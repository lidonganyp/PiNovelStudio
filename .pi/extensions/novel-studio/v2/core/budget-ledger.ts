/**
 * BUDGET-LEDGER — 统一预算账本（BG-01 最小接入切片）
 *
 * 目标：成为唯一预算权威，取代 layered-budget.ts + recovery-budget.ts +
 * legacyRecovery。当前只完成主链路 reserve/settle 最小接入；生产仍双写旧账本。
 * 完整治理闭环（真实成本、价格版本、Batch 准入、队列级预留、mandatory reserve、
 * 动态预算决策、旧源收敛、Replay Matrix）见 docs/project-memory.md BUDGET-LEDGER。
 */

import { randomBytes } from 'node:crypto';
import type { BudgetStage, HardBudget, SoftBudget, BudgetReservation } from './budget-types.js';
import type { BudgetLedger, BudgetDecision } from './budget-types.js';
import {
  CURRENT_UNIT_PRICE_SCHEDULE_VERSION,
  computeActualCost,
} from './unit-price-schedule.js';

// 类型 re-export：调用方从账本模块统一取类型契约
export type { BudgetStage, BudgetLedger, BudgetReservation, BudgetDecision } from './budget-types.js';

/** 账本用量快照（reserve/settle 返回给调用方的剩余额度视图） */
export interface BudgetLedgerSnapshot {
  remainingModelCalls: number;
  remainingTokens: number;
  exhausted: boolean;
  mandatoryRemaining: number;
}

/** reserve 结果 */
export interface ReserveLedgerResult {
  ok: boolean;
  ledger: BudgetLedger;
  reason?: string;
  reservationId?: string;
  snapshot: BudgetLedgerSnapshot;
}

export class BudgetLedgerError extends Error {
  constructor(
    public code: string,
    public reason: string,
    public recoverable: boolean = false
  ) {
    super(reason);
    this.name = 'BudgetLedgerError';
  }
}

export function createBudgetLedger(
  overrides?: Partial<BudgetLedger>
): BudgetLedger {
  const base: BudgetLedger = {
    runIdentity: {
      runId: randomBytes(16).toString('hex'),
      releaseId: 'default',
      modelVersion: 'grok-4.6',
      bundleId: 'default',
      budgetGrantId: 'default',
    },
    hardBudget: {
      maxModelCalls: 25,
      maxRecoveryModelCalls: 6,
      maxInputTokens: 800_000,
      maxOutputTokens: 300_000,
      maxTotalWaitMs: 45 * 60 * 1000,
      maxSingleStageMs: 20 * 60 * 1000,
      maxProviderCost: 2.0, // USD / chapter hard cap; settle 超支记 overage，后续 reserve 阻断
      maxBatchChapters: 1,
      mandatoryReserveMin: 8, // 必经阶段最低保留
    },
    softBudget: {
      suggestedRetrievalRounds: 3,
      suggestedToolCalls: 4,
      targetContextSize: 12_000,
      targetFirstResponseMs: 45_000,
      targetChapterCost: 0.08,
      recommendedRecoveryTimes: 2,
    },
    mandatoryReserve: {
      agenticDraft: 4,
      styleOptimization: 3,
      storyPreservation: 2,
      finalFactRecheck: 2,
      completeness: 1,
    },
    optionalExploration: 6,
    recoveryReserve: {
      maxRecoveryAttempts: 3,
      maxRecoveryTokens: 100_000,
    },
    unitPriceScheduleVersion: CURRENT_UNIT_PRICE_SCHEDULE_VERSION,
    reservations: {},
    usage: {
      totalModelCalls: 0,
      totalTokensInput: 0,
      totalTokensOutput: 0,
      totalLatencyMs: 0,
      totalCost: 0,
      failedCalls: 0,
    },
    costSnapshots: [],
    decisions: [],
  };

  return {
    ...base,
    ...overrides,
    // 深隔离可变容器：reserve/settle 不得突变调用方传入的对象
    runIdentity: { ...base.runIdentity, ...overrides?.runIdentity },
    hardBudget: { ...base.hardBudget, ...overrides?.hardBudget },
    softBudget: { ...base.softBudget, ...overrides?.softBudget },
    mandatoryReserve: { ...base.mandatoryReserve, ...overrides?.mandatoryReserve },
    recoveryReserve: { ...base.recoveryReserve, ...overrides?.recoveryReserve },
    reservations: { ...(overrides?.reservations ?? {}) },
    usage: { ...base.usage, ...overrides?.usage },
    costSnapshots: [...(overrides?.costSnapshots ?? [])],
    decisions: [...(overrides?.decisions ?? [])],
  };
}

