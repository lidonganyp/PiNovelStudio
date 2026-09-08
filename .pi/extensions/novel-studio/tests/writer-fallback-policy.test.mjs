import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  authorizedWriterFallbackRoutes,
  createLegacyModelGenerateFn,
} from "../dist/v2/adapters/legacy-model-route-adapter.js";
import { buildRoutingStabilityReport } from "../dist/v2/core/model-call-observability.js";

const routing = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../../config/model-routing.json"), "utf8"),
);

/**
 * GPT6-ASTRA-PRODUCTION-SWITCH-1：gpt-6-astra 走 shunfen6.win 单一 OpenAI 兼容渠道，
 * 无互备渠道（旧 Gemini Aimagichub/Solov 对等渠道链已删除）。
 * 生产写路由 fallback=[]，传输失败即 hard block，不静默切换 Claude/Gemini/Doubao。
 */
test("production gpt-6-astra writer routes have no authorized peer fallback", () => {
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_rawstage2_gpt6astra"), []);
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_amplified_gpt6astra"), []);
});

test("explicit Claude writer routes remain isolated", () => {
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_rawstage2"), []);
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_amplified"), []);
});

test("legacy Gemini writer route names no longer authorize any fallback", () => {
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_rawstage2_gemini31"), []);
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_rawstage2_gemini31_solov"), []);
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_amplified_gemini31"), []);
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_amplified_gemini31_solov"), []);
});

test("gpt-6-astra writer routes declare a single transport channel and fail-closed fallback", () => {
  const rawRoute = routing.agent_routing.v2_rawstage2_gpt6astra;
  const amplifiedRoute = routing.agent_routing.v2_amplified_gpt6astra;
  for (const route of [rawRoute, amplifiedRoute]) {
    assert.equal(route.provider, "gpt");
    assert.equal(route.model, "gpt-6-astra");
    assert.equal(route.channel, undefined, "gpt-6-astra 无互备渠道概念");
    assert.equal(route.base_url_env, "GPT_BASE_URL");
    assert.equal(route.api_key_env, "GPT_API_KEY");
    assert.equal(route.model_env, "GPT_WRITER_MODEL");
    assert.deepEqual(route.fallback, []);
  }
  assert.deepEqual(routing.agent_routing.v2_rawstage2.fallback, []);
  assert.deepEqual(routing.agent_routing.v2_amplified.fallback, []);
});

test("gpt-6-astra transport failure fails closed without switching the prose provider", async () => {
  const envKeys = [
    "GPT_API_KEY",
    "GPT_BASE_URL",
    "GPT_MODEL",
    "GPT_WRITER_MODEL",
    "PINOVEL_DISABLE_FALLBACK",
    "PINOVEL_MODEL_MAX_RETRIES",
  ];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    process.env.GPT_API_KEY = "shunfen-key";
    process.env.GPT_BASE_URL = "https://shunfen6.test/v1";
    process.env.GPT_WRITER_MODEL = "";
    process.env.GPT_MODEL = "structured-model-test";
    delete process.env.PINOVEL_DISABLE_FALLBACK;
    process.env.PINOVEL_MODEL_MAX_RETRIES = "0";
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url: String(url), authorization: init.headers.Authorization, model: body.model });
      return new Response("upstream unavailable", { status: 503 });
    };

    await assert.rejects(
      createLegacyModelGenerateFn()({
        kind: "raw_chapter",
        route: "v2_rawstage2_gpt6astra",
        systemPrompt: "system",
        userPrompt: "write",
        timeoutMs: 1000,
        maxTokens: 64,
      }),
      /All model calls failed/,
    );
    // 单渠道 fail-closed：只尝试 shunfen6 渠道本身，无互备渠道、无跨 provider 回退。
    assert.deepEqual(calls.map((call) => call.url), [
      "https://shunfen6.test/v1/responses",
    ]);
    assert.deepEqual(calls.map((call) => call.authorization), [
      "Bearer shunfen-key",
    ]);
    assert.deepEqual(calls.map((call) => call.model), [
      "gpt-6-astra",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});

test("judge and evaluation routes never receive a prose writer fallback", () => {
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_opportunity_judge"), []);
  assert.deepEqual(authorizedWriterFallbackRoutes("nb4_generate_glm"), []);
  assert.deepEqual(authorizedWriterFallbackRoutes("nb4_generate_gpt6astra-placeholder"), []);
});

test("routing stability report accepts the single-channel gpt-6-astra writer", () => {
  const report = buildRoutingStabilityReport({
    runId: "run-1",
    expectedProvider: "gpt",
    expectedModel: "gpt-6-astra",
    calls: [{
      runId: "run-1",
      stage: "agentic_raw",
      route: "v2_rawstage2_gpt6astra",
      provider: "gpt",
      model: "gpt-6-astra",
      modelVersion: "gpt-6-astra",
      promptBundleHash: "bundle",
      contextHash: "context",
      temperature: 0.72,
      maxTokens: 16384,
      timeout: 120000,
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 100,
      waitMs: 0,
      retryIndex: 0,
      budgetType: "hard",
      fallbackTrace: {
        authorized: true,
        fromRoute: "v2_rawstage2_gpt6astra",
        attemptedRoutes: ["v2_rawstage2_gpt6astra"],
        failures: [],
      },
    }],
  });

  assert.equal(report.unauthorizedCrossModelCount, 0);
  assert.equal(report.stable, true);
});
