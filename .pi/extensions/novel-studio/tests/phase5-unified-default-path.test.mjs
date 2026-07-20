/**
 * Phase 5/7：统一主链路默认路径验证（生产入口 smoke）
 *
 * Step 2 逻辑隔离后，本文件仅验证生产入口（dist/index.js）的统一主链路：
 *   novel_generate_chapter 始终走统一主链路（raw → editorial → judge → select → commit）
 *   （stageResults.unifiedPipeline === true，无 legacy Stage0-8 字段）
 *
 * legacy_test 工具的 Stage0-8 链路验证（原 phase5-legacy-test-tool.test.mjs）已在
 * LEGACY-TEST-TOOL-REPLACEMENT-1 删除——legacy Stage0-8 行为随统一主链路收敛不再保留。
 *
 * 为避免真实 API 调用，统一主链路用例设 V2_FORCE_STUB=1 使 unified-entry 使用
 * stub ModelGenerateFn（与 v2 内核 phase5 单元测试同模式，A3 后位于 ./v2/）。
 */

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

const PHASE5_WORKSPACE = join(PROJECT_ROOT, "workspaces", "phase5-unified-default");
const originalStubFlag = process.env.V2_FORCE_STUB;

/**
 * 通过 fake PI 注册工具，返回 novel_generate_chapter 工具实例。
 */
async function loadGenerateChapterTool() {
  const fakePi = {
    tools: new Map(),
    api: {
      registerTool(t) { fakePi.tools.set(t.name, t); },
      registerCommand() {},
      on() {},
    },
  };
  const novelStudioExtension = (await import(pathToFileURL(join(EXT_ROOT, "dist", "index.js")).href)).default;
  novelStudioExtension(fakePi.api);
  return fakePi.tools.get("novel_generate_chapter");
}

function createMinimalWorkspace() {
  rmSync(PHASE5_WORKSPACE, { recursive: true, force: true });
  mkdirSync(join(PHASE5_WORKSPACE, "chapters"), { recursive: true });
  mkdirSync(join(PHASE5_WORKSPACE, "characters"), { recursive: true });
  mkdirSync(join(PHASE5_WORKSPACE, "series"), { recursive: true });

  const config = {
    name: "Phase5 默认路径验证",
    genre: "玄幻",
    subGenres: ["东方玄幻"],
    totalChapters: 50,
    chapterType: "standard",
    serialFrequency: "daily",
    characters: [
      { id: "protagonist-1", name: "叶尘", role: "protagonist" },
    ],
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(PHASE5_WORKSPACE, "config.json"), JSON.stringify(config, null, 2), "utf-8");

  writeFileSync(
    join(PHASE5_WORKSPACE, "series", "outline.md"),
    "# 大纲\n## 第1章\n故事开始。\n",
    "utf-8",
  );

  writeFileSync(
    join(PHASE5_WORKSPACE, "characters", "叶尘.md"),
    "# 叶尘\n主角，废物少年，偶得传承。\n",
    "utf-8",
  );

  return PHASE5_WORKSPACE;
}

