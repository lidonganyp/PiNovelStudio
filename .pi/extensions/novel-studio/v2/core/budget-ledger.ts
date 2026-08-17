/**
 * BUDGET-LEDGER — 统一预算账本
 *
 * 生产准入权威：reserve / settle / release / expire / Batch 准入 /
 * mandatory lock / 动态追加决策。layered-budget 仅作兼容投影，不得单独阻断。
 */

import { randomBytes } from 'node:crypto';
import type {
  BudgetStage,
  BudgetReservation,
  BudgetLedger,
  BudgetDecision,
  BudgetAction,
  ExhaustionReason,
  UserBudgetExtension,
  MandatoryReserve,
} from './budget-types.js';
import {
  CURRENT_UNIT_PRICE_SCHEDULE_VERSION,
  computeActualCost,
} from './unit-price-schedule.js';

export type {
  BudgetStage,
  BudgetLedger,
  BudgetReservation,
  BudgetDecision,
  BudgetAction,
  ExhaustionReason,
  UserBudgetExtension,
} from './budget-types.js';

const MANDATORY_STAGES: readonly (keyof MandatoryReserve)[] = [
  'agenticDraft',
  'styleOptimization',
  'storyPreservation',
  'finalFactRecheck',
  'completeness',
];

export interface BudgetLedgerSnapshot {
  remainingModelCalls: number;
  remainingTokens: number;
  remainingProviderCost: number;
  remainingWaitMs: number;
  remainingRecoveryCalls: number;
  remainingBatchChapters: number;
  exhausted: boolean;
  mandatoryRemaining: number;
}

export interface ReserveLedgerResult {
  ok: boolean;
  ledger: BudgetLedger;
  reason?: ExhaustionReason | string;
  reservationId?: string;
  snapshot: BudgetLedgerSnapshot;
}

export interface BudgetDecisionResult {
  action: BudgetAction;
  reason: ExhaustionReason | string;
  ledger: BudgetLedger;
}

export class BudgetLedgerError extends Error {
  constructor(
    public code: string,
    public reason: string,
    public recoverable: boolean = false,
  ) {
    super(reason);
    this.name = 'BudgetLedgerError';
  }
}

function cloneLedger(ledger: BudgetLedger): BudgetLedger {
  return {
    ...ledger,
    runIdentity: { ...ledger.runIdentity },
    hardBudget: { ...ledger.hardBudget },
    softBudget: { ...ledger.softBudget },
    mandatoryReserve: { ...ledger.mandatoryReserve },
    recoveryReserve: { ...ledger.recoveryReserve },
    userExtension: ledger.userExtension ? { ...ledger.userExtension } : undefined,
    reservations: { ...ledger.reservations },
    usage: { ...ledger.usage },
    costSnapshots: [...ledger.costSnapshots],
    decisions: [...ledger.decisions],
  };
}

export function createBudgetLedger(
  overrides?: Partial<Omit<BudgetLedger, "hardBudget" | "softBudget" | "mandatoryReserve" | "recoveryReserve" | "usage" | "runIdentity">> & {
    runIdentity?: Partial<BudgetLedger["runIdentity"]>;
    hardBudget?: Partial<BudgetLedger["hardBudget"]>;
    softBudget?: Partial<BudgetLedger["softBudget"]>;
    mandatoryReserve?: Partial<BudgetLedger["mandatoryReserve"]>;
    recoveryReserve?: Partial<BudgetLedger["recoveryReserve"]>;
    usage?: Partial<BudgetLedger["usage"]>;
  },
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
      maxProviderCost: 2.0,
      maxBatchChapters: 1,
      mandatoryReserveMin: 8,
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
      recoveryModelCalls: 0,
      batchChaptersUsed: 0,
      lastAdmittedChapter: undefined,
      providerUsage: {},
    },
    costSnapshots: [],
    decisions: [],
  };

  return {
    ...base,
    ...overrides,
    runIdentity: { ...base.runIdentity, ...overrides?.runIdentity },
    hardBudget: { ...base.hardBudget, ...overrides?.hardBudget },
    softBudget: { ...base.softBudget, ...overrides?.softBudget },
    mandatoryReserve: { ...base.mandatoryReserve, ...overrides?.mandatoryReserve },
    recoveryReserve: { ...base.recoveryReserve, ...overrides?.recoveryReserve },
    userExtension: overrides?.userExtension ?? base.userExtension,
    reservations: { ...(overrides?.reservations ?? {}) },
    usage: { ...base.usage, ...overrides?.usage },
    costSnapshots: [...(overrides?.costSnapshots ?? [])],
    decisions: [...(overrides?.decisions ?? [])],
  };
}

