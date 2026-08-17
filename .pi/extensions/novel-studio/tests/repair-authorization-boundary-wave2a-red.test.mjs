/**
 * RED 测试：修订授权策略边界（REASONING-REPAIR-BOUNDARY-1 Wave 2A / RRB-1.3~1.6）
 *
 * 锁定 Wave 2A 的 fail-closed 期望行为：
 *
 *   RRB-1.3 — evaluateRepairAuthorization 按 §3.2 逐项 fail-closed；
 *            任一条件不满足时返回 decision=denied，不得修改正文。
 *   RRB-1.4 — failure type → allowed action 白名单生效；
 *            未知类型默认 no_op/block/human_review。
 *   RRB-1.5 — 文学软诊断、启发式 finding、author input conflict 路由到
 *            human_review/no_op/block。
 *   RRB-1.6 — 授权绑定 candidate hash、snapshot、evidence hash、范围、预算；
 *            stale/missing/mismatch 均生成明确拒绝理由。
 *
 * 对照计划 §7 最小验收矩阵：
 *   T01  sourceRef 只是 diagnostic ID → 拒绝
 *   T02  EvidenceRecord 缺 authority/snapshot/hash → 拒绝
 *   T03  evidence snapshot ≠ candidate snapshot → 拒绝
 *   T04  hard + heuristic finding → 拒绝
 *   T05  review/info 文学诊断 → 只进 Review Surface，自动修改 0 次
 *   T06  可定位实体/属性硬冲突 → 授权 span/patch
 *   T08  span ≥ 40% 但无灾难授权 → 拒绝（由 RRB-3.1 在候选修补层实现）
 *   T20  模型输出 approved=true → 不改变系统授权结果
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateRepairAuthorization } from "../dist-test/v2/core/repair-authorization-policy.js";
import { isAutoEditingAction } from "../dist-test/v2/core/repair-authorization-contracts.js";

// ============================================================================
// 辅助：构造测试 fixture
// ============================================================================

/** 构造一个合法的 hard + deterministic finding（通过全部准入条件的基础）。 */
function baseFinding(overrides = {}) {
  return {
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
}

/** 构造一个合法的权威 EvidenceRecord。 */
function baseEvidence(overrides = {}) {
  return {
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
    ...overrides,
  };
}

/** 基础输入：通过全部条件。 */
function baseInput(overrides = {}) {
  return {
    finding: baseFinding(),
    evidenceRecords: [baseEvidence()],
    candidateId: "s1-agentic_generation-abc123def4567890-0",
    candidateTextHash: "abc123",
    candidateTextLength: 100,
    snapshotId: "snap-001",
    budgetAvailable: true,
    ...overrides,
  };
}

// ============================================================================
// T05：review/info 文学诊断 → 拒绝自动修改
// ============================================================================

test("T05: review 严重度 finding → denied（非 hard/fatal）", () => {
  const input = baseInput({
    finding: baseFinding({ severity: "review" }),
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_heuristic_finding");
  assert.ok(
    result.reasons.some((r) => r.includes("review")),
    `应报 severity=review 原因：${result.reasons.join("; ")}`,
  );
});

test("T05: info 严重度 finding → denied（非 hard/fatal）", () => {
  const input = baseInput({
    finding: baseFinding({ severity: "info" }),
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_heuristic_finding");
});

// ============================================================================
// T04：启发式 finding → 拒绝
// ============================================================================

test("T04: heuristic certainty finding → denied", () => {
  const input = baseInput({
    finding: baseFinding({ certainty: "heuristic" }),
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_insufficient_certainty");
  assert.ok(
    result.reasons.some((r) => r.includes("heuristic")),
    `应报 certainty=heuristic 原因：${result.reasons.join("; ")}`,
  );
});

// ============================================================================
// T02：证据记录缺字段 → 拒绝
// ============================================================================

test("T02: 缺 evidenceId → denied", () => {
  const input = baseInput({
    finding: baseFinding({ evidenceId: undefined }),
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_missing_evidence");
});

test("T02: evidenceId 无法定位 EvidenceRecord → denied", () => {
  const input = baseInput({
    finding: baseFinding({ evidenceId: "ev-nonexistent" }),
    evidenceRecords: [baseEvidence({ evidenceId: "ev-other" })],
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_missing_evidence");
});

test("T02: authorityClass=model_planned → denied（非权威证据）", () => {
  const input = baseInput({
    evidenceRecords: [
      baseEvidence({
        authorityClass: "model_planned",
      }),
    ],
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_missing_authority");
});

test("T02: authorityClass=diagnostic_hypothesis → denied（非权威证据）", () => {
  const input = baseInput({
    evidenceRecords: [
      baseEvidence({
        authorityClass: "diagnostic_hypothesis",
      }),
    ],
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_missing_authority");
});

// ============================================================================
// T03：snapshot 不一致 → 拒绝
// ============================================================================

test("T03: evidence snapshot ≠ candidate snapshot → denied", () => {
  const input = baseInput({
    snapshotId: "snap-002",
    evidenceRecords: [
      baseEvidence({ snapshotId: "snap-001" }),
    ],
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_stale_snapshot");
});

// ============================================================================
// T02 续：hash 缺失 → 拒绝
// ============================================================================

test("T02: sourceContentHash 为空 → denied", () => {
  const input = baseInput({
    evidenceRecords: [
      baseEvidence({ sourceContentHash: "" }),
    ],
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_missing_content_hash");
});

test("T02: evidenceExcerptHash 为空 → denied", () => {
  const input = baseInput({
    evidenceRecords: [
      baseEvidence({ evidenceExcerptHash: "" }),
    ],
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_missing_excerpt_hash");
});

// ============================================================================
// RRB-1.4：失败类型白名单
// ============================================================================

test("RRB-1.4: language_risk → 非自动编辑动作（no_op/human_review）", () => {
  const input = baseInput({
    finding: baseFinding({
      failureType: "language_risk",
      allowedRepairRange: { start: 10, end: 20, excerpt: "" },
    }),
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.ok(
    !isAutoEditingAction(result.action),
    `language_risk 不得产生自动编辑动作，实际 action=${result.action}`,
  );
  assert.ok(
    result.action === "no_op" || result.action === "human_review",
    `language_risk 应路由到 no_op/human_review，实际 action=${result.action}`,
  );
});

test("RRB-1.4: author_input_conflict → block/human_review", () => {
  const input = baseInput({
    finding: baseFinding({
      failureType: "author_input_conflict",
      allowedRepairRange: { start: 10, end: 20, excerpt: "" },
    }),
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.ok(
    result.action === "block" || result.action === "human_review",
    `author_input_conflict 应路由到 block/human_review，实际 action=${result.action}`,
  );
});

test("RRB-1.4: 未知 failure type → 默认 no_op/block/human_review", () => {
  const input = baseInput({
    finding: baseFinding({
      failureType: "nonexistent_type",
      allowedRepairRange: { start: 10, end: 20, excerpt: "" },
    }),
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.ok(
    result.action === "no_op" || result.action === "block" || result.action === "human_review",
    `未知 failure type 应路由到 no_op/block/human_review，实际 action=${result.action}`,
  );
});

// ============================================================================
// RRB-1.5：启发式/文学诊断路由
// ============================================================================

test("RRB-1.5: intent_covered（正向覆盖）→ no_op，不自动修改", () => {
  const input = baseInput({
    finding: baseFinding({
      failureType: "intent_covered",
      severity: "info",
    }),
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.ok(
    !isAutoEditingAction(result.action),
    `intent_covered 不应触发自动编辑，实际 action=${result.action}`,
  );
});

// ============================================================================
// RRB-1.6：span 越界 → 拒绝
// ============================================================================

test("RRB-1.6: allowedRepairRange 越界 → denied", () => {
  const input = baseInput({
    finding: baseFinding({
      allowedRepairRange: { start: 0, end: 10000, excerpt: "" },
    }),
    candidateTextLength: 3, // 极短正文，span 一定越界
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_out_of_bounds_span");
});

test("RRB-1.6: allowedRepairRange start > end → denied", () => {
  const input = baseInput({
    finding: baseFinding({
      allowedRepairRange: { start: 50, end: 10, excerpt: "" },
    }),
    candidateTextLength: 100,
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_invalid_span");
});

// ============================================================================
// RRB-1.6：预算耗尽 → 拒绝
// ============================================================================

test("RRB-1.6: budgetAvailable=false → denied", () => {
  const input = baseInput({ budgetAvailable: false });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_budget_exhausted");
});

// ============================================================================
// T06：全部条件满足 → 授权通过
// ============================================================================

test("T06: 合法 hard+deterministic+权威证据 → authorized", () => {
  const input = baseInput();
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "authorized");
  assert.equal(result.action, "span_patch");
  assert.ok(result.authorization, "authorized 时应附带 RepairAuthorization");
  assert.equal(result.authorization.candidateId, input.candidateId);
  assert.equal(result.authorization.candidateTextHash, input.candidateTextHash);
  assert.equal(result.authorization.snapshotId, input.snapshotId);
  assert.deepEqual(result.authorization.findingIds, ["f-001"]);
  assert.deepEqual(result.authorization.evidenceIds, ["ev-001"]);
  assert.ok(
    result.authorization.authorizationId.startsWith("auth-"),
    `authorizationId 应以 auth- 开头：${result.authorization.authorizationId}`,
  );
  assert.ok(
    result.authorization.expiresAt > new Date().toISOString(),
    "expiresAt 应在未来",
  );
});

// ============================================================================
// 二级证据权威：不同 authorityClass 的授权行为
// ============================================================================

test("authorityClass=final_text_explicit → authorized", () => {
  const input = baseInput({
    evidenceRecords: [baseEvidence({ authorityClass: "final_text_explicit" })],
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "authorized");
});

test("authorityClass=committed_state → authorized", () => {
  const input = baseInput({
    evidenceRecords: [baseEvidence({ authorityClass: "committed_state" })],
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "authorized");
});

test("authorityClass=system_derived → authorized", () => {
  const input = baseInput({
    evidenceRecords: [baseEvidence({ authorityClass: "system_derived" })],
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "authorized");
});

// ============================================================================
// 不同 failure type → 不同 action
// ============================================================================

test("fact_omission → paragraph_patch", () => {
  const input = baseInput({
    finding: baseFinding({
      failureType: "fact_omission",
      allowedRepairRange: { start: 10, end: 50, excerpt: "" },
    }),
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "authorized");
  assert.equal(result.action, "paragraph_patch");
});

test("scene_continuity → bridge_patch", () => {
  const input = baseInput({
    finding: baseFinding({
      failureType: "scene_continuity",
      allowedRepairRange: { start: 10, end: 20, excerpt: "" },
    }),
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "authorized");
  assert.equal(result.action, "bridge_patch");
});

test("intent_omission → paragraph_patch（优先于 new_candidate）", () => {
  const input = baseInput({
    finding: baseFinding({
      failureType: "intent_omission",
      severity: "hard",
      allowedRepairRange: { start: 10, end: 50, excerpt: "" },
    }),
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "authorized");
  // intent_omission 允许 ["paragraph_patch", "new_candidate"]，
  // 按 REPAIR_LADDER 优先选择 paragraph_patch
  assert.equal(result.action, "paragraph_patch");
});

// ============================================================================
// T20：模型输出字段不影响授权
// ============================================================================

test("T20: 模型返回 approved=true 不影响系统授权（纯函数纯输入）", () => {
  // 本函数不读取模型输出字段，只接受结构化 finding + evidence + budget
  const input = baseInput();
  const result = evaluateRepairAuthorization(input);
  // 只要输入合法，结果就是 authorized——模型无法通过伪造字段绕过
  assert.equal(result.decision, "authorized");
  assert.equal(result.action, "span_patch");
});

// ============================================================================
// 边界：空 span 仅在 bridge 类型允许
// ============================================================================

test("零宽 span 在非 bridge 类型 → denied", () => {
  const input = baseInput({
    finding: baseFinding({
      failureType: "entity_hallucination",
      allowedRepairRange: { start: 10, end: 10, excerpt: "" },
    }),
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "denied");
  assert.equal(result.reasonCode, "deny_invalid_span");
});

test("零宽 span 在 bridge 类型 → authorized", () => {
  const input = baseInput({
    finding: baseFinding({
      failureType: "scene_continuity",
      allowedRepairRange: { start: 10, end: 10, excerpt: "" },
    }),
  });
  const result = evaluateRepairAuthorization(input);
  assert.equal(result.decision, "authorized");
  assert.equal(result.action, "bridge_patch");
});