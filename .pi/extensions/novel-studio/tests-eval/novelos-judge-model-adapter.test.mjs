/**
 * NovelOS 裁判模型适配器测试（P1-2）
 *
 * 用 mock fetch 测试 judge-model-adapter 的控制流（不调真实 API）。
 *
 * 验证：
 * - loadJudgeModelConfigFromEnv 读取 env 变量，缺失时抛错
 * - maskEndpoint 脱敏 endpoint（只保留 protocol+host）
 * - describeJudgeConfig 不暴露 Key/Auth
 * - callJudgeModel 调用 fetch、解析响应、返回 {text, model, durationMs}
 * - callJudgeModel JSON schema 模式构造 response_format
 * - callJudgeModel 失败时抛错（HTTP error）
 * - spikeJudgeModel 3 阶段探测（/models → chat → json_schema）
 * - spikeJudgeModel 不抛错，所有失败记入 notes
 *
 * 安全验证：
 * - 请求 header 不在日志/返回值中暴露
 * - Authorization header 只含 Bearer 前缀 + key，但 key 不进返回值
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
// novelos/eval/* 模块是 dormant-from-prod（PROD-BUILD-BOUNDARY-1 后退出生产构建），
// 只存在于 dist-eval/novelos/eval/。生产 dist/novelos/ 不含 eval 子目录。
const DIST_ROOT = join(EXTENSION_ROOT, "dist-eval");

const judgeAdapterUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "eval", "judge-model-adapter.js"),
).href;

const {
  loadJudgeModelConfigFromEnv,
  maskEndpoint,
  describeJudgeConfig,
  callJudgeModel,
  spikeJudgeModel,
} = await import(judgeAdapterUrl);

// ============================================================================
// Mock fetch 工具
// ============================================================================

/** 记录所有 fetch 调用，便于断言请求构造 */
let fetchCalls = [];
let originalFetch;

function mockFetch(responses) {
  // responses: Array<{ urlMatch?: RegExp, status?: number, body: unknown }>
  // 无 urlMatch 匹配时用第一个 status 非 200 的或第一个
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    const matched = responses.find(
      (r) => !r.urlMatch || r.urlMatch.test(String(url)),
    );
    const resp = matched ?? responses[0];
    return {
      ok: (resp.status ?? 200) >= 200 && (resp.status ?? 200) < 300,
      status: resp.status ?? 200,
      statusText: resp.statusText ?? "OK",
      text: async () => (typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body)),
      json: async () => resp.body,
    };
  };
}

function restoreFetch() {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
}

// ============================================================================
// 测试
// ============================================================================

