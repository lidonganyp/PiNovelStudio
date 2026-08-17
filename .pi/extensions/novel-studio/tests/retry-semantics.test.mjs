/**
 * RETRY / RESUME / REGENERATE / ROLLBACK 语义区分
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRecovery } from "../dist/v2/core/recovery-decision-engine.js";
import { createRecoveryBudget } from "../dist/v2/core/recovery-budget.js";
import { createRecoveryStateMachine } from "../dist/v2/core/recovery-state-machine.js";

test("retry 必须 changesCondition=true", () => {
  const d = decideRecovery({
    failureClass: "recoverable",
    stage: "style",
    gate: "style_optimization",
    reason: "empty",
    attempt: 0,
    maxAttempts: 1,
    budget: createRecoveryBudget(),
  });
  assert.ok(d.recoveryAction === "retry_stage" || d.recoveryAction === "retry_gate");
  assert.equal(d.changesCondition, true);
  assert.ok(d.nextCondition);
});

test("resume 必须显式：状态机 resume", () => {
  const sm = createRecoveryStateMachine("running");
  sm.transition("retryable_failure");
  sm.transition("checkpoint");
  // 不得自动 committed
  assert.equal(sm.transition("committed").ok, false);
  assert.equal(sm.resume("user_explicit").ok, true);
});

test("regenerate 决策路径（coverage 重试条件）", () => {
  const d = decideRecovery({
    failureClass: "recoverable",
    stage: "agentic",
    gate: "coverage",
    reason: "missing must-verify",
    attempt: 0,
    maxAttempts: 2,
    budget: createRecoveryBudget(),
    coverageInsufficient: true,
  });
  assert.equal(d.recoveryAction, "retry_stage");
  assert.match(d.nextCondition, /missing|retrieval/);
});

test("rollback 路径", () => {
  const d = decideRecovery({
    failureClass: "blocked",
    stage: "commit",
    gate: "state.commit",
    reason: "state failed",
    attempt: 0,
    budget: createRecoveryBudget(),
    stateCommitFailed: true,
  });
  assert.equal(d.recoveryAction, "rollback");
});
