/** v2_literary_judge must use SSE even with its 4096-token structured budget. */

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
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("production literary judge requests and parses an OpenAI-compatible SSE stream", async () => {
  process.env.NOVELOS_JUDGE_API_KEY = "test-key";
  process.env.NOVELOS_JUDGE_BASE_URL = "https://judge.example.test/v1";
  process.env.NOVELOS_JUDGE_MODEL = "gpt-5.6-sol";
  process.env.PINOVEL_DISABLE_FALLBACK = "1";
  process.env.PINOVEL_MODEL_MAX_RETRIES = "0";

  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    const payload = [
      'data: {"choices":[{"delta":{"content":"{\\"winner\\":\\"A\\"}"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const generate = createLegacyModelGenerateFn();
  const result = await generate({
    route: "v2_literary_judge",
    kind: "literary_judge",
    systemPrompt: "Return strict JSON.",
    userPrompt: "Compare anonymous candidates.",
    maxTokens: 4096,
    timeoutMs: 30_000,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.max_tokens, 4096);
  assert.equal(result.text, '{"winner":"A"}');
  assert.equal(result.provider, "gpt");
  assert.equal(result.model, "gpt-5.6-sol");
});
