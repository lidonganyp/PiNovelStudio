/**
 * MODEL-ROUTING-CLAUDE46-1A — 路由契约与 fail-closed RED 测试
 *
 * 派工卡 §3（子任务 A）RED Tests：
 *   - 未知 route 不再落到 GLM，而是抛出配置错误。
 *   - 生产 raw/editorial 路由不能调用 Doubao、GLM 或 GPT。
 *   - 中文校准路由不能调用 Claude、GLM 或 GPT。
 *   - judge 路由不能调用 Claude、Doubao 或 GLM。
 *   - route-level `fallback=[]` 时 provider-level fallback 不得生效。
 *
 * 本文件只覆盖 config-level 与 fallback-manager runtime-level 断言；
 * orchestrator 级 generation/judge 异源分轨与 modelTestRoute=glm 锁定覆盖
 * 见 model-routing-heterogeneous-split.test.mjs。
 *
 * 禁止真实模型调用：所有 runtime 用例 mock globalThis.fetch 与 API key，
 * 不发起任何网络请求。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, beforeEach, afterEach } from "node:test";

import { createAPIFallbackManager } from "../dist/api/fallback-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const extensionRoot = resolve(__dirname, "..");
const repoRoot = resolve(extensionRoot, "../../..");

function loadRoutingConfig() {
  return JSON.parse(readFileSync(join(repoRoot, "config/model-routing.json"), "utf-8"));
}

/**
 * 从 agent_routing 解析路由对象（兼容 string | AgentRoutingEntry）。
 * string 形式视为 provider-only 路由（无显式 model/fallback）。
 */
function resolveRouteEntry(config, routeName) {
  const entry = config.agent_routing?.[routeName];
  if (!entry) return undefined;
  if (typeof entry === "string") return { provider: entry, model: undefined, fallback: undefined };
  return {
    provider: entry.provider,
    model: entry.model,
    fallback: entry.fallback,
    baseUrlEnv: entry.base_url_env,
    apiKeyEnv: entry.api_key_env,
    modelEnv: entry.model_env,
  };
}

// ============================================================================
// 1. 生产路由契约（config-level）：5 条新路由必须显式声明 provider/model/fallback
// ============================================================================

describe("MODEL-ROUTING-CLAUDE46-1A：生产路由显式契约", () => {
  const config = loadRoutingConfig();

  test("v2_rawstage2 路由：provider=claude，model=claude-opus-4-6，fallback=[]", () => {
    const route = resolveRouteEntry(config, "v2_rawstage2");
    assert.ok(route, "v2_rawstage2 路由必须存在");
    assert.equal(route.provider, "claude",
      `v2_rawstage2.provider 必须为 claude（raw 正文唯一正式主写），实际: ${route.provider}`);
    assert.equal(route.model, "claude-opus-4-6",
      `v2_rawstage2.model 必须为 claude-opus-4-6，实际: ${route.model}`);
    assert.deepEqual(route.fallback, [],
      `v2_rawstage2.fallback 必须为 []（hard block，不静默切换其他正文模型），实际: ${JSON.stringify(route.fallback)}`);
  });

  test("v2_amplified 路由：provider=claude，model=claude-opus-4-6，fallback=[]", () => {
    const route = resolveRouteEntry(config, "v2_amplified");
    assert.ok(route, "v2_amplified 路由必须存在");
    assert.equal(route.provider, "claude",
      `v2_amplified.provider 必须为 claude（普通 editorial candidate 主写），实际: ${route.provider}`);
    assert.equal(route.model, "claude-opus-4-6",
      `v2_amplified.model 必须为 claude-opus-4-6，实际: ${route.model}`);
    assert.deepEqual(route.fallback, [],
      `v2_amplified.fallback 必须为 []，实际: ${JSON.stringify(route.fallback)}`);
  });

  test("v2_chinese_calibration 路由：provider=doubao，model=doubao-seed-2-1-pro-260628，fallback=[]", () => {
    const route = resolveRouteEntry(config, "v2_chinese_calibration");
    assert.ok(route, "v2_chinese_calibration 路由必须存在（1C span 驱动中文校准候选）");
    assert.equal(route.provider, "doubao",
      `v2_chinese_calibration.provider 必须为 doubao（仅中文校准），实际: ${route.provider}`);
    assert.equal(route.model, "doubao-seed-2-1-pro-260628",
      `v2_chinese_calibration.model 必须为 doubao-seed-2-1-pro-260628，实际: ${route.model}`);
    assert.deepEqual(route.fallback, [],
      `v2_chinese_calibration.fallback 必须为 []（不回退 Claude/GPT/GLM），实际: ${JSON.stringify(route.fallback)}`);
  });

  test("v2_opportunity_judge 路由：异源 judge provider，fallback=[]", () => {
    const route = resolveRouteEntry(config, "v2_opportunity_judge");
    assert.ok(route, "v2_opportunity_judge 路由必须存在（编辑机会 LLM 裁判）");
    // 异源 judge：不得是 claude / doubao / glm
    assert.notEqual(route.provider, "claude",
      "v2_opportunity_judge.provider 不得为 claude（Claude 不得自审其生成的编辑机会）");
    assert.notEqual(route.provider, "doubao",
      "v2_opportunity_judge.provider 不得为 doubao（Doubao 不是 judge provider）");
    assert.notEqual(route.provider, "glm",
      "v2_opportunity_judge.provider 不得为 glm（GLM 不得进入生产 judge）");
    assert.deepEqual(route.fallback, [],
      `v2_opportunity_judge.fallback 必须为 []，实际: ${JSON.stringify(route.fallback)}`);
  });

  test("v2_literary_judge 路由：异源 judge provider，fallback=[]", () => {
    const route = resolveRouteEntry(config, "v2_literary_judge");
    assert.ok(route, "v2_literary_judge 路由必须存在（pairwise 文学裁判）");
    assert.notEqual(route.provider, "claude",
      "v2_literary_judge.provider 不得为 claude（Claude 不得同时担任生成者与文学裁判）");
    assert.notEqual(route.provider, "doubao",
      "v2_literary_judge.provider 不得为 doubao");
    assert.notEqual(route.provider, "glm",
      "v2_literary_judge.provider 不得为 glm");
    assert.deepEqual(route.fallback, [],
      `v2_literary_judge.fallback 必须为 []，实际: ${JSON.stringify(route.fallback)}`);
  });
});

