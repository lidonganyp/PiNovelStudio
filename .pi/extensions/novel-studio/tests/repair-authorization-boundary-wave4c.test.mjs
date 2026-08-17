/**
 * GREEN 测试：审计 / Review Surface / 入口边界（REASONING-REPAIR-BOUNDARY-1 Wave 4C / RRB-5.4~5.7）
 *
 * 锁定 Wave 4C 的期望行为：
 * - RRB-5.4：AuditEvent 记录 decision summary、evidence refs/hash、授权动作、
 *   parent/child candidate、接受/拒绝结果和 stopReason；payload 禁止原始思维链。
 * - RRB-5.5：文学软诊断只进 Review Surface，生产计数断言 `literary_advisory_auto_edits=0`。
 * - RRB-5.6：失败分类区分 verification_blocked / repair_unauthorized /
 *   candidate_integrity / repair_stagnant / new_candidate_required；禁止笼统“修订失败”。
 * - RRB-5.7：`novel_generate_chapter` 仍是唯一公开章节生成入口；不暴露 repair /
 *   new candidate / verifier 为可绕过编排器的公开正文入口。
 *
 * 对照计划 §7 最小验收矩阵：
 *   T05  review/info 文学诊断 → 只进 Review Surface，自动修改 0 次
 *   T26  trace schema 扫描 → 只含摘要、证据、动作、hash；不含原始思维链
 *   T27  生产工具注册 → novel_generate_chapter 仍是唯一公开章节生成入口
 * 对照计划 §8 门槛：
 *   文学软诊断触发自动修改 = 0；原始思维链持久化 = 0；公开入口数量不变
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REPAIR_FAILURE_CATEGORIES,
  repairStopReasonToFailureCategory,
  repairReasonCodeToFailureCategory,
  countLiteraryAdvisoryAutoEdits,
  isAutoEditingAction,
  FAILURE_TYPE_TO_ALLOWED_ACTION,
} from "../dist/v2/core/repair-authorization-contracts.js";
import { evaluateRepairAuthorization } from "../dist/v2/core/repair-authorization-policy.js";
import {
  validateAuditEvent,
  createAuditEvent,
  findBannedReasoningFieldPaths,
} from "../dist/v2/core/audit/audit-event-schema.js";
import { REASONING_CHAIN_OF_THOUGHT_BANNED_FIELDS } from "../dist/v2/core/audit/audit-event-types.js";
import { registerTools } from "../dist/tools/register-tools.js";

// ============================================================================
// 共享构造器
// ============================================================================

function makeValidEvent(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    traceId: "trc-wave4c-test",
    runId: "run-wave4c-test",
    eventId: "evt-wave4c-test",
    parentEventId: null,
    sequence: 1,
    timestamp: 1_700_000_000_000,
    actor: "orchestrator",
    stage: "repair",
    eventType: "repair_completed",
    status: "completed",
    evidenceLevel: "confirmed",
    ...overrides,
  };
}

// ============================================================================
// RRB-5.6：失败分类五类可区分，禁止笼统“修订失败”
// ============================================================================

test("RRB-5.6: REPAIR_FAILURE_CATEGORIES 恰为五个可区分值", () => {
  assert.equal(REPAIR_FAILURE_CATEGORIES.length, 5);
  assert.deepEqual(
    [...REPAIR_FAILURE_CATEGORIES].sort(),
    [
      "candidate_integrity",
      "new_candidate_required",
      "repair_stagnant",
      "repair_unauthorized",
      "verification_blocked",
    ],
  );
  // 全部非笼统值
  for (const c of REPAIR_FAILURE_CATEGORIES) {
    assert.ok(
      !["修订失败", "failed", "unknown", "repair_failed"].includes(c),
      `类别不得为笼统值：${c}`,
    );
  }
});

test("RRB-5.6: RepairStopReason → 失败分类映射（逐一可解释）", () => {
  assert.equal(repairStopReasonToFailureCategory("stagnant"), "repair_stagnant");
  assert.equal(repairStopReasonToFailureCategory("budget_exhausted"), "repair_unauthorized");
  assert.equal(repairStopReasonToFailureCategory("no_authorized_action"), "repair_unauthorized");
  assert.equal(repairStopReasonToFailureCategory("stale_authorization"), "repair_unauthorized");
  assert.equal(repairStopReasonToFailureCategory("comparator_rejected"), "candidate_integrity");
  assert.equal(repairStopReasonToFailureCategory("new_hard_finding"), "candidate_integrity");
  assert.equal(repairStopReasonToFailureCategory("request_new_candidate"), "new_candidate_required");
  assert.equal(repairStopReasonToFailureCategory("blocked"), "verification_blocked");
  // cleared 非失败
  assert.equal(repairStopReasonToFailureCategory("cleared"), null);
});

test("RRB-5.6: RepairReasonCode → 失败分类映射（deny_* 归 repair_unauthorized）", () => {
  const denyCodes = [
    "deny_missing_authority",
    "deny_missing_evidence",
    "deny_missing_snapshot",
    "deny_missing_content_hash",
    "deny_missing_excerpt_hash",
    "deny_source_ref_not_authoritative",
    "deny_diagnostic_id_as_source_ref",
    "deny_missing_lineage",
    "deny_stale_snapshot",
    "deny_stale_candidate_hash",
    "deny_evidence_hash_mismatch",
    "deny_invalid_span",
    "deny_overlapping_span",
    "deny_out_of_bounds_span",
    "deny_range_outside_authorized",
    "deny_heuristic_finding",
    "deny_insufficient_certainty",
    "deny_action_not_allowed_for_failure_type",
    "deny_missing_bridge_anchor",
    "deny_not_orchestrator_issued",
    "deny_budget_exhausted",
  ];
  for (const code of denyCodes) {
    assert.equal(
      repairReasonCodeToFailureCategory(code),
      "repair_unauthorized",
      `${code} 应归 repair_unauthorized`,
    );
  }
  assert.equal(repairReasonCodeToFailureCategory("require_new_candidate"), "new_candidate_required");
  // 显式非失败出口
  assert.equal(repairReasonCodeToFailureCategory("authorized"), null);
  assert.equal(repairReasonCodeToFailureCategory("require_block"), null);
  assert.equal(repairReasonCodeToFailureCategory("require_human_review"), null);
  assert.equal(repairReasonCodeToFailureCategory("require_input_revision"), null);
});

// ============================================================================
// RRB-5.5：文学软诊断只进 Review Surface，自动修改 0 次
// ============================================================================

test("RRB-5.5: countLiteraryAdvisoryAutoEdits 对 language_risk 自动编辑动作计数", () => {
  assert.equal(
    countLiteraryAdvisoryAutoEdits([{ failureType: "language_risk", action: "span_patch" }]),
    1,
  );
  assert.equal(
    countLiteraryAdvisoryAutoEdits([{ failureType: "language_risk", action: "paragraph_patch" }]),
    1,
  );
  assert.equal(
    countLiteraryAdvisoryAutoEdits([{ failureType: "language_risk", action: "new_candidate" }]),
    1,
  );
});

test("RRB-5.5: 文学软诊断正常路径自动编辑恒为 0", () => {
  assert.equal(
    countLiteraryAdvisoryAutoEdits([{ failureType: "language_risk", action: "no_op" }]),
    0,
  );
  assert.equal(
    countLiteraryAdvisoryAutoEdits([{ failureType: "language_risk", action: "human_review" }]),
    0,
  );
  // 非文学 finding 不计数
  assert.equal(
    countLiteraryAdvisoryAutoEdits([{ failureType: "fact_contradiction", action: "span_patch" }]),
    0,
  );
});

test("RRB-5.5: 白名单保证 language_risk 无自动编辑动作，且策略不签发自动授权", () => {
  // 契约白名单：language_risk 只允许 no_op / human_review。
  const allowed = FAILURE_TYPE_TO_ALLOWED_ACTION.language_risk;
  assert.deepEqual([...allowed].sort(), ["human_review", "no_op"]);
  assert.ok(allowed.every((a) => !isAutoEditingAction(a)));

  // 真实策略：对语言软诊断 finding，决策 action 非自动编辑。
  const decision = evaluateRepairAuthorization({
    finding: {
      id: "f-lang",
      source: "style_guard",
      failureType: "language_risk",
      severity: "hard",
      certainty: "deterministic",
      span: { start: 0, end: 3, excerpt: "" },
      allowedRepairRange: { start: 0, end: 3, excerpt: "" },
      evidenceId: "ev-lang",
      conflictFact: "语气偏生硬",
      sourceRef: "diagnostic:lang",
      confidence: 1,
    },
    evidenceRecords: [
      {
        evidenceId: "ev-lang",
        statement: "语气偏生硬",
        authorityClass: "author_declaration",
        epistemicStatus: "confirmed",
        sourceRef: "diagnostic:lang",
        sourceContentHash: "src-hash-lang",
        evidenceExcerptHash: "excerpt-hash-lang",
        validFrom: null,
        validUntil: null,
        matchedBecause: [],
        retrievalQueryId: null,
        snapshotId: "snap-1",
        traceable: true,
      },
    ],
    candidateId: "session-1-agentic_generation-deadbeefdeadbeef-0",
    candidateTextHash: "deadbeefdeadbeef000000000000000000000000000000000000000000000000",
    candidateTextLength: 100,
    snapshotId: "snap-1",
    budgetAvailable: true,
  });

  assert.equal(decision.decision, "denied");
  assert.ok(
    !isAutoEditingAction(decision.action),
    `language_risk 不得产生自动编辑动作，实际 action=${decision.action}`,
  );
});

// ============================================================================
// RRB-5.4：AuditEvent 记录动作/停止原因，payload 禁止原始思维链（T26）
// ============================================================================

test("RRB-5.4: AuditEvent 支持 action + stopReason 字段并通过校验", () => {
  const result = validateAuditEvent(
    makeValidEvent({
      action: "span_patch",
      stopReason: "cleared",
      decisionReason: "允许目标 span 修复",
      candidateId: "session-1-agentic_generation-deadbeefdeadbeef-0",
      parentCandidateId: null,
      sourceRefs: [{ kind: "chapter", id: "ch1", contentHash: "abc123" }],
      artifactRefs: [{ artifactId: "candidates/x.md", kind: "candidate_text", contentHash: "def456" }],
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("RRB-5.4: payload 顶层原始思维链字段被拒（reasoning_content）", () => {
  const result = validateAuditEvent(
    makeValidEvent({ payload: { reasoning_content: "我认为应该这样写……" } }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "payload.reasoning_content"));
});

test("RRB-5.4: payload 嵌套原始思维链字段被拒（nested.thinking）", () => {
  const result = validateAuditEvent(
    makeValidEvent({
      payload: { meta: { thinking: "内部推理不应落盘" }, summary: "决策摘要" },
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "payload.meta.thinking"));
});

test("RRB-5.4: 合法 payload（决策摘要 + hash + 动作，无思维链）通过校验", () => {
  const result = validateAuditEvent(
    makeValidEvent({
      payload: {
        summary: "span 修复完成",
        evidenceHash: "abc123",
        action: "span_patch",
        parentCandidateId: null,
        stopReason: "cleared",
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("RRB-5.4: createAuditEvent 对含思维链 payload 抛错", () => {
  assert.throws(
    () =>
      createAuditEvent({
        traceId: "trc-wave4c-test",
        runId: "run-wave4c-test",
        parentEventId: null,
        sequence: 1,
        actor: "orchestrator",
        stage: "repair",
        eventType: "repair_completed",
        status: "completed",
        evidenceLevel: "confirmed",
        action: "span_patch",
        stopReason: "cleared",
        payload: { chain_of_thought: "内部推理" },
      }),
    /Invalid AuditEvent/,
  );
});

test("RRB-5.4: findBannedReasoningFieldPaths 命中并返回相对路径", () => {
  assert.deepEqual(
    findBannedReasoningFieldPaths({ reasoning_content: "x", ok: 1 }),
    ["reasoning_content"],
  );
  assert.deepEqual(
    findBannedReasoningFieldPaths({ a: { b: { thinking: "x" } }, safe: "v" }),
    ["a.b.thinking"],
  );
  assert.deepEqual(findBannedReasoningFieldPaths({ safe: "v", nested: { k: 1 } }), []);
});

test("RRB-5.4: 思维链黑名单覆盖常见模型内部字段", () => {
  for (const key of ["reasoning_content", "thinking", "chain_of_thought", "internal_monologue"]) {
    assert.ok(
      REASONING_CHAIN_OF_THOUGHT_BANNED_FIELDS.includes(key),
      `黑名单应包含 ${key}`,
    );
  }
});

// ============================================================================
// RRB-5.7：novel_generate_chapter 唯一公开生成入口，无 bypass 工具（T27）
// ============================================================================

function makeStubHandlers() {
  return new Proxy({}, { get: () => async () => ({}) });
}

test("RRB-5.7: 公开工具恰为 6 个，且不含 repair / new-candidate / verifier 绕过入口", () => {
  const tools = registerTools(makeStubHandlers());
  const names = tools.map((t) => t.name);

  assert.equal(names.length, 6, `公开工具数应为 6，实际: ${names.join(", ")}`);

  // 唯一公开章节生成入口
  assert.ok(names.includes("novel_generate_chapter"), "应保留 novel_generate_chapter");

  // 禁止 bypass：repair / new candidate / verifier / 单阶段 narrator 均不得成为公开正文入口。
  const forbidden = [
    "novel_repair_candidate",
    "novel_new_candidate",
    "novel_verify_candidate",
    "novel_verifier",
    "novel_narrator",
    "novel_critic",
    "novel_patch_candidate",
    "novel_author_style_transform",
  ];
  for (const name of forbidden) {
    assert.ok(
      !names.includes(name),
      `公开工具不得暴露绕过编排器的入口：${name}`,
    );
  }
});
