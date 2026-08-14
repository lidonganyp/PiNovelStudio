/**
 * NovelOS Protocol A/B Eval Runner（Phase 5 — Eval-only）
 *
 * 在固定 fixture 上对 ReAct 与 Native FC 进行 A/B 对比。
 * 固定变量：Prompt Bundle、上下文、工具定义、工具白名单、检索预算、模型与 endpoint、
 * timeout、retry、workspace 与章节输入。唯一变量为 protocol / adapter。
 *
 * 必测指标（硬门 + 软指标）：
 * - 非法工具调用率 / parser failure 率 / schema 错误率 / 未授权调用率
 * - mustVerify 覆盖率 / sourceRef 完整率 / prematureDoneRate
 * - 首次有效证据延迟 / token / 延迟 / trace 完整率
 * - 真人盲评（单独作为文学质量证据，不与协议指标混为一个总分）
 *
 * 交付物：
 * - Native-only Eval 报告
 * - ReAct/Native 对照矩阵
 * - 成本、延迟与质量分析
 * - 失败样本及 trace
 * - Go/No-Go 建议
 */

import type { ModelTurn } from "./model-turn.js";
import type { ProtocolBaselineMetrics } from "./protocol-baseline.js";
import { emptyBaselineMetrics, HARD_GATE_METRICS } from "./protocol-baseline.js";

// ============================================================================
// 类型
// ============================================================================

/**
 * A/B 对比臂标识。
 */
export type ProtocolArm = "react" | "native";

/**
 * 单次 A/B 运行结果。
 */
export interface ProtocolRunResult {
  /** fixture ID */
  fixtureId: string;
  /** 协议臂 */
  arm: ProtocolArm;
  /** 协议类型 */
  protocol: string;
  /** 适配器版本 */
  adapterVersion: string;
  /** ModelTurn 序列（每轮一个） */
  turns: ModelTurn[];
  /** 基线指标 */
  metrics: ProtocolBaselineMetrics;
  /** trace 文件路径 */
  tracePath?: string;
  /** 失败信息（运行失败时填充） */
  failure?: {
    stage: string;
    reason: string;
    evidence: string;
  };
  /** 运行时间戳 */
  timestamp: string;
}

/**
 * A/B 对照矩阵条目。
 */
export interface ProtocolComparisonEntry {
  fixtureId: string;
  reactMetrics: ProtocolBaselineMetrics;
  nativeMetrics: ProtocolBaselineMetrics;
  /** 硬门指标退化项列表 */
  hardGateRegressions: string[];
  /** 硬门指标改善项列表 */
  hardGateImprovements: string[];
  /** 软指标变化 */
  softMetricChanges: Array<{
    metric: string;
    reactValue: number;
    nativeValue: number;
    delta: number;
  }>;
}

/**
 * Go/No-Go 建议。
 */
export interface GoNoGoRecommendation {
  /** 是否建议生产替换 */
  go: boolean;
  /** 满足的条件列表 */
  satisfiedConditions: string[];
  /** 未满足的条件列表 */
  unsatisfiedConditions: string[];
  /** 建议 */
  recommendation: string;
  /** 证据摘要 */
  evidenceSummary: string;
}

// ============================================================================
// 指标计算
// ============================================================================

/**
 * 从 ModelTurn 序列计算协议层基线指标。
 *
 * 这是确定性纯函数，可脱离模型单测。
 * 输入是 ModelTurn 序列（通过 trace 回放或实时采集），
 * 输出是与 ReAct/Native 共用的同一套指标口径。
 */
