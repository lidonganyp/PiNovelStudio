/**
 * LAYERED-BUDGET — 分层预算与成本记录（WP-03）
 *
 * 四层预算：
 * 1. 阶段预算（agenticGeneration / retrieval / verification / style / preservation / fact recheck）
 * 2. 正常预算（normal model calls / tokens / latency）
 * 3. 恢复预算（recovery model calls / tokens / latency / attempts）
 * 4. 用户体验预算（firstResponse / maxTotalWait / longTail / batchChapter）
 *
 * 规则：
 * - 调用前预扣
 * - 调用后结算实际 token/耗时/结果
 * - 失败调用也计入成本
 * - 预算不足 → checkpoint 或 blocked
 * - 正常预算与恢复预算互不挤占
 */

import {
  createRecoveryBudget,
  reserveBudget,
  snapshotBudget,
  type ReserveBudgetRequest,
  type ReserveBudgetResult,
} from "./recovery-budget.js";
import {
  DEFAULT_RECOVERY_BUDGET,
  type RecoveryBudget,
  type RecoveryBudgetSnapshot,
} from "./recovery-types.js";

export type BudgetStage =
  | "agenticGeneration"
  | "agenticRetrieval"
  | "agenticVerification"
  | "authorStyleOptimization"
  | "storyPreservation"
  | "finalFactRecheck"
  | "other";

export type BudgetType = "normal" | "recovery";

export interface StageBudgetLimits {
  maxModelCalls: number;
  maxLatencyMs: number;
}

export interface NormalBudget {
  maxModelCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxLatencyMs: number;
  usedModelCalls: number;
  usedInputTokens: number;
  usedOutputTokens: number;
  usedLatencyMs: number;
}

export interface RecoveryLayerBudget {
  maxModelCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxLatencyMs: number;
  maxStageAttempts: number;
  maxTotalAttempts: number;
  usedModelCalls: number;
  usedInputTokens: number;
  usedOutputTokens: number;
  usedLatencyMs: number;
  usedStageAttempts: number;
  usedTotalAttempts: number;
}

export interface UxBudget {
  firstResponseTimeoutMs: number;
  maxTotalWaitMs: number;
  longTailTimeoutMs: number;
  batchChapterTimeoutMs: number;
  usedWallMs: number;
  firstResponseMs?: number;
  longTailTriggered: boolean;
}

export interface LayeredBudget {
  stages: Record<BudgetStage, { usedModelCalls: number; usedLatencyMs: number; limits: StageBudgetLimits }>;
  normal: NormalBudget;
  recovery: RecoveryLayerBudget;
  ux: UxBudget;
  /** 兼容既有 RecoveryBudget 快照 */
  legacyRecovery: RecoveryBudget;
}

export interface BudgetReservationRequest {
  stage: BudgetStage;
  budgetType: BudgetType;
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  stageAttempts?: number;
  totalAttempts?: number;
}

export interface BudgetSettlement {
  stage: BudgetStage;
  budgetType: BudgetType;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  failed: boolean;
  route?: string;
  provider?: string;
  model?: string;
}

export interface LayeredBudgetReserveResult {
  ok: boolean;
  budget: LayeredBudget;
  reason?: string;
  snapshot: LayeredBudgetSnapshot;
}

export interface LayeredBudgetSnapshot {
  normalRemainingCalls: number;
  recoveryRemainingCalls: number;
  remainingTotalWaitMs: number;
  exhausted: boolean;
  exhaustedReasons: string[];
  legacy: RecoveryBudgetSnapshot;
}

const DEFAULT_STAGE_LIMITS: StageBudgetLimits = {
  maxModelCalls: 6,
  maxLatencyMs: 20 * 60 * 1000,
};

