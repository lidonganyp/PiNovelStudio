import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  authorizedWriterFallbackRoutes,
  createLegacyModelGenerateFn,
} from "../dist/v2/adapters/legacy-model-route-adapter.js";
import { clearUnhealthyProviders } from "../dist/api/fallback-manager.js";
import { buildRoutingStabilityReport } from "../dist/v2/core/model-call-observability.js";
import {
  clearConfigCache,
  getGeminiWriterModel,
  resolveRoutingEnvironment,
} from "../dist/utils/config.js";

const routing = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../../config/model-routing.json"), "utf8"),
);

/**
 * WRITER-ENV-UNIFY-1：生产 writer 只有一个配置渠道（.env GEMINI_MODEL /
 * GOOGLE_GEMINI_BASE_URL / GEMINI_API_KEY）。请求失败只在同一渠道内有界重试；
 * 不得自动换 Solov、Claude 或其他正文模型。显式选择 Claude 的既有能力保留。
 */

test("production Gemini writer routes authorize no fallback channel", () => {
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_rawstage2_gemini31"), []);
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_amplified_gemini31"), []);
});

test("removed Solov route names no longer authorize any fallback", () => {
  assert.equal(routing.agent_routing.v2_rawstage2_gemini31_solov, undefined);
  assert.equal(routing.agent_routing.v2_amplified_gemini31_solov, undefined);
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_rawstage2_gemini31_solov"), []);
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_amplified_gemini31_solov"), []);
});

test("explicit Claude writer routes remain isolated", () => {
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_rawstage2"), []);
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_amplified"), []);
});

test("legacy gpt-6-astra writer route names no longer authorize any fallback", () => {
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_rawstage2_gpt6astra"), []);
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_amplified_gpt6astra"), []);
});

test("production Gemini writer identity resolves from effective .env configuration", () => {
  const raw = routing.agent_routing.v2_rawstage2_gemini31;
  assert.equal(raw.provider, "gemini31");
  // 路由 JSON 只保留稳定占位符；实际身份由 .env 变量解析
  assert.equal(raw.model, "${GEMINI_MODEL}");
  assert.equal(raw.base_url_env, "GOOGLE_GEMINI_BASE_URL");
  assert.equal(raw.api_key_env, "GEMINI_API_KEY");
  assert.equal(raw.model_env, "GEMINI_MODEL");
  assert.deepEqual(raw.fallback, []);
  assert.deepEqual(routing.fallback.gemini31, []);

  const resolved = resolveRoutingEnvironment(routing);
  assert.equal(resolved.agent_routing.v2_rawstage2_gemini31.model, getGeminiWriterModel());
  assert.equal(
    resolved.agent_routing.v2_rawstage2_gemini31.model,
    process.env.GEMINI_MODEL?.trim(),
  );
});

test("single-channel writer failure blocks without switching channels", async () => {
  const envKeys = [
    "GEMINI_API_KEY",
    "GEMINI_AIMAGICHUB_API_KEY",
    "GEMINI_AIMAGICHUB_BASE_URL",
    "GEMINI_AIMAGICHUB_MODEL",
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_MODEL",
    "GEMINI_SOLOV_API_KEY",
    "GEMINI_SOLOV_BASE_URL",
    "GEMINI_SOLOV_MODEL",
    "PINOVEL_DISABLE_FALLBACK",
    "PINOVEL_MODEL_MAX_RETRIES",
  ];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    // 统一渠道变量决定请求地址；旧渠道变量即使设置也不得参与路由
    process.env.GEMINI_API_KEY = "writer-key";
    process.env.GOOGLE_GEMINI_BASE_URL = "https://writer.test/v1";
    process.env.GEMINI_MODEL = "gemini-test-writer";
    process.env.GEMINI_AIMAGICHUB_API_KEY = "legacy-aimagichub-key";
    process.env.GEMINI_AIMAGICHUB_BASE_URL = "https://aimagichub-legacy.test/v1";
    process.env.GEMINI_AIMAGICHUB_MODEL = "gemini-legacy";
    process.env.GEMINI_SOLOV_API_KEY = "legacy-solov-key";
    process.env.GEMINI_SOLOV_BASE_URL = "https://solov-legacy.test/v1";
    process.env.GEMINI_SOLOV_MODEL = "gemini-legacy";
    delete process.env.PINOVEL_DISABLE_FALLBACK;
    process.env.PINOVEL_MODEL_MAX_RETRIES = "0";
    clearConfigCache();
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url: String(url), authorization: init.headers.Authorization, model: body.model });
      return new Response("upstream unavailable", { status: 503 });
    };

    await assert.rejects(
      createLegacyModelGenerateFn()({
        kind: "raw_chapter",
        route: "v2_rawstage2_gemini31",
        systemPrompt: "system",
        userPrompt: "write",
        timeoutMs: 1000,
        maxTokens: 64,
      }),
      /All model calls failed/,
    );

    // 单渠道：只有统一渠道地址收到请求，旧渠道变量地址零请求
    assert.deepEqual(calls.map((call) => call.url), [
      "https://writer.test/v1/chat/completions",
    ]);
    assert.deepEqual(calls.map((call) => call.authorization), ["Bearer writer-key"]);
    assert.deepEqual(calls.map((call) => call.model), ["gemini-test-writer"]);
  } finally {
    globalThis.fetch = previousFetch;
    clearConfigCache();
    // 401 等永久错误会把 provider 标记为模块级 unhealthy；测试之间必须清零，
    // 否则后续测试的请求会被 unhealthy_skip 跳过（fetch mock 根本不会收到调用）。
    clearUnhealthyProviders();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});

