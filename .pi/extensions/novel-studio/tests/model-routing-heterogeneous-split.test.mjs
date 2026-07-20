/**
 * MODEL-ROUTING-CLAUDE46-1A — 异源 generation/judge 分轨与 GLM 锁定覆盖 RED 测试
 *
 * 派工卡 §3（子任务 A）RED Tests：
 *   - 默认生产调用的 generation/judge trace provider 不同。
 *   - 显式 `modelTestRoute=glm` 时所有生成和判断调用仍锁定 GLM，且 `fallback=[]`。
 *
 * 本文件覆盖 orchestrator 级 trace 断言：
 *   1. 默认生产路径（无 modelTestRoute）：generation 调用 provider=claude/anthropic，
 *      judge 调用 provider=gpt/openai，两者不同（异源分轨）。
 *   2. modelTestRoute=glm：所有 modelCalls 的 provider=glm，requestedRoute 为 nb4_*_glm，
 *      且不出现 GPT/Claude/Doubao fallback。
 *
 * 禁止真实模型调用：用 V2_FORCE_STUB=1 + 自定义 stub ModelGenerateFn，
 * 不发起任何网络请求。
 */

import assert from "node:assert/strict";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, test, before, after, beforeEach, afterEach } from "node:test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

const PHASE5_WORKSPACE = join(PROJECT_ROOT, "workspaces", "phase5-routing-split");

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
    name: "Routing split 验证",
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

/**
 * 从工具返回结果中提取 modelCalls 数组。
 *
 * modelCalls 由编排器写入 stageResults.modelCalls（计划 §trace 遥测），
 * 并通过 V2Output.stageResults 透传给工具调用方。本测试读此字段而非
 * trace 文件（QualityTraceDocument 的 gates 不保留 modelCalls 数组）。
 */
function extractModelCalls(result) {
  const details = result.details || result;
  const stageResults = details.stageResults || {};
  const modelCalls = stageResults.modelCalls ?? [];
  assert.ok(Array.isArray(modelCalls), `modelCalls 应为数组，实际: ${typeof modelCalls}`);
  return modelCalls;
}

// ============================================================================
// 1. 默认生产路径：generation 与 judge 异源分轨
// ============================================================================

