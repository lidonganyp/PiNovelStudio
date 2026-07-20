/**
 * CEILING-JUDGE-SCHEMA-1: strict evaluator-only absolute-quality verdicts.
 *
 * This module deliberately has no generator or production imports. A malformed
 * response is invalid evidence; it is never coerced into a usable verdict.
 */

import { createHash } from "node:crypto";

export const CEILING_JUDGE_SCHEMA_VERSION = "ceiling-judge.v2";

export const CEILING_DIMENSION_IDS = [
  "active_protagonist",
  "rule_information_gain",
  "scene_state_delta",
  "terror_escalation",
  "dialogue_function",
  "information_asymmetry",
  "chapter_end_causal_pressure",
  "native_chinese",
] as const;

export type CeilingDimensionId = (typeof CEILING_DIMENSION_IDS)[number];
export type CeilingGapType =
  | "candidate_below_reference"
  | "candidate_above_reference"
  | "aligned"
  | "unknown";
export type CeilingTierRelationship =
  | "candidate_below_reference"
  | "same_tier"
  | "candidate_above_reference"
  | "uncertain";

export interface CeilingEvidence {
  excerpt: string;
}

export interface CeilingDimensionVerdict {
  id: CeilingDimensionId;
  candidate_level: number;
  reference_level: number;
  gap_type: CeilingGapType;
  evidence_candidate: CeilingEvidence[];
  evidence_reference: CeilingEvidence[];
  reason: string;
}

export interface CeilingJudgeVerdict {
  dimensions: CeilingDimensionVerdict[];
  overall_candidate_level: number;
  overall_reference_level: number;
  tier_relationship: CeilingTierRelationship;
  largest_bottlenecks: string[];
  needs_human_review: boolean;
}

export interface CeilingJudgeTexts {
  candidate: string;
  reference: string;
}

export interface CeilingJudgeProvenanceInput {
  requestId: string;
  model: string;
  route: string;
}

export interface CeilingJudgeProvenance extends CeilingJudgeProvenanceInput {
  schemaVersion: string;
  responseHash: string;
}

export interface CeilingVerdictParseResult {
  valid: boolean;
  verdict: CeilingJudgeVerdict | null;
  errors: string[];
}

export interface CeilingDimensionParseResult {
  valid: boolean;
  dimension: CeilingDimensionVerdict | null;
  errors: string[];
}

export interface CeilingJudgeRunResult {
  status: "valid" | "invalid";
  verdict: CeilingJudgeVerdict | null;
  errors: string[];
  retryCount: number;
  provenance: CeilingJudgeProvenance;
}

export interface CeilingJudgeRunInput extends CeilingJudgeTexts {
  request: () => Promise<string>;
  repair?: (feedback: string) => Promise<string>;
  provenance: CeilingJudgeProvenanceInput;
}

export interface CeilingJudgeRepairSchemaInput {
  candidateSpans: string[];
  referenceSpans: string[];
}

export function buildCeilingJudgeSchema(): Record<string, unknown> {
  return buildSchema();
}

export function buildCeilingJudgeRepairSchema(
  input: CeilingJudgeRepairSchemaInput,
): Record<string, unknown> {
  if (input.candidateSpans.length === 0 || input.referenceSpans.length === 0) {
    throw new Error("repair_span_enum_must_not_be_empty");
  }
  return buildSchema(input);
}

export function buildCeilingDimensionJudgeSchema(
  id: CeilingDimensionId,
  spanEnums?: CeilingJudgeRepairSchemaInput,
): Record<string, unknown> {
  const evidence = (values?: string[]) => ({
    type: "object",
    properties: {
      excerpt: values
        ? { type: "string", enum: [...new Set(values)] }
        : { type: "string", minLength: 1 },
    },
    required: ["excerpt"],
    additionalProperties: false,
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      id: { type: "string", enum: [id] },
      candidate_level: { type: "integer", minimum: 1, maximum: 5 },
      reference_level: { type: "integer", minimum: 1, maximum: 5 },
      gap_type: {
        type: "string",
        enum: ["candidate_below_reference", "candidate_above_reference", "aligned", "unknown"],
      },
      evidence_candidate: { type: "array", items: evidence(spanEnums?.candidateSpans), minItems: 1, maxItems: 1 },
      evidence_reference: { type: "array", items: evidence(spanEnums?.referenceSpans), minItems: 1, maxItems: 1 },
      reason: { type: "string", minLength: 1, maxLength: 240 },
    },
    required: [
      "id", "candidate_level", "reference_level", "gap_type",
      "evidence_candidate", "evidence_reference", "reason",
    ],
    additionalProperties: false,
  };
}

