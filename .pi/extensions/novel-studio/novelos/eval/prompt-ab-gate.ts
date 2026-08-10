/**
 * Phase 8 Stage P — Prompt-only 门禁（eval-only）
 *
 * 评估 P-B（Gemini 专属 Prompt）相对 P-A（通用 Prompt）是否通过预注册门禁
 * （见 docs/phase8-gemini-prompt-native-design.md §4.3）。
 *
 * 门禁（P-B 相对 P-A，全部满足才通过）：
 * 1. mustVerify 覆盖率不降级：>= A - 0.05
 * 2. sourceRef 完整率不降级：>= A - 0.05
 * 3. 非法调用不恶化（非法工具选择 + 解析失败）：<= A
 * 4. 空结果不恶化：<= A
 * 5. 停止率不降级：>= A - 5%
 * 6. token 成本：获益（< A×0.9）为加分项，非硬门
 * 7. 首证据延迟不恶化：<= A + 1ms
 *
 * 强调失败行为与 sourceRef 优先；token 为加分项，避免仅为省 token 牺牲覆盖/召回。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import type { RealToolAbArmAggregation } from "./tool-ab-real-runner.js";

// ============================================================================
// 类型
// ============================================================================

/** P-A / P-B 单臂聚合（在 RealToolAbArmAggregation 基础上补充停止率与首证延迟） */
export interface PromptArmAggregation extends RealToolAbArmAggregation {
  /** 停止率：模型主动输出终止标记收敛的场景占比 */
  stopRate: number;
  /** 首次有效证据平均延迟 (ms)；无有效证据时为 null */
  avgFirstEvidenceLatencyMs: number | null;
}

/** Stage P 门禁结果 */
export interface PromptGate {
  /** mustVerify 覆盖率不降级：B >= A - 0.05 */
  coverageNotDegraded: boolean;
  /** sourceRef 完整率不降级：B >= A - 0.05 */
  sourceRefNotDegraded: boolean;
  /** 非法调用不恶化：B 非法工具选择 + 解析失败 <= A */
  invalidCallsNotWorsened: boolean;
  /** 空结果不恶化：B <= A */
  emptyResultsNotWorsened: boolean;
  /** 停止率不降级：B >= A - 5% */
  stopRateNotDegraded: boolean;
  /** token 成本获益（加分项，非硬门）：B < A × 0.9 */
  tokenCostReduced: boolean;
  /** 首证据延迟不恶化（加分项，非硬门）：B <= A + 1ms */
  latencyNotWorse: boolean;
  /** 硬门全部通过（不含 token/latency 加分项） */
  allHardPassed: boolean;
  /** 所有门禁通过（含加分项） */
  allPassed: boolean;
  /** 各门禁详情 */
  details: Record<string, string>;
}

// ============================================================================
// 容差常量
// ============================================================================

/** 覆盖率 / sourceRef 容差（允许 5% 降级） */
const COVERAGE_TOLERANCE = 0.05;
/** 停止率容差（允许 5% 降级） */
const STOP_RATE_TOLERANCE = 0.05;
/** token 成本获益门槛（需 < A × 0.9） */
const TOKEN_REDUCTION_THRESHOLD = 0.9;

// ============================================================================
// 门禁评估
// ============================================================================

/**
 * 评估 Stage P 门禁（P-B Gemini 专属 Prompt 不降级且失败行为不恶化）。
 *
 * @param a P-A（通用 Prompt）聚合
 * @param b P-B（Gemini 专属 Prompt）聚合
 */
export function evaluatePromptGate(
  a: PromptArmAggregation,
  b: PromptArmAggregation,
): PromptGate {
  const coverageNotDegraded = b.avgCoverageRatio >= a.avgCoverageRatio - COVERAGE_TOLERANCE;
  const sourceRefNotDegraded =
    b.sourceRefCompleteness >= a.sourceRefCompleteness - COVERAGE_TOLERANCE;
  // 非法调用 = 非法工具选择 + 解析失败（含 directive 解析失败）。
  const invalidCallsNotWorsened =
    b.invalidToolSelections <= a.invalidToolSelections &&
    b.parseErrors <= a.parseErrors;
  const emptyResultsNotWorsened = b.emptyResults <= a.emptyResults;
  const stopRateNotDegraded = b.stopRate >= a.stopRate - STOP_RATE_TOLERANCE;
  // token 为加分项：获益（< A × 0.9）为真，否则恒 false（不阻塞硬门）。
  const tokenCostReduced =
    a.totalEstimateTokens > 0 &&
    b.totalEstimateTokens < a.totalEstimateTokens * TOKEN_REDUCTION_THRESHOLD;
  // 首证据延迟为加分项：A 无有效证据时不判（恒 true 不阻塞）。
  const latencyNotWorse =
    a.avgFirstEvidenceLatencyMs !== null
      ? b.avgFirstEvidenceLatencyMs !== null &&
        b.avgFirstEvidenceLatencyMs <= a.avgFirstEvidenceLatencyMs + 1
      : true;

  const allHardPassed =
    coverageNotDegraded &&
    sourceRefNotDegraded &&
    invalidCallsNotWorsened &&
    emptyResultsNotWorsened &&
    stopRateNotDegraded;

  const allPassed = allHardPassed && tokenCostReduced && latencyNotWorse;

  return {
    coverageNotDegraded,
    sourceRefNotDegraded,
    invalidCallsNotWorsened,
    emptyResultsNotWorsened,
    stopRateNotDegraded,
    tokenCostReduced,
    latencyNotWorse,
    allHardPassed,
    allPassed,
    details: {
      coverageNotDegraded: `B=${b.avgCoverageRatio.toFixed(3)} >= A=${a.avgCoverageRatio.toFixed(3)} - ${COVERAGE_TOLERANCE}`,
      sourceRefNotDegraded: `B=${b.sourceRefCompleteness.toFixed(3)} >= A=${a.sourceRefCompleteness.toFixed(3)} - ${COVERAGE_TOLERANCE}`,
      invalidCallsNotWorsened: `非法工具 B=${b.invalidToolSelections}<=A=${a.invalidToolSelections}, 解析失败 B=${b.parseErrors}<=A=${a.parseErrors}`,
      emptyResultsNotWorsened: `B=${b.emptyResults} <= A=${a.emptyResults}`,
      stopRateNotDegraded: `B=${(b.stopRate * 100).toFixed(0)}% >= A=${(a.stopRate * 100).toFixed(0)}% - ${(STOP_RATE_TOLERANCE * 100).toFixed(0)}%`,
      tokenCostReduced: `B=${b.totalEstimateTokens} < A=${a.totalEstimateTokens}×${TOKEN_REDUCTION_THRESHOLD}=${Math.round(a.totalEstimateTokens * TOKEN_REDUCTION_THRESHOLD)}`,
      latencyNotWorse: a.avgFirstEvidenceLatencyMs !== null
        ? `B=${b.avgFirstEvidenceLatencyMs?.toFixed(0) ?? "unmeasured"}ms <= A=${a.avgFirstEvidenceLatencyMs.toFixed(0)}ms + 1`
        : "A 无有效证据（unmeasured，不判）",
    },
  };
}