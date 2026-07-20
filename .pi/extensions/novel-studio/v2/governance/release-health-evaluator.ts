/**
 * ReleaseHealthEvaluator — G8 健康判定纯函数（EVOLUTION-RELEASE-GOVERNANCE-G8）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §8 Phase G8
 * 计划：.trae/documents/g8-health-monitoring-and-retirement-implementation.md §2.2
 *
 * 基于 ReleaseHealthReport（per-release 分桶后）+ 阈值 + 当前 release status，
 * 判定 release 健康状态并输出决策建议（不自动执行）。
 *
 * 判定流程（优先级从高到低）：
 * 1. sampleCount < MIN_SAMPLE_SIZE → insufficient_data
 * 2. auto_hold 条件之一满足（consecutiveNegative / alignmentRate / rollbackRate / factGuardPassRate）→ auto_hold_eligible
 * 3. longTermAlignmentRate < RETIRED_ALIGNMENT_RATE → retired_suggestion
 * 4. alignmentRate < HEALTHY_ALIGNMENT_RATE → warning
 * 5. 否则 → healthy
 *
 * 决策建议（不自动执行）：
 * - shouldAutoHold: status=auto_hold_eligible 且未 held（幂等：已 held 不重复触发）
 * - shouldSuggestRetired: longTermAlignmentRate < RETIRED_ALIGNMENT_RATE（仅建议）
 * - recoveryAlignmentRate: 始终返回 RECOVERY_ALIGNMENT_RATE（滞回水位）
 * - alreadyHeld: currentStatus === "held"
 * - overrideHint: 已 held 且 alignmentRate 低于滞回水位时，提示 --force override
 *
 * 设计原则：
 * - 纯函数：无副作用、不调模型、不读写文件
 * - 幂等：已 held 的 release 不重复触发 shouldAutoHold
 * - 滞回：recoveryAlignmentRate (0.8) > AUTO_HOLD_ALIGNMENT_RATE (0.4)，避免抖动
 * - retired 只生成建议，不触发 shouldAutoHold
 *
 * 边界（READY_LOCAL）：
 * - 闭包自包含（仅依赖 governance sibling）
 * - 可被 dist-test/ / dist/ / dist-eval/ 任意闭包消费
 * - 不依赖 finalization / draft-checkpoint 运行时
 */

import type { ReleaseHealthReport, StrategyReputationSnapshot } from "./release-health-aggregator.js";
import type { ReleaseStatus } from "./evolution-release-types.js";
import {
  MIN_SAMPLE_SIZE,
  HEALTHY_ALIGNMENT_RATE,
  AUTO_HOLD_ALIGNMENT_RATE,
  AUTO_HOLD_ROLLBACK_RATE,
  AUTO_HOLD_CONSECUTIVE_NEGATIVE,
  RETIRED_ALIGNMENT_RATE,
  RECOVERY_ALIGNMENT_RATE,
  AUTO_HOLD_FACTGUARD_PASS_RATE,
} from "./release-health-thresholds.js";

// ============================================================================
// 类型
// ============================================================================

/** 健康状态枚举 */
export type ReleaseHealthStatus =
  | "healthy"
  | "warning"
  | "auto_hold_eligible"
  | "retired_suggestion"
  | "insufficient_data";

/** 触发阈值的证据摘要 */
export interface ReleaseHealthEvidence {
  /** 样本数（= healthReport.totalFeedbackRecords） */
  sampleCount: number;
  /** 当前 alignmentRate */
  alignmentRate: number;
  /** rollback 率（rolledBack / sampleCount） */
  rollbackRate: number;
  /** FactGuard 通过率；无数据时为 null */
  factGuardPassRate: number | null;
  /** 连续负收益数 */
  consecutiveNegative: number;
  /** 长期窗口 alignmentRate */
  longTermAlignmentRate: number;
}

/** 决策建议（不自动执行，由 release-health-actions 负责执行） */
export interface ReleaseHealthDecision {
  /** 是否建议 auto-hold（已 held 时不重复触发） */
  shouldAutoHold: boolean;
  /** 是否建议 retired（仅建议，不自动执行） */
  shouldSuggestRetired: boolean;
  /** 滞回：恢复 active 需的 alignmentRate 水位 */
  recoveryAlignmentRate: number;
  /** 当前 release status（幂等检查输入） */
  currentStatus: ReleaseStatus;
  /** 是否已 held（幂等标记） */
  alreadyHeld: boolean;
}

/** 健康判定结果 */
export interface ReleaseHealthEvaluation {
  releaseId: string;
  status: ReleaseHealthStatus;
  evidence: ReleaseHealthEvidence;
  decision: ReleaseHealthDecision;
  /** 人工 override 提示（已 held 且 alignmentRate 低于滞回水位时填充） */
  overrideHint?: string;
}

/** evaluateReleaseHealth 选项 */
export interface EvaluateReleaseHealthOptions {
  releaseId: string;
  currentStatus: ReleaseStatus;
  healthReport: ReleaseHealthReport;
  /**
   * 长期窗口 alignmentRate；未提供时 fallback 到 healthReport.alignmentStats.alignmentRate。
   *
   * 长期窗口用于 retired_suggestion 判定，避免短期波动误触发退役建议。
   * 由调用方（release-health-actions / CLI）按 RETIRED_EVALUATION_WINDOW 计算后传入。
   */
  longTermAlignmentRate?: number;
  /**
   * 连续负收益数；未提供时 fallback 到 strategyReputations 中的最大 consecutiveLosses。
   *
   * 用于 auto_hold_eligible 判定。
   */
  consecutiveNegative?: number;
}

