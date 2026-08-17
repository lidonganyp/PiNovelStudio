/**
 * GREEN 测试：修订循环结构化退出原因（REASONING-REPAIR-BOUNDARY-1 Wave 4A / RRB-4.4）
 *
 * 锁定 Wave 4A 的期望行为：修订循环退出原因收敛为 RepairStopReason 单一可解释枚举，
 * 不再把 no_authorized_action / stale_authorization / comparator_rejected /
 * new_hard_finding 折叠成 stagnant。
 *
 * 对照计划 §7 最小验收矩阵：
 *   T02  EvidenceRecord 缺 authority/snapshot/source hash/excerpt hash → no_op/block，正文 hash 不变
 *   T03  evidence snapshot 与 candidate run 不一致 → stale authorization，零修改
 *   T13  comparator 拒绝 → parent/current candidateId 与 hash 不变
 *   T14  patch 解决旧 finding 但产生新 hard finding → child 拒绝，不成为 current
 *   T16  patch 通过全部门禁 → 生成新 candidateId（stopReason=cleared）
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NarrativeAgentLoop,
  classifyNoAuthorizationStopReason,
} from "../dist/novelos/agent/narrative-agent-loop.js";
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
// 纯函数：无授权动作 → RepairStopReason 细分
// ============================================================================

test("classifyNoAuthorizationStopReason: stale 理由码 → stale_authorization", () => {
  assert.equal(
    classifyNoAuthorizationStopReason(["deny_missing_evidence", "deny_stale_snapshot"]),
    "stale_authorization",
  );
  assert.equal(
    classifyNoAuthorizationStopReason(["deny_stale_candidate_hash"]),
    "stale_authorization",
  );
  assert.equal(
    classifyNoAuthorizationStopReason(["deny_evidence_hash_mismatch"]),
    "stale_authorization",
  );
});

test("classifyNoAuthorizationStopReason: require_block/require_input_revision → blocked", () => {
  assert.equal(
    classifyNoAuthorizationStopReason(["require_block"]),
    "blocked",
  );
  assert.equal(
    classifyNoAuthorizationStopReason(["require_input_revision"]),
    "blocked",
  );
});

test("classifyNoAuthorizationStopReason: require_new_candidate → request_new_candidate", () => {
  assert.equal(
    classifyNoAuthorizationStopReason(["require_new_candidate"]),
    "request_new_candidate",
  );
});

test("classifyNoAuthorizationStopReason: 其余 → no_authorized_action", () => {
  assert.equal(
    classifyNoAuthorizationStopReason(["deny_missing_evidence"]),
    "no_authorized_action",
  );
  assert.equal(
    classifyNoAuthorizationStopReason(["deny_insufficient_certainty", "deny_invalid_span"]),
    "no_authorized_action",
  );
  assert.equal(
    classifyNoAuthorizationStopReason([]),
    "no_authorized_action",
  );
});

test("classifyNoAuthorizationStopReason: stale 优先级高于 require_block", () => {
  // stale 一致性失效比「动作不允许」更应优先暴露（正文 hash/snapshot 已过期）。
  assert.equal(
    classifyNoAuthorizationStopReason(["require_block", "deny_stale_snapshot"]),
    "stale_authorization",
  );
});

// ============================================================================
// Loop 级：修订循环产出单一可解释 stopReason
// ============================================================================

/** RRB-3.7：从 findings 构建权威证据记录（按 evidenceId 索引）。 */
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

function makeFinding({
  id,
  source = "canon_guard",
  failureType = "fact_contradiction",
  conflictFact = `missing ${id}`,
  sourceRef = `canon:${id}`,
  span = { start: 0, end: 3 },
}) {
  return {
    id,
    source,
    failureType,
    severity: "hard",
    span: { ...span, excerpt: "" },
    conflictFact,
    sourceRef,
    evidenceId: sourceRef,
    confidence: 1,
    allowedRepairRange: { ...span, excerpt: "" },
    description: conflictFact,
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

function makeHarness({
  reports,
  patchedTexts,
  maxRepairRounds = 10,
  evaluatePatchResult = { accepted: true, reason: "improved", metrics: {} },
}) {
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
      return evaluatePatchResult;
    },
  };

  const noOpStore = new Proxy({}, { get: () => () => {} });
  const budget = {
    isExhausted: () => false,
    getSnapshot: () => ({ turns: prompts.length, toolCalls: 0 }),
  };

  const candidateWorkspace = createCandidateWorkspace({
    workspaceRoot: "repair-boundary-wave4a-test",
    sessionId: "wave4a-test-session",
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
  });

  return { loop, prompts };
}

