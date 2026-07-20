/**
 * NB-4.0 BenchmarkCostProfile 测试
 *
 * 验证（纯本地，不调真实模型）：
 * 1. getBenchmarkCostProfile: env 读取（unset/null/valid/invalid）
 * 2. getAuthorizedProviders / isProviderAuthorized: 授权表正确 + 大小写不敏感
 * 3. assertProviderAuthorized: 未激活不强制；未授权 hard block；授权放行
 * 4. shouldDisableFallbackForProfile: package_screening=true，production_validation=false，unset=false
 * 5. filterFallbackChainByProfile: 未激活返回 copy；激活时过滤；空结果抛错；大小写不敏感
 * 6. BenchmarkCostProfileViolation: name/provider/agentName/profile 字段完整
 * 7. emitLLMAttempt trace 标准化: 自动派生 requestedRoute/actualProvider/actualModel
 * 8. callWithFallback / callClaudeWithFallback / callGPTWithFallback 集成:
 *    - 未授权 chain → hard block（抛 BenchmarkCostProfileViolation，不触网）
 *    - package_screening 强制 disableFallback（primary 未授权时即抛错）
 *
 * import 自 dist/api/（生产模块，非 lab-only）。
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  getBenchmarkCostProfile,
  getAuthorizedProviders,
  isProviderAuthorized,
  assertProviderAuthorized,
  shouldDisableFallbackForProfile,
  filterFallbackChainByProfile,
  BenchmarkCostProfileViolation,
} from "../dist/api/benchmark-cost-profile.js";
import {
  APIFallbackManager,
  setLLMAttemptListener,
  emitLLMAttempt,
  clearUnhealthyProviders,
  clearChapterTimeoutCounts,
} from "../dist/api/fallback-manager.js";

// ─────────────────────────────────────────────────────────────────────────────
// env 管理
// ─────────────────────────────────────────────────────────────────────────────

const ENV_KEYS = [
  "PINOVEL_BENCHMARK_COST_PROFILE",
  "PINOVEL_DISABLE_FALLBACK",
  "GLM_API_KEY",
  "DOUBAO_API_KEY",
  "GPT_API_KEY",
  "CLAUDE_API_KEY",
];

const SAVED_ENV = {};

function saveEnv() {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// mock context builder（参考 fallback-timeout-behavioral.test.mjs）
// ─────────────────────────────────────────────────────────────────────────────

function buildMockContext(chain) {
  const providers = {};
  for (const p of chain) {
    const envVar = `${p.toUpperCase()}_API_KEY`;
    providers[p] = {
      name: `Mock ${p}`,
      base_url: "https://example.invalid/v1",
      api_key_env: envVar,
      model: `${p}-test`,
      protocol: "openai",
      temperature: {},
      max_tokens: {},
    };
    // getApiKey(p) 读 real config 的 api_key_env；对 glm/gpt/claude/doubao，
    // real config 映射到 GLM_API_KEY/GPT_API_KEY/CLAUDE_API_KEY/DOUBAO_API_KEY。
    // 这里设非空值确保 apiKey 不为 null（不会因 `!apiKey` continue 静默跳过）。
    process.env[envVar] = "test-key";
  }
  return {
    routing: { provider: chain[0], model: `${chain[0]}-test` },
    primaryProvider: chain[0],
    fallbackChain: [...chain],
    providers,
    retryOptions: {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 1,
      totalTimeoutMs: 5000,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 单元测试 — benchmark-cost-profile 纯函数
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4.0 benchmark-cost-profile unit", () => {
  beforeEach(() => {
    saveEnv();
    delete process.env.PINOVEL_BENCHMARK_COST_PROFILE;
    delete process.env.PINOVEL_DISABLE_FALLBACK;
  });
  afterEach(restoreEnv);

  describe("getBenchmarkCostProfile", () => {
    test("returns null when env unset", () => {
      assert.equal(getBenchmarkCostProfile(), null);
    });
    test("returns 'package_screening' when set", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
      assert.equal(getBenchmarkCostProfile(), "package_screening");
    });
    test("returns 'production_validation' when set", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "production_validation";
      assert.equal(getBenchmarkCostProfile(), "production_validation");
    });
    test("returns null for invalid value (not enforced)", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "invalid";
      assert.equal(getBenchmarkCostProfile(), null);
    });
  });

  describe("getAuthorizedProviders", () => {
    test("package_screening allows glm + doubao only", () => {
      const set = getAuthorizedProviders("package_screening");
      assert.equal(set.has("glm"), true);
      assert.equal(set.has("doubao"), true);
      assert.equal(set.has("gpt"), false);
      assert.equal(set.has("claude"), false);
      assert.equal(set.has("ernie"), false);
    });
    test("production_validation allows gpt + claude only", () => {
      const set = getAuthorizedProviders("production_validation");
      assert.equal(set.has("gpt"), true);
      assert.equal(set.has("claude"), true);
      assert.equal(set.has("glm"), false);
      assert.equal(set.has("doubao"), false);
      assert.equal(set.has("ernie"), false);
    });
  });

  describe("isProviderAuthorized (case-insensitive)", () => {
    test("package_screening: glm/doubao authorized (any case); gpt/claude/ernie not", () => {
      assert.equal(isProviderAuthorized("glm", "package_screening"), true);
      assert.equal(isProviderAuthorized("GLM", "package_screening"), true);
      assert.equal(isProviderAuthorized("Doubao", "package_screening"), true);
      assert.equal(isProviderAuthorized("gpt", "package_screening"), false);
      assert.equal(isProviderAuthorized("claude", "package_screening"), false);
      assert.equal(isProviderAuthorized("ernie", "package_screening"), false);
    });
    test("production_validation: gpt/claude authorized (any case); glm/doubao/ernie not", () => {
      assert.equal(isProviderAuthorized("gpt", "production_validation"), true);
      assert.equal(isProviderAuthorized("GPT", "production_validation"), true);
      assert.equal(isProviderAuthorized("Claude", "production_validation"), true);
      assert.equal(isProviderAuthorized("glm", "production_validation"), false);
      assert.equal(isProviderAuthorized("doubao", "production_validation"), false);
      assert.equal(isProviderAuthorized("ernie", "production_validation"), false);
    });
  });

  describe("assertProviderAuthorized", () => {
    test("no-throw when profile unset (backward compat)", () => {
      delete process.env.PINOVEL_BENCHMARK_COST_PROFILE;
      assert.doesNotThrow(() => assertProviderAuthorized("gpt", "any_agent"));
      assert.doesNotThrow(() => assertProviderAuthorized("claude", "any_agent"));
      assert.doesNotThrow(() => assertProviderAuthorized("ernie", "any_agent"));
      assert.doesNotThrow(() => assertProviderAuthorized("glm", "any_agent"));
    });
    test("no-throw when provider authorized (package_screening + glm/doubao)", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
      assert.doesNotThrow(() => assertProviderAuthorized("glm", "reference_analyzer"));
      assert.doesNotThrow(() => assertProviderAuthorized("doubao", "narrator_primary"));
    });
    test("no-throw when provider authorized (production_validation + gpt/claude)", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "production_validation";
      assert.doesNotThrow(() => assertProviderAuthorized("gpt", "anti_ai_detector"));
      assert.doesNotThrow(() => assertProviderAuthorized("claude", "style_shaper"));
    });
    test("throws BenchmarkCostProfileViolation when package_screening + gpt", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
      assert.throws(
        () => assertProviderAuthorized("gpt", "reference_analyzer"),
        (err) => {
          assert.ok(err instanceof BenchmarkCostProfileViolation);
          assert.equal(err.name, "BenchmarkCostProfileViolation");
          assert.equal(err.provider, "gpt");
          assert.equal(err.agentName, "reference_analyzer");
          assert.equal(err.profile, "package_screening");
          assert.match(err.message, /HARD BLOCK/);
          return true;
        }
      );
    });
    test("throws when package_screening + claude", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
      assert.throws(
        () => assertProviderAuthorized("claude", "style_shaper"),
        (err) => err instanceof BenchmarkCostProfileViolation &&
          err.profile === "package_screening" &&
          err.provider === "claude"
      );
    });
    test("throws when package_screening + ernie", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
      assert.throws(
        () => assertProviderAuthorized("ernie", "narrator_primary"),
        (err) => err instanceof BenchmarkCostProfileViolation
      );
    });
    test("throws when production_validation + glm", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "production_validation";
      assert.throws(
        () => assertProviderAuthorized("glm", "reference_analyzer"),
        (err) => err instanceof BenchmarkCostProfileViolation &&
          err.profile === "production_validation" &&
          err.provider === "glm"
      );
    });
    test("throws when production_validation + doubao", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "production_validation";
      assert.throws(
        () => assertProviderAuthorized("doubao", "narrator_primary"),
        (err) => err instanceof BenchmarkCostProfileViolation
      );
    });
    test("throws when production_validation + ernie", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "production_validation";
      assert.throws(
        () => assertProviderAuthorized("ernie", "narrator_primary"),
        (err) => err instanceof BenchmarkCostProfileViolation
      );
    });
  });

  describe("shouldDisableFallbackForProfile", () => {
    test("false when unset", () => {
      assert.equal(shouldDisableFallbackForProfile(), false);
    });
    test("true for package_screening", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
      assert.equal(shouldDisableFallbackForProfile(), true);
    });
    test("false for production_validation", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "production_validation";
      assert.equal(shouldDisableFallbackForProfile(), false);
    });
  });

  describe("filterFallbackChainByProfile", () => {
    test("returns copy of chain when profile unset (backward compat)", () => {
      const chain = ["glm", "gpt"];
      const result = filterFallbackChainByProfile(chain, "architect");
      assert.deepEqual(result, ["glm", "gpt"]);
      assert.notEqual(result, chain); // must be a new array, not same ref
    });
    test("package_screening keeps only glm/doubao", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
      const result = filterFallbackChainByProfile(
        ["gpt", "glm", "claude", "doubao"],
        "architect"
      );
      assert.deepEqual(result, ["glm", "doubao"]);
    });
    test("production_validation keeps only gpt/claude", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "production_validation";
      const result = filterFallbackChainByProfile(
        ["glm", "gpt", "doubao", "claude"],
        "architect"
      );
      assert.deepEqual(result, ["gpt", "claude"]);
    });
    test("throws BenchmarkCostProfileViolation when chain becomes empty", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
      assert.throws(
        () => filterFallbackChainByProfile(["gpt", "claude"], "architect"),
        (err) => {
          assert.ok(err instanceof BenchmarkCostProfileViolation);
          assert.equal(err.profile, "package_screening");
          return true;
        }
      );
    });
    test("production_validation: chain=[glm, doubao] throws (no authorized provider)", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "production_validation";
      assert.throws(
        () => filterFallbackChainByProfile(["glm", "doubao"], "architect"),
        (err) => err instanceof BenchmarkCostProfileViolation
      );
    });
    test("empty input → empty output (no throw, edge case)", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
      const result = filterFallbackChainByProfile([], "architect");
      assert.deepEqual(result, []);
    });
    test("case-insensitive matching", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
      const result = filterFallbackChainByProfile(
        ["GLM", "Doubao", "GPT"],
        "architect"
      );
      assert.deepEqual(result, ["GLM", "Doubao"]);
    });
  });

  describe("BenchmarkCostProfileViolation", () => {
    test("has correct name and fields", () => {
      process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
      try {
        assertProviderAuthorized("gpt", "reference_analyzer");
        assert.fail("should have thrown");
      } catch (err) {
        assert.ok(err instanceof BenchmarkCostProfileViolation);
        assert.ok(err instanceof Error);
        assert.equal(err.name, "BenchmarkCostProfileViolation");
        assert.equal(err.provider, "gpt");
        assert.equal(err.agentName, "reference_analyzer");
        assert.equal(err.profile, "package_screening");
        assert.ok(err.message.length > 0);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. emitLLMAttempt trace 标准化
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4.0 emitLLMAttempt trace standardization", () => {
  beforeEach(() => {
    saveEnv();
    delete process.env.PINOVEL_BENCHMARK_COST_PROFILE;
  });
  afterEach(() => {
    setLLMAttemptListener(null);
    restoreEnv();
  });

  test("derives requestedRoute/actualProvider/actualModel from agent/provider/model", () => {
    const captured = [];
    setLLMAttemptListener((entry) => captured.push(entry));
    emitLLMAttempt({
      timestamp: new Date().toISOString(),
      agent: "reference_analyzer",
      provider: "glm",
      model: "glm-4.6",
      attempt: 1,
      elapsedMs: 100,
      status: "ok",
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].requestedRoute, "reference_analyzer");
    assert.equal(captured[0].actualProvider, "glm");
    assert.equal(captured[0].actualModel, "glm-4.6");
  });

  test("preserves explicit requestedRoute/actualProvider/actualModel when provided", () => {
    const captured = [];
    setLLMAttemptListener((entry) => captured.push(entry));
    emitLLMAttempt({
      timestamp: new Date().toISOString(),
      agent: "narrator_primary",
      provider: "doubao",
      model: "doubao-seed-2-1",
      attempt: 1,
      elapsedMs: 100,
      status: "ok",
      requestedRoute: "narrator_testing_gpt",
      actualProvider: "gpt",
      actualModel: "gpt-5.5",
    });
    assert.equal(captured[0].requestedRoute, "narrator_testing_gpt");
    assert.equal(captured[0].actualProvider, "gpt");
    assert.equal(captured[0].actualModel, "gpt-5.5");
    // 原始字段也保留
    assert.equal(captured[0].agent, "narrator_primary");
    assert.equal(captured[0].provider, "doubao");
  });

  test("null listener does not throw", () => {
    setLLMAttemptListener(null);
    assert.doesNotThrow(() => {
      emitLLMAttempt({
        timestamp: new Date().toISOString(),
        agent: "x",
        provider: "y",
        model: "z",
        attempt: 1,
        elapsedMs: 1,
        status: "ok",
      });
    });
  });

  test("listener throwing does not propagate (observation layer isolated)", () => {
    setLLMAttemptListener(() => {
      throw new Error("listener boom");
    });
    assert.doesNotThrow(() => {
      emitLLMAttempt({
        timestamp: new Date().toISOString(),
        agent: "x",
        provider: "y",
        model: "z",
        attempt: 1,
        elapsedMs: 1,
        status: "ok",
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. callWithFallback 集成 — cost profile hard block
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4.0 callWithFallback cost profile integration", () => {
  beforeEach(() => {
    saveEnv();
    delete process.env.PINOVEL_BENCHMARK_COST_PROFILE;
    delete process.env.PINOVEL_DISABLE_FALLBACK;
    clearUnhealthyProviders();
    clearChapterTimeoutCounts();
  });
  afterEach(restoreEnv);

  test("package_screening + chain=[gpt] hard-blocks before network call", async () => {
    process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
    const manager = new APIFallbackManager();
    manager.loadFallbackContext = async () => buildMockContext(["gpt"]);
    manager.makeOpenAIChatCall = async () => {
      throw new Error("mock transport error (offline)");
    };
    await assert.rejects(
      () => manager.callWithFallback("architect", [{ role: "user", content: "hi" }]),
      (err) => {
        assert.ok(err instanceof BenchmarkCostProfileViolation);
        assert.equal(err.profile, "package_screening");
        return true;
      }
    );
  });

  test("package_screening + chain=[gpt, claude] hard-blocks (no authorized provider)", async () => {
    process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
    const manager = new APIFallbackManager();
    manager.loadFallbackContext = async () => buildMockContext(["gpt", "claude"]);
    await assert.rejects(
      () => manager.callWithFallback("architect", [{ role: "user", content: "hi" }]),
      (err) => err instanceof BenchmarkCostProfileViolation
    );
  });

  test("production_validation + chain=[glm, doubao] hard-blocks", async () => {
    process.env.PINOVEL_BENCHMARK_COST_PROFILE = "production_validation";
    const manager = new APIFallbackManager();
    manager.loadFallbackContext = async () => buildMockContext(["glm", "doubao"]);
    await assert.rejects(
      () => manager.callWithFallback("architect", [{ role: "user", content: "hi" }]),
      (err) => {
        assert.ok(err instanceof BenchmarkCostProfileViolation);
        assert.equal(err.profile, "production_validation");
        return true;
      }
    );
  });

  test("package_screening forces disableFallback: primary=gpt → hard-blocks even with glm in chain", async () => {
    // 关键断言：disableFallback 限制 chain 到 [primary=gpt]，profile 过滤掉 gpt → 抛错。
    // 若 disableFallback 未生效，chain=[gpt, glm] 会过滤为 [glm]，glm 会进入网络调用
    // （example.invalid 抛网络错误，不是 BenchmarkCostProfileViolation）。
    // 因此本测试能区分 "disableFallback 生效" 与 "未生效"。
    process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
    // 显式不设 PINOVEL_DISABLE_FALLBACK，验证 profile 自身触发 disableFallback
    delete process.env.PINOVEL_DISABLE_FALLBACK;
    const manager = new APIFallbackManager();
    manager.loadFallbackContext = async () => buildMockContext(["gpt", "glm"]);
    await assert.rejects(
      () => manager.callWithFallback("architect", [{ role: "user", content: "hi" }]),
      (err) => {
        assert.ok(err instanceof BenchmarkCostProfileViolation);
        assert.equal(err.provider, "gpt");
        return true;
      }
    );
  });

  test("profile unset → no hard block (backward compat, falls through to network error)", async () => {
    // 未激活 cost profile 时不应抛 BenchmarkCostProfileViolation。
    // Mock transport 避免真实网络调用（离线、无费用、不依赖外部配置）。
    delete process.env.PINOVEL_BENCHMARK_COST_PROFILE;
    delete process.env.PINOVEL_DISABLE_FALLBACK;
    const manager = new APIFallbackManager();
    manager.loadFallbackContext = async () => buildMockContext(["gpt"]);
    manager.makeOpenAIChatCall = async () => {
      throw new Error("mock transport error (offline)");
    };
    await assert.rejects(
      () => manager.callWithFallback("architect", [{ role: "user", content: "hi" }]),
      (err) => !(err instanceof BenchmarkCostProfileViolation)
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. callClaudeWithFallback / callGPTWithFallback 集成
//    （验证 replace_all 同时修改了两个方法）
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-4.0 callClaudeWithFallback / callGPTWithFallback cost profile integration", () => {
  beforeEach(() => {
    saveEnv();
    delete process.env.PINOVEL_BENCHMARK_COST_PROFILE;
    delete process.env.PINOVEL_DISABLE_FALLBACK;
    clearUnhealthyProviders();
    clearChapterTimeoutCounts();
  });
  afterEach(restoreEnv);

  test("callClaudeWithFallback: package_screening + chain=[gpt] hard-blocks", async () => {
    process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
    const manager = new APIFallbackManager();
    manager.loadFallbackContext = async () => buildMockContext(["gpt"]);
    manager.makeOpenAIChatCall = async () => {
      throw new Error("mock transport error (offline)");
    };
    await assert.rejects(
      () =>
        manager.callClaudeWithFallback("architect", [
          { role: "user", content: "hi" },
        ]),
      (err) => err instanceof BenchmarkCostProfileViolation
    );
  });

  test("callGPTWithFallback: package_screening + chain=[gpt] hard-blocks", async () => {
    process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
    const manager = new APIFallbackManager();
    manager.loadFallbackContext = async () => buildMockContext(["gpt"]);
    manager.makeOpenAIChatCall = async () => {
      throw new Error("mock transport error (offline)");
    };
    await assert.rejects(
      () =>
        manager.callGPTWithFallback("architect", [
          { role: "user", content: "hi" },
        ]),
      (err) => err instanceof BenchmarkCostProfileViolation
    );
  });

  test("callClaudeWithFallback: production_validation + chain=[glm] hard-blocks", async () => {
    process.env.PINOVEL_BENCHMARK_COST_PROFILE = "production_validation";
    const manager = new APIFallbackManager();
    manager.loadFallbackContext = async () => buildMockContext(["glm"]);
    await assert.rejects(
      () =>
        manager.callClaudeWithFallback("architect", [
          { role: "user", content: "hi" },
        ]),
      (err) => err instanceof BenchmarkCostProfileViolation
    );
  });

  test("callGPTWithFallback: production_validation + chain=[doubao] hard-blocks", async () => {
    process.env.PINOVEL_BENCHMARK_COST_PROFILE = "production_validation";
    const manager = new APIFallbackManager();
    manager.loadFallbackContext = async () => buildMockContext(["doubao"]);
    await assert.rejects(
      () =>
        manager.callGPTWithFallback("architect", [
          { role: "user", content: "hi" },
        ]),
      (err) => err instanceof BenchmarkCostProfileViolation
    );
  });
});
