/**
 * RECOVERY-DECISION-ENGINE tests
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideRecovery,
  isForbiddenProductionFallback,
  classifyFailureFromGate,
} from "../dist/v2/core/recovery-decision-engine.js";
import { createRecoveryBudget, reserveBudget } from "../dist/v2/core/recovery-budget.js";
import { mapLegacyFailureClass } from "../dist/v2/core/failure-types.js";
import { buildProductionFailureEnvelope } from "../dist/v2/core/failure-envelope.js";

function base(overrides = {}) {
  return {
    failureClass: "recoverable",
    stage: "novelos_agentic",
    gate: "model_timeout",
    reason: "timeout",
    attempt: 0,
    maxAttempts: 1,
    budget: createRecoveryBudget(),
    forbidOneShotRawFallback: true,
    ...overrides,
  };
}

test("旧 soft/hard_block 映射到统一分类", () => {
  assert.equal(mapLegacyFailureClass("soft"), "recoverable");
  assert.equal(mapLegacyFailureClass("hard_block"), "blocked");
  assert.equal(mapLegacyFailureClass("hard"), "blocked");
});

test("首次 timeout → retry_stage", () => {
  const d = decideRecovery(base());
  assert.equal(d.recoveryAction, "retry_stage");
  assert.equal(d.allowed, true);
  assert.equal(d.changesCondition, true);
});

test("连续两次 timeout（attempt 耗尽）→ checkpoint，禁止 one_shot_raw", () => {
  const d = decideRecovery(base({ attempt: 1, maxAttempts: 1 }));
  assert.equal(d.recoveryAction, "checkpoint");
  assert.ok(!isForbiddenProductionFallback(d.reason) || d.reason.includes("禁止"));
});

test("schema 错误 → retry_gate", () => {
  const d = decideRecovery(base({
    schemaOrParseError: true,
    gate: "schema",
    failureClass: "recoverable",
  }));
  assert.equal(d.recoveryAction, "retry_gate");
});

test("Coverage 不足 → retry_stage 带缺失项条件", () => {
  const d = decideRecovery(base({
    coverageInsufficient: true,
    gate: "coverage",
  }));
  assert.equal(d.recoveryAction, "retry_stage");
  assert.match(d.nextCondition ?? "", /missing|retrieval/);
});

test("确认事实冲突 → user_fix + blocked", () => {
  const d = decideRecovery(base({
    failureClass: "blocked",
    confirmedFactConflict: true,
    gate: "fact_guard",
  }));
  assert.equal(d.recoveryAction, "user_fix");
  assert.equal(d.nextLifecycleState, "blocked");
});

test("正文保存失败 → stop/blocked", () => {
  const d = decideRecovery(base({
    failureClass: "blocked",
    chapterSaveFailed: true,
  }));
  assert.equal(d.recoveryAction, "stop");
});

test("状态提交失败 → rollback", () => {
  const d = decideRecovery(base({
    failureClass: "blocked",
    stateCommitFailed: true,
  }));
  assert.equal(d.recoveryAction, "rollback");
});

test("stale revision → stop", () => {
  const d = decideRecovery(base({ staleRevision: true }));
  assert.equal(d.recoveryAction, "stop");
});

test("用户中断 → checkpoint/interrupted", () => {
  const d = decideRecovery(base({ interruptSignal: "user_abort" }));
  assert.equal(d.nextLifecycleState, "interrupted");
  assert.equal(d.recoveryAction, "checkpoint");
});

test("预算耗尽 → checkpoint", () => {
  let budget = createRecoveryBudget({ maxTotalAttempts: 1 });
  budget = reserveBudget(budget, { totalAttempts: 1 }).budget;
  const d = decideRecovery(base({ budget, attempt: 0 }));
  assert.equal(d.recoveryAction, "checkpoint");
});

test("isForbiddenProductionFallback 识别 one_shot_raw", () => {
  assert.equal(isForbiddenProductionFallback("fallback to one_shot_raw"), true);
  assert.equal(isForbiddenProductionFallback("retry_stage_or_checkpoint"), false);
});

test("buildProductionFailureEnvelope 含 failureClass + recoveryAction + traceId", () => {
  const env = buildProductionFailureEnvelope({
    stage: "novelos_agentic",
    gate: "model_timeout",
    reason: "timeout",
    severity: "recoverable",
    attempt: 0,
    maxAttempts: 1,
  });
  assert.equal(env.failureClass, "recoverable");
  assert.ok(env.recoveryAction);
  assert.ok(env.traceId);
  assert.equal(env.severity, "recoverable");
});

test("classifyFailureFromGate model_timeout recoverable", () => {
  assert.equal(
    classifyFailureFromGate({ gate: "model_timeout", recoverable: true }),
    "recoverable",
  );
});
