/**
 * UserFeedbackIngestor — 用户反馈摄入器（Phase 6，计划 §Phase 6 §7.2）
 *
 * 把用户对最终正文的反馈转化为高权重 evidence，写入 StrategyPolicyStore。
 *
 * 设计原则（计划 §7.2 外部反馈等级，从高到低）：
 *   1. 用户最终选择或明确评分（最高权重，WEIGHT_USER_EXPLICIT=3）
 *   2. 用户对最终正文的实际修改（高权重，WEIGHT_USER_MODIFICATION=3）
 *   3. 异构 LLM 双裁判一致（WEIGHT_JUDGE_DOUBLE_CONSENSUS=2）
 *   4. 单 LLM 裁判明确胜出（WEIGHT_JUDGE_SINGLE=1）
 *   5. 机械风险指标（仅诊断，不写入策略信誉）
 *
 * 用户反馈的高权重体现为"counts as multiple samples"：
 *   weight=3 意味着一次用户反馈 ≈ 3 次单裁判观察。
 * 这保证用户行为是策略学习的最高证据（计划 §11 质量指标）。
 *
 * 可撤销性：
 * - 所有摄入操作返回 evidence 与可审计的 RecordedOutcome
 * - 用户可手动 setStatus（如"这个策略对我作品不适用，retire"）
 * - 用户可 revertLastOutcome 撤销最近一条 evidence
 *
 * 禁止：自动修改系统 prompt、作品宪法核心字段、硬门禁和世界事实。
 * 用户反馈只调整策略调用概率与信誉，不修改任何硬约束。
 */

import type { StrategyPolicyStore, StrategyEvidence, StrategyStatus } from "./strategy-policy-store.js";
import {
  WEIGHT_USER_EXPLICIT,
  WEIGHT_USER_MODIFICATION,
  type StrategyContext,
  type RecordedOutcome,
} from "./strategy-outcome-recorder.js";

// ============================================================================
// 常量
// ============================================================================

/** 用户修改幅度阈值：超过此值视为"重度修改"，额外加权 */
export const HEAVY_EDIT_DISTANCE_THRESHOLD = 0.3;
/** 重度修改的额外权重加成 */
export const HEAVY_EDIT_BONUS = 1;

/** 用户评分映射：高于此值 win，低于此值 loss，之间 tie */
export const RATING_WIN_THRESHOLD = 4; // 5 分制 >=4 为 win
export const RATING_LOSS_THRESHOLD = 3; // 5 分制 <=2 为 loss（<3）
/** 用户评分基础权重 */
export const WEIGHT_USER_RATING = WEIGHT_USER_EXPLICIT;

// ============================================================================
// 类型
// ============================================================================

/** 用户显式选择信号 */
export interface UserChoiceFeedback {
  context: StrategyContext;
  /** 用户最终选择哪个候选（明确二选一） */
  chosen: "editorial" | "raw";
  /** 可选备注 */
  note?: string;
}

/** 用户修改信号 */
export interface UserEditFeedback {
  context: StrategyContext;
  /** 实际交付的来源（editorial / raw / fallback） */
  deliveredSource: "editorial" | "raw" | "fallback";
  /** 用户对最终正文做了修改 */
  modified: boolean;
  /** 修改幅度 0-1（edit distance / text length） */
  editDistance?: number;
  /** 可选备注 */
  note?: string;
}

/** 用户评分信号 */
export interface UserRatingFeedback {
  context: StrategyContext;
  /** 评分 1-5（5 为最佳） */
  rating: number;
  /** 候选来源（评分对象） */
  candidateSource: "editorial" | "raw";
  /** 可选备注 */
  note?: string;
}

/** 用户手动状态覆盖 */
export interface UserStatusOverride {
  strategyId: string;
  modelVersion: string;
  /** 用户指定的新状态 */
  status: StrategyStatus;
  /** 用户给出的原因 */
  reason: string;
}

// ============================================================================
// UserFeedbackIngestor
// ============================================================================

export class UserFeedbackIngestor {
  /**
   * 摄入用户显式选择（等级 1，最高权重）。
   *
   * 语义：
   * - chosen=editorial → win（策略候选被用户采纳）
   * - chosen=raw → loss（用户拒绝 editorial，选择 raw）
   *
   * weight=WEIGHT_USER_EXPLICIT=3（counts as 3 samples）。
   */
  ingestChoice(
    store: StrategyPolicyStore,
    feedback: UserChoiceFeedback
  ): RecordedOutcome {
    const { context, chosen, note } = feedback;
    const outcome: "win" | "loss" = chosen === "editorial" ? "win" : "loss";
    const evidence: StrategyEvidence = {
      sourceChapter: context.sourceChapter,
      outcome,
      source: "user",
      weight: WEIGHT_USER_EXPLICIT,
      timestamp: new Date().toISOString(),
      note: note ?? `用户明确选择 ${chosen}`,
    };
    store.recordOutcome(context.strategyId, context.modelVersion, evidence);
    return {
      strategyId: context.strategyId,
      modelVersion: context.modelVersion,
      outcome,
      weight: WEIGHT_USER_EXPLICIT,
      source: "user",
      evidence,
      recorded: true,
    };
  }

