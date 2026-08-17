/**
 * REPAIR-AUTHORIZATION-CONTRACTS — 修订授权与候选谱系最小契约（REASONING-REPAIR-BOUNDARY-1 Phase 0）
 *
 * 冻结修订授权、候选谱系与修订阶梯的最小契约（计划 §3、§4）。本模块只定义
 * 协议类型、枚举、映射表与不变量常量，**不含 I/O，不含授权策略实现**。
 *
 * 关键边界（计划 §1）：
 * - 模型可自由思考与提出修订动作，但**不得自行授予正文修改权**；
 * - 任何正文变化都必须可定位、可证明、可拒绝、可回放，并产生新的不可变候选；
 * - 授权只能由 orchestrator/system 签发（`OrchestratorDecision` 是唯一裁决真相源）。
 *
 * 复用边界（计划 §2.1，禁止平行 schema）：
 * - 权威复用 `AuthorityClass`（memory-record.ts），不新造 evidenceAuthority 枚举；
 * - 证据身份复用 `EvidenceRecord`（evidence-governance-contracts.ts），新增
 *   `evidenceExcerptHash` 与补齐非空 `sourceContentHash`；
 * - 候选关系复用 `AgentLineage` 的 candidateId / sourceCandidateId / parentCandidateId；
 * - 裁决复用 `OrchestratorDecision`；审计复用 `AuditEvent` 的 candidate_created /
 *   candidate_derived / gate_evaluated / repair_started / repair_completed。
 *
 * 命名可在实现评审时微调，但不得弱化字段或形成平行裁决协议（计划 §3.3）。
 */

import type { TextSpan } from "./types.js";
import type { AuthorityClass } from "./memory/memory-record.js";
// type-only：仅复用 failure type 字面量，避免反向运行时依赖与平行枚举。
import type { VerificationFailureType } from "../../novelos/verification/narrative-verifier-types.js";

// ============================================================================
// 版本
// ============================================================================

export const REPAIR_AUTHORIZATION_CONTRACT_ID =
  "REASONING-REPAIR-BOUNDARY-1" as const;
export const REPAIR_AUTHORIZATION_SCHEMA_VERSION = 1 as const;

// ============================================================================
// 修订动作与阶梯（计划 §3.1）
// ============================================================================

/** 系统授权可签发的动作。模型返回的 approved/authorized/severity 字段不能产生任何动作。 */
export type RepairAction =
  | "no_op"
  | "span_patch"
  | "paragraph_patch"
  | "bridge_patch"
  | "new_candidate"
  | "block"
  | "human_review";

/**
 * 修订阶梯（从最小干预到最大干预）。
 * `new_candidate` 是生成新的完整候选，不是覆盖父候选的 chapter_rewrite。
 */
export const REPAIR_LADDER = [
  "no_op",
  "span_patch",
  "paragraph_patch",
  "bridge_patch",
  "new_candidate",
] as const;

export type RepairLadderStep = (typeof REPAIR_LADDER)[number];

// ============================================================================
// 修订授权（计划 §3.3）
// ============================================================================

/**
 * 系统签发的、一次性有效的修订授权。
 *
 * 不变量：
 * - 授权绑定父候选 hash（candidateTextHash）；父候选内容变化、snapshot 变化或
 *   预算 reservation 失效时授权立即失效；
 * - authorizedRanges 必须规范化、非越界、非重叠；零宽插入只允许显式白名单情形；
 * - new_candidate 的 authorizedRanges 必须为空，且进入新的生成请求，不进入 patch merger；
 * - 授权只对一次执行有效；重试必须产生新 authorization 或结构化停止。
 */
export interface RepairAuthorization {
  authorizationId: string;
  orchestratorDecisionId: string;
  candidateId: string;
  candidateTextHash: string;
  findingIds: string[];
  evidenceIds: string[];
  snapshotId: string;
  evidenceExcerptHashes: string[];
  action: RepairAction;
  authorizedRanges: TextSpan[];
  budgetReservationId: string | null;
  issuedBy: "orchestrator" | "system";
  reasonCode: RepairReasonCode;
  expiresAt: string;
}

// ============================================================================
// 修订授权策略决策（RRB-1.3 实现目标；本模块只冻结形状）
// ============================================================================

/** 授权策略的 fail-closed 裁决输出。任一准入条件不满足时必须 deny。 */
export interface RepairAuthorizationPolicyDecision {
  decision: "authorized" | "denied";
  action: RepairAction;
  /** 仅 decision=authorized 时存在 */
  authorization?: RepairAuthorization;
  reasonCode: RepairReasonCode;
  /** 命中的全部拒绝/放行理由（可解释性） */
  reasons: string[];
}

