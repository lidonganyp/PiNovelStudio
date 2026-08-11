/**
 * APIFallbackManager total timeout behavior tests.
 *
 * These tests exercise the production fallback manager with mocked provider
 * calls. They verify the chain-level timeout instead of testing a copied
 * timeout snippet.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  APIFallbackManager,
  clearUnhealthyProviders,
  emitLLMAttempt,
  setLLMAttemptListener,
} from "../dist/api/fallback-manager.js";

const originalEnv = {
  GLM_API_KEY: process.env.GLM_API_KEY,
  GPT_API_KEY: process.env.GPT_API_KEY,
  GLM_MODEL: process.env.GLM_MODEL,
  GPT_MODEL: process.env.GPT_MODEL,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMockProviderContext(totalTimeoutMs) {
  return {
    routing: { provider: "glm", model: "glm-test" },
    primaryProvider: "glm",
    fallbackChain: ["glm", "gpt"],
    providers: {
      glm: {
        name: "Mock GLM",
        base_url: "https://example.invalid/v1",
        api_key_env: "GLM_API_KEY",
        model: "glm-test",
        protocol: "openai",
        temperature: {},
        max_tokens: {},
      },
      gpt: {
        name: "Mock GPT",
        base_url: "https://example.invalid/v1",
        api_key_env: "GPT_API_KEY",
        model: "gpt-test",
        protocol: "openai",
        temperature: {},
        max_tokens: {},
      },
    },
    retryOptions: {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 1,
      totalTimeoutMs,
    },
  };
}

function installMockContext(manager, totalTimeoutMs) {
  manager.loadFallbackContext = async () => buildMockProviderContext(totalTimeoutMs);
}

describe("APIFallbackManager totalTimeoutMs behavior", () => {
  // P43 Task 2：使用 "architect"（非主路由 agent）而非 "narrator_primary"，
  // 因为 B.3 白名单守卫现在正确阻止 narrator_primary 使用 glm/gpt（只允许 doubao/ernie）。
  // 本测试关注 timeout 行为，不关注主路由路由，故用非主路由 agent 名。
  beforeEach(() => {
    process.env.GLM_API_KEY = "test-glm-key";
    process.env.GPT_API_KEY = "test-gpt-key";
    process.env.GLM_MODEL = "glm-test";
    process.env.GPT_MODEL = "gpt-test";
    clearUnhealthyProviders();
    setLLMAttemptListener(null);
  });

  afterEach(() => {
    if (originalEnv.GLM_API_KEY === undefined) {
      delete process.env.GLM_API_KEY;
    } else {
      process.env.GLM_API_KEY = originalEnv.GLM_API_KEY;
    }

    if (originalEnv.GPT_API_KEY === undefined) {
      delete process.env.GPT_API_KEY;
    } else {
      process.env.GPT_API_KEY = originalEnv.GPT_API_KEY;
    }

    if (originalEnv.GLM_MODEL === undefined) {
      delete process.env.GLM_MODEL;
    } else {
      process.env.GLM_MODEL = originalEnv.GLM_MODEL;
    }

    if (originalEnv.GPT_MODEL === undefined) {
      delete process.env.GPT_MODEL;
    } else {
      process.env.GPT_MODEL = originalEnv.GPT_MODEL;
    }

    clearUnhealthyProviders();
  });

  test("throws a chain timeout after a slow provider exhausts the total budget", async () => {
    const manager = new APIFallbackManager();
    const attempts = [];

    installMockContext(manager, 25);
    manager.makeOpenAIChatCall = async (_baseUrl, _apiKey, _providerKey, model) => {
      attempts.push(model);
      await sleep(40);
      throw new Error("mock transient provider failure");
    };

    await assert.rejects(
      () => manager.callWithFallback("architect", [
        { role: "user", content: "test" },
      ]),
      /Fallback chain timeout: exceeded 25ms total budget/
    );

    assert.deepEqual(
      attempts,
      ["glm-test"],
      "the fallback provider should not be called once the chain budget is spent"
    );
  });

  test("does not trigger a timeout when the primary provider succeeds within budget", async () => {
    const manager = new APIFallbackManager();
    const attempts = [];

    installMockContext(manager, 250);
    manager.makeOpenAIChatCall = async (_baseUrl, _apiKey, _providerKey, model) => {
      attempts.push(model);
      await sleep(10);
      return {
        id: "mock-response",
        object: "chat.completion",
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      };
    };

    const result = await manager.callWithFallback("architect", [
      { role: "user", content: "test" },
    ]);

    assert.equal(result.usedProvider, "glm");
    assert.equal(result.usedModel, "glm-test");
    assert.equal(result.fellBack, false);
    assert.deepEqual(attempts, ["glm-test"]);
  });

  test("successful attempt trace binds requestId to a SHA-256 responseHash", async () => {
    const manager = new APIFallbackManager();
    const timings = [];
    setLLMAttemptListener((entry) => timings.push(entry));
    installMockContext(manager, 250);
    manager.makeOpenAIChatCall = async (_baseUrl, _apiKey, _providerKey, model) => ({
      id: "mock-response",
      object: "chat.completion",
      created: 0,
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "traceable response" },
        finish_reason: "stop",
      }],
    });

    await manager.callWithFallback("architect", [{ role: "user", content: "trace me" }]);

    const ok = timings.find((entry) => entry.status === "ok");
    assert.match(ok?.requestId ?? "", /^llm-/);
    assert.match(ok?.responseHash ?? "", /^[a-f0-9]{64}$/);
  });

  test("ok 调用从 usage 捕获输入/输出 token 到 llmTimings", async () => {
    const manager = new APIFallbackManager();
    const timings = [];
    setLLMAttemptListener((entry) => timings.push(entry));
    installMockContext(manager, 250);
    manager.makeOpenAIChatCall = async (_baseUrl, _apiKey, _providerKey, model) => ({
      id: "mock-response",
      object: "chat.completion",
      created: 0,
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "token-captured response" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1234, completion_tokens: 567, total_tokens: 1801 },
    });

    await manager.callWithFallback("architect", [{ role: "user", content: "count my tokens" }]);

    const ok = timings.find((entry) => entry.status === "ok");
    assert.equal(ok?.inputTokens, 1234, "llmTimings 应精确捕获输入 token");
    assert.equal(ok?.outputTokens, 567, "llmTimings 应精确捕获输出 token");
  });

  test("allows fallback success when no total timeout budget is configured", async () => {
    const manager = new APIFallbackManager();
    const attempts = [];
    installMockContext(manager, 250);
    manager.makeOpenAIChatCall = async (_baseUrl, _apiKey, _providerKey, model) => {
      attempts.push(model);
      if (model === "glm-test") {
        await sleep(40);
        throw new Error("mock transient provider failure");
      }

      return {
        id: "mock-fallback-response",
        object: "chat.completion",
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "fallback ok" },
            finish_reason: "stop",
          },
        ],
      };
    };

    const result = await manager.callWithFallback("architect", [
      { role: "user", content: "test" },
    ]);

    assert.equal(result.usedProvider, "gpt");
    assert.equal(result.usedModel, "gpt-test");
    assert.equal(result.fellBack, true);
    assert.deepEqual(attempts, ["glm-test", "gpt-test"]);
  });

  test("explicit manager retry limits override process-wide env for bounded eval calls", async () => {
    const previousRetries = process.env.PINOVEL_MODEL_MAX_RETRIES;
    const previousTotal = process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS;
    process.env.PINOVEL_MODEL_MAX_RETRIES = "3";
    process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS = "9999";
    try {
      const manager = new APIFallbackManager({ maxRetries: 0, totalTimeoutMs: 37 });
      installMockContext(manager, 5000);
      const resolved = manager.resolveRuntimeRetryOptions({ max_retries: 2, total_timeout_ms: 4000 });
      assert.equal(resolved.maxRetries, 0);
      assert.equal(resolved.totalTimeoutMs, 37);
    } finally {
      if (previousRetries === undefined) delete process.env.PINOVEL_MODEL_MAX_RETRIES;
      else process.env.PINOVEL_MODEL_MAX_RETRIES = previousRetries;
      if (previousTotal === undefined) delete process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS;
      else process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS = previousTotal;
    }
  });
});
