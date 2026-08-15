/**
 * Strategy Promotion Governance — 策略晋级治理（USER-FEEDBACK-EVIDENCE-PIPELINE-1 Phase 6）
 *
 * 运行时信誉、离线证据和生产晋级彻底分层：
 * - 单次用户反馈不得切换 production baseline
 * - candidate → active 必须经过 Eval + replay + 人工复核 + 审批记录
 * - revoked / quarantined / polluted 证据晋级率为 0
 */

import {
  MIN_ADMISSION_ELIGIBLE_DECISIONS,
  MIN_ADMISSION_HUMAN_VERDICTS,
  type StrategyEvidenceRecord,
} from "../core/strategy-evidence-dataset.js";
import type { StrategyPolicyStore, StrategyStatus } from "./strategy-policy-store.js";

export interface PromotionApprovalRecord {
  approvalId: string;
  strategyId: string;
  modelVersion: string;
  approvedBy: string;
  approvedAt: string;
  /** 必须包含 eval / replay / human_review */
  checklist: {
    evalPassed: boolean;
    replayPassed: boolean;
    humanReviewPassed: boolean;
  };
  notes?: string;
}

export interface PromotionRecommendation {
  strategyId: string;
  modelVersion: string;
  recommendedStatus: "candidate" | "active";
  canPromote: boolean;
  blockers: string[];
  eligibleDecisionCount: number;
  humanVerdictCount: number;
  revokedCount: number;
  quarantinedCount: number;
  pollutedCount: number;
  reason: string;
}

export interface ApplyPromotionResult {
  applied: boolean;
  previousStatus: StrategyStatus;
  newStatus: StrategyStatus;
  reason: string;
}

/**
 * 从 evidence records 生成晋级建议（纯函数，不改生产状态）。
 */
export function buildPromotionRecommendation(
  records: readonly StrategyEvidenceRecord[],
  strategyId: string,
  modelVersion: string,
): PromotionRecommendation {
  const scoped = records.filter(
    (r) => r.strategyId === strategyId && r.modelVersion === modelVersion,
  );

  const revokedCount = scoped.filter((r) => r.revoked === true).length;
  const quarantinedCount = scoped.filter((r) => r.quarantined === true).length;
  const pollutedCount = scoped.filter((r) => r.polluted === true).length;

  const effective = scoped.filter(
    (r) => !r.revoked && !r.quarantined && !r.polluted,
  );
  const eligibleDecisionCount = effective.filter((r) => r.fromEligiblePair === true).length;
  const humanVerdictCount = effective.filter((r) => r.hasHumanVerdict === true).length;

  const blockers: string[] = [];
  if (eligibleDecisionCount < MIN_ADMISSION_ELIGIBLE_DECISIONS) {
    blockers.push(
      `eligible decisions ${eligibleDecisionCount}/${MIN_ADMISSION_ELIGIBLE_DECISIONS}`,
    );
  }
  if (humanVerdictCount < MIN_ADMISSION_HUMAN_VERDICTS) {
    blockers.push(
      `human verdicts ${humanVerdictCount}/${MIN_ADMISSION_HUMAN_VERDICTS}`,
    );
  }
  // revoked/quarantined 不得参与晋级：若有效集为空而原始有污染，阻断
  if (effective.length === 0 && scoped.length > 0) {
    blockers.push("all evidence revoked/quarantined/polluted");
  }

  const canPromote = blockers.length === 0 && effective.length > 0;
  return {
    strategyId,
    modelVersion,
    recommendedStatus: canPromote ? "active" : "candidate",
    canPromote,
    blockers,
    eligibleDecisionCount,
    humanVerdictCount,
    revokedCount,
    quarantinedCount,
    pollutedCount,
    reason: canPromote
      ? `promotion thresholds satisfied: eligible=${eligibleDecisionCount}, human=${humanVerdictCount}`
      : `promotion blocked: ${blockers.join("; ")}`,
  };
}

/**
 * 应用晋级：必须有完整审批记录，且 recommendation.canPromote。
 * 单次用户反馈路径不得调用本函数。
 */
export function applyPromotionWithApproval(
  store: StrategyPolicyStore,
  recommendation: PromotionRecommendation,
  approval: PromotionApprovalRecord,
): ApplyPromotionResult {
  const previous = store.getReputation(
    recommendation.strategyId,
    recommendation.modelVersion,
  );

  if (!recommendation.canPromote) {
    return {
      applied: false,
      previousStatus: previous.status,
      newStatus: previous.status,
      reason: `晋级被拒绝：${recommendation.reason}`,
    };
  }

  if (
    approval.strategyId !== recommendation.strategyId ||
    approval.modelVersion !== recommendation.modelVersion
  ) {
    return {
      applied: false,
      previousStatus: previous.status,
      newStatus: previous.status,
      reason: "审批记录与晋级建议的 strategyId/modelVersion 不匹配",
    };
  }

  if (
    !approval.checklist.evalPassed ||
    !approval.checklist.replayPassed ||
    !approval.checklist.humanReviewPassed
  ) {
    return {
      applied: false,
      previousStatus: previous.status,
      newStatus: previous.status,
      reason:
        "审批清单不完整：eval/replay/human_review 必须全部通过才能 candidate→active",
    };
  }

  if (!approval.approvedBy || approval.approvedBy.trim().length === 0) {
    return {
      applied: false,
      previousStatus: previous.status,
      newStatus: previous.status,
      reason: "缺少人工审批人 approvedBy",
    };
  }

  store.setStatus(
    recommendation.strategyId,
    recommendation.modelVersion,
    "active",
    `晋级审批通过 approvalId=${approval.approvalId} by ${approval.approvedBy}: ${recommendation.reason}`,
  );

  return {
    applied: true,
    previousStatus: previous.status,
    newStatus: "active",
    reason: `candidate→active 已审批：${approval.approvalId}`,
  };
}

/**
 * 安全边界：单次反馈不得切换生产策略基线。
 * 本函数恒返回 false；供测试与调用方断言。
 */
export function singleFeedbackCanSwitchProductionBaseline(): false {
  return false;
}
