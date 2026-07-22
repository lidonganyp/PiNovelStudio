/**
 * BATCH checkpoint 测试 — 进程重启恢复、幂等 resume、cancel 不破坏已完成
 *
 * 覆盖 TDD 验收点：
 *   #4  进程重启后从 checkpoint 恢复，不重复第 1 章
 *   #6  cancel 不会破坏当前已完成章节
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  loadGenerateChapterTool,
  createBatchWorkspace,
  createMockGenerateChapter,
  writeStateStoreEntry,
  cleanupWorkspace,
  PROJECT_ROOT,
} from "./batch-test-helpers.mjs";

const CKPT_WORKSPACE = "batch-checkpoint-test";

describe("BATCH checkpoint：进程重启恢复 / cancel 不破坏", () => {
  let tool;

  before(async () => {
    createBatchWorkspace(CKPT_WORKSPACE);
    tool = await loadGenerateChapterTool();
  });

  after(() => {
    cleanupWorkspace(CKPT_WORKSPACE);
  });

  // ──────────────────────────────────────────────────────────────────────
  // TDD #4：进程重启后从 checkpoint 恢复，不重复第 1 章
  //
  // 模拟：第 1 章已完成（文件 + state store entry），checkpoint 记录 frontier=2。
  // resume 后应从第 2 章开始，不重复调用第 1 章。
  // ──────────────────────────────────────────────────────────────────────
  it("#4 进程重启后从 checkpoint 恢复，不重复第 1 章", async () => {
    const wsId = "batch-restart-test";
    const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
    createBatchWorkspace(wsId);

    // 模拟第 1 章已完成（进程退出前的状态）
    const chapter1Text = "# 第1章\n\n这是第1章正文。";
    writeFileSync(join(workspacePath, "chapters", "1.md"), chapter1Text, "utf-8");
    writeStateStoreEntry(workspacePath, 1, chapter1Text);

    // 手动构造 checkpoint 文件（模拟进程退出前保存的 BatchJobState）
    const jobId = "batch-restart-test-001";
    const checkpointPath = join(workspacePath, "batch-jobs", `${jobId}.json`);
    const checkpoint = {
      jobId,
      workspaceId: wsId,
      status: "paused",
      startChapter: 1,
      endChapter: 3,
      seedSource: "workspace_or_planner",
      stopOnFailure: true,
      confirmLargeBatch: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      frontier: 2,  // 第 1 章已完成，下一章是第 2 章
      completedChapters: [1],
      failedChapter: null,
      chapters: [
        {
          chapterNumber: 1,
          chapterId: "1",
          status: "completed",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          chapterFilePath: join(workspacePath, "chapters", "1.md"),
        },
      ],
      cancelRequested: false,
    };
    writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf-8");

    // resume：从第 2 章继续
    const mock = createMockGenerateChapter({ workspacePath });
    const result = await tool.execute(
      "test-batch-restart-resume",
      {
        mode: "batch",
        action: "resume",
        workspaceId: wsId,
        chapterId: "1",
        chapterNumber: 1,
        jobId,
        _projectRoot: PROJECT_ROOT,
        _mockGenerateChapter: mock,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );

    const details = result.details || result;
    assert.equal(details.status, "completed", `resume 后应完成: ${JSON.stringify(details.failureEnvelope)}`);
    assert.equal(details.completedChapters, 3, "应完成 3 章");

    // 关键：第 1 章不应被重复调用
    assert.equal(mock.calls.length, 2, `mock 应只被调用 2 次（第 2、3 章），实际 ${mock.calls.length}`);
    assert.equal(mock.calls[0].chapterNumber, 2, "第 1 次调用应是第 2 章");
    assert.equal(mock.calls[1].chapterNumber, 3, "第 2 次调用应是第 3 章");
    assert.ok(
      !mock.calls.some(c => c.chapterNumber === 1),
      "第 1 章不应被重复调用",
    );

    cleanupWorkspace(wsId);
  });

  // ──────────────────────────────────────────────────────────────────────
  // TDD #6：cancel 不会破坏当前已完成章节
  //
  // cancel 设置 cancelRequested=true。运行循环在下一章开始前检查并停止。
  // 已完成的章节文件不被删除。
  // ──────────────────────────────────────────────────────────────────────
  it("#6 cancel 不会破坏当前已完成章节", async () => {
    const wsId = "batch-cancel-test";
    const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
    createBatchWorkspace(wsId);

    // 先 start 一个 5 章任务（mock 会逐章完成）
    const mock = createMockGenerateChapter({ workspacePath });
    const startResult = await tool.execute(
      "test-batch-cancel-start",
      {
        mode: "batch",
        action: "start",
        workspaceId: wsId,
        chapterId: "1",
        chapterNumber: 1,
        startChapter: 1,
        endChapter: 5,
        _projectRoot: PROJECT_ROOT,
        _mockGenerateChapter: mock,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );
    const startDetails = startResult.details || startResult;
    const jobId = startDetails.jobId;

    // 任务应已完成（mock 很快）。验证所有章节文件存在。
    assert.equal(startDetails.status, "completed", "5 章应完成");
    for (let i = 1; i <= 5; i++) {
      const chapterFile = join(workspacePath, "chapters", `${i}.md`);
      assert.ok(existsSync(chapterFile), `第 ${i} 章文件应存在`);
    }

    // cancel 已完成的任务：不应破坏已完成章节
    const cancelResult = await tool.execute(
      "test-batch-cancel-cancel",
      {
        mode: "batch",
        action: "cancel",
        workspaceId: wsId,
        chapterId: "1",
        chapterNumber: 1,
        jobId,
        _projectRoot: PROJECT_ROOT,
        _mockGenerateChapter: mock,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );
    const cancelDetails = cancelResult.details || cancelResult;

    // cancel 后所有章节文件仍应存在
    for (let i = 1; i <= 5; i++) {
      const chapterFile = join(workspacePath, "chapters", `${i}.md`);
      assert.ok(existsSync(chapterFile), `cancel 后第 ${i} 章文件仍应存在`);
    }

    cleanupWorkspace(wsId);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 补充：cancel 对运行中任务的停止行为
  // 由于同步执行模式下 start 阻塞直到完成，无法在运行中 cancel。
  // cancel 主要用于：任务因失败 paused 后用户决定放弃。
  // ──────────────────────────────────────────────────────────────────────
  it("cancel paused 任务后 resume 被拒绝", async () => {
    const wsId = "batch-cancel-paused-test";
    const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
    createBatchWorkspace(wsId);

    // 第 2 章失败 → paused
    const mock = createMockGenerateChapter({ workspacePath, failOnChapters: [2] });
    const startResult = await tool.execute(
      "test-batch-cancel-paused-start",
      {
        mode: "batch",
        action: "start",
        workspaceId: wsId,
        chapterId: "1",
        chapterNumber: 1,
        startChapter: 1,
        endChapter: 3,
        _projectRoot: PROJECT_ROOT,
        _mockGenerateChapter: mock,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );
    const startDetails = startResult.details || startResult;
    assert.equal(startDetails.status, "paused", "应因第 2 章失败暂停");
    const jobId = startDetails.jobId;

    // cancel
    const cancelResult = await tool.execute(
      "test-batch-cancel-paused-cancel",
      {
        mode: "batch",
        action: "cancel",
        workspaceId: wsId,
        chapterId: "1",
        chapterNumber: 1,
        jobId,
        _projectRoot: PROJECT_ROOT,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );
    const cancelDetails = cancelResult.details || cancelResult;
    assert.equal(cancelDetails.status, "cancelled", "cancel 后状态应为 cancelled");

    // resume 已 cancelled 的任务应被拒绝
    const resumeResult = await tool.execute(
      "test-batch-cancel-paused-resume",
      {
        mode: "batch",
        action: "resume",
        workspaceId: wsId,
        chapterId: "1",
        chapterNumber: 1,
        jobId,
        _projectRoot: PROJECT_ROOT,
        _mockGenerateChapter: mock,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );
    const resumeDetails = resumeResult.details || resumeResult;
    assert.ok(
      resumeDetails.status === "error" || resumeDetails.status === "cancelled",
      `resume cancelled 任务应被拒绝（error 或 cancelled），实际 ${resumeDetails.status}`,
    );

    // 第 1 章文件仍应存在（cancel 不破坏）
    assert.ok(existsSync(join(workspacePath, "chapters", "1.md")), "cancel 后第 1 章仍应存在");

    cleanupWorkspace(wsId);
  });
});
