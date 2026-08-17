/**
 * REPAIR-AUTHORIZATION-POLICY — 修订授权策略（REASONING-REPAIR-BOUNDARY-1 Wave 2A / RRB-1.3~1.6）
 *
 * 实现 §3.2 的 fail-closed 自动修订准入条件评估。只有 orchestrator/system 可签发授权。
 * 任一条件不满足时，决策只能是 no_op、new_candidate、block 或 human_review，不得修改正文。
 *
 * 入口：evaluateRepairAuthorization() — 逐 finding 评估，返回结构化决策。
 *
 * 复用边界（计划 §2.1）：
 * - 权威复用 AUTHORITY_CLASS_TO_SLOT_AUTHORITY（evidence-governance-contracts.ts）
 * - 失败类型映射复用 FAILURE_TYPE_TO_ALLOWED_ACTION（repair-authorization-contracts.ts）
 * - 未映射类型默认复用 UNKNOWN_FAILURE_TYPE_DEFAULT_ACTION
 */

import type { VerificationFinding } from "../../novelos/verification/narrative-verifier-types.js";
import type { EvidenceRecord } from "./evidence-governance-contracts.js";
import { AUTHORITY_CLASS_TO_SLOT_AUTHORITY } from "./evidence-governance-contracts.js";
import { evaluateEvidenceAuthorityBinding } from "./evidence-eligibility-gate.js";
import {
  type RepairAuthorizationPolicyDecision,
  type RepairAction,
  type RepairReasonCode,
  FAILURE_TYPE_TO_ALLOWED_ACTION,
  UNKNOWN_FAILURE_TYPE_DEFAULT_ACTION,
  isAutoEditingAction,
  REPAIR_LADDER,
} from "./repair-authorization-contracts.js";

// ============================================================================
// 公共输入
// ============================================================================