export function parseAndValidateCeilingDimension(
  raw: string,
  expectedId: CeilingDimensionId,
  texts: CeilingJudgeTexts,
): CeilingDimensionParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { valid: false, dimension: null, errors: ["invalid_json"] };
  }
  if (!isRecord(value)) return { valid: false, dimension: null, errors: ["root_not_object"] };
  const errors: string[] = [];
  rejectUnknownKeys(value, [
    "id", "candidate_level", "reference_level", "gap_type",
    "evidence_candidate", "evidence_reference", "reason",
  ], errors, "dimension");
  if (value.id !== expectedId) errors.push(`dimension_invalid_id:${String(value.id)}`);
  if (!isLevel(value.candidate_level)) errors.push("dimension_invalid_candidate_level");
  if (!isLevel(value.reference_level)) errors.push("dimension_invalid_reference_level");
  if (!isGapType(value.gap_type)) errors.push("dimension_invalid_gap_type");
  if (typeof value.reason !== "string" || value.reason.length === 0 || value.reason.length > 240) {
    errors.push("dimension_invalid_reason");
  }
  validateEvidence(value.evidence_candidate, texts.candidate, errors, "dimension_candidate");
  validateEvidence(value.evidence_reference, texts.reference, errors, "dimension_reference");
  if (isLevel(value.candidate_level) && isLevel(value.reference_level) && isGapType(value.gap_type)) {
    const expected = value.candidate_level < value.reference_level
      ? "candidate_below_reference"
      : value.candidate_level > value.reference_level ? "candidate_above_reference" : "aligned";
    if (value.gap_type !== "unknown" && value.gap_type !== expected) errors.push("dimension_gap_mismatch");
  }
  if (errors.length > 0) return { valid: false, dimension: null, errors };
  return { valid: true, dimension: value as unknown as CeilingDimensionVerdict, errors: [] };
}

export function aggregateCeilingDimensionVerdicts(
  dimensions: CeilingDimensionVerdict[],
): CeilingJudgeVerdict {
  const ids = new Set(dimensions.map((dimension) => dimension.id));
  if (dimensions.length !== CEILING_DIMENSION_IDS.length
    || CEILING_DIMENSION_IDS.some((id) => !ids.has(id))) {
    throw new Error("aggregate_requires_all_8_unique_dimensions");
  }
  const overallCandidate = roundedMean(dimensions.map((dimension) => dimension.candidate_level));
  const overallReference = roundedMean(dimensions.map((dimension) => dimension.reference_level));
  const uncertain = dimensions.some((dimension) => dimension.gap_type === "unknown");
  const tierRelationship: CeilingTierRelationship = uncertain
    ? "uncertain"
    : overallCandidate < overallReference
      ? "candidate_below_reference"
      : overallCandidate > overallReference ? "candidate_above_reference" : "same_tier";
  const largestBottlenecks = [...dimensions]
    .filter((dimension) => dimension.candidate_level < dimension.reference_level)
    .sort((left, right) => (
      (right.reference_level - right.candidate_level) - (left.reference_level - left.candidate_level)
    ))
    .slice(0, 3)
    .map((dimension) => `${dimension.id}: ${dimension.reason}`);
  return {
    dimensions: [...dimensions],
    overall_candidate_level: overallCandidate,
    overall_reference_level: overallReference,
    tier_relationship: tierRelationship,
    largest_bottlenecks: largestBottlenecks,
    needs_human_review: uncertain,
  };
}

function buildSchema(spanEnums?: CeilingJudgeRepairSchemaInput): Record<string, unknown> {
  const evidence = (values?: string[]) => ({
    type: "object",
    properties: {
      excerpt: values
        ? { type: "string", enum: [...new Set(values)] }
        : { type: "string", minLength: 1 },
    },
    required: ["excerpt"],
    additionalProperties: false,
  });
  const dimension = {
    type: "object",
    properties: {
      id: { type: "string", enum: [...CEILING_DIMENSION_IDS] },
      candidate_level: { type: "integer", minimum: 1, maximum: 5 },
      reference_level: { type: "integer", minimum: 1, maximum: 5 },
      gap_type: {
        type: "string",
        enum: ["candidate_below_reference", "candidate_above_reference", "aligned", "unknown"],
      },
      evidence_candidate: { type: "array", items: evidence(spanEnums?.candidateSpans), minItems: 1, maxItems: 1 },
      evidence_reference: { type: "array", items: evidence(spanEnums?.referenceSpans), minItems: 1, maxItems: 1 },
      reason: { type: "string", minLength: 1, maxLength: 240 },
    },
    required: [
      "id", "candidate_level", "reference_level", "gap_type",
      "evidence_candidate", "evidence_reference", "reason",
    ],
    additionalProperties: false,
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      dimensions: { type: "array", minItems: 8, maxItems: 8, items: dimension },
      overall_candidate_level: { type: "integer", minimum: 1, maximum: 5 },
      overall_reference_level: { type: "integer", minimum: 1, maximum: 5 },
      tier_relationship: {
        type: "string",
        enum: [
          "candidate_below_reference",
          "same_tier",
          "candidate_above_reference",
          "uncertain",
        ],
      },
      largest_bottlenecks: {
        type: "array",
        items: { type: "string", maxLength: 200 },
        maxItems: 3,
      },
      needs_human_review: { type: "boolean" },
    },
    required: [
      "dimensions", "overall_candidate_level", "overall_reference_level", "tier_relationship",
      "largest_bottlenecks", "needs_human_review",
    ],
    additionalProperties: false,
  };
}