test("bounded retry stays on the same channel before blocking", async () => {
  const envKeys = [
    "GEMINI_API_KEY",
    "GEMINI_AIMAGICHUB_API_KEY",
    "GEMINI_AIMAGICHUB_BASE_URL",
    "GEMINI_AIMAGICHUB_MODEL",
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_MODEL",
    "GEMINI_SOLOV_API_KEY",
    "GEMINI_SOLOV_BASE_URL",
    "GEMINI_SOLOV_MODEL",
    "PINOVEL_DISABLE_FALLBACK",
    "PINOVEL_MODEL_MAX_RETRIES",
  ];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const urls = [];
  try {
    process.env.GEMINI_API_KEY = "writer-key";
    process.env.GOOGLE_GEMINI_BASE_URL = "https://writer.test/v1";
    process.env.GEMINI_MODEL = "gemini-test-writer";
    delete process.env.GEMINI_AIMAGICHUB_API_KEY;
    delete process.env.GEMINI_AIMAGICHUB_BASE_URL;
    delete process.env.GEMINI_AIMAGICHUB_MODEL;
    delete process.env.GEMINI_SOLOV_API_KEY;
    delete process.env.GEMINI_SOLOV_BASE_URL;
    delete process.env.GEMINI_SOLOV_MODEL;
    delete process.env.PINOVEL_DISABLE_FALLBACK;
    process.env.PINOVEL_MODEL_MAX_RETRIES = "1";
    clearConfigCache();
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response("upstream unavailable", { status: 503 });
    };

    await assert.rejects(
      createLegacyModelGenerateFn()({
        kind: "raw_chapter",
        route: "v2_rawstage2_gemini31",
        systemPrompt: "system",
        userPrompt: "write",
        timeoutMs: 5000,
        maxTokens: 64,
      }),
      /All model calls failed/,
    );

    // 有界重试始终命中同一渠道地址；重试耗尽即阻断
    assert.equal(urls.length, 2);
    assert.deepEqual(urls, [
      "https://writer.test/v1/chat/completions",
      "https://writer.test/v1/chat/completions",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    clearConfigCache();
    // 401 等永久错误会把 provider 标记为模块级 unhealthy；测试之间必须清零，
    // 否则后续测试的请求会被 unhealthy_skip 跳过（fetch mock 根本不会收到调用）。
    clearUnhealthyProviders();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});

test("auth failure (401) blocks on the single channel without switching", async () => {
  const envKeys = [
    "GEMINI_API_KEY",
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_MODEL",
    "PINOVEL_DISABLE_FALLBACK",
    "PINOVEL_MODEL_MAX_RETRIES",
  ];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    process.env.GEMINI_API_KEY = "writer-key";
    process.env.GOOGLE_GEMINI_BASE_URL = "https://writer.test/v1";
    process.env.GEMINI_MODEL = "gemini-test-writer";
    delete process.env.PINOVEL_DISABLE_FALLBACK;
    process.env.PINOVEL_MODEL_MAX_RETRIES = "0";
    clearConfigCache();
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url: String(url), authorization: init.headers.Authorization, model: body.model });
      return new Response("unauthorized", { status: 401 });
    };

    await assert.rejects(
      createLegacyModelGenerateFn()({
        kind: "raw_chapter",
        route: "v2_rawstage2_gemini31",
        systemPrompt: "system",
        userPrompt: "write",
        timeoutMs: 1000,
        maxTokens: 64,
      }),
      (error) => /unauthorized|401|All model calls failed/i.test(String(error?.message ?? error)),
    );

    // 鉴权失败不切换渠道：仅统一渠道地址收到一次请求
    assert.deepEqual(calls.map((call) => call.url), [
      "https://writer.test/v1/chat/completions",
    ]);
    assert.deepEqual(calls.map((call) => call.authorization), ["Bearer writer-key"]);
  } finally {
    globalThis.fetch = previousFetch;
    clearConfigCache();
    // 401 等永久错误会把 provider 标记为模块级 unhealthy；测试之间必须清零，
    // 否则后续测试的请求会被 unhealthy_skip 跳过（fetch mock 根本不会收到调用）。
    clearUnhealthyProviders();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});

