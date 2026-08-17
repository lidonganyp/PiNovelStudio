/**
 * INTERRUPTION + CHECKPOINT tests
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveRecoveryCheckpoint,
  loadLatestRecoveryCheckpoint,
  validateResumeCheckpoint,
  markCheckpointResumed,
} from "../dist/v2/core/recovery-checkpoint.js";
import { createRecoveryBudget } from "../dist/v2/core/recovery-budget.js";
import { decideRecovery } from "../dist/v2/core/recovery-decision-engine.js";

test("中断决策 → interrupted/checkpoint，不 commit", () => {
  const d = decideRecovery({
    failureClass: "recoverable",
    stage: "agentic",
    reason: "user abort",
    attempt: 0,
    budget: createRecoveryBudget(),
    interruptSignal: "user_abort",
  });
  assert.equal(d.nextLifecycleState, "interrupted");
  assert.notEqual(d.recoveryAction, "regenerate_candidate");
});

test("checkpoint 落盘与 resume 校验", () => {
  const root = mkdtempSync(join(tmpdir(), "rcp-"));
  const workspacePath = join(root, "ws");
  mkdirSync(workspacePath, { recursive: true });
  try {
    const cp = saveRecoveryCheckpoint({
      workspacePath,
      workspaceId: "ws1",
      chapterId: "1",
      taskId: "t1",
      stage: "novelos_agentic",
      recoveryBudget: createRecoveryBudget(),
      interruptReason: "user_abort",
      completedWork: ["preflight", "context"],
      remainingWork: ["agentic", "style", "commit"],
      failureClass: "interrupted",
      recoveryAction: "checkpoint",
    });
    assert.ok(cp.checkpointId);
    const loaded = loadLatestRecoveryCheckpoint(workspacePath, "1");
    assert.ok(loaded);
    assert.equal(loaded.checkpointId, cp.checkpointId);
    assert.equal(validateResumeCheckpoint({
      checkpoint: loaded,
      workspaceId: "ws1",
      chapterId: "1",
    }).ok, true);
    assert.equal(validateResumeCheckpoint({
      checkpoint: loaded,
      workspaceId: "ws-other",
      chapterId: "1",
    }).ok, false);
    const resumed = markCheckpointResumed(workspacePath, loaded);
    assert.equal(resumed.status, "resumed");
    // resumed 后 latest open 应为空（status!=open）
    const after = loadLatestRecoveryCheckpoint(workspacePath, "1");
    assert.equal(after, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint 不自动提交：无 chapter.save 副作用字段", () => {
  const d = decideRecovery({
    failureClass: "recoverable",
    stage: "agentic",
    gate: "model_timeout",
    reason: "budget",
    attempt: 1,
    maxAttempts: 1,
    budget: createRecoveryBudget({ maxTotalAttempts: 1, usedTotalAttempts: 1 }),
  });
  assert.ok(d.recoveryAction === "checkpoint" || d.recoveryAction === "stop");
  assert.notEqual(d.nextLifecycleState, "committed");
});
