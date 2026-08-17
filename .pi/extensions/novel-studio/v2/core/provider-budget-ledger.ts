/**
 * PROVIDER-BUDGET-LEDGER — provider 级共享配额（跨 run / 跨任务）
 *
 * 正式预算源：workspace 或项目 config 的 provider-budget-grant.json。
 * 用量账本：workspaces/{id}/provider-budget-ledger.json，独占锁预留。
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { atomicSave } from "./orchestrator-commit-save.js";
import { withExclusiveGuard } from "./fs-atomic.js";

export interface ProviderQuota {
  maxCalls: number;
  maxCost: number;
}

export interface ProviderBudgetGrant {
  version: string;
  providers: Record<string, ProviderQuota>;
}

export interface ProviderReservation {
  reservationId: string;
  provider: string;
  ownerRunId: string;
  reservedCalls: number;
  expiresAt: number;
}

export interface ProviderUsage {
  reservedCalls: number;
  settledCalls: number;
  settledCost: number;
}

export interface ProviderBudgetLedger {
  grantVersion: string;
  usage: Record<string, ProviderUsage>;
  reservations: Record<string, ProviderReservation>;
}

export interface ProviderReserveResult {
  ok: boolean;
  reason?: string;
  reservationId?: string;
  ledger: ProviderBudgetLedger;
}

const DEFAULT_GRANT: ProviderBudgetGrant = {
  version: "pbg-2026-08-15",
  providers: {
    gemini31: { maxCalls: 80, maxCost: 20 },
    claude: { maxCalls: 80, maxCost: 40 },
    gpt: { maxCalls: 40, maxCost: 20 },
    glm: { maxCalls: 80, maxCost: 10 },
    doubao: { maxCalls: 80, maxCost: 10 },
  },
};

function emptyUsage(): ProviderUsage {
  return { reservedCalls: 0, settledCalls: 0, settledCost: 0 };
}

export function providerBudgetLedgerPath(workspaceId: string, projectRoot: string): string {
  return join(projectRoot, "workspaces", workspaceId, "provider-budget-ledger.json");
}

export function resolveProviderQuota(grant: ProviderBudgetGrant, provider: string): ProviderQuota {
  return grant.providers[provider] ?? grant.providers.default ?? { maxCalls: 80, maxCost: 20 };
}

export function loadProviderBudgetGrant(
  projectRoot: string,
  workspaceId?: string,
): ProviderBudgetGrant {
  const candidates = [
    workspaceId
      ? join(projectRoot, "workspaces", workspaceId, "provider-budget-grant.json")
      : "",
    join(projectRoot, "config", "provider-budget-grant.json"),
  ].filter(Boolean);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, "..", "..", "config", "provider-budget-grant.json"));
  } catch {
    /* bundled path may not resolve */
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as ProviderBudgetGrant;
      if (parsed && parsed.providers) {
        return {
          version: parsed.version ?? DEFAULT_GRANT.version,
          providers: { ...DEFAULT_GRANT.providers, ...parsed.providers },
        };
      }
    } catch {
      /* 下一候选 */
    }
  }
  return DEFAULT_GRANT;
}

export function createProviderBudgetLedger(
  grant: ProviderBudgetGrant = DEFAULT_GRANT,
): ProviderBudgetLedger {
  return {
    grantVersion: grant.version,
    usage: {},
    reservations: {},
  };
}

export function loadProviderBudgetLedger(
  workspaceId: string,
  projectRoot: string,
): ProviderBudgetLedger {
  const path = providerBudgetLedgerPath(workspaceId, projectRoot);
  if (!existsSync(path)) return createProviderBudgetLedger();
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ProviderBudgetLedger;
  } catch {
    return createProviderBudgetLedger();
  }
}

