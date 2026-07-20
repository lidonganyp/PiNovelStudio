/**
 * ReleaseEligibilityRecomputer — G8 eligibility 重算纯函数（EVOLUTION-RELEASE-GOVERNANCE-G8）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §8 Phase G8
 * 计划：.trae/documents/g8-health-monitoring-and-retirement-implementation.md §2.6
 *
 * 在 strategy 被 retire 后，重新评估 release 是否仍满足晋级条件。
 * 检查 strategyReputations 中是否有 status="retired" 的策略：
 * - 无 retired strategy -> eligibility="intact"
 * - 有 retired strategy 且 approvalRef 非空 -> eligibility="needs_requalify"（reason=strategy_retired）
 * - 有 retired strategy 但 approvalRef=null -> eligibility="unverifiable"（无法验证关联）
 *
 * 注：计划文档使用 "revoked" 术语，但实际 StrategyStatus 类型为 "retired"
 *（见 v2/learning/strategy-policy-store.ts:59）。本模块按实际类型实现，语义一致。
 *
 * suggestedAction 优先级（仅 needs_requalify 时填充）：
 * 1. retire: longTermAlignmentRate < RETIRED_ALIGNMENT_RATE (0.3)
 * 2. hold: alignmentRate < AUTO_HOLD_ALIGNMENT_RATE (0.4)
 * 3. requalify: retired strategy sampleCount >= MIN_SAMPLE_SIZE (3)
 * 4. undefined: 无足够信号
 *
 * 设计原则：
 * - 纯函数：无副作用、不调模型、不读写文件
 * - 不自动执行：只返回建议，由 CLI/handler 决策
 * - intact 时永远不返回 suggestedAction（无 retired strategy 无需重算）
 *
 * 边界（READY_LOCAL）：
 * - 闭包自包含（仅依赖 governance sibling：release-health-aggregator + release-health-thresholds）
 * - 可被 dist-test/ / dist/ / dist-eval/ 任意闭包消费
 */

import type { StrategyReputationSnapshot } from "./release-health-aggregator.js";
import {
  MIN_SAMPLE_SIZE,
  AUTO_HOLD_ALIGNMENT_RATE,
  RETIRED_ALIGNMENT_RATE,
} from "./release-health-thresholds.js";

// ============================================================================
// 类型
// ============================================================================

/** eligibility 判定结果 */
export type EligibilityStatus = "intact" | "needs_requalify" | "unverifiable";

/** 建议动作（仅 needs_requalify 时填充） */
export type EligibilitySuggestedAction = "requalify" | "hold" | "retire";

/** eligibility 重算结果 */
export interface EligibilityRecomputeResult {
  releaseId: string;
  eligibility: EligibilityStatus;
  /** 所有 status="retired" 的策略快照（计划术语为 "revoked"，实际类型为 "retired"） */
  revokedStrategies: StrategyReputationSnapshot[];
  /** 原因说明（needs_requalify / unverifiable 时填充） */
  reason?: string;
  /** 建议动作（仅 needs_requalify 时可能填充；intact/unverifiable 时为 undefined） */
  suggestedAction?: EligibilitySuggestedAction;
}

/** recomputeEligibility 选项 */
export interface RecomputeEligibilityOptions {
  /** 策略信誉快照（来自 release-health-aggregator） */
  strategyReputations: StrategyReputationSnapshot[];
  /** release ID */
  releaseId: string;
  /** 当前 release 的 approvalRef；为 null 时无法验证 strategy 关联 */
  approvalRef: string | null;
  /**
   * 可选：release 当前 alignmentRate，用于 suggestedAction 判定。
   * 未提供时视为健康（不触发 hold 建议）。
   */
  alignmentRate?: number;
  /**
   * 可选：release 长期 alignmentRate，用于 suggestedAction 判定。
   * 未提供时视为健康（不触发 retire 建议）。
   */
  longTermAlignmentRate?: number;
}