// ============================================================================
// 纯函数实现
// ============================================================================

/**
 * 从 strategyReputations 中提取最大 consecutiveLosses。
 *
 * 用于 consecutiveNegative fallback：当调用方未显式传入 consecutiveNegative 时，
 * 取所有策略信誉快照中的最大 consecutiveLosses 作为 release 级别的连续负收益指标。
 */
function resolveConsecutiveNegative(
  strategyReputations: StrategyReputationSnapshot[],
  explicit?: number,
): number {
  if (typeof explicit === "number") {
    return explicit;
  }
  if (!Array.isArray(strategyReputations) || strategyReputations.length === 0) {
    return 0;
  }
  return Math.max(
    0,
    ...strategyReputations.map((s) => s.consecutiveLosses ?? 0),
  );
}

/**
 * 判定 release 健康状态并输出决策建议（纯函数，无副作用）。
 *
 * @param options 包含 releaseId / currentStatus / healthReport / 可选 longTermAlignmentRate / consecutiveNegative
 * @returns ReleaseHealthEvaluation，包含 status / evidence / decision / 可选 overrideHint
 */
export function evaluateReleaseHealth(
  options: EvaluateReleaseHealthOptions,
): ReleaseHealthEvaluation {
  const { releaseId, currentStatus, healthReport } = options;

  // 证据采集
  const sampleCount = healthReport.totalFeedbackRecords ?? 0;
  const alignmentRate = healthReport.alignmentStats?.alignmentRate ?? 0;
  const rolledBack = healthReport.rollbackStats?.rolledBack ?? 0;
  const rollbackRate = sampleCount > 0 ? rolledBack / sampleCount : 0;
  const factGuardPassRate = healthReport.factGuardStats?.passRate ?? null;

  const consecutiveNegative = resolveConsecutiveNegative(
    healthReport.strategyReputations ?? [],
    options.consecutiveNegative,
  );

  // longTermAlignmentRate fallback：未提供时用 alignmentRate
  const longTermAlignmentRate =
    typeof options.longTermAlignmentRate === "number"
      ? options.longTermAlignmentRate
      : alignmentRate;

  // 幂等与滞回
  const alreadyHeld = currentStatus === "held";
  const recoveryAlignmentRate = RECOVERY_ALIGNMENT_RATE;

  // 健康状态判定（优先级从高到低）
  let status: ReleaseHealthStatus;

  if (sampleCount < MIN_SAMPLE_SIZE) {
    // 1. 样本不足
    status = "insufficient_data";
  } else if (
    // 2. auto_hold 条件之一满足
    consecutiveNegative >= AUTO_HOLD_CONSECUTIVE_NEGATIVE ||
    alignmentRate < AUTO_HOLD_ALIGNMENT_RATE ||
    rollbackRate > AUTO_HOLD_ROLLBACK_RATE ||
    (factGuardPassRate !== null && factGuardPassRate < AUTO_HOLD_FACTGUARD_PASS_RATE)
  ) {
    status = "auto_hold_eligible";
  } else if (longTermAlignmentRate < RETIRED_ALIGNMENT_RATE) {
    // 3. 长期负收益 → retired 建议
    status = "retired_suggestion";
  } else if (alignmentRate < HEALTHY_ALIGNMENT_RATE) {
    // 4. 短期 alignmentRate 偏低 → warning
    status = "warning";
  } else {
    // 5. 健康
    status = "healthy";
  }

  // 决策建议
  // shouldAutoHold: status=auto_hold_eligible 且未 held（幂等：已 held 不重复触发）
  const shouldAutoHold = status === "auto_hold_eligible" && !alreadyHeld;

  // shouldSuggestRetired: 长期 alignmentRate 低于 retired 水位（仅建议，不触发 auto-hold）
  // 需 sampleCount >= MIN_SAMPLE_SIZE，避免样本不足时误建议退役
  const shouldSuggestRetired =
    sampleCount >= MIN_SAMPLE_SIZE &&
    longTermAlignmentRate < RETIRED_ALIGNMENT_RATE;

  const evaluation: ReleaseHealthEvaluation = {
    releaseId,
    status,
    evidence: {
      sampleCount,
      alignmentRate,
      rollbackRate,
      factGuardPassRate,
      consecutiveNegative,
      longTermAlignmentRate,
    },
    decision: {
      shouldAutoHold,
      shouldSuggestRetired,
      recoveryAlignmentRate,
      currentStatus,
      alreadyHeld,
    },
  };

  // 人工 override 提示：已 held 且 alignmentRate 低于滞回水位
  // 用户可通过 `evolution:promote --target active_dev --force` override 滞回
  if (alreadyHeld && alignmentRate < recoveryAlignmentRate) {
    evaluation.overrideHint =
      `Release 已 held；当前 alignmentRate=${alignmentRate.toFixed(2)} ` +
      `< recoveryAlignmentRate=${recoveryAlignmentRate}. ` +
      `恢复 active 需 alignmentRate >= ${recoveryAlignmentRate}，` +
      `或使用 evolution:promote --target active_dev --force override 滞回。`;
  }

  return evaluation;
}
