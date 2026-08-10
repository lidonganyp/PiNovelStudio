/**
 * Phase 7 - 推理预算门禁评估（eval-only）
 *
 * 评估 B/C 组是否通过预注册门禁（见 docs/phase7-reasoning-budget-design.md §5）。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import type { ToolAbArmAggregation } from "./tool-ab-runner.js";

// ============================================================================
// 类型
// ============================================================================

/** 单臂聚合扩展停止率 */
export interface BudgetArmAggregation extends ToolAbArmAggregation {
  /** 停止率：确定性 replay 固定 1.0；真实模型 replay 才会变化 */
  stopRate: number;
  /** 首次有效证据平均延迟 (ms) */
  avgFirstEvidenceLatencyMs: number;
  /** 预算耗尽次数 */
  budgetExhaustedCount: number;
}

/** B 组门禁结果 */
export interface BudgetGateB {
  coverageNotDegraded: boolean;
  sourceRefNotDegraded: boolean;
  failureNotWorse: boolean;
  tokenCostReduced: boolean;
  stopRateNotDegraded: boolean;
  latencyNotWorse: boolean;
  allPassed: boolean;
  details: Record<string, string>;
}

/** C 组门禁结果 */
export interface BudgetGateC {
  coverageNotDegraded: boolean;
  sourceRefNotDegraded: boolean;
  failureNotWorse: boolean;
  lowRiskTokenReduced: boolean;
  highRiskCoverageImproved: boolean;
  stopRateNotDegraded: boolean;
  tokenNotInflated: boolean;
  allPassed: boolean;
  details: Record<string, string>;
}

// ============================================================================
// 容差常量
// ============================================================================

/** 覆盖率/sourceRef 容差（B 组允许 5% 降级） */
const COVERAGE_TOLERANCE = 0.05;

/** 停止率容差（允许 5% 降级） */
const STOP_RATE_TOLERANCE = 0.05;

/** token 成本下降门槛（B 组需下降 > 10%） */
const TOKEN_REDUCTION_THRESHOLD = 0.9;

/** token 膨胀上限（C 组不超过 A 的 15%） */
const TOKEN_INFLATION_LIMIT = 1.15;

// ============================================================================
// B 组门禁
// ============================================================================

/**
 * 评估 B 组门禁（温和降低预算不降级）。
 *
 * 门禁（见设计文档 §5.1）：
 * 1. mustVerify 覆盖率不降级：B >= A - 5%
 * 2. sourceRef 完整率不降级：B >= A - 5%
 * 3. 失败行为不恶化：B errors/timeouts/empty/truncated <= A + 容差
 * 4. token 成本下降：B < A × 0.9 (-10%)
 * 5. 停止率不降级：B >= A - 5%
 * 6. 首证据延迟不恶化：B <= A + 1ms
 */
export function evaluateBudgetGateB(
  a: BudgetArmAggregation,
  b: BudgetArmAggregation,
): BudgetGateB {
  const coverageNotDegraded =
    b.avgCoverageRatio >= a.avgCoverageRatio - COVERAGE_TOLERANCE;
  const sourceRefNotDegraded =
    b.sourceRefCompleteness >= a.sourceRefCompleteness - COVERAGE_TOLERANCE;
  const failureNotWorse =
    b.totalErrors <= a.totalErrors &&
    b.totalTimeouts <= a.totalTimeouts &&
    b.totalEmptyResults <= a.totalEmptyResults &&
    b.totalTruncatedResults <= a.totalTruncatedResults;
  const tokenCostReduced =
    a.totalEstimateTokens > 0 &&
    b.totalEstimateTokens < a.totalEstimateTokens * TOKEN_REDUCTION_THRESHOLD;
  const stopRateNotDegraded =
    b.stopRate >= a.stopRate - STOP_RATE_TOLERANCE;
  const latencyNotWorse =
    b.avgFirstEvidenceLatencyMs <= a.avgFirstEvidenceLatencyMs + 1;

  const allPassed =
    coverageNotDegraded &&
    sourceRefNotDegraded &&
    failureNotWorse &&
    tokenCostReduced &&
    stopRateNotDegraded &&
    latencyNotWorse;

  return {
    coverageNotDegraded,
    sourceRefNotDegraded,
    failureNotWorse,
    tokenCostReduced,
    stopRateNotDegraded,
    latencyNotWorse,
    allPassed,
    details: {
      coverageNotDegraded: `B=${b.avgCoverageRatio.toFixed(3)} >= A=${a.avgCoverageRatio.toFixed(3)} - ${COVERAGE_TOLERANCE}`,
      sourceRefNotDegraded: `B=${b.sourceRefCompleteness.toFixed(3)} >= A=${a.sourceRefCompleteness.toFixed(3)} - ${COVERAGE_TOLERANCE}`,
      failureNotWorse: `errors B=${b.totalErrors}<=A=${a.totalErrors}, timeouts B=${b.totalTimeouts}<=A=${a.totalTimeouts}, empty B=${b.totalEmptyResults}<=A=${a.totalEmptyResults}, truncated B=${b.totalTruncatedResults}<=A=${a.totalTruncatedResults}`,
      tokenCostReduced: `B=${b.totalEstimateTokens} < A=${a.totalEstimateTokens}×${TOKEN_REDUCTION_THRESHOLD}=${Math.round(a.totalEstimateTokens * TOKEN_REDUCTION_THRESHOLD)}`,
      stopRateNotDegraded: `B=${(b.stopRate * 100).toFixed(0)}% >= A=${(a.stopRate * 100).toFixed(0)}% - ${(STOP_RATE_TOLERANCE * 100).toFixed(0)}%`,
      latencyNotWorse: `B=${b.avgFirstEvidenceLatencyMs}ms <= A=${a.avgFirstEvidenceLatencyMs}ms + 1`,
    },
  };
}