  /**
   * 摄入用户对最终正文的实际修改（等级 2，高权重）。
   *
   * 语义：
   * - modified=true 且 deliveredSource=editorial → loss（用户改了 editorial 交付稿，视为对策略候选的否定）
   * - modified=true 且 deliveredSource=raw → loss（策略未参与交付；raw 也需改进，但不计入策略信誉——这里仍记 loss 但 note 说明）
   * - modified=false → 不记录（用户保留原稿 = 隐性接受，但无明确信号）
   *
   * 修改幅度大时额外加权（HEAVY_EDIT_BONUS），体现"重度修改"的强否定。
   */
  ingestEdit(
    store: StrategyPolicyStore,
    feedback: UserEditFeedback
  ): RecordedOutcome {
    const { context, deliveredSource, modified, editDistance, note } = feedback;

    if (!modified) {
      // 用户未修改 = 隐性接受，不写入策略信誉（避免虚假样本）
      return {
        strategyId: context.strategyId,
        modelVersion: context.modelVersion,
        outcome: "tie",
        weight: 0,
        source: "user",
        evidence: {
          sourceChapter: context.sourceChapter,
          outcome: "tie",
          source: "user",
          weight: 0,
          timestamp: new Date().toISOString(),
          note: "用户未修改最终正文，无明确信号，不记录",
        },
        recorded: false,
        reason: "用户未修改，无明确信号",
      };
    }

    // 用户修改了最终正文 → loss（策略候选未被用户接受）
    let weight = WEIGHT_USER_MODIFICATION;
    const isHeavy =
      typeof editDistance === "number" && editDistance >= HEAVY_EDIT_DISTANCE_THRESHOLD;
    if (isHeavy) {
      weight += HEAVY_EDIT_BONUS;
    }

    const evidence: StrategyEvidence = {
      sourceChapter: context.sourceChapter,
      outcome: "loss",
      source: "user",
      weight,
      timestamp: new Date().toISOString(),
      note:
        note ??
        (deliveredSource === "editorial"
          ? `用户修改了 editorial 交付稿${
              isHeavy ? `（重度修改 editDistance=${editDistance?.toFixed(2)}）` : ""
            }，视为对策略候选的否定`
          : `用户修改了 raw 交付稿（策略未参与交付）${
              isHeavy ? `（重度修改 editDistance=${editDistance?.toFixed(2)}）` : ""
            }`),
    };
    store.recordOutcome(context.strategyId, context.modelVersion, evidence);
    return {
      strategyId: context.strategyId,
      modelVersion: context.modelVersion,
      outcome: "loss",
      weight,
      source: "user",
      evidence,
      recorded: true,
    };
  }

  /**
   * 摄入用户评分（等级 1，最高权重）。
   *
   * 5 分制映射：
   * - rating >= 4 → win
   * - rating < 3 → loss
   * - 3 <= rating < 4 → tie（弱更新）
   *
   * 仅当 candidateSource=editorial 时才记录（评分 raw 不计入策略信誉）。
   */
  ingestRating(
    store: StrategyPolicyStore,
    feedback: UserRatingFeedback
  ): RecordedOutcome {
    const { context, rating, candidateSource, note } = feedback;

    // 评分对象是 raw → 不计入策略信誉
    if (candidateSource === "raw") {
      return {
        strategyId: context.strategyId,
        modelVersion: context.modelVersion,
        outcome: "tie",
        weight: 0,
        source: "user",
        evidence: {
          sourceChapter: context.sourceChapter,
          outcome: "tie",
          source: "user",
          weight: 0,
          timestamp: new Date().toISOString(),
          note: `用户评分对象是 raw（rating=${rating}），不计入策略信誉`,
        },
        recorded: false,
        reason: "评分对象是 raw，不计入策略信誉",
      };
    }

    // 评分对象是 editorial → 映射 win/loss/tie
    let outcome: "win" | "loss" | "tie";
    if (rating >= RATING_WIN_THRESHOLD) {
      outcome = "win";
    } else if (rating < RATING_LOSS_THRESHOLD) {
      outcome = "loss";
    } else {
      outcome = "tie";
    }

    const evidence: StrategyEvidence = {
      sourceChapter: context.sourceChapter,
      outcome,
      source: "user",
      weight: WEIGHT_USER_RATING,
      timestamp: new Date().toISOString(),
      note: note ?? `用户对 editorial 候选评分 ${rating}/5 → ${outcome}`,
    };
    store.recordOutcome(context.strategyId, context.modelVersion, evidence);
    return {
      strategyId: context.strategyId,
      modelVersion: context.modelVersion,
      outcome,
      weight: WEIGHT_USER_RATING,
      source: "user",
      evidence,
      recorded: true,
    };
  }

  /**
   * 用户手动覆盖策略状态（可解释、可撤销的人工干预）。
   *
   * 场景：
   * - 用户认为某策略对作品不适用 → setStatus=retired
   * - 用户想强制重新探索某策略 → setStatus=active
   * - 用户想暂停某策略 → setStatus=dormant
   *
   * 返回更新后的信誉（含 statusChangedAt/statusReason 审计字段）。
   */
  applyStatusOverride(
    store: StrategyPolicyStore,
    override: UserStatusOverride
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
      `用户手动覆盖：${override.reason}`
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
   * 撤销最近一条 evidence（可撤销原则）。
   * 委托给 StrategyPolicyStore.revertLastOutcome。
   */
  revertLastOutcome(
    store: StrategyPolicyStore,
    strategyId: string,
    modelVersion: string
  ): {
    reverted: boolean;
    evidence?: StrategyEvidence;
    reason?: string;
  } {
    const rep = store.getReputation(strategyId, modelVersion);
    if (rep.evidence.length === 0) {
      return { reverted: false, reason: "无 evidence 可撤销" };
    }
    const lastEvidence = rep.evidence[rep.evidence.length - 1];
    store.revertLastOutcome(strategyId, modelVersion);
    return { reverted: true, evidence: lastEvidence };
  }
}

export function createUserFeedbackIngestor(): UserFeedbackIngestor {
  return new UserFeedbackIngestor();
}
