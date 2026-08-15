/**
 * UserFeedbackIngestor — 用户反馈摄入器（USER-FEEDBACK-EVIDENCE-PIPELINE-1）
 *
 * 把用户对最终正文的反馈转化为可归因、可撤销、分层的 evidence。
 *
 * 核心不变量：
 * - 用户反馈不得直接充当奖励函数；先归因再决定是否更新文学信誉
 * - 无法归因默认 neutral，不污染策略
 * - raw / 非策略候选不计入该策略信誉
 * - 事实/设定/剧情方向修正不直接惩罚文学策略
 * - decisionCount 恒为真实决策数；weightedEvidence 只影响置信度幅度
 * - 反馈只影响下一次请求；不改当前正文/事实/硬门禁
 * - 文学负反馈不得自动 retired
 */

import type {
  StrategyPolicyStore,
  StrategyEvidence,
  StrategyStatus,
} from "./strategy-policy-store.js";
import {
  WEIGHT_USER_EXPLICIT,
  WEIGHT_USER_MODIFICATION,
  type StrategyContext,
  type RecordedOutcome,
} from "./strategy-outcome-recorder.js";
import type {
  AttributionConfidence,
  DeliveredSource,
  EditClassification,
  EditType,
  FeedbackAttributionDecision,
  FeedbackLevel,
  FeedbackLineage,
} from "./feedback-evidence-contracts.js";
import {
  feedbackLevelUpdatesLiteraryReputation,
  isCompleteLineage,
  isLiteraryStrategyPenaltyEdit,
  literaryFeedbackAllowedOnlineActions,
} from "./feedback-evidence-contracts.js";
import {
  classifyEditSemantics,
  type UserModificationDelta,
} from "./user-modification-delta.js";

// ============================================================================
// 常量
// ============================================================================

/** 用户修改幅度阈值：超过此值视为"重度修改"，额外加权 */
export const HEAVY_EDIT_DISTANCE_THRESHOLD = 0.3;
/** 重度修改的额外权重加成（仅 weightedEvidence，不增加 decisionCount） */
export const HEAVY_EDIT_BONUS = 1;

/** 用户评分映射：高于此值 win，低于此值 loss，之间 tie */
export const RATING_WIN_THRESHOLD = 4;
export const RATING_LOSS_THRESHOLD = 3;
export const WEIGHT_USER_RATING = WEIGHT_USER_EXPLICIT;

// ============================================================================
// 类型
// ============================================================================

export interface UserChoiceFeedback {
  context: StrategyContext;
  chosen: "editorial" | "raw";
  note?: string;
  /** 可选完整血缘；缺失时降级为 unattributed */
  lineage?: Partial<FeedbackLineage>;
  feedbackEventId?: string;
}

export interface UserEditFeedback {
  context: StrategyContext;
  deliveredSource: DeliveredSource;
  modified: boolean;
  editDistance?: number;
  note?: string;
  /** 可选：完整修改分类（来自 computeUserModificationDelta） */
  classification?: EditClassification;
  /** 可选：完整 delta */
  delta?: UserModificationDelta;
  lineage?: Partial<FeedbackLineage>;
  feedbackEventId?: string;
}

export interface UserRatingFeedback {
  context: StrategyContext;
  rating: number;
  candidateSource: "editorial" | "raw";
  note?: string;
  lineage?: Partial<FeedbackLineage>;
  feedbackEventId?: string;
}

export interface UserStatusOverride {
  strategyId: string;
  modelVersion: string;
  status: StrategyStatus;
  reason: string;
}

export interface AttributedRecordedOutcome extends RecordedOutcome {
  feedbackLevel: FeedbackLevel;
  attributionConfidence: AttributionConfidence;
  decisionCount: number;
  weightedEvidence: number;
  onlineActions: ReturnType<typeof literaryFeedbackAllowedOnlineActions>;
  attribution: FeedbackAttributionDecision;
}

// ============================================================================
// Attribution helpers
// ============================================================================

let evidenceIdSeq = 0;

function makeEvidenceId(
  prefix: string,
  context: StrategyContext,
  feedbackEventId?: string,
): string {
  if (feedbackEventId && feedbackEventId.trim().length > 0) {
    // 调用方提供的幂等键：同一 feedbackEventId 必须稳定
    return `${prefix}:${feedbackEventId}`;
  }
  evidenceIdSeq += 1;
  return `${prefix}:${context.sourceChapter}:${context.strategyId}:${context.modelVersion}:${Date.now()}:${evidenceIdSeq}`;
}

