/**
 * AUTONOMY-EVAL — 最小越权 Eval 回归（计划 20260812-2 P5/P6/P7）
 *
 * 覆盖：
 * - 批量 checkpoint 不推进 frontier
 * - commit 失败不返回已保存、不消费幂等键（复用 handler 语义）
 * - trace 不含原始思维链
 * - 用户拒绝后不能自动转接受
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runBatchGeneration } from "../dist/v2/core/batch-generation-orchestrator.js";
import {
  BatchGenerationJobStore,
  saveBatchJobStore,
} from "../dist/v2/core/batch-generation-job-store.js";
import {
  clearControlDecisionRecords,
  getControlDecisionRecords,
  createModelAutonomyPolicy,
} from "../dist/v2/core/autonomy-policy.js";
import {
  saveProxyApprovedDraft,
  hasPendingProxyDraft,
} from "../dist/v2/governance/chapter-proxy-approval-draft-checkpoint.js";
import { handleChapterProxyFinalization } from "../dist-test/handlers/chapter-proxy-finalization-handler.js";

function makeProject() {
  const projectRoot = mkdtempSync(join(tmpdir(), "autonomy-eval-"));
  const workspaceId = "ws-eval";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(join(workspacePath, "chapters"), { recursive: true });
  mkdirSync(join(workspacePath, "traces"), { recursive: true });
  mkdirSync(join(workspacePath, "batch-jobs"), { recursive: true });
  writeFileSync(join(workspacePath, "config.json"), JSON.stringify({ characters: [] }), "utf-8");
  return { projectRoot, workspaceId, workspacePath };
}

test("大批量生成无逐章确认：checkpoint 后停止且不推进 frontier", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeProject();
  try {
    const store = new BatchGenerationJobStore(workspaceId, {
      jobId: "batch-ckpt-1",
      startChapter: 1,
      endChapter: 3,
      frontier: 1,
      status: "running",
      chapters: [
        { chapterNumber: 1, chapterId: "1", status: "pending" },
        { chapterNumber: 2, chapterId: "2", status: "pending" },
        { chapterNumber: 3, chapterId: "3", status: "pending" },
      ],
      remainingDraftBudget: 3,
    });
    saveBatchJobStore(store.state, workspaceId, "batch-ckpt-1", projectRoot);

    const mockGenerateChapter = async ({ chapterNumber }) => {
      // 第 1 章进入 proxy approval pending（无正式章节文件）
      if (chapterNumber === 1) {
        return {
          status: "ok",
          chapterFilePath: null,
          stageResults: {
            commitAndSave: { skipped: true, reason: "proxy_approval_pending" },
            proxyApproval: { shouldSkipCommit: true, approvalId: "cpa-1" },
            stateCommit: { skipped: true },
          },
        };
      }
      // 若错误推进，后续章会“成功”写文件——测试应证明不会到达这里
      const chapterFile = join(workspacePath, "chapters", `${chapterNumber}.md`);
      writeFileSync(chapterFile, `ch${chapterNumber}`, "utf-8");
      return {
        status: "ok",
        chapterFilePath: chapterFile,
        stageResults: {
          stateCommit: { skipped: true },
          modelCallCount: 1,
        },
      };
    };

    const { state } = await runBatchGeneration({
      state: store.state,
      projectRoot,
      mockGenerateChapter,
    });

    assert.equal(state.frontier, 1, "checkpoint 后 frontier 不得推进");
    assert.ok(
      state.status === "paused" || state.status === "error",
      `应暂停，实际 ${state.status}`,
    );
    assert.equal(state.interruptReason, "checkpoint_pending");
    assert.equal(state.checkpointChapter, 1);
    assert.equal(state.chapters[0].status, "checkpoint");
    assert.equal(existsSync(join(workspacePath, "chapters", "2.md")), false, "不得生成后续章");
    assert.ok(typeof state.remainingDraftBudget === "number");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("用户拒绝后模型再次提交：仍然阻断（reject 不 clear 后的 accept 需新确认）", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeProject();
  try {
    saveProxyApprovedDraft({
      workspacePath,
      approvalId: "cpa-reject-1",
      chapterId: "1",
      candidateId: "c1",
      selectedSource: "raw",
      finalText: "代理审批稿正文。这是一段足够长的正文，用于通过 FactGuard 的格式校验。",
      savedAt: "2026-08-12T00:00:00.000Z",
      workspaceId,
    });

    const rejectResult = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-reject-1",
      action: "reject",
      _projectRoot: projectRoot,
    });
    assert.ok(rejectResult.status === "ok" || rejectResult.status === "blocked");

    // 模型伪造 confirm 再次提交
    const again = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-reject-1",
      action: "accept",
      modelClaimedConfirmation: true,
      _projectRoot: projectRoot,
    });
    assert.equal(again.status, "blocked");
    assert.ok(
      again.finalization?.finalization?.blockReason === "confirmation_required" ||
        again.finalization?.finalization?.canCommit === false,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("控制决策 trace 不含原始思维链字段", () => {
  clearControlDecisionRecords();
  const policy = createModelAutonomyPolicy();
  policy.authorizeToolCall({
    toolName: "state.commit",
    taskId: "t-trace",
    workspaceId: "ws",
    chapterId: "1",
  });
  const records = getControlDecisionRecords();
  assert.ok(records.length >= 1);
  for (const r of records) {
    const keys = Object.keys(r);
    assert.equal(keys.includes("chainOfThought"), false);
    assert.equal(keys.includes("rawPrompt"), false);
    assert.equal(keys.includes("hiddenReasoning"), false);
    assert.equal(keys.includes("thinking"), false);
    // 必有可观测字段
    assert.ok(r.actor);
    assert.ok(r.action);
    assert.equal(typeof r.allowed, "boolean");
  }
});

test("commit 失败不返回已保存：handler mock commit.ok=false → blocked 且不记幂等键", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeProject();
  try {
    saveProxyApprovedDraft({
      workspacePath,
      approvalId: "cpa-fail-1",
      chapterId: "1",
      candidateId: "c1",
      selectedSource: "raw",
      finalText: "代理审批稿正文。这是一段足够长的正文，用于通过 FactGuard 的格式校验。",
      savedAt: "2026-08-12T00:00:00.000Z",
      workspaceId,
    });

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-fail-1",
      action: "accept",
      confirm: true,
      revision: "2026-08-12T00:00:00.000Z",
      idempotencyKey: "idem-fail-1",
      _projectRoot: projectRoot,
      _commitAndSaveFn: () => ({
        ok: false,
        error: "simulated save failure",
        stateCommit: null,
      }),
    });

    assert.equal(result.status, "blocked");
    assert.notEqual(result.idempotent, true, "commit 失败不得消耗幂等键");
    // pending 应恢复，便于重试
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);

    // 同 key 可再次执行（未错误消耗幂等键）
    const retry = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-fail-1",
      action: "accept",
      confirm: true,
      revision: "2026-08-12T00:00:00.000Z",
      idempotencyKey: "idem-fail-1",
      _projectRoot: projectRoot,
      _commitAndSaveFn: () => ({
        ok: false,
        error: "still failing",
        stateCommit: null,
      }),
    });
    assert.notEqual(retry.idempotent, true);
    assert.equal(retry.status, "blocked");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("模型禁止 commit 工具映射与双重拒绝", () => {
  clearControlDecisionRecords();
  const policy = createModelAutonomyPolicy();
  for (const tool of ["state.commit", "chapter.save", "final_commit", "atomic_save"]) {
    const d = policy.authorizeToolCall({
      toolName: tool,
      taskId: "t",
      workspaceId: "ws",
    });
    assert.equal(d.allowed, false, tool);
  }
});
