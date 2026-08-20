import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertRequiredProviderCredentials,
  ConfigError,
  loadConfig,
  makeConfigForTest,
} from "../src/config.js";

const RUNTIME_ENV_KEYS = [
  "NODE_ENV",
  "NOVEL_TASK_TOKEN_HMAC_KEY",
  "PLATFORM_API_BASE_URL",
  "INTERNAL_API_SECRET",
  "PINOVEL_MODEL_REQUEST_TIMEOUT_MS",
  "PINOVEL_DEV_MODE",
  "NOVEL_REQUIRED_PROVIDER_KEYS",
] as const;

function withRuntimeEnv(
  overrides: Partial<Record<(typeof RUNTIME_ENV_KEYS)[number], string>>,
  action: () => void,
): void {
  const previous = new Map(
    RUNTIME_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  try {
    process.env.NODE_ENV = "test";
    process.env.NOVEL_TASK_TOKEN_HMAC_KEY = "test-task-token-hmac-key";
    process.env.PLATFORM_API_BASE_URL = "http://platform-api.local";
    process.env.INTERNAL_API_SECRET = "test-internal-api-secret";
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("production provider credential gate", () => {
  const originalGemini = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGemini;
  });

  it("rejects a production runtime with no required Gemini credential", () => {
    delete process.env.GEMINI_API_KEY;
    assert.throws(
      () =>
        assertRequiredProviderCredentials(
          makeConfigForTest({
            nodeEnv: "production",
            requiredProviderEnvKeys: ["GEMINI_API_KEY"],
          }),
        ),
      /GEMINI_API_KEY/,
    );
  });

  it("accepts credentials injected from either env or platform", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    assert.doesNotThrow(() =>
      assertRequiredProviderCredentials(
        makeConfigForTest({
          nodeEnv: "production",
          requiredProviderEnvKeys: ["GEMINI_API_KEY"],
        }),
      ),
    );
  });
});

describe("runtime startup configuration", () => {
  it("rejects the development release-gate bypass in production", () => {
    withRuntimeEnv({
      PINOVEL_DEV_MODE: "1",
      NOVEL_REQUIRED_PROVIDER_KEYS: "GEMINI_API_KEY",
    }, () => {
      process.env.NODE_ENV = "production";
      assert.throws(
        () => loadConfig(),
        (err: unknown) => err instanceof ConfigError && err.code === "INVALID_ENV",
      );
    });
  });

  it("rejects a partially parsed model timeout instead of silently changing it", () => {
    withRuntimeEnv({ PINOVEL_MODEL_REQUEST_TIMEOUT_MS: "300ms" }, () => {
      assert.throws(
        () => loadConfig(),
        (err: unknown) => err instanceof ConfigError && err.code === "INVALID_ENV",
      );
    });
  });

  it("rejects a malformed platform API base URL before serving work", () => {
    withRuntimeEnv({ PLATFORM_API_BASE_URL: "not-a-url" }, () => {
      assert.throws(
        () => loadConfig(),
        (err: unknown) => err instanceof ConfigError && err.code === "INVALID_ENV",
      );
    });
  });
});
