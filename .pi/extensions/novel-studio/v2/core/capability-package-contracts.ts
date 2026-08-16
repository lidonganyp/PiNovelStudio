/**
 * Capability Package contracts — Package / Activation / Output / Consumption.
 *
 * Truth source: docs/skill-capability-package-governance-development-plan-20260815.md §5.
 * These types are the only schema for capability-package governance. Do not
 * create a parallel authority, budget, or consumption model.
 */

import type { MethodologyAuthority, MethodologyEnforcement } from "./methodology-policy.js";
import type { CapabilityKey } from "../../novelos/protocol/capability-registry.js";

export const CAPABILITY_PACKAGE_SCHEMA_VERSION = "capability-package-v1" as const;
export const CAPABILITY_PACKAGE_SET_SCHEMA_VERSION = "capability-package-set-v1" as const;
export const CAPABILITY_ACTIVATION_SCHEMA_VERSION = "capability-activation-v1" as const;
export const CAPABILITY_OUTPUT_SCHEMA_VERSION = "capability-output-v1" as const;
export const CAPABILITY_CONSUMPTION_LEDGER_SCHEMA_VERSION = "capability-consumption-v1" as const;

export const CAPABILITY_PACKAGE_KINDS = [
  "workflow_skill",
  "craft_gene",
  "prompt_pattern",
  "editorial_strategy",
  "diagnostic_module",
] as const;
export type CapabilityPackageKind = (typeof CAPABILITY_PACKAGE_KINDS)[number];

export const CAPABILITY_STAGES = [
  "preflight",
  "context_compiler",
  "agentic_investigation",
  "agentic_draft",
  "style_optimization",
  "review_surface",
  "eval_only",
] as const;
export type CapabilityStage = (typeof CAPABILITY_STAGES)[number];

export const CAPABILITY_PACKAGE_STATUSES = [
  "draft",
  "eval",
  "held",
  "rejected",
  "canary",
  "active",
  "retired",
] as const;
export type CapabilityPackageStatus = (typeof CAPABILITY_PACKAGE_STATUSES)[number];

export const CAPABILITY_OUTPUT_KINDS = [
  "evidence",
  "unresolved_questions",
  "candidate_guidance",
  "diagnostic",
  "review_question",
] as const;
export type CapabilityOutputKind = (typeof CAPABILITY_OUTPUT_KINDS)[number];

/** Methodology packages may not emit fact or hard_constraint artifacts. */
export const FORBIDDEN_METHODOLOGY_OUTPUT_KINDS = ["fact", "hard_constraint"] as const;

export const CAPABILITY_CONSUMPTION_EVENTS = [
  "discovered",
  "admitted",
  "eligible",
  "selected",
  "activated",
  "rendered",
  "delivered_to_model",
  "consumed",
  "skipped",
  "rejected",
  "failed",
  "budget_exhausted",
  "optional_capability_unavailable",
  "unauthorized_activation",
] as const;
export type CapabilityConsumptionEventName = (typeof CAPABILITY_CONSUMPTION_EVENTS)[number];

export const CAPABILITY_ACTIVATION_DECISIONS = [
  "selected",
  "skipped",
  "rejected",
  "unavailable",
] as const;
export type CapabilityActivationDecisionKind = (typeof CAPABILITY_ACTIVATION_DECISIONS)[number];

export type CapabilityPackageEnforcement = MethodologyEnforcement | "eval_only";
export type CapabilityCriticality = "required" | "optional";

export type CapabilityPredicate =
  | { kind: "always" }
  | { kind: "never" }
  | { kind: "stage_is"; stage: CapabilityStage }
  | { kind: "chapter_number_gte"; value: number }
  | { kind: "chapter_number_lte"; value: number }
  | { kind: "intent_field_equals"; field: string; value: string }
  | { kind: "intent_field_includes"; field: string; value: string }
  | { kind: "context_meta_equals"; field: string; value: string }
  | { kind: "state_summary_equals"; field: string; value: string };

export interface RequiredInputContract {
  name: string;
  source: "chapter_intent" | "context_package_meta" | "official_state_summary" | "activation_manifest";
  required: boolean;
}

