/**
 * GREEN 测试：多维修订预算（REASONING-REPAIR-BOUNDARY-1 Wave 4A / RRB-4.6）
 *
 * 锁定修订循环同时约束四个维度：模型调用、授权次数、候选数量、validator runs，
 * 任一维度触顶即 budget_exhausted 退出，防止只限制轮次导致单一维度无界。
 *
 * 对照计划 §7 最小验收矩阵：
 *   T23  修订预算耗尽或连续停滞 → 有界退出并记录明确 stopReason
 * 对照计划 §8 门槛：
 *   verification loop 无界执行 = 0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkRepairBudget,
  deriveRepairBudgetConfig,
} from "../dist/novelos/agent/repair-budget.js";
import { NarrativeAgentLoop } from "../dist/novelos/agent/narrative-agent-loop.js";
import { createCandidateWorkspace } from "../dist/novelos/agent/candidate-workspace.js";

const EMPTY_CONTEXT = {
  facts: [],
  characterStates: [],
  openLoops: [],
  worldRules: [],
  styleReferences: [],
  sourceMap: [],
};

const SNAPSHOT_ID = "snap-test";

// ============================================================================
// 纯函数：天花板派生 + 维度耗尽检查
// ============================================================================

test("deriveRepairBudgetConfig: 由 maxRepairRounds 派生四维天花板", () => {
  assert.deepEqual(deriveRepairBudgetConfig(2, 4), {
    maxModelCalls: 2,
    maxAuthorizations: 8,
    maxCandidates: 2,
    maxValidatorRuns: 5,
  });
  assert.deepEqual(deriveRepairBudgetConfig(10, 4), {
    maxModelCalls: 10,
    maxAuthorizations: 40,
    maxCandidates: 10,
    maxValidatorRuns: 21,
  });
});

test("checkRepairBudget: 未触顶返回 exhausted=false", () => {
  assert.deepEqual(
    checkRepairBudget(
      { modelCalls: 1, authorizations: 3, candidates: 1, validatorRuns: 4 },
      deriveRepairBudgetConfig(2, 4),
    ),
    { exhausted: false },
  );
});

test("checkRepairBudget: 模型调用触顶 → maxModelCalls", () => {
  assert.deepEqual(
    checkRepairBudget(
      { modelCalls: 2, authorizations: 0, candidates: 0, validatorRuns: 0 },
      deriveRepairBudgetConfig(2, 4),
    ),
    { exhausted: true, exhaustedDimension: "maxModelCalls" },
  );
});

test("checkRepairBudget: 授权次数触顶 → maxAuthorizations", () => {
  assert.deepEqual(
    checkRepairBudget(
      { modelCalls: 0, authorizations: 8, candidates: 0, validatorRuns: 0 },
      deriveRepairBudgetConfig(2, 4),
    ),
    { exhausted: true, exhaustedDimension: "maxAuthorizations" },
  );
});

test("checkRepairBudget: 候选数量触顶 → maxCandidates", () => {
  assert.deepEqual(
    checkRepairBudget(
      { modelCalls: 0, authorizations: 0, candidates: 2, validatorRuns: 0 },
      deriveRepairBudgetConfig(2, 4),
    ),
    { exhausted: true, exhaustedDimension: "maxCandidates" },
  );
});

test("checkRepairBudget: validator runs 触顶 → maxValidatorRuns", () => {
  assert.deepEqual(
    checkRepairBudget(
      { modelCalls: 0, authorizations: 0, candidates: 0, validatorRuns: 5 },
      deriveRepairBudgetConfig(2, 4),
    ),
    { exhausted: true, exhaustedDimension: "maxValidatorRuns" },
  );
});

test("checkRepairBudget: 模型调用优先于其他维度标注", () => {
  assert.deepEqual(
    checkRepairBudget(
      { modelCalls: 2, authorizations: 8, candidates: 2, validatorRuns: 5 },
      deriveRepairBudgetConfig(2, 4),
    ),
    { exhausted: true, exhaustedDimension: "maxModelCalls" },
  );
});

// ============================================================================
// Loop 级：独立维度收紧即可让循环 budget_exhausted 退出（无需降低轮次）
// ============================================================================

function buildEvidenceRecords(findings, snapshotId = SNAPSHOT_ID) {
  const byId = new Map();
  for (const f of findings) {
    if (!f.evidenceId || byId.has(f.evidenceId)) continue;
    byId.set(f.evidenceId, {
      evidenceId: f.evidenceId,
      statement: f.conflictFact,
      authorityClass: "author_declaration",
      epistemicStatus: "confirmed",
      sourceRef: f.sourceRef,
      sourceContentHash: `src-hash-${f.evidenceId}`,
      evidenceExcerptHash: `excerpt-hash-${f.evidenceId}`,
      validFrom: null,
      validUntil: null,
      matchedBecause: ["AUTHOR_CONTRACT"],
      retrievalQueryId: null,
      snapshotId,
      traceable: true,
    });
  }
  return [...byId.values()];
}

function makeFinding({ id, sourceRef = `canon:${id}`, span = { start: 0, end: 3 } }) {
  return {
    id,
    source: "canon_guard",
    failureType: "fact_contradiction",
    severity: "hard",
    span: { ...span, excerpt: "" },
    conflictFact: `missing ${id}`,
    sourceRef,
    evidenceId: sourceRef,
    confidence: 1,
    allowedRepairRange: { ...span, excerpt: "" },
    description: `missing ${id}`,
    certainty: "deterministic",
    coverageStatus: "missing",
  };
}

function makeReport(hardFindings) {
  return {
    findings: hardFindings,
    hardFindings,
    softFindings: [],
    hasHardFailure: hardFindings.length > 0,
  };
}

function makeHarness({ reports, patchedTexts, maxRepairRounds = 10, repairBudget }) {
  const prompts = [];
  let verifyIndex = 0;
  let patchIndex = 0;

  const runtime = {
    agent: { state: { messages: [] } },
    subscribe() {},
    async prompt(prompt) {
      prompts.push(prompt);
      const text = prompts.length === 1
        ? "初始草稿。人物走进现场，开始调查。"
        : patchedTexts[Math.min(patchIndex++, patchedTexts.length - 1)];
      this.agent.state.messages.push({ role: "assistant", content: [{ type: "text", text }] });
    },
    async waitForIdle() {},
  };

  const verifier = {
    verify() {
      return reports[Math.min(verifyIndex++, reports.length - 1)];
    },
  };

  const patchService = {
    proposePatches(_draft, feedbacks) {
      return feedbacks.map((feedback) => ({
        findingId: feedback.findingId,
        type: "paragraph_patch",
        targetSpan: feedback.allowedRepairRange,
        suggestion: feedback.repairSuggestion,
        repairDirection: `repair ${feedback.findingId}`,
        applied: false,
        localReplacement: false,
      }));
    },
    evaluatePatch() {
      return { accepted: true, reason: "improved", metrics: {} };
    },
  };

  const noOpStore = new Proxy({}, { get: () => () => {} });
  const budget = {
    isExhausted: () => false,
    getSnapshot: () => ({ turns: prompts.length, toolCalls: 0 }),
  };

  const candidateWorkspace = createCandidateWorkspace({
    workspaceRoot: "repair-budget-wave4a-test",
    sessionId: "budget-test-session",
    dryRun: true,
  });

  const loop = new NarrativeAgentLoop({
    runtime,
    registry: {},
    searchService: {},
    candidateWorkspace,
    permissionPolicy: {},
    budget,
    trajectory: noOpStore,
    verifier,
    patchService,
    maxRepairRounds,
    repairBudget,
  });

  return { loop, prompts };
}

function runLoop(loop, evidenceRecords) {
  return loop.run({
    chapterIntent: "作者章纲事件顺序：\n  1. 事件一",
    seedContext: "seed",
    context: EMPTY_CONTEXT,
    snapshotId: SNAPSHOT_ID,
    evidenceRecords,
  });
}

test("RRB-4.6: maxCandidates=1 收紧时，高轮次下仍以 budget_exhausted 退出", async () => {
  const finding = makeFinding({ id: "f1", sourceRef: "canon:f1" });
  const { loop } = makeHarness({
    // 同一个 finding 永远不收敛：连续 4 轮报告同一硬失败，确保循环会尝试多轮。
    reports: [makeReport([finding]), makeReport([finding]), makeReport([finding]), makeReport([finding])],
    patchedTexts: ["修订一。", "修订二。", "修订三。"],
    maxRepairRounds: 10,
    // 收紧候选数量维度，而非轮次。
    repairBudget: { maxCandidates: 1 },
  });
  const evidenceRecords = buildEvidenceRecords([finding]);
  const result = await runLoop(loop, evidenceRecords);

  assert.equal(result.lineage.stopReason, "budget_exhausted");
  assert.equal(result.lineage.verifierCleared, false);
  // 只创建了 1 个子候选（第一轮通过 gate），第二轮触顶退出。
  assert.equal(result.repairRounds, 1);
  assert.equal(result.lineage.repairBudget.candidates, 1);
  assert.equal(result.lineage.repairBudget.exhausted, true);
  assert.equal(result.lineage.repairBudget.exhaustedDimension, "maxCandidates");
});

test("RRB-4.6: maxModelCalls=1 收紧时，以 budget_exhausted 退出并标注 maxModelCalls", async () => {
  const finding = makeFinding({ id: "f1", sourceRef: "canon:f1" });
  const { loop } = makeHarness({
    reports: [makeReport([finding]), makeReport([finding]), makeReport([finding]), makeReport([finding])],
    patchedTexts: ["修订一。", "修订二。", "修订三。"],
    maxRepairRounds: 10,
    repairBudget: { maxModelCalls: 1 },
  });
  const evidenceRecords = buildEvidenceRecords([finding]);
  const result = await runLoop(loop, evidenceRecords);

  assert.equal(result.lineage.stopReason, "budget_exhausted");
  assert.equal(result.lineage.repairBudget.modelCalls, 1);
  assert.equal(result.lineage.repairBudget.exhausted, true);
  assert.equal(result.lineage.repairBudget.exhaustedDimension, "maxModelCalls");
});

test("RRB-4.6: 未收紧预算时，连续停滞仍以 stagnant 退出（不被 budget 抢跑）", async () => {
  const finding = makeFinding({ id: "f1", sourceRef: "canon:f1" });
  const { loop } = makeHarness({
    reports: [makeReport([finding]), makeReport([finding]), makeReport([finding]), makeReport([finding])],
    patchedTexts: ["修订一。", "修订二。", "修订三。"],
    maxRepairRounds: 10,
    // 不传 repairBudget → 默认派生，stagnant 应优先触发。
  });
  const evidenceRecords = buildEvidenceRecords([finding]);
  const result = await runLoop(loop, evidenceRecords);

  assert.equal(result.lineage.stopReason, "stagnant");
  assert.equal(result.repairRounds, 2);
  assert.equal(result.lineage.repairBudget.exhausted, false);
});