function buildAttribution(input: {
  feedbackLevel: FeedbackLevel;
  outcome: "win" | "loss" | "tie" | "neutral";
  attributionConfidence: AttributionConfidence;
  decisionCount: number;
  weightedEvidence: number;
  learningTarget: "bundle" | "strategy" | "none";
  strategyId?: string;
  strategyBundleId?: string;
  reason: string;
  editClassification?: EditClassification;
}): FeedbackAttributionDecision {
  const updatesLiteraryReputation =
    feedbackLevelUpdatesLiteraryReputation(input.feedbackLevel) &&
    input.outcome !== "neutral" &&
    input.learningTarget !== "none" &&
    input.weightedEvidence > 0;

  return {
    feedbackLevel: input.feedbackLevel,
    outcome: input.outcome,
    updatesLiteraryReputation,
    attributionConfidence: input.attributionConfidence,
    decisionCount: input.decisionCount,
    weightedEvidence: input.weightedEvidence,
    learningTarget: input.learningTarget,
    strategyBundleId: input.strategyBundleId,
    strategyId: input.strategyId,
    reason: input.reason,
    editClassification: input.editClassification,
  };
}

function toRecordedOutcome(
  context: StrategyContext,
  attribution: FeedbackAttributionDecision,
  evidence: StrategyEvidence,
  recorded: boolean,
  reason?: string,
): AttributedRecordedOutcome {
  const outcome =
    attribution.outcome === "neutral" ? "tie" : attribution.outcome;
  return {
    strategyId: context.strategyId,
    modelVersion: context.modelVersion,
    outcome,
    weight: attribution.weightedEvidence,
    source: "user",
    evidence,
    recorded,
    reason,
    feedbackLevel: attribution.feedbackLevel,
    attributionConfidence: attribution.attributionConfidence,
    decisionCount: attribution.decisionCount,
    weightedEvidence: attribution.weightedEvidence,
    onlineActions: literaryFeedbackAllowedOnlineActions(attribution.outcome),
    attribution,
  };
}

// ============================================================================
// UserFeedbackIngestor
// ============================================================================

export class UserFeedbackIngestor {
  /**
   * 摄入用户显式选择（explicit_direct）。
   * chosen=editorial → win；chosen=raw → loss。
   * 血缘不完整时降级为 natural_language_unattributed / neutral。
   */
  ingestChoice(
    store: StrategyPolicyStore,
    feedback: UserChoiceFeedback,
  ): AttributedRecordedOutcome {
    const { context, chosen, note } = feedback;

    // 若提供了 lineage 但不完整 → 不更新信誉
    if (feedback.lineage !== undefined && !isCompleteLineage(feedback.lineage as FeedbackLineage)) {
      const attribution = buildAttribution({
        feedbackLevel: "natural_language_unattributed",
        outcome: "neutral",
        attributionConfidence: "none",
        decisionCount: 1,
        weightedEvidence: 0,
        learningTarget: "none",
        reason: "显式选择缺少完整候选血缘，记 neutral 不更新文学信誉",
      });
      const evidence: StrategyEvidence = {
        sourceChapter: context.sourceChapter,
        outcome: "tie",
        source: "user",
        weight: 0,
        timestamp: new Date().toISOString(),
        note: note ?? attribution.reason,
        evidenceId: makeEvidenceId("choice-unattr", context, feedback.feedbackEventId),
        decisionCount: 1,
        feedbackLevel: attribution.feedbackLevel,
        attributionConfidence: "none",
      };
      return toRecordedOutcome(context, attribution, evidence, false, attribution.reason);
    }

    const outcome: "win" | "loss" = chosen === "editorial" ? "win" : "loss";
    const attribution = buildAttribution({
      feedbackLevel: "explicit_direct",
      outcome,
      attributionConfidence: "high",
      decisionCount: 1,
      weightedEvidence: WEIGHT_USER_EXPLICIT,
      learningTarget: "strategy",
      strategyId: context.strategyId,
      reason: note ?? `用户明确选择 ${chosen}`,
    });

    const evidenceId = makeEvidenceId("choice", context, feedback.feedbackEventId);
    const before = store.getReputation(context.strategyId, context.modelVersion);
    const already =
      evidenceId &&
      before.evidence.some((e) => e.evidenceId === evidenceId && !e.revoked);

    const evidence: StrategyEvidence = {
      sourceChapter: context.sourceChapter,
      outcome,
      source: "user",
      weight: WEIGHT_USER_EXPLICIT,
      timestamp: new Date().toISOString(),
      note: attribution.reason,
      evidenceId,
      decisionCount: 1,
      feedbackLevel: attribution.feedbackLevel,
      attributionConfidence: attribution.attributionConfidence,
    };

    if (already) {
      return toRecordedOutcome(
        context,
        attribution,
        evidence,
        false,
        `幂等命中 evidenceId=${evidenceId}，不重复写入`,
      );
    }

    store.recordOutcome(context.strategyId, context.modelVersion, evidence);
    return toRecordedOutcome(context, attribution, evidence, true);
  }

