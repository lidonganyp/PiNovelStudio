/**
 * MODEL-CALL-OBSERVABILITY — Trace / 成本 / 延迟观测（WP-05）
 *
 * 扩展模型调用 trace 字段，并提供延迟分位、成本与失败分布报告。
 */

import type { BudgetType } from "./layered-budget.js";
import { computeActualCost } from "./unit-price-schedule.js";

export interface ObservableModelCall {
  runId: string;
  stage: string;
  route: string;
  provider: string;
  model: string;
  modelVersion: string;
  promptBundleHash: string;
  contextHash: string;
  temperature: number;
  maxTokens: number;
  timeout: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  waitMs: number;
  retryIndex: number;
  budgetType: BudgetType;
  finishReason?: string;
  failureType?: string;
  failed?: boolean;
  cost?: number;
  ts?: number;
  fallbackTrace?: {
    authorized: true;
    fromRoute: string;
    attemptedRoutes: string[];
    failures: string[];
  };
}

export interface LatencyStats {
  count: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  avg: number;
  max: number;
  firstTokenLatencyMs?: number;
}

export interface CostReport {
  totalCalls: number;
  failedCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  totalWaitMs: number;
  totalCost: number;
  byRoute: Record<string, number>;
  byProvider: Record<string, number>;
  byBudgetType: Record<string, number>;
  failureTypeDistribution: Record<string, number>;
}

export interface RoutingStabilityReport {
  runId: string;
  expectedProvider: string;
  expectedModel: string;
  driftCount: number;
  unauthorizedCrossModelCount: number;
  calls: number;
  stable: boolean;
  drifts: Array<{ route: string; provider: string; model: string; reason: string }>;
}

export interface LongTailReport {
  longTailThresholdMs: number;
  longTailCalls: ObservableModelCall[];
  agenticToolGapsMs: number[];
  styleOptimizationDurationsMs: number[];
  recoveryTotalDurationMs: number;
  userFinalWaitMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function computeLatencyStats(durationsMs: number[]): LatencyStats {
  const sorted = [...durationsMs].filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    avg: count === 0 ? 0 : sum / count,
    max: count === 0 ? 0 : sorted[count - 1]!,
    firstTokenLatencyMs: sorted[0],
  };
}

export function estimateCallCost(input: {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  /** 可选单价覆盖（每 1M tokens）；提供时不走版本化价格表 */
  pricePerMillion?: { input: number; output: number };
  unitPriceScheduleVersion?: string;
}): number {
  if (input.pricePerMillion) {
    return (
      (input.inputTokens / 1_000_000) * input.pricePerMillion.input +
      (input.outputTokens / 1_000_000) * input.pricePerMillion.output
    );
  }
  return computeActualCost({
    provider: input.provider,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    unitPriceScheduleVersion: input.unitPriceScheduleVersion,
  }).actualCost;
}

export function buildCostReport(calls: readonly ObservableModelCall[]): CostReport {
  const report: CostReport = {
    totalCalls: calls.length,
    failedCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalDurationMs: 0,
    totalWaitMs: 0,
    totalCost: 0,
    byRoute: {},
    byProvider: {},
    byBudgetType: {},
    failureTypeDistribution: {},
  };

  for (const call of calls) {
    if (call.failed) report.failedCalls += 1;
    report.totalInputTokens += call.inputTokens;
    report.totalOutputTokens += call.outputTokens;
    report.totalDurationMs += call.durationMs;
    report.totalWaitMs += call.waitMs;
    const cost =
      call.cost ??
      estimateCallCost({
        provider: call.provider,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
      });
    report.totalCost += cost;
    report.byRoute[call.route] = (report.byRoute[call.route] ?? 0) + 1;
    report.byProvider[call.provider] = (report.byProvider[call.provider] ?? 0) + 1;
    report.byBudgetType[call.budgetType] = (report.byBudgetType[call.budgetType] ?? 0) + 1;
    if (call.failureType) {
      report.failureTypeDistribution[call.failureType] =
        (report.failureTypeDistribution[call.failureType] ?? 0) + 1;
    } else if (call.failed) {
      report.failureTypeDistribution["unknown"] =
        (report.failureTypeDistribution["unknown"] ?? 0) + 1;
    }
  }
  return report;
}

export function buildRoutingStabilityReport(input: {
  runId: string;
  expectedProvider: string;
  expectedModel: string;
  calls: readonly ObservableModelCall[];
}): RoutingStabilityReport {
  const drifts: RoutingStabilityReport["drifts"] = [];
  let unauthorizedCrossModelCount = 0;
  for (const call of input.calls) {
    if (call.provider !== input.expectedProvider || call.model !== input.expectedModel) {
      if (call.fallbackTrace?.authorized) continue;
      // judge 路由允许异源，不计入生产写漂移
      if (call.route.includes("judge")) continue;
      const reason =
        call.provider !== input.expectedProvider
          ? "provider_drift"
          : "model_drift";
      drifts.push({
        route: call.route,
        provider: call.provider,
        model: call.model,
        reason,
      });
      if (call.provider !== input.expectedProvider) unauthorizedCrossModelCount += 1;
    }
  }
  return {
    runId: input.runId,
    expectedProvider: input.expectedProvider,
    expectedModel: input.expectedModel,
    driftCount: drifts.length,
    unauthorizedCrossModelCount,
    calls: input.calls.length,
    stable: drifts.length === 0,
    drifts,
  };
}

