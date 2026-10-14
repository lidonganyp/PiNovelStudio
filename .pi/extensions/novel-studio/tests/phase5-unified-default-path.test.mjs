/**
 * Phase 5/7：统一主链路默认路径验证（生产入口 smoke）
 *
 * Step 2 逻辑隔离后，本文件仅验证生产入口（dist/index.js）的统一主链路：
 *   novel_generate_chapter 始终走统一主链路（Agentic → 作者风格优化 → 复检 → commit）
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
const originalLegacyFlowFlag = process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW;

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

/** WRITER-ENV-UNIFY-1：测试断言读有效配置（.env GEMINI_MODEL 解析值）。 */
async function getGeminiWriterModel() {
  const { getGeminiWriterModel: resolve } = await import(
    pathToFileURL(join(EXT_ROOT, "dist", "utils", "config.js")).href
  );
  return resolve();
}

function createMinimalWorkspace() {
  rmSync(PHASE5_WORKSPACE, { recursive: true, force: true });
  mkdirSync(join(PHASE5_WORKSPACE, "chapters"), { recursive: true });
  mkdirSync(join(PHASE5_WORKSPACE, "characters"), { recursive: true });
  mkdirSync(join(PHASE5_WORKSPACE, "series"), { recursive: true });
  mkdirSync(join(PHASE5_WORKSPACE, "styles"), { recursive: true });

  const config = {
    name: "Phase5 默认路径验证",
    genre: "玄幻",
    subGenres: ["东方玄幻"],
    totalChapters: 50,
    chapterType: "standard",
    styleProfile: "phase5-author",
    serialFrequency: "daily",
    characters: [
      { id: "protagonist-1", name: "叶尘", role: "protagonist" },
    ],
    chapterSeeds: {
      default: {
        choicesAndCosts: [
          { choice: "公开接受传承", cost: "暴露自己已不再是普通少年" },
        ],
        expectedIrreversibleChange: ["叶尘接受传承后无法再维持原有身份"],
        causalEndPressure: ["传承被激活后引来追踪者"],
      },
    },
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
  writeFileSync(
    join(PHASE5_WORKSPACE, "styles", "profile.json"),
    JSON.stringify({
      id: "phase5-author",
      usagePolicy: { fullChapterOptimization: "required" },
      editorialGuidance: [
        "人物压力优先通过动作、停顿和环境变化呈现。",
        "章末停在仍有压力的动作或状态上，不替读者总结。",
      ],
      characterVoiceGuidance: {
        叶尘: ["少年感保留现实处境，不写成老练谋士。"],
      },
    }, null, 2),
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
    if (originalLegacyFlowFlag === undefined) {
      delete process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW;
    } else {
      process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW = originalLegacyFlowFlag;
    }
  });

  beforeEach(() => {
    // stub 模型（无真实 API 调用）
    process.env.V2_FORCE_STUB = "1";
    delete process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW;
  });

  afterEach(() => {
    delete process.env.V2_FORCE_STUB;
    if (originalLegacyFlowFlag !== undefined) {
      process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW = originalLegacyFlowFlag;
    }
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
    assert.equal(details.status, "ok", JSON.stringify(details.failureEnvelope));

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

    assert.equal(stageResults.productionFlow?.mode, "agentic_style_full_pipeline");
    assert.equal(stageResults.productionFlow?.oneShotRawCalled, false);
    assert.equal(stageResults.productionFlow?.machineJudgeCalled, false);
    assert.equal(stageResults.novelos?.required, true);
    assert.equal(stageResults.novelos?.shadowEnabled, false);
    assert.equal(stageResults.authorStyleOptimization?.styleProfileLoaded, true);
    assert.equal(stageResults.authorStyleOptimization?.styleGuidanceConsumed, true);
    const styleModelCall = (stageResults.modelCalls ?? []).find(
      (call) => call.kind === "author_style_optimization",
    );
    assert.ok(styleModelCall, "默认路径必须记录作者风格整章优化调用");
    assert.equal(styleModelCall.route, "v2_amplified_gemini31");
    assert.equal(styleModelCall.expectedProvider, "gemini31");
    assert.equal(styleModelCall.expectedModel, await getGeminiWriterModel());

    // 固定场景候选源已退出生产；trace 必须明确记录退休状态。
    assert.ok(
      stageResults.positiveGainCandidates,
      "公开生产入口必须记录固定场景候选源已退休",
    );
    assert.equal(stageResults.positiveGainCandidates.status, "retired_from_production");
    assert.equal(stageResults.positiveGainCandidates.failureReason, "global_scene_candidate_admission_retired");
    assert.equal(
      (details.candidates ?? []).some((candidate) => candidate.kind === "style_aware"),
      false,
      "非增量提示模式 C 必须保持 dormant，不得由公开入口生成",
    );
  });

  it("统一主链路落盘 trace（生产路径：Agentic/风格/选择证据可回放，不含机器裁判）", async () => {
    // 验证 runUnifiedPipeline 把每章候选与最终选择落盘到
    // {workspace}/traces/{chapterId}-quality-trace.json。
    // 生产路径不调用机器文学裁判；隔离评测的裁判载荷不是本 smoke 合同。
    // 用独立 chapterId 避免与其他用例的 trace 互相 append。
    // Phase 2A：chapterNumber=1 避免触发 Preflight 前章连续性检查（ch98 state store 不存在）；
    // trace 路径由 chapterId 决定，与 chapterNumber 无关。
    const tool = await loadGenerateChapterTool();
    assert.ok(tool, "novel_generate_chapter 应注册");

    const result = await tool.execute(
      "test-phase5-trace-persistence",
      {
        workspaceId: "phase5-unified-default",
        chapterId: "p1-8-trace",
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
    assert.equal(details.status, "ok", JSON.stringify(details.failureEnvelope));

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
      v2GateStages.includes("v2_novelos_agentic"),
      `trace gates 应含 v2_novelos_agentic，实际 gates: ${v2GateStages.join(", ")}`,
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
    assert.equal(
      summary.finalSelectedSource,
      "v2_amplified",
      `生产 agentic_style 成功路径 finalSelectedSource 必须是 v2_amplified，不得回退 rawStage2；实际: ${summary.finalSelectedSource}`,
    );
    assert.ok(
      ["positive", "neutral"].includes(summary.projectGain),
      `v2Summary.projectGain 应为 positive 或 neutral，实际: ${summary.projectGain}`,
    );

    // 生产路径不得出现机器文学裁判 gate。
    const comparedGate = gates.find((g) => g.stage === "v2_candidate_compared");
    assert.equal(
      comparedGate,
      undefined,
      "生产 smoke 不得写入 v2_candidate_compared",
    );
  });
});
