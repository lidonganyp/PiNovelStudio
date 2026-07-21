/**
 * JUDGE-GATEWAY-STREAMING-1
 *
 * Long-running GPT opportunity judgments must use SSE so the reverse proxy
 * receives response bytes before its non-streaming gateway timeout. Repeated
 * 502/504 responses remain bounded and preserve the existing raw fallback.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createLegacyModelGenerateFn } from "../dist/v2/adapters/legacy-model-route-adapter.js";

const originalFetch = globalThis.fetch;
const originalEnv = {
  NOVELOS_JUDGE_API_KEY: process.env.NOVELOS_JUDGE_API_KEY,
  NOVELOS_JUDGE_BASE_URL: process.env.NOVELOS_JUDGE_BASE_URL,
  NOVELOS_JUDGE_MODEL: process.env.NOVELOS_JUDGE_MODEL,
  PINOVEL_DISABLE_FALLBACK: process.env.PINOVEL_DISABLE_FALLBACK,
  PINOVEL_MODEL_MAX_RETRIES: process.env.PINOVEL_MODEL_MAX_RETRIES,
  PINOVEL_MODEL_RETRY_DELAY_MS: process.env.PINOVEL_MODEL_RETRY_DELAY_MS,
  PINOVEL_JUDGE_MAX_RETRIES: process.env.PINOVEL_JUDGE_MAX_RETRIES,
};

function configureJudgeEnvironment() {
  process.env.NOVELOS_JUDGE_API_KEY = "test-key";
  process.env.NOVELOS_JUDGE_BASE_URL = "https://judge.example.test/v1";
  process.env.NOVELOS_JUDGE_MODEL = "gpt-5.6-sol";
  process.env.PINOVEL_DISABLE_FALLBACK = "1";
  process.env.PINOVEL_MODEL_RETRY_DELAY_MS = "0";
  delete process.env.PINOVEL_MODEL_MAX_RETRIES;
  delete process.env.PINOVEL_JUDGE_MAX_RETRIES;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("production opportunity judge requests and parses an OpenAI-compatible SSE stream", async () => {
  configureJudgeEnvironment();
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ url: String(url), body });
    const verdict = '{"opportunities":[],"noOpReason":"raw is already strong"}';
    if (body.stream === true) {
      const payload = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: verdict }, finish_reason: "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: verdict }, finish_reason: "stop" }],
    });
  };

  const result = await createLegacyModelGenerateFn()({
    route: "v2_opportunity_judge",
    kind: "opportunity_judge",
    systemPrompt: "Return strict JSON.",
    userPrompt: "Find only span-backed editorial opportunities.",
    maxTokens: 4096,
    timeoutMs: 30_000,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.max_tokens, 4096);
  assert.equal(result.text, '{"opportunities":[],"noOpReason":"raw is already strong"}');
  assert.equal(result.provider, "gpt");
});

test("production opportunity judge stops after one retry when the gateway keeps returning 504", async () => {
  configureJudgeEnvironment();
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response("<html><title>504 Gateway Time-out</title></html>", {
      status: 504,
      headers: { "content-type": "text/html" },
    });
  };

  await assert.rejects(
    () => createLegacyModelGenerateFn()({
      route: "v2_opportunity_judge",
      kind: "opportunity_judge",
      systemPrompt: "Return strict JSON.",
      userPrompt: "Find only span-backed editorial opportunities.",
      maxTokens: 4096,
      timeoutMs: 30_000,
    }),
    /504 Gateway Time-out/,
  );

  assert.equal(requests.length, 2, "首次请求加一次重试后必须停止");
  assert.ok(requests.every((request) => request.body.stream === true));
});
