/**
 * Claude request protocol and sampling capability regression tests.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createAPIFallbackManager } from "../dist/api/fallback-manager.js";
import { RoutedChatAPI } from "../dist/api/routed-chat.js";

const originalFetch = globalThis.fetch;
const originalEnv = {
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
  CLAUDE_MODEL: process.env.CLAUDE_MODEL,
  GPT_API_KEY: process.env.GPT_API_KEY,
  PINOVEL_DISABLE_FALLBACK: process.env.PINOVEL_DISABLE_FALLBACK,
  PINOVEL_MODEL_MAX_RETRIES: process.env.PINOVEL_MODEL_MAX_RETRIES,
};

function makeAnthropicStreamResponse(text = "测试正文") {
  const encoder = new TextEncoder();
  const events = [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg-test",
        model: "claude-opus-4-6",
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(0, 2) },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(2) },
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(event));
        }
        controller.close();
      },
    }),
    text: async () => events.join(""),
    json: async () => {
      throw new Error("streaming response must not use response.json()");
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("v2_rawstage2 uses the Claude Code-compatible Anthropic Bearer protocol", async () => {
  process.env.CLAUDE_API_KEY = "test-claude-key";
  process.env.CLAUDE_MODEL = "claude-opus-4-6";
  process.env.PINOVEL_DISABLE_FALLBACK = "1";
  process.env.PINOVEL_MODEL_MAX_RETRIES = "0";

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      headers: init?.headers,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return makeAnthropicStreamResponse();
  };

  const manager = createAPIFallbackManager({ maxRetries: 0, baseDelayMs: 0 });
  const result = await manager.callWithFallback(
    "v2_rawstage2",
    [
      { role: "system", content: "System prompt with raw span." },
      { role: "user", content: "Generate candidate A and return JSON." },
    ],
    {},
  );

  assert.equal(result.usedProvider, "claude");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/messages$/);
  assert.equal(calls[0].headers.Authorization, "Bearer test-claude-key");
  assert.equal(Object.hasOwn(calls[0].headers, "x-api-key"), false);
  assert.equal(calls[0].body.model, "claude-opus-4-6");
  assert.equal(calls[0].body.max_tokens, 8192);
  assert.doesNotMatch(calls[0].body.system, /[A-Za-z]/);
  assert.doesNotMatch(calls[0].body.messages[0].content, /[A-Za-z]/);
  assert.deepEqual(calls[0].body.thinking, { type: "disabled" });
  assert.equal(calls[0].body.stream, true);
  assert.equal(Object.hasOwn(calls[0].body, "temperature"), false);
  assert.equal(Object.hasOwn(calls[0].body, "top_p"), false);
});

test("non-Claude OpenAI-compatible routes retain configured sampling parameters", async () => {
  process.env.GPT_API_KEY = "test-gpt-key";
  process.env.PINOVEL_DISABLE_FALLBACK = "1";
  process.env.PINOVEL_MODEL_MAX_RETRIES = "0";

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    // gpt provider 已切换 Responses 传输（providers.gpt.request_options.api=responses），
    // mock 返回 Responses API 格式响应。
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      json: async () => ({
        id: "resp-test",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "{}" }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    };
  };

  const manager = createAPIFallbackManager({ maxRetries: 0, baseDelayMs: 0 });
  const result = await manager.callWithFallback(
    "anti_ai_detector",
    [{ role: "user", content: "检查文本" }],
    { temperature: 0.2, max_tokens: 64 },
  );

  assert.equal(result.usedProvider, "gpt");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/responses$/);
  // Responses 传输保留采样参数：temperature 原样透传，max_tokens 映射为 max_output_tokens。
  assert.equal(calls[0].body.temperature, 0.2);
  assert.equal(calls[0].body.max_output_tokens, 64);
  assert.equal(result.response.choices[0].message.content, "{}");
});

test("RoutedChatAPI honors Anthropic Bearer authentication from provider options", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      headers: init?.headers,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return makeAnthropicStreamResponse("OK");
  };

  const api = new RoutedChatAPI(
    {
      agentName: "test_claude_route",
      provider: "claude",
      baseUrl: "https://aimagichub.xyz/v1",
      model: "claude-opus-4-6",
      protocol: "anthropic",
      temperature: 0.72,
      maxTokens: 8,
      requestOptions: { auth: "bearer" },
    },
    "test-claude-key",
  );

  const response = await api.chat([{ role: "user", content: "Reply only OK." }]);

  assert.equal(response.choices[0]?.message.content, "OK");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/messages$/);
  assert.equal(calls[0].headers.Authorization, "Bearer test-claude-key");
  assert.equal(Object.hasOwn(calls[0].headers, "x-api-key"), false);
  assert.equal(Object.hasOwn(calls[0].body, "temperature"), false);
  assert.equal(calls[0].body.stream, true);
});