export function reserveBudget(
  ledger: BudgetLedger,
  request: {
    stage: BudgetStage;
    budgetType?: BudgetReservation['budgetType'];
    modelCalls?: number;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    reservationId?: string;
    expiresAt?: number;
    provider?: string;
  }
): ReserveLedgerResult {
  // 深拷贝隔离：reserve 不突变调用方账本（纯函数语义，并发 reserve 安全）
  const next: BudgetLedger = {
    ...ledger,
    runIdentity: { ...ledger.runIdentity },
    hardBudget: { ...ledger.hardBudget },
    softBudget: { ...ledger.softBudget },
    mandatoryReserve: { ...ledger.mandatoryReserve },
    recoveryReserve: { ...ledger.recoveryReserve },
    reservations: { ...ledger.reservations },
    usage: { ...ledger.usage },
    costSnapshots: [...ledger.costSnapshots],
    decisions: [...ledger.decisions],
  };
  const resId = request.reservationId ?? `res_${Date.now()}_${randomBytes(8).toString('hex')}`;
  const exp = request.expiresAt ?? Date.now() + 30 * 60 * 1000;

  const res: BudgetReservation = {
    reservationId: resId,
    ownerRunId: ledger.runIdentity.runId,
    stage: request.stage,
    budgetType: request.budgetType ?? 'normal',
    reservedCalls: request.modelCalls ?? 1,
    reservedTokens: (request.inputTokens ?? 0) + (request.outputTokens ?? 0),
    reservedLatencyMs: request.latencyMs ?? 0,
    reservedCost: 0,
    expiresAt: exp,
    createdAt: Date.now(),
  };

  // 原子预扣检查（简化版，实际需全账本锁定）
  const totalCalls = (next.usage.totalModelCalls || 0) + (request.modelCalls || 1);
  if (totalCalls > ledger.hardBudget.maxModelCalls) {
    return { ok: false, ledger, reason: 'hard_model_calls_exceeded', snapshot: getSnapshot(ledger) };
  }
  const totalInput = next.usage.totalTokensInput + (request.inputTokens ?? 0);
  if (totalInput > ledger.hardBudget.maxInputTokens) {
    return { ok: false, ledger, reason: 'hard_input_tokens_exceeded', snapshot: getSnapshot(ledger) };
  }
  const totalOutput = next.usage.totalTokensOutput + (request.outputTokens ?? 0);
  if (totalOutput > ledger.hardBudget.maxOutputTokens) {
    return { ok: false, ledger, reason: 'hard_output_tokens_exceeded', snapshot: getSnapshot(ledger) };
  }
  const remainingProviderCost =
    ledger.hardBudget.maxProviderCost - (ledger.usage.totalCost || 0);
  if (remainingProviderCost <= 0) {
    return { ok: false, ledger, reason: 'hard_provider_cost_exceeded', snapshot: getSnapshot(ledger) };
  }

  next.reservations[resId] = res;
  next.usage.totalModelCalls += request.modelCalls ?? 1;
  next.usage.totalLatencyMs += request.latencyMs ?? 0;

  next.decisions.push({
    timestamp: Date.now(),
    type: 'budget_reservation_created',
    reservationId: resId,
    stage: request.stage,
    reservedCalls: request.modelCalls ?? 1,
  });

  return {
    ok: true,
    ledger: next,
    reservationId: resId,
    snapshot: getSnapshot(next),
  };
}