export function buildLongTailReport(
  calls: readonly ObservableModelCall[],
  opts?: {
    longTailThresholdMs?: number;
    recoveryTotalDurationMs?: number;
    userFinalWaitMs?: number;
  },
): LongTailReport {
  const threshold = opts?.longTailThresholdMs ?? 120_000;
  const longTailCalls = calls.filter((c) => c.durationMs >= threshold);
  const agentic = calls.filter((c) => c.stage.toLowerCase().includes("agentic"));
  const agenticToolGapsMs: number[] = [];
  for (let i = 1; i < agentic.length; i++) {
    const prev = agentic[i - 1]!;
    const cur = agentic[i]!;
    const gap = (cur.ts ?? 0) - ((prev.ts ?? 0) + prev.durationMs);
    if (gap > 0) agenticToolGapsMs.push(gap);
  }
  const styleOptimizationDurationsMs = calls
    .filter((c) => c.stage.toLowerCase().includes("style") || c.route.includes("amplified"))
    .map((c) => c.durationMs);

  return {
    longTailThresholdMs: threshold,
    longTailCalls,
    agenticToolGapsMs,
    styleOptimizationDurationsMs,
    recoveryTotalDurationMs: opts?.recoveryTotalDurationMs ??
      calls.filter((c) => c.budgetType === "recovery").reduce((s, c) => s + c.durationMs, 0),
    userFinalWaitMs:
      opts?.userFinalWaitMs ??
      calls.reduce((s, c) => s + c.durationMs + c.waitMs, 0),
  };
}

/**
 * 从 orchestrator ModelCallEntry 宽松投影为 ObservableModelCall。
 */
export function projectModelCallEntry(
  entry: {
    route: string;
    kind?: string;
    model?: string;
    provider?: string;
    durationMs: number;
    tokenUsage?: "unknown" | { in: number; out: number };
    failed?: boolean;
    requestedRoute?: string;
    expectedProvider?: string;
    expectedModel?: string;
    fallbackTrace?: ObservableModelCall["fallbackTrace"];
    finishReason?: string;
    maxTokens?: number;
    ts?: number;
  },
  ctx: {
    runId: string;
    stage: string;
    modelVersion?: string;
    promptBundleHash?: string;
    contextHash?: string;
    temperature?: number;
    timeout?: number;
    retryIndex?: number;
    budgetType?: BudgetType;
    failureType?: string;
    waitMs?: number;
  },
): ObservableModelCall {
  const tokens =
    entry.tokenUsage && entry.tokenUsage !== "unknown"
      ? entry.tokenUsage
      : { in: 0, out: 0 };
  const provider = entry.provider ?? entry.expectedProvider ?? "unknown";
  const model = entry.model ?? entry.expectedModel ?? "unknown";
  return {
    runId: ctx.runId,
    stage: ctx.stage,
    route: entry.requestedRoute ?? entry.route,
    provider,
    model,
    modelVersion: ctx.modelVersion ?? model,
    promptBundleHash: ctx.promptBundleHash ?? "bundle:unset",
    contextHash: ctx.contextHash ?? "context:unset",
    temperature: ctx.temperature ?? 0,
    maxTokens: entry.maxTokens ?? ctx.timeout ?? 0,
    timeout: ctx.timeout ?? 0,
    inputTokens: tokens.in,
    outputTokens: tokens.out,
    durationMs: entry.durationMs,
    waitMs: ctx.waitMs ?? 0,
    retryIndex: ctx.retryIndex ?? 0,
    budgetType: ctx.budgetType ?? "normal",
    finishReason: entry.finishReason,
    failureType: ctx.failureType,
    failed: entry.failed,
    cost: estimateCallCost({ provider, inputTokens: tokens.in, outputTokens: tokens.out }),
    ts: entry.ts,
    fallbackTrace: entry.fallbackTrace,
  };
}

export function assertAllCallsHaveTraceCost(calls: readonly ObservableModelCall[]): {
  ok: boolean;
  missing: number;
} {
  let missing = 0;
  for (const call of calls) {
    if (call.cost === undefined || !Number.isFinite(call.cost)) missing += 1;
    if (!call.route || !call.provider || !call.model) missing += 1;
    if (!call.timeout || call.timeout <= 0) missing += 1;
  }
  return { ok: missing === 0, missing };
}