  /**
   * 摄入用户修改（explicit_edit）。
   *
   * 规则：
   * - modified=false → implicit_accept，不更新
   * - deliveredSource=raw/fallback → 不计入该策略信誉
   * - fact/setting_completion/plot_direction → neutral（非文学惩罚）
   * - typo → neutral；轻度 language → 弱 loss 或 neutral
   * - voice/motivation/structure → loss；heavy 时加权但不增加 decisionCount
   */
  ingestEdit(
    store: StrategyPolicyStore,
    feedback: UserEditFeedback,
  ): AttributedRecordedOutcome {
    const { context, deliveredSource, modified, editDistance, note } = feedback;

    if (!modified) {
      const attribution = buildAttribution({
        feedbackLevel: "implicit_accept",
        outcome: "neutral",
        attributionConfidence: "low",
        decisionCount: 1,
        weightedEvidence: 0,
        learningTarget: "none",
        reason: "用户未修改最终正文，隐性接受，不记录策略信誉",
      });
      const evidence: StrategyEvidence = {
        sourceChapter: context.sourceChapter,
        outcome: "tie",
        source: "user",
        weight: 0,
        timestamp: new Date().toISOString(),
        note: attribution.reason,
        evidenceId: makeEvidenceId("edit-implicit", context, feedback.feedbackEventId),
        decisionCount: 1,
        feedbackLevel: attribution.feedbackLevel,
        attributionConfidence: "low",
      };
      return toRecordedOutcome(context, attribution, evidence, false, attribution.reason);
    }

    // raw / fallback 交付：策略未参与交付，不计入该策略
    if (deliveredSource !== "editorial") {
      const attribution = buildAttribution({
        feedbackLevel: "explicit_edit",
        outcome: "neutral",
        attributionConfidence: "high",
        decisionCount: 1,
        weightedEvidence: 0,
        learningTarget: "none",
        reason: `用户修改了 ${deliveredSource} 交付稿（策略未参与交付），不计入该策略信誉`,
      });
      const evidence: StrategyEvidence = {
        sourceChapter: context.sourceChapter,
        outcome: "tie",
        source: "user",
        weight: 0,
        timestamp: new Date().toISOString(),
        note: note ?? attribution.reason,
        evidenceId: makeEvidenceId("edit-raw", context, feedback.feedbackEventId),
        decisionCount: 1,
        feedbackLevel: attribution.feedbackLevel,
        attributionConfidence: "high",
      };
      return toRecordedOutcome(context, attribution, evidence, false, attribution.reason);
    }

    // 分类
    const classification: EditClassification =
      feedback.classification ??
      feedback.delta?.classification ??
      classifyEditSemantics({
        editDistance: editDistance ?? 0,
        heavy:
          typeof editDistance === "number" &&
          editDistance >= HEAVY_EDIT_DISTANCE_THRESHOLD,
        structuralRatio: feedback.delta?.structuralRatio ?? 0,
        modificationTypes: feedback.delta?.modificationTypes ?? {
          deletion: 0,
          insertion: 0,
          rewording: 0,
          structural: 0,
        },
        note,
        deliveredLength: feedback.delta?.deliveredLength ?? 0,
        userFinalLength: feedback.delta?.userFinalLength ?? 0,
      });

    // 非文学类：事实/设定/剧情
    if (
      classification.factIssue ||
      classification.settingCompletion ||
      classification.editType === "plot_direction" ||
      classification.editType === "fact" ||
      classification.editType === "setting_completion"
    ) {
      const attribution = buildAttribution({
        feedbackLevel: "explicit_edit",
        outcome: "neutral",
        attributionConfidence: classification.attributionConfidence,
        decisionCount: 1,
        weightedEvidence: 0,
        learningTarget: "none",
        reason: `用户修改类型=${classification.editType}，属上下文/FactGuard 类别，不惩罚文学策略`,
        editClassification: classification,
      });
      const evidence: StrategyEvidence = {
        sourceChapter: context.sourceChapter,
        outcome: "tie",
        source: "user",
        weight: 0,
        timestamp: new Date().toISOString(),
        note: note ?? attribution.reason,
        evidenceId: makeEvidenceId("edit-nonlit", context, feedback.feedbackEventId),
        decisionCount: 1,
        feedbackLevel: attribution.feedbackLevel,
        attributionConfidence: classification.attributionConfidence,
      };
      return toRecordedOutcome(context, attribution, evidence, false, attribution.reason);
    }

    // typo 或无法归因
    if (
      classification.editType === "typo" ||
      classification.attributionConfidence === "none"
    ) {
      const attribution = buildAttribution({
        feedbackLevel:
          classification.attributionConfidence === "none"
            ? "natural_language_unattributed"
            : "explicit_edit",
        outcome: "neutral",
        attributionConfidence: classification.attributionConfidence,
        decisionCount: 1,
        weightedEvidence: 0,
        learningTarget: "none",
        reason:
          classification.editType === "typo"
            ? "局部错别字修改，记 neutral"
            : "修改无法归因，记 neutral 不污染策略",
        editClassification: classification,
      });
      const evidence: StrategyEvidence = {
        sourceChapter: context.sourceChapter,
        outcome: "tie",
        source: "user",
        weight: 0,
        timestamp: new Date().toISOString(),
        note: note ?? attribution.reason,
        evidenceId: makeEvidenceId("edit-neutral", context, feedback.feedbackEventId),
        decisionCount: 1,
        feedbackLevel: attribution.feedbackLevel,
        attributionConfidence: classification.attributionConfidence,
      };
      return toRecordedOutcome(context, attribution, evidence, false, attribution.reason);
    }

    // 文学相关修改 → loss（弱或强）
    const isHeavy =
      typeof editDistance === "number" &&
      editDistance >= HEAVY_EDIT_DISTANCE_THRESHOLD;
    let weightedEvidence = classification.weightedEvidence;
    if (weightedEvidence <= 0) {
      // language 轻度默认弱更新
      weightedEvidence = isLiteraryStrategyPenaltyEdit(classification.editType as EditType)
        ? isHeavy
          ? WEIGHT_USER_MODIFICATION + HEAVY_EDIT_BONUS
          : WEIGHT_USER_MODIFICATION
        : 1;
    } else if (isHeavy && isLiteraryStrategyPenaltyEdit(classification.editType)) {
      weightedEvidence = Math.max(weightedEvidence, WEIGHT_USER_MODIFICATION + HEAVY_EDIT_BONUS);
    }

    // 轻度 language + retainedCoreEffect → 弱 loss（weight 可保留但 outcome=loss）
    const outcome: "loss" = "loss";
    const attribution = buildAttribution({
      feedbackLevel: "explicit_edit",
      outcome,
      attributionConfidence: classification.attributionConfidence,
      decisionCount: 1,
      weightedEvidence,
      learningTarget: "strategy",
      strategyId: context.strategyId,
      reason:
        note ??
        `用户修改了 editorial 交付稿（editType=${classification.editType}, scope=${classification.editScope}${
          isHeavy ? `, heavy editDistance=${editDistance?.toFixed(2)}` : ""
        }），decisionCount=1`,
      editClassification: classification,
    });

    const evidence: StrategyEvidence = {
      sourceChapter: context.sourceChapter,
      outcome,
      source: "user",
      weight: weightedEvidence,
      timestamp: new Date().toISOString(),
      note: attribution.reason,
      evidenceId: makeEvidenceId("edit", context, feedback.feedbackEventId),
      decisionCount: 1,
      feedbackLevel: attribution.feedbackLevel,
      attributionConfidence: classification.attributionConfidence,
    };

    store.recordOutcome(context.strategyId, context.modelVersion, evidence);
    return toRecordedOutcome(context, attribution, evidence, true);
  }