export function parseAndValidateCeilingVerdict(
  raw: string,
  texts: CeilingJudgeTexts,
): CeilingVerdictParseResult {
  const errors: string[] = [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { valid: false, verdict: null, errors: ["invalid_json"] };
  }
  if (!isRecord(value)) return invalid("root_not_object");
  const rootKeys = [
    "dimensions", "overall_candidate_level", "overall_reference_level", "tier_relationship",
    "largest_bottlenecks", "needs_human_review",
  ];
  rejectUnknownKeys(value, rootKeys, errors, "root");
  if (!Array.isArray(value.dimensions) || value.dimensions.length !== CEILING_DIMENSION_IDS.length) {
    errors.push("dimensions_must_contain_exactly_8");
  }
  if (!isLevel(value.overall_candidate_level)) errors.push("invalid_overall_candidate_level");
  if (!isLevel(value.overall_reference_level)) errors.push("invalid_overall_reference_level");
  if (!isTierRelationship(value.tier_relationship)) errors.push("invalid_tier_relationship");
  if (!Array.isArray(value.largest_bottlenecks) || value.largest_bottlenecks.some((x) => typeof x !== "string")) {
    errors.push("invalid_largest_bottlenecks");
  }
  if (typeof value.needs_human_review !== "boolean") errors.push("invalid_needs_human_review");

  const dimensions: CeilingDimensionVerdict[] = [];
  if (Array.isArray(value.dimensions)) {
    const ids = new Set<string>();
    for (const [index, item] of value.dimensions.entries()) {
      if (!isRecord(item)) { errors.push(`dimension_${index}_not_object`); continue; }
      const allowed = [
        "id", "candidate_level", "reference_level", "gap_type",
        "evidence_candidate", "evidence_reference", "reason",
      ];
      rejectUnknownKeys(item, allowed, errors, `dimension_${index}`);
      if (!isCeilingDimensionId(item.id)) errors.push(`dimension_${index}_invalid_id`);
      else if (ids.has(item.id)) errors.push(`dimension_duplicate:${item.id}`);
      else ids.add(item.id);
      if (!isLevel(item.candidate_level)) errors.push(`dimension_${index}_invalid_candidate_level`);
      if (!isLevel(item.reference_level)) errors.push(`dimension_${index}_invalid_reference_level`);
      if (!isGapType(item.gap_type)) errors.push(`dimension_${index}_invalid_gap_type`);
      if (typeof item.reason !== "string" || item.reason.length === 0) errors.push(`dimension_${index}_invalid_reason`);
      validateEvidence(item.evidence_candidate, texts.candidate, errors, `dimension_${index}_candidate`);
      validateEvidence(item.evidence_reference, texts.reference, errors, `dimension_${index}_reference`);
      if (isCeilingDimensionId(item.id) && isLevel(item.candidate_level) && isLevel(item.reference_level) && isGapType(item.gap_type)) {
        const expected = item.candidate_level < item.reference_level
          ? "candidate_below_reference"
          : item.candidate_level > item.reference_level ? "candidate_above_reference" : "aligned";
        if (item.gap_type !== "unknown" && item.gap_type !== expected) errors.push(`dimension_${index}_gap_mismatch`);
        dimensions.push(item as unknown as CeilingDimensionVerdict);
      }
    }
    for (const id of CEILING_DIMENSION_IDS) if (!ids.has(id)) errors.push(`dimension_missing:${id}`);
  }
  const hasUncertainDimension = dimensions.some((dimension) => dimension.gap_type === "unknown");
  if (hasUncertainDimension && value.tier_relationship !== "uncertain") {
    errors.push("uncertain_dimension_requires_uncertain_tier");
  }
  if (value.tier_relationship === "uncertain" && value.needs_human_review !== true) {
    errors.push("uncertain_tier_requires_human_review");
  }
  if (
    isLevel(value.overall_candidate_level)
    && isLevel(value.overall_reference_level)
    && isTierRelationship(value.tier_relationship)
    && value.tier_relationship !== "uncertain"
  ) {
    const expected = value.overall_candidate_level < value.overall_reference_level
      ? "candidate_below_reference"
      : value.overall_candidate_level > value.overall_reference_level
        ? "candidate_above_reference"
        : "same_tier";
    if (value.tier_relationship !== expected) errors.push("tier_relationship_mismatch");
  }
  if (errors.length > 0) return { valid: false, verdict: null, errors };
  return {
    valid: true,
    verdict: {
      dimensions,
      overall_candidate_level: value.overall_candidate_level as number,
      overall_reference_level: value.overall_reference_level as number,
      tier_relationship: value.tier_relationship as CeilingTierRelationship,
      largest_bottlenecks: value.largest_bottlenecks as string[],
      needs_human_review: value.needs_human_review as boolean,
    },
    errors: [],
  };
}