export const DEFAULT_LAYERED_BUDGET: LayeredBudget = {
  stages: {
    agenticGeneration: { usedModelCalls: 0, usedLatencyMs: 0, limits: { ...DEFAULT_STAGE_LIMITS } },
    agenticRetrieval: { usedModelCalls: 0, usedLatencyMs: 0, limits: { maxModelCalls: 4, maxLatencyMs: 10 * 60 * 1000 } },
    agenticVerification: { usedModelCalls: 0, usedLatencyMs: 0, limits: { maxModelCalls: 3, maxLatencyMs: 10 * 60 * 1000 } },
    authorStyleOptimization: { usedModelCalls: 0, usedLatencyMs: 0, limits: { maxModelCalls: 3, maxLatencyMs: 15 * 60 * 1000 } },
    storyPreservation: { usedModelCalls: 0, usedLatencyMs: 0, limits: { maxModelCalls: 2, maxLatencyMs: 5 * 60 * 1000 } },
    finalFactRecheck: { usedModelCalls: 0, usedLatencyMs: 0, limits: { maxModelCalls: 2, maxLatencyMs: 5 * 60 * 1000 } },
    other: { usedModelCalls: 0, usedLatencyMs: 0, limits: { ...DEFAULT_STAGE_LIMITS } },
  },
  normal: {
    maxModelCalls: 10,
    maxInputTokens: 500_000,
    maxOutputTokens: 200_000,
    maxLatencyMs: 25 * 60 * 1000,
    usedModelCalls: 0,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    usedLatencyMs: 0,
  },
  recovery: {
    maxModelCalls: 4,
    maxInputTokens: 200_000,
    maxOutputTokens: 80_000,
    maxLatencyMs: 15 * 60 * 1000,
    maxStageAttempts: 2,
    maxTotalAttempts: 4,
    usedModelCalls: 0,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    usedLatencyMs: 0,
    usedStageAttempts: 0,
    usedTotalAttempts: 0,
  },
  ux: {
    firstResponseTimeoutMs: 120_000,
    maxTotalWaitMs: 30 * 60 * 1000,
    longTailTimeoutMs: 20 * 60 * 1000,
    batchChapterTimeoutMs: 45 * 60 * 1000,
    usedWallMs: 0,
    longTailTriggered: false,
  },
  legacyRecovery: { ...DEFAULT_RECOVERY_BUDGET },
};

function cloneBudget(budget: LayeredBudget): LayeredBudget {
  return {
    stages: Object.fromEntries(
      Object.entries(budget.stages).map(([k, v]) => [
        k,
        {
          usedModelCalls: v.usedModelCalls,
          usedLatencyMs: v.usedLatencyMs,
          limits: { ...v.limits },
        },
      ]),
    ) as LayeredBudget["stages"],
    normal: { ...budget.normal },
    recovery: { ...budget.recovery },
    ux: { ...budget.ux },
    legacyRecovery: { ...budget.legacyRecovery },
  };
}

export function createLayeredBudget(overrides?: Partial<LayeredBudget>): LayeredBudget {
  const base = cloneBudget(DEFAULT_LAYERED_BUDGET);
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    stages: { ...base.stages, ...(overrides.stages ?? {}) },
    normal: { ...base.normal, ...(overrides.normal ?? {}) },
    recovery: { ...base.recovery, ...(overrides.recovery ?? {}) },
    ux: { ...base.ux, ...(overrides.ux ?? {}) },
    legacyRecovery: createRecoveryBudget(overrides.legacyRecovery),
  };
}

export function snapshotLayeredBudget(budget: LayeredBudget): LayeredBudgetSnapshot {
  const normalRemainingCalls = Math.max(0, budget.normal.maxModelCalls - budget.normal.usedModelCalls);
  const recoveryRemainingCalls = Math.max(0, budget.recovery.maxModelCalls - budget.recovery.usedModelCalls);
  const remainingTotalWaitMs = Math.max(0, budget.ux.maxTotalWaitMs - budget.ux.usedWallMs);
  const exhaustedReasons: string[] = [];
  if (normalRemainingCalls <= 0) exhaustedReasons.push("normal_model_calls");
  if (recoveryRemainingCalls <= 0) exhaustedReasons.push("recovery_model_calls");
  if (remainingTotalWaitMs <= 0) exhaustedReasons.push("ux_total_wait");
  if (budget.normal.usedLatencyMs >= budget.normal.maxLatencyMs) exhaustedReasons.push("normal_latency");
  if (budget.recovery.usedLatencyMs >= budget.recovery.maxLatencyMs) exhaustedReasons.push("recovery_latency");
  return {
    normalRemainingCalls,
    recoveryRemainingCalls,
    remainingTotalWaitMs,
    exhausted: exhaustedReasons.length > 0,
    exhaustedReasons,
    legacy: snapshotBudget(budget.legacyRecovery),
  };
}

/**
 * 调用前预扣。正常与恢复互不挤占：recovery 请求只扣 recovery 层。
 */