  /**
   * 摄入用户评分。
   * 仅 candidateSource=editorial 时记录；raw 不计入策略信誉。
   */
  ingestRating(
    store: StrategyPolicyStore,
    feedback: UserRatingFeedback,
  ): AttributedRecordedOutcome {
    const { context, rating, candidateSource, note } = feedback;

    if (candidateSource === "raw") {
      const attribution = buildAttribution({
        feedbackLevel: "explicit_direct",
        outcome: "neutral",
        attributionConfidence: "high",
        decisionCount: 1,
        weightedEvidence: 0,
        learningTarget: "none",
        reason: `用户评分对象是 raw（rating=${rating}），不计入策略信誉`,
      });
      const evidence: StrategyEvidence = {
        sourceChapter: context.sourceChapter,
        outcome: "tie",
        source: "user",
        weight: 0,
        timestamp: new Date().toISOString(),
        note: attribution.reason,
        evidenceId: makeEvidenceId("rating-raw", context, feedback.feedbackEventId),
        decisionCount: 1,
        feedbackLevel: attribution.feedbackLevel,
        attributionConfidence: "high",
      };
      return toRecordedOutcome(context, attribution, evidence, false, attribution.reason);
    }

    let outcome: "win" | "loss" | "tie";
    if (rating >= RATING_WIN_THRESHOLD) outcome = "win";
    else if (rating < RATING_LOSS_THRESHOLD) outcome = "loss";
    else outcome = "tie";

    const attribution = buildAttribution({
      feedbackLevel: "explicit_direct",
      outcome,
      attributionConfidence: "high",
      decisionCount: 1,
      weightedEvidence: WEIGHT_USER_RATING,
      learningTarget: "strategy",
      strategyId: context.strategyId,
      reason: note ?? `用户对 editorial 候选评分 ${rating}/5 → ${outcome}`,
    });

    const evidence: StrategyEvidence = {
      sourceChapter: context.sourceChapter,
      outcome,
      source: "user",
      weight: WEIGHT_USER_RATING,
      timestamp: new Date().toISOString(),
      note: attribution.reason,
      evidenceId: makeEvidenceId("rating", context, feedback.feedbackEventId),
      decisionCount: 1,
      feedbackLevel: attribution.feedbackLevel,
      attributionConfidence: "high",
    };

    store.recordOutcome(context.strategyId, context.modelVersion, evidence);
    return toRecordedOutcome(context, attribution, evidence, true);
  }

