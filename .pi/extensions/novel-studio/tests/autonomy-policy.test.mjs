/**
 * AUTONOMY-POLICY tests — 模型自主性策略与双重守护（计划 20260812-2 P0/P1/P7）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createModelAutonomyPolicy,
  authorizeAction,
  assertOrchestratorCommitActor,
  clearControlDecisionRecords,
  getControlDecisionRecords,
} from "../dist/v2/core/autonomy-policy.js";
import {
  mapToolNameToAction,
  isKnownAction,
  getDefaultAutonomyLevel,
  listActions,
} from "../dist/v2/core/action-catalog.js";
import { buildTrustedControlPlane } from "../dist/v2/core/control-plane.js";

function baseRequest(overrides = {}) {
  return {
    taskId: "task-auto-1",
    workspaceId: "ws-auto",
    chapterId: "1",
    action: "retrieval.execute",
    requestedLevel: "bounded_execute",
    actor: "model",
    scope: { workspaceId: "ws-auto", chapterId: "1", taskId: "task-auto-1" },
    ...overrides,
  };
}

test("动作目录：所有动作有唯一名称与默认自主性等级", () => {
  const actions = listActions();
  assert.ok(actions.length >= 10);
  const names = new Set(actions.map((a) => a.action));
  assert.equal(names.size, actions.length);
  for (const a of actions) {
    assert.equal(isKnownAction(a.action), true);
    assert.equal(getDefaultAutonomyLevel(a.action), a.defaultAutonomyLevel);
  }
});

test("模型调用未授权/禁止工具：state.commit 执行前阻断并记录 actor=model", () => {
  clearControlDecisionRecords();
  const policy = createModelAutonomyPolicy();
  const decision = policy.authorizeToolCall({
    toolName: "state.commit",
    taskId: "t1",
    workspaceId: "ws1",
    chapterId: "1",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.blockReason, "actor_forbidden");
  const records = getControlDecisionRecords();
  assert.ok(records.some((r) => r.actor === "model" && r.action === "state.commit" && r.allowed === false));
});

test("模型直接调用 chapter.save：阻断并记录", () => {
  clearControlDecisionRecords();
  const policy = createModelAutonomyPolicy();
  const decision = policy.evaluate(baseRequest({
    action: "chapter.save",
    requestedLevel: "commit",
  }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.blockReason, "actor_forbidden");
});

test("模型输出伪造 confirm=true 不参与授权判断", () => {
  const decision = authorizeAction({
    request: baseRequest({ action: "chapter.save", requestedLevel: "commit" }),
    modelClaimedConfirmation: true,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /忽略模型输出的确认字段|禁止/);
});

test("安全检索自主性保持：retrieval.execute 允许", () => {
  const policy = createModelAutonomyPolicy();
  const decision = policy.evaluate(baseRequest({
    action: "retrieval.execute",
    requestedLevel: "bounded_execute",
    resource: "search_chapter_span",
  }));
  assert.equal(decision.allowed, true);
  assert.equal(decision.result, "allowed");
});

test("未知动作默认拒绝", () => {
  const policy = createModelAutonomyPolicy();
  const decision = policy.evaluate(baseRequest({
    action: "totally.unknown.action",
    requestedLevel: "observe",
  }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.blockReason, "unknown_action");
});

test("动作升级只能产生 approval_required，不能自动升级", () => {
  const policy = createModelAutonomyPolicy();
  const decision = policy.evaluate(baseRequest({
    action: "repair.suggest",
    requestedLevel: "commit",
  }));
  assert.equal(decision.allowed, false);
  assert.ok(
    decision.result === "approval_required" || decision.blockReason === "approval_required" || decision.blockReason === "actor_forbidden",
  );
});

test("编排器第二道守护：orchestrator 可请求 commit 级动作评估", () => {
  const decision = assertOrchestratorCommitActor({
    actor: "orchestrator",
    action: "chapter.save",
    taskId: "t1",
    workspaceId: "ws1",
    chapterId: "1",
  });
  assert.equal(decision.allowed, true);
});

test("编排器第二道守护：model actor 请求 commit 被拒", () => {
  const decision = assertOrchestratorCommitActor({
    actor: "model",
    action: "state.commit",
    taskId: "t1",
    workspaceId: "ws1",
    chapterId: "1",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.blockReason, "actor_forbidden");
});

test("执行能力策略：deny chapter.save 时 authorizeAction 拒绝", () => {
  const plane = buildTrustedControlPlane({
    taskId: "cap-deny",
    objective: "test",
    scope: ["test"],
    allowedResources: [],
    forbiddenResources: [],
    generationLock: { route: "r", provider: "p", model: "m" },
    judgeLock: { route: "r", provider: "p", model: "m" },
    modelTransport: "local",
    capabilityOverrides: { "chapter.save": "deny" },
  });
  const decision = authorizeAction({
    request: baseRequest({
      actor: "orchestrator",
      action: "chapter.save",
      requestedLevel: "commit",
    }),
    executionPolicy: plane.policy,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.blockReason, "capability_denied");
});

test("CapabilityPolicy 对 actor=model 的 state.commit 永久拒绝", () => {
  const plane = buildTrustedControlPlane({
    taskId: "cap-model",
    objective: "test",
    scope: ["test"],
    allowedResources: [],
    forbiddenResources: [],
    generationLock: { route: "r", provider: "p", model: "m" },
    judgeLock: { route: "r", provider: "p", model: "m" },
    modelTransport: "local",
  });
  const auth = plane.policy.authorize("state.commit", "model attempt", { actor: "model" });
  assert.equal(auth.allowed, false);
  assert.equal(auth.trace.blockReason, "actor_forbidden");
});

test("mapToolNameToAction 映射 commit 工具与未知工具 fail-closed", () => {
  assert.equal(mapToolNameToAction("state.commit"), "state.commit");
  assert.equal(mapToolNameToAction("final_commit"), "state.commit");
  assert.equal(mapToolNameToAction("search_chapter_span"), "retrieval.execute");
  assert.equal(mapToolNameToAction("mystery_tool"), null);
  assert.equal(mapToolNameToAction(""), null);
});

test("未知工具 authorizeToolCall 阻断（unknown_action）", () => {
  clearControlDecisionRecords();
  const policy = createModelAutonomyPolicy();
  const decision = policy.authorizeToolCall({
    toolName: "mystery_tool",
    taskId: "t-unknown",
    workspaceId: "ws1",
    chapterId: "1",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.blockReason, "unknown_action");
  assert.equal(decision.result, "unknown_action");
  const records = getControlDecisionRecords();
  assert.ok(records.some((r) => r.resource === "mystery_tool" && r.allowed === false));
});