function isMandatoryStage(stage: BudgetStage): stage is keyof MandatoryReserve {
  return (MANDATORY_STAGES as readonly string[]).includes(stage);
}

function consumedCallsForStage(ledger: BudgetLedger, stage: BudgetStage): number {
  const reserved = Object.values(ledger.reservations)
    .filter((r) => r.stage === stage)
    .reduce((sum, r) => sum + r.reservedCalls, 0);
  const settled = ledger.decisions
    .filter((d) => d.type === 'budget_settled' && d.stage === stage)
    .reduce((sum, d) => sum + (d.actualCalls ?? 0), 0);
  return reserved + settled;
}

export function unusedMandatoryCalls(ledger: BudgetLedger): number {
  let unused = 0;
  for (const stage of MANDATORY_STAGES) {
    const quota = ledger.mandatoryReserve[stage] ?? 0;
    unused += Math.max(0, quota - consumedCallsForStage(ledger, stage));
  }
  return unused;
}

function recoveryReservedCalls(ledger: BudgetLedger): number {
  return Object.values(ledger.reservations)
    .filter((r) => r.budgetType === 'recovery')
    .reduce((sum, r) => sum + r.reservedCalls, 0);
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
    providerQuota?: { maxCalls: number; maxCost: number };
  },
): ReserveLedgerResult {
  const next = cloneLedger(ledger);
  const requestedCalls = request.modelCalls ?? 1;
  const budgetType = request.budgetType ?? 'normal';
  const resId = request.reservationId ?? `res_${Date.now()}_${randomBytes(8).toString('hex')}`;
  const exp = request.expiresAt ?? Date.now() + 30 * 60 * 1000;

  const totalCalls = (next.usage.totalModelCalls || 0) + requestedCalls;
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
  const remainingProviderCost = ledger.hardBudget.maxProviderCost - (ledger.usage.totalCost || 0);
  if (remainingProviderCost <= 0) {
    return { ok: false, ledger, reason: 'hard_provider_cost_exceeded', snapshot: getSnapshot(ledger) };
  }
  if ((next.usage.totalLatencyMs || 0) + (request.latencyMs ?? 0) > ledger.hardBudget.maxTotalWaitMs) {
    return { ok: false, ledger, reason: 'hard_wait_exceeded', snapshot: getSnapshot(ledger) };
  }
  if (budgetType === 'recovery') {
    const recoveryUsed = (next.usage.recoveryModelCalls || 0) + recoveryReservedCalls(next) + requestedCalls;
    if (recoveryUsed > ledger.hardBudget.maxRecoveryModelCalls) {
      return { ok: false, ledger, reason: 'recovery_exhausted', snapshot: getSnapshot(ledger) };
    }
  }
  if (request.provider && request.providerQuota) {
    const used = ledger.usage.providerUsage?.[request.provider];
    const usedCalls = used?.calls ?? 0;
    const usedCost = used?.cost ?? 0;
    if (usedCalls + requestedCalls > request.providerQuota.maxCalls || usedCost > request.providerQuota.maxCost) {
      return { ok: false, ledger, reason: 'provider_quota_exceeded', snapshot: getSnapshot(ledger) };
    }
  }
  if (!isMandatoryStage(request.stage)) {
    const remainingAfter = ledger.hardBudget.maxModelCalls - totalCalls;
    if (remainingAfter < unusedMandatoryCalls(ledger)) {
      return { ok: false, ledger, reason: 'mandatory_reserve_depleted', snapshot: getSnapshot(ledger) };
    }
  }

  const res: BudgetReservation = {
    reservationId: resId,
    ownerRunId: ledger.runIdentity.runId,
    stage: request.stage,
    budgetType,
    reservedCalls: requestedCalls,
    reservedTokens: (request.inputTokens ?? 0) + (request.outputTokens ?? 0),
    reservedLatencyMs: request.latencyMs ?? 0,
    reservedCost: 0,
    expiresAt: exp,
    createdAt: Date.now(),
  };

  next.reservations[resId] = res;
  next.usage.totalModelCalls += requestedCalls;
  next.usage.totalLatencyMs += request.latencyMs ?? 0;
  if (budgetType === 'recovery') {
    next.usage.recoveryModelCalls = (next.usage.recoveryModelCalls || 0) + requestedCalls;
  }

  next.decisions.push({
    timestamp: Date.now(),
    type: 'budget_reservation_created',
    reservationId: resId,
    stage: request.stage,
    reservedCalls: requestedCalls,
  });

  return {
    ok: true,
    ledger: next,
    reservationId: resId,
    snapshot: getSnapshot(next),
  };
}