// ============================================================================
// 纯函数实现
// ============================================================================

/**
 * 从策略信誉快照中过滤出 status="retired" 的策略。
 *
 * 计划文档使用 "revoked" 术语，但实际 StrategyStatus 类型为
 * "candidate" | "active" | "dormant" | "retired"（见 strategy-policy-store.ts:59）。
 * 本函数按实际类型实现，检查 "retired" 状态。
 */
function findRevokedStrategies(
  strategyReputations: StrategyReputationSnapshot[],
): StrategyReputationSnapshot[] {
  if (!Array.isArray(strategyReputations)) {
    return [];
  }
  return strategyReputations.filter((s) => s?.status === "retired");
}

/**
 * 判定 suggestedAction（仅 needs_requalify 时调用）。
 *
 * 优先级（从高到低）：
 * 1. retire: longTermAlignmentRate < RETIRED_ALIGNMENT_RATE (0.3)
 * 2. hold: alignmentRate < AUTO_HOLD_ALIGNMENT_RATE (0.4)
 * 3. requalify: 任一 retired strategy 的 sampleCount >= MIN_SAMPLE_SIZE (3)
 * 4. undefined: 无足够信号
 *
 * @param revokedStrategies retired 策略列表
 * @param alignment release 当前 alignmentRate（可选）
 * @param longTermAlignment release 长期 alignmentRate（可选）
 * @returns 建议动作或 undefined
 */
function resolveSuggestedAction(
  revokedStrategies: StrategyReputationSnapshot[],
  alignment?: number,
  longTermAlignment?: number,
): EligibilitySuggestedAction | undefined {
  // 1. retire: 长期负收益优先（最严重）
  if (
    typeof longTermAlignment === "number" &&
    longTermAlignment < RETIRED_ALIGNMENT_RATE
  ) {
    return "retire";
  }

  // 2. hold: 当前 alignmentRate 偏低
  if (
    typeof alignment === "number" &&
    alignment < AUTO_HOLD_ALIGNMENT_RATE
  ) {
    return "hold";
  }

  // 3. requalify: retired strategy 有足够证据（sampleCount >= MIN_SAMPLE_SIZE）
  const hasMeaningfulEvidence = revokedStrategies.some(
    (s) => s.sampleCount >= MIN_SAMPLE_SIZE,
  );
  if (hasMeaningfulEvidence) {
    return "requalify";
  }

  // 4. 无足够信号
  return undefined;
}

/**
 * 重算 release eligibility（纯函数，无副作用）。
 *
 * @param options 包含 strategyReputations / releaseId / approvalRef / 可选 alignmentRate / longTermAlignmentRate
 * @returns EligibilityRecomputeResult
 */
export function recomputeEligibility(
  options: RecomputeEligibilityOptions,
): EligibilityRecomputeResult {
  const { strategyReputations, releaseId, approvalRef } = options;

  const revokedStrategies = findRevokedStrategies(strategyReputations);

  // 无 retired strategy -> intact
  if (revokedStrategies.length === 0) {
    return {
      releaseId,
      eligibility: "intact",
      revokedStrategies: [],
      // intact 时永远不返回 suggestedAction / reason
    };
  }

  // 有 retired strategy 但 approvalRef=null -> unverifiable
  if (approvalRef === null || approvalRef === undefined) {
    return {
      releaseId,
      eligibility: "unverifiable",
      revokedStrategies,
      reason: "approvalRef 为 null，无法验证 retired strategy 与本 release 的关联",
    };
  }

  // 有 retired strategy 且 approvalRef 非空 -> needs_requalify
  const suggestedAction = resolveSuggestedAction(
    revokedStrategies,
    options.alignmentRate,
    options.longTermAlignmentRate,
  );

  return {
    releaseId,
    eligibility: "needs_requalify",
    revokedStrategies,
    reason: "strategy_retired",
    suggestedAction,
  };
}