export interface OutputArtifactContract {
  kind: CapabilityOutputKind;
  schemaId: string;
}

export interface ContentAddressedPayloadRef {
  mediaType: "application/json" | "text/plain";
  payloadHash: string;
  sourceRef: string;
}

export interface StopCondition {
  kind: "max_tool_calls" | "max_output_artifacts" | "budget_exhausted" | "no_match";
  value?: number;
}

export interface CapabilityBudgetPolicy {
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxLatencyMs: number;
  maxCost: number;
}

export interface CapabilityBudgetReservation {
  reservationId: string;
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxLatencyMs: number;
  maxCost: number;
}

export interface CapabilityBudgetUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cost: number;
}

export interface CapabilityCostEstimate {
  estimatedCalls: number;
  estimatedTokens: number;
}

export interface PackageRef {
  packageId: string;
  version?: string;
}

export interface ModelCapabilityRequirement {
  capability:
    | "nativeFunctionCalling"
    | "responseSchema"
    | "structuredToolCallParser"
    | "toolResultContinuation"
    | "nativeSystemInstruction";
  required: true;
}

export interface ProvenanceRef {
  sourceId: string;
  sourceType: string;
  accessedAt?: string;
}

export interface AdmissionEvidenceRef {
  evalManifestId: string;
  sampleSize: number;
  validatedWinRate: number | null;
  reason: string;
}

export interface CapabilityPackageManifest {
  schemaVersion: typeof CAPABILITY_PACKAGE_SCHEMA_VERSION;
  packageId: string;
  version: string;
  slot: string;
  kind: CapabilityPackageKind;
  purpose: string;
  applicableWhen: CapabilityPredicate[];
  excludedWhen: CapabilityPredicate[];
  requiredInputs: RequiredInputContract[];
  outputArtifacts: OutputArtifactContract[];
  payloadRef: ContentAddressedPayloadRef;
  targetStages: CapabilityStage[];
  allowedTools: string[];
  stopConditions: StopCondition[];
  budgetPolicy: CapabilityBudgetPolicy;
  authority: MethodologyAuthority;
  enforcement: CapabilityPackageEnforcement;
  dependencies: PackageRef[];
  conflicts: PackageRef[];
  modelCapabilityRequirements: ModelCapabilityRequirement[];
  provenance: ProvenanceRef[];
  evalManifestId: string;
  admissionEvidence: AdmissionEvidenceRef[];
  contentHash: string;
  status: CapabilityPackageStatus;
  criticality: CapabilityCriticality;
}

export interface CapabilityPayloadRecord {
  payloadHash: string;
  mediaType: ContentAddressedPayloadRef["mediaType"];
  body: unknown;
  sourceRef: string;
}

export interface CapabilityPackageSet {
  schemaVersion: typeof CAPABILITY_PACKAGE_SET_SCHEMA_VERSION;
  packages: CapabilityPackageManifest[];
  payloads: CapabilityPayloadRecord[];
}

export interface CapabilityCatalogEntry {
  packageId: string;
  version: string;
  purpose: string;
  targetStage: CapabilityStage;
  estimatedCost: CapabilityCostEstimate;
  outputKinds: CapabilityOutputKind[];
  activationId: string;
}

export interface CapabilityActivationDecision {
  activationId: string;
  packageId: string;
  version: string;
  targetStage: CapabilityStage;
  decision: CapabilityActivationDecisionKind;
  reasons: string[];
  grantedTools: string[];
  reservedBudget: CapabilityBudgetReservation;
  payloadHash: string;
}

export interface CapabilityActivationManifest {
  schemaVersion: typeof CAPABILITY_ACTIVATION_SCHEMA_VERSION;
  runId: string;
  workspaceId: string;
  chapterId: string;
  releaseId: string;
  bundleId: string;
  capabilityPackageSetHash: string;
  routeCapabilityKey: CapabilityKey;
  catalogHash: string;
  decisions: CapabilityActivationDecision[];
  issuedAt: string;
  manifestHash: string;
}