function runLoop(loop, evidenceRecords, snapshotId = SNAPSHOT_ID) {
  return loop.run({
    chapterIntent: "作者章纲事件顺序：\n  1. 事件一",
    seedContext: "seed",
    context: EMPTY_CONTEXT,
    snapshotId,
    evidenceRecords,
  });
}

test("RRB-4.4: 全部 finding 缺权威证据 → no_authorized_action（正文不变）", async () => {
  const finding = makeFinding({ id: "f1", sourceRef: "canon:f1" });
  const { loop } = makeHarness({
    reports: [makeReport([finding]), makeReport([finding])],
    patchedTexts: ["不应生成的修订文本。"],
  });

  // 空 evidenceRecords → evaluateRepairAuthorization 返回 deny_missing_evidence。
  const result = await runLoop(loop, []);

  assert.equal(result.lineage.stopReason, "no_authorized_action");
  assert.equal(result.lineage.verifierCleared, false);
  assert.equal(result.text, "初始草稿。人物走进现场，开始调查。");
});

test("RRB-4.4: evidence snapshot 与候选不一致 → stale_authorization（零修改）", async () => {
  const finding = makeFinding({ id: "f1", sourceRef: "canon:f1" });
  const { loop } = makeHarness({
    reports: [makeReport([finding]), makeReport([finding])],
    patchedTexts: ["不应生成的修订文本。"],
  });

  // 证据 snapshotId=stale-snap，候选 snapshotId=snap-test → deny_stale_snapshot。
  const evidenceRecords = buildEvidenceRecords([finding], "stale-snap");
  const result = await runLoop(loop, evidenceRecords);

  assert.equal(result.lineage.stopReason, "stale_authorization");
  assert.equal(result.lineage.verifierCleared, false);
  assert.equal(result.text, "初始草稿。人物走进现场，开始调查。");
});

test("RRB-4.4: comparator 拒绝 → comparator_rejected（current pointer 不变）", async () => {
  const finding = makeFinding({ id: "f1", sourceRef: "canon:f1" });
  const { loop } = makeHarness({
    reports: [makeReport([finding]), makeReport([finding])],
    patchedTexts: ["模型产出的修订文本。"],
    evaluatePatchResult: { accepted: false, reason: "degraded", metrics: {} },
  });
  const evidenceRecords = buildEvidenceRecords([finding]);
  const result = await runLoop(loop, evidenceRecords);

  assert.equal(result.lineage.stopReason, "comparator_rejected");
  assert.equal(result.lineage.verifierCleared, false);
  // comparator 拒绝后不推进 current pointer → 正文仍是初稿
  assert.equal(result.text, "初始草稿。人物走进现场，开始调查。");
});

test("RRB-4.4: patch 引入新 hard finding → new_hard_finding（child 拒绝）", async () => {
  const oldFinding = makeFinding({
    id: "old-1",
    failureType: "fact_contradiction",
    sourceRef: "canon:old",
  });
  const newFinding = makeFinding({
    id: "new-1",
    failureType: "fact_omission",
    sourceRef: "canon:new",
    span: { start: 5, end: 8 },
  });
  const { loop } = makeHarness({
    // 首轮 verify 报告 old-1；reverify 报告 new-1（identity 换新）。
    reports: [makeReport([oldFinding]), makeReport([newFinding])],
    patchedTexts: ["模型产出的修订文本。"],
  });
  // 两个 finding 都有权威证据记录（否则授权阶段就拒绝，到不了 new_hard_finding 分支）。
  const evidenceRecords = buildEvidenceRecords([oldFinding, newFinding]);
  const result = await runLoop(loop, evidenceRecords);

  assert.equal(result.lineage.stopReason, "new_hard_finding");
  assert.equal(result.lineage.verifierCleared, false);
  // 新 hard finding child 被拒绝，不成为 current → 正文仍是初稿
  assert.equal(result.text, "初始草稿。人物走进现场，开始调查。");
});

test("RRB-4.4: 清零 → cleared", async () => {
  const finding = makeFinding({ id: "f1", sourceRef: "canon:f1" });
  const { loop } = makeHarness({
    // 首轮有 hard finding，reverify 清零。
    reports: [makeReport([finding]), makeReport([])],
    patchedTexts: ["修复后的文本。"],
  });
  const evidenceRecords = buildEvidenceRecords([finding]);
  const result = await runLoop(loop, evidenceRecords);

  assert.equal(result.lineage.stopReason, "cleared");
  assert.equal(result.lineage.verifierCleared, true);
  assert.equal(result.text, "修复后的文本。");
});
