/**
 * RECOVERY-TRANSACTION — 正文/状态事务恢复语义
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRecovery } from "../dist/v2/core/recovery-decision-engine.js";
import { createRecoveryBudget } from "../dist/v2/core/recovery-budget.js";
import { buildProductionFailureEnvelope } from "../dist/v2/core/failure-envelope.js";

test("正文保存失败：不提交状态（stop）", () => {
  const d = decideRecovery({
    failureClass: "blocked",
    stage: "atomic_save",
    gate: "atomic_save",
    reason: "disk full",
    attempt: 0,
    budget: createRecoveryBudget(),
    chapterSaveFailed: true,
  });
  assert.equal(d.recoveryAction, "stop");
  assert.equal(d.nextLifecycleState, "blocked");
});

test("状态失败：rollback", () => {
  const d = decideRecovery({
    failureClass: "blocked",
    stage: "state_commit",
    gate: "state.commit",
    reason: "state error",
    attempt: 0,
    budget: createRecoveryBudget(),
    stateCommitFailed: true,
  });
  assert.equal(d.recoveryAction, "rollback");
});

test("stale revision 无副作用", () => {
  const env = buildProductionFailureEnvelope({
    stage: "finalization",
    gate: "stale_revision",
    reason: "revision mismatch",
    recoveryHints: { staleRevision: true },
  });
  assert.equal(env.failureClass, "blocked");
  assert.equal(env.recoveryAction, "stop");
  assert.equal(env.recoverable, false);
});

test("生产路径 envelope 禁止 one_shot_raw 文案", () => {
  const env = buildProductionFailureEnvelope({
    stage: "novelos_agentic",
    gate: "model_timeout",
    reason: "timeout after retries",
    severity: "recoverable",
    attempt: 1,
    maxAttempts: 1,
  });
  const blob = JSON.stringify(env);
  assert.ok(!blob.includes("one_shot_raw"), `envelope 不得含 one_shot_raw：${blob}`);
  assert.ok(!blob.includes("fallback to one_shot_raw"));
});