export interface CapabilityOutputEnvelope {
  schemaVersion: typeof CAPABILITY_OUTPUT_SCHEMA_VERSION;
  activationId: string;
  packageId: string;
  outputKind: CapabilityOutputKind;
  artifacts: unknown[];
  sourceRefs: string[];
  toolCallIds: string[];
  budgetUsed: CapabilityBudgetUsage;
  stopReason: "completed" | "no_match" | "budget_exhausted" | "blocked" | "not_applicable";
  outputArtifactHash: string;
}

export interface CapabilityConsumptionEvent {
  schemaVersion: typeof CAPABILITY_CONSUMPTION_LEDGER_SCHEMA_VERSION;
  runId: string;
  chapterId: string;
  releaseId: string;
  bundleId: string;
  packageId: string;
  version: string;
  activationId: string | null;
  targetStage: CapabilityStage | null;
  event: CapabilityConsumptionEventName;
  reason: string;
  payloadHash: string | null;
  outputArtifactHash: string | null;
  contextPackageHash: string | null;
  modelInputHash: string | null;
  modelTurnId: string | null;
  grantedTools: string[];
  toolCallIds: string[];
  budgetReserved: CapabilityBudgetReservation | null;
  budgetUsed: CapabilityBudgetUsage | null;
  timestamp: string;
}

export interface CapabilityChapterFacts {
  chapterNumber: number;
  stage: CapabilityStage;
  intent: Record<string, unknown>;
  contextMeta: Record<string, unknown>;
  stateSummary: Record<string, unknown>;
}

export const RAW_FORBIDDEN_ENFORCEMENTS: ReadonlySet<CapabilityPackageEnforcement> = new Set([
  "candidate_only",
  "review_only",
  "excluded_from_raw",
  "eval_only",
]);

const LEGAL_KIND_ENFORCEMENT: Record<CapabilityPackageKind, ReadonlySet<CapabilityPackageEnforcement>> = {
  workflow_skill: new Set(["candidate_only", "excluded_from_raw", "review_only", "eval_only"]),
  craft_gene: new Set(["candidate_only", "excluded_from_raw", "eval_only"]),
  prompt_pattern: new Set(["candidate_only", "excluded_from_raw", "eval_only"]),
  editorial_strategy: new Set(["candidate_only", "eval_only"]),
  diagnostic_module: new Set(["review_only", "eval_only"]),
};

const LEGAL_KIND_AUTHORITY: Record<CapabilityPackageKind, ReadonlySet<MethodologyAuthority>> = {
  workflow_skill: new Set(["methodology", "heuristic"]),
  craft_gene: new Set(["methodology", "heuristic"]),
  prompt_pattern: new Set(["methodology", "heuristic"]),
  editorial_strategy: new Set(["methodology"]),
  diagnostic_module: new Set(["methodology", "heuristic"]),
};

export function isLegalKindAuthorityEnforcement(
  kind: CapabilityPackageKind,
  authority: MethodologyAuthority,
  enforcement: CapabilityPackageEnforcement,
): boolean {
  if (authority === "author" || authority === "accepted_text") return false;
  if (enforcement === "hard_boundary" || enforcement === "generation_context") return false;
  return (
    LEGAL_KIND_AUTHORITY[kind].has(authority)
    && LEGAL_KIND_ENFORCEMENT[kind].has(enforcement)
  );
}

export function mayEnterRawChannel(enforcement: CapabilityPackageEnforcement): boolean {
  return !RAW_FORBIDDEN_ENFORCEMENTS.has(enforcement);
}

export function isExecutableProductionStatus(status: CapabilityPackageStatus): boolean {
  return status === "active";
}

export function isIsolatedEvalStatus(status: CapabilityPackageStatus): boolean {
  return status === "eval" || status === "canary";
}

export function emptyBudgetReservation(): CapabilityBudgetReservation {
  return {
    reservationId: "",
    maxCalls: 0,
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxLatencyMs: 0,
    maxCost: 0,
  };
}

export function emptyBudgetUsage(): CapabilityBudgetUsage {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    cost: 0,
  };
}
