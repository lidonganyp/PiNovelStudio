/**
 * NovelOS verifier repair convergence regression tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

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

/** RRB-3.7：修订授权要求 candidate.snapshotId 与 evidenceRecord.snapshotId 一致。 */
const SNAPSHOT_ID = "snap-test";

/**
 * RRB-3.7：从 findings 构建权威证据记录（按 evidenceId 索引），供 verifyAndPatch
 * 逐 finding 走 evaluateRepairAuthorization fail-closed 授权。authorityClass 选
 * author_declaration（→ hard_constraint），sourceContentHash / evidenceExcerptHash 非空。
 */
function buildEvidenceRecords(findings) {
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
      snapshotId: SNAPSHOT_ID,
      traceable: true,
    });
  }
  return [...byId.values()];
}

function makeFinding({
  id,
  source = "intent_omission_checker",
  failureType = "intent_omission",
  conflictFact = `missing ${id}`,
  sourceRef = `author-outline:${id}`,
  description = conflictFact,
}) {
  return {
    id,
    source,
    failureType,
    severity: "hard",
    span: { start: 0, end: 3, excerpt: "" },
    conflictFact,
    sourceRef,
    // RRB-3.7：修订授权需要确定性 + 可回源 evidenceId；默认回源到 sourceRef。
    evidenceId: sourceRef,
    confidence: 1,
    // 有效 span（end > start 且不越界），否则会被 selectRepairFindings / 授权拒绝。
    allowedRepairRange: { start: 0, end: 3, excerpt: "" },
    description,
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

function makeHarness({ reports, patchedTexts, maxRepairRounds = 10 }) {
  const prompts = [];
  const feedbackBatches = [];
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
      this.agent.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text }],
      });
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
      feedbackBatches.push(feedbacks);
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

  // RRB-3.7：候选工作区必须是真实 dryRun 实例，提供 writeDraft → createCandidate →
  // advanceCurrentCandidate → getCurrentCandidateId → readCandidateManifest →
  // readCandidateText → deriveChildCandidate 的不可变候选链路。noOpStore Proxy 无法
  // 支撑授权所需的候选身份（candidateId + textHash），会导致 readCurrentManifest=null
  // 而 fail-closed 拒绝全部修订。
  const candidateWorkspace = createCandidateWorkspace({
    workspaceRoot: "novelos-repair-convergence-test",
    sessionId: "novelos-test-session",
    dryRun: true,
  });

  const evidenceRecords = buildEvidenceRecords(
    reports.flatMap((report) => report.hardFindings),
  );

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
  });

  return { loop, prompts, feedbackBatches, evidenceRecords };
}

function runLoop(loop, evidenceRecords) {
  return loop.run({
    chapterIntent: "作者章纲事件顺序：\n  1. 事件一\n作者章纲必须包含：锚点一",
    seedContext: "seed",
    context: EMPTY_CONTEXT,
    snapshotId: SNAPSHOT_ID,
    evidenceRecords,
  });
}

