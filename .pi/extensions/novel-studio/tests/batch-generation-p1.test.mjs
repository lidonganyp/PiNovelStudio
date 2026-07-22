/**
 * BATCH P1 测试 — summary trace / seed planner / extended preflight
 *
 * 覆盖 P1 验收点：
 *   P1-02  批量 summary trace 文件写入（每章耗时/模型调用/状态提交/失败 envelope）
 *   P1-03  可选 ChapterSeed 规划阶段（只输出结构化种子，不输出正文）
 *   P1-04  缺少世界观/角色档案/前章状态时在生成前阻断
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { existsSync, readFileSync, rmSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadGenerateChapterTool,
  createBatchWorkspace,
  createMockGenerateChapter,
  cleanupWorkspace,
  PROJECT_ROOT,
} from "./batch-test-helpers.mjs";

const P1_WORKSPACE = "batch-p1-test";

describe("BATCH P1：summary trace / seed planner / extended preflight", () => {
  let tool;

  before(async () => {
    createBatchWorkspace(P1_WORKSPACE);
    tool = await loadGenerateChapterTool();
  });

  after(() => {
    cleanupWorkspace(P1_WORKSPACE);
  });

  // ──────────────────────────────────────────────────────────────────────
  // P1-02：批量 summary trace 文件写入
  //
  // 批量任务完成后，traces/batch-{jobId}-summary.json 应存在，
  // 包含每章耗时、模型调用次数、状态提交结果和失败 envelope。
  // ──────────────────────────────────────────────────────────────────────
  describe("P1-02：batch summary trace", () => {
    it("完成后写入 batch-{jobId}-summary.json trace 文件", async () => {
      const wsId = "batch-p1-trace-test";
      const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
      createBatchWorkspace(wsId);

      const mock = createMockGenerateChapter({ workspacePath });
      const result = await tool.execute(
        "test-p1-trace",
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
      assert.equal(details.status, "completed", "应完成 3 章");

      // summary trace 文件应存在
      const summaryTracePath = join(
        workspacePath, "traces", `batch-${details.jobId}-summary.json`,
      );
      assert.ok(existsSync(summaryTracePath), `summary trace 应存在: ${summaryTracePath}`);

      // 解析 trace 内容
      const trace = JSON.parse(readFileSync(summaryTracePath, "utf-8"));
      assert.equal(trace.jobId, details.jobId, "trace jobId 匹配");
      assert.equal(trace.status, "completed", "trace status = completed");
      assert.equal(trace.startChapter, 1, "trace startChapter = 1");
      assert.equal(trace.endChapter, 3, "trace endChapter = 3");

      // summary 字段
      assert.ok(trace.summary, "trace 应含 summary");
      assert.equal(trace.summary.totalChapters, 3, "summary totalChapters = 3");
      assert.equal(trace.summary.completedChapters, 3, "summary completedChapters = 3");

      // per-chapter 结果
      assert.ok(Array.isArray(trace.chapters), "trace 应含 chapters 数组");
      assert.equal(trace.chapters.length, 3, "trace chapters 长度 = 3");
      for (const ch of trace.chapters) {
        assert.ok(typeof ch.chapterNumber === "number", "每章含 chapterNumber");
        assert.ok(typeof ch.durationMs === "number", "每章含 durationMs");
        assert.ok(typeof ch.modelCalls === "number", "每章含 modelCalls");
        assert.ok(ch.stateCommitResult, "每章含 stateCommitResult");
      }

      cleanupWorkspace(wsId);
    });

    it("失败章节的 summary trace 含 failureEnvelope", async () => {
      const wsId = "batch-p1-trace-fail-test";
      const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
      createBatchWorkspace(wsId);

      const mock = createMockGenerateChapter({
        workspacePath,
        failOnChapters: [2],
      });
      const result = await tool.execute(
        "test-p1-trace-fail",
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
      assert.equal(details.status, "paused", "应在第 2 章失败后暂停");

      const summaryTracePath = join(
        workspacePath, "traces", `batch-${details.jobId}-summary.json`,
      );
      assert.ok(existsSync(summaryTracePath), "summary trace 应存在");

      const trace = JSON.parse(readFileSync(summaryTracePath, "utf-8"));
      // 第 2 章应有 failureEnvelope
      const failedCh = trace.chapters.find((c) => c.chapterNumber === 2);
      assert.ok(failedCh, "trace 应含第 2 章结果");
      assert.equal(failedCh.status, "failed", "第 2 章状态 = failed");
      assert.ok(failedCh.failureEnvelope, "第 2 章应有 failureEnvelope");

      // summary 应含 failureEnvelopes
      assert.ok(
        Array.isArray(trace.summary.failureEnvelopes) && trace.summary.failureEnvelopes.length > 0,
        "summary 应含 failureEnvelopes",
      );

      cleanupWorkspace(wsId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // P1-03：可选 ChapterSeed 规划阶段（P0-FIX-3：写入 series/ch{N}-outline-explicit.md）
  //
  // seedSource="workspace_or_planner" 且无 workspace 种子时，
  // 规划阶段应生成 series/ch{N}-outline-explicit.md 显式章纲文件。
  // ChapterSeedBuilder.loadAuthorChapterContract 会读取此文件。
  // ──────────────────────────────────────────────────────────────────────
  describe("P1-03：ChapterSeed 规划阶段", () => {
    it("workspace_or_planner 模式下无种子时自动规划显式章纲", async () => {
      const wsId = "batch-p1-planner-test";
      const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
      createBatchWorkspace(wsId);

      // 确保无显式章纲（模拟无种子）
      const explicitPath = join(workspacePath, "series", "ch1-outline-explicit.md");
      assert.ok(!existsSync(explicitPath), "不应有显式章纲");

      const mock = createMockGenerateChapter({ workspacePath });
      const result = await tool.execute(
        "test-p1-planner",
        {
          mode: "batch",
          action: "start",
          workspaceId: wsId,
          chapterId: "1",
          chapterNumber: 1,
          startChapter: 1,
          endChapter: 3,
          seedSource: "workspace_or_planner",
          _projectRoot: PROJECT_ROOT,
          _mockGenerateChapter: mock,
        },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT },
      );

      const details = result.details || result;
      // 规划阶段应生成显式章纲，批量任务应成功执行（不被阻断）
      assert.equal(details.status, "completed", "规划显式章纲后应完成批量任务");
      assert.equal(mock.calls.length, 3, "应调用 3 章模型");

      // P0-FIX-3：规划的显式章纲应写入 series/ch{N}-outline-explicit.md（不是 batch-jobs/planned-seeds/）
      for (let n = 1; n <= 3; n++) {
        const outlinePath = join(workspacePath, "series", `ch${n}-outline-explicit.md`);
        assert.ok(existsSync(outlinePath), `应生成 series/ch${n}-outline-explicit.md`);
      }

      // 验证显式章纲文件是 markdown 格式（非正文），可被 parseExplicitOutline 解析
      const outline1Text = readFileSync(join(workspacePath, "series", "ch1-outline-explicit.md"), "utf-8");
      assert.ok(outline1Text.includes("## 事件 1"), "显式章纲应含 `## 事件 1` 事件头");
      assert.ok(outline1Text.includes("内容摘要"), "显式章纲应含内容摘要字段");
      // 不得含正文内容
      assert.ok(!outline1Text.includes("# 第1章\n\n这是第1章的正文"), "显式章纲不得含正文");

      // 旧的 planned-seeds 目录不应存在（P0-FIX-3：不再写 JSON 到该目录）
      const oldSeedsDir = join(workspacePath, "batch-jobs", "planned-seeds");
      assert.ok(!existsSync(oldSeedsDir), "不应再创建 batch-jobs/planned-seeds 目录");

      cleanupWorkspace(wsId);
    });

    it("workspace_only 模式下无种子时阻断（不规划）", async () => {
      const wsId = "batch-p1-no-planner-test";
      const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
      createBatchWorkspace(wsId);

      // 确保无显式章纲
      const explicitPath = join(workspacePath, "series", "ch1-outline-explicit.md");
      assert.ok(!existsSync(explicitPath), "不应有显式章纲");

      const mock = createMockGenerateChapter({ workspacePath });
      const result = await tool.execute(
        "test-p1-no-planner",
        {
          mode: "batch",
          action: "start",
          workspaceId: wsId,
          chapterId: "1",
          chapterNumber: 1,
          startChapter: 1,
          endChapter: 3,
          seedSource: "workspace_only",
          _projectRoot: PROJECT_ROOT,
          _mockGenerateChapter: mock,
        },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT },
      );

      const details = result.details || result;
      // workspace_only 模式下无种子 → 阻断
      assert.ok(
        details.status === "error" || details.status === "paused",
        `workspace_only 无种子应阻断，实际 ${details.status}`,
      );
      assert.equal(mock.calls.length, 0, "workspace_only 无种子时不应调用模型");

      // 不应生成规划显式章纲
      assert.ok(!existsSync(explicitPath), "workspace_only 模式不应生成显式章纲");

      cleanupWorkspace(wsId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // P1-04：扩展 preflight 检查
  //
  // 缺少世界观（genre）/角色档案/前章状态时，在生成前阻断。
  // ──────────────────────────────────────────────────────────────────────
  describe("P1-04：扩展 preflight 阻断", () => {
    it("缺少 config.json genre（世界观）时阻断", async () => {
      const wsId = "batch-p1-no-genre-test";
      const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
      createBatchWorkspace(wsId);

      // 删除 genre 字段
      const configPath = join(workspacePath, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      delete config.genre;
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

      const mock = createMockGenerateChapter({ workspacePath });
      const result = await tool.execute(
        "test-p1-no-genre",
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
      assert.equal(details.status, "error", "缺少 genre 应阻断");
      assert.equal(mock.calls.length, 0, "缺少 genre 时不应调用模型");
      assert.ok(
        details.failureEnvelope?.reason?.includes("genre") ||
        details.failureEnvelope?.reason?.includes("世界观"),
        "阻断原因应提及 genre 或世界观",
      );

      cleanupWorkspace(wsId);
    });

    it("缺少角色档案目录时阻断", async () => {
      const wsId = "batch-p1-no-chars-test";
      const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
      createBatchWorkspace(wsId);

      // 删除角色档案目录
      rmSync(join(workspacePath, "characters"), { recursive: true, force: true });

      const mock = createMockGenerateChapter({ workspacePath });
      const result = await tool.execute(
        "test-p1-no-chars",
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
      assert.equal(details.status, "error", "缺少角色档案应阻断");
      assert.equal(mock.calls.length, 0, "缺少角色档案时不应调用模型");

      cleanupWorkspace(wsId);
    });

    it("startChapter > 1 且无前章状态时阻断", async () => {
      const wsId = "batch-p1-no-prior-state-test";
      const workspacePath = join(PROJECT_ROOT, "workspaces", wsId);
      createBatchWorkspace(wsId);

      // 确保无 narrative-state-store.json
      const stateStorePath = join(workspacePath, "narrative-state-store.json");
      assert.ok(!existsSync(stateStorePath), "不应有前章状态");

      const mock = createMockGenerateChapter({ workspacePath });
      const result = await tool.execute(
        "test-p1-no-prior-state",
        {
          mode: "batch",
          action: "start",
          workspaceId: wsId,
          chapterId: "2",
          chapterNumber: 2,
          startChapter: 2,
          endChapter: 4,
          _projectRoot: PROJECT_ROOT,
          _mockGenerateChapter: mock,
        },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT },
      );

      const details = result.details || result;
      assert.equal(details.status, "error", "缺前章状态应阻断");
      assert.equal(mock.calls.length, 0, "缺前章状态时不应调用模型");
      assert.ok(
        details.failureEnvelope?.reason?.includes("前章") ||
        details.failureEnvelope?.reason?.includes("state") ||
        details.failureEnvelope?.reason?.includes("narrative"),
        "阻断原因应提及前章状态",
      );

      cleanupWorkspace(wsId);
    });
  });
});
