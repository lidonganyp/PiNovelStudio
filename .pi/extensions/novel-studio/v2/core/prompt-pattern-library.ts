/**
 * PromptPatternLibrary - source-backed narrative prompt patterns with explicit
 * production admission. Runtime compilation exposes only bounded abstract
 * guidance; provenance and evaluator references remain audit-only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sealCapabilityPackage } from "../governance/capability-package-registry.js";
import type { CapabilityPackageManifest, CapabilityPayloadRecord } from "./capability-package-contracts.js";

export type PromptPatternStatus = "candidate" | "active" | "dormant" | "retired";
export type PromptPatternSourceType =
  | "repository_prompt"
  | "repository_workflow"
  | "video_metadata"
  | "experiment_report"
  | "secondary_article";
export type PromptPatternConfidence = "high" | "medium" | "low";

export interface PromptPatternSource {
  sourceId: string;
  url: string;
  accessedAt: string;
  sourceType: PromptPatternSourceType;
  license: string;
  evidenceConfidence: PromptPatternConfidence;
}

export interface PromptPatternAdmission {
  sampleSize: number;
  validatedWinRate: number | null;
  reason: string;
}

export interface PromptPattern {
  id: string;
  status: PromptPatternStatus;
  title: string;
  guidance: string;
  requiredMoves: string[];
  avoidPatterns: string[];
  sources: PromptPatternSource[];
  admission: PromptPatternAdmission;
}

export interface PromptPatternLibrary {
  schemaVersion: "1.0.0";
  updatedAt: string;
  patterns: PromptPattern[];
}

export interface PromptPatternValidation {
  valid: boolean;
  errors: string[];
}

export interface PromptPatternTraceEntry {
  id: string;
  status: PromptPatternStatus;
  reason: string;
}

export interface PromptPatternResolutionTrace {
  libraryStatus: "loaded" | "missing" | "invalid";
  mode: "production" | "evaluation";
  discovered: PromptPatternTraceEntry[];
  selected: PromptPatternTraceEntry[];
  dropped: PromptPatternTraceEntry[];
  errors: string[];
}

export interface PromptPatternResolution {
  promptBlock: string;
  patternIds: string[];
  trace: PromptPatternResolutionTrace;
}

export interface ResolvePromptPatternLibraryInput {
  library: unknown | null;
  mode: "production" | "evaluation";
  explicitPatternIds?: readonly string[];
}

const MAX_PATTERNS = 32;
const MAX_SELECTED_PATTERNS = 4;
const MAX_GUIDANCE_LENGTH = 240;
const MAX_LIST_ITEMS = 5;
const MAX_LIST_ITEM_LENGTH = 100;
// User-authorized positive-gain admission (2026-07-19): the observed bundle
// had 8 complete validation cases and a 7/8 win rate versus ordinary raw.
// Keep this as the minimum auditable evidence floor so a single pilot or a
// hand-edited `active` flag cannot silently enter production.
const MIN_ACTIVE_SAMPLE_SIZE = 8;
const MIN_ACTIVE_VALIDATED_WIN_RATE = 0.55;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
const REFERENCE_OR_IMITATION =
  /神秘复苏|杨间|鬼眼|鬼域|人皮纸|敲门鬼|佛前献花|模仿.{0,12}(?:作者|作品|原文|原句|文风|句式)|复刻.{0,12}(?:作者|作品|原文|原句|文风|句式)|照着.{0,12}(?:作者|作品|原文|原句)写/u;
const MECHANICAL_QUOTA =
  /对白(?:占比|比例)|段落(?:数|比例|字数)|每章必须[一二三四五六七八九十两\d]+(?:次|个|段|场)|固定[一二三四五六七八九十两\d]+(?:次|个|段|场)(?:反转|冲突|钩子)|(?:反转|冲突|钩子)(?:数|次数)(?:达到|不少于|至少)/u;

/** Validate the complete audit library before any pattern can reach a prompt. */
export function validatePromptPatternLibrary(value: unknown): PromptPatternValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["library_not_object"] };
  if (value.schemaVersion !== "1.0.0") errors.push("unsupported_schema_version");
  if (!isBoundedText(value.updatedAt, 32) || !ISO_DATE.test(value.updatedAt)) {
    errors.push("invalid_updated_at");
  }
  if (!Array.isArray(value.patterns)) return { valid: false, errors: [...errors, "patterns_not_array"] };
  if (value.patterns.length > MAX_PATTERNS) errors.push("patterns_exceed_limit");

  const ids = new Set<string>();
  for (const [index, raw] of value.patterns.entries()) {
    if (!isRecord(raw)) {
      errors.push(`pattern_${index}_not_object`);
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id : `index_${index}`;
    if (!ID_PATTERN.test(id)) errors.push(`pattern_${index}_invalid_id`);
    if (ids.has(id)) errors.push(`pattern_${index}_duplicate_id`);
    ids.add(id);
    if (!isStatus(raw.status)) errors.push(`pattern_${id}_invalid_status`);
    validateRuntimeText(raw.title, id, "title", 80, errors);
    validateRuntimeText(raw.guidance, id, "guidance", MAX_GUIDANCE_LENGTH, errors);
    validateRuntimeList(raw.requiredMoves, id, "required_moves", errors);
    validateRuntimeList(raw.avoidPatterns, id, "avoid_patterns", errors);
    validateSources(raw.sources, id, errors);
    validateAdmission(raw.admission, id, errors);
    if (raw.status === "active" && !hasActiveAdmissionEvidence(raw.admission)) {
      errors.push(`pattern_${id}_active_without_admission_evidence`);
    }
    if (raw.status === "active" && !hasActiveExperimentProvenance(raw.sources)) {
      errors.push(`pattern_${id}_active_without_experiment_provenance`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Resolve admitted patterns and produce a prompt-safe block plus full audit trace. */
export function resolvePromptPatternLibrary(
  input: ResolvePromptPatternLibraryInput,
): PromptPatternResolution {
  if (input.library === null || input.library === undefined) {
    return emptyResolution(input.mode, "missing", []);
  }
  const validation = validatePromptPatternLibrary(input.library);
  if (!validation.valid) return emptyResolution(input.mode, "invalid", validation.errors);

  const library = input.library as PromptPatternLibrary;
  const explicit = new Set(input.explicitPatternIds ?? []);
  const discovered: PromptPatternTraceEntry[] = library.patterns.map((pattern) => ({
    id: pattern.id,
    status: pattern.status,
    reason: "library_discovery",
  }));
  const selectedPatterns: PromptPattern[] = [];
  const selected: PromptPatternTraceEntry[] = [];
  const dropped: PromptPatternTraceEntry[] = [];

  for (const pattern of library.patterns) {
    const decision = decidePattern(pattern, input.mode, explicit, input.explicitPatternIds !== undefined);
    if (decision.selected && selectedPatterns.length < MAX_SELECTED_PATTERNS) {
      selectedPatterns.push(pattern);
      selected.push({ id: pattern.id, status: pattern.status, reason: decision.reason });
    } else {
      dropped.push({
        id: pattern.id,
        status: pattern.status,
        reason: decision.selected ? "selection_budget_exceeded" : decision.reason,
      });
    }
  }

  const entries = selectedPatterns.map((pattern) => [
    `叙事决策：${pattern.guidance}`,
    `通过正文体现：${pattern.requiredMoves.join("；")}`,
    `避免：${pattern.avoidPatterns.join("；")}`,
  ].join("\n"));
  return {
    promptBlock: entries.length > 0
      ? [
          input.mode === "production"
            ? "【经生产准入的叙事决策：执行抽象决策，不输出规则清单，不模仿任何作者或作品】"
            : "【受控评测叙事决策：仅用于实验，不输出规则清单，不模仿任何作者或作品】",
          ...entries,
        ].join("\n")
      : "",
    patternIds: selectedPatterns.map((pattern) => pattern.id),
    trace: {
      libraryStatus: "loaded",
      mode: input.mode,
      discovered,
      selected,
      dropped,
      errors: [],
    },
  };
}

/** Load the project runtime library. Any read or parse failure becomes ordinary raw. */
export function loadPromptPatternLibrary(
  projectRoot: string | undefined,
  options: Omit<ResolvePromptPatternLibraryInput, "library">,
): PromptPatternResolution {
  if (!projectRoot || projectRoot.trim().length === 0) {
    return emptyResolution(options.mode, "missing", ["project_root_missing"]);
  }
  const filePath = join(projectRoot, "data", "runtime", "prompt-pattern-library.json");
  try {
    const library = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return resolvePromptPatternLibrary({ ...options, library });
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ENOENT") return emptyResolution(options.mode, "missing", []);
    const message = error instanceof Error ? error.message : String(error);
    return emptyResolution(options.mode, "invalid", [`library_load_failed:${message}`]);
  }
}

function decidePattern(
  pattern: PromptPattern,
  mode: "production" | "evaluation",
  explicit: ReadonlySet<string>,
  hasExplicitSelection: boolean,
): { selected: boolean; reason: string } {
  if (pattern.status === "retired") return { selected: false, reason: "status_retired" };
  if (pattern.status === "dormant") return { selected: false, reason: "status_dormant" };
  if (mode === "production") {
    return pattern.status === "active"
      ? { selected: true, reason: "status_active" }
      : { selected: false, reason: "status_not_active" };
  }
  if (hasExplicitSelection) {
    return explicit.has(pattern.id)
      ? { selected: true, reason: "explicit_evaluation_activation" }
      : { selected: false, reason: "not_explicitly_selected_for_evaluation" };
  }
  return pattern.status === "active"
    ? { selected: true, reason: "status_active" }
    : { selected: false, reason: "status_not_active" };
}

function emptyResolution(
  mode: "production" | "evaluation",
  libraryStatus: "missing" | "invalid",
  errors: string[],
): PromptPatternResolution {
  return {
    promptBlock: "",
    patternIds: [],
    trace: { libraryStatus, mode, discovered: [], selected: [], dropped: [], errors },
  };
}

function validateRuntimeText(
  value: unknown,
  id: string,
  field: string,
  maxLength: number,
  errors: string[],
): void {
  if (!isBoundedText(value, maxLength)) {
    errors.push(`pattern_${id}_invalid_${field}`);
    return;
  }
  if (REFERENCE_OR_IMITATION.test(value)) errors.push(`pattern_${id}_reference_or_imitation_${field}`);
  if (MECHANICAL_QUOTA.test(value)) errors.push(`pattern_${id}_mechanical_quota_${field}`);
}

function validateRuntimeList(value: unknown, id: string, field: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ITEMS) {
    errors.push(`pattern_${id}_invalid_${field}`);
    return;
  }
  for (const item of value) validateRuntimeText(item, id, field, MAX_LIST_ITEM_LENGTH, errors);
}

function validateSources(value: unknown, id: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
    errors.push(`pattern_${id}_invalid_sources`);
    return;
  }
  for (const [index, source] of value.entries()) {
    if (!isRecord(source)
      || !isBoundedText(source.sourceId, 120)
      || !isBoundedText(source.url, 500)
      || !isAuditableSourceLocator(source.url)
      || !isBoundedText(source.accessedAt, 32)
      || !ISO_DATE.test(source.accessedAt)
      || !isSourceType(source.sourceType)
      || !isBoundedText(source.license, 80)
      || !isConfidence(source.evidenceConfidence)) {
      errors.push(`pattern_${id}_invalid_source_${index}`);
    }
  }
}

function validateAdmission(value: unknown, id: string, errors: string[]): void {
  if (!isRecord(value)
    || !Number.isInteger(value.sampleSize)
    || (value.sampleSize as number) < 0
    || !(value.validatedWinRate === null
      || (typeof value.validatedWinRate === "number"
        && value.validatedWinRate >= 0
        && value.validatedWinRate <= 1))
    || !isBoundedText(value.reason, 300)) {
    errors.push(`pattern_${id}_invalid_admission`);
  }
}

function hasActiveAdmissionEvidence(value: unknown): boolean {
  return isRecord(value)
    && Number.isInteger(value.sampleSize)
    && (value.sampleSize as number) >= MIN_ACTIVE_SAMPLE_SIZE
    && typeof value.validatedWinRate === "number"
    && value.validatedWinRate >= MIN_ACTIVE_VALIDATED_WIN_RATE
    && value.validatedWinRate <= 1;
}

function hasActiveExperimentProvenance(value: unknown): boolean {
  return Array.isArray(value) && value.some((source) =>
    isRecord(source)
    && source.sourceType === "experiment_report"
    && source.evidenceConfidence === "high"
    && isBoundedText(source.url, 500)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isStatus(value: unknown): value is PromptPatternStatus {
  return value === "candidate" || value === "active" || value === "dormant" || value === "retired";
}

function isSourceType(value: unknown): value is PromptPatternSourceType {
  return value === "repository_prompt"
    || value === "repository_workflow"
    || value === "video_metadata"
    || value === "experiment_report"
    || value === "secondary_article";
}

function isConfidence(value: unknown): value is PromptPatternConfidence {
  return value === "high" || value === "medium" || value === "low";
}

function isAuditableSourceLocator(value: string): boolean {
  return /^https:\/\//u.test(value)
    || /^reports\/[a-z0-9][a-z0-9_./-]*\.(?:json|md)$/u.test(value);
}

function mapPromptPatternStatus(status: PromptPatternStatus): CapabilityPackageManifest["status"] {
  if (status === "active") return "active";
  if (status === "retired") return "retired";
  if (status === "dormant") return "held";
  return "eval";
}

/** Read-only one-shot adapter. Package status is the runtime truth after migration. */
export function adaptPromptPatternToPackage(
  pattern: PromptPattern,
): { manifest: CapabilityPackageManifest; payload: CapabilityPayloadRecord } {
  return sealCapabilityPackage({
    schemaVersion: "capability-package-v1",
    packageId: `prompt_pattern.${pattern.id}`,
    version: "1.0.0",
    slot: `prompt_pattern.${pattern.id}`,
    kind: "prompt_pattern",
    purpose: pattern.title,
    applicableWhen: [],
    excludedWhen: [],
    requiredInputs: [],
    outputArtifacts: [{ kind: "candidate_guidance", schemaId: "prompt-pattern-guidance-v1" }],
    payloadRef: {
      mediaType: "application/json",
      payloadHash: "",
      sourceRef: `prompt-pattern:${pattern.id}`,
    },
    targetStages: ["style_optimization"],
    allowedTools: [],
    stopConditions: [{ kind: "max_output_artifacts", value: 1 }],
    budgetPolicy: {
      maxCalls: 0,
      maxInputTokens: 400,
      maxOutputTokens: 0,
      maxLatencyMs: 0,
      maxCost: 0,
    },
    authority: "methodology",
    enforcement: "candidate_only",
    dependencies: [],
    conflicts: [],
    modelCapabilityRequirements: [],
    provenance: pattern.sources.map((source) => ({
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      accessedAt: source.accessedAt,
    })),
    evalManifestId: `prompt-pattern:${pattern.id}`,
    admissionEvidence: [{
      evalManifestId: `prompt-pattern:${pattern.id}`,
      sampleSize: pattern.admission.sampleSize,
      validatedWinRate: pattern.admission.validatedWinRate,
      reason: pattern.admission.reason,
    }],
    status: mapPromptPatternStatus(pattern.status),
    criticality: "optional",
  }, {
    guidance: pattern.guidance,
    requiredMoves: pattern.requiredMoves,
    avoidPatterns: pattern.avoidPatterns,
  });
}
