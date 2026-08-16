/**
 * CONTEXT-EVIDENCE-GOVERNANCE-1 / CEG-0.1 + CEG-0.4 + CEG-0.5
 *
 * 冻结知识检索、证据选择与 ContextCompiler 质量治理契约。
 * 本模块只定义协议类型、映射表、FailureEnvelope gate 名和生产 A 基线常量。
 * 不含 I/O，不改变现有读取/排序/裁剪/渲染行为。
 *
 * 真相源：docs/knowledge-retrieval-evidence-context-compiler-governance-development-plan-20260815.md §4
 */

import type { AuditStage } from "./audit/audit-event-types.js";
import type { CreativeConstitution } from "./creative-constitution.js";
import type { FailureClass } from "./failure-types.js";
import type { NarrativeStateStore } from "./final-state-commit.js";
import type { AuthorityClass, EpistemicStatus, LifecycleStatus, MemoryType } from "./memory/memory-record.js";
import type { Authority, TrustClass } from "./trust/trust-types.js";
import type { NarrativeResultKind } from "../../novelos/tools/tool-protocol.js";

export const CEG_CONTRACT_SCHEMA_VERSION = 1 as const;
export const CEG_CONTRACT_ID = "CONTEXT-EVIDENCE-GOVERNANCE-1" as const;

// ============================================================================
// 4.1 NarrativeEvidenceSnapshot
// ============================================================================

/** 已接受正文的内容寻址引用；读取时必须校验 contentHash。 */
export interface AcceptedChapterEvidenceRef {
  chapterId: string;
  chapterNumber: number;
  contentHash: string;
  locator: string;
}

export interface NarrativeEvidenceSnapshot {
  schemaVersion: number;
  snapshotId: string;
  workspaceId: string;
  workspaceRevision: string;
  lastCommittedChapter: string | null;
  releaseId: string;
  createdAt: string;
  knowledgeSnapshotHash: string;
  creativeConstitution: CreativeConstitution | null;
  narrativeState: Readonly<NarrativeStateStore>;
  acceptedChapterIndex: readonly AcceptedChapterEvidenceRef[];
  sourceHashes: Readonly<Record<string, string>>;
}

// ============================================================================
// 4.2 EvidenceRecord
// ============================================================================

/**
 * EvidenceRecord.epistemicStatus 是证据认识状态，比 MemoryRecord 更窄：
 * 查询“有没有结果”不得占用本枚举。
 */
export type EvidenceEpistemicStatus =
  | "confirmed"
  | "derived"
  | "advisory"
  | "conflicted";

export interface EvidenceRecord {
  evidenceId: string;
  statement: string;
  authorityClass: AuthorityClass;
  epistemicStatus: EvidenceEpistemicStatus;
  sourceRef: string;
  /** 权威源内容 hash（canon/character/promise/pattern 源条目；非空，供修订准入回源校验） */
  sourceContentHash: string;
  /** 证据摘录 hash（实际交付给模型的证据 statement；非空） */
  evidenceExcerptHash: string;
  validFrom: string | null;
  validUntil: string | null;
  matchedBecause: string[];
  retrievalQueryId: string | null;
  snapshotId: string;
  traceable: boolean;
}

// ============================================================================
// 4.3 RetrievalOutcome
// ============================================================================

export type RetrievalOutcomeStatus =
  | "match"
  | "no_match"
  | "retrieval_error"
  | "truncated";

export interface RetrievalOutcome {
  queryId: string;
  status: RetrievalOutcomeStatus;
  evidence: EvidenceRecord[];
  nextQueryHint: string | null;
  budget: { usedCalls: number; remainingCalls: number };
}

export function buildRetrievalOutcome(input: {
  queryId: string;
  evidence: EvidenceRecord[];
  error?: string | null;
  truncated?: boolean;
  nextQueryHint?: string | null;
  usedCalls: number;
  remainingCalls: number;
}): RetrievalOutcome {
  let status: RetrievalOutcomeStatus = "match";
  if (input.error) status = "retrieval_error";
  else if (input.truncated) status = "truncated";
  else if (input.evidence.length === 0) status = "no_match";
  return {
    queryId: input.queryId,
    status,
    evidence: input.evidence,
    nextQueryHint: input.nextQueryHint ?? null,
    budget: { usedCalls: input.usedCalls, remainingCalls: input.remainingCalls },
  };
}

// ============================================================================
// 4.4 EvidenceSelectionDecision
// ============================================================================

export const EVIDENCE_SELECTION_STAGES = [
  "eligibility",
  "authority_partition",
  "conflict_isolation",
  "required_evidence_reservation",
  "match_quality_within_authority_tier",
  "temporal_validity_or_recency",
  "diversity",
  "token_utility",
] as const;

export type EvidenceSelectionStage = (typeof EVIDENCE_SELECTION_STAGES)[number];

export interface EvidenceSelectionDecision {
  snapshotId: string;
  stages: readonly EvidenceSelectionStage[];
  selectedEvidenceIds: readonly string[];
  rejected: ReadonlyArray<{ evidenceId: string; stage: EvidenceSelectionStage; reason: string }>;
  conflictSetIds: readonly string[];
}

