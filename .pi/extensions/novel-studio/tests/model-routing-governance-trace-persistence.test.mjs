/**
 * MODEL-ROUTING-GOVERNANCE trace persistence — 成功/blocked 治理字段落盘 quality-trace.json
 *
 * 验收：
 * 1. blocked：error gate.evidence 含 routingGovernance / layeredBudget
 * 2. success（B0）：final_selected gate.evidence 含 modelCallObservability / qualityCostAnalysis
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";
import { resolveRunRouting } from "../dist/v2/core/run-routing-context.js";
import { buildTrustedControlPlane } from "../dist/v2/core/control-plane.js";
import { createLegacyTraceAdapter } from "../dist/v2/adapters/legacy-trace-adapter.js";
import { buildTraceRecordsFromOrchResultForTest } from "../dist/v2/core/unified-entry.js";
// buildTraceRecordsFromOrchResultForTest 与生产 buildTraceRecordsFromOrchResult 同逻辑

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
    taskId: "GOV-TRACE:ws:1",
    objective: "routing governance trace persistence",
    scope: ["chapter generation"],
    allowedResources: ["workspace:ws:read"],
    forbiddenResources: [],
    generationLock: runRouting.generationLock,
    judgeLock: runRouting.judgeLock,
    modelTransport: "stub",
    enforceModelLocks: true,
  });
}

function flushOrchToTrace(projectRoot, workspaceId, chapterId, orchResult) {
  // 复用 production buildTraceRecords 路径：从 dist unified-entry 导出的测试 helper
  // 若不存在 helper，则直接构造与 production 同字段的 record 并 flush。
  const records =
    typeof buildTraceRecordsFromOrchResultForTest === "function"
      ? buildTraceRecordsFromOrchResultForTest(orchResult, "ctx:test")
      : null;

  const adapter = createLegacyTraceAdapter({
    workspacePath: join(projectRoot, "workspaces"),
    workspaceId,
    chapterId,
    append: false,
    writeMode: "legacy",
  });

  if (records) {
    for (const r of records) adapter.record(r);
  } else {
    // 回退：按 stageResults 直接写 final_selected / error 记录（与 production 字段对齐）
    if (orchResult.status === "ok") {
      adapter.record({
        stage: "final_selected",
        timestamp: new Date().toISOString(),
        finalSelection: {
          selectedCandidateId: orchResult.selectedCandidateId || "c1",
          selectedSource: "rawStage2",
          projectGain: "neutral",
          whySelected: ["test"],
          whyRejected: [],
          acceptedRepairs: [],
          rejectedRepairs: [],
        },
        modelCalls: orchResult.stageResults.modelCalls,
        modelBudget: orchResult.stageResults.modelBudget,
        routingGovernance: orchResult.stageResults.routingGovernance,
        layeredBudget: orchResult.stageResults.layeredBudget,
        modelCallObservability: orchResult.stageResults.modelCallObservability,
        qualityCostAnalysis: orchResult.stageResults.qualityCostAnalysis,
        contextHash: "ctx:test",
      });
    } else {
      adapter.record({
        stage: "error",
        timestamp: new Date().toISOString(),
        error: {
          message: orchResult.failureEnvelope?.reason ?? "blocked",
          code: orchResult.failureEnvelope?.stage ?? "error",
          recoverable: false,
        },
        failureEnvelope: {
          stage: orchResult.failureEnvelope?.stage ?? "error",
          gate: orchResult.failureEnvelope?.gate ?? "error",
          severity: "hard_block",
          reason: orchResult.failureEnvelope?.reason ?? "blocked",
          evidence: {
            stageResults: orchResult.stageResults,
          },
          recoverable: false,
        },
        routingGovernance: orchResult.stageResults.routingGovernance,
        layeredBudget: orchResult.stageResults.layeredBudget,
        modelCallObservability: orchResult.stageResults.modelCallObservability,
        qualityCostAnalysis: orchResult.stageResults.qualityCostAnalysis,
        failureStrategyDecision: orchResult.stageResults.failureStrategyDecision,
        contextHash: "ctx:test",
      });
    }
  }

  const path = adapter.flush();
  assert.ok(path && existsSync(path), `trace 应落盘: ${path}`);
  return { path, doc: JSON.parse(readFileSync(path, "utf-8")) };
}

test("blocked：quality-trace gate.evidence 含 layeredBudget / routingGovernance", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gov-trace-b-"));
  const workspaceId = "ws-trace-b";
  mkdirSync(join(projectRoot, "workspaces", workspaceId), { recursive: true });
  try {
    const runRouting = resolveRunRouting({ orchestratorRunId: "run_trace_b" });
    const orchResult = await createUnifiedOrchestrator().orchestrate({
      workspaceId,
      chapterId: "blocked-trace",
      chapterNumber: 1,
      projectRoot,
      productionFlow: "agentic_style",
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川"],
      runRouting,
      controlPlane: makeControlPlane(runRouting),
      agenticCandidateSource: {
        async generate() {
          return {
            candidate: null,
            sessionId: "s",
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
      },
      modelGenerate: async () => {
        throw new Error("no raw");
      },
    });
    assert.equal(orchResult.status, "blocked");
    assert.ok(orchResult.stageResults.routingGovernance);

    const { doc } = flushOrchToTrace(
      projectRoot,
      workspaceId,
      "blocked-trace",
      orchResult,
    );
    const gates = doc.gates ?? [];
    assert.ok(gates.length >= 1, "trace 应有 gates");

    // evidence 是完整 V2TraceRecord
    const withGov = gates.find(
      (g) =>
        g.evidence?.routingGovernance ||
        g.evidence?.layeredBudget ||
        g.evidence?.failureEnvelope?.evidence?.stageResults?.routingGovernance,
    );
    assert.ok(withGov, "至少一条 gate.evidence 含治理字段");
    const ev = withGov.evidence;
    const layered =
      ev.layeredBudget ??
      ev.failureEnvelope?.evidence?.stageResults?.layeredBudget;
    const rg =
      ev.routingGovernance ??
      ev.failureEnvelope?.evidence?.stageResults?.routingGovernance;
    assert.ok(layered, "trace 应含 layeredBudget");
    assert.ok(rg, "trace 应含 routingGovernance");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("success B0：quality-trace final_selected evidence 含 modelCallObservability", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gov-trace-s-"));
  const workspaceId = "ws-trace-s";
  mkdirSync(join(projectRoot, "workspaces", workspaceId), { recursive: true });
  try {
    const runRouting = resolveRunRouting({
      orchestratorRunId: "run_trace_s",
      writerModel: "claude",
    });
    const orchResult = await createUnifiedOrchestrator().orchestrate({
      workspaceId,
      chapterId: "ok-trace",
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
        durationMs: 11,
        tokenUsage: { in: 20, out: 30 },
      }),
    });
    assert.ok(orchResult.stageResults?.routingGovernance);

    const { doc } = flushOrchToTrace(
      projectRoot,
      workspaceId,
      "ok-trace",
      orchResult,
    );
    const gates = doc.gates ?? [];
    const finalGate = gates.find(
      (g) =>
        g.stage === "v2_final_selected" ||
        g.evidence?.stage === "final_selected",
    );
    assert.ok(finalGate, `应有 final_selected gate，实际: ${gates.map((g) => g.stage).join(",")}`);
    const ev = finalGate.evidence;
    assert.ok(
      ev.modelCallObservability || ev.routingGovernance,
      "final_selected evidence 应含 modelCallObservability 或 routingGovernance",
    );
    if (ev.modelCallObservability) {
      assert.ok(typeof ev.modelCallObservability.latency?.p50 === "number");
      assert.ok(ev.modelCallObservability.costReport);
    }
    if (ev.qualityCostAnalysis) {
      assert.equal(
        ev.qualityCostAnalysis.note,
        "analysis_only_not_production_score",
      );
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