// ============================================================================
// C 组门禁
// ============================================================================

/**
 * 评估 C 组门禁（自适应预算不降级 + 分类收益）。
 *
 * 门禁（见设计文档 §5.2/§5.3）：
 * 1. mustVerify 覆盖率不降级：C >= A
 * 2. sourceRef 完整率不降级：C >= A
 * 3. 失败行为不恶化：C errors/timeouts/empty/truncated <= A
 * 4. 低风险章节 token 下降：C_low < A_low × 0.9
 * 5. 高风险章节覆盖率提升：C_high > A_high
 * 6. 停止率不降级：C >= A - 5%
 * 7. 聚合 token 不膨胀：C <= A × 1.15
 *
 * 注意：门禁 4/5 需要按 riskTier 分场景聚合，在 runner 中计算后传入。
 */
export function evaluateBudgetGateC(
  a: BudgetArmAggregation,
  c: BudgetArmAggregation,
  lowRiskA: BudgetArmAggregation | null,
  lowRiskC: BudgetArmAggregation | null,
  highRiskA: BudgetArmAggregation | null,
  highRiskC: BudgetArmAggregation | null,
): BudgetGateC {
  const coverageNotDegraded = c.avgCoverageRatio >= a.avgCoverageRatio;
  const sourceRefNotDegraded = c.sourceRefCompleteness >= a.sourceRefCompleteness;
  const failureNotWorse =
    c.totalErrors <= a.totalErrors &&
    c.totalTimeouts <= a.totalTimeouts &&
    c.totalEmptyResults <= a.totalEmptyResults &&
    c.totalTruncatedResults <= a.totalTruncatedResults;

  // 低风险章节 token 下降（需要分场景数据）
  const lowRiskTokenReduced =
    lowRiskA !== null && lowRiskC !== null &&
    lowRiskA.totalEstimateTokens > 0 &&
    lowRiskC.totalEstimateTokens < lowRiskA.totalEstimateTokens * TOKEN_REDUCTION_THRESHOLD;

  // 高风险章节覆盖率提升（需要分场景数据）
  const highRiskCoverageImproved =
    highRiskA !== null && highRiskC !== null &&
    highRiskC.avgCoverageRatio > highRiskA.avgCoverageRatio;

  const stopRateNotDegraded = c.stopRate >= a.stopRate - STOP_RATE_TOLERANCE;

  const tokenNotInflated =
    c.totalEstimateTokens <= a.totalEstimateTokens * TOKEN_INFLATION_LIMIT;

  const allPassed =
    coverageNotDegraded &&
    sourceRefNotDegraded &&
    failureNotWorse &&
    stopRateNotDegraded &&
    tokenNotInflated &&
    (lowRiskA === null || lowRiskTokenReduced) &&
    (highRiskA === null || highRiskCoverageImproved);

  return {
    coverageNotDegraded,
    sourceRefNotDegraded,
    failureNotWorse,
    lowRiskTokenReduced,
    highRiskCoverageImproved,
    stopRateNotDegraded,
    tokenNotInflated,
    allPassed,
    details: {
      coverageNotDegraded: `C=${c.avgCoverageRatio.toFixed(3)} >= A=${a.avgCoverageRatio.toFixed(3)}`,
      sourceRefNotDegraded: `C=${c.sourceRefCompleteness.toFixed(3)} >= A=${a.sourceRefCompleteness.toFixed(3)}`,
      failureNotWorse: `errors C=${c.totalErrors}<=A=${a.totalErrors}, timeouts C=${c.totalTimeouts}<=A=${a.totalTimeouts}, empty C=${c.totalEmptyResults}<=A=${a.totalEmptyResults}, truncated C=${c.totalTruncatedResults}<=A=${a.totalTruncatedResults}`,
      lowRiskTokenReduced: lowRiskA && lowRiskC
        ? `C_low=${lowRiskC.totalEstimateTokens} < A_low=${lowRiskA.totalEstimateTokens}×${TOKEN_REDUCTION_THRESHOLD}`
        : `低风险场景数据${lowRiskA ? "C缺失" : "A缺失"}`,
      highRiskCoverageImproved: highRiskA && highRiskC
        ? `C_high=${highRiskC.avgCoverageRatio.toFixed(3)} > A_high=${highRiskA.avgCoverageRatio.toFixed(3)}`
        : `高风险场景数据${highRiskA ? "C缺失" : "A缺失"}`,
      stopRateNotDegraded: `C=${(c.stopRate * 100).toFixed(0)}% >= A=${(a.stopRate * 100).toFixed(0)}% - ${(STOP_RATE_TOLERANCE * 100).toFixed(0)}%`,
      tokenNotInflated: `C=${c.totalEstimateTokens} <= A=${a.totalEstimateTokens}×${TOKEN_INFLATION_LIMIT}=${Math.round(a.totalEstimateTokens * TOKEN_INFLATION_LIMIT)}`,
    },
  };
}