test("高约束章纲每轮只修复有限批次，并优先事实与原句约束", async () => {
  const fact = makeFinding({
    id: "fact-1",
    source: "canon_guard",
    failureType: "fact_contradiction",
    conflictFact: "角色眼睛颜色与 canon 冲突",
    sourceRef: "canon:character:eyes",
  });
  const verbatim = makeFinding({
    id: "verbatim-1",
    conflictFact: "作者章纲必须包含项「原句：潮声停了」在正文中遗漏",
    sourceRef: "author-outline:原句：潮声停了",
  });
  const anchors = Array.from({ length: 27 }, (_, index) => makeFinding({
    id: `anchor-${index + 1}`,
    sourceRef: `author-outline:锚点${index + 1}`,
  }));
  const events = Array.from({ length: 5 }, (_, index) => makeFinding({
    id: `event-${index + 1}`,
    source: "event_intent_checker",
    conflictFact: `作者章纲事件 ${index + 1} 在正文中缺少事件级覆盖`,
    sourceRef: `author-outline:event:${index + 1}`,
  }));
  const hardFindings = [events[0], ...anchors, ...events.slice(1), verbatim, fact];
  const { loop, prompts, feedbackBatches, evidenceRecords } = makeHarness({
    reports: [makeReport(hardFindings), makeReport(hardFindings)],
    patchedTexts: ["第一轮已接受候选。人物走进现场，开始调查并核对事实。"],
    maxRepairRounds: 1,
  });

  const result = await runLoop(loop, evidenceRecords);

  assert.equal(feedbackBatches[0].length, 4);
  assert.deepEqual(
    feedbackBatches[0].map((feedback) => feedback.findingId).slice(0, 2),
    ["fact-1", "verbatim-1"],
  );
  assert.equal(feedbackBatches[0].some((feedback) => feedback.findingId.startsWith("event-")), false);
  assert.match(prompts[1], /fact-1/);
  assert.match(prompts[1], /canon:character:eyes/);
  assert.match(prompts[1], /角色眼睛颜色与 canon 冲突/);
  assert.equal(result.verifierCleared, undefined);
  assert.equal(result.lineage.verifierCleared, false);
  assert.equal(result.text, "第一轮已接受候选。人物走进现场，开始调查并核对事实。");
});

test("连续两轮 hard finding 无减少时停止，不耗尽全部修复预算", async () => {
  const unchanged = makeReport([
    makeFinding({ id: "anchor-stuck", sourceRef: "author-outline:始终遗漏的锚点" }),
  ]);
  const { loop, prompts, evidenceRecords } = makeHarness({
    reports: [unchanged, unchanged, unchanged, unchanged],
    patchedTexts: [
      "第一轮已接受候选。人物进入现场，继续调查。",
      "第二轮已接受候选。人物进入现场，继续调查并回望线索。",
      "不应执行的第三轮。",
    ],
    maxRepairRounds: 10,
  });

  const result = await runLoop(loop, evidenceRecords);

  assert.equal(result.repairRounds, 2);
  assert.equal(prompts.length, 3, "一次初稿调用加两次修复调用");
  assert.equal(result.lineage.stopReason, "stagnant");
  assert.equal(result.lineage.verifierCleared, false);
  assert.equal(result.text, "第二轮已接受候选。人物进入现场，继续调查并回望线索。");
});

test("事件级遗漏进入修复批次时携带完整事件摘要", async () => {
  const eventFinding = makeFinding({
    id: "event-5",
    source: "event_intent_checker",
    conflictFact: "作者章纲事件 5 在正文中缺少事件级覆盖",
    sourceRef: "author-outline:event:5",
    description: "作者章纲事件遗漏：回程时木心微亮，但墨老仍未醒",
  });
  const report = makeReport([eventFinding]);
  const { loop, prompts, evidenceRecords } = makeHarness({
    reports: [report, makeReport([])],
    patchedTexts: ["修复候选。回程时木心微亮，但墨老仍未醒。"],
    maxRepairRounds: 1,
  });

  const result = await runLoop(loop, evidenceRecords);

  assert.match(prompts[1], /回程时木心微亮，但墨老仍未醒/);
  assert.equal(result.lineage.verifierCleared, true);
});

test("hard finding 持续减少时继续下一批并在清零后通过", async () => {
  const first = [1, 2, 3, 4].map((index) => makeFinding({ id: `anchor-${index}` }));
  const second = first.slice(2);
  const { loop, evidenceRecords } = makeHarness({
    reports: [makeReport(first), makeReport(second), makeReport([])],
    patchedTexts: [
      "第一轮候选。人物调查并处理前两个锚点。",
      "第二轮候选。人物调查并处理全部锚点。",
    ],
  });

  const result = await runLoop(loop, evidenceRecords);

  assert.equal(result.repairRounds, 2);
  assert.equal(result.lineage.verifierCleared, true);
  assert.equal(result.lineage.stopReason, "cleared");
  assert.equal(result.text, "第二轮候选。人物调查并处理全部锚点。");
});