/** 单 finding 的授权策略评估输入。 */
export interface RepairAuthorizationPolicyInput {
  finding: VerificationFinding;
  /** 全部可用证据记录（按 evidenceId 索引） */
  evidenceRecords: ReadonlyArray<EvidenceRecord>;
  candidateId: string;
  candidateTextHash: string;
  /** 候选正文长度（用于 span 越界校验） */
  candidateTextLength: number;
  snapshotId: string;
  budgetAvailable: boolean;
  /**
   * orchestrator 决策 ID（由签发者/loop 在调用前生成）。
   * RRB-3.7：生产签发者必须填充此字段，把授权与本次编排决策绑定；
   * 未提供时回退为确定性派生 ID（仍可追溯 candidate+finding）。
   */
  orchestratorDecisionId?: string;
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 逐 finding 评估 §3.2 全部准入条件，fail-closed。
 *
 * 任一条件不满足时返回 decision=denied，reasonCode 标识首个命中拒绝条件。
 * 全部条件通过时返回 decision=authorized，附带一次性 RepairAuthorization。
 */
export function evaluateRepairAuthorization(
  input: RepairAuthorizationPolicyInput,
): RepairAuthorizationPolicyDecision {
  const {
    finding,
    evidenceRecords,
    candidateId,
    candidateTextHash,
    candidateTextLength,
    snapshotId,
    budgetAvailable,
    orchestratorDecisionId,
  } = input;

  // ---- 1. hard finding 检查 ----
  if (finding.severity !== "hard" && finding.severity !== "fatal") {
    return deny("deny_heuristic_finding", "no_op", [
      `severity=${finding.severity}，非 hard/fatal，不可自动修订`,
    ]);
  }

  // ---- 2. 确定性检查 ----
  if (finding.certainty !== "deterministic" && finding.certainty !== "corroborated") {
    return deny("deny_insufficient_certainty", "no_op", [
      `certainty=${finding.certainty}，非 deterministic/corroborated`,
    ]);
  }

  // ---- 3. evidenceId 存在 ----
  if (!finding.evidenceId) {
    return deny("deny_missing_evidence", "no_op", [
      "finding.evidenceId 为空，无可回源证据",
    ]);
  }

  // ---- 4. 证据记录可定位 ----
  const evidenceRecord = evidenceRecords.find(
    (e) => e.evidenceId === finding.evidenceId,
  );
  if (!evidenceRecord) {
    return deny("deny_missing_evidence", "no_op", [
      `evidenceId=${finding.evidenceId} 不在提供的证据记录中`,
    ]);
  }

  // ---- 5. 权威证据（非 model_planned / diagnostic_hypothesis） ----
  const slotAuthority = AUTHORITY_CLASS_TO_SLOT_AUTHORITY[evidenceRecord.authorityClass];
  if (slotAuthority === "no_authority" || slotAuthority === "evidence_only") {
    return deny("deny_missing_authority", "no_op", [
      `authorityClass=${evidenceRecord.authorityClass} → slotAuthority=${slotAuthority}，非权威证据`,
    ]);
  }

  // ---- 6. 同一 snapshot ----
  if (evidenceRecord.snapshotId !== snapshotId) {
    return deny("deny_stale_snapshot", "no_op", [
      `evidence.snapshotId=${evidenceRecord.snapshotId} ≠ candidate.snapshotId=${snapshotId}`,
    ]);
  }

  // ---- 7/8. 完整权威绑定：hash + snapshot + chapter/run/candidate 血缘 ----
  const boundLineage = {
    sourceChapter: evidenceRecord.lineage?.sourceChapter,
    chapterNumber: evidenceRecord.lineage?.chapterNumber,
    runId: evidenceRecord.lineage?.runId ?? orchestratorDecisionId ?? `candidate:${candidateId}`,
    candidateId: evidenceRecord.lineage?.candidateId ?? candidateId,
  };
  const authority = evaluateEvidenceAuthorityBinding({
    sourceRef: evidenceRecord.sourceRef,
    snapshotId: evidenceRecord.snapshotId,
    sourceContentHash: evidenceRecord.sourceContentHash,
    evidenceExcerptHash: evidenceRecord.evidenceExcerptHash,
    findingId: finding.id,
    lineage: boundLineage,
  });
  if (authority.decision === "reject") {
    if (authority.reason === "diagnostic_id_as_source_ref") {
      return deny("deny_diagnostic_id_as_source_ref", "no_op", [
        `sourceRef=${evidenceRecord.sourceRef} 不得等于 finding.id`,
      ]);
    }
    if (authority.reason === "missing_source_content_hash") {
      return deny("deny_missing_content_hash", "no_op", [
        "evidence.sourceContentHash 为空",
      ]);
    }
    if (authority.reason === "missing_excerpt_hash") {
      return deny("deny_missing_excerpt_hash", "no_op", [
        "evidence.evidenceExcerptHash 为空",
      ]);
    }
    if (authority.reason === "missing_snapshot") {
      return deny("deny_missing_snapshot", "no_op", [
        "evidence.snapshotId 为空",
      ]);
    }
    if (authority.reason === "missing_lineage") {
      return deny("deny_missing_lineage", "no_op", [
        "evidence 缺少 chapter/run/candidate 血缘，不得授权修订",
      ]);
    }
    return deny("deny_source_ref_not_authoritative", "no_op", [
      `evidence 权威绑定失败：${authority.reason}`,
    ]);
  }
  if (evidenceRecord.lineage?.candidateId && evidenceRecord.lineage.candidateId !== candidateId) {
    return deny("deny_stale_candidate_hash", "no_op", [
      `evidence.lineage.candidateId=${evidenceRecord.lineage.candidateId} ≠ candidateId=${candidateId}`,
    ]);
  }

  // ---- 9. failure type → allowed action 白名单 ----
  const allowedActions: readonly RepairAction[] =
    FAILURE_TYPE_TO_ALLOWED_ACTION[finding.failureType] ??
    UNKNOWN_FAILURE_TYPE_DEFAULT_ACTION;

  // ---- 10. 选择最合适的动作 ----
  let action = selectAction(allowedActions);
  const isFullChapterRange =
    finding.allowedRepairRange.start === 0
    && finding.allowedRepairRange.end === candidateTextLength;
  if (isAutoEditingAction(action) && action !== "new_candidate" && isFullChapterRange) {
    if ((allowedActions as readonly string[]).includes("new_candidate")) {
      action = "new_candidate";
    } else {
      return deny("require_new_candidate", "new_candidate", [
        `failureType=${finding.failureType} 的授权范围为整章，禁止 patch 隐式升级，必须走显式 new_candidate`,
      ]);
    }
  }

  if (!isAutoEditingAction(action)) {
    // 文学软诊断、启发式、作者冲突 → 拒绝自动修改
    if (action === "block") {
      return deny("require_block", "block", [
        `failureType=${finding.failureType}，仅允许 block/human_review，拒绝自动修改`,
      ]);
    }
    if (action === "human_review") {
      return deny("require_human_review", "human_review", [
        `failureType=${finding.failureType}，仅允许 human_review，拒绝自动修改`,
      ]);
    }
    return deny("deny_action_not_allowed_for_failure_type", "no_op", [
      `failureType=${finding.failureType}，允许动作=${allowedActions.join(",")}，非自动编辑动作`,
    ]);
  }

  // ---- 11. 有效 span 检查 ----
  const spanCheck = checkSpanValidity(finding, candidateTextLength);
  if (!spanCheck.ok) {
    return deny(spanCheck.reasonCode, "no_op", [spanCheck.reason]);
  }

  // ---- 12. 预算可用 ----
  if (!budgetAvailable) {
    return deny("deny_budget_exhausted", "no_op", [
      "修订预算已耗尽",
    ]);
  }

  // ======== 全部准入条件通过 → 签发授权 ========
  const authorizationId = buildAuthorizationId(candidateId, finding.id);
  // RRB-3.7：orchestratorDecisionId 由签发者传入；未提供时回退为确定性派生 ID
  const decisionId = orchestratorDecisionId
    ?? `decision-${candidateId}-${finding.id}`;

  return {
    decision: "authorized",
    action,
    reasonCode: "authorized" as RepairReasonCode,
    reasons: [
      "全部 12 项准入条件通过",
      `severity=${finding.severity} certainty=${finding.certainty}`,
      `authorityClass=${evidenceRecord.authorityClass} snapshotId=${snapshotId}`,
      `action=${action} allowedActions=${allowedActions.join(",")}`,
    ],
    authorization: {
      authorizationId,
      orchestratorDecisionId: decisionId,
      candidateId,
      candidateTextHash,
      findingIds: [finding.id],
      evidenceIds: [finding.evidenceId],
      snapshotId,
      evidenceExcerptHashes: [evidenceRecord.evidenceExcerptHash],
      action,
      authorizedRanges: action === "new_candidate" ? [] : [finding.allowedRepairRange],
      budgetReservationId: `resv-${authorizationId}`,
      issuedBy: "system" as const,
      reasonCode: "authorized" as RepairReasonCode,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    },
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 构建 fail-closed 拒绝决策。 */
function deny(
  reasonCode: RepairReasonCode,
  fallbackAction: RepairAction,
  reasons: string[],
): RepairAuthorizationPolicyDecision {
  return {
    decision: "denied",
    action: fallbackAction,
    reasonCode,
    reasons,
  };
}

/** 从允许动作中选择最合适的（按修订阶梯优先最小干预）。 */
function selectAction(allowedActions: readonly RepairAction[]): RepairAction {
  // 按 REPAIR_LADDER 顺序选择第一个允许的动作
  for (const step of REPAIR_LADDER) {
    if ((allowedActions as readonly string[]).includes(step)) {
      return step as RepairAction;
    }
  }
  // 回退：取第一个允许的动作（可能是 block / human_review）
  return allowedActions[0];
}

/** span 有效性检查结果。 */
interface SpanCheckResult {
  ok: boolean;
  reasonCode: RepairReasonCode;
  reason: string;
}

/** 校验 finding 的 allowedRepairRange 是否有效。 */
function checkSpanValidity(
  finding: VerificationFinding,
  textLength: number,
): SpanCheckResult {
  const { start, end } = finding.allowedRepairRange;
  const failureType = finding.failureType;

  // 越界
  if (start < 0 || end > textLength) {
    return {
      ok: false,
      reasonCode: "deny_out_of_bounds_span",
      reason: `allowedRepairRange [${start},${end}] 越界 (textLength=${textLength})`,
    };
  }

  // 倒置（零宽插入除外）
  if (start > end) {
    return {
      ok: false,
      reasonCode: "deny_invalid_span",
      reason: `allowedRepairRange [${start},${end}] start > end`,
    };
  }

  // 零宽只有在白名单情形才允许（bridge_patch 锚点）
  if (start === end) {
    const zeroWidthAllowed = ["bridge_patch", "scene_continuity", "timeline_inconsistency", "location_discontinuity"];
    const allowedActions = FAILURE_TYPE_TO_ALLOWED_ACTION[failureType] ?? [];
    const hasBridgePatch = (allowedActions as readonly string[]).includes("bridge_patch");
    if (!hasBridgePatch) {
      return {
        ok: false,
        reasonCode: "deny_invalid_span",
        reason: `allowedRepairRange [${start},${end}] 为零宽，但 failureType=${failureType} 不允许 bridge_patch`,
      };
    }
  }

  return { ok: true, reasonCode: "authorized" as RepairReasonCode, reason: "span 有效" };
}

/** 构建授权 ID。 */
function buildAuthorizationId(candidateId: string, findingId: string): string {
  return `auth-${candidateId}-${findingId}`;
}