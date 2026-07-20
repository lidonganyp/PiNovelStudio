/** CEILING-REFERENCE-CASES-1 evaluator-only quality annotation schema. */

import { CEILING_DIMENSION_IDS, type CeilingDimensionId } from "./ceiling-judge-schema.js";

export { CEILING_DIMENSION_IDS } from "./ceiling-judge-schema.js";

export type ReferenceQualityCaseKind =
  | "opening_anomaly"
  | "rule_reveal"
  | "investigation"
  | "character_conflict"
  | "high_pressure_ending";

export interface ReferenceQualityAnnotation {
  level: number;
  evidence: Array<{ excerpt: string }>;
  rationale: string;
}

export interface ReferenceQualityCase {
  schemaVersion: "ceiling-reference-case.v1";
  referenceId: string;
  bodyHash: string;
  kind: ReferenceQualityCaseKind;
  annotations: Record<CeilingDimensionId, ReferenceQualityAnnotation>;
}

export function buildReferenceQualityCase(input: Omit<ReferenceQualityCase, "schemaVersion">): ReferenceQualityCase {
  return { schemaVersion: "ceiling-reference-case.v1", ...input };
}

export function validateReferenceQualityCase(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["root_not_object"] };
  const allowed = ["schemaVersion", "referenceId", "bodyHash", "kind", "annotations"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`unknown_key:${key}`);
  if (value.schemaVersion !== "ceiling-reference-case.v1") errors.push("invalid_schema_version");
  if (typeof value.referenceId !== "string" || !value.referenceId) errors.push("invalid_reference_id");
  if (typeof value.bodyHash !== "string" || !/^[a-f0-9]{64}$/.test(value.bodyHash)) errors.push("invalid_body_hash");
  if (!isKind(value.kind)) errors.push("invalid_kind");
  if (!isRecord(value.annotations)) errors.push("invalid_annotations");
  if (isRecord(value.annotations)) {
    for (const id of CEILING_DIMENSION_IDS) {
      const annotation = value.annotations[id];
      if (!isRecord(annotation)) { errors.push(`missing_dimension:${id}`); continue; }
      if (!Number.isInteger(annotation.level) || annotation.level < 1 || annotation.level > 5) errors.push(`invalid_level:${id}`);
      if (!Array.isArray(annotation.evidence) || annotation.evidence.length === 0) errors.push(`missing_evidence:${id}`);
      else for (const item of annotation.evidence) if (!isRecord(item) || typeof item.excerpt !== "string" || !item.excerpt) errors.push(`invalid_span:${id}`);
      if (typeof annotation.rationale !== "string" || !annotation.rationale) errors.push(`missing_rationale:${id}`);
    }
    for (const key of Object.keys(value.annotations)) if (!(CEILING_DIMENSION_IDS as readonly string[]).includes(key)) errors.push(`unknown_dimension:${key}`);
  }
  // Reference text is evaluator registry data and must never be copied into annotation assets.
  if ("body" in value || "referenceText" in value || "sourcePath" in value || "startOffset" in value || "endOffset" in value) errors.push("reference_body_or_locator_leak");
  return { valid: errors.length === 0, errors };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is ReferenceQualityCaseKind {
  return value === "opening_anomaly" || value === "rule_reveal" || value === "investigation" || value === "character_conflict" || value === "high_pressure_ending";
}