export function saveProviderBudgetLedger(
  ledger: ProviderBudgetLedger,
  workspaceId: string,
  projectRoot: string,
): void {
  const path = providerBudgetLedgerPath(workspaceId, projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  atomicSave(path, JSON.stringify(ledger, null, 2));
}

function expireProviderReservations(
  ledger: ProviderBudgetLedger,
  now: number,
): ProviderBudgetLedger {
  const next: ProviderBudgetLedger = {
    ...ledger,
    usage: { ...ledger.usage },
    reservations: { ...ledger.reservations },
  };
  for (const [id, res] of Object.entries(next.reservations)) {
    if (res.expiresAt > now) continue;
    const usage = { ...(next.usage[res.provider] ?? emptyUsage()) };
    usage.reservedCalls = Math.max(0, usage.reservedCalls - res.reservedCalls);
    next.usage[res.provider] = usage;
    delete next.reservations[id];
  }
  return next;
}

export function reserveProviderQuota(input: {
  workspaceId: string;
  projectRoot: string;
  provider: string;
  ownerRunId: string;
  modelCalls?: number;
  reservationId?: string;
  expiresAt?: number;
}): ProviderReserveResult {
  const grant = loadProviderBudgetGrant(input.projectRoot, input.workspaceId);
  const quota = resolveProviderQuota(grant, input.provider);
  const requested = input.modelCalls ?? 1;
  const path = providerBudgetLedgerPath(input.workspaceId, input.projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  return withExclusiveGuard(`${path}.guard`, () => {
    const loaded = expireProviderReservations(
      loadProviderBudgetLedger(input.workspaceId, input.projectRoot),
      Date.now(),
    );
    const usage = loaded.usage[input.provider] ?? emptyUsage();
    const committed = usage.reservedCalls + usage.settledCalls;
    if (committed + requested > quota.maxCalls || usage.settledCost > quota.maxCost) {
      return {
        ok: false,
        reason: "provider_quota_exceeded",
        ledger: loaded,
      };
    }
    const reservationId =
      input.reservationId ?? `prov_${Date.now()}_${randomBytes(6).toString("hex")}`;
    const next: ProviderBudgetLedger = {
      ...loaded,
      grantVersion: grant.version,
      usage: {
        ...loaded.usage,
        [input.provider]: {
          ...usage,
          reservedCalls: usage.reservedCalls + requested,
        },
      },
      reservations: {
        ...loaded.reservations,
        [reservationId]: {
          reservationId,
          provider: input.provider,
          ownerRunId: input.ownerRunId,
          reservedCalls: requested,
          expiresAt: input.expiresAt ?? Date.now() + 30 * 60 * 1000,
        },
      },
    };
    saveProviderBudgetLedger(next, input.workspaceId, input.projectRoot);
    return { ok: true, reservationId, ledger: next };
  });
}

export function settleProviderQuota(input: {
  workspaceId: string;
  projectRoot: string;
  reservationId?: string;
  provider: string;
  modelCalls: number;
  cost: number;
}): ProviderBudgetLedger {
  const path = providerBudgetLedgerPath(input.workspaceId, input.projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  return withExclusiveGuard(`${path}.guard`, () => {
    const loaded = loadProviderBudgetLedger(input.workspaceId, input.projectRoot);
    const res = input.reservationId ? loaded.reservations[input.reservationId] : undefined;
    const provider = res?.provider ?? input.provider;
    const usage = loaded.usage[provider] ?? emptyUsage();
    const reserved = res?.reservedCalls ?? 0;
    const next: ProviderBudgetLedger = {
      ...loaded,
      usage: {
        ...loaded.usage,
        [provider]: {
          reservedCalls: Math.max(0, usage.reservedCalls - reserved),
          settledCalls: usage.settledCalls + input.modelCalls,
          settledCost: usage.settledCost + input.cost,
        },
      },
      reservations: { ...loaded.reservations },
    };
    if (input.reservationId) delete next.reservations[input.reservationId];
    saveProviderBudgetLedger(next, input.workspaceId, input.projectRoot);
    return next;
  });
}

export function releaseProviderQuota(input: {
  workspaceId: string;
  projectRoot: string;
  reservationId: string;
}): ProviderBudgetLedger {
  const path = providerBudgetLedgerPath(input.workspaceId, input.projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  return withExclusiveGuard(`${path}.guard`, () => {
    const loaded = loadProviderBudgetLedger(input.workspaceId, input.projectRoot);
    const res = loaded.reservations[input.reservationId];
    if (!res) return loaded;
    const usage = loaded.usage[res.provider] ?? emptyUsage();
    const next: ProviderBudgetLedger = {
      ...loaded,
      usage: {
        ...loaded.usage,
        [res.provider]: {
          ...usage,
          reservedCalls: Math.max(0, usage.reservedCalls - res.reservedCalls),
        },
      },
      reservations: { ...loaded.reservations },
    };
    delete next.reservations[input.reservationId];
    saveProviderBudgetLedger(next, input.workspaceId, input.projectRoot);
    return next;
  });
}
