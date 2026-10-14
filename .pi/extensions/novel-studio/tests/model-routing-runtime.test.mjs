/**
 * Model routing runtime guard tests.
 *
 * These checks keep the single routing config aligned with runtime defaults.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { RoutedChatAPI, supportsJsonResponseFormat } from "../dist/api/routed-chat.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(testDir, "..");
const repoRoot = resolve(extensionRoot, "../../..");

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function loadRoutingConfig() {
  return JSON.parse(readRepoFile("config/model-routing.json"));
}

function makeRoutedChatConfig(overrides) {
  return {
    agentName: "test_agent",
    provider: "gpt",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.5",
    protocol: "openai",
    temperature: 0.2,
    maxTokens: 128,
    ...overrides,
  };
}

function makeChatResponse(model = "test-model") {
  return {
    ok: true,
    json: async () => ({
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "{\"ok\":true}" },
          finish_reason: "stop",
        },
      ],
    }),
    text: async () => "",
    status: 200,
    statusText: "OK",
  };
}

describe("model routing runtime alignment", () => {
  test("chapter generation routes use the best-fit production model per stage", () => {
    const config = loadRoutingConfig();

    // WRITER-ENV-UNIFY-1: 生产正文身份由 .env GEMINI_MODEL 解析（gemini31 只是稳定路由 ID）。
    // 原始 JSON 只保留 ${GEMINI_MODEL} 占位符；已解析值断言见 gemini38/writer-env-config 测试。
    // best_of_n_config.models 是休眠候选目录，不代表自动双写。
    assert.equal(config.model_strategy.narrator_primary, "${GEMINI_MODEL}");
    assert.equal(config.model_strategy.narrator_backup, null);
    assert.equal(config.model_strategy.narrator_candidate, null);
    assert.equal(config.model_strategy.narrator_testing, "doubao-seed-2-1-pro-260628");
    assert.equal(config.model_strategy.chinese_naturalizer, "doubao-seed-2-1-pro-260628");
    assert.equal(config.model_strategy.style_shaper, "claude-opus-4-6");
    assert.deepEqual(config.best_of_n_config.models, [
      "${GEMINI_MODEL}",
      "claude-opus-4-6",
    ]);

    assert.equal(config.stage_routing.stage2_narrator.provider, "gemini31");
    assert.equal(config.stage_routing.stage2_narrator.model, "${GEMINI_MODEL}");
    assert.equal(config.stage_routing.stage5_style_shaper.provider, "claude");
    assert.equal(config.stage_routing.stage5_style_shaper.model, "claude-opus-4-6");
    assert.equal(config.stage_routing.stage8_final_gate.provider, "claude");
    assert.equal(config.stage_routing.stage8_final_gate.model, "claude-opus-4-6");
    assert.equal(config.agent_routing.narrator_primary.provider, "gemini31");
    assert.equal(config.agent_routing.narrator_primary.model, "${GEMINI_MODEL}");
    assert.deepEqual(config.agent_routing.narrator_primary.fallback, []);
    assert.equal(config.agent_routing.narrator_backup, undefined);
    assert.equal(config.agent_routing.narrator_testing_claude.provider, "claude");
    assert.equal(config.agent_routing.narrator_testing_claude.model, "claude-opus-4-6");
    // narrator_testing / chinese_naturalizer 仍保留 Doubao（受限中文校准器与测试路由，1C）
    assert.equal(config.agent_routing.narrator_testing.provider, "doubao");
    assert.equal(config.agent_routing.chinese_naturalizer.provider, "doubao");
    assert.equal(config.agent_routing.style_shaper.provider, "claude");
    assert.equal(config.agent_routing.stage8_final_gate.provider, "claude");
    assert.equal(config.providers.doubao.api_key_env, "ARK_API_KEY");
    assert.equal(config.providers.doubao.model, "doubao-seed-2-1-pro-260628");
  });

  test("unused providers stay out of active routing nodes", () => {
    const config = loadRoutingConfig();

    // P34-T05: narrator_testing_glm 是新增的 GLM 专用测试路由（additive），
    // 仅用于三方 A/B 对比（Claude / Doubao / GLM），不进入生产 stage_routing / fallback。
    // P34-T05 扩展：style_shaper_testing_* / chinese_naturalizer_* 同属测试路由，
    // 用模式匹配排除所有 *_testing* 与 chinese_naturalizer_<model> 路由，避免硬编码遗漏。
    // NB-3R/NB-4/NB-5 扩展：nb4_*/nb5_* 等 NovelBench benchmark 路由、
    // reference_analyzer_<model> 校准路由同属测试路由，不进入生产 stage_routing / fallback。
    // 注意：reference_analyzer（无后缀）是生产路由，只排除 reference_analyzer_<model>。
    const isTestRoute = (key) =>
      /_testing/.test(key) ||
      /^chinese_naturalizer_/.test(key) ||
      /^nb/.test(key) ||
      /^reference_analyzer_/.test(key);

    // P34-T05: fallback.qwen 是测试支持的回退链（测试模型失败时回退到生产模型），
    // 不是生产 provider 本身。只把生产 provider 的 fallback key 计入 productionRouteProviders。
    // REAL-QUALITY-1-PREFLIGHT-REPAIR-1: fallback.glm 已强制为 []（真禁 fallback），
    // nb4_*_glm 路由锁定后不得回退 GPT/Claude/Doubao/ERNIE（总控要求 #3）。
    const PRODUCTION_PROVIDERS = new Set(["claude", "gpt", "deepseek", "doubao"]);

    const productionRouteProviders = [
      ...Object.values(config.stage_routing).map(route => route.provider),
      ...Object.entries(config.agent_routing)
        .filter(([key]) => !isTestRoute(key))
        .map(([, route]) => route.provider),
      ...Object.values(config.fallback).flat(),
      ...Object.keys(config.fallback).filter(k => PRODUCTION_PROVIDERS.has(k)),
    ].filter(Boolean);

    // GLM 不得出现在生产 stage_routing / 非 testing agent_routing / fallback 链路
    assert.equal(productionRouteProviders.includes("glm"), false);
    assert.equal(productionRouteProviders.includes("qwen"), false);
    assert.equal(productionRouteProviders.includes("claude_backup"), false);
    assert.equal(productionRouteProviders.includes("gpt_backup"), false);
    // v4.9.0 (P39 中文模型主写): Stage 2 正文 fallback 只在中文训练模型链内发生。
    assert.deepEqual(config.fallback.claude, ["gpt"]);
    assert.deepEqual(config.fallback.gpt, ["claude"]);
    assert.deepEqual(config.fallback.deepseek, ["gpt"]);
    assert.deepEqual(config.fallback.doubao, []);
    assert.deepEqual(config.fallback.ernie, []);
    assert.deepEqual(config.fallback.glm, []);
    assert.deepEqual(config.fallback.qwen, []);
    assert.equal(config.fallback.doubao.includes("gpt"), false);
    assert.equal(config.fallback.doubao.includes("claude"), false);

    // P34-T05: GLM 仅在测试路由出现（narrator_testing_glm / style_shaper_testing_glm / chinese_naturalizer_glm），不污染其他节点
    assert.equal(config.agent_routing.narrator_testing_glm.provider, "glm");
    assert.equal(config.agent_routing.narrator_testing_glm.model, "glm-5.2");
  });

  test("runtime configuration keeps Doubao provider defaults for Chinese naturalization and explicit test runs", () => {
    const config = loadRoutingConfig();

    assert.deepEqual(config.providers.doubao.request_options?.thinking, {
      type: "disabled",
    });
    assert.equal(config.agent_routing.narrator_testing.provider, "doubao");
    assert.equal(config.agent_routing.narrator_testing.model, "doubao-seed-2-1-pro-260628");
    assert.equal(config.agent_routing.chinese_naturalizer.provider, "doubao");
    assert.equal(config.agent_routing.chinese_naturalizer.model, "doubao-seed-2-1-pro-260628");
  });

  test("P36 Stage 8 keeps GPT as paradigm_judge 主裁 and Doubao as chinese_editor_judge 副裁", () => {
    const config = loadRoutingConfig();

    // GPT paradigm_judge 仍是主裁，不替换
    assert.equal(config.agent_routing.paradigm_judge.provider, "gpt");
    assert.equal(config.agent_routing.paradigm_judge.model, "gpt-5.5");

    // P36 新增：Doubao 中文编辑副裁路由
    assert.equal(config.agent_routing.chinese_editor_judge.provider, "doubao");
    assert.equal(config.agent_routing.chinese_editor_judge.model, "doubao-seed-2-1-pro-260628");

    // Doubao 副裁温度与 max_tokens 已配置（与生产 paradigm_judge 对齐）
    assert.equal(config.providers.doubao.temperature.chinese_editor_judge, 0.3);
    assert.equal(config.providers.doubao.max_tokens.chinese_editor_judge, 4096);

    // GEMINI38-FLASH-PRODUCTION-RESTORE-1: Stage 2 默认主写为 Gemini 3.8 Flash；Doubao 仍仅作中文校准。
    assert.equal(config.stage_routing.stage2_narrator.provider, "gemini31");
    assert.deepEqual(config.fallback.doubao, []);

    // chinese_editor_judge 不在 stage_routing（它是 agent_routing 副裁，不是阶段主路由）
    assert.equal(config.stage_routing.stage8_final_gate.provider, "claude");
    assert.equal(
      Object.prototype.hasOwnProperty.call(config.stage_routing, "chinese_editor_judge"),
      false,
      "chinese_editor_judge 不应进入 stage_routing（仅 agent_routing 副裁）",
    );
  });

  test("legacy route smoke script reads provider slots from central routing config", () => {
    const source = readRepoFile("scripts/test-model-routing.py");

    assert.match(
      source,
      /from model_routing_config import load_dotenv, load_model_routing, resolve_provider_configs/
    );
    assert.match(source, /resolve_provider_configs\(REPO_ROOT\)/);
    assert.match(source, /load_model_routing\(REPO_ROOT\)/);
    assert.match(source, /current_provider_for_role\(role\)/);
  });

  test("model API fetch calls use bounded request timeouts", () => {
    // DEAD-SOURCE-AUDIT-2: api/deepseek.ts 已删除（DeepSeek 退出默认质量链路，AGENTS.md v4.5.0）
    const apiFiles = [
      ".pi/extensions/novel-studio/api/claude.ts",
      ".pi/extensions/novel-studio/api/fallback-manager.ts",
      ".pi/extensions/novel-studio/api/glm.ts",
      ".pi/extensions/novel-studio/api/gpt.ts",
      ".pi/extensions/novel-studio/api/routed-chat.ts",
    ];

    for (const file of apiFiles) {
      const source = readRepoFile(file);
      assert.match(source, /fetchWithTimeout\(/, `${file} should use fetchWithTimeout`);
    }
  });

  test("Doubao route does not request unsupported JSON response format", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return makeChatResponse("doubao-seed-2-1-pro-260628");
    };

    try {
      const api = new RoutedChatAPI(
        makeRoutedChatConfig({
          provider: "doubao",
          baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
          model: "doubao-seed-2-1-pro-260628",
        }),
        "test-key"
      );

      assert.equal(supportsJsonResponseFormat(api.getConfig(), "doubao-seed-2-1-pro-260628"), false);
      await api.chat([{ role: "user", content: "return json" }], { jsonMode: true });

      assert.equal(calls.length, 1);
      assert.equal(Object.hasOwn(calls[0].body, "response_format"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("legacy route smoke script help works without API keys", () => {
    const result = spawnSync("python", ["scripts/test-model-routing.py", "--help"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Test PiNovelStudio model routing/);
  });

  test.skip("legacy ERNIE routing history (provider disabled)", () => {
    const config = loadRoutingConfig();

    // 1. ernie provider 配置完整
    assert.equal(config.providers.ernie.name, "ERNIE 5.1 (Baidu Qianfan)");
    assert.equal(config.providers.ernie.base_url, "https://qianfan.baidubce.com/v2");
    assert.equal(config.providers.ernie.api_key_env, "ERNIE_API_KEY");
    assert.equal(config.providers.ernie.model, "ernie-5.1");
    assert.equal(config.providers.ernie.protocol, "openai");
    // thinking 必须 disabled（避免思维链泄露，参见离线能力测试 B 模型问题）
    assert.deepEqual(config.providers.ernie.request_options?.thinking, {
      type: "disabled",
    });
    // 温度与 max_tokens 已为测试路由配置
    assert.equal(config.providers.ernie.temperature.narrator_testing_ernie, 0.72);
    assert.equal(config.providers.ernie.max_tokens.narrator_testing_ernie, 8192);

    // 2. 三条测试路由存在且指向 ernie
    assert.equal(config.agent_routing.narrator_testing_ernie.provider, "ernie");
    assert.equal(config.agent_routing.narrator_testing_ernie.model, "ernie-5.1");
    assert.equal(config.agent_routing.style_shaper_testing_ernie.provider, "ernie");
    assert.equal(config.agent_routing.style_shaper_testing_ernie.model, "ernie-5.1");
    assert.equal(config.agent_routing.chinese_naturalizer_ernie.provider, "ernie");
    assert.equal(config.agent_routing.chinese_naturalizer_ernie.model, "ernie-5.1");

    // 3. Stage 2 中文模型链：Doubao 可以 fallback 到 ERNIE，ERNIE 不再退回 GPT/Claude 正文。
    assert.deepEqual(config.fallback.doubao, ["ernie"]);
    assert.deepEqual(config.fallback.ernie, []);

    // 4. model_strategy 标注主力备选候选
    assert.equal(config.model_strategy.narrator_backup_ernie, "ernie-5.1");

    // 5. ERNIE 不直接抢占 stage_routing.stage2_narrator；只作为 Doubao provider fallback / narrator_backup 语义路由。
    assert.equal(config.stage_routing.stage2_narrator.provider, "doubao");
    assert.equal(config.agent_routing.narrator_backup.provider, "ernie");

    // 6. ERNIE 不进入 GPT/Claude 的 fallback 链，避免结构节点被误导向正文模型。
    assert.equal(config.fallback.claude.includes("ernie"), false);
    assert.equal(config.fallback.gpt.includes("ernie"), false);

    // 7. P39 治理：ERNIE 是 Stage 2 中文备援，Doubao 仍是主写。
    assert.equal(config.model_strategy.narrator_primary, "doubao-seed-2-1-pro-260628");
    assert.equal(config.model_strategy.narrator_backup, "ernie-5.1");
    assert.equal(config.model_strategy.narrator_candidate, "ernie-5.1");

    // 8. Best-of-N 的正文候选也限定在中文训练模型。
    assert.deepEqual(config.best_of_n_config.models, [
      "doubao-seed-2-1-pro-260628",
      "ernie-5.1",
    ]);
    assert.equal(config.best_of_n_config.models.includes("gpt-5.5"), false);
    assert.equal(config.best_of_n_config.models.includes("claude-opus-4-8"), false);

    // 9. ERNIE 只允许出现在 narrator_backup 和显式测试/自然化路由。
    const isTestRoute = (key) =>
      /_testing/.test(key) ||
      /^chinese_naturalizer_/.test(key) ||
      key === "narrator_backup";
    for (const [key, route] of Object.entries(config.agent_routing)) {
      if (!isTestRoute(key)) {
        assert.notEqual(
          route.provider,
          "ernie",
          `agent_routing.${key} 不应使用 ernie（仅测试路由允许）`
        );
      }
    }
    const nonTestAgentProviders = Object.entries(config.agent_routing)
      .filter(([key]) => !isTestRoute(key))
      .map(([, r]) => r.provider);
    assert.equal(nonTestAgentProviders.includes("ernie"), false);
  });
});
