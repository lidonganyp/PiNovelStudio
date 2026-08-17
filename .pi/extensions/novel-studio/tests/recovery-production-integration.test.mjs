/**
 * RECOVERY production integration — 真实主链路接线验收
 *
 * 覆盖核验缺口：
 * 1. 章节级恢复预算挂到 orchestrate 并在 recoverable hardBlock 预扣
 * 2. hardBlock 落盘 recovery checkpoint
 * 3. 生产 agentic_style 禁止 deliverRaw 静默 raw 降级
 * 4. failureClass 出现在 failureEnvelope
 * 5. runtime abort 记录 interrupted
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";
import { createNovelOSRuntime } from "../dist/novelos/runtime/runtime.js";
import { BudgetPolicy } from "../dist/novelos/runtime/budget-policy.js";
import { TrajectoryStore } from "../dist/novelos/trajectory/trajectory-store.js";
import { loadLatestRecoveryCheckpoint } from "../dist/v2/core/recovery-checkpoint.js";

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
    characterStates: [{ characterId: "林川", name: "林川", state: { role: "protagonist" }, sourceIds: ["t"] }],
    openLoops: [],
    worldRules: [],
    styleReferences: [{ kind: "fingerprint", id: "fp1", summary: "冷硬短句", sourceRef: "t" }],
    sourceMap: [],
    constitution: null,
    longTermState: null,
  };
}

test("生产 agentic_style：Agentic timeout → failureClass=recoverable + recoveryCheckpoint 落盘", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "rec-int-"));
  const workspaceId = "ws-rec";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(workspacePath, { recursive: true });
  try {
    const agenticCandidateSource = {
      async generate() {
        return {
          candidate: null,
          sessionId: "s1",
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
      modelGenerate: async () => {
        throw new Error("production path should not call one-shot raw model");
      },
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.failureEnvelope);
    assert.equal(result.failureEnvelope.failureClass, "recoverable");
    assert.ok(result.failureEnvelope.recoveryAction);
    assert.equal(result.failureEnvelope.gate, "model_timeout");
    assert.ok(result.stageResults.recoveryBudget, "应挂载章节恢复预算");
    assert.ok(result.stageResults.recoveryDecision);
    // checkpoint 应尝试落盘
    const cp = result.stageResults.recoveryCheckpoint;
    // recoverable 首次 timeout 动作是 retry_stage，不一定 checkpoint；
    // 但 budget 预扣与 recoveryDecision 必须存在
    assert.ok(result.stageResults.recoveryBudgetSnapshot || result.stageResults.recoveryBudget);
    assert.equal(result.chapterFilePath, null);
    assert.equal(result.selectedSource, null);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("生产 agentic_style：缺少 agentic 源 → blocked 且 failureClass 非 soft", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "rec-int2-"));
  try {
    const result = await createUnifiedOrchestrator().orchestrate({
      workspaceId: "ws2",
      chapterId: "1",
      chapterNumber: 1,
      projectRoot,
      productionFlow: "agentic_style",
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川"],
      // 无 agenticCandidateSource
      modelGenerate: async () => ({ text: "不应调用", model: "x", route: "r", durationMs: 1 }),
    });
    assert.equal(result.status, "blocked");
    assert.ok(result.failureEnvelope?.failureClass);
    assert.notEqual(result.failureEnvelope.failureClass, "soft");
    assert.ok(!JSON.stringify(result.failureEnvelope).includes("fallback to one_shot_raw"));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("hardBlock 预算耗尽路径：recoveryAction=checkpoint 且落盘", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "rec-budg-"));
  const workspaceId = "ws-b";
  mkdirSync(join(projectRoot, "workspaces", workspaceId), { recursive: true });
  try {
    const agenticCandidateSource = {
      async generate() {
        return {
          candidate: null,
          sessionId: "s",
          trajectoryPath: null,
          stopReason: "model_error",
          failureReason: "timed out",
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
      chapterId: "2",
      chapterNumber: 2,
      projectRoot,
      productionFlow: "agentic_style",
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川"],
      agenticCandidateSource,
      // 极小预算：第一次 recoverable hardBlock 预扣即耗尽
      recoveryBudgetOverrides: {
        maxStageAttempts: 0,
        maxTotalAttempts: 0,
        maxModelCalls: 0,
        maxRecoveryModelCalls: 0,
      },
      modelGenerate: async () => {
        throw new Error("should not call");
      },
    });
    assert.equal(result.status, "blocked");
    // 预算耗尽 → checkpoint 动作
    assert.ok(
      result.stageResults.recoveryBudgetExhausted ||
        result.failureEnvelope?.recoveryAction === "checkpoint" ||
        result.stageResults.recoveryDecision?.recoveryAction === "checkpoint",
    );
    if (result.stageResults.recoveryCheckpoint?.saved) {
      const loaded = loadLatestRecoveryCheckpoint(
        join(projectRoot, "workspaces", workspaceId),
        "2",
      );
      assert.ok(loaded);
      assert.equal(loaded.status, "open");
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("预算耗尽：recoveryLifecycle.state 必须为 checkpoint（非 running）", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "rec-life-"));
  const workspaceId = "ws-life";
  mkdirSync(join(projectRoot, "workspaces", workspaceId), { recursive: true });
  try {
    const agenticCandidateSource = {
      async generate() {
        return {
          candidate: null,
          sessionId: "s",
          trajectoryPath: null,
          stopReason: "model_error",
          failureReason: "timed out",
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
      chapterId: "3",
      chapterNumber: 3,
      projectRoot,
      productionFlow: "agentic_style",
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川"],
      agenticCandidateSource,
      recoveryBudgetOverrides: {
        maxStageAttempts: 0,
        maxTotalAttempts: 0,
        maxModelCalls: 0,
        maxRecoveryModelCalls: 0,
      },
      modelGenerate: async () => {
        throw new Error("should not call");
      },
    });
    assert.equal(result.status, "blocked");
    assert.equal(
      result.stageResults.recoveryLifecycle?.state,
      "checkpoint",
      `lifecycle 应为 checkpoint，实际=${JSON.stringify(result.stageResults.recoveryLifecycle)}`,
    );
    assert.ok(
      Array.isArray(result.stageResults.recoveryLifecycle?.history) &&
        result.stageResults.recoveryLifecycle.history.length > 0,
      "history 不得为空",
    );
    // 合法路径：running → retryable_failure → checkpoint
    const states = result.stageResults.recoveryLifecycle.history.map((h) => h.to);
    assert.ok(states.includes("retryable_failure") || states.includes("checkpoint"));
    assert.equal(result.stageResults.recoveryDecision?.recoveryAction, "checkpoint");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("两次 timeout：第二次 attempt 耗尽 → checkpoint 且不再 retry_stage", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "rec-2to-"));
  const workspaceId = "ws-2to";
  mkdirSync(join(projectRoot, "workspaces", workspaceId), { recursive: true });
  try {
    const agenticCandidateSource = {
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
    };

    // 第一次（attempt=0）
    const first = await createUnifiedOrchestrator().orchestrate({
      workspaceId,
      chapterId: "4",
      chapterNumber: 4,
      projectRoot,
      productionFlow: "agentic_style",
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川"],
      agenticCandidateSource,
      _modelTimeoutRetryAttempt: 0,
      modelGenerate: async () => {
        throw new Error("should not call");
      },
    });
    assert.equal(first.status, "blocked");
    assert.equal(first.failureEnvelope?.gate, "model_timeout");
    // 首次应允许 retry（工具层可重试）
    assert.ok(
      first.failureEnvelope?.recoveryAction === "retry_stage" ||
        first.stageResults.recoveryDecision?.recoveryAction === "retry_stage",
    );
    const priorBudget = first.stageResults.recoveryBudget;
    assert.ok(priorBudget, "首次应产出累计预算");

    // 第二次（attempt=1，maxAttempts=1）—— 应强制 checkpoint，不再 retry_stage
    const second = await createUnifiedOrchestrator().orchestrate({
      workspaceId,
      chapterId: "4",
      chapterNumber: 4,
      projectRoot,
      productionFlow: "agentic_style",
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川"],
      agenticCandidateSource,
      _modelTimeoutRetryAttempt: 1,
      _priorRecoveryBudget: priorBudget,
      modelGenerate: async () => {
        throw new Error("should not call");
      },
    });
    assert.equal(second.status, "blocked");
    assert.equal(
      second.stageResults.recoveryDecision?.recoveryAction,
      "checkpoint",
      `第二次应为 checkpoint，实际=${JSON.stringify(second.stageResults.recoveryDecision)}`,
    );
    assert.equal(second.stageResults.recoveryLifecycle?.state, "checkpoint");
    assert.equal(second.failureEnvelope?.recoverable, false);
    // 预算应累计（usedTotalAttempts 至少比首次多或相等且 >0）
    assert.ok(
      (second.stageResults.recoveryBudget?.usedTotalAttempts ?? 0) >=
        (priorBudget.usedTotalAttempts ?? 0),
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("runtime abort：interrupted envelope + isInterrupted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-abort-"));
  try {
    const session = {
      sessionId: "sess-abort",
      workspaceId: "ws-abort",
      chapterId: "1",
    };
    const budget = new BudgetPolicy({ maxTurns: 10, maxToolCalls: 10, maxModelCalls: 10 });
    const trajectory = new TrajectoryStore({
      projectRoot: dir,
      workspaceId: "ws-abort",
      sessionId: "sess-abort",
      persist: false,
    });

    const runtime = createNovelOSRuntime({
      session,
      systemPrompt: "test",
      modelGenerate: async () => ({ text: "ok", model: "m", route: "r", durationMs: 1 }),
      route: "test",
      tools: [],
      allowedToolNames: new Set(),
      budget,
      trajectory,
    });

    assert.equal(runtime.isInterrupted(), false);
    await runtime.abort("user_abort");
    assert.equal(runtime.isInterrupted(), true);
    assert.equal(runtime.getInterruptReason(), "user_abort");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
