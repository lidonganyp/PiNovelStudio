/**
 * RECOVERY-EVAL — 最小越权/恢复 Eval 场景
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRecovery, isForbiddenProductionFallback } from "../dist/v2/core/recovery-decision-engine.js";
import { createRecoveryBudget, reserveBudget, canAffordRetry } from "../dist/v2/core/recovery-budget.js";
import { createRecoveryStateMachine } from "../dist/v2/core/recovery-state-machine.js";
import { buildProductionFailureEnvelope, toUnifiedFailureEnvelope } from "../dist/v2/core/failure-envelope.js";
import { mapLegacyFailureClass } from "../dist/v2/core/failure-types.js";

test("1) 首次 timeout 第二次可 retry", () => {
  const d0 = decideRecovery({
    failureClass: "recoverable",
    stage: "agentic",
    gate: "model_timeout",
    reason: "timeout",
    attempt: 0,
    maxAttempts: 1,
    budget: createRecoveryBudget(),
  });
  assert.equal(d0.recoveryAction, "retry_stage");
});

test("2) 连续两次 timeout → checkpoint", () => {
  const d1 = decideRecovery({
    failureClass: "recoverable",
    stage: "agentic",
    gate: "model_timeout",
    reason: "timeout",
    attempt: 1,
    maxAttempts: 1,
    budget: createRecoveryBudget(),
  });
  assert.equal(d1.recoveryAction, "checkpoint");
});

test("3) schema 只重试 gate", () => {
  const d = decideRecovery({
    failureClass: "recoverable",
    stage: "judge",
    gate: "schema",
    reason: "parse error",
    attempt: 0,
    budget: createRecoveryBudget(),
    schemaOrParseError: true,
  });
  assert.equal(d.recoveryAction, "retry_gate");
});

test("4) Coverage 不足继续检索", () => {
  const d = decideRecovery({
    failureClass: "recoverable",
    stage: "agentic",
    gate: "must_verify_coverage",
    reason: "missing items",
    attempt: 0,
    maxAttempts: 2,
    budget: createRecoveryBudget(),
    coverageInsufficient: true,
  });
  assert.equal(d.recoveryAction, "retry_stage");
});

test("5) 预算在工具调用前耗尽", () => {
  let b = createRecoveryBudget({ maxModelCalls: 0 });
  assert.equal(canAffordRetry(b), false);
  const r = reserveBudget(b, { modelCalls: 1 });
  assert.equal(r.ok, false);
});

test("6) 模型调用期间用户中断", () => {
  const d = decideRecovery({
    failureClass: "recoverable",
    stage: "agentic",
    reason: "abort",
    attempt: 0,
    budget: createRecoveryBudget(),
    interruptSignal: "user_abort",
  });
  assert.equal(d.nextLifecycleState, "interrupted");
});

test("7) 正文成功状态失败 → rollback", () => {
  const d = decideRecovery({
    failureClass: "blocked",
    stage: "commit",
    reason: "state fail",
    attempt: 0,
    budget: createRecoveryBudget(),
    stateCommitFailed: true,
  });
  assert.equal(d.recoveryAction, "rollback");
});

test("8) stale revision 无副作用", () => {
  const d = decideRecovery({
    failureClass: "blocked",
    stage: "finalization",
    reason: "stale",
    attempt: 0,
    budget: createRecoveryBudget(),
    staleRevision: true,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.recoveryAction, "stop");
});

test("9) 生产路径拒绝 one_shot_raw fallback 文案", () => {
  assert.equal(isForbiddenProductionFallback("fallback to one_shot_raw"), true);
  const env = buildProductionFailureEnvelope({
    stage: "agentic",
    gate: "model_timeout",
    reason: "timeout",
    severity: "recoverable",
    attempt: 1,
    maxAttempts: 1,
  });
  assert.ok(!JSON.stringify(env).includes("one_shot_raw"));
});

test("10) 每次失败都有 traceId", () => {
  const env = buildProductionFailureEnvelope({
    stage: "x",
    reason: "y",
    severity: "hard",
  });
  assert.ok(env.traceId);
  const unified = toUnifiedFailureEnvelope(env);
  assert.ok(unified.traceId);
  assert.ok(unified.failureClass);
});

test("11) checkpoint 不自动提交", () => {
  const sm = createRecoveryStateMachine("checkpoint");
  assert.equal(sm.transition("committed").ok, false);
});

test("12) resume 不重复正式副作用：仅 checkpoint→running", () => {
  const sm = createRecoveryStateMachine("checkpoint");
  assert.equal(sm.resume().ok, true);
  assert.equal(sm.state, "running");
});

test("13) regenerate 使用新条件（coverage retry nextCondition）", () => {
  const d = decideRecovery({
    failureClass: "recoverable",
    stage: "agentic",
    gate: "coverage",
    reason: "missing",
    attempt: 0,
    maxAttempts: 2,
    budget: createRecoveryBudget(),
    coverageInsufficient: true,
  });
  assert.ok(d.changesCondition);
  assert.ok(d.nextCondition);
});

test("14) 未分类失败映射为 blocked", () => {
  assert.equal(mapLegacyFailureClass("totally-unknown"), "blocked");
});
