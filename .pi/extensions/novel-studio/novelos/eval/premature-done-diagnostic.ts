/**
 * Phase 9 - Premature Done 诊断（eval-only）
 *
 * 检测模型在检索验证前过早输出终止标记（<done>）的行为。
 *
 * Phase 8 Stage P 根因：P-B（Gemini 专属 Prompt）过度强调"证据充分即输出 <done>"，
 * 导致真实模型在检索验证前就过早终止：
 * - mustVerify 覆盖率从 0.983 崩溃至 0.134
 * - sourceRef 完整率从 0.880 崩溃至 0.083
 * - 9 个场景空结果/超时/错误
 * - 总调用仅 10（P-A=124）
 *
 * 本模块将"过早终止"从隐性行为提升为显式诊断指标 prematureDoneRate，
 * 作为 Prompt 版本管理的评测门禁之一。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import type { RealToolAbScenarioMetrics } from "./tool-ab-real-runner.js";

// ============================================================================
// 类型
// ============================================================================

/** 单场景的过早终止诊断详情 */
export interface PrematureDoneDetail {
  scenarioId: string;
  seed: number;
  /** 模型总调用次数 */
  totalCalls: number;
  /** 有效证据回合数（firstValidEvidence != null 或 sourceRefsValid > 0） */
  validEvidenceCount: number;
  /** 是否由模型主动输出终止标记收敛 */
  stopped: boolean;
  /** 是否判定为过早终止 */
  premature: boolean;
  /** 判定原因 */
  reason: string;
}

/** prematureDoneRate 诊断结果 */
export interface PrematureDoneResult {
  /** 总场景数 */
  totalScenarios: number;
  /** 过早终止场景数 */
  prematureDoneCount: number;
  /** 过早终止率 = prematureDoneCount / totalScenarios */
  prematureDoneRate: number;
  /** 逐场景详情 */
  details: PrematureDoneDetail[];
}

// ============================================================================
// 诊断逻辑
// ============================================================================

/**
 * 判定单个场景是否为过早终止。
 *
 * 判定标准（满足任一即为 premature）：
 * 1. 模型输出终止标记（stopped=true）但有效证据数 = 0
 *    -> "无有效证据即 done"：模型在未检索任何证据的情况下直接终止
 * 2. 总调用 = 0 且结果为空/错误/超时
 *    -> 模型完全未执行任何工具调用，可能是 prompt 导致的"直接放弃"
 * 3. mustVerify 覆盖率 < 0.1 且 totalCalls < 3
 *    -> 极低覆盖率 + 极少调用 = 检索计划未执行就终止
 */
export function diagnosePrematureDone(metrics: RealToolAbScenarioMetrics): PrematureDoneDetail {
  const totalCalls = metrics.totalCalls;
  const validEvidenceCount =
    (metrics.firstValidEvidence ? 1 : 0) +
    (metrics.sourceRefsValid > 0 ? 1 : 0);
  const stopped = metrics.stopped;
  const coverage = metrics.mustVerify?.coverageRatio ?? 0;

  // 判定 1：输出终止标记但无有效证据
  if (stopped && validEvidenceCount === 0) {
    return {
      scenarioId: metrics.scenarioId,
      seed: metrics.seed,
      totalCalls,
      validEvidenceCount,
      stopped,
      premature: true,
      reason: "模型输出终止标记但无有效证据（无有效证据即 done）",
    };
  }

  // 判定 2：零调用且结果为空/错误
  if (totalCalls === 0 && (metrics.emptyResults > 0 || metrics.errors > 0 || metrics.timeouts > 0)) {
    return {
      scenarioId: metrics.scenarioId,
      seed: metrics.seed,
      totalCalls,
      validEvidenceCount,
      stopped,
      premature: true,
      reason: "模型零调用且结果为空/错误/超时（直接放弃检索）",
    };
  }

  // 判定 3：极低覆盖率 + 极少调用
  if (coverage < 0.1 && totalCalls < 3) {
    return {
      scenarioId: metrics.scenarioId,
      seed: metrics.seed,
      totalCalls,
      validEvidenceCount,
      stopped,
      premature: true,
      reason: `极低覆盖率(${coverage.toFixed(3)}) + 极少调用(${totalCalls}) = 检索计划未执行`,
    };
  }

  return {
    scenarioId: metrics.scenarioId,
    seed: metrics.seed,
    totalCalls,
    validEvidenceCount,
    stopped,
    premature: false,
    reason: "正常执行",
  };
}

/**
 * 计算一组场景的 prematureDoneRate。
 *
 * @param metrics 单臂跨 seed 的场景指标数组
 */
export function computePrematureDoneRate(metrics: RealToolAbScenarioMetrics[]): PrematureDoneResult {
  const details = metrics.map(diagnosePrematureDone);
  const prematureDoneCount = details.filter((d) => d.premature).length;
  const totalScenarios = details.length;

  return {
    totalScenarios,
    prematureDoneCount,
    prematureDoneRate: totalScenarios > 0 ? prematureDoneCount / totalScenarios : 0,
    details,
  };
}

// ============================================================================
// 门禁集成
// ============================================================================

/**
 * prematureDoneRate 门禁判定。
 *
 * 门禁规则：prematureDoneRate <= tolerance（默认 0.0，即不允许任何过早终止）。
 *
 * Phase 8 P-B 的 prematureDoneRate = 9/9 = 1.0（100% 场景过早终止），
 * 远超任何合理容差。
 */
export function evaluatePrematureDoneGate(
  result: PrematureDoneResult,
  tolerance = 0.0,
): {
  passed: boolean;
  tolerance: number;
  actual: number;
  details: string;
} {
  const passed = result.prematureDoneRate <= tolerance;
  return {
    passed,
    tolerance,
    actual: result.prematureDoneRate,
    details: `prematureDoneRate=${result.prematureDoneRate.toFixed(3)} (tolerance=${tolerance}, premature=${result.prematureDoneCount}/${result.totalScenarios})`,
  };
}
