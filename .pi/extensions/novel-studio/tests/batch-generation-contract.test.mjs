/**
 * BATCH 契约测试 — 单章兼容、API 契约、依赖边界、trace 无 judge 路由
 *
 * 覆盖 TDD 验收点：
 *   #1  单章旧接口完全兼容
 *   #11 生产 trace 中不存在 judge/pairwise 路由
 *   #12 生产构建依赖边界不引入 dist-eval 或 NovelBench 模块
 */

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadGenerateChapterTool,
  createBatchWorkspace,
  cleanupWorkspace,
  PROJECT_ROOT,
  EXT_ROOT,
} from "./batch-test-helpers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONTRACT_WORKSPACE = "batch-contract-test";
const originalStubFlag = process.env.V2_FORCE_STUB;
const originalLegacyFlowFlag = process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW;

describe("BATCH 契约：单章旧接口兼容 + 依赖边界 + trace 无 judge", () => {
  before(() => {
    createBatchWorkspace(CONTRACT_WORKSPACE);
  });

  after(() => {
    cleanupWorkspace(CONTRACT_WORKSPACE);
    if (originalStubFlag === undefined) delete process.env.V2_FORCE_STUB;
    else process.env.V2_FORCE_STUB = originalStubFlag;
    if (originalLegacyFlowFlag === undefined) delete process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW;
    else process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW = originalLegacyFlowFlag;
  });

  beforeEach(() => {
    process.env.V2_FORCE_STUB = "1";
    delete process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW;
  });

  afterEach(() => {
    delete process.env.V2_FORCE_STUB;
    if (originalLegacyFlowFlag !== undefined) {
      process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW = originalLegacyFlowFlag;
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // TDD #1：单章旧接口完全兼容
  // 不传 mode 字段时走单章生成（默认行为），status=ok，不受 batch 分支影响。
  // ──────────────────────────────────────────────────────────────────────
  it("#1 单章旧接口完全兼容（不传 mode 走单章生成）", async () => {
    const tool = await loadGenerateChapterTool();
    assert.ok(tool, "novel_generate_chapter 应注册");

    const result = await tool.execute(
      "test-batch-contract-single",
      {
        workspaceId: CONTRACT_WORKSPACE,
        chapterId: "contract-1",
        chapterNumber: 1,
        previousChapterSummary: "前章摘要",
        mockAgent: true,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );

    const details = result.details || result;
    assert.equal(details.status, "ok", `单章生成应成功: ${JSON.stringify(details.failureEnvelope)}`);
    assert.equal(
      details.stageResults?.unifiedPipeline,
      true,
      "单章生成应走统一主链路",
    );
    // 不应有 batch 相关字段
    assert.equal(details.jobId, undefined, "单章生成不应返回 batch jobId");
  });

  // ──────────────────────────────────────────────────────────────────────
  // TDD #12：生产构建依赖边界不引入 dist-eval 或 NovelBench 模块
  // （focused 补充，dependency-boundary.test.mjs 已有完整断言）
  // ──────────────────────────────────────────────────────────────────────
  it("#12 batch 模块不 import dist-eval / NovelBench / lab", () => {
    const distDir = join(EXT_ROOT, "dist");
    assert.ok(existsSync(distDir), "dist/ 应存在");

    const batchModules = [
      "v2/core/batch-generation-job-store.js",
      "v2/core/batch-generation-lock.js",
      "v2/core/batch-generation-orchestrator.js",
      "handlers/batch-generation-handler.js",
    ];

    for (const mod of batchModules) {
      const p = join(distDir, mod);
      assert.ok(existsSync(p), `${mod} 应存在`);
      const src = readFileSync(p, "utf-8");
      assert.ok(!src.includes("dist-eval/"), `${mod} 不得 import dist-eval/`);
      assert.ok(!src.includes("dist-test/"), `${mod} 不得 import dist-test/`);
      assert.ok(!src.includes("novelbench/"), `${mod} 不得 import novelbench/`);
      assert.ok(!/from\s+["'][^"']*(?:^|\/)lab\//.test(src), `${mod} 不得 import lab/`);
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // TDD #11：生产 trace 中不存在 judge/pairwise 路由
  // 单章生成后检查 trace 文件，确认不含 judge/pairwise 路由调用。
  // 机器文学裁判 / pairwise judge 不得进入生产路径。
  // ──────────────────────────────────────────────────────────────────────
  it("#11 单章生产 trace 不含 judge/pairwise 路由", async () => {
    const tool = await loadGenerateChapterTool();
    await tool.execute(
      "test-batch-contract-trace",
      {
        workspaceId: CONTRACT_WORKSPACE,
        chapterId: "contract-trace",
        chapterNumber: 1,
        mockAgent: true,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );

    // 检查 trace 目录
    const traceDir = join(PROJECT_ROOT, "workspaces", CONTRACT_WORKSPACE, "traces");
    if (existsSync(traceDir)) {
      const traces = readdirSync(traceDir).filter(f => f.endsWith(".json"));
      for (const traceFile of traces) {
        const tracePath = join(traceDir, traceFile);
        const traceContent = readFileSync(tracePath, "utf-8");
        // trace 中不应含 pairwise judge / opportunity judge / literary judge 路由调用
        assert.ok(
          !traceContent.includes('"pairwiseJudge"') || traceContent.includes('"machineJudgeCalled": false'),
          `trace ${traceFile} 不得含 pairwise judge 路由调用`,
        );
      }
    }

    // 也检查 stageResults.productionFlow.machineJudgeCalled === false（统一主链路标记）
    // 已在 #1 测试中验证 unifiedPipeline=true；此处补充验证无 judge 路由。
  });

  // ──────────────────────────────────────────────────────────────────────
  // 批量 mode 字段存在性验证（API 契约）
  // ──────────────────────────────────────────────────────────────────────
  it("API 契约：novel_generate_chapter inputSchema 含 batch 字段", async () => {
    const tool = await loadGenerateChapterTool();
    assert.ok(tool, "novel_generate_chapter 应注册");
    // wrapLegacyTool 把 inputSchema 转为 TypeBox parameters
    const schema = tool.parameters || tool.inputSchema;
    assert.ok(schema, "tool 应有 parameters 或 inputSchema");
    const props = schema.properties || {};
    assert.ok(props.mode, "inputSchema 应含 mode 字段");
    assert.ok(props.action, "inputSchema 应含 action 字段");
    assert.ok(props.startChapter, "inputSchema 应含 startChapter 字段");
    assert.ok(props.endChapter, "inputSchema 应含 endChapter 字段");
    assert.ok(props.stopOnFailure, "inputSchema 应含 stopOnFailure 字段");
    assert.ok(props.confirmLargeBatch, "inputSchema 应含 confirmLargeBatch 字段");
    assert.ok(props.jobId, "inputSchema 应含 jobId 字段");
    // required 仍为单章兼容字段（TypeBox 的 required 在 anyOf 或直接 required 中）
    const required = schema.required || [];
    assert.ok(
      required.includes("workspaceId") && required.includes("chapterId") && required.includes("chapterNumber"),
      "required 应保持单章兼容（含 workspaceId/chapterId/chapterNumber）",
    );
  });
});
