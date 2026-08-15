/**
 * ROUTING-GOVERNANCE-RUNTIME — WP-03..07 生产运行时适配层
 *
 * 将分层预算 / 失败策略矩阵 / 观测报告 / 质量-成本分析
 * 接入统一编排器，而不另建第二套路由或预算系统。
 *
 * 设计：
 * - 与既有 RecoveryBudget / modelBudget 并存；layered budget 是权威分层账本
 * - 失败策略矩阵补充 attemptHistory 与 prohibited 证据，不替换 FailureEnvelope 主路径
 * - 观测与质量-成本报告写入 stageResults，供 trace 验收
 */

import {
  createLayeredBudget,
  reserveLayeredBudget,
  settleLayeredBudget,
  snapshotLayeredBudget,
  computeChapterCostBreakdown,
  type BudgetStage,
  type BudgetType,
  type LayeredBudget,
  type LayeredBudgetSnapshot,
} from "./layered-budget.js";
import {
  classifyFailureType,
  decideFailureStrategy,
  type AttemptHistoryEntry,
  type FailureType,
} from "./failure-strategy-matrix.js";
import {
  projectModelCallEntry,
  buildCostReport,
  buildRoutingStabilityReport,
  buildLongTailReport,
  computeLatencyStats,
  assertAllCallsHaveTraceCost,
  type ObservableModelCall,
  type CostReport,
  type LatencyStats,
  type RoutingStabilityReport,
  type LongTailReport,
} from "./model-call-observability.js";
import {
  aggregateQualityCostObservations,
  type QualityCostAggregate,
  type QualityCostObservation,
} from "./quality-cost-metrics.js";
import type { RunRoutingContext } from "./run-routing-context.js";
import type { ModelCallEntry } from "./orchestrator-types.js";
import type { RecoveryBudget } from "./recovery-types.js";

export interface RoutingGovernanceState {
  layeredBudget: LayeredBudget;
  attemptHistory: AttemptHistoryEntry[];
  runRouting?: RunRoutingContext;
  startedAtMs: number;
}

export interface ModelCallGovernanceReserveResult {
  ok: boolean;
  state: RoutingGovernanceState;
  reason?: string;
  budgetType: BudgetType;
  stage: BudgetStage;
}

export interface GovernanceReports {
  layeredBudget: {
    snapshot: LayeredBudgetSnapshot;
    chapterCostBreakdown: ReturnType<typeof computeChapterCostBreakdown>;
    stages: LayeredBudget["stages"];
    normal: LayeredBudget["normal"];
    recovery: LayeredBudget["recovery"];
    ux: LayeredBudget["ux"];
  };
  modelCallObservability: {
    latency: LatencyStats;
    costReport: CostReport;
    routingStability: RoutingStabilityReport | null;
    longTail: LongTailReport;
    traceCostCompleteness: { ok: boolean; missing: number };
    observableCalls: ObservableModelCall[];
  };
  failureStrategy?: {
    attemptHistory: AttemptHistoryEntry[];
    lastFailureType?: FailureType;
    lastDecision?: ReturnType<typeof decideFailureStrategy>;
  };
  qualityCostAnalysis: {
    note: "analysis_only_not_production_score";
    aggregate: QualityCostAggregate | null;
    observation: QualityCostObservation | null;
  };
  governanceVersion: "routing-governance-1.0";
}

function inferBudgetStage(kind: string, route: string): BudgetStage {
  const blob = `${kind} ${route}`.toLowerCase();
  if (blob.includes("retriev") || blob.includes("tool")) return "agenticRetrieval";
  if (blob.includes("verif") || blob.includes("fact") || blob.includes("must_verify")) {
    return "agenticVerification";
  }
  if (blob.includes("style") || blob.includes("amplified") || blob.includes("author_style")) {
    return "authorStyleOptimization";
  }
  if (blob.includes("preservation") || blob.includes("story_preservation")) {
    return "storyPreservation";
  }
  if (blob.includes("final_fact") || blob.includes("recheck")) return "finalFactRecheck";
  if (blob.includes("agentic") || blob.includes("novelos") || blob.includes("raw")) {
    return "agenticGeneration";
  }
  return "other";
}

export function inferBudgetType(
  kind: string,
  retryIndex: number,
  opts?: { forceBudgetType?: BudgetType },
): BudgetType {
  if (opts?.forceBudgetType) return opts.forceBudgetType;
  if (retryIndex > 0) return "recovery";
  const blob = kind.toLowerCase();
  if (
    blob.includes("retry") ||
    blob.includes("recover") ||
    blob.includes("timeout") ||
    blob.includes("model_timeout")
  ) {
    return "recovery";
  }
  return "normal";
}

