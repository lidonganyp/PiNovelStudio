/**
 * 最小验收矩阵补全测试（REASONING-REPAIR-BOUNDARY-1 Wave 5 / RRB-6.1）
 *
 * 对照计划 §7 最小验收矩阵 T01-T28，补齐此前仅做结构断言（RED G1-G6）或未覆盖的
 * 行为级用例：
 *
 *   T10  多 span 同轮修订 → 按授权范围联合校验（gap 保留时接受）
 *   T11  span 重叠 → 整轮拒绝，current pointer 不变
 *   T12  任一授权 span 外有一字变化 → 整轮拒绝（前缀 / 后缀 / span 间插入 / gap 篡改）
 *   T19  相同/不同模型负责写作与局部修复 → 授权只来自外部证据与系统，与模型身份无关
 *        （RRB-6.3：准入结果不得取决于“换了模型”）
 *
 * T01-T09 / T13-T18 / T20-T27 已在 wave1/1b/2a-red/2b/2c/4a/4a-budget/4b/4c 与
 * production-agentic-style-flow 中覆盖；T28 属 Wave 6（RRB-6.5/6.6 clean checkout）。
 *
 * 注意：T10/T11/T12 的判定逻辑在 novelos/agent/candidate-patch-service.ts 的
 * checkSpanImmutability（RRB-3.3 落地）；本文件是行为级回归，非结构断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createCandidatePatchService } from "../dist/novelos/agent/candidate-patch-service.js";
import { evaluateRepairAuthorization } from "../dist/v2/core/repair-authorization-policy.js";

// ============================================================================
// 共享 fixture
// ============================================================================

const svc = createCandidatePatchService();

// 原文按 5 字一段切分：A[0,5) B[5,10) C[10,15) D[15,20)
const ORIGINAL = "AAAAABBBBBCCCCCDDDDD";

function span(start, end) {
  return { start, end, excerpt: ORIGINAL.slice(start, end) };
}

// ============================================================================
// T10 — 多 span 联合校验：只改 span 内、gap 保留 → 接受
// ============================================================================

test("T10: 多 span 同轮修订，gap 与 span 外保留 → accepted", () => {
  const ranges = [span(0, 5), span(10, 15)]; // 改 A 段与 C 段，B 段为不可变 gap
  const patched = "XXXXXBBBBBYYYYYDDDDD";
  const result = svc.evaluatePatch(ORIGINAL, patched, ranges);
  assert.equal(result.accepted, true, `应接受：${result.reason}`);
  assert.equal(result.metrics.spanImmutabilityPassed, true);
});

// ============================================================================
// T11 — span 重叠 → 整轮拒绝
// ============================================================================

test("T11: 授权 span 重叠 → 整轮拒绝，current pointer 不变", () => {
  const overlapping = [span(2, 8), span(5, 12)]; // [2,8) 与 [5,12) 重叠
  const result = svc.evaluatePatch(ORIGINAL, ORIGINAL, overlapping);
  assert.equal(result.accepted, false);
  assert.equal(result.metrics.spanImmutabilityPassed, false);
  assert.match(result.metrics.spanViolationDetail ?? "", /重叠/);
});

test("T11: 授权 span 越界 → 整轮拒绝", () => {
  const outOfBounds = [span(0, 5), span(10, 25)]; // 第二个 span end=25 > len 20
  const result = svc.evaluatePatch(ORIGINAL, ORIGINAL, outOfBounds);
  assert.equal(result.accepted, false);
  assert.equal(result.metrics.spanImmutabilityPassed, false);
  assert.match(result.metrics.spanViolationDetail ?? "", /越界|非法/);
});

test("T11: 授权 span 倒置 → 整轮拒绝", () => {
  const inverted = [span(0, 5), span(12, 8)]; // start > end
  const result = svc.evaluatePatch(ORIGINAL, ORIGINAL, inverted);
  assert.equal(result.accepted, false);
  assert.equal(result.metrics.spanImmutabilityPassed, false);
});

// ============================================================================
// T12 — 任一授权 span 外一字变化 → 整轮拒绝
// ============================================================================

test("T12: span 外前缀被修改 → 整轮拒绝", () => {
  const ranges = [span(5, 10)]; // 只授权 B 段
  const patched = "ZZZZZBBBBBCCCCCDDDDD"; // A 段（前缀）被改成 Z
  const result = svc.evaluatePatch(ORIGINAL, patched, ranges);
  assert.equal(result.accepted, false);
  assert.equal(result.metrics.spanImmutabilityPassed, false);
  assert.match(result.metrics.spanViolationDetail ?? "", /前缀/);
});

test("T12: span 外后缀被修改 → 整轮拒绝", () => {
  const ranges = [span(5, 10)]; // 只授权 B 段
  const patched = "AAAAABBBBBCCCCCDDDDZ"; // D 段末字（后缀）被改
  const result = svc.evaluatePatch(ORIGINAL, patched, ranges);
  assert.equal(result.accepted, false);
  assert.equal(result.metrics.spanImmutabilityPassed, false);
  assert.match(result.metrics.spanViolationDetail ?? "", /后缀/);
});

test("T10: 三个授权 span 多 gap 按序保留 → accepted", () => {
  const three = "AAAAABBBBBCCCCCDDDDDEEEEE"; // A/B/C/D/E 各 5 字
  const ranges = [
    { start: 0, end: 5, excerpt: "" }, // A 段
    { start: 10, end: 15, excerpt: "" }, // C 段
    { start: 20, end: 25, excerpt: "" }, // E 段
  ];
  // 改 A/C/E，gap B、D 逐字保留
  const patched = "XXXXXBBBBBYYYYYDDDDDZZZZZ";
  const result = svc.evaluatePatch(three, patched, ranges);
  assert.equal(result.accepted, true, `应接受：${result.reason}`);
  assert.equal(result.metrics.spanImmutabilityPassed, true);
});

test("T12: span 间 gap 被篡改/缺失 → 整轮拒绝", () => {
  const ranges = [span(0, 5), span(10, 15)];
  const patched = "XXXXXQQQQQYYYYYDDDDD"; // gap "BBBBB" 被替换为 QQQQQ
  const result = svc.evaluatePatch(ORIGINAL, patched, ranges);
  assert.equal(result.accepted, false);
  assert.equal(result.metrics.spanImmutabilityPassed, false);
  assert.match(result.metrics.spanViolationDetail ?? "", /不可变段/);
});

test("T12: 三个 span 中第二个 gap 被篡改 → 整轮拒绝", () => {
  const three = "AAAAABBBBBCCCCCDDDDDEEEEE";
  const ranges = [
    { start: 0, end: 5, excerpt: "" },
    { start: 10, end: 15, excerpt: "" },
    { start: 20, end: 25, excerpt: "" },
  ];
  // 第一个 gap "BBBBB" 保留，第二个 gap "DDDDD" 被篡改为 "QQQQQ"
  const patched = "XXXXXBBBBBYYYYYQQQQQZZZZZ";
  const result = svc.evaluatePatch(three, patched, ranges);
  assert.equal(result.accepted, false);
  assert.equal(result.metrics.spanImmutabilityPassed, false);
  assert.match(result.metrics.spanViolationDetail ?? "", /不可变段/);
});

test("T12: 无授权 range 但正文被修改 → 整轮拒绝", () => {
  const result = svc.evaluatePatch(ORIGINAL, "XXXXXBBBBBCCCCCDDDDD", []);
  assert.equal(result.accepted, false);
  assert.equal(result.metrics.spanImmutabilityPassed, false);
});

// ============================================================================
// T19 / RRB-6.3 — 相同/不同模型：授权结果与模型身份无关
// ============================================================================

function policyInput(overrides = {}) {
  const finding = {
    id: "f-001",
    source: "entity_checker",
    failureType: "entity_hallucination",
    severity: "hard",
    span: { start: 10, end: 20, excerpt: "test" },
    conflictFact: "角色 X 不在档案中",
    sourceRef: "entity_checker",
    evidenceId: "ev-001",
    confidence: 1.0,
    allowedRepairRange: { start: 10, end: 20, excerpt: "" },
    description: "测试用 finding",
    certainty: "deterministic",
    coverageStatus: "missing",
    ...overrides,
  };
  return {
    finding,
    evidenceRecords: [
      {
        evidenceId: "ev-001",
        statement: "角色 X 在档案中定义为 Y",
        authorityClass: "author_declaration",
        epistemicStatus: "confirmed",
        sourceRef: "character:1",
        sourceContentHash: "abc123def456",
        evidenceExcerptHash: "xyz789uvw012",
        validFrom: null,
        validUntil: null,
        matchedBecause: ["exact_match"],
        retrievalQueryId: "q-001",
        snapshotId: "snap-001",
        traceable: true,
      },
    ],
    candidateId: "s1-agentic_generation-abc123def4567890-0",
    candidateTextHash: "abc123",
    candidateTextLength: 100,
    snapshotId: "snap-001",
    budgetAvailable: true,
  };
}

test("T19: 相同模型负责写作与局部修复 → 授权仍只来自外部证据与系统", () => {
  // 写作与修复都由同一模型（sourceModel=model-A）产出，不影响授权准入。
  const result = evaluateRepairAuthorization(
    policyInput({ sourceModel: "model-A", model: "model-A" }),
  );
  assert.equal(result.decision, "authorized");
  assert.equal(result.action, "span_patch");
});

test("RRB-6.3: 换成不同模型，授权结果与授权范围完全一致（不取决于换模型）", () => {
  const a = evaluateRepairAuthorization(policyInput({ sourceModel: "model-A" }));
  const b = evaluateRepairAuthorization(policyInput({ sourceModel: "model-B" }));
  assert.equal(a.decision, b.decision);
  assert.equal(a.action, b.action);
  assert.equal(a.reasonCode, b.reasonCode);
  assert.deepEqual(
    a.authorization?.authorizedRanges,
    b.authorization?.authorizedRanges,
  );
  assert.deepEqual(
    a.authorization?.evidenceIds,
    b.authorization?.evidenceIds,
  );
});

test("RRB-6.3: 模型自报 approved=true 或伪造 sourceRef 不改变系统授权", () => {
  // 与 T20 同口径：模型对自身的背书不是授权来源。
  const baseline = evaluateRepairAuthorization(policyInput());
  const forged = evaluateRepairAuthorization(
    policyInput({ approved: true, sourceRef: "model_forged_authority" }),
  );
  assert.equal(forged.decision, baseline.decision);
  assert.equal(forged.action, baseline.action);
});
