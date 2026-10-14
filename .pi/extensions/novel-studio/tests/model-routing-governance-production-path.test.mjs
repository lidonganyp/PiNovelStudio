/**
 * MODEL-ROUTING-GOVERNANCE production path — WP-03..07 统一编排器生产接入验收
 *
 * 核验缺口补齐：
 * - layered budget 在 hardBlock / 成功出口写入 stageResults
 * - failure strategy matrix 在 hardBlock 写入 attemptHistory
 * - modelCallObservability / qualityCostAnalysis 出现在 stageResults
 * - runRouting 锁进入 controlPlane.runRouting 并驱动 identity
 *
 * 禁止真实模型调用。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";
import { resolveRunRouting } from "../dist/v2/core/run-routing-context.js";
import { buildTrustedControlPlane } from "../dist/v2/core/control-plane.js";

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
      {
        characterId: "林川",
        name: "林川",
        state: { role: "protagonist" },
        sourceIds: ["t"],
      },
    ],
    openLoops: [],
    worldRules: [],
    styleReferences: [
      { kind: "fingerprint", id: "fp1", summary: "冷硬短句", sourceRef: "t" },
    ],
    sourceMap: [],
    constitution: null,
    longTermState: null,
  };
}

function makeControlPlane(runRouting) {
  return buildTrustedControlPlane({
    taskId: "GOV-TEST:ws:1",
    objective: "routing governance production path",
    scope: ["chapter generation"],
    allowedResources: ["workspace:ws:read"],
    forbiddenResources: [],
    generationLock: runRouting.generationLock,
    judgeLock: runRouting.judgeLock,
    modelTransport: "stub",
    enforceModelLocks: true,
  });
}

test("生产 agentic_style blocked：stageResults 含 layeredBudget + failureStrategy + observability + qualityCost", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gov-prod-"));
  const workspaceId = "ws-gov";
  mkdirSync(join(projectRoot, "workspaces", workspaceId), { recursive: true });
  try {
    const runRouting = resolveRunRouting({
      orchestratorRunId: "run_gov_test_1",
      writerModel: undefined,
      budgetProfile: "production_default",
    });
    assert.equal(runRouting.provider, "gemini31");

    const agenticCandidateSource = {
      async generate() {
        return {
          candidate: null,
          sessionId: "s-gov",
          trajectoryPath: null,
          stopReason: "model_error",
          failureReason: "request timed out",
          failureKind: "model_timeout",
          toolCalls: 0,
          verifierCleared: false,
          repairRounds: 0,
          decisionMode: "react",
          firstAction: "none",
          actualRetrievalCalls: 0,
          mustVerifyCount: 0,
          mustVerifyCoveredCount: 0,
          coverageResult: null,
          modelCallsByKind: {},
        };
      },
    };

    const result = await createUnifiedOrchestrator().orchestrate({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      projectRoot,
      productionFlow: "agentic_style",
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川"],
      agenticCandidateSource,
      runRouting,
      controlPlane: makeControlPlane(runRouting),
      modelGenerate: async () => {
        throw new Error("production path should not call one-shot raw model");
      },
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.stageResults, "stageResults 必须存在");

    // WP-01：controlPlane 含 runRouting 快照
    assert.ok(result.stageResults.controlPlane?.runRouting);
    assert.equal(
      result.stageResults.controlPlane.runRouting.provider,
      "gemini31",
    );
    assert.equal(
      result.stageResults.controlPlane.runRouting.generationRoute,
      "v2_rawstage2_gemini31",
    );

    // WP-03：分层预算报告
    assert.ok(
      result.stageResults.layeredBudget,
      "blocked 出口必须写入 layeredBudget",
    );
    assert.ok(result.stageResults.layeredBudget.snapshot);
    assert.ok(result.stageResults.layeredBudget.chapterCostBreakdown);
    assert.ok(result.stageResults.layeredBudget.normal);
    assert.ok(result.stageResults.layeredBudget.recovery);
    assert.ok(result.stageResults.layeredBudget.ux);

    // WP-04：失败策略矩阵
    assert.ok(
      result.stageResults.failureStrategyDecision ||
        result.stageResults.failureStrategyTrace,
      "blocked 出口必须写入 failure strategy 证据",
    );
    const fsDecision =
      result.stageResults.failureStrategyDecision ??
      result.stageResults.failureStrategyTrace?.lastDecision;
    if (result.stageResults.failureStrategyDecision) {
      assert.ok(
        Array.isArray(result.stageResults.failureStrategyDecision.attemptHistory),
      );
      assert.equal(
        result.stageResults.failureStrategyDecision.silentDegradeForbidden,
        true,
      );
      assert.ok(
        result.stageResults.failureStrategyDecision.attemptHistory.length >= 1,
      );
    }
    assert.ok(fsDecision || result.stageResults.failureStrategyTrace);

    // WP-05：观测报告
    assert.ok(
      result.stageResults.modelCallObservability,
      "blocked 出口必须写入 modelCallObservability",
    );
    assert.ok(result.stageResults.modelCallObservability.latency);
    assert.ok(
      typeof result.stageResults.modelCallObservability.latency.p50 === "number",
    );
    assert.ok(
      typeof result.stageResults.modelCallObservability.latency.p99 === "number",
    );
    assert.ok(result.stageResults.modelCallObservability.costReport);
    assert.ok(result.stageResults.modelCallObservability.longTail);
    assert.ok(
      result.stageResults.modelCallObservability.routingStability === null ||
        typeof result.stageResults.modelCallObservability.routingStability ===
          "object",
    );

    // WP-07：质量-成本分析（分析 only）
    assert.ok(result.stageResults.qualityCostAnalysis);
    assert.equal(
      result.stageResults.qualityCostAnalysis.note,
      "analysis_only_not_production_score",
    );
    assert.ok(result.stageResults.qualityCostAnalysis.observation);
    assert.equal(
      result.stageResults.qualityCostAnalysis.observation.delivered,
      false,
    );
    assert.equal(
      result.stageResults.qualityCostAnalysis.observation.provider,
      "gemini31",
    );

    // 聚合包
    assert.ok(result.stageResults.routingGovernance);
    assert.equal(
      result.stageResults.routingGovernance.governanceVersion,
      "routing-governance-1.0",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("wrapModelFn 路径：成功模型调用后 layered budget usedModelCalls 递增并结算", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gov-call-"));
  try {
    const runRouting = resolveRunRouting({
      orchestratorRunId: "run_gov_call_1",
      writerModel: "claude",
    });
    assert.equal(runRouting.explicitWriterSelection, true);

    // eval B0 路径：走 one-shot raw + deliverRaw，触发 wrapModelFn 真实调用
    let calls = 0;
    const result = await createUnifiedOrchestrator().orchestrate({
      workspaceId: "ws-call",
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
      modelGenerate: async (input) => {
        calls += 1;
        return {
          text: "林川推开门，冷风灌进来。巷口的脚步声越来越近。",
          model: runRouting.model,
          route: input.route,
          provider: runRouting.provider,
          durationMs: 12,
          tokenUsage: { in: 50, out: 80 },
          finishReason: "stop",
        };
      },
    });

    assert.ok(calls >= 1, "至少一次模型调用");
    assert.ok(result.stageResults?.layeredBudget, "成功出口必须有 layeredBudget");
    assert.ok(
      result.stageResults.layeredBudget.normal.usedModelCalls >= 1,
      `normal.usedModelCalls 应 >=1，实际 ${result.stageResults.layeredBudget.normal.usedModelCalls}`,
    );
    assert.ok(
      result.stageResults.layeredBudget.chapterCostBreakdown.totalCost
        .modelCalls >= 1,
    );
    assert.ok(result.stageResults.modelCallObservability?.costReport);
    assert.ok(
      result.stageResults.modelCallObservability.costReport.totalCalls >= 1,
    );
    // 模型调用条目应带 budgetType / timeout 等 WP-05 字段
    const modelCalls = result.stageResults.modelCalls ?? [];
    assert.ok(modelCalls.length >= 1);
    const first = modelCalls[0];
    assert.ok(first.budgetType === "normal" || first.budgetType === "recovery");
    assert.ok(
      first.timeout === undefined || first.timeout > 0,
      "timeout 应有上限",
    );
    assert.ok(result.stageResults.qualityCostAnalysis?.note);
    // BG 真实成本：wrapModelFn 不得再 settle cost:0；tokenUsage 必须按价格表计入 actualCost
    const budgetLedger = result.stageResults.budgetLedger;
    assert.ok(budgetLedger, "成功出口必须落盘 budgetLedger");
    assert.ok(
      budgetLedger.usage.totalCost > 0,
      `真实 tokenUsage 结算后 totalCost 必须 > 0，实际 ${budgetLedger.usage.totalCost}`,
    );
    const costSnap = budgetLedger.costSnapshots?.[0];
    assert.ok(costSnap?.actualCost > 0, "costSnapshot.actualCost 必须来自 provider usage");
    assert.ok(
      costSnap.unitPriceScheduleVersion,
      "costSnapshot 必须记录 unitPriceScheduleVersion",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("同运行重试：失败后下一次模型调用 budgetType=recovery 且不挤占 normal", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gov-retry-"));
  try {
    const runRouting = resolveRunRouting({
      orchestratorRunId: "run_gov_retry_1",
      writerModel: "claude",
    });
    let call = 0;
    const result = await createUnifiedOrchestrator().orchestrate({
      workspaceId: "ws-retry",
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
      // 第一次失败 → 触发 empty/retry 路径；第二次成功
      modelGenerate: async (input) => {
        call += 1;
        if (call === 1) {
          const err = new Error("request timed out");
          throw err;
        }
        return {
          text: "林川推开门，冷风灌进来。巷口的脚步声越来越近。",
          model: runRouting.model,
          route: input.route,
          provider: runRouting.provider,
          durationMs: 15,
          tokenUsage: { in: 40, out: 60 },
          finishReason: "stop",
        };
      },
    });

    const modelCalls = result.stageResults?.modelCalls ?? [];
    assert.ok(modelCalls.length >= 1, "至少记录一次模型调用");
    const failed = modelCalls.filter((c) => c.failed);
    const succeeded = modelCalls.filter((c) => !c.failed);
    // 若编排器在 B0 路径对 empty/timeout 有重试，则后续成功调用应为 recovery
    if (failed.length >= 1 && succeeded.length >= 1) {
      const recoveryCalls = succeeded.filter((c) => c.budgetType === "recovery");
      assert.ok(
        recoveryCalls.length >= 1,
        `失败后的成功调用应为 recovery，实际 budgetTypes=${succeeded.map((c) => c.budgetType).join(",")}`,
      );
      assert.ok(
        result.stageResults.layeredBudget.recovery.usedModelCalls >= 1,
        "recovery.usedModelCalls 应 >= 1",
      );
    } else {
      // 即使 B0 不重试：显式 _modelTimeoutRetryAttempt=1 的二次 orchestrate 也应走 recovery
      const second = await createUnifiedOrchestrator().orchestrate({
        workspaceId: "ws-retry",
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
        _modelTimeoutRetryAttempt: 1,
        modelGenerate: async (input) => ({
          text: "林川推开门，冷风灌进来。巷口的脚步声越来越近。",
          model: runRouting.model,
          route: input.route,
          provider: runRouting.provider,
          durationMs: 10,
          tokenUsage: { in: 10, out: 20 },
        }),
      });
      const calls2 = second.stageResults?.modelCalls ?? [];
      assert.ok(calls2.length >= 1);
      assert.equal(
        calls2[0].budgetType,
        "recovery",
        "外层 model_timeout 重试必须 budgetType=recovery",
      );
      assert.ok(second.stageResults.layeredBudget.recovery.usedModelCalls >= 1);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("显式 Claude runRouting 写入 controlPlane 且与 generation lock 一致", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gov-claude-"));
  try {
    const runRouting = resolveRunRouting({ writerModel: "claude" });
    const result = await createUnifiedOrchestrator().orchestrate({
      workspaceId: "ws-claude",
      chapterId: "1",
      chapterNumber: 1,
      projectRoot,
      productionFlow: "agentic_style",
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川"],
      runRouting,
      controlPlane: makeControlPlane(runRouting),
      // 缺 agentic 源 → blocked，但仍应有 controlPlane.runRouting
      modelGenerate: async () => ({
        text: "x",
        model: "claude-opus-4-6",
        route: "v2_rawstage2",
        provider: "claude",
        durationMs: 1,
      }),
    });

    assert.equal(result.status, "blocked");
    const rr = result.stageResults.controlPlane?.runRouting;
    assert.ok(rr);
    assert.equal(rr.provider, "claude");
    assert.equal(rr.model, "claude-opus-4-6");
    assert.equal(rr.explicitWriterSelection, true);
    assert.equal(rr.generationRoute, "v2_rawstage2");
    // 治理报告在 blocked 出口
    assert.ok(result.stageResults.routingGovernance);
    assert.equal(
      result.stageResults.qualityCostAnalysis.observation.provider,
      "claude",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
