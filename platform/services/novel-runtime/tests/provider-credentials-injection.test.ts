import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProviderCredentialsClient } from "../src/provider-credentials.js";
import { makeConfigForTest } from "../src/config.js";

describe("platform provider credential injection", () => {
  const originalKey = process.env.GEMINI_API_KEY;
  const originalBase = process.env.GOOGLE_GEMINI_BASE_URL;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
    else process.env.GOOGLE_GEMINI_BASE_URL = originalBase;
  });

  it("injects the Gemini base URL under the env name used by PiNovelStudio", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GEMINI_BASE_URL;
    const client = createProviderCredentialsClient(makeConfigForTest());

    const result = client.injectIntoEnv([
      {
        providerKey: "gemini",
        apiKey: "gemini-secret",
        apiBaseUrl: "https://gemini-gateway.example/v1",
      },
    ]);

    assert.deepEqual(result.injected, ["GEMINI_API_KEY"]);
    assert.equal(process.env.GEMINI_API_KEY, "gemini-secret");
    assert.equal(
      process.env.GOOGLE_GEMINI_BASE_URL,
      "https://gemini-gateway.example/v1",
    );
  });

  it("maps admin provider keys like gemini-3.7-flash onto GEMINI_API_KEY", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GEMINI_BASE_URL;
    const client = createProviderCredentialsClient(makeConfigForTest());

    const result = client.injectIntoEnv([
      {
        providerKey: "gemini-3.7-flash",
        apiKey: "sk-admin-gemini",
        apiBaseUrl: "https://aimagichub.xyz/v1",
      },
    ]);

    assert.deepEqual(result.injected, ["GEMINI_API_KEY"]);
    assert.equal(process.env.GEMINI_API_KEY, "sk-admin-gemini");
    assert.equal(process.env.GOOGLE_GEMINI_BASE_URL, "https://aimagichub.xyz/v1");
  });

  it("lets platform-admin credentials replace a leftover shell GEMINI_API_KEY", () => {
    process.env.GEMINI_API_KEY = "stale-shell-key";
    const client = createProviderCredentialsClient(
      makeConfigForTest({ providerCredentialsSource: "platform" }),
    );
    const result = client.injectIntoEnv([
      {
        providerKey: "gemini-3.7-flash",
        apiKey: "admin-gemini-key",
        apiBaseUrl: "https://aimagichub.xyz/v1",
      },
    ]);
    assert.deepEqual(result.injected, ["GEMINI_API_KEY"]);
    assert.equal(process.env.GEMINI_API_KEY, "admin-gemini-key");
  });
});