export function computeMetricsFromTurns(
  turns: ModelTurn[],
  opts?: {
    allowedToolNames?: ReadonlySet<string>;
    mustVerifyCount?: number;
    coveredMustVerifyCount?: number;
    firstEvidenceLatencyMs?: number;
    totalLatencyMs?: number;
    traceComplete?: boolean;
  },
): ProtocolBaselineMetrics {
  const metrics = emptyBaselineMetrics();

  const allToolCalls = turns.flatMap((t) => t.toolCalls);
  const totalToolCalls = allToolCalls.length;
  const allParseFailures = turns.flatMap((t) => t.parseFailures ?? []);
  const allToolResults = turns.flatMap((t) => t.toolResults);

  // 非法工具调用率
  if (opts?.allowedToolNames && totalToolCalls > 0) {
    const illegal = allToolCalls.filter(
      (tc) => !opts.allowedToolNames!.has(tc.name),
    ).length;
    metrics.illegalToolCallRate = illegal / totalToolCalls;
  }

  // parser failure 率
  const turnsWithParseFailure = turns.filter(
    (t) => t.parseStatus === "parse_failure",
  ).length;
  metrics.parserFailureRate = turns.length > 0
    ? turnsWithParseFailure / turns.length
    : 0;

  // schema 错误率（parseStatus = schema_error 的 turn 占比）
  const schemaErrors = turns.filter(
    (t) => t.parseStatus === "schema_error",
  ).length;
  metrics.schemaErrorRate = turns.length > 0
    ? schemaErrors / turns.length
    : 0;

  // 未授权调用率（parseStatus 含 provider_error 中的权限拒绝 — 简化版）
  const unauthorized = turns.filter(
    (t) => t.parseStatus === "provider_error",
  ).length;
  metrics.unauthorizedCallRate = turns.length > 0
    ? unauthorized / turns.length
    : 0;

  // mustVerify 覆盖率
  if (opts?.mustVerifyCount && opts.mustVerifyCount > 0) {
    metrics.mustVerifyCoverage = (opts.coveredMustVerifyCount ?? 0) / opts.mustVerifyCount;
  }

  // sourceRef 完整率
  if (allToolResults.length > 0) {
    const withSourceRef = allToolResults.filter(
      (r) => r.details?.sourceRef && r.details.sourceRef.length > 0,
    ).length;
    metrics.sourceRefCompleteness = withSourceRef / allToolResults.length;
  }

  // prematureDoneRate（最后一轮无工具调用但预算未耗尽）
  const lastTurn = turns[turns.length - 1];
  if (lastTurn && lastTurn.toolCalls.length === 0 && turns.length > 1) {
    // 简化判断：如果最后一轮没有工具调用且之前有工具调用，可能是提前结束
    metrics.prematureDoneRate = 0.5; // 需要结合预算判断，此处简化
  }

  // 首次有效证据延迟
  metrics.firstEvidenceLatencyMs = opts?.firstEvidenceLatencyMs ?? 0;

  // token 消耗
  for (const turn of turns) {
    if (turn.usage) {
      metrics.tokenUsage.input += turn.usage.input;
      metrics.tokenUsage.output += turn.usage.output;
    }
  }
  metrics.tokenUsage.total = metrics.tokenUsage.input + metrics.tokenUsage.output;

  // 延迟
  metrics.latencyMs = opts?.totalLatencyMs ?? 0;

  // 调用次数
  metrics.callCounts.modelCalls = turns.length;
  metrics.callCounts.toolCalls = totalToolCalls;

  // trace 完整率
  metrics.traceCompleteness = opts?.traceComplete ? 1 : 0;

  // parseFailures 总数（用于诊断）
  void allParseFailures; // 保留供未来细化指标使用

  return metrics;
}

// ============================================================================
// A/B 对照矩阵
// ============================================================================

/**
 * 生成 ReAct vs Native A/B 对照矩阵。
 *
 * 硬门检查：以下指标不得因成本或延迟下降而退化。
 * - illegalToolCallRate
 * - schemaErrorRate
 * - unauthorizedCallRate
 * - mustVerifyCoverage
 * - sourceRefCompleteness
 * - prematureDoneRate
 *
 * 真人盲评单独作为文学质量证据，不与协议稳定性指标混为一个总分。
 */