function refundReservation(next: BudgetLedger, res: BudgetReservation): void {
  next.usage.totalModelCalls = Math.max(0, next.usage.totalModelCalls - res.reservedCalls);
  next.usage.totalLatencyMs = Math.max(0, next.usage.totalLatencyMs - res.reservedLatencyMs);
  if (res.budgetType === 'recovery') {
    next.usage.recoveryModelCalls = Math.max(0, (next.usage.recoveryModelCalls || 0) - res.reservedCalls);
  }
}

export function releaseBudget(ledger: BudgetLedger, reservationId: string): BudgetLedger {
  const res = ledger.reservations[reservationId];
  if (!res) return ledger;
  const next = cloneLedger(ledger);
  refundReservation(next, res);
  delete next.reservations[reservationId];
  next.decisions.push({
    timestamp: Date.now(),
    type: 'budget_released',
    reservationId,
    stage: res.stage,
    reservedCalls: res.reservedCalls,
  });
  return next;
}

export function expireReservations(ledger: BudgetLedger, now: number = Date.now()): BudgetLedger {
  const expired = Object.values(ledger.reservations).filter((r) => r.expiresAt <= now);
  if (expired.length === 0) return ledger;
  let next = cloneLedger(ledger);
  for (const res of expired) {
    refundReservation(next, res);
    delete next.reservations[res.reservationId];
    next.decisions.push({
      timestamp: now,
      type: 'budget_expired',
      reservationId: res.reservationId,
      stage: res.stage,
      reservedCalls: res.reservedCalls,
    });
  }
  return next;
}

export function admitBatchChapter(
  ledger: BudgetLedger,
  opts?: { chapterNumber?: number },
): ReserveLedgerResult {
  const live = expireReservations(ledger);
  const snap = getSnapshot(live);
  const retrySameChapter =
    typeof opts?.chapterNumber === "number" &&
    live.usage.lastAdmittedChapter === opts.chapterNumber;
  if (!retrySameChapter && snap.remainingBatchChapters <= 0) {
    return { ok: false, ledger: live, reason: 'batch_chapters_remaining_zero', snapshot: snap };
  }
  if (snap.remainingModelCalls < unusedMandatoryCalls(live)) {
    return { ok: false, ledger: live, reason: 'mandatory_reserve_depleted', snapshot: snap };
  }
  if (snap.remainingProviderCost <= 0) {
    return { ok: false, ledger: live, reason: 'hard_provider_cost_exceeded', snapshot: snap };
  }
  if (snap.remainingWaitMs <= 0) {
    return { ok: false, ledger: live, reason: 'hard_wait_exceeded', snapshot: snap };
  }
  if (snap.remainingRecoveryCalls <= 0) {
    return { ok: false, ledger: live, reason: 'recovery_exhausted', snapshot: snap };
  }
  const next = cloneLedger(live);
  if (!retrySameChapter) {
    next.usage.batchChaptersUsed = (next.usage.batchChaptersUsed || 0) + 1;
  }
  if (typeof opts?.chapterNumber === "number") {
    next.usage.lastAdmittedChapter = opts.chapterNumber;
  }
  next.decisions.push({
    timestamp: Date.now(),
    type: 'budget_batch_admitted',
    reason: `chapter_slot_${next.usage.batchChaptersUsed}`,
  });
  return { ok: true, ledger: next, snapshot: getSnapshot(next) };
}