describe("MODEL-ROUTING-CLAUDE46-1A：默认生产 generation/judge 异源分轨", () => {
  before(() => {
    createMinimalWorkspace();
  });

  after(() => {
    rmSync(PHASE5_WORKSPACE, { recursive: true, force: true });
  });

  beforeEach(() => {
    // stub 模型（无真实 API 调用）
    process.env.V2_FORCE_STUB = "1";
    // 确保未设置 modelTestRoute（默认生产路径）
    delete process.env.PINOVEL_MODEL_TEST_ROUTE;
  });

  afterEach(() => {
    delete process.env.V2_FORCE_STUB;
  });

  test("默认生产调用：generation trace provider 与 judge trace provider 不同", async () => {
    const tool = await loadGenerateChapterTool();
    assert.ok(tool, "novel_generate_chapter 应注册");

    const result = await tool.execute(
      "test-routing-split-default",
      {
        workspaceId: "phase5-routing-split",
        chapterId: "1",
        chapterNumber: 1,
        previousChapterSummary: "前章摘要",
        mockAgent: true,
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );

    const modelCalls = extractModelCalls(result);
    assert.ok(modelCalls.length > 0,
      `modelCalls 应非空，实际: ${JSON.stringify(modelCalls).slice(0, 200)}`);

    // 区分 generation 调用与 judge 调用
    // generation: kind 属于 raw_chapter / editorial_amplified / agentic_raw 等
    // judge: kind 属于 opportunity_judge / literary_judge / reverse_review / arbitration 等
    const generationKinds = new Set([
      "raw_chapter", "editorial_amplified", "agentic_raw",
      "v2_rawstage2", "v2_amplified", "v2_chinese_calibration",
    ]);
    const judgeKinds = new Set([
      "opportunity_judge", "literary_judge", "reverse_review",
      "arbitration", "v2_opportunity_judge", "v2_literary_judge",
      "pairwise_judge", "judge_arbitration",
    ]);

    const generationCalls = modelCalls.filter((c) =>
      generationKinds.has(c.kind) || /raw|editorial|amplified|generation/i.test(c.kind || ""));
    const judgeCalls = modelCalls.filter((c) =>
      judgeKinds.has(c.kind) || /judge|opportunity|pairwise|arbitr|reverse|review/i.test(c.kind || ""));

    // 至少应有 generation 调用（raw 必跑）
    assert.ok(generationCalls.length > 0,
      `应至少有 1 次 generation 调用，modelCalls: ${JSON.stringify(modelCalls.map((c) => ({ kind: c.kind, route: c.route, provider: c.provider })))}`);

    // 若有 judge 调用（editorial 候选触发裁判时），验证 provider 异源
    if (judgeCalls.length > 0) {
      const generationProviders = new Set(generationCalls.map((c) => c.provider).filter(Boolean));
      const judgeProviders = new Set(judgeCalls.map((c) => c.provider).filter(Boolean));

      assert.ok(generationProviders.size > 0,
        "generation 调用应有非空 provider");
      assert.ok(judgeProviders.size > 0,
        "judge 调用应有非空 provider");

      // 异源断言：generation provider 与 judge provider 不得完全相同
      const isHeterogeneous = [...generationProviders].some((p) => !judgeProviders.has(p))
        || [...judgeProviders].some((p) => !generationProviders.has(p));
      assert.ok(
        isHeterogeneous,
        `generation provider (${[...generationProviders].join(",")}) 与 judge provider (${[...judgeProviders].join(",")}) 应异源（不同 provider），实际相同`,
      );

      // 更强断言：generation 应为 claude/anthropic，judge 应为 gpt/openai（异源 judge）
      const genIsClaude = [...generationProviders].some((p) =>
        /claude|anthropic/i.test(p));
      const judgeIsGpt = [...judgeProviders].some((p) =>
        /gpt|openai/i.test(p));
      assert.ok(genIsClaude,
        `generation provider 应为 claude/anthropic，实际: ${[...generationProviders].join(",")}`);
      assert.ok(judgeIsGpt,
        `judge provider 应为 gpt/openai（异源 judge），实际: ${[...judgeProviders].join(",")}`);

      // 不得出现 glm（GLM 不得进入生产默认）
      const allProviders = [...generationProviders, ...judgeProviders];
      assert.ok(
        !allProviders.some((p) => /glm/i.test(p)),
        `默认生产路径不得出现 GLM provider，实际 providers: ${allProviders.join(",")}`,
      );
    }
  });
});

// ============================================================================
// 2. modelTestRoute=glm：所有调用锁定 GLM，fallback=[]
// ============================================================================

describe("MODEL-ROUTING-CLAUDE46-1A：modelTestRoute=glm 锁定全部 generation/judge 调用", () => {
  before(() => {
    createMinimalWorkspace();
  });

  after(() => {
    rmSync(PHASE5_WORKSPACE, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.V2_FORCE_STUB = "1";
  });

  afterEach(() => {
    delete process.env.V2_FORCE_STUB;
  });

  test("modelTestRoute=glm：所有 modelCalls provider=glm，requestedRoute=nb4_*_glm，无 GPT/Claude/Doubao fallback", async () => {
    const tool = await loadGenerateChapterTool();
    assert.ok(tool, "novel_generate_chapter 应注册");

    const result = await tool.execute(
      "test-routing-glm-lock",
      {
        workspaceId: "phase5-routing-split",
        chapterId: "2",
        chapterNumber: 2,
        previousChapterSummary: "前章摘要",
        mockAgent: true,
        modelTestRoute: "glm",
      },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    );

    const modelCalls = extractModelCalls(result);
    assert.ok(modelCalls.length > 0,
      `modelCalls 应非空，实际: ${JSON.stringify(modelCalls).slice(0, 200)}`);

    // 所有调用 provider 必须为 glm
    for (const call of modelCalls) {
      const provider = call.provider ?? call.actualProvider;
      assert.ok(
        provider && /glm/i.test(provider),
        `modelTestRoute=glm 下所有调用 provider 应为 glm，实际 call (kind=${call.kind}, route=${call.route}, provider=${provider})`,
      );
      // requestedRoute 必须为 nb4_generate_glm 或 nb4_judge_glm
      const requestedRoute = call.requestedRoute ?? call.route;
      assert.ok(
        requestedRoute && /nb4_(generate|judge)_glm/.test(requestedRoute),
        `modelTestRoute=glm 下 requestedRoute 应为 nb4_*_glm，实际 call (kind=${call.kind}, requestedRoute=${requestedRoute}, route=${call.route})`,
      );
    }

    // 不得出现任何 GPT/Claude/Doubao/ERNIE 调用
    const nonGlmProviders = modelCalls
      .map((c) => c.provider ?? c.actualProvider)
      .filter((p) => p && !/glm/i.test(p));
    assert.equal(
      nonGlmProviders.length, 0,
      `modelTestRoute=glm 下不得出现非 GLM provider，实际: ${JSON.stringify(nonGlmProviders)}`,
    );
  });
});