// ============================================================================
// 失败类型 → 允许动作白名单（计划 §3.1）
// ============================================================================

/**
 * failure type → 允许的自动修订动作。
 *
 * 白名单语义：某 failure type 未列入动作，即禁止该动作。
 * 未列入本表的 failure type（未来新增）默认只允许 no_op/block/human_review。
 *
 * 注意：此表只决定“动作类型是否允许”；是否真正签发还要同时满足 §3.2 全部
 * 准入条件（确定性、权威证据、snapshot、hash、有效 span、orchestrator 签发、预算）。
 */
export const FAILURE_TYPE_TO_ALLOWED_ACTION: Readonly<
  Record<VerificationFailureType, readonly RepairAction[]>
> = {
  // 可定位格式损坏 / 重复污染 → 局部句级修复
  format_error: ["span_patch", "new_candidate"],
  duplicate_pollution: ["span_patch"],
  entity_hallucination: ["span_patch"],
  knowledge_boundary: ["span_patch", "new_candidate"],
  canon_conflict: ["span_patch"],
  promise_conflict: ["span_patch"],
  fact_contradiction: ["span_patch"],
  // 有权威事实且落点明确的事实遗漏 → 段落级修复
  fact_omission: ["paragraph_patch"],
  intent_omission: ["paragraph_patch", "new_candidate"],
  // 两个确定场景锚点间的时间/空间断裂 → 桥接修复
  scene_continuity: ["bridge_patch"],
  timeline_inconsistency: ["bridge_patch"],
  location_discontinuity: ["bridge_patch"],
  // 骨架/事件推进不一致 → 允许局部或段落修复，但需有效 span
  skeleton_inconsistency: ["span_patch", "paragraph_patch"],
  event_progression: ["span_patch", "paragraph_patch"],
  // 文学软诊断 → 只进 Review Surface，永不自动改文
  language_risk: ["no_op", "human_review"],
  // 正向覆盖证据 → 无需修复
  intent_covered: ["no_op"],
  // 作者输入自相矛盾 → 阻断并要求修订输入，正文修订不得掩盖输入冲突
  author_input_conflict: ["block", "human_review"],
};

/** 未列入 FAILURE_TYPE_TO_ALLOWED_ACTION 的类型默认允许的动作（fail-closed）。 */
export const UNKNOWN_FAILURE_TYPE_DEFAULT_ACTION: readonly RepairAction[] = [
  "no_op",
  "block",
  "human_review",
];

/**
 * 允许动作是否可导致自动正文修改（用于计数断言
 * `literary_advisory_auto_edits=0` 与 `unauthorized_edit=0`）。
 */
export function isAutoEditingAction(action: RepairAction): boolean {
  return (
    action === "span_patch" ||
    action === "paragraph_patch" ||
    action === "bridge_patch" ||
    action === "new_candidate"
  );
}

// ============================================================================
// 修订理由码（RRB-1.4 / RRB-5.6）
// ============================================================================

/**
 * 结构化拒绝/放行理由码。禁止笼统“修订失败”。
 * - 前缀 semantics：`deny_` = 准入拒绝；`stop_` = 循环停止；`require_` = 强制动作。
 */
export type RepairReasonCode =
  // 证据身份不完整（§3.2 fail-closed）
  | "deny_missing_authority"
  | "deny_missing_evidence"
  | "deny_missing_snapshot"
  | "deny_missing_content_hash"
  | "deny_missing_excerpt_hash"
  | "deny_source_ref_not_authoritative"
  | "deny_diagnostic_id_as_source_ref"
  | "deny_missing_lineage"
  // 一致性失效
  | "deny_stale_snapshot"
  | "deny_stale_candidate_hash"
  | "deny_evidence_hash_mismatch"
  // 范围非法
  | "deny_invalid_span"
  | "deny_overlapping_span"
  | "deny_out_of_bounds_span"
  | "deny_range_outside_authorized"
  // 失败类型/确定性不允许
  | "deny_heuristic_finding"
  | "deny_insufficient_certainty"
  | "deny_action_not_allowed_for_failure_type"
  | "deny_missing_bridge_anchor"
  | "deny_not_orchestrator_issued"
  // 预算
  | "deny_budget_exhausted"
  // 强制动作
  | "require_new_candidate"
  | "require_block"
  | "require_human_review"
  | "require_input_revision"
  // 授权通过
  | "authorized";

// ============================================================================
// 停止原因（RRB-4.4）
// ============================================================================

/** 修订循环的结构化退出原因（收敛为单一可解释枚举）。 */
export type RepairStopReason =
  | "cleared"
  | "budget_exhausted"
  | "stagnant"
  | "no_authorized_action"
  | "stale_authorization"
  | "comparator_rejected"
  | "new_hard_finding"
  | "request_new_candidate"
  | "blocked";

