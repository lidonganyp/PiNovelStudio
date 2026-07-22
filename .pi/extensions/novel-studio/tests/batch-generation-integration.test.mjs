/**
 * BATCH 集成测试 — workspace 锁、ChapterSeed 阻断、FinalStateCommit 失败、工具注册
 *
 * 覆盖 TDD 验收点：
 *   #7  同一 workspace 同时启动两个任务会被拒绝
 *   #8  缺少 ChapterSeed 时不会调用模型
 *   #10 单章最终状态提交失败时，不推进批任务 frontier
 *   #13 完整注册工具集成测试（6 工具 + batch 分支）
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  loadGenerateChapterTool,
  createBatchWorkspace,
  createMockGenerateChapter,
  cleanupWorkspace,
  PROJECT_ROOT,
} from "./batch-test-helpers.mjs";

const INTEG_WORKSPACE = "batch-integration-test";

describe("BATCH 集成：锁 / ChapterSeed 阻断 / state commit 失败 / 工具注册", () => {
  let tool;

  before(async () => {
    createBatchWorkspace(INTEG_WORKSPACE);
    tool = await loadGenerateChapterTool();
  });

  after(() => {
    cleanupWorkspace(INTEG_WORKSPACE);
  });

  // ──────────────────────────────────────────────────────────────────────
  // TDD #7：同一 workspace 同时启动两个任务会被拒绝
  // ──────────────────────────────────────────────────────────────────────
  it("#7 同一 workspace 同时启动两个任务会被拒绝", async () => {
    const wsId = "batch-lock-test";
    const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
    createBatchWorkspace(wsId);

    // 手动创建一个锁文件（模拟已有运行中的任务）
    const lockPath = join(workspacePath, "batch-jobs", ".lock");
    const lockInfo = {
      workspaceId: wsId,
      jobId: "batch-existing-job-001",
      pid: process.pid,  // 当前进程存活
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2), "utf-8");

    const mock = createMockGenerateChapter({ workspacePath });
    const result = await tool.execute(
      "test-batch-lock-reject",
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

    const details = result.details || result;
    assert.equal(details.status, "error", "应被锁拒绝");
    assert.ok(details.failureEnvelope, "应有 failureEnvelope");
    assert.ok(
      typeof details.failureEnvelope.reason === "string" && details.failureEnvelope.reason.length > 0,
      "failureEnvelope.reason 应说明拒绝原因",
    );
    // mock 不应被调用（锁拒绝在编排前）
    assert.equal(mock.calls.length, 0, "锁拒绝时 mock 不应被调用");

    cleanupWorkspace(wsId);
  });

  // ──────────────────────────────────────────────────────────────────────
  // TDD #8：缺少 ChapterSeed 时不会调用模型
  //
  // workspace 缺少 config.json 的 chapterSeeds → 批量启动前应阻断。
  // ──────────────────────────────────────────────────────────────────────
  it("#8 缺少 ChapterSeed 时不会调用模型", async () => {
    const wsId = "batch-no-seed-test";
    const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
    createBatchWorkspace(wsId);

    // 删除 chapterSeeds 配置（模拟缺少 ChapterSeed）
    const configPath = join(workspacePath, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    delete config.chapterSeeds;
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    const mock = createMockGenerateChapter({ workspacePath });
    const result = await tool.execute(
      "test-batch-no-seed",
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

    const details = result.details || result;
    // 缺少 ChapterSeed 应在调用模型前阻断
    assert.ok(
      details.status === "error" || details.status === "paused",
      `缺少 ChapterSeed 应阻断（error 或 paused），实际 ${details.status}`,
    );
    assert.equal(mock.calls.length, 0, "缺少 ChapterSeed 时 mock 不应被调用");

    cleanupWorkspace(wsId);
  });

  // ──────────────────────────────────────────────────────────────────────
  // TDD #10：单章最终状态提交失败时，不推进批任务 frontier
  //
  // mock 返回 status=ok 但不写 state store → stateCommit 失败 → frontier 不推进。
  // ──────────────────────────────────────────────────────────────────────
  it("#10 单章最终状态提交失败时，不推进批任务 frontier", async () => {
    const wsId = "batch-state-commit-fail-test";
    const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
    createBatchWorkspace(wsId);

    // mock 写章节文件但不写 state store（模拟 FinalStateCommit 失败）
    const mock = createMockGenerateChapter({
      workspacePath,
      skipStateStore: true,
    });

    const result = await tool.execute(
      "test-batch-state-commit-fail",
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
    // state commit 失败应导致该章不推进 frontier → paused
    assert.ok(
      details.status === "paused" || details.status === "error",
      `state commit 失败应暂停（paused 或 error），实际 ${details.status}`,
    );
    assert.equal(details.completedChapters, 0, "应完成 0 章（第 1 章 state commit 失败）");
    assert.equal(details.failedChapter, 1, "失败章节应为第 1 章");
    // 只调用了第 1 章
    assert.equal(mock.calls.length, 1, "应只调用第 1 章");
    assert.equal(mock.calls[0].chapterNumber, 1, "第 1 次调用应是第 1 章");

    cleanupWorkspace(wsId);
  });

  // ──────────────────────────────────────────────────────────────────────
  // TDD #13：完整注册工具集成测试
  // 验证 6 工具注册 + batch 分支接线正确。
  // ──────────────────────────────────────────────────────────────────────
  it("#13 完整工具注册集成测试（6 工具 + batch 分支）", async () => {
    // 重新加载工具，验证 6 个公开工具全部注册
    const fakePi = {
      tools: new Map(),
      api: {
        registerTool(t) { fakePi.tools.set(t.name, t); },
        registerCommand() {},
        on() {},
      },
    };
    const { pathToFileURL } = await import("node:url");
    const { join: joinPath } = await import("node:path");
    const extRoot = joinPath(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
    const novelStudioExtension = (await import(pathToFileURL(joinPath(extRoot, "dist", "index.js")).href)).default;
    novelStudioExtension(fakePi.api);

    // 6 个公开工具
    const expectedTools = [
      "novel_generate_chapter",
      "novel_preflight_workspace",
      "novel_workspace_manager",
      "novel_plan_story_outline",
      "novel_strategy_policy_view",
      "novel_strategy_feedback",
    ];
    assert.equal(fakePi.tools.size, 6, `应注册 6 个公开工具，实际 ${fakePi.tools.size}`);
    for (const name of expectedTools) {
      assert.ok(fakePi.tools.has(name), `工具 ${name} 应注册`);
    }

    // novel_generate_chapter 应含 batch 分支字段
    const genTool = fakePi.tools.get("novel_generate_chapter");
    const genSchema = genTool.parameters || genTool.inputSchema;
    assert.ok(genSchema, "novel_generate_chapter 应有 parameters 或 inputSchema");
    const genProps = genSchema.properties || {};
    assert.ok(genProps.mode, "应含 mode 字段");
    assert.ok(genProps.action, "应含 action 字段");
    const genRequired = genSchema.required || [];
    assert.ok(
      genRequired.includes("workspaceId") && genRequired.includes("chapterId") && genRequired.includes("chapterNumber"),
      "required 应保持单章兼容",
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // 补充：>100 章需 confirmLargeBatch=true
  // ──────────────────────────────────────────────────────────────────────
  it(">100 章任务需 confirmLargeBatch=true（否则拒绝）", async () => {
    const wsId = "batch-large-reject-test";
    const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
    createBatchWorkspace(wsId);

    const mock = createMockGenerateChapter({ workspacePath });
    const result = await tool.execute(
      "test-batch-large-reject",
      {
        mode: "batch",
        action: "start",
        workspaceId: wsId,
        chapterId: "1",
        chapterNumber: 1,
        startChapter: 1,
        endChapter: 101,
        confirmLargeBatch: false,  // 不确认大批量
        _projectRoot: PROJECT_ROOT,
        _mockGenerateChapter: mock,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );

    const details = result.details || result;
    assert.equal(details.status, "error", ">100 章且未确认应被拒绝");
    assert.equal(mock.calls.length, 0, "拒绝时 mock 不应被调用");

    cleanupWorkspace(wsId);
  });

  it(">100 章任务 confirmLargeBatch=true 可执行（上限 1000）", async () => {
    const wsId = "batch-large-ok-test";
    const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
    createBatchWorkspace(wsId);

    const mock = createMockGenerateChapter({ workspacePath });
    const result = await tool.execute(
      "test-batch-large-ok",
      {
        mode: "batch",
        action: "start",
        workspaceId: wsId,
        chapterId: "1",
        chapterNumber: 1,
        startChapter: 1,
        endChapter: 101,
        confirmLargeBatch: true,  // 确认大批量
        _projectRoot: PROJECT_ROOT,
        _mockGenerateChapter: mock,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );

    const details = result.details || result;
    assert.equal(details.status, "completed", `confirmLargeBatch=true 时 101 章应完成: ${JSON.stringify(details.failureEnvelope)}`);
    assert.equal(details.completedChapters, 101, "应完成 101 章");
    assert.equal(mock.calls.length, 101, "应调用 101 次");

    cleanupWorkspace(wsId);
  });

  it(">1000 章任务即使 confirmLargeBatch=true 也被拒绝（硬上限）", async () => {
    const wsId = "batch-hard-cap-test";
    const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
    createBatchWorkspace(wsId);

    const mock = createMockGenerateChapter({ workspacePath });
    const result = await tool.execute(
      "test-batch-hard-cap",
      {
        mode: "batch",
        action: "start",
        workspaceId: wsId,
        chapterId: "1",
        chapterNumber: 1,
        startChapter: 1,
        endChapter: 1001,
        confirmLargeBatch: true,
        _projectRoot: PROJECT_ROOT,
        _mockGenerateChapter: mock,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );

    const details = result.details || result;
    assert.equal(details.status, "error", ">1000 章应被硬上限拒绝");
    assert.equal(mock.calls.length, 0, "拒绝时 mock 不应被调用");

    cleanupWorkspace(wsId);
  });
});
