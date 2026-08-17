/**
 * BUDGET-LEDGER-STORE — 队列级原子账本（跨进程 reserve / release / expire）
 *
 * 磁盘：workspaces/{workspaceId}/budget-ledger.json
 * 互斥：withExclusiveGuard + atomicSave，禁止无锁读改写。
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicSave } from "./orchestrator-commit-save.js";
import { withExclusiveGuard } from "./fs-atomic.js";
import {
  createBudgetLedger,
  expireReservations,
  reserveBudget,
  releaseBudget,
  settleBudget,
  type ReserveLedgerResult,
} from "./budget-ledger.js";
import type { BudgetLedger, BudgetReservation, BudgetStage } from "./budget-types.js";

export function budgetLedgerStorePath(workspaceId: string, projectRoot: string): string {
  return join(projectRoot, "workspaces", workspaceId, "budget-ledger.json");
}

function guardPath(storePath: string): string {
  return `${storePath}.guard`;
}

export function seedBudgetLedgerStoreIfAbsent(
  ledger: BudgetLedger,
  workspaceId: string,
  projectRoot: string,
): void {
  const path = budgetLedgerStorePath(workspaceId, projectRoot);
  if (!existsSync(path)) {
    saveBudgetLedgerStore(ledger, workspaceId, projectRoot);
  }
}

export function loadBudgetLedgerStore(
  workspaceId: string,
  projectRoot: string,
): BudgetLedger {
  const path = budgetLedgerStorePath(workspaceId, projectRoot);
  if (!existsSync(path)) return createBudgetLedger();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as BudgetLedger;
    return createBudgetLedger(parsed);
  } catch {
    return createBudgetLedger();
  }
}

export function saveBudgetLedgerStore(
  ledger: BudgetLedger,
  workspaceId: string,
  projectRoot: string,
): void {
  const path = budgetLedgerStorePath(workspaceId, projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  atomicSave(path, JSON.stringify(ledger, null, 2));
}

export function withBudgetLedgerLock<T>(
  workspaceId: string,
  projectRoot: string,
  fn: (ledger: BudgetLedger) => { ledger: BudgetLedger; result: T },
): T {
  const path = budgetLedgerStorePath(workspaceId, projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  return withExclusiveGuard(guardPath(path), () => {
    const loaded = expireReservations(loadBudgetLedgerStore(workspaceId, projectRoot));
    const { ledger, result } = fn(loaded);
    saveBudgetLedgerStore(ledger, workspaceId, projectRoot);
    return result;
  });
}

export function reservePersistedBudget(
  workspaceId: string,
  projectRoot: string,
  request: {
    stage: BudgetStage;
    budgetType?: BudgetReservation["budgetType"];
    modelCalls?: number;
    reservationId?: string;
    expiresAt?: number;
    provider?: string;
    providerQuota?: { maxCalls: number; maxCost: number };
  },
): ReserveLedgerResult {
  return withBudgetLedgerLock(workspaceId, projectRoot, (ledger) => {
    const reserved = reserveBudget(ledger, request);
    return { ledger: reserved.ledger, result: reserved };
  });
}

export function settlePersistedBudget(
  workspaceId: string,
  projectRoot: string,
  reservationId: string,
  actual: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    failed: boolean;
    provider?: string;
    cost?: number;
  },
): BudgetLedger {
  return withBudgetLedgerLock(workspaceId, projectRoot, (ledger) => {
    const next = settleBudget(ledger, reservationId, actual);
    return { ledger: next, result: next };
  });
}

export function releasePersistedBudget(
  workspaceId: string,
  projectRoot: string,
  reservationId: string,
): BudgetLedger {
  return withBudgetLedgerLock(workspaceId, projectRoot, (ledger) => {
    const next = releaseBudget(ledger, reservationId);
    return { ledger: next, result: next };
  });
}