export function requestAdditionalBudget(
  ledger: BudgetLedger,
  input: { reason: string; extraCalls?: number; extraCost?: number; extraRecoveryCalls?: number },
): BudgetDecisionResult {
  const next = cloneLedger(ledger);
  next.decisions.push({
    timestamp: Date.now(),
    type: 'budget_request_additional',
    reason: input.reason,
    action: 'request_additional',
    reservedCalls: input.extraCalls,
    actualCost: input.extraCost,
  });
  return { action: 'request_additional', reason: input.reason, ledger: next };
}

export function applyUserExtension(
  ledger: BudgetLedger,
  extension: UserBudgetExtension,
): BudgetLedger {
  const next = cloneLedger(ledger);
  next.hardBudget.maxModelCalls += extension.extraCalls;
  next.hardBudget.maxProviderCost += extension.extraCost;
  next.hardBudget.maxRecoveryModelCalls += extension.extraRecoveryCalls;
  next.userExtension = { ...extension };
  next.decisions.push({
    timestamp: Date.now(),
    type: 'budget_user_extension',
    reason: extension.reason,
    action: 'continue',
    reservedCalls: extension.extraCalls,
    actualCost: extension.extraCost,
  });
  return next;
}

export function evaluateBudgetDecision(
  ledger: BudgetLedger,
  ctx?: { noProgress?: boolean },
): BudgetDecisionResult {
  const snap = getSnapshot(ledger);
  if (ctx?.noProgress) {
    const next = cloneLedger(ledger);
    next.decisions.push({
      timestamp: Date.now(),
      type: 'budget_decision_made',
      reason: 'no_progress',
      action: 'request_additional',
    });
    return { action: 'request_additional', reason: 'no_progress', ledger: next };
  }
  if (snap.exhausted || snap.remainingProviderCost <= 0 || snap.remainingWaitMs <= 0) {
    const next = cloneLedger(ledger);
    const reason: ExhaustionReason = snap.exhausted
      ? 'hard_model_calls_exceeded'
      : snap.remainingProviderCost <= 0
        ? 'hard_provider_cost_exceeded'
        : 'hard_wait_exceeded';
    next.decisions.push({
      timestamp: Date.now(),
      type: 'budget_exhausted',
      reason,
      action: 'stop',
    });
    return { action: 'stop', reason, ledger: next };
  }
  return { action: 'continue', reason: 'within_budget', ledger };
}

function getSnapshot(ledger: BudgetLedger): BudgetLedgerSnapshot {
  const usedCalls = ledger.usage.totalModelCalls || 0;
  return {
    remainingModelCalls: ledger.hardBudget.maxModelCalls - usedCalls,
    remainingTokens:
      ledger.hardBudget.maxInputTokens +
      ledger.hardBudget.maxOutputTokens -
      (ledger.usage.totalTokensInput + ledger.usage.totalTokensOutput),
    remainingProviderCost: ledger.hardBudget.maxProviderCost - (ledger.usage.totalCost || 0),
    remainingWaitMs: ledger.hardBudget.maxTotalWaitMs - (ledger.usage.totalLatencyMs || 0),
    remainingRecoveryCalls:
      ledger.hardBudget.maxRecoveryModelCalls - (ledger.usage.recoveryModelCalls || 0),
    remainingBatchChapters:
      ledger.hardBudget.maxBatchChapters - (ledger.usage.batchChaptersUsed || 0),
    exhausted: usedCalls >= ledger.hardBudget.maxModelCalls,
    mandatoryRemaining: unusedMandatoryCalls(ledger),
  };
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
  },
): BudgetLedger {
  const res = ledger.reservations[reservationId];
  if (!res) return ledger;

  const next = cloneLedger(ledger);
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
  if (res.budgetType === 'recovery') {
    next.usage.recoveryModelCalls =
      (next.usage.recoveryModelCalls || 0) + actual.modelCalls - res.reservedCalls;
  }
  const provider = actual.provider;
  if (provider) {
    const prev = next.usage.providerUsage?.[provider] ?? {
      calls: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    next.usage.providerUsage = {
      ...(next.usage.providerUsage ?? {}),
      [provider]: {
        calls: prev.calls + actual.modelCalls,
        cost: prev.cost + priced.actualCost,
        inputTokens: prev.inputTokens + actual.inputTokens,
        outputTokens: prev.outputTokens + actual.outputTokens,
      },
    };
  }

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