test("request timeout blocks after bounded same-channel attempts", async () => {
  const envKeys = [
    "GEMINI_API_KEY",
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_MODEL",
    "PINOVEL_DISABLE_FALLBACK",
    "PINOVEL_MODEL_MAX_RETRIES",
  ];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const urls = [];
  try {
    process.env.GEMINI_API_KEY = "writer-key";
    process.env.GOOGLE_GEMINI_BASE_URL = "https://writer.test/v1";
    process.env.GEMINI_MODEL = "gemini-test-writer";
    delete process.env.PINOVEL_DISABLE_FALLBACK;
    process.env.PINOVEL_MODEL_MAX_RETRIES = "0";
    clearConfigCache();
    // 模拟挂起请求：仅在 fetchWithTimeout 的 AbortSignal 触发时以 AbortError 拒绝
    globalThis.fetch = (url, init) =>
      new Promise((_, reject) => {
        urls.push(String(url));
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });

    await assert.rejects(
      createLegacyModelGenerateFn()({
        kind: "raw_chapter",
        route: "v2_rawstage2_gemini31",
        systemPrompt: "system",
        userPrompt: "write",
        timeoutMs: 200,
        maxTokens: 64,
      }),
      (error) => /abort|timeout|timed out|All model calls failed/i.test(String(error?.message ?? error)),
    );

    // 超时只在同一渠道内处理，不切换渠道
    assert.deepEqual(urls, ["https://writer.test/v1/chat/completions"]);
  } finally {
    globalThis.fetch = previousFetch;
    clearConfigCache();
    // 401 等永久错误会把 provider 标记为模块级 unhealthy；测试之间必须清零，
    // 否则后续测试的请求会被 unhealthy_skip 跳过（fetch mock 根本不会收到调用）。
    clearUnhealthyProviders();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});

test("empty model response stays on the single channel (empty-text gating is downstream)", async () => {
  const envKeys = [
    "GEMINI_API_KEY",
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_MODEL",
    "PINOVEL_DISABLE_FALLBACK",
    "PINOVEL_MODEL_MAX_RETRIES",
  ];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    process.env.GEMINI_API_KEY = "writer-key";
    process.env.GOOGLE_GEMINI_BASE_URL = "https://writer.test/v1";
    process.env.GEMINI_MODEL = "gemini-test-writer";
    delete process.env.PINOVEL_DISABLE_FALLBACK;
    process.env.PINOVEL_MODEL_MAX_RETRIES = "0";
    clearConfigCache();
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url: String(url), model: body.model });
      return new Response(
        JSON.stringify({
          model: body.model,
          choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    // 传输层拿到 200 空文本：不切换渠道；空文 fail-closed 由下游完整性门禁负责
    const output = await createLegacyModelGenerateFn()({
      kind: "raw_chapter",
      route: "v2_rawstage2_gemini31",
      systemPrompt: "system",
      userPrompt: "write",
      timeoutMs: 1000,
      maxTokens: 64,
    });

    assert.deepEqual(calls.map((call) => call.url), [
      "https://writer.test/v1/chat/completions",
    ]);
    assert.equal(output.model, "gemini-test-writer");
    assert.ok(!output.text, "空响应不得被传输层填充为非空文本");
  } finally {
    globalThis.fetch = previousFetch;
    clearConfigCache();
    // 401 等永久错误会把 provider 标记为模块级 unhealthy；测试之间必须清零，
    // 否则后续测试的请求会被 unhealthy_skip 跳过（fetch mock 根本不会收到调用）。
    clearUnhealthyProviders();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});

test("judge and evaluation routes never receive a prose writer fallback", () => {
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_opportunity_judge"), []);
  assert.deepEqual(authorizedWriterFallbackRoutes("nb4_generate_glm"), []);
});

test("routing stability report stays stable for same-channel bounded retries", () => {
  const report = buildRoutingStabilityReport({
    runId: "run-1",
    expectedProvider: "gemini31",
    expectedModel: "gemini-test-writer",
    calls: [{
      runId: "run-1",
      stage: "agentic_raw",
      route: "v2_rawstage2_gemini31",
      provider: "gemini31",
      model: "gemini-test-writer",
      modelVersion: "gemini-test-writer",
      promptBundleHash: "bundle",
      contextHash: "context",
      temperature: 0.7,
      maxTokens: 4096,
      timeout: 120000,
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 100,
      waitMs: 0,
      retryIndex: 1,
      budgetType: "recovery",
    }],
  });

  assert.equal(report.unauthorizedCrossModelCount, 0);
  assert.equal(report.stable, true);
});
