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

test("production Gemini writer routes fall back only to the peer Gemini channel", () => {
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_rawstage2_gemini31"), [
    "v2_rawstage2_gemini31_solov",
  ]);
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_amplified_gemini31"), [
    "v2_amplified_gemini31_solov",
  ]);
});

test("the two Gemini channels are mutually authorized", () => {
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_rawstage2_gemini31_solov"), [
    "v2_rawstage2_gemini31",
  ]);
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_amplified_gemini31_solov"), [
    "v2_amplified_gemini31",
  ]);
});

test("explicit Claude writer routes remain isolated", () => {
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_rawstage2"), []);
  assert.deepEqual(authorizedWriterFallbackRoutes("v2_amplified"), []);
});

test("Gemini peer routes declare separate channels but the same writer identity", () => {
  const aimagichub = routing.agent_routing.v2_rawstage2_gemini31;
  const solov = routing.agent_routing.v2_rawstage2_gemini31_solov;
  assert.equal(aimagichub.provider, "gemini31");
  assert.equal(solov.provider, "gemini31");
  assert.equal(aimagichub.model, solov.model);
  assert.equal(aimagichub.channel, "aimagichub");
  assert.equal(solov.channel, "solov");
  assert.equal(solov.base_url_env, "GEMINI_SOLOV_BASE_URL");
  assert.equal(solov.api_key_env, "GEMINI_SOLOV_API_KEY");
  assert.equal(solov.model_env, "GEMINI_SOLOV_MODEL");
  assert.deepEqual(routing.agent_routing.v2_rawstage2.fallback, []);
  assert.deepEqual(routing.agent_routing.v2_amplified.fallback, []);
});

test("Gemini channel recovery switches request transport without changing writer identity", async () => {
  const envKeys = [
    "GEMINI_API_KEY",
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_MODEL",
    "GEMINI_AIMAGICHUB_API_KEY",
    "GEMINI_AIMAGICHUB_BASE_URL",
    "GEMINI_AIMAGICHUB_MODEL",
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
    process.env.GEMINI_API_KEY = "aimagichub-key";
    process.env.GOOGLE_GEMINI_BASE_URL = "https://aimagichub.test/v1";
    process.env.GEMINI_MODEL = "gemini-3.7-flash";
    process.env.GEMINI_AIMAGICHUB_API_KEY = "aimagichub-key";
    process.env.GEMINI_AIMAGICHUB_BASE_URL = "https://aimagichub.test/v1";
    process.env.GEMINI_AIMAGICHUB_MODEL = "gemini-3.7-flash";
    process.env.GEMINI_SOLOV_API_KEY = "solov-key";
    process.env.GEMINI_SOLOV_BASE_URL = "https://solov.test/v1";
    process.env.GEMINI_SOLOV_MODEL = "gemini-3.7-flash";
    delete process.env.PINOVEL_DISABLE_FALLBACK;
    process.env.PINOVEL_MODEL_MAX_RETRIES = "0";
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url: String(url), authorization: init.headers.Authorization, model: body.model });
      if (String(url).startsWith("https://aimagichub.test/")) {
        return new Response("upstream unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "solov recovery" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const result = await createLegacyModelGenerateFn()({
      kind: "raw_chapter",
      route: "v2_rawstage2_gemini31",
      systemPrompt: "system",
      userPrompt: "write",
      timeoutMs: 1000,
      maxTokens: 64,
    });

    assert.equal(result.text, "solov recovery");
    assert.equal(result.provider, "gemini31");
    assert.equal(result.model, "gemini-3.7-flash");
    assert.deepEqual(calls.map((call) => call.url), [
      "https://aimagichub.test/v1/chat/completions",
      "https://solov.test/v1/chat/completions",
    ]);
    assert.deepEqual(calls.map((call) => call.authorization), [
      "Bearer aimagichub-key",
      "Bearer solov-key",
    ]);
    assert.deepEqual(calls.map((call) => call.model), [
      "gemini-3.7-flash",
      "gemini-3.7-flash",
    ]);
    assert.equal(result.fallbackTrace.authorized, true);
    assert.equal(result.fallbackTrace.fromRoute, "v2_rawstage2_gemini31");
    assert.deepEqual(result.fallbackTrace.attemptedRoutes, [
      "v2_rawstage2_gemini31",
      "v2_rawstage2_gemini31_solov",
    ]);
    assert.equal(result.fallbackTrace.failures.length, 1);
    assert.match(result.fallbackTrace.failures[0], /503.*upstream unavailable/);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});

test("Gemini channel recovery fails closed when the peer has no credentials", async () => {
  const envKeys = [
    "GEMINI_API_KEY",
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_AIMAGICHUB_API_KEY",
    "GEMINI_AIMAGICHUB_BASE_URL",
    "GEMINI_AIMAGICHUB_MODEL",
    "GEMINI_SOLOV_API_KEY",
    "GEMINI_SOLOV_BASE_URL",
    "GEMINI_SOLOV_MODEL",
    "PINOVEL_MODEL_MAX_RETRIES",
  ];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    process.env.GEMINI_API_KEY = "aimagichub-key";
    process.env.GOOGLE_GEMINI_BASE_URL = "https://aimagichub.test/v1";
    process.env.GEMINI_AIMAGICHUB_API_KEY = "aimagichub-key";
    process.env.GEMINI_AIMAGICHUB_BASE_URL = "https://aimagichub.test/v1";
    process.env.GEMINI_AIMAGICHUB_MODEL = "gemini-3.7-flash";
    delete process.env.GEMINI_SOLOV_API_KEY;
    delete process.env.GEMINI_SOLOV_BASE_URL;
    delete process.env.GEMINI_SOLOV_MODEL;
    process.env.PINOVEL_MODEL_MAX_RETRIES = "0";
    globalThis.fetch = async (url) => {
      calls.push(String(url));
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
    assert.deepEqual(calls, ["https://aimagichub.test/v1/chat/completions"]);
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
});

test("authorized fallback evidence is excluded from unauthorized routing drift", () => {
  const report = buildRoutingStabilityReport({
    runId: "run-1",
    expectedProvider: "gemini31",
    expectedModel: "gemini-3.7-flash",
    calls: [{
      runId: "run-1",
      stage: "agentic_raw",
      route: "v2_rawstage2_gemini31",
      provider: "gemini31",
      model: "gemini-3.7-flash",
      modelVersion: "gemini-3.7-flash",
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
      fallbackTrace: {
        authorized: true,
        fromRoute: "v2_rawstage2_gemini31",
        attemptedRoutes: ["v2_rawstage2_gemini31", "v2_rawstage2_gemini31_solov"],
        failures: ["timeout"],
      },
    }],
  });

  assert.equal(report.unauthorizedCrossModelCount, 0);
  assert.equal(report.stable, true);
});