// ============================================================================
// 2. 未知 route fail-closed（runtime-level）
// ============================================================================

describe("MODEL-ROUTING-CLAUDE46-1A：未知 route fail-closed", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 设置所有 provider 的 API key 为 fake，使 fail-open 路径能"尝试"调用
    // （而非因缺 key 被跳过）。这样 fail-open 行为会真正发起 fetch，
    // 测试可通过 fetch 是否被调用来判断 fail-closed 是否生效。
    process.env.GLM_API_KEY = "fake-glm-key";
    process.env.GLM_BASE_URL = "https://fake-glm.example.com/v1";
    process.env.CLAUDE_API_KEY = "fake-claude-key";
    process.env.CLAUDE_BASE_URL = "https://fake-claude.example.com/v1";
    process.env.GPT_API_KEY = "fake-gpt-key";
    process.env.GPT_BASE_URL = "https://fake-gpt.example.com/v1";
    process.env.ARK_API_KEY = "fake-ark-key";
    process.env.DOUBAO_API_KEY = "fake-doubao-key";
    // mock fetch：记录所有调用，返回 200 但带 error body（使链路抛错而非静默成功）
    let callCount = 0;
    globalThis.fetch = async (url, init) => {
      callCount += 1;
      // 返回一个 401 错误，使 fallback-manager 把 provider 标记为 permanent failure
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Unauthorized",
        json: async () => ({ error: { message: "Unauthorized" } }),
      };
    };
    globalThis.__testFetchCallCount = () => callCount;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.__testFetchCallCount;
    // 恢复 env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test("未知 route 不再落到 GLM，而是抛出结构化配置错误（不发起任何 API 调用）", async () => {
    const manager = createAPIFallbackManager();
    const unknownRoute = "nonexistent_route_xyz_12345";

    let thrownError = null;
    try {
      await manager.callWithFallback(
        unknownRoute,
        [{ role: "user", content: "test" }],
        { temperature: 0.2, max_tokens: 16 },
      );
    } catch (e) {
      thrownError = e;
    }

    // 必须抛错（而非静默成功）
    assert.ok(thrownError, `未知 route 必须抛错，实际未抛错`);

    // 错误信息必须明确指示"未知 route"，而非 GLM API 调用失败
    const errMsg = String(thrownError.message || thrownError);
    assert.ok(
      /unknown route|未知 route|未知路由|unconfigured route|missing route/i.test(errMsg),
      `错误信息应明确指示"未知 route"，实际: ${errMsg}`,
    );
    assert.ok(
      !/GLM|glm-5|fake-glm|Unauthorized|401/i.test(errMsg) || /unknown route|未知 route/i.test(errMsg),
      `错误信息不应是 GLM API 调用失败（说明 fail-open 到 GLM），实际: ${errMsg}`,
    );

    // 不得发起任何 API 调用（fail-closed 必须在调用前阻断）
    const fetchCallCount = globalThis.__testFetchCallCount();
    assert.equal(
      fetchCallCount, 0,
      `未知 route fail-closed 必须在 API 调用前阻断，但实际发起了 ${fetchCallCount} 次 fetch 调用（fail-open 到 GLM）`,
    );
  });

  test("缺失 agent_routing 整表时 fail-closed（不默认返回 GLM）", async () => {
    // 用一个不存在的 route 验证：即使 GLM key 已设置，也不应尝试 GLM
    const manager = createAPIFallbackManager();
    let thrownError = null;
    try {
      await manager.callWithFallback(
        "totally_missing_route",
        [{ role: "user", content: "test" }],
        { temperature: 0.2, max_tokens: 16 },
      );
    } catch (e) {
      thrownError = e;
    }
    assert.ok(thrownError, "缺失路由必须抛错");
    const fetchCallCount = globalThis.__testFetchCallCount();
    assert.equal(fetchCallCount, 0,
      `缺失路由 fail-closed 必须在 API 调用前阻断，实际发起了 ${fetchCallCount} 次 fetch`);
  });
});