export function createRoutingGovernanceState(input?: {
  runRouting?: RunRoutingContext;
  recoveryBudget?: RecoveryBudget;
  layeredOverrides?: Partial<LayeredBudget>;
}): RoutingGovernanceState {
  const layered = createLayeredBudget({
    ...(input?.layeredOverrides ?? {}),
    legacyRecovery: input?.recoveryBudget,
  });
  // 与既有 model hard 上限对齐：normal.maxModelCalls 跟随 PINOVEL_MODEL_CALL_HARD
  const hard = Number(process.env.PINOVEL_MODEL_CALL_HARD ?? 10);
  if (Number.isFinite(hard) && hard > 0) {
    layered.normal.maxModelCalls = Math.max(layered.normal.maxModelCalls, hard);
  }
  return {
    layeredBudget: layered,
    attemptHistory: [],
    runRouting: input?.runRouting,
    startedAtMs: Date.now(),
  };
}

/**
 * 模型调用前预扣分层预算。不足时 ok=false，调用方应阻断。
 */
export function reserveForModelCall(
  state: RoutingGovernanceState,
  input: {
    kind: string;
    route: string;
    retryIndex?: number;
    /** 显式指定预算层（同运行重试 / 外层 model_timeout 重试） */
    forceBudgetType?: BudgetType;
    estimatedLatencyMs?: number;
    estimatedInputTokens?: number;
    estimatedOutputTokens?: number;
  },
): ModelCallGovernanceReserveResult {
  const stage = inferBudgetStage(input.kind, input.route);
  const budgetType = inferBudgetType(input.kind, input.retryIndex ?? 0, {
    forceBudgetType: input.forceBudgetType,
  });
  const reserved = reserveLayeredBudget(state.layeredBudget, {
    stage,
    budgetType,
    modelCalls: 1,
    latencyMs: input.estimatedLatencyMs ?? 0,
    inputTokens: input.estimatedInputTokens ?? 0,
    outputTokens: input.estimatedOutputTokens ?? 0,
    stageAttempts: budgetType === "recovery" ? 1 : 0,
    totalAttempts: budgetType === "recovery" ? 1 : 0,
  });
  if (!reserved.ok) {
    return {
      ok: false,
      state,
      reason: reserved.reason,
      budgetType,
      stage,
    };
  }
  return {
    ok: true,
    state: { ...state, layeredBudget: reserved.budget },
    budgetType,
    stage,
  };
}

/**
 * 模型调用后结算实际 token/耗时（失败也计）。
 */
export function settleModelCall(
  state: RoutingGovernanceState,
  input: {
    stage: BudgetStage;
    budgetType: BudgetType;
    durationMs: number;
    tokenUsage?: "unknown" | { in: number; out: number };
    failed: boolean;
    route?: string;
    provider?: string;
    model?: string;
  },
): RoutingGovernanceState {
  const tokens =
    input.tokenUsage && input.tokenUsage !== "unknown"
      ? input.tokenUsage
      : { in: 0, out: 0 };
  const nextBudget = settleLayeredBudget(
    state.layeredBudget,
    {
      stage: input.stage,
      budgetType: input.budgetType,
      modelCalls: 1,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    },
    {
      stage: input.stage,
      budgetType: input.budgetType,
      modelCalls: 1,
      inputTokens: tokens.in,
      outputTokens: tokens.out,
      latencyMs: input.durationMs,
      failed: input.failed,
      route: input.route,
      provider: input.provider,
      model: input.model,
    },
  );
  return { ...state, layeredBudget: nextBudget };
}

/**
 * hardBlock 路径：记录失败策略矩阵决策与 attemptHistory。
 */
export function recordFailureStrategy(
  state: RoutingGovernanceState,
  input: {
    stage: string;
    gate?: string;
    reason: string;
    attempt: number;
    failureClassHint?: string;
  },
): {
  state: RoutingGovernanceState;
  decision: ReturnType<typeof decideFailureStrategy>;
  failureType: FailureType;
} {
  const failureType = classifyFailureType({
    gate: input.gate,
    stage: input.stage,
    reason: input.reason,
    failureClass: input.failureClassHint as never,
  });
  const decision = decideFailureStrategy({
    failureType,
    gate: input.gate,
    stage: input.stage,
    reason: input.reason,
    attempt: input.attempt,
    budget: state.layeredBudget.legacyRecovery,
    attemptHistory: state.attemptHistory,
  });
  return {
    state: {
      ...state,
      attemptHistory: decision.attemptHistory,
      layeredBudget: {
        ...state.layeredBudget,
        // 同步 decision 使用后的 legacy 快照语义：不在此处改 budget 数值
        legacyRecovery: state.layeredBudget.legacyRecovery,
      },
    },
    decision,
    failureType,
  };
}

function toObservableCalls(
  modelCalls: readonly ModelCallEntry[],
  state: RoutingGovernanceState,
): ObservableModelCall[] {
  const runId =
    state.runRouting?.orchestratorRunId ??
    `run:${state.startedAtMs}`;
  return modelCalls.map((entry, index) =>
    projectModelCallEntry(entry, {
      runId,
      stage: entry.stage ?? entry.kind ?? "unknown",
      modelVersion: entry.modelVersion ?? entry.model ?? state.runRouting?.modelVersion,
      promptBundleHash:
        entry.promptBundleHash ?? state.runRouting?.promptBundleHash ?? "bundle:unset",
      contextHash: entry.contextHash ?? state.runRouting?.contextHash ?? "context:unset",
      temperature: entry.temperature ?? state.runRouting?.temperature,
      timeout: entry.timeout ?? state.runRouting?.timeout ?? 300_000,
      retryIndex: entry.retryIndex ?? 0,
      budgetType: entry.budgetType ?? (index === 0 ? "normal" : "normal"),
      failureType: entry.failureType,
      waitMs: entry.waitMs ?? 0,
    }),
  );
}