describe("Phase 5/7：统一主链路为唯一生产路径", () => {
  before(() => {
    createMinimalWorkspace();
  });

  after(() => {
    rmSync(PHASE5_WORKSPACE, { recursive: true, force: true });
    if (originalStubFlag === undefined) {
      delete process.env.V2_FORCE_STUB;
    } else {
      process.env.V2_FORCE_STUB = originalStubFlag;
    }
  });

  beforeEach(() => {
    // stub 模型（无真实 API 调用）
    process.env.V2_FORCE_STUB = "1";
  });

  afterEach(() => {
    delete process.env.V2_FORCE_STUB;
  });

  it("novel_generate_chapter 始终走统一主链路，不走 legacy Stage0-8", async () => {
    const tool = await loadGenerateChapterTool();
    assert.ok(tool, "novel_generate_chapter 应注册");

    const result = await tool.execute(
      "test-phase5-default-unified",
      {
        workspaceId: "phase5-unified-default",
        chapterId: "1",
        chapterNumber: 1,
        previousChapterSummary: "前章摘要",
        mockAgent: true,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );

    const details = result.details || result;
    const stageResults = details.stageResults || {};

    // 统一主链路标记必须存在（unified-entry.ts 或 index.ts 错误兜底均设此字段）
    assert.equal(
      stageResults.unifiedPipeline,
      true,
      `默认路径应走统一主链路（stageResults.unifiedPipeline=true），实际: ${stageResults.unifiedPipeline}`,
    );

    // legacy Stage0-8 专属字段必须缺失，证明未走 legacy 编排
    assert.equal(
      stageResults.styleShaperRoute,
      undefined,
      "统一主链路不应产生 legacy 的 styleShaperRoute 字段",
    );
    assert.equal(
      stageResults.stage2_narrator,
      undefined,
      "统一主链路不应产生 legacy 的 stage2_narrator 字段",
    );

    // 不应有 v2NotImplemented（统一主链路无 legacy 回退）
    assert.equal(
      details.v2NotImplemented ?? result.v2NotImplemented,
      undefined,
      "统一主链路不应返回 v2NotImplemented（无 legacy 回退）",
    );
  });

  it("统一主链路落盘 trace（P1-8：候选/judge/选择证据可回放）", async () => {
    // 验证 runUnifiedPipeline 把每章候选、judge 仲裁、最终选择落盘到
    // {workspace}/traces/{chapterId}-quality-trace.json（legacy QualityTraceDocument 格式）。
    // 用独立 chapterId 避免与其他用例的 trace 互相 append。
    const tool = await loadGenerateChapterTool();
    assert.ok(tool, "novel_generate_chapter 应注册");

    const result = await tool.execute(
      "test-phase5-trace-persistence",
      {
        workspaceId: "phase5-unified-default",
        chapterId: "p1-8-trace",
        chapterNumber: 99,
        previousChapterSummary: "前章摘要",
        mockAgent: true,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );

    const details = result.details || result;
    const stageResults = details.stageResults || {};

    // 1. stageResults.tracePath 必须返回落盘路径
    const tracePath = stageResults.tracePath;
    assert.ok(
      typeof tracePath === "string" && tracePath.length > 0,
      `stageResults.tracePath 应为非空字符串，实际: ${tracePath}`,
    );
    assert.ok(
      tracePath.includes(join("phase5-unified-default", "traces", "p1-8-trace-quality-trace.json")),
      `tracePath 应符合 legacy 路径约定，实际: ${tracePath}`,
    );

    // 2. trace 文件必须实际存在
    assert.ok(existsSync(tracePath), `trace 文件应存在: ${tracePath}`);

    // 3. trace 内容必须是 legacy QualityTraceDocument，含 v2_ 前缀 gates 与 v2Summary
    const parsed = JSON.parse(readFileSync(tracePath, "utf-8"));
    assert.equal(parsed.schemaVersion, 1, "trace 应为 legacy QualityTraceDocument schemaVersion=1");

    const gates = parsed.gates || [];
    const v2GateStages = gates.map((g) => g.stage).filter((s) => String(s).startsWith("v2_"));
    assert.ok(
      v2GateStages.includes("v2_rawstage2_generated"),
      `trace gates 应含 v2_rawstage2_generated，实际 gates: ${v2GateStages.join(", ")}`,
    );
    assert.ok(
      v2GateStages.includes("v2_candidate_generated"),
      `trace gates 应含 v2_candidate_generated，实际 gates: ${v2GateStages.join(", ")}`,
    );
    assert.ok(
      v2GateStages.includes("v2_final_selected"),
      `trace gates 应含 v2_final_selected，实际 gates: ${v2GateStages.join(", ")}`,
    );

    // 4. v2Summary 跨阶段聚合视图必须存在且字段正确
    const summary = parsed.v2Summary;
    assert.ok(summary, "trace 应含 v2Summary 聚合视图");
    assert.ok(
      summary.candidateCount >= 1,
      `v2Summary.candidateCount 应 >= 1（至少 raw 候选），实际: ${summary.candidateCount}`,
    );
    assert.ok(
      typeof summary.finalSelectedId === "string" && summary.finalSelectedId.length > 0,
      `v2Summary.finalSelectedId 应为非空字符串，实际: ${summary.finalSelectedId}`,
    );
    assert.ok(
      ["rawStage2", "v2_amplified"].includes(summary.finalSelectedSource),
      `v2Summary.finalSelectedSource 应为 rawStage2 或 v2_amplified，实际: ${summary.finalSelectedSource}`,
    );
    assert.ok(
      ["positive", "neutral"].includes(summary.projectGain),
      `v2Summary.projectGain 应为 positive 或 neutral（统一主链路不交付劣于 raw 的正文），实际: ${summary.projectGain}`,
    );

    // 5. A6：若裁判跑过（v2_candidate_compared gate 存在），其 evidence 必须含
    //    完整 judgeEvidence（匿名映射 / verdict / evidence spans），而非只压缩 auditSummary。
    const comparedGate = gates.find((g) => g.stage === "v2_candidate_compared");
    if (comparedGate) {
      const je = comparedGate.evidence?.judgeEvidence;
      assert.ok(je, "v2_candidate_compared gate evidence 应含 judgeEvidence（A6）");
      assert.ok(Array.isArray(je.rounds), "judgeEvidence.rounds 应为数组");
      assert.ok(je.rounds.length >= 1, `judgeEvidence 至少 1 轮，实际: ${je.rounds.length}`);
      const r0 = je.rounds[0];
      assert.ok(r0.mapping, "首轮应有匿名映射 mapping");
      assert.ok(["A", "B"].includes(r0.mapping.leftLabel), "mapping.leftLabel 应为 A/B");
      assert.ok(typeof r0.mapping.seed === "number", "mapping.seed 应为 number");
      assert.ok(r0.evidenceValidation, "首轮应有 evidenceValidation");
      assert.equal(typeof r0.degraded, "boolean", "degraded 应为 boolean");
      // 非降级时 verdict 非 null，含 decisiveReasons（spans 可回放）
      if (!r0.degraded && r0.verdict) {
        assert.ok(Array.isArray(r0.verdict.decisiveReasons), "verdict.decisiveReasons 应为数组");
        assert.ok(
          ["clear", "slight", "uncertain"].includes(r0.verdict.confidence),
          `verdict.confidence 应为 clear/slight/uncertain，实际: ${r0.verdict.confidence}`,
        );
      }
      assert.equal(typeof je.auditSummary, "string", "judgeEvidence.auditSummary 应为 string");
    }
  });
});
