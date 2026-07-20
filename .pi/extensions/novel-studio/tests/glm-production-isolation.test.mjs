/**
 * MODEL-ROUTING-CLAUDE46-1D RED 测试
 *
 * 派工卡: docs/model-routing-claude-opus-4-6-dispatch-card-20260717.md §6 (1D)
 *
 * 验证 GLM 5.2 开发隔离与配置守卫：
 * - 所有 GLM 路由（nb4_*_glm / nb5_*_glm / reference_analyzer_glm / narrator_testing_glm /
 *   style_shaper_testing_glm / chinese_naturalizer_glm）必须显式 fallback=[] 且标注 lab/testing
 * - 生产 stage_routing / agent_routing（非测试路由）不得包含 GLM provider
 * - 生产 fallback 链路不得包含 GLM
 * - scripts/invoke-generate-chapter.mjs 默认 modelTestRoute=glm 时日志必须明确 development route lock
 * - 公开工具未传 modelTestRoute 时不得触发任何 GLM route（运行时 stub 验证）
 *
 * RED 状态：narrator_testing_glm / style_shaper_testing_glm / chinese_naturalizer_glm
 *   当前未显式声明 fallback=[]，且 invoke-generate-chapter.mjs 日志未含 "development route lock"。
 * GREEN 状态：1D 实现完成后全部通过。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { resolveModelTestRouteLock } from "../dist/v2/core/unified-entry.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(testDir, "..");
const repoRoot = resolve(extensionRoot, "../../..");

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function loadRoutingConfig() {
  return JSON.parse(readRepoFile("config/model-routing.json"));
}

describe("MODEL-ROUTING-CLAUDE46-1D: GLM 开发隔离与配置守卫", () => {
  describe("GLM 路由显式 fallback=[] 与 lab/testing 标注", () => {
    test("nb4_*_glm 路由显式 fallback=[] 且标注 lab/testing", () => {
      const config = loadRoutingConfig();
      const routes = ["nb4_generate_glm", "nb4_judge_glm"];
      for (const name of routes) {
        const route = config.agent_routing[name];
        assert.ok(route, `agent_routing.${name} must exist`);
        assert.equal(route.provider, "glm");
        assert.deepEqual(
          route.fallback,
          [],
          `agent_routing.${name}.fallback must be explicit []`,
        );
        // note 必须含 lab/testing 标注
        const note = (route.note ?? "").toLowerCase();
        assert.ok(
          note.includes("lab-only") || note.includes("lab") || note.includes("test"),
          `agent_routing.${name}.note must mark lab/testing`,
        );
      }
    });

    test("nb5_judge_glm 路由显式 fallback=[] 且标注 lab/testing", () => {
      const config = loadRoutingConfig();
      const route = config.agent_routing.nb5_judge_glm;
      assert.ok(route);
      assert.equal(route.provider, "glm");
      assert.deepEqual(route.fallback, []);
      const note = (route.note ?? "").toLowerCase();
      assert.ok(
        note.includes("lab-only") || note.includes("lab") || note.includes("test"),
      );
    });

    test("reference_analyzer_glm 路由显式 fallback=[] 且标注 lab/testing", () => {
      const config = loadRoutingConfig();
      const route = config.agent_routing.reference_analyzer_glm;
      assert.ok(route);
      assert.equal(route.provider, "glm");
      assert.deepEqual(route.fallback, []);
      const note = (route.note ?? "").toLowerCase();
      assert.ok(
        note.includes("lab-only") || note.includes("lab") || note.includes("test"),
      );
    });

    test("narrator_testing_glm 路由显式 fallback=[] 且标注 lab/testing", () => {
      const config = loadRoutingConfig();
      const route = config.agent_routing.narrator_testing_glm;
      assert.ok(route);
      assert.equal(route.provider, "glm");
      assert.deepEqual(
        route.fallback,
        [],
        `narrator_testing_glm.fallback must be explicit [] (currently inherits provider-level)`,
      );
      const note = (route.note ?? "").toLowerCase();
      assert.ok(
        note.includes("lab-only") || note.includes("lab") || note.includes("test"),
      );
    });

    test("style_shaper_testing_glm 路由显式 fallback=[]", () => {
      const config = loadRoutingConfig();
      const route = config.agent_routing.style_shaper_testing_glm;
      assert.ok(route);
      assert.equal(route.provider, "glm");
      assert.deepEqual(route.fallback, []);
    });

    test("chinese_naturalizer_glm 路由显式 fallback=[]", () => {
      const config = loadRoutingConfig();
      const route = config.agent_routing.chinese_naturalizer_glm;
      assert.ok(route);
      assert.equal(route.provider, "glm");
      assert.deepEqual(route.fallback, []);
    });
  });

  describe("生产 stage_routing / agent_routing 不含 GLM", () => {
    test("stage_routing 中无 GLM provider", () => {
      const config = loadRoutingConfig();
      const stages = Object.entries(config.stage_routing);
      for (const [name, route] of stages) {
        assert.notEqual(
          route.provider,
          "glm",
          `stage_routing.${name}.provider 不得为 glm`,
        );
      }
    });

    test("agent_routing 中非测试路由无 GLM provider", () => {
      const config = loadRoutingConfig();
      const isTestRoute = (key) =>
        /_testing/.test(key) ||
        /^chinese_naturalizer_/.test(key) ||
        /^nb/.test(key) ||
        /^reference_analyzer_/.test(key) ||
        /^style_shaper_testing_/.test(key);

      const nonTestAgentProviders = Object.entries(config.agent_routing)
        .filter(([key]) => !isTestRoute(key))
        .map(([, r]) => r.provider);

      assert.equal(
        nonTestAgentProviders.includes("glm"),
        false,
        "非测试 agent_routing 路由不得使用 glm provider",
      );
    });

    test("生产 fallback 链路不含 GLM", () => {
      const config = loadRoutingConfig();
      const productionProviders = new Set(["claude", "gpt", "deepseek", "doubao"]);
      for (const [provider, chain] of Object.entries(config.fallback)) {
        if (productionProviders.has(provider)) {
          assert.equal(
            chain.includes("glm"),
            false,
            `fallback.${provider} 不得包含 glm`,
          );
        }
      }
      // fallback.glm 必须为 []（GLM 不作为任何生产节点的 fallback 目标）
      assert.deepEqual(config.fallback.glm, []);
    });
  });

  describe("scripts/invoke-generate-chapter.mjs 默认 GLM 锁定日志", () => {
    test("脚本默认 modelTestRoute=glm 时日志明确 development route lock", () => {
      const source = readRepoFile("scripts/invoke-generate-chapter.mjs");
      // 默认值仍为 glm（开发验证用）
      assert.match(source, /DEFAULT_MODEL_TEST_ROUTE\s*=\s*process\.env\.PINOVEL_MODEL_TEST_ROUTE\s*\|\|\s*"glm"/);
      // 日志或注释中必须明确 "development route lock" 字样
      assert.match(
        source,
        /development route lock/i,
        "invoke-generate-chapter.mjs 必须在日志或注释中明确 development route lock",
      );
    });
  });

  describe("modelTestRoute=glm 路由锁定语义", () => {
    test("resolveModelTestRouteLock('glm') 返回 nb4_generate_glm + nb4_judge_glm", () => {
      const lock = resolveModelTestRouteLock("glm");
      assert.ok(lock);
      assert.equal(lock.generateRoute, "nb4_generate_glm");
      assert.equal(lock.judgeRoute, "nb4_judge_glm");
    });

    test("resolveModelTestRouteLock(undefined) 返回 null（不锁定，走默认生产路由）", () => {
      const lock = resolveModelTestRouteLock(undefined);
      assert.equal(lock, null);
    });

    test("resolveModelTestRouteLock('claude') 返回 null（公开工具未传 modelTestRoute 时不得触发 GLM）", () => {
      // modelTestRoute 非 'glm' 时不锁定，生产路径不触发 GLM route
      const lock = resolveModelTestRouteLock("claude");
      assert.equal(lock, null);
    });
  });

  describe("公开工具未传 modelTestRoute 时不得触发 GLM route", () => {
    test("默认生产 modelCalls 中无 GLM provider（stub 验证）", async () => {
      const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");

      // 使用 stub 模型 + 不传 modelTestRoute（默认生产路径）
      const result = await runUnifiedPipeline({
        workspaceId: "test-workspace",
        chapterId: "ch1",
        chapterNumber: 1,
        seed: {
          chapterId: "ch1",
          chapterNumber: 1,
          title: "测试章节",
          worldConstraint: { immutableFacts: [] },
          highLevelDirection: { immutableFacts: [] },
          characters: [],
          currentPressure: { pendingForeshadowing: [] },
        },
        evalMode: "B4",
        // evalIntent 必须是完整 ChapterIntent（chapter-intent-builder.ts:23），
        // 含 readerExperience/currentPressure/inviolableFacts 等必填数组；
        // buildRawPrompt 直接读这些字段的 .length，缺失会 TypeError。
        evalIntent: {
          chapterFunction: "character",
          readerExperience: [],
          currentPressure: [],
          meaningfulChoices: [],
          promisesToAdvance: [],
          possibleEndPressure: [],
          relevantCharacters: [],
          inviolableFacts: [],
          sourceRefs: [],
        },
        evalContext: {
          // CompiledContext 必填数组（types.ts:140）：buildRawPrompt 直接读 .length
          facts: [],
          characterStates: [],
          openLoops: [],
          worldRules: [],
          styleReferences: [],
          sourceMap: [],
          longTermState: { canon: [], character: [], promise: [], pattern: [] },
          recentContext: "",
        },
        evalModelGenerate: async (input) => ({
          text: `# 第一章 测试\n\n这是一段测试正文。`,
          model: "claude-opus-4-6",
          route: input.route,
          provider: input.route.startsWith("v2_literary_judge") || input.route.startsWith("v2_opportunity_judge")
            ? "openai"
            : "anthropic",
          durationMs: 10,
        }),
      });

      const modelCalls = result.details?.stageResults?.modelCalls ?? [];
      // 默认生产路径不应有任何 GLM 调用
      const glmCalls = modelCalls.filter(
        (c) =>
          c.provider === "glm" ||
          c.actualProvider === "glm" ||
          c.requestedRoute?.includes("glm") ||
          c.route?.includes("glm"),
      );
      assert.equal(
        glmCalls.length,
        0,
        `默认生产路径不得触发 GLM route，但发现: ${JSON.stringify(glmCalls, null, 2)}`,
      );
    });
  });
});
