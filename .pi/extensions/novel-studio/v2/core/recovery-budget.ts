/**
 * RECOVERY-BUDGET — 章节级全局恢复预算（P2）
 *
 * 规则：
 * - 每次重试前预扣预算
 * - 预算不足时不得发起模型或工具调用
 * - 阶段预算与章节总预算同时生效
 * - 总预算不因阶段切换而重置
 */

import {
  DEFAULT_RECOVERY_BUDGET,
  type RecoveryBudget,
  type RecoveryBudgetSnapshot,
} from "./recovery-types.js";

export function createRecoveryBudget(
  overrides?: Partial<RecoveryBudget>,
): RecoveryBudget {
  return {
    ...DEFAULT_RECOVERY_BUDGET,
    ...overrides,
    usedStageAttempts: overrides?.usedStageAttempts ?? 0,
    usedTotalAttempts: overrides?.usedTotalAttempts ?? 0,
    usedModelCalls: overrides?.usedModelCalls ?? 0,
    usedRecoveryModelCalls: overrides?.usedRecoveryModelCalls ?? 0,
    usedLatencyMs: overrides?.usedLatencyMs ?? 0,
  };
}

export function snapshotBudget(budget: RecoveryBudget): RecoveryBudgetSnapshot {
  const remainingStageAttempts = Math.max(
    0,
    budget.maxStageAttempts - budget.usedStageAttempts,
  );
  const remainingTotalAttempts = Math.max(
    0,
    budget.maxTotalAttempts - budget.usedTotalAttempts,
  );
  const remainingModelCalls = Math.max(
    0,
    budget.maxModelCalls - budget.usedModelCalls,
  );
  const remainingRecoveryModelCalls = Math.max(
    0,
    budget.maxRecoveryModelCalls - budget.usedRecoveryModelCalls,
  );
  const remainingLatencyMs = Math.max(
    0,
    budget.maxLatencyMs - budget.usedLatencyMs,
  );
  const exhaustedReasons: string[] = [];
  if (remainingStageAttempts <= 0) exhaustedReasons.push("stage_attempts");
  if (remainingTotalAttempts <= 0) exhaustedReasons.push("total_attempts");
  if (remainingModelCalls <= 0) exhaustedReasons.push("model_calls");
  if (remainingRecoveryModelCalls <= 0) {
    exhaustedReasons.push("recovery_model_calls");
  }
  if (remainingLatencyMs <= 0) exhaustedReasons.push("latency");
  return {
    remainingStageAttempts,
    remainingTotalAttempts,
    remainingModelCalls,
    remainingRecoveryModelCalls,
    remainingLatencyMs,
    exhausted: exhaustedReasons.length > 0,
    exhaustedReasons,
  };
}

export interface ReserveBudgetRequest {
  stageAttempts?: number;
  totalAttempts?: number;
  modelCalls?: number;
  recoveryModelCalls?: number;
  latencyMs?: number;
}

export interface ReserveBudgetResult {
  ok: boolean;
  budget: RecoveryBudget;
  reason?: string;
  snapshot: RecoveryBudgetSnapshot;
}

/**
 * 预扣预算。不足时 ok=false，不修改原 budget（返回原对象拷贝）。
 */
export function reserveBudget(
  budget: RecoveryBudget,
  request: ReserveBudgetRequest,
): ReserveBudgetResult {
  const next: RecoveryBudget = { ...budget };
  const stage = request.stageAttempts ?? 0;
  const total = request.totalAttempts ?? 0;
  const models = request.modelCalls ?? 0;
  const recoveryModels = request.recoveryModelCalls ?? 0;
  const latency = request.latencyMs ?? 0;

  if (next.usedStageAttempts + stage > next.maxStageAttempts) {
    return {
      ok: false,
      budget: { ...budget },
      reason: "stage_attempts_exhausted",
      snapshot: snapshotBudget(budget),
    };
  }
  if (next.usedTotalAttempts + total > next.maxTotalAttempts) {
    return {
      ok: false,
      budget: { ...budget },
      reason: "total_attempts_exhausted",
      snapshot: snapshotBudget(budget),
    };
  }
  if (next.usedModelCalls + models > next.maxModelCalls) {
    return {
      ok: false,
      budget: { ...budget },
      reason: "model_calls_exhausted",
      snapshot: snapshotBudget(budget),
    };
  }
  if (next.usedRecoveryModelCalls + recoveryModels > next.maxRecoveryModelCalls) {
    return {
      ok: false,
      budget: { ...budget },
      reason: "recovery_model_calls_exhausted",
      snapshot: snapshotBudget(budget),
    };
  }
  if (next.usedLatencyMs + latency > next.maxLatencyMs) {
    return {
      ok: false,
      budget: { ...budget },
      reason: "latency_exhausted",
      snapshot: snapshotBudget(budget),
    };
  }

  next.usedStageAttempts += stage;
  next.usedTotalAttempts += total;
  next.usedModelCalls += models;
  next.usedRecoveryModelCalls += recoveryModels;
  next.usedLatencyMs += latency;
  return {
    ok: true,
    budget: next,
    snapshot: snapshotBudget(next),
  };
}

/** 阶段切换时重置 usedStageAttempts，但保留章节总预算 */
export function resetStageAttempts(budget: RecoveryBudget): RecoveryBudget {
  return { ...budget, usedStageAttempts: 0 };
}

/** 是否还能发起一次恢复重试（至少 1 total + 1 recovery model） */
export function canAffordRetry(budget: RecoveryBudget): boolean {
  const snap = snapshotBudget(budget);
  return (
    snap.remainingTotalAttempts > 0 &&
    snap.remainingStageAttempts > 0 &&
    snap.remainingRecoveryModelCalls > 0 &&
    snap.remainingModelCalls > 0 &&
    snap.remainingLatencyMs > 0
  );
}
