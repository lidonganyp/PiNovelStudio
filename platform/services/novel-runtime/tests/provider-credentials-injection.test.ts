import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProviderCredentialsClient } from "../src/provider-credentials.js";
import { makeConfigForTest } from "../src/config.js";

describe("platform provider credential injection", () => {
  const originalKey = process.env.GPT_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalBase = process.env.GPT_BASE_URL;
  const originalGeminiBase = process.env.GOOGLE_GEMINI_BASE_URL;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GPT_API_KEY;
    else process.env.GPT_API_KEY = originalKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    if (originalBase === undefined) delete process.env.GPT_BASE_URL;
    else process.env.GPT_BASE_URL = originalBase;
    if (originalGeminiBase === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
    else process.env.GOOGLE_GEMINI_BASE_URL = originalGeminiBase;
  });

  it("injects the GPT base URL under the env name used by PiNovelStudio", () => {
    delete process.env.GPT_API_KEY;
    delete process.env.GPT_BASE_URL;
    const client = createProviderCredentialsClient(makeConfigForTest());

    const result = client.injectIntoEnv([
      {
        providerKey: "gpt",
        apiKey: "gpt-secret",
        apiBaseUrl: "https://gpt-gateway.example/v1",
      },
    ]);

    assert.deepEqual(result.injected, ["GPT_API_KEY"]);
    assert.equal(process.env.GPT_API_KEY, "gpt-secret");
    assert.equal(
      process.env.GPT_BASE_URL,
      "https://gpt-gateway.example/v1",
    );
  });

  it("maps admin provider keys like gpt-6-astra onto GPT_API_KEY", () => {
    delete process.env.GPT_API_KEY;
    delete process.env.GPT_BASE_URL;
    const client = createProviderCredentialsClient(makeConfigForTest());

    const result = client.injectIntoEnv([
      {
        providerKey: "gpt-6-astra",
        apiKey: "sk-admin-gpt",
        apiBaseUrl: "https://shunfen6.win/v1",
      },
    ]);

    assert.deepEqual(result.injected, ["GPT_API_KEY"]);
    assert.equal(process.env.GPT_API_KEY, "sk-admin-gpt");
    assert.equal(process.env.GPT_BASE_URL, "https://shunfen6.win/v1");
  });

  it("lets platform-admin credentials replace a leftover shell GPT_API_KEY", () => {
    process.env.GPT_API_KEY = "stale-shell-key";
    const client = createProviderCredentialsClient(
      makeConfigForTest({ providerCredentialsSource: "platform" }),
    );
    const result = client.injectIntoEnv([
      {
        providerKey: "gpt-6-astra",
        apiKey: "admin-gpt-key",
        apiBaseUrl: "https://shunfen6.win/v1",
      },
    ]);
    assert.deepEqual(result.injected, ["GPT_API_KEY"]);
    assert.equal(process.env.GPT_API_KEY, "admin-gpt-key");
  });

  it("keeps the unified gemini writer key same-source when platform credentials differ", () => {
    // WRITER-ENV-UNIFY：统一入口已注入 GEMINI_API_KEY 时，platform 模式的 DB
    // 凭证不得覆盖（避免"统一地址 + DB 密钥"混合鉴权）；三变量保持同一来源。
    process.env.GEMINI_API_KEY = "unified-writer-key";
    delete process.env.GOOGLE_GEMINI_BASE_URL;
    const client = createProviderCredentialsClient(
      makeConfigForTest({ providerCredentialsSource: "platform" }),
    );
    const result = client.injectIntoEnv([
      {
        providerKey: "gemini",
        apiKey: "db-different-key",
        apiBaseUrl: "https://db-different.example/v1",
      },
    ]);
    assert.deepEqual(result.skipped, ["GEMINI_API_KEY"]);
    assert.equal(process.env.GEMINI_API_KEY, "unified-writer-key");
    // 整条 gemini 凭证被跳过：地址也不得来自 DB（保持统一来源）
    assert.equal(process.env.GOOGLE_GEMINI_BASE_URL, undefined);
  });

  it("injects platform gemini credentials when the unified env key is absent", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GEMINI_BASE_URL;
    const client = createProviderCredentialsClient(
      makeConfigForTest({ providerCredentialsSource: "platform" }),
    );
    const result = client.injectIntoEnv([
      {
        providerKey: "gemini",
        apiKey: "db-managed-key",
        apiBaseUrl: "https://db-managed.example/v1",
      },
    ]);
    // 统一入口未注入时仍可用平台 DB 凭证（非混合：密钥与地址同批注入）
    assert.deepEqual(result.injected, ["GEMINI_API_KEY"]);
    assert.equal(process.env.GEMINI_API_KEY, "db-managed-key");
    assert.equal(process.env.GOOGLE_GEMINI_BASE_URL, "https://db-managed.example/v1");
  });
});