describe("NovelOS 裁判模型适配器（P1-2）", () => {
  beforeEach(() => {
    fetchCalls = [];
  });
  afterEach(() => {
    restoreFetch();
  });

  test("loadJudgeModelConfigFromEnv 读取 3 个 env 变量", () => {
    const oldEnv = {
      NOVELOS_JUDGE_API_KEY: process.env.NOVELOS_JUDGE_API_KEY,
      NOVELOS_JUDGE_BASE_URL: process.env.NOVELOS_JUDGE_BASE_URL,
      NOVELOS_JUDGE_MODEL: process.env.NOVELOS_JUDGE_MODEL,
    };
    process.env.NOVELOS_JUDGE_API_KEY = "test-key";
    process.env.NOVELOS_JUDGE_BASE_URL = "https://example.com/v1";
    process.env.NOVELOS_JUDGE_MODEL = "test-model";
    try {
      const config = loadJudgeModelConfigFromEnv();
      assert.equal(config.apiKey, "test-key");
      assert.equal(config.baseUrl, "https://example.com/v1");
      assert.equal(config.model, "test-model");
      assert.ok(config.timeoutMs >= 1000, "timeoutMs 应有默认值");
    } finally {
      for (const [k, v] of Object.entries(oldEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("loadJudgeModelConfigFromEnv 缺失变量时抛错", () => {
    const oldEnv = {
      NOVELOS_JUDGE_API_KEY: process.env.NOVELOS_JUDGE_API_KEY,
      NOVELOS_JUDGE_BASE_URL: process.env.NOVELOS_JUDGE_BASE_URL,
      NOVELOS_JUDGE_MODEL: process.env.NOVELOS_JUDGE_MODEL,
    };
    delete process.env.NOVELOS_JUDGE_API_KEY;
    delete process.env.NOVELOS_JUDGE_BASE_URL;
    delete process.env.NOVELOS_JUDGE_MODEL;
    try {
      assert.throws(
        () => loadJudgeModelConfigFromEnv(),
        /裁判模型 env 未配置/,
      );
    } finally {
      for (const [k, v] of Object.entries(oldEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("maskEndpoint 只保留 protocol+host，不暴露 path", () => {
    assert.equal(
      maskEndpoint("https://shunfen6.win/v1/chat/completions"),
      "https://shunfen6.win",
    );
    assert.equal(
      maskEndpoint("https://example.com/v1"),
      "https://example.com",
    );
    assert.equal(
      maskEndpoint("http://localhost:3000/api"),
      "http://localhost:3000",
    );
    assert.equal(maskEndpoint("invalid-url"), "[invalid-url]");
  });

  test("describeJudgeConfig 不暴露 Key/Auth", () => {
    const config = {
      apiKey: "sk-secret-key-12345",
      baseUrl: "https://shunfen6.win/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 120_000,
    };
    const desc = describeJudgeConfig(config);
    assert.ok(desc.includes("model=gpt-5.6-sol"), "应含 model");
    assert.ok(desc.includes("endpoint=https://shunfen6.win"), "应含脱敏 endpoint");
    assert.ok(desc.includes("timeoutMs=120000"), "应含 timeoutMs");
    assert.ok(!desc.includes("sk-secret-key-12345"), "不得暴露 Key");
    assert.ok(!desc.includes("Bearer"), "不得暴露 Auth header");
  });

  test("callJudgeModel 调用 fetch 并解析响应", async () => {
    mockFetch([
      {
        urlMatch: /chat\/completions/,
        body: {
          model: "gpt-5.6-sol",
          choices: [
            { message: { content: "裁判结果：A 更好" }, finish_reason: "stop" },
          ],
        },
      },
    ]);
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const result = await callJudgeModel(
      config,
      [
        { role: "system", content: "你是裁判" },
        { role: "user", content: "比较 A 和 B" },
      ],
      { temperature: 0.1, maxTokens: 256 },
    );
    assert.equal(result.text, "裁判结果：A 更好");
    assert.equal(result.model, "gpt-5.6-sol");
    assert.ok(result.durationMs >= 0, "durationMs 应非负");

    // 验证请求构造
    assert.equal(fetchCalls.length, 1, "应只调一次 fetch");
    const init = fetchCalls[0].init;
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "gpt-5.6-sol");
    assert.equal(body.temperature, 0.1);
    assert.equal(body.max_tokens, 256);
    assert.equal(body.messages.length, 2);
    assert.ok(!body.response_format, "无 responseFormat 时不设 response_format");
  });

  test("callJudgeModel JSON schema 模式构造 response_format", async () => {
    mockFetch([
      {
        urlMatch: /chat\/completions/,
        body: {
          model: "gpt-5.6-sol",
          choices: [
            { message: { content: '{"winner":"A","reason":"更好"}' }, finish_reason: "stop" },
          ],
        },
      },
    ]);
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const schema = {
      type: "object",
      properties: {
        winner: { type: "string", enum: ["A", "B", "tie"] },
        reason: { type: "string" },
      },
      required: ["winner", "reason"],
      additionalProperties: false,
    };
    const result = await callJudgeModel(
      config,
      [
        { role: "system", content: "输出 JSON" },
        { role: "user", content: "裁决" },
      ],
      { responseFormat: "json_schema", schema, schemaName: "verdict", temperature: 0 },
    );
    assert.ok(result.text.includes('"winner":"A"'), "应返回 JSON 文本");

    const body = JSON.parse(fetchCalls[0].init.body);
    assert.ok(body.response_format, "应设 response_format");
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.name, "verdict");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema, schema);
  });

  test("callJudgeModel JSON schema 缺 schema/schemaName 时抛错", async () => {
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    await assert.rejects(
      callJudgeModel(
        config,
        [{ role: "user", content: "test" }],
        { responseFormat: "json_schema" },
      ),
      /responseFormat=json_schema 需要 schema 和 schemaName/,
    );
  });

  test("callJudgeModel HTTP error 时抛错且不暴露 Key", async () => {
    mockFetch([
      {
        urlMatch: /chat\/completions/,
        status: 401,
        statusText: "Unauthorized",
        body: { error: { message: "Invalid API key" } },
      },
    ]);
    const config = {
      apiKey: "sk-secret-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    await assert.rejects(
      callJudgeModel(config, [
        { role: "user", content: "test" },
      ]),
      /judge API error \(HTTP 401\): Invalid API key/,
    );
    // 请求体不应含 key（key 只在 header）
    const init = fetchCalls[0].init;
    assert.ok(init.headers.Authorization.includes("Bearer sk-secret-key"), "header 应含 Bearer key");
    const bodyStr = init.body;
    assert.ok(!bodyStr.includes("sk-secret-key"), "请求体不得含 key");
  });

  test("spikeJudgeModel 3 阶段探测：全部成功", async () => {
    mockFetch([
      {
        urlMatch: /\/models$/,
        body: { data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.5" }] },
      },
      {
        urlMatch: /chat\/completions$/,
        body: {
          model: "gpt-5.6-sol",
          choices: [{ message: { content: "好" } }],
        },
      },
    ]);
    // 第三次 fetch（json_schema 测试）需要返回 JSON
    // mockFetch 用同一组 responses 循环匹配，chat/completions 匹配第二个
    // 但 json_schema 测试也走 chat/completions，需返回 JSON 文本
    // 重新 mock：chat 端点根据调用顺序返回不同内容
    let chatCallCount = 0;
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      const urlStr = String(url);
      if (urlStr.includes("/models")) {
        return {
          ok: true, status: 200, statusText: "OK",
          text: async () => JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }),
          json: async () => ({ data: [{ id: "gpt-5.6-sol" }] }),
        };
      }
      if (urlStr.includes("chat/completions")) {
        chatCallCount++;
        if (chatCallCount === 1) {
          // 最小 chat 请求
          return {
            ok: true, status: 200, statusText: "OK",
            text: async () => JSON.stringify({ model: "gpt-5.6-sol", choices: [{ message: { content: "好" } }] }),
            json: async () => ({ model: "gpt-5.6-sol", choices: [{ message: { content: "好" } }] }),
          };
        }
        // json_schema 测试
        return {
          ok: true, status: 200, statusText: "OK",
          text: async () => JSON.stringify({ model: "gpt-5.6-sol", choices: [{ message: { content: '{"winner":"A","reason":"更好"}' } }] }),
          json: async () => ({ model: "gpt-5.6-sol", choices: [{ message: { content: '{"winner":"A","reason":"更好"}' } }] }),
        };
      }
      return {
        ok: false, status: 404, statusText: "Not Found",
        text: async () => "Not Found",
        json: async () => ({ error: "Not Found" }),
      };
    };

    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const result = await spikeJudgeModel(config);
    assert.equal(result.available, true, "应 available=true");
    assert.equal(result.modelIdentifier, "gpt-5.6-sol", "应返回 model identifier");
    assert.equal(result.supportsJsonSchema, true, "应 supportsJsonSchema=true");
    assert.ok(result.notes.length >= 3, "应有至少 3 条 notes（每阶段一条）");
  });

  test("spikeJudgeModel 全部失败时不抛错，available=false", async () => {
    globalThis.fetch = async () => {
      throw new Error("Connection refused");
    };
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const result = await spikeJudgeModel(config);
    assert.equal(result.available, false, "应 available=false");
    assert.equal(result.supportsJsonSchema, undefined, "未测试 json_schema");
    assert.ok(result.notes.length >= 1, "应有失败 notes");
    assert.ok(result.notes.some((n) => n.includes("失败")), "应含失败说明");
  });

  test("spikeJudgeModel chat 成功但 json_schema 失败 → supportsJsonSchema=false", async () => {
    let chatCallCount = 0;
    globalThis.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/models")) {
        return {
          ok: false, status: 404, statusText: "Not Found",
          text: async () => "Not Found",
          json: async () => ({ error: "Not Found" }),
        };
      }
      if (urlStr.includes("chat/completions")) {
        chatCallCount++;
        if (chatCallCount === 1) {
          return {
            ok: true, status: 200, statusText: "OK",
            text: async () => JSON.stringify({ model: "gpt-5.6-sol", choices: [{ message: { content: "好" } }] }),
            json: async () => ({ model: "gpt-5.6-sol", choices: [{ message: { content: "好" } }] }),
          };
        }
        // json_schema 测试返回非 JSON
        return {
          ok: true, status: 200, statusText: "OK",
          text: async () => JSON.stringify({ model: "gpt-5.6-sol", choices: [{ message: { content: "这不是 JSON" } }] }),
          json: async () => ({ model: "gpt-5.6-sol", choices: [{ message: { content: "这不是 JSON" } }] }),
        };
      }
      return {
        ok: false, status: 404, statusText: "Not Found",
        text: async () => "Not Found",
        json: async () => ({ error: "Not Found" }),
      };
    };
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const result = await spikeJudgeModel(config);
    assert.equal(result.available, true, "chat 成功 → available=true");
    assert.equal(result.supportsJsonSchema, false, "json_schema 失败 → supportsJsonSchema=false");
    assert.ok(result.notes.some((n) => n.includes("JSON schema")), "应含 json_schema notes");
  });
});