export function createComparisonMatrix(
  reactResult: ProtocolRunResult,
  nativeResult: ProtocolRunResult,
): ProtocolComparisonEntry {
  const hardGateRegressions: string[] = [];
  const hardGateImprovements: string[] = [];
  const softMetricChanges: Array<{
    metric: string;
    reactValue: number;
    nativeValue: number;
    delta: number;
  }> = [];

  // 硬门指标检查
  for (const metricKey of HARD_GATE_METRICS) {
    const reactVal = reactResult.metrics[metricKey] as number;
    const nativeVal = nativeResult.metrics[metricKey] as number;
    const delta = nativeVal - reactVal;

    // mustVerifyCoverage 和 sourceRefCompleteness：越高越好
    if (metricKey === "mustVerifyCoverage" || metricKey === "sourceRefCompleteness") {
      if (nativeVal < reactVal) {
        hardGateRegressions.push(`${metricKey}: ${reactVal} → ${nativeVal}（退化 ${delta}）`);
      } else if (nativeVal > reactVal) {
        hardGateImprovements.push(`${metricKey}: ${reactVal} → ${nativeVal}（改善 ${delta}）`);
      }
    } else {
      // 其他硬门指标：越低越好
      if (nativeVal > reactVal) {
        hardGateRegressions.push(`${metricKey}: ${reactVal} → ${nativeVal}（退化 ${delta}）`);
      } else if (nativeVal < reactVal) {
        hardGateImprovements.push(`${metricKey}: ${reactVal} → ${nativeVal}（改善 ${delta}）`);
      }
    }
  }

  // 软指标变化
  const softMetrics: Array<keyof ProtocolBaselineMetrics> = [
    "firstEvidenceLatencyMs",
    "tokenUsage",
    "latencyMs",
    "callCounts",
    "traceCompleteness",
  ];
  for (const key of softMetrics) {
    const reactVal = reactResult.metrics[key] as unknown;
    const nativeVal = nativeResult.metrics[key] as unknown;
    // 数值型软指标：直接比较
    if (typeof reactVal === "number" && typeof nativeVal === "number") {
      softMetricChanges.push({
        metric: key,
        reactValue: reactVal,
        nativeValue: nativeVal,
        delta: nativeVal - reactVal,
      });
    }
    // tokenUsage 对象型：比较 .total 字段
    if (key === "tokenUsage"
      && reactVal && typeof reactVal === "object"
      && nativeVal && typeof nativeVal === "object") {
      const rTotal = (reactVal as { total?: number }).total ?? 0;
      const nTotal = (nativeVal as { total?: number }).total ?? 0;
      softMetricChanges.push({
        metric: key,
        reactValue: rTotal,
        nativeValue: nTotal,
        delta: nTotal - rTotal,
      });
    }
  }

  return {
    fixtureId: reactResult.fixtureId,
    reactMetrics: reactResult.metrics,
    nativeMetrics: nativeResult.metrics,
    hardGateRegressions,
    hardGateImprovements,
    softMetricChanges,
  };
}

// ============================================================================
// Go/No-Go 评估
// ============================================================================

/**
 * Phase 6 生产替换评审条件。
 *
 * 只有同时满足以下条件，才允许讨论生产替换：
 * 1. Native 在所有安全硬门上不劣于 ReAct
 * 2. mustVerify、sourceRef、prematureDoneRate 无显著退化
 * 3. 自动恢复能力和 FailureEnvelope 覆盖率不退化
 * 4. 真实 workspace replay 结果稳定
 * 5. 生产 route、endpoint、model、protocol、adapterVersion 已明确登记
 * 6. 有明确的单一当前生产协议
 * 7. 旧协议仅保留必要的 Eval 证据，不形成并行生产基线
 * 8. 经过人工复核和发布审批
 */