// ============================================================================
// 失败分类（RRB-5.6）
// ============================================================================

/**
 * 修订/验证边界的 FailureEnvelope 可区分类别。
 * 禁止笼统“修订失败”——每条失败必须映射到这五个之一（或显式非失败出口）。
 *
 * - verification_blocked：verifier 未清零（orchestrator 的 verifier gate）。
 * - repair_unauthorized：修订授权被拒（deny_* 理由码 / 预算耗尽 / 无授权动作 / 授权过期）。
 * - candidate_integrity：候选 hash / lineage 断裂（hash 绑定失败 / comparator 拒绝 / 新 hard finding）。
 * - repair_stagnant：修订循环停滞。
 * - new_candidate_required：灾难级问题要求生成新候选。
 */
export type RepairFailureCategory =
  | "verification_blocked"
  | "repair_unauthorized"
  | "candidate_integrity"
  | "repair_stagnant"
  | "new_candidate_required";

export const REPAIR_FAILURE_CATEGORIES: readonly RepairFailureCategory[] = [
  "verification_blocked",
  "repair_unauthorized",
  "candidate_integrity",
  "repair_stagnant",
  "new_candidate_required",
];

/** RepairStopReason → RepairFailureCategory；`cleared` 非失败返回 null。 */
export function repairStopReasonToFailureCategory(
  stopReason: RepairStopReason,
): RepairFailureCategory | null {
  switch (stopReason) {
    case "cleared":
      return null;
    case "stagnant":
      return "repair_stagnant";
    case "budget_exhausted":
    case "no_authorized_action":
    case "stale_authorization":
      return "repair_unauthorized";
    case "comparator_rejected":
    case "new_hard_finding":
      return "candidate_integrity";
    case "request_new_candidate":
      return "new_candidate_required";
    case "blocked":
      return "verification_blocked";
    default: {
      // fail-closed：未知停止原因不得静默吞掉。
      const _exhaustive: never = stopReason;
      throw new Error(`未知 RepairStopReason 无法归类：${String(_exhaustive)}`);
    }
  }
}

/**
 * RepairReasonCode → RepairFailureCategory。
 * - 全部 deny_* → repair_unauthorized（授权被拒）。
 * - require_new_candidate → new_candidate_required。
 * - require_block / require_human_review / require_input_revision / authorized
 *   是显式非失败出口，返回 null（不属于修订失败分类）。
 */
export function repairReasonCodeToFailureCategory(
  reasonCode: RepairReasonCode,
): RepairFailureCategory | null {
  if (reasonCode === "require_new_candidate") return "new_candidate_required";
  if (reasonCode.startsWith("deny_")) return "repair_unauthorized";
  return null;
}

// ============================================================================
// 文学软诊断计数断言（RRB-5.5）
// ============================================================================

/**
 * 文学软诊断 failure type（只进 Review Surface，永不自动改文）。
 * 保持与 FAILURE_TYPE_TO_ALLOWED_ACTION 中 language_risk 的 no_op/human_review 一致。
 */
export const LITERARY_ADVISORY_FAILURE_TYPES = ["language_risk"] as const;

/**
 * 生产计数断言 `literary_advisory_auto_edits=0`：
 * 给定 (failureType, action) 决策集，返回文学软诊断触发自动改文的次数。
 * 正常生产路径恒为 0（language_risk 只允许 no_op/human_review）。
 */
export function countLiteraryAdvisoryAutoEdits(
  decisions: ReadonlyArray<{ failureType: VerificationFailureType; action: RepairAction }>,
): number {
  return decisions.filter(
    (d) =>
      (LITERARY_ADVISORY_FAILURE_TYPES as readonly string[]).includes(d.failureType) &&
      isAutoEditingAction(d.action),
  ).length;
}

// ============================================================================
// 自动修订准入条件清单（计划 §3.2）
// ============================================================================

/**
 * 自动修订必须同时满足的全部条件。任一不满足时，决策只能是
 * `no_op`、`request_new_candidate`、`block` 或 `human_review`，不得修改正文。
 * 本常量供 RRB-1.3 的 RepairAuthorizationPolicy 逐项 fail-closed 校验引用。
 */
export const REPAIR_ADMISSION_CONDITIONS = [
  "hard_finding",
  "deterministic_or_corroborated",
  "authoritative_evidence_record",
  "same_source_snapshot",
  "non_empty_source_content_hash",
  "non_empty_evidence_excerpt_hash",
  "complete_evidence_lineage",
  "valid_authorized_repair_span",
  "action_allowed_for_failure_type",
  "system_issued_authorization",
  "repair_budget_available",
] as const;