/**
 * 编排结束（ok 或 blocked）时构建可写入 stageResults 的治理报告。
 */
export function buildGovernanceReports(
  state: RoutingGovernanceState,
  input: {
    modelCalls: readonly ModelCallEntry[];
    delivered: boolean;
    factGuardPassed?: boolean;
    storyPreservationPassed?: boolean;
    recoveryAssisted?: boolean;
    lastFailureDecision?: ReturnType<typeof decideFailureStrategy>;
    lastFailureType?: FailureType;
  },
): GovernanceReports {
  const observableCalls = toObservableCalls(input.modelCalls, state);
  // 补齐 cost / timeout 默认值，保证 assertAllCallsHaveTraceCost 在生产路径可审计
  const normalized = observableCalls.map((c) => ({
    ...c,
    timeout: c.timeout > 0 ? c.timeout : state.runRouting?.timeout ?? 300_000,
    cost:
      c.cost ??
      0,
  }));
  const latency = computeLatencyStats(normalized.map((c) => c.durationMs));
  const costReport = buildCostReport(normalized);
  const routingStability = state.runRouting
    ? buildRoutingStabilityReport({
        runId: state.runRouting.orchestratorRunId,
        expectedProvider: state.runRouting.provider,
        expectedModel: state.runRouting.model,
        calls: normalized,
      })
    : null;
  const longTail = buildLongTailReport(normalized, {
    longTailThresholdMs: state.layeredBudget.ux.longTailTimeoutMs,
    recoveryTotalDurationMs: state.layeredBudget.recovery.usedLatencyMs,
    userFinalWaitMs: Date.now() - state.startedAtMs,
  });
  const completeness = assertAllCallsHaveTraceCost(normalized);

  const observation: QualityCostObservation | null = state.runRouting
    ? {
        delivered: input.delivered,
        deliveryCost: costReport.totalCost,
        factGuardPassed: input.factGuardPassed ?? input.delivered,
        storyPreservationPassed: input.storyPreservationPassed ?? input.delivered,
        recoveryAssisted: input.recoveryAssisted ?? state.layeredBudget.recovery.usedModelCalls > 0,
        latencyMs: Date.now() - state.startedAtMs,
        longTail: state.layeredBudget.ux.longTailTriggered || longTail.longTailCalls.length > 0,
        modelVersion: state.runRouting.modelVersion,
        provider: state.runRouting.provider,
      }
    : null;
  const aggregate = observation
    ? aggregateQualityCostObservations([observation])
    : null;

  return {
    layeredBudget: {
      snapshot: snapshotLayeredBudget(state.layeredBudget),
      chapterCostBreakdown: computeChapterCostBreakdown(state.layeredBudget),
      stages: state.layeredBudget.stages,
      normal: state.layeredBudget.normal,
      recovery: state.layeredBudget.recovery,
      ux: state.layeredBudget.ux,
    },
    modelCallObservability: {
      latency,
      costReport,
      routingStability,
      longTail,
      traceCostCompleteness: completeness,
      observableCalls: normalized,
    },
    failureStrategy: {
      attemptHistory: state.attemptHistory,
      lastFailureType: input.lastFailureType,
      lastDecision: input.lastFailureDecision,
    },
    qualityCostAnalysis: {
      note: "analysis_only_not_production_score",
      aggregate,
      observation,
    },
    governanceVersion: "routing-governance-1.0",
  };
}

/**
 * 将治理报告挂到 stageResults（不可变浅合并）。
 */
export function attachGovernanceReports(
  stageResults: Record<string, unknown>,
  reports: GovernanceReports,
): void {
  stageResults.routingGovernance = reports;
  stageResults.layeredBudget = reports.layeredBudget;
  stageResults.modelCallObservability = reports.modelCallObservability;
  stageResults.failureStrategyTrace = reports.failureStrategy;
  stageResults.qualityCostAnalysis = reports.qualityCostAnalysis;
}

export function getGovernanceState(
  stageResults: Record<string, unknown>,
): RoutingGovernanceState | undefined {
  return stageResults._routingGovernanceState as RoutingGovernanceState | undefined;
}

export function setGovernanceState(
  stageResults: Record<string, unknown>,
  state: RoutingGovernanceState,
): void {
  stageResults._routingGovernanceState = state;
  // 实时快照便于 hardBlock 中途可读
  stageResults.layeredBudgetLive = {
    snapshot: snapshotLayeredBudget(state.layeredBudget),
    attemptHistoryCount: state.attemptHistory.length,
  };
}
