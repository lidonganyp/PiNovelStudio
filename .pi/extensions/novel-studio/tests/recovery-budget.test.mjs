/**
 * RECOVERY-BUDGET tests
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRecoveryBudget,
  reserveBudget,
  snapshotBudget,
  canAffordRetry,
  resetStageAttempts,
} from "../dist/v2/core/recovery-budget.js";

test("预扣成功与不足", () => {
  const b = createRecoveryBudget({ maxTotalAttempts: 2, maxStageAttempts: 1 });
  const r1 = reserveBudget(b, { totalAttempts: 1, stageAttempts: 1, recoveryModelCalls: 1, modelCalls: 1 });
  assert.equal(r1.ok, true);
  const r2 = reserveBudget(r1.budget, { stageAttempts: 1 });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "stage_attempts_exhausted");
});

test("总预算不因阶段切换重置", () => {
  let b = createRecoveryBudget({ maxTotalAttempts: 3, maxStageAttempts: 2 });
  b = reserveBudget(b, { totalAttempts: 2, stageAttempts: 2 }).budget;
  b = resetStageAttempts(b);
  assert.equal(b.usedStageAttempts, 0);
  assert.equal(b.usedTotalAttempts, 2);
  const snap = snapshotBudget(b);
  assert.equal(snap.remainingTotalAttempts, 1);
});

test("canAffordRetry 在预算耗尽时 false", () => {
  let b = createRecoveryBudget({ maxRecoveryModelCalls: 1 });
  b = reserveBudget(b, {
    totalAttempts: 1,
    stageAttempts: 1,
    recoveryModelCalls: 1,
    modelCalls: 1,
  }).budget;
  assert.equal(canAffordRetry(b), false);
});

test("latency 预算", () => {
  const b = createRecoveryBudget({ maxLatencyMs: 100 });
  const r = reserveBudget(b, { latencyMs: 150 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "latency_exhausted");
});