// ============================================================================
// 3. route-level fallback=[] 覆盖 provider-level fallback（runtime-level）
// ============================================================================

describe("MODEL-ROUTING-CLAUDE46-1A：route-level fallback 覆盖 provider-level fallback", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CLAUDE_API_KEY = "fake-claude-key";
    process.env.CLAUDE_BASE_URL = "https://fake-claude.example.com/v1";
    process.env.GPT_API_KEY = "fake-gpt-key";
    process.env.GPT_BASE_URL = "https://fake-gpt.example.com/v1";
    // WRITER-ENV-UNIFY-1：占位符解析对整个路由表 fail-closed；
    // 前组测试的 afterEach 会删除 loadProjectDotEnv 回填的 key，
    // 这里必须显式提供固定测试变量，否则 v2_rawstage2 解析前就因
    // "GEMINI_MODEL is required in .env" 阻断（与 Gemini 写路由无关也会触发）。
    process.env.GEMINI_MODEL = "gemini-fail-closed-test";
    process.env.GOOGLE_GEMINI_BASE_URL = "https://gemini-fail-closed.test/v1";
    process.env.GEMINI_API_KEY = "fake-gemini-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test("v2_rawstage2 路由 fallback=[] 时，Claude 失败不得回退 GPT（即使 fallback.claude=[gpt]）", async () => {
    const config = loadRoutingConfig();
    // 前置断言：provider-level fallback.claude 非空（否则测试无意义）
    assert.deepEqual(config.fallback.claude, ["gpt"],
      "前置条件：fallback.claude 应为 [gpt]，否则 route-level override 测试无意义");

    // 路由级 fallback=[] 必须存在（否则测试无意义）
    const route = resolveRouteEntry(config, "v2_rawstage2");
    assert.deepEqual(route?.fallback, [],
      "前置条件：v2_rawstage2.fallback 必须为 []，否则 route-level override 测试无意义");

    let claudeCalled = 0;
    let gptCalled = 0;
    globalThis.fetch = async (url, init) => {
      const urlStr = String(url);
      const body = (() => { try { return JSON.parse(init.body); } catch { return {}; } })();
      // 通过 model 区分 Claude vs GPT（Claude 协议走 makeClaudeAPICall，但 baseUrl 仍可区分）
      if (urlStr.includes("claude") || body.model?.includes("claude")) {
        claudeCalled += 1;
        return {
          ok: false, status: 500, statusText: "Internal Server Error",
          text: async () => "Claude failed",
          json: async () => ({ error: { message: "Claude failed" } }),
        };
      }
      if (urlStr.includes("gpt") || body.model?.includes("gpt")) {
        gptCalled += 1;
        return {
          ok: true, status: 200,
          json: async () => ({
            model: "gpt-5.5",
            choices: [{ index: 0, message: { role: "assistant", content: "gpt response" }, finish_reason: "stop" }],
          }),
          text: async () => "",
        };
      }
      return {
        ok: false, status: 500, statusText: "Unknown",
        text: async () => "unknown",
        json: async () => ({ error: { message: "unknown" } }),
      };
    };

    const manager = createAPIFallbackManager();
    let thrownError = null;
    try {
      await manager.callWithFallback(
        "v2_rawstage2",
        [{ role: "user", content: "test" }],
        { temperature: 0.2, max_tokens: 16 },
      );
    } catch (e) {
      thrownError = e;
    }

    // v2_rawstage2 fallback=[] → Claude 失败即 hard block，不回退 GPT
    assert.ok(claudeCalled > 0, "应尝试 Claude（primary provider）");
    assert.equal(
      gptCalled, 0,
      `v2_rawstage2.fallback=[] 时不得回退 GPT（route-level override），但 GPT 被调用了 ${gptCalled} 次`,
    );
    assert.ok(thrownError, "Claude 失败 + fallback=[] 应抛错（hard block）");
  });
});