export type RepairAdmissionCondition =
  (typeof REPAIR_ADMISSION_CONDITIONS)[number];

// ============================================================================
// 候选谱系（计划 §4.1）
// ============================================================================

export type CandidateDerivationType =
  | "agentic_generation"
  | "span_patch"
  | "paragraph_patch"
  | "bridge_patch"
  | "new_candidate"
  | "author_style_transform"
  | "user_edit";

/**
 * 每次初稿、成功 patch、新候选生成和作者风格转换都必须生成独立 manifest。
 *
 * 存储规则（计划 §4.2）：
 * - 正文与 manifest 以 append-only 写入 `novelos-sessions/{sessionId}/candidates/`；
 * - `current-candidate.json` 只保存当前指针 + candidateId + textHash，原子替换；
 * - comparator / post-verification gate 拒绝时，可保存 rejected artifact 供审计，
 *   但不得移动 current pointer；
 * - candidateId 必须包含运行身份与内容 hash，不得使用每章固定 ID 表示多轮不同正文。
 */
export interface CandidateRevisionManifest {
  candidateId: string;
  chapterId: string;
  parentCandidateId: string | null;
  sourceCandidateId: string | null;
  derivationType: CandidateDerivationType;
  textArtifactRef: string;
  textHash: string;
  parentTextHash: string | null;
  diffArtifactRef: string | null;
  diffHash: string | null;
  authorizationId: string | null;
  verifierReportId: string | null;
  createdAt: string;
}

// ============================================================================
// RRB-0.3 现有类型字段映射（复用，禁止平行 schema）
// ============================================================================

/**
 * 新契约字段 → 现有协议字段的复用映射。实现（Phase 1+）必须复用右列现有字段，
 * 不得新建第二套 Candidate store / EvidenceRecord / 权限枚举 / 审计事件库。
 */
export const REPAIR_CONTRACT_REUSE_MAP = {
  authority: "MemoryRecord.authorityClass (AuthorityClass)",
  evidenceIdentity: "EvidenceRecord.evidenceId",
  evidenceSnapshot: "EvidenceRecord.snapshotId / NarrativeEvidenceSnapshot.snapshotId",
  sourceContentHash: "EvidenceRecord.sourceContentHash（现为空，需补齐非空）",
  evidenceExcerptHash: "EvidenceRecord.evidenceExcerptHash（新增字段）",
  authorizationDecisionId: "OrchestratorDecision.decisionId",
  candidateParent: "AgentLineage.parentCandidateId",
  candidateSource: "AgentLineage.sourceCandidateId",
  candidateIdentity: "AgentLineage.candidateId / AgentLineageIndex.byCandidate",
  candidateContentHash: "AuditArtifactRef.contentHash / AuditSourceRef.contentHash",
  auditCandidateCreated: "AuditEvent.eventType=candidate_created",
  auditCandidateDerived: "AuditEvent.eventType=candidate_derived",
  auditGateEvaluated: "AuditEvent.eventType=gate_evaluated",
  auditRepairStarted: "AuditEvent.eventType=repair_started",
  auditRepairCompleted: "AuditEvent.eventType=repair_completed",
} as const;

export type RepairContractReuseKey = keyof typeof REPAIR_CONTRACT_REUSE_MAP;

/** 权威等级别名：授权必须基于 AuthorityClass，不得新造枚举。 */
export type AuthorizedAuthorityClass = AuthorityClass;

// ============================================================================
// 不变量（计划 §3.3 / §4.2，供实现与测试引用）
// ============================================================================

export const REPAIR_AUTHORIZATION_INVARIANTS = [
  "模型返回的 approved/authorized/severity/sourceRef 字段不能生成授权",
  "授权绑定父候选 hash；父候选内容变化、snapshot 变化或 budget reservation 失效时授权立即失效",
  "authorizedRanges 必须规范化、非越界、非重叠；零宽插入只允许显式白名单情形",
  "new_candidate 的 authorizedRanges 必须为空，且进入新的生成请求，不进入 patch merger",
  "授权只对一次执行有效；重试必须产生新 authorization 或结构化停止",
] as const;

export const CANDIDATE_LINEAGE_INVARIANTS = [
  "每次初稿、成功 patch、新候选生成和作者风格转换都必须生成独立 manifest",
  "已存在 candidateId 不得覆盖；原候选正文与 manifest 永不变化",
  "current pointer 只能指向已接受且已复验候选",
  "comparator 或 post-verification gate 拒绝时，不移动 current pointer",
  "candidateId 必须包含运行身份和内容 hash",
] as const;