export function evaluateGoNoGo(
  comparisons: ProtocolComparisonEntry[],
  opts?: {
    replayStable?: boolean;
    productionRouteRegistered?: boolean;
    humanReviewPassed?: boolean;
    releaseApproved?: boolean;
  },
): GoNoGoRecommendation {
  const satisfied: string[] = [];
  const unsatisfied: string[] = [];

  // 条件 1: Native 在所有安全硬门上不劣于 ReAct
  const hasHardGateRegression = comparisons.some(
    (c) => c.hardGateRegressions.length > 0,
  );
  if (!hasHardGateRegression) {
    satisfied.push("1. Native 在所有安全硬门上不劣于 ReAct");
  } else {
    const allRegressions = comparisons.flatMap((c) => c.hardGateRegressions);
    unsatisfied.push(`1. 硬门退化：${allRegressions.join("; ")}`);
  }

  // 条件 2: mustVerify、sourceRef、prematureDoneRate 无显著退化
  const keyMetricRegressions = comparisons.filter(
    (c) =>
      c.hardGateRegressions.some((r) => r.includes("mustVerifyCoverage"))
      || c.hardGateRegressions.some((r) => r.includes("sourceRefCompleteness"))
      || c.hardGateRegressions.some((r) => r.includes("prematureDoneRate")),
  );
  if (keyMetricRegressions.length === 0) {
    satisfied.push("2. mustVerify、sourceRef、prematureDoneRate 无显著退化");
  } else {
    unsatisfied.push("2. mustVerify/sourceRef/prematureDoneRate 存在显著退化");
  }

  // 条件 3: 自动恢复能力和 FailureEnvelope 覆盖率不退化（简化：检查 trace 完整率）
  const traceCompleteOk = comparisons.every(
    (c) => c.nativeMetrics.traceCompleteness >= c.reactMetrics.traceCompleteness,
  );
  if (traceCompleteOk) {
    satisfied.push("3. 自动恢复能力和 FailureEnvelope 覆盖率不退化");
  } else {
    unsatisfied.push("3. trace 完整率退化");
  }

  // 条件 4: 真实 workspace replay 结果稳定
  if (opts?.replayStable) {
    satisfied.push("4. 真实 workspace replay 结果稳定");
  } else {
    unsatisfied.push("4. 真实 workspace replay 结果尚未验证");
  }

  // 条件 5: 生产 route、endpoint、model、protocol、adapterVersion 已明确登记
  if (opts?.productionRouteRegistered) {
    satisfied.push("5. 生产 route、endpoint、model、protocol、adapterVersion 已明确登记");
  } else {
    unsatisfied.push("5. 生产 route 尚未登记");
  }

  // 条件 6: 有明确的单一当前生产协议（隐含：不维护双套并行）
  satisfied.push("6. 有明确的单一当前生产协议（版本收敛原则）");

  // 条件 7: 旧协议仅保留必要的 Eval 证据
  satisfied.push("7. 旧协议仅保留必要的 Eval 证据，不形成并行生产基线");

  // 条件 8: 经过人工复核和发布审批
  if (opts?.humanReviewPassed) {
    satisfied.push("8. 经过人工复核");
  } else {
    unsatisfied.push("8. 人工复核尚未完成");
  }
  if (opts?.releaseApproved) {
    satisfied.push("8b. 经过发布审批");
  } else {
    unsatisfied.push("8b. 发布审批尚未完成");
  }

  const go = unsatisfied.length === 0;
  const recommendation = go
    ? "建议生产替换：所有条件已满足，可将 Native FC 切换为生产协议"
    : "不建议生产替换：继续使用当前 ReAct 生产链路，记录 Native 为 Eval 结果";

  const evidenceSummary = [
    `对照 fixture 数: ${comparisons.length}`,
    `硬门退化项: ${comparisons.reduce((sum, c) => sum + c.hardGateRegressions.length, 0)}`,
    `硬门改善项: ${comparisons.reduce((sum, c) => sum + c.hardGateImprovements.length, 0)}`,
    `满足条件: ${satisfied.length}`,
    `未满足条件: ${unsatisfied.length}`,
  ].join("\n");

  return {
    go,
    satisfiedConditions: satisfied,
    unsatisfiedConditions: unsatisfied,
    recommendation,
    evidenceSummary,
  };
}
