/**
 * BudgetLedger 单一权威 + 生产持久化预留 + provider 共享配额
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";
import { resolveRunRouting } from "../dist/v2/core/run-routing-context.js";
import { buildTrustedControlPlane } from "../dist/v2/core/control-plane.js";
import {
  createBudgetLedger,
  reserveBudget,
} from "../dist/v2/core/budget-ledger.js";
import {
  saveBudgetLedgerStore,
  loadBudgetLedgerStore,
  budgetLedgerStorePath,
  reservePersistedBudget,
  settlePersistedBudget,
} from "../dist/v2/core/budget-ledger-store.js";
import {
  loadProviderBudgetGrant,
  reserveProviderQuota,
  settleProviderQuota,
  loadProviderBudgetLedger,
  providerBudgetLedgerPath,
} from "../dist/v2/core/provider-budget-ledger.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH_SRC = join(HERE, "..", "v2", "core", "unified-orchestrator.ts");

function makeIntent() {
  return {
    chapterFunction: "推进冲突",
    readerExperience: ["紧张"],
    currentPressure: ["封锁"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林川"],
    inviolableFacts: [],
    sourceRefs: ["test"],
  };
}

function makeContext() {
  return {
    facts: [],
    characterStates: [
      { characterId: "林川", name: "林川", state: { role: "protagonist" }, sourceIds: ["t"] },
    ],
    openLoops: [],
    worldRules: [],
    styleReferences: [{ id: "s1", kind: "fingerprint", content: "冷硬", sourceIds: ["t"] }],
    sourceMap: {},
  };
}

function makeControlPlane(runRouting) {
  return buildTrustedControlPlane({
    taskId: `NOVEL-TEST:${runRouting.orchestratorRunId}`,
    objective: "budget authority test",
    scope: ["eval"],
    allowedResources: ["eval:model"],
    forbiddenResources: [],
    generationLock: runRouting.generationLock,
    judgeLock: runRouting.judgeLock,
    modelTransport: "local",
    enforceModelLocks: false,
  });
}

test("wrapModelFn 源码不再用 reserveForModelCall 作为准入阻断", () => {
  const src = readFileSync(ORCH_SRC, "utf-8");
  assert.equal(
    src.includes("reserveForModelCall("),
    false,
    "生产 wrapModelFn 不得再调用 reserveForModelCall",
  );
  assert.match(src, /admitProductionModelCall/);
});

test("同一 workspace 两次真实调用共享持久化账本，不得各自从零消耗", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "bg-persist-"));
  const workspaceId = "ws-shared";
  mkdirSync(join(projectRoot, "workspaces", workspaceId), { recursive: true });
  try {
    saveBudgetLedgerStore(
      createBudgetLedger({ hardBudget: { maxModelCalls: 1, maxRecoveryModelCalls: 1 } }),
      workspaceId,
      projectRoot,
    );
    const runRouting = resolveRunRouting({
      orchestratorRunId: "run_shared_1",
      writerModel: "claude",
    });
    const orch = createUnifiedOrchestrator();
    const first = await orch.orchestrate({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      projectRoot,
      evalMode: "B0",
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川"],
      runRouting,
      controlPlane: makeControlPlane(runRouting),
      modelGenerate: async (input) => ({
        text: "林川推开门，冷风灌进来。巷口的脚步声越来越近。",
        model: runRouting.model,
        route: input.route,
        provider: runRouting.provider,
        durationMs: 8,
        tokenUsage: { in: 20, out: 30 },
      }),
    });
    assert.ok(first.stageResults?.budgetLedger?.usage.totalModelCalls >= 1);
    assert.ok(existsSync(budgetLedgerStorePath(workspaceId, projectRoot)));

    const secondRouting = resolveRunRouting({
      orchestratorRunId: "run_shared_2",
      writerModel: "claude",
    });
    const second = await orch.orchestrate({
      workspaceId,
      chapterId: "2",
      chapterNumber: 2,
      projectRoot,
      evalMode: "B0",
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川"],
      runRouting: secondRouting,
      controlPlane: makeControlPlane(secondRouting),
      modelGenerate: async () => {
        throw new Error("second run must not call the model");
      },
    });
    const disk = loadBudgetLedgerStore(workspaceId, projectRoot);
    assert.equal(disk.usage.totalModelCalls, 1);
    assert.notEqual(second.status, "ok");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("provider 共享配额：两 run 共用同一 provider，超额不得独立消耗", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "bg-prov-"));
  const workspaceId = "ws-prov";
  mkdirSync(join(projectRoot, "workspaces", workspaceId), { recursive: true });
  try {
    writeFileSync(
      join(projectRoot, "workspaces", workspaceId, "provider-budget-grant.json"),
      JSON.stringify({
        version: "test-grant",
        providers: { claude: { maxCalls: 1, maxCost: 10 } },
      }),
      "utf-8",
    );
    const grant = loadProviderBudgetGrant(projectRoot, workspaceId);
    assert.equal(grant.providers.claude.maxCalls, 1);

    const r1 = reserveProviderQuota({
      workspaceId,
      projectRoot,
      provider: "claude",
      ownerRunId: "runA",
      modelCalls: 1,
    });
    assert.equal(r1.ok, true);
    settleProviderQuota({
      workspaceId,
      projectRoot,
      reservationId: r1.reservationId,
      provider: "claude",
      modelCalls: 1,
      cost: 0.01,
    });

    const r2 = reserveProviderQuota({
      workspaceId,
      projectRoot,
      provider: "claude",
      ownerRunId: "runB",
      modelCalls: 1,
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, "provider_quota_exceeded");
    const disk = loadProviderBudgetLedger(workspaceId, projectRoot);
    assert.equal(disk.usage.claude.settledCalls, 1);
    assert.ok(existsSync(providerBudgetLedgerPath(workspaceId, projectRoot)));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("persist settle 把预扣转成实际 token/cost", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "bg-settle-"));
  const workspaceId = "ws-settle";
  mkdirSync(join(projectRoot, "workspaces", workspaceId), { recursive: true });
  try {
    saveBudgetLedgerStore(createBudgetLedger(), workspaceId, projectRoot);
    const reserved = reservePersistedBudget(workspaceId, projectRoot, {
      stage: "agenticDraft",
      provider: "claude",
      modelCalls: 1,
    });
    assert.equal(reserved.ok, true);
    const settled = settlePersistedBudget(workspaceId, projectRoot, reserved.reservationId, {
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 12,
      failed: false,
      provider: "claude",
    });
    assert.equal(settled.usage.totalModelCalls, 1);
    assert.ok(settled.usage.totalCost > 0);
    assert.equal(Object.keys(settled.reservations).length, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("in-memory reserve 仍可在传入 providerQuota 时按 provider 阻断", () => {
  const ledger = createBudgetLedger({
    hardBudget: { maxModelCalls: 10 },
    usage: {
      providerUsage: { claude: { calls: 1, cost: 0, inputTokens: 0, outputTokens: 0 } },
    },
  });
  const denied = reserveBudget(ledger, {
    stage: "agenticDraft",
    provider: "claude",
    providerQuota: { maxCalls: 1, maxCost: 10 },
    modelCalls: 1,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "provider_quota_exceeded");
});