function getSnapshot(ledger: BudgetLedger): BudgetLedgerSnapshot {
  return {
    remainingModelCalls: ledger.hardBudget.maxModelCalls - (ledger.usage.totalModelCalls || 0),
    remainingTokens: ledger.hardBudget.maxInputTokens + ledger.hardBudget.maxOutputTokens - (ledger.usage.totalTokensInput + ledger.usage.totalTokensOutput),
    exhausted: (ledger.usage.totalModelCalls || 0) >= ledger.hardBudget.maxModelCalls,
    mandatoryRemaining: calculateMandatoryRemaining(ledger),
  };
}

function calculateMandatoryRemaining(ledger: BudgetLedger) {
  const used = Object.values(ledger.reservations).reduce((sum, r) => sum + r.reservedCalls, 0);
  return ledger.hardBudget.mandatoryReserveMin - used;
}

function resolveSettledCost(
  actual: {
    inputTokens: number;
    outputTokens: number;
    cost?: number;
    provider?: string;
  },
  scheduleVersion: string,
): { actualCost: number; unitPriceScheduleVersion: string } {
  if (actual.provider) {
    return computeActualCost({
      provider: actual.provider,
      inputTokens: actual.inputTokens,
      outputTokens: actual.outputTokens,
      unitPriceScheduleVersion: scheduleVersion,
    });
  }
  return {
    actualCost: actual.cost ?? 0,
    unitPriceScheduleVersion: scheduleVersion,
  };
}

export function settleBudget(
  ledger: BudgetLedger,
  reservationId: string,
  actual: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    cost?: number;
    failed: boolean;
    provider?: string;
  }
): BudgetLedger {
  const res = ledger.reservations[reservationId];
  if (!res) return ledger;

  // 深拷贝隔离：settle 不突变调用方账本
  const next: BudgetLedger = {
    ...ledger,
    runIdentity: { ...ledger.runIdentity },
    hardBudget: { ...ledger.hardBudget },
    softBudget: { ...ledger.softBudget },
    mandatoryReserve: { ...ledger.mandatoryReserve },
    recoveryReserve: { ...ledger.recoveryReserve },
    reservations: { ...ledger.reservations },
    usage: { ...ledger.usage },
    costSnapshots: [...ledger.costSnapshots],
    decisions: [...ledger.decisions],
  };

  // 预扣转实际：calls/latency 按差额调整（reserve 已预扣），tokens/cost 结算实际值。
  // 不二次累加 reserved 量，避免 reserve+settle 双计数。
  const scheduleVersion =
    next.unitPriceScheduleVersion || CURRENT_UNIT_PRICE_SCHEDULE_VERSION;
  const priced = resolveSettledCost(actual, scheduleVersion);
  const remainingBefore = next.hardBudget.maxProviderCost - (next.usage.totalCost || 0);
  const overage = Number(Math.max(0, priced.actualCost - Math.max(0, remainingBefore)).toFixed(10));

  next.usage.totalModelCalls += actual.modelCalls - res.reservedCalls;
  next.usage.totalLatencyMs += actual.latencyMs - res.reservedLatencyMs;
  next.usage.totalTokensInput += actual.inputTokens;
  next.usage.totalTokensOutput += actual.outputTokens;
  next.usage.totalCost += priced.actualCost;
  if (actual.failed) next.usage.failedCalls += 1;

  next.costSnapshots.push({
    timestamp: Date.now(),
    stage: res.stage,
    cost: priced.actualCost,
    actualCost: priced.actualCost,
    overage,
    unitPriceScheduleVersion: priced.unitPriceScheduleVersion,
    tokensInput: actual.inputTokens,
    tokensOutput: actual.outputTokens,
    ...(actual.provider ? { provider: actual.provider } : {}),
  });

  delete next.reservations[reservationId];

  next.decisions.push({
    timestamp: Date.now(),
    type: 'budget_settled',
    reservationId,
    stage: res.stage,
    actualCalls: actual.modelCalls,
    actualCost: priced.actualCost,
  });

  return next;
}

export function getBudgetLedger(ledger: BudgetLedger) {
  return {
    ...ledger,
    snapshot: getSnapshot(ledger),
  };
}