export async function runCeilingJudgeWithRepair(input: CeilingJudgeRunInput): Promise<CeilingJudgeRunResult> {
  let response = "";
  let retryCount = 0;
  let parsed: CeilingVerdictParseResult = { valid: false, verdict: null, errors: ["not_called"] };
  try {
    response = await input.request();
    parsed = parseAndValidateCeilingVerdict(response, input);
    if (!parsed.valid && input.repair) {
      retryCount = 1;
      response = await input.repair(parsed.errors.join(";"));
      parsed = parseAndValidateCeilingVerdict(response, input);
    }
  } catch (error: unknown) {
    parsed = { valid: false, verdict: null, errors: [error instanceof Error ? error.message : String(error)] };
  }
  const provenance: CeilingJudgeProvenance = {
    ...input.provenance,
    schemaVersion: CEILING_JUDGE_SCHEMA_VERSION,
    responseHash: sha256(response),
  };
  return {
    status: parsed.valid ? "valid" : "invalid",
    verdict: parsed.verdict,
    errors: parsed.errors,
    retryCount,
    provenance,
  };
}

function invalid(error: string): CeilingVerdictParseResult {
  return { valid: false, verdict: null, errors: [error] };
}

function roundedMean(values: number[]): number {
  return Math.max(1, Math.min(5, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, any>, allowed: string[], errors: string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${path}_unknown_key:${key}`);
}

function isLevel(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

function isCeilingDimensionId(value: unknown): value is CeilingDimensionId {
  return typeof value === "string" && (CEILING_DIMENSION_IDS as readonly string[]).includes(value);
}

function isGapType(value: unknown): value is CeilingGapType {
  return value === "candidate_below_reference" || value === "candidate_above_reference" || value === "aligned" || value === "unknown";
}

function isTierRelationship(value: unknown): value is CeilingTierRelationship {
  return value === "candidate_below_reference"
    || value === "same_tier"
    || value === "candidate_above_reference"
    || value === "uncertain";
}

function validateEvidence(value: unknown, source: string, errors: string[], path: string): void {
  if (!Array.isArray(value) || value.length === 0) { errors.push(`${path}_missing`); return; }
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || typeof item.excerpt !== "string" || item.excerpt.length === 0) {
      errors.push(`${path}_${index}_invalid`);
    } else if (!source.includes(item.excerpt)) {
      const restored = restoreUniqueNormalizedSpan(source, item.excerpt);
      if (restored === null) errors.push(`${path}_${index}_span_not_in_source`);
      else item.excerpt = restored;
    }
  }
}

function restoreUniqueNormalizedSpan(source: string, excerpt: string): string | null {
  const normalizedSource = normalizeSpanText(source, true);
  const normalizedExcerpt = normalizeSpanText(excerpt, false).text;
  if (normalizedExcerpt.length === 0) return null;

  const first = normalizedSource.text.indexOf(normalizedExcerpt);
  if (first < 0 || normalizedSource.text.indexOf(normalizedExcerpt, first + 1) >= 0) return null;

  const last = first + normalizedExcerpt.length - 1;
  let start = normalizedSource.sourceIndexes[first];
  let end = normalizedSource.sourceIndexes[last] + 1;
  while (start > 0 && !isSpanContentCharacter(source[start - 1])) start -= 1;
  while (end < source.length && !isSpanContentCharacter(source[end])) end += 1;
  return source.slice(start, end);
}

function normalizeSpanText(
  value: string,
  keepSourceIndexes: boolean,
): { text: string; sourceIndexes: number[] } {
  let text = "";
  const sourceIndexes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const normalized = value[index].normalize("NFKC").toLowerCase();
    for (const character of normalized) {
      if (!isSpanContentCharacter(character)) continue;
      text += character;
      if (keepSourceIndexes) sourceIndexes.push(index);
    }
  }
  return { text, sourceIndexes };
}

function isSpanContentCharacter(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value.normalize("NFKC"));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