export function reserveLayeredBudget(
  budget: LayeredBudget,
  request: BudgetReservationRequest,
): LayeredBudgetReserveResult {
  const next = cloneBudget(budget);
  const modelCalls = request.modelCalls ?? 1;
  const inputTokens = request.inputTokens ?? 0;
  const outputTokens = request.outputTokens ?? 0;
  const latencyMs = request.latencyMs ?? 0;
  const stageAttempts = request.stageAttempts ?? 0;
  const totalAttempts = request.totalAttempts ?? 0;

  const stage = next.stages[request.stage] ?? next.stages.other;
  if (stage.usedModelCalls + modelCalls > stage.limits.maxModelCalls) {
    return {
      ok: false,
      budget: cloneBudget(budget),
      reason: `stage_${request.stage}_model_calls_exhausted`,
      snapshot: snapshotLayeredBudget(budget),
    };
  }
  if (stage.usedLatencyMs + latencyMs > stage.limits.maxLatencyMs) {
    return {
      ok: false,
      budget: cloneBudget(budget),
      reason: `stage_${request.stage}_latency_exhausted`,
      snapshot: snapshotLayeredBudget(budget),
    };
  }

  if (next.ux.usedWallMs + latencyMs > next.ux.maxTotalWaitMs) {
    return {
      ok: false,
      budget: cloneBudget(budget),
      reason: "ux_total_wait_exhausted",
      snapshot: snapshotLayeredBudget(budget),
    };
  }

  if (request.budgetType === "normal") {
    if (next.normal.usedModelCalls + modelCalls > next.normal.maxModelCalls) {
      return {
        ok: false,
        budget: cloneBudget(budget),
        reason: "normal_model_calls_exhausted",
        snapshot: snapshotLayeredBudget(budget),
      };
    }
    if (next.normal.usedInputTokens + inputTokens > next.normal.maxInputTokens) {
      return {
        ok: false,
        budget: cloneBudget(budget),
        reason: "normal_input_tokens_exhausted",
        snapshot: snapshotLayeredBudget(budget),
      };
    }
    if (next.normal.usedOutputTokens + outputTokens > next.normal.maxOutputTokens) {
      return {
        ok: false,
        budget: cloneBudget(budget),
        reason: "normal_output_tokens_exhausted",
        snapshot: snapshotLayeredBudget(budget),
      };
    }
    if (next.normal.usedLatencyMs + latencyMs > next.normal.maxLatencyMs) {
      return {
        ok: false,
        budget: cloneBudget(budget),
        reason: "normal_latency_exhausted",
        snapshot: snapshotLayeredBudget(budget),
      };
    }
    next.normal.usedModelCalls += modelCalls;
    next.normal.usedInputTokens += inputTokens;
    next.normal.usedOutputTokens += outputTokens;
    next.normal.usedLatencyMs += latencyMs;
  } else {
    if (next.recovery.usedModelCalls + modelCalls > next.recovery.maxModelCalls) {
      return {
        ok: false,
        budget: cloneBudget(budget),
        reason: "recovery_model_calls_exhausted",
        snapshot: snapshotLayeredBudget(budget),
      };
    }
    if (next.recovery.usedInputTokens + inputTokens > next.recovery.maxInputTokens) {
      return {
        ok: false,
        budget: cloneBudget(budget),
        reason: "recovery_input_tokens_exhausted",
        snapshot: snapshotLayeredBudget(budget),
      };
    }
    if (next.recovery.usedOutputTokens + outputTokens > next.recovery.maxOutputTokens) {
      return {
        ok: false,
        budget: cloneBudget(budget),
        reason: "recovery_output_tokens_exhausted",
        snapshot: snapshotLayeredBudget(budget),
      };
    }
    if (next.recovery.usedLatencyMs + latencyMs > next.recovery.maxLatencyMs) {
      return {
        ok: false,
        budget: cloneBudget(budget),
        reason: "recovery_latency_exhausted",
        snapshot: snapshotLayeredBudget(budget),
      };
    }
    if (next.recovery.usedStageAttempts + stageAttempts > next.recovery.maxStageAttempts) {
      return {
        ok: false,
        budget: cloneBudget(budget),
        reason: "recovery_stage_attempts_exhausted",
        snapshot: snapshotLayeredBudget(budget),
      };
    }
    if (next.recovery.usedTotalAttempts + totalAttempts > next.recovery.maxTotalAttempts) {
      return {
        ok: false,
        budget: cloneBudget(budget),
        reason: "recovery_total_attempts_exhausted",
        snapshot: snapshotLayeredBudget(budget),
      };
    }
    next.recovery.usedModelCalls += modelCalls;
    next.recovery.usedInputTokens += inputTokens;
    next.recovery.usedOutputTokens += outputTokens;
    next.recovery.usedLatencyMs += latencyMs;
    next.recovery.usedStageAttempts += stageAttempts;
    next.recovery.usedTotalAttempts += totalAttempts;
  }

  stage.usedModelCalls += modelCalls;
  stage.usedLatencyMs += latencyMs;
  next.stages[request.stage] = stage;
  next.ux.usedWallMs += latencyMs;
  if (next.ux.usedWallMs >= next.ux.longTailTimeoutMs) {
    next.ux.longTailTriggered = true;
  }

  // 同步 legacy recovery budget（兼容既有 recovery-decision-engine）
  const legacyReq: ReserveBudgetRequest = {
    modelCalls: request.budgetType === "normal" ? modelCalls : modelCalls,
    recoveryModelCalls: request.budgetType === "recovery" ? modelCalls : 0,
    latencyMs,
    stageAttempts,
    totalAttempts,
  };
  const legacyResult: ReserveBudgetResult = reserveBudget(next.legacyRecovery, legacyReq);
  if (!legacyResult.ok) {
    // legacy 与分层双重要求：任一不足都阻断
    return {
      ok: false,
      budget: cloneBudget(budget),
      reason: legacyResult.reason ?? "legacy_recovery_budget_exhausted",
      snapshot: snapshotLayeredBudget(budget),
    };
  }
  next.legacyRecovery = legacyResult.budget;

  return {
    ok: true,
    budget: next,
    snapshot: snapshotLayeredBudget(next),
  };
}

