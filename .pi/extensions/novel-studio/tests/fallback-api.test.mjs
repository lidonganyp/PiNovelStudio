/**
 * PiNovelStudio fallback API routing safety tests.
 *
 * These tests inspect the compiled fallback manager because the behavior under
 * test is mostly route resolution and cross-protocol dispatch wiring. Method
 * bodies are extracted with brace balancing so harmless nested branches do not
 * break the assertions.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { before, describe, test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");

test('budget and authorization denial do not consume transport retry loops', async () => {
  const { classifyError } = await import('../dist/api/fallback-manager.js');
  assert.equal(classifyError(Object.assign(new Error('budget denied'),{code:'BUDGET_EXHAUSTED'})), 'permanent');
  assert.equal(classifyError(Object.assign(new Error('authorization denied'),{code:'TRANSPORT_ADMISSION_DENIED'})), 'permanent');
  assert.equal(classifyError(new Error('temporary network failure')), 'transient');
});

function extractMethod(source, methodName) {
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?${methodName}\\s*\\(`, "m");
  const match = pattern.exec(source);
  assert.ok(match, `Expected compiled fallback manager to contain ${methodName}`);

  const openBrace = source.indexOf("{", match.index);
  assert.notEqual(openBrace, -1, `Expected ${methodName} to have a body`);

  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const method = source.slice(match.index, index + 1);
        // Public methods now attach the trusted HTTP accounting route before
        // forwarding to the unchanged dispatch implementation.
        return method.includes(`this.${methodName}Internal(`)
          ? `${method}\n${extractMethod(source, `${methodName}Internal`)}` : method;
      }
    }
  }

  assert.fail(`Could not find the end of ${methodName}`);
}

describe("Fallback API routing", () => {
  let fallbackSrc;
  let configData;

  before(() => {
    const extRoot = resolve(repoRoot, ".pi/extensions/novel-studio");
    fallbackSrc = readFileSync(
      join(extRoot, "dist", "api", "fallback-manager.js"),
      "utf-8"
    );
    configData = JSON.parse(
      readFileSync(resolve(repoRoot, "config/model-routing.json"), "utf-8")
    );
  });

  test("resolveProviderModel only uses routing.model for the primary provider", () => {
    const methodSrc = extractMethod(fallbackSrc, "resolveProviderModel");

    assert.ok(methodSrc.includes("isPrimary"), "should compute primary provider status");
    assert.ok(
      methodSrc.includes("if (isPrimary && routingModel)"),
      "routing.model should only be applied to the primary provider"
    );
    assert.ok(methodSrc.includes("provider.model"), "fallback providers should use provider.model");
    assert.ok(methodSrc.includes("getModelOverride"), "model IDs should honor .env overrides");
  });

  test("callWithFallback records fellBack on successful provider selection", () => {
    const methodSrc = extractMethod(fallbackSrc, "callWithFallback");
    const fellBackIndex = methodSrc.indexOf("fellBack = providerKey !== primaryProvider");
    const returnIndex = methodSrc.indexOf("return {", fellBackIndex);

    assert.notEqual(fellBackIndex, -1, "should set fellBack in the success path");
    assert.notEqual(returnIndex, -1, "should return after setting fellBack");
  });

  test("callClaudeWithFallback records fellBack and supports cross-protocol fallback", () => {
    const methodSrc = extractMethod(fallbackSrc, "callClaudeWithFallback");

    assert.ok(
      methodSrc.includes("fellBack = providerKey !== primaryProvider"),
      "should set fellBack in the success path"
    );
    assert.ok(methodSrc.includes("protocol"), "should branch by provider protocol");
    assert.ok(
      methodSrc.includes("makeGPTAPICall"),
      "Claude-shaped calls should fall back to OpenAI-compatible providers"
    );
  });

  test("callGPTWithFallback records fellBack and supports cross-protocol fallback", () => {
    const methodSrc = extractMethod(fallbackSrc, "callGPTWithFallback");

    assert.ok(
      methodSrc.includes("fellBack = providerKey !== primaryProvider"),
      "should set fellBack in the success path"
    );
    assert.ok(methodSrc.includes("protocol"), "should branch by provider protocol");
    assert.ok(
      methodSrc.includes("makeClaudeAPICall"),
      "GPT-shaped calls should fall back to Anthropic-compatible providers"
    );
  });

  test("makeGPTAPICall forwards response_format", () => {
    const methodSrc = extractMethod(fallbackSrc, "makeGPTAPICall");

    assert.ok(methodSrc.includes("response_format"), "should support response_format");
    assert.ok(
      methodSrc.includes("request.response_format"),
      "should write response_format into the request body"
    );
  });

  test("callGPTWithFallback defaults to json_object mode", () => {
    const methodSrc = extractMethod(fallbackSrc, "callGPTWithFallback");

    assert.ok(methodSrc.includes("json_object"), "should default to json_object output");
  });

  test("model-routing.json gives every provider an explicit protocol", () => {
    for (const [name, provider] of Object.entries(configData.providers)) {
      assert.ok(provider.protocol, `${name} should declare protocol`);
      assert.ok(
        provider.protocol === "openai" || provider.protocol === "anthropic",
        `${name} protocol should be openai or anthropic, got ${provider.protocol}`
      );
    }
  });

  test("anti_ai_detector routes to gpt/gpt-5.5", () => {
    const route = configData.agent_routing.anti_ai_detector;

    assert.strictEqual(route.provider, "gpt");
    assert.strictEqual(route.model, "gpt-5.5");
  });

  test("gpt_backup provider remains in catalog but is NOT in active fallback chain (v4.2.0 rebalance)", () => {
    // v4.2.0 migration: gpt_backup is kept as a credentials/catalog provider only,
    // removed from active stage routing, agent routing, best-of candidates, and
    // fallback chains to avoid duplicate GPT endpoints. This aligns with the
    // user constraint: "do not delete models from provider catalog; only adjust
    // from active routing."
    const backup = configData.providers.gpt_backup;

    assert.ok(backup, "gpt_backup provider should remain in the provider catalog");
    assert.strictEqual(backup.protocol, "openai");
    assert.strictEqual(backup.base_url, "https://shunfen6.win/v1");
    assert.strictEqual(backup.api_key_env, "GPT_BACKUP_API_KEY");
    assert.strictEqual(backup.model, "gpt-5.5");
    assert.strictEqual(
      configData.fallback.gpt.includes("gpt_backup"),
      false,
      "gpt_backup should NOT be in the active gpt fallback chain after v4.2.0 rebalance"
    );
    assert.deepEqual(
      configData.fallback.gpt,
      ["claude"],
      "v4.6.0 P35 治理：fallback.gpt 收紧为 [claude]，避免 Stage 2 生产主写静默兜底到 Doubao/DeepSeek 正文"
    );
  });

  test("claude_backup provider remains in catalog but is NOT in active fallback chain (v4.2.0 rebalance)", () => {
    // v4.2.0 migration: claude_backup is kept as a credentials/catalog provider only,
    // removed from active stage routing, agent routing, best-of candidates, and
    // fallback chains to avoid duplicate Claude endpoints.
    const backup = configData.providers.claude_backup;

    assert.ok(backup, "claude_backup provider should remain in the provider catalog");
    assert.strictEqual(backup.protocol, "anthropic");
    assert.strictEqual(backup.request_options?.auth, "bearer");
    // 2026-07-18: aimagichub.xyz 的 Claude Code-compatible Anthropic Bearer 路径实测可用；
    // OpenAI-compatible /chat/completions 路径在章节生成中返回 504。
    assert.strictEqual(backup.base_url, "https://aimagichub.xyz/v1");
    assert.strictEqual(backup.api_key_env, "CLAUDE_BACKUP_API_KEY");
    // MODEL-ROUTING-CLAUDE46-1B: claude_backup model 从 claude-opus-4-8 切到 claude-opus-4-6
    assert.strictEqual(backup.model, "claude-opus-4-6");
    assert.strictEqual(
      configData.fallback.claude.includes("claude_backup"),
      false,
      "claude_backup should NOT be in the active claude fallback chain after v4.2.0 rebalance"
    );
    assert.deepEqual(
      configData.fallback.claude,
      ["gpt"],
      "v4.6.0 P35 治理：fallback.claude 收紧为 [gpt]，避免 Stage 2 生产主写静默兜底到 Doubao/DeepSeek 正文"
    );
  });

  test("APIFallbackManager keeps protocol inference as a final guard", () => {
    assert.ok(fallbackSrc.includes("inferProtocol"), "should keep inferProtocol");
  });

  test("APIFallbackManager resolves retry options from routing config and env overrides", () => {
    assert.ok(
      fallbackSrc.includes("resolveRuntimeRetryOptions"),
      "should resolve runtime retry options before provider attempts"
    );
    assert.ok(
      fallbackSrc.includes("modelRouting.retry"),
      "should read retry defaults from model-routing.json"
    );
    assert.ok(
      fallbackSrc.includes("PINOVEL_MODEL_MAX_RETRIES"),
      "should allow bounded replay runs to cap retry count"
    );
    assert.ok(
      fallbackSrc.includes("PINOVEL_MODEL_RETRY_DELAY_MS"),
      "should allow bounded replay runs to cap retry delay"
    );
  });

  test("APIFallbackManager includes provider failure details in all-failed errors", () => {
    assert.ok(
      fallbackSrc.includes("summarizeFailureLogs"),
      "should summarize provider failures when all calls fail"
    );
    assert.ok(
      fallbackSrc.includes("failure summary"),
      "all-failed errors should include a human-readable failure summary"
    );
  });

  test("APIFallbackManager can disable unhealthy providers for bounded replay runs", () => {
    assert.ok(
      fallbackSrc.includes("PINOVEL_DISABLED_PROVIDERS"),
      "should support disabling a known-unhealthy provider without editing model-routing.json"
    );
    assert.ok(
      fallbackSrc.includes("getDisabledProviders"),
      "should parse disabled providers in a dedicated helper"
    );
    assert.ok(
      fallbackSrc.includes("disabledProviders.has"),
      "fallback chain should filter disabled providers before model calls"
    );
  });

  test("totalTimeoutMs is checked before each provider and retry attempt", () => {
    assert.ok(
      fallbackSrc.includes("totalTimeoutMs"),
      "fallback manager should support total timeout budget"
    );
    assert.ok(
      fallbackSrc.includes("chainStartTime"),
      "fallback manager should track chain start time"
    );
    assert.ok(
      fallbackSrc.includes("Fallback chain timeout"),
      "fallback manager should throw timeout error when budget exceeded"
    );
    // Verify timeout is checked in all three methods
    const callWithFallback = extractMethod(fallbackSrc, "callWithFallback");
    const callClaude = extractMethod(fallbackSrc, "callClaudeWithFallback");
    const callGPT = extractMethod(fallbackSrc, "callGPTWithFallback");
    assert.ok(
      callWithFallback.includes("totalTimeoutMs"),
      "callWithFallback should check total timeout"
    );
    assert.ok(
      callClaude.includes("totalTimeoutMs"),
      "callClaudeWithFallback should check total timeout"
    );
    assert.ok(
      callGPT.includes("totalTimeoutMs"),
      "callGPTWithFallback should check total timeout"
    );
  });
});