  /**
   * 用户手动覆盖策略状态。
   * retired 只允许通过此人工路径（或离线审批），不得由文学反馈自动触发。
   */
  applyStatusOverride(
    store: StrategyPolicyStore,
    override: UserStatusOverride,
  ): {
    strategyId: string;
    modelVersion: string;
    previousStatus: StrategyStatus;
    newStatus: StrategyStatus;
    reason: string;
    timestamp: string;
  } {
    const previous = store.getReputation(override.strategyId, override.modelVersion);
    const previousStatus = previous.status;
    store.setStatus(
      override.strategyId,
      override.modelVersion,
      override.status,
      `用户手动覆盖：${override.reason}`,
    );
    return {
      strategyId: override.strategyId,
      modelVersion: override.modelVersion,
      previousStatus,
      newStatus: override.status,
      reason: override.reason,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 按 evidenceId 定点撤销。
   */
  revertOutcomeByEvidenceId(
    store: StrategyPolicyStore,
    strategyId: string,
    modelVersion: string,
    evidenceId: string,
  ): {
    reverted: boolean;
    evidence?: StrategyEvidence;
    reason?: string;
  } {
    const before = store.getReputation(strategyId, modelVersion);
    const target = before.evidence.find((e) => e.evidenceId === evidenceId);
    const result = store.revertOutcomeByEvidenceId(
      strategyId,
      modelVersion,
      evidenceId,
    );
    return {
      reverted: result.reverted,
      evidence: target,
      reason: result.reason,
    };
  }

  /**
   * @deprecated 兼容：撤销最近一条 evidence。新代码用 revertOutcomeByEvidenceId。
   */
  revertLastOutcome(
    store: StrategyPolicyStore,
    strategyId: string,
    modelVersion: string,
  ): {
    reverted: boolean;
    evidence?: StrategyEvidence;
    reason?: string;
  } {
    const rep = store.getReputation(strategyId, modelVersion);
    if (rep.evidence.length === 0) {
      return { reverted: false, reason: "无 evidence 可撤销" };
    }
    let last: StrategyEvidence | undefined;
    for (let i = rep.evidence.length - 1; i >= 0; i--) {
      if (!rep.evidence[i]!.revoked) {
        last = rep.evidence[i];
        break;
      }
    }
    if (!last) {
      return { reverted: false, reason: "无未撤销 evidence 可撤销" };
    }
    if (last.evidenceId) {
      return this.revertOutcomeByEvidenceId(
        store,
        strategyId,
        modelVersion,
        last.evidenceId,
      );
    }
    store.revertLastOutcome(strategyId, modelVersion);
    return { reverted: true, evidence: last };
  }
}

export function createUserFeedbackIngestor(): UserFeedbackIngestor {
  return new UserFeedbackIngestor();
}