/**
 * 调用后结算实际用量。
 * 预扣时可能用估算值；结算用实际 token/耗时，失败也计入。
 * 若实际 > 预扣，追加差额；不足不退还（保守成本）。
 */
export function settleLayeredBudget(
  budget: LayeredBudget,
  reserved: BudgetReservationRequest,
  actual: BudgetSettlement,
): LayeredBudget {
  const deltaCalls = Math.max(0, actual.modelCalls - (reserved.modelCalls ?? 1));
  const deltaIn = Math.max(0, actual.inputTokens - (reserved.inputTokens ?? 0));
  const deltaOut = Math.max(0, actual.outputTokens - (reserved.outputTokens ?? 0));
  const deltaLatency = Math.max(0, actual.latencyMs - (reserved.latencyMs ?? 0));

  if (deltaCalls === 0 && deltaIn === 0 && deltaOut === 0 && deltaLatency === 0) {
    const next = cloneBudget(budget);
    if (actual.failed) {
      // 失败调用已在预扣中计数；标记 UX first response 若尚未设置
      if (next.ux.firstResponseMs === undefined) {
        next.ux.firstResponseMs = actual.latencyMs;
      }
    } else if (next.ux.firstResponseMs === undefined) {
      next.ux.firstResponseMs = actual.latencyMs;
    }
    return next;
  }

  const topUp = reserveLayeredBudget(budget, {
    stage: actual.stage,
    budgetType: actual.budgetType,
    modelCalls: deltaCalls,
    inputTokens: deltaIn,
    outputTokens: deltaOut,
    latencyMs: deltaLatency,
  });
  // 结算超支时仍写入实际（成本真实性优先），但 reason 可由调用方读 snapshot
  const next = topUp.ok ? topUp.budget : cloneBudget(budget);
  if (!topUp.ok) {
    // 强制记入实际成本，即使超预算（失败也计）
    if (actual.budgetType === "normal") {
      next.normal.usedModelCalls += deltaCalls;
      next.normal.usedInputTokens += deltaIn;
      next.normal.usedOutputTokens += deltaOut;
      next.normal.usedLatencyMs += deltaLatency;
    } else {
      next.recovery.usedModelCalls += deltaCalls;
      next.recovery.usedInputTokens += deltaIn;
      next.recovery.usedOutputTokens += deltaOut;
      next.recovery.usedLatencyMs += deltaLatency;
    }
    next.ux.usedWallMs += deltaLatency;
  }
  if (next.ux.firstResponseMs === undefined) {
    next.ux.firstResponseMs = actual.latencyMs;
  }
  if (next.ux.usedWallMs >= next.ux.longTailTimeoutMs) {
    next.ux.longTailTriggered = true;
  }
  return next;
}

export function canAffordModelCall(
  budget: LayeredBudget,
  budgetType: BudgetType,
  stage: BudgetStage = "other",
): boolean {
  const result = reserveLayeredBudget(budget, {
    stage,
    budgetType,
    modelCalls: 1,
    latencyMs: 0,
  });
  return result.ok;
}

/** 每章成功交付成本 vs 自动恢复后成功成本 */
export interface ChapterCostBreakdown {
  successDeliveryCost: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
  recoveryAssistedCost: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
  totalCost: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
  longTailTriggered: boolean;
}

export function computeChapterCostBreakdown(budget: LayeredBudget): ChapterCostBreakdown {
  const success = {
    modelCalls: budget.normal.usedModelCalls,
    inputTokens: budget.normal.usedInputTokens,
    outputTokens: budget.normal.usedOutputTokens,
    latencyMs: budget.normal.usedLatencyMs,
  };
  const recovery = {
    modelCalls: budget.recovery.usedModelCalls,
    inputTokens: budget.recovery.usedInputTokens,
    outputTokens: budget.recovery.usedOutputTokens,
    latencyMs: budget.recovery.usedLatencyMs,
  };
  return {
    successDeliveryCost: success,
    recoveryAssistedCost: recovery,
    totalCost: {
      modelCalls: success.modelCalls + recovery.modelCalls,
      inputTokens: success.inputTokens + recovery.inputTokens,
      outputTokens: success.outputTokens + recovery.outputTokens,
      latencyMs: success.latencyMs + recovery.latencyMs,
    },
    longTailTriggered: budget.ux.longTailTriggered,
  };
}
