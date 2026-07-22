/**
 * BATCH 编排测试 — 串行执行、失败暂停、幂等 resume、100 章 mock
 *
 * 覆盖 TDD 验收点：
 *   #2  新建 3 章批任务按 N → N+1 → N+2 严格串行
 *   #3  第 2 章失败后第 3 章不会调用
 *   #9  100 章 mock 任务全部生成并保存
 *   #5  重复 resume 具有幂等性
 */

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  loadGenerateChapterTool,
  createBatchWorkspace,
  createMockGenerateChapter,
  cleanupWorkspace,
  PROJECT_ROOT,
} from "./batch-test-helpers.mjs";

const ORCH_WORKSPACE = "batch-orchestration-test";

describe("BATCH 编排：串行 / 失败暂停 / 100 章 / 幂等", () => {
  let tool;

  before(async () => {
    createBatchWorkspace(ORCH_WORKSPACE);
    tool = await loadGenerateChapterTool();
  });

  after(() => {
    cleanupWorkspace(ORCH_WORKSPACE);
  });

  // ──────────────────────────────────────────────────────────────────────
  // TDD #2：新建 3 章批任务按 N → N+1 → N+2 严格串行
  // ──────────────────────────────────────────────────────────────────────
  it("#2 新建 3 章批任务按 1 → 2 → 3 严格串行", async () => {
    const workspacePath = join(PROJECT_ROOT, "workspaces", ORCH_WORKSPACE);
    const mock = createMockGenerateChapter({ workspacePath });

    const result = await tool.execute(
      "test-batch-serial-3",
      {
        mode: "batch",
        action: "start",
        workspaceId: ORCH_WORKSPACE,
        chapterId: "1",
        chapterNumber: 1,
        startChapter: 1,
        endChapter: 3,
        stopOnFailure: true,
        _projectRoot: PROJECT_ROOT,
        _mockGenerateChapter: mock,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );

    const details = result.details || result;
    assert.equal(details.status, "completed", `3 章应全部完成: ${JSON.stringify(details.failureEnvelope)}`);
    assert.equal(details.completedChapters, 3, "应完成 3 章");
    assert.equal(details.totalChapters, 3, "总章节数应为 3");

    // 串行验证：mock.calls 应按 1, 2, 3 顺序
    assert.equal(mock.calls.length, 3, "mock 应被调用 3 次");
    assert.equal(mock.calls[0].chapterNumber, 1, "第 1 次调用应是第 1 章");
    assert.equal(mock.calls[1].chapterNumber, 2, "第 2 次调用应是第 2 章");
    assert.equal(mock.calls[2].chapterNumber, 3, "第 3 次调用应是第 3 章");

    // 章节文件应存在
    for (let i = 1; i <= 3; i++) {
      const chapterFile = join(workspacePath, "chapters", `${i}.md`);
      assert.ok(existsSync(chapterFile), `第 ${i} 章文件应存在`);
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // TDD #3：第 2 章失败后第 3 章不会调用
  // ──────────────────────────────────────────────────────────────────────
  it("#3 第 2 章失败后第 3 章不会调用", async () => {
    const wsId = "batch-fail-stop-test";
    const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
    createBatchWorkspace(wsId);

    const mock = createMockGenerateChapter({
      workspacePath,
      failOnChapters: [2],
    });

    const result = await tool.execute(
      "test-batch-fail-stop",
      {
        mode: "batch",
        action: "start",
        workspaceId: wsId,
        chapterId: "1",
        chapterNumber: 1,
        startChapter: 1,
        endChapter: 3,
        stopOnFailure: true,
        _projectRoot: PROJECT_ROOT,
        _mockGenerateChapter: mock,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );

    const details = result.details || result;
    assert.equal(details.status, "paused", `第 2 章失败应暂停: ${JSON.stringify(details)}`);
    assert.equal(details.failedChapter, 2, "失败章节应为第 2 章");
    assert.equal(details.completedChapters, 1, "应只完成 1 章");
    assert.equal(mock.calls.length, 2, "mock 应只被调用 2 次（第 1 章 + 第 2 章失败）");
    assert.equal(mock.calls[1].chapterNumber, 2, "第 2 次调用应是第 2 章");
    // 第 3 章不应被调用
    assert.ok(
      !mock.calls.some(c => c.chapterNumber === 3),
      "第 3 章不应被调用",
    );

    // 失败应形成结构化 FailureEnvelope
    assert.ok(details.failureEnvelope, "应有 failureEnvelope");
    assert.ok(details.failureEnvelope.stage || details.failureEnvelope.reason, "failureEnvelope 应含 stage/reason");

    cleanupWorkspace(wsId);
  });

  // ──────────────────────────────────────────────────────────────────────
  // TDD #9：100 章 mock 任务全部生成并保存
  // ──────────────────────────────────────────────────────────────────────
  it("#9 100 章 mock 任务全部生成并保存", async () => {
    const wsId = "batch-100ch-test";
    const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
    createBatchWorkspace(wsId);

    const mock = createMockGenerateChapter({ workspacePath });

    const result = await tool.execute(
      "test-batch-100ch",
      {
        mode: "batch",
        action: "start",
        workspaceId: wsId,
        chapterId: "1",
        chapterNumber: 1,
        startChapter: 1,
        endChapter: 100,
        stopOnFailure: true,
        _projectRoot: PROJECT_ROOT,
        _mockGenerateChapter: mock,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );

    const details = result.details || result;
    assert.equal(details.status, "completed", `100 章应全部完成: ${JSON.stringify(details.failureEnvelope)}`);
    assert.equal(details.completedChapters, 100, "应完成 100 章");
    assert.equal(details.totalChapters, 100, "总章节数应为 100");
    assert.equal(mock.calls.length, 100, "mock 应被调用 100 次（每章独立调用）");

    // 验证 100 章文件全部存在
    for (let i = 1; i <= 100; i++) {
      const chapterFile = join(workspacePath, "chapters", `${i}.md`);
      assert.ok(existsSync(chapterFile), `第 ${i} 章文件应存在`);
    }

    // 验证 state store 含 100 章 entry
    const stateStorePath = join(workspacePath, "narrative-state-store.json");
    assert.ok(existsSync(stateStorePath), "state store 应存在");
    const store = JSON.parse(readFileSync(stateStorePath, "utf-8"));
    const allEntries = [
      ...(store.canon || []),
      ...(store.character || []),
      ...(store.promise || []),
      ...(store.pattern || []),
      ...(store.expectation || []),
    ];
    const ch1to100 = allEntries.filter(e => e?.sourceChapter?.match(/^ch\d+$/));
    assert.ok(ch1to100.length >= 100, `state store 应含至少 100 个 ch entry，实际 ${ch1to100.length}`);

    cleanupWorkspace(wsId);
  });

  // ──────────────────────────────────────────────────────────────────────
  // TDD #5：重复 resume 具有幂等性
  // 已完成的任务 resume 不重复调用模型，不重复写章节。
  // ──────────────────────────────────────────────────────────────────────
  it("#5 重复 resume 具有幂等性（已完成任务不重复调用）", async () => {
    const wsId = "batch-idempotent-test";
    const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
    createBatchWorkspace(wsId);

    const mock = createMockGenerateChapter({ workspacePath });

    // 第一次 start：完成 3 章
    const startResult = await tool.execute(
      "test-batch-idempotent-start",
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
    assert.equal(startDetails.status, "completed", "首次 start 应完成");
    const firstCallCount = mock.calls.length;
    const jobId = startDetails.jobId;

    // 第二次 resume：不应重复调用模型
    const resumeResult = await tool.execute(
      "test-batch-idempotent-resume",
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
    assert.equal(resumeDetails.status, "completed", "resume 应完成");
    assert.equal(resumeDetails.completedChapters, 3, "resume 后仍应只完成 3 章");
    assert.equal(mock.calls.length, firstCallCount, `resume 不应重复调用模型（${firstCallCount} → ${mock.calls.length}）`);

    cleanupWorkspace(wsId);
  });
});
