import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProviderCredentialsClient } from "../src/provider-credentials.js";
import { makeConfigForTest } from "../src/config.js";

describe("platform provider credential injection", () => {
  const originalKey = process.env.GPT_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalBase = process.env.GPT_BASE_URL;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GPT_API_KEY;
    else process.env.GPT_API_KEY = originalKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    if (originalBase === undefined) delete process.env.GPT_BASE_URL;
    else process.env.GPT_BASE_URL = originalBase;
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
});