// ============================================================================
// 4.5 ContextDeliveryLedger
// ============================================================================

export const CONTEXT_DELIVERY_ACTIONS = [
  "discovered",
  "eligible",
  "rejected",
  "selected",
  "rendered_preloaded",
  "retrieved_on_demand",
  "delivered_to_model",
  "dropped",
] as const;

export type ContextDeliveryAction = (typeof CONTEXT_DELIVERY_ACTIONS)[number];

export interface ContextDeliveryLedgerEvent {
  evidenceId: string;
  snapshotId: string;
  queryId: string | null;
  modelTurnId: string | null;
  action: ContextDeliveryAction;
  reason: string;
  sourceRef: string;
  contentHash: string;
  contextPackageHash: string | null;
  modelInputHash: string | null;
  tokenEstimate: number | null;
}

export interface ContextDeliveryLedger {
  snapshotId: string;
  events: readonly ContextDeliveryLedgerEvent[];
}

// ============================================================================
// 4.6 Hash 口径
// ============================================================================

export const CEG_CONTENT_HASH_KINDS = [
  "knowledgeSnapshotHash",
  "contextPackageHash",
  "modelInputHash",
] as const;

export type CegContentHashKind = (typeof CEG_CONTENT_HASH_KINDS)[number];

/** 旧数量签名形态：f{n}-l{n}-c{n}-w{n}-s{n} */
export const LEGACY_QUANTITY_CONTEXT_HASH_PATTERN = /^f\d+-l\d+-c\d+-w\d+-s\d+$/;

export function isLegacyQuantityContextHash(value: string): boolean {
  return /^f\d+-l\d+-c\d+-w\d+-s\d+$/.test(value);
}

// ============================================================================
// CEG-0.1 现有类型映射（复用，禁止平行枚举）
// ============================================================================

export const MEMORY_TO_EVIDENCE_EPISTEMIC: Readonly<
  Record<EpistemicStatus, EvidenceEpistemicStatus | "not_evidence">
> = {
  declared: "confirmed",
  confirmed: "confirmed",
  derived: "derived",
  planned: "not_evidence",
  hypothesis: "advisory",
  disputed: "conflicted",
  superseded: "not_evidence",
};

export const AUTHORITY_CLASS_TO_TRUST_CLASS: Readonly<
  Record<AuthorityClass, TrustClass>
> = {
  author_declaration: "author_authority",
  final_text_explicit: "committed_state",
  committed_state: "committed_state",
  system_derived: "retrieved_reference",
  model_planned: "model_or_user_untrusted",
  diagnostic_hypothesis: "model_or_user_untrusted",
};

export const AUTHORITY_CLASS_TO_SLOT_AUTHORITY: Readonly<
  Record<AuthorityClass, Authority>
> = {
  author_declaration: "hard_constraint",
  final_text_explicit: "hard_constraint",
  committed_state: "hard_constraint",
  system_derived: "reference_only",
  model_planned: "no_authority",
  diagnostic_hypothesis: "evidence_only",
};

export const MEMORY_TYPE_DEFAULT_ROLE: Readonly<
  Record<MemoryType, "hard_fact_candidate" | "advisory" | "not_retrievable_as_fact">
> = {
  working: "not_retrievable_as_fact",
  chapter_fact: "hard_fact_candidate",
  canon: "hard_fact_candidate",
  character: "hard_fact_candidate",
  promise: "hard_fact_candidate",
  pattern: "advisory",
  chapter_summary: "advisory",
  source_text: "hard_fact_candidate",
  plan: "not_retrievable_as_fact",
  diagnostic: "not_retrievable_as_fact",
};

export const LIFECYCLE_ELIGIBILITY: Readonly<
  Record<LifecycleStatus, "eligible" | "reject">
> = {
  active: "eligible",
  expired: "reject",
  superseded: "reject",
  conflicted: "reject",
  archived: "reject",
};

/**
 * 工具 resultKind → RetrievalOutcome.status。
 * truncated 是 NarrativeToolResultDetails 上的布尔字段，不是 resultKind。
 * 读失败走 TrustedToolResult.ok=false / error，不得写成 no_match。
 */
export const TOOL_RESULT_KIND_TO_OUTCOME_STATUS: Readonly<
  Record<NarrativeResultKind, Exclude<RetrievalOutcomeStatus, "retrieval_error" | "truncated">>
> = {
  no_match: "no_match",
  canon_entries: "match",
  character_state: "match",
  character_knowledge_boundary: "match",
  timeline_events: "match",
  promise_entries: "match",
  pattern_entries: "match",
  voice_evidence: "match",
  chapter_spans: "match",
  ranked_evidence: "match",
};

export function retrievalOutcomeStatusFromToolResult(input: {
  resultKind?: NarrativeResultKind;
  truncated?: boolean;
  ok?: boolean;
  error?: { code?: string } | null;
}): RetrievalOutcomeStatus {
  if (input.ok === false || input.error) return "retrieval_error";
  if (input.truncated === true) return "truncated";
  if (!input.resultKind) return "retrieval_error";
  return TOOL_RESULT_KIND_TO_OUTCOME_STATUS[input.resultKind];
}

