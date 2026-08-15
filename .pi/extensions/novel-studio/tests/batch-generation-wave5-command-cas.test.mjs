/**
 * CONCURRENCY-WAVE5：公共批量入口 commandId 幂等 + CAS 错误上浮
 *
 * 计划要求：
 * - resume / cancel（以及带 commandId 的 start）重复命令返回首次结果，无重复副作用
 * - saveBatchJobStore 返回 concurrent_state_update 时，handler 不得伪装成功
 * - 不同 commandId 操作同一已消费任务 → already_consumed
 */

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createBatchWorkspace,
  createMockGenerateChapter,
  cleanupWorkspace,
  PROJECT_ROOT,
} from "./batch-test-helpers.mjs";

const EXT_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");

const { handleBatchGeneration } = await import(
  pathToFileURL(join(EXT_ROOT, "dist", "handlers", "batch-generation-handler.js")).href
);
const {
  loadBatchJobStore,
} = await import(
  pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "batch-generation-job-store.js")).href
);

function baseStart(workspaceId, overrides = {}) {
  return {
    mode: "batch",
    action: "start",
    workspaceId,
    startChapter: 1,
    endChapter: 1,
    _projectRoot: PROJECT_ROOT,
    ...overrides,
  };
}

describe("CONCURRENCY-WAVE5：公共 handler commandId / CAS", () => {
  const workspaces = [];

  function freshWorkspace(id) {
    createBatchWorkspace(id);
    workspaces.push(id);
    return join(PROJECT_ROOT, "workspaces", id);
  }

  after(() => {
    for (const id of workspaces) cleanupWorkspace(id);
  });

  it("相同 commandId 的 start 只生成一次，第二次幂等返回首次结果", async () => {
    const ws = "batch-wave5-start-once";
    const workspacePath = freshWorkspace(ws);
    const mock = createMockGenerateChapter({ workspacePath });
    const commandId = "cmd-start-once-001";
    const jobId = "batch-wave5-start-once";

    const first = await handleBatchGeneration(baseStart(ws, {
      jobId,
      commandId,
      _mockGenerateChapter: mock,
    }));
    assert.equal(first.status, "completed", "首次 start 应完成");
    assert.equal(first.jobId, jobId);
    assert.notEqual(first.idempotent, true);
    assert.equal(mock.calls.length, 1);

    const second = await handleBatchGeneration(baseStart(ws, {
      jobId,
      commandId,
      _mockGenerateChapter: mock,
    }));
    assert.equal(second.status, first.status, "重复 commandId 应返回首次 status");
    assert.equal(second.jobId, first.jobId);
    assert.equal(second.idempotent, true, "重复 commandId 必须标记 idempotent");
    assert.equal(mock.calls.length, 1, "重复 start 不得再次调用生成");
  });

  it("相同 commandId 的 cancel 第二次不改变 stateRevision", async () => {
    const ws = "batch-wave5-cancel-once";
    const workspacePath = freshWorkspace(ws);
    const mock = createMockGenerateChapter({
      workspacePath,
      failOnChapters: [1],
    });
    const jobId = "batch-wave5-cancel-once";
    const start = await handleBatchGeneration(baseStart(ws, {
      jobId,
      commandId: "cmd-cancel-setup",
      endChapter: 2,
      _mockGenerateChapter: mock,
    }));
    assert.equal(start.status, "paused", "第1章失败应暂停");

    const commandId = "cmd-cancel-once-001";
    const first = await handleBatchGeneration({
      mode: "batch",
      action: "cancel",
      workspaceId: ws,
      jobId,
      commandId,
      _projectRoot: PROJECT_ROOT,
    });
    assert.equal(first.status, "cancelled");
    const afterFirst = loadBatchJobStore(ws, jobId, PROJECT_ROOT);
    assert.ok(afterFirst, "cancel 后任务应存在");
    const revisionAfterFirst = afterFirst.state.stateRevision;

    const second = await handleBatchGeneration({
      mode: "batch",
      action: "cancel",
      workspaceId: ws,
      jobId,
      commandId,
      _projectRoot: PROJECT_ROOT,
    });
    assert.equal(second.status, "cancelled");
    assert.equal(second.idempotent, true);
    const afterSecond = loadBatchJobStore(ws, jobId, PROJECT_ROOT);
    assert.equal(
      afterSecond.state.stateRevision,
      revisionAfterFirst,
      "重复 cancel 不得再次 CAS 写入",
    );
  });

  it("不同 commandId 再次 cancel 已取消任务返回 already_consumed", async () => {
    const ws = "batch-wave5-cancel-consumed";
    const workspacePath = freshWorkspace(ws);
    const mock = createMockGenerateChapter({
      workspacePath,
      failOnChapters: [1],
    });
    const jobId = "batch-wave5-cancel-consumed";
    const start = await handleBatchGeneration(baseStart(ws, {
      jobId,
      commandId: "cmd-consumed-setup",
      endChapter: 2,
      _mockGenerateChapter: mock,
    }));
    assert.equal(start.status, "paused");
    const firstCancel = await handleBatchGeneration({
      mode: "batch",
      action: "cancel",
      workspaceId: ws,
      jobId,
      commandId: "cmd-cancel-first",
      _projectRoot: PROJECT_ROOT,
    });
    assert.equal(firstCancel.status, "cancelled");

    const result = await handleBatchGeneration({
      mode: "batch",
      action: "cancel",
      workspaceId: ws,
      jobId,
      commandId: "cmd-cancel-other-002",
      _projectRoot: PROJECT_ROOT,
    });
    assert.equal(result.status, "error");
    assert.equal(result.concurrencyError, "already_consumed");
    assert.match(String(result.failureEnvelope?.reason ?? ""), /already_consumed/);
  });

  it("start 在已有 job 上 CAS 失败时返回 concurrent_state_update 且不重跑生成", async () => {
    const ws = "batch-wave5-cas-conflict";
    const workspacePath = freshWorkspace(ws);
    const jobId = "batch-wave5-cas-conflict";
    const mock1 = createMockGenerateChapter({ workspacePath });
    const first = await handleBatchGeneration(baseStart(ws, {
      jobId,
      commandId: "cmd-cas-first",
      _mockGenerateChapter: mock1,
    }));
    assert.equal(first.status, "completed");

    const generateCalls = [];
    const mock2 = async (input) => {
      generateCalls.push(input.chapterNumber);
      return mock1(input);
    };

    const conflicted = await handleBatchGeneration(baseStart(ws, {
      jobId,
      commandId: "cmd-cas-second",
      _mockGenerateChapter: mock2,
    }));
    assert.equal(conflicted.status, "error", "不同 commandId 复用同一 jobId 不得伪装成功");
    assert.equal(conflicted.concurrencyError, "concurrent_state_update");
    assert.match(
      String(conflicted.failureEnvelope?.reason ?? ""),
      /concurrent_state_update/,
    );
    assert.equal(generateCalls.length, 0, "CAS 失败不得进入生成");
  });

  it("resume 相同 commandId 不重复推进 frontier", async () => {
    const ws = "batch-wave5-resume-once";
    const workspacePath = freshWorkspace(ws);
    const jobId = "batch-wave5-resume-once";
    const mock = createMockGenerateChapter({
      workspacePath,
      failOnChapters: [1],
    });
    const started = await handleBatchGeneration(baseStart(ws, {
      jobId,
      commandId: "cmd-resume-setup",
      endChapter: 2,
      _mockGenerateChapter: mock,
    }));
    assert.equal(started.status, "paused");

    const resumeMock = createMockGenerateChapter({ workspacePath });
    const commandId = "cmd-resume-once-001";
    const first = await handleBatchGeneration({
      mode: "batch",
      action: "resume",
      workspaceId: ws,
      jobId,
      commandId,
      _projectRoot: PROJECT_ROOT,
      _mockGenerateChapter: resumeMock,
    });
    assert.ok(["completed", "paused", "error"].includes(first.status));
    const firstCalls = resumeMock.calls.length;

    const second = await handleBatchGeneration({
      mode: "batch",
      action: "resume",
      workspaceId: ws,
      jobId,
      commandId,
      _projectRoot: PROJECT_ROOT,
      _mockGenerateChapter: resumeMock,
    });
    assert.equal(second.idempotent, true);
    assert.equal(second.status, first.status);
    assert.equal(resumeMock.calls.length, firstCalls, "重复 resume 不得再次生成");
  });
});
