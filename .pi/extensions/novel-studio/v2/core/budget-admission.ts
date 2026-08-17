/**
 * BUDGET-ADMISSION — 生产模型调用唯一准入入口
 *
 * wrapModelFn 只调用本模块：持久化 BudgetLedger + provider 共享配额。
 * layered-budget 不得出现在本入口。
 */

import {
  loadBudgetLedgerStore,
  reservePersistedBudget,
  settlePersistedBudget,
  releasePersistedBudget,
} from "./budget-ledger-store.js";
import {
  loadProviderBudgetGrant,
  resolveProviderQuota,
  reserveProviderQuota,
  settleProviderQuota,
  releaseProviderQuota,
} from "./provider-budget-ledger.js";
import type { BudgetLedger, BudgetReservation, BudgetStage } from "./budget-types.js";

export interface AdmitProductionModelCallInput {
  workspaceId: string;
  projectRoot: string;
  ownerRunId: string;
  stage: BudgetStage;
  budgetType?: BudgetReservation["budgetType"];
  provider: string;
  modelCalls?: number;
}

export interface AdmitProductionModelCallResult {
  ok: boolean;
  reason?: string;
  reservationId?: string;
  providerReservationId?: string;
  ledger: BudgetLedger;
}

export function admitProductionModelCall(
  input: AdmitProductionModelCallInput,
): AdmitProductionModelCallResult {
  const grant = loadProviderBudgetGrant(input.projectRoot, input.workspaceId);
  const quota = resolveProviderQuota(grant, input.provider);
  const providerReserve = reserveProviderQuota({
    workspaceId: input.workspaceId,
    projectRoot: input.projectRoot,
    provider: input.provider,
    ownerRunId: input.ownerRunId,
    modelCalls: input.modelCalls ?? 1,
  });
  if (!providerReserve.ok || !providerReserve.reservationId) {
    return {
      ok: false,
      reason: providerReserve.reason ?? "provider_quota_exceeded",
      ledger: loadBudgetLedgerStore(input.workspaceId, input.projectRoot),
    };
  }
  const reserved = reservePersistedBudget(input.workspaceId, input.projectRoot, {
    stage: input.stage,
    budgetType: input.budgetType,
    provider: input.provider,
    providerQuota: quota,
    modelCalls: input.modelCalls ?? 1,
  });
  if (!reserved.ok || !reserved.reservationId) {
    releaseProviderQuota({
      workspaceId: input.workspaceId,
      projectRoot: input.projectRoot,
      reservationId: providerReserve.reservationId,
    });
    return {
      ok: false,
      reason: reserved.reason ?? "hard_model_calls_exceeded",
      ledger: reserved.ledger,
    };
  }
  return {
    ok: true,
    reservationId: reserved.reservationId,
    providerReservationId: providerReserve.reservationId,
    ledger: reserved.ledger,
  };
}

export function settleProductionModelCall(input: {
  workspaceId: string;
  projectRoot: string;
  reservationId: string;
  providerReservationId?: string;
  provider: string;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  failed: boolean;
  cost?: number;
}): BudgetLedger {
  const settled = settlePersistedBudget(
    input.workspaceId,
    input.projectRoot,
    input.reservationId,
    {
      modelCalls: input.modelCalls,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      latencyMs: input.latencyMs,
      failed: input.failed,
      provider: input.provider,
      cost: input.cost,
    },
  );
  if (input.providerReservationId) {
    const snap = settled.costSnapshots[settled.costSnapshots.length - 1];
    settleProviderQuota({
      workspaceId: input.workspaceId,
      projectRoot: input.projectRoot,
      reservationId: input.providerReservationId,
      provider: input.provider,
      modelCalls: input.modelCalls,
      cost: snap?.actualCost ?? 0,
    });
  }
  return settled;
}

export function releaseProductionModelCall(input: {
  workspaceId: string;
  projectRoot: string;
  reservationId?: string;
  providerReservationId?: string;
}): void {
  if (input.reservationId) {
    releasePersistedBudget(input.workspaceId, input.projectRoot, input.reservationId);
  }
  if (input.providerReservationId) {
    releaseProviderQuota({
      workspaceId: input.workspaceId,
      projectRoot: input.projectRoot,
      reservationId: input.providerReservationId,
    });
  }
}