export const REUSED_EXISTING_TYPES = [
  "MemoryRecord.authorityClass",
  "MemoryRecord.epistemicStatus",
  "MemoryRecord.lifecycleStatus",
  "MemoryRecord.sourceRef / textHash",
  "ContextPackage / ContextSlotItem / contextHash",
  "TrustedToolResult.contentHash / evidenceRefs / contentTrust",
  "NarrativeToolResultDetails.resultKind / truncated / nextQueryHint",
  "AuditEvent + TrustAuditEvent",
  "UnifiedProductionFailureEnvelope.stage / gate / failureClass",
] as const;

// ============================================================================
// CEG-0.5 FailureEnvelope gate 名
// ============================================================================

export const CEG_FAILURE_GATES = [
  "snapshot_build",
  "snapshot_hash_mismatch",
  "evidence_conflict",
  "retrieval_error",
  "retrieval_budget_exhausted",
  "must_verify_coverage",
  "context_package_validation",
] as const;

export type CegFailureGate = (typeof CEG_FAILURE_GATES)[number];

/** 现网已写入的同义 gate；接线时映射或同发布替换，不得长期双写。 */
export const CEG_FAILURE_GATE_EXISTING_ALIASES = {
  must_verify_coverage: "unverified_high_risk_facts",
} as const;

export interface CegFailureRecord {
  failureClass: FailureClass;
  stage: AuditStage;
  gate: CegFailureGate;
  reason: string;
  evidence: unknown;
  recoverable: boolean;
}

export function createCegFailure(
  gate: CegFailureGate,
  reason: string,
  evidence?: unknown,
): CegFailureRecord {
  const defaults = CEG_FAILURE_GATE_DEFAULTS[gate];
  return {
    failureClass: defaults.failureClass,
    stage: defaults.stage,
    gate,
    reason,
    evidence: evidence ?? null,
    recoverable: defaults.failureClass === "recoverable",
  };
}

export const CEG_FAILURE_GATE_DEFAULTS: Readonly<
  Record<CegFailureGate, { stage: AuditStage; failureClass: FailureClass }>
> = {
  snapshot_build: { stage: "context_compile", failureClass: "preflight" },
  snapshot_hash_mismatch: { stage: "context_compile", failureClass: "blocked" },
  evidence_conflict: { stage: "gate", failureClass: "blocked" },
  retrieval_error: { stage: "tool", failureClass: "recoverable" },
  retrieval_budget_exhausted: { stage: "agentic", failureClass: "blocked" },
  must_verify_coverage: { stage: "gate", failureClass: "blocked" },
  context_package_validation: { stage: "context_compile", failureClass: "blocked" },
};

// ============================================================================
// CEG-0.4 生产 A 基线（冻结，本计划不得顺手调整）
// ============================================================================

export const CEG_PRODUCTION_A_BASELINE = {
  historicalContinuity: { maxEntries: 4, maxChars: 2400 },
  historicalCharacterState: { maxEntries: 6, maxChars: 1800 },
  recentPatternMemory: { maxEntries: 4, maxChars: 1000 },
  relevantCharacterProfiles: { totalChars: 3200, perEntryChars: 900 },
  retrievalMaxItems: { min: 24, max: 48, divisor: 4 },
  passingScoreThreshold: 10,
  advisoryFloorDivisor: 8,
  promptItemSummaryChars: 160,
  knownSummary: { maxCharsPerItem: 80, maxItems: 12 },
  mustVerifyMaxItems: 8,
  searchChapterSpan: { maxChapters: 10, maxResults: 10, excerptRadius: 40 },
  contextSafetyTokens: {
    modelWindow: 128000,
    outputReserve: 8192,
    safetyMargin: 4096,
  },
  scoreWeights: {
    memoryAuthorDeclared: 50,
    memoryFinalText: 40,
    memoryCommitted: 30,
    memorySystemDerived: -20,
    memoryConfirmed: 20,
    memoryDerived: -10,
    characterExact: 100,
    promiseRequired: 120,
    keywordHit: 40,
    recencyMax: 20,
    promiseHeatCap: 10,
  },
  retrievalCallLimit: { withMustVerify: 4, withoutMustVerify: 2 },
  dedicatedTools: [
    "search_narrative_evidence",
    "search_chapter_span",
    "query_canon",
    "query_character_state",
    "query_timeline",
    "query_character_knowledge_boundary",
    "query_promise_ledger",
    "query_pattern_memory",
    "query_voice_evidence",
  ],
  writerRouteDefault: "v2_rawstage2_gemini31",
  styleRouteDefault: "v2_amplified_gemini31",
  productionRendererProfile: "gemini_writer_v2",
  layeredRendererProfile: "gemini_writer_v2_layered",
} as const;

export type CegProductionABaseline = typeof CEG_PRODUCTION_A_BASELINE;
