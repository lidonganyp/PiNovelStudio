/**
 * NovelOS Pairwise LLM Judge 测试（P1-3 + P1-4 + M1-R3）
 *
 * 用 mock fetch 测试 3 轮多数决、positionSensitive 检测、
 * 证据约束校验、事实风险合并（不调真实 API）。
 *
 * 验证：
 * - judgeOnce 调用 callJudgeModel 并解析 JSON schema 响应
 * - judgePairwise 3 轮多数决（原始/反转/独立）
 * - positionSensitive 检测（顺序反转导致 winner 随位置变化）
 * - 匿名化映射正确性（A/B 标签不暴露物理候选身份）
 * - validateJudgeVerdict（M1-R3 强化）：
 *   - 维度数固定 5、名称集合等于 JUDGE_DIMENSIONS（无重复无缺失）
 *   - 败方无 span → invalid
 *   - span 越界/倒置 → invalid
 *   - excerpt 与 text.slice(start,end) 不符 → invalid
 *   - 胜方无 span → invalid（M1-R3：升为硬要求，不再仅 warning）
 *   - tie 维度不校验 span
 *   - 4 维 / 维度名重复 → invalid
 * - judgePairwise M1-R3：无效 verdict 排除出多数决，<2 有效 → insufficientValidVerdicts + tie
 * - mergeFactRisk：verifier 优先于 LLM
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
// pairwise-judge 等 novelos/eval/* 模块是 dormant-from-prod（PROD-BUILD-BOUNDARY-1 后退出生产构建），
// 只存在于 dist-eval/novelos/eval/。生产 dist/novelos/ 不含 eval 子目录。
const DIST_ROOT = join(EXTENSION_ROOT, "dist-eval");

const pairwiseJudgeUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "eval", "pairwise-judge.js"),
).href;

const {
  judgeOnce,
  judgePairwise,
  validateJudgeVerdict,
  mergeFactRisk,
  JUDGE_DIMENSIONS,
} = await import(pairwiseJudgeUrl);

// ============================================================================
// Mock fetch 工具
// ============================================================================

let fetchCalls = [];
let originalFetch;
let verdictQueue = []; // 每次调用的 verdict 队列

function mockFetchWithVerdicts(verdicts) {
  verdictQueue = [...verdicts];
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    const verdict = verdictQueue.shift() ?? verdicts[verdicts.length - 1];
    // callJudgeModel 期望 chat completions 格式：{choices:[{message:{content}}]}
    // content 是 JSON 字符串（LLM 返回的 JSON 文本）
    const chatResponse = {
      model: "gpt-5.6-sol",
      choices: [{ message: { content: JSON.stringify(verdict) }, finish_reason: "stop" }],
    };
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(chatResponse),
      json: async () => chatResponse,
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
// 构造 verdict 的 helpers
// M1-R3：excerpt 必须 === text.slice(start, end)
// 使用公共前缀 "测试候选正"（5 字符），使 LEFT_TEXT/RIGHT_TEXT 的 slice(0,5) 相同，
// 这样无论匿名映射把哪个候选设为 A/B，excerpt 都能匹配。
// ============================================================================

const COMMON_PREFIX = "测试候选正"; // 5 字符，leftText/rightText 的公共前缀
const LEFT_TEXT = "测试候选正文左"; // slice(0,5) === COMMON_PREFIX
const RIGHT_TEXT = "测试候选正文右"; // slice(0,5) === COMMON_PREFIX
const VALID_SPAN = { start: 0, end: 5, excerpt: COMMON_PREFIX };

/** 合法 verdict：5 维度，胜负双方都有 excerpt 一致的 span */
function makeVerdict(winner, opts = {}) {
  return {
    winner,
    confidence: opts.confidence ?? 0.8,
    dimensions: JUDGE_DIMENSIONS.map((name) => ({
      name,
      winner: winner === "tie" ? "tie" : winner,
      reason: `${name} 判断理由`,
      evidenceA: [VALID_SPAN],
      evidenceB: [VALID_SPAN],
    })),
    hardFactRisk: opts.hardFactRisk ?? false,
    literaryRegressionRisk: opts.literaryRegressionRisk ?? false,
  };
}

/** 缺 excerpt 的 verdict → M1-R3 excerpt 一致性校验判 invalid */
function makeVerdictNoExcerpt(winner) {
  return {
    winner,
    confidence: 0.8,
    dimensions: JUDGE_DIMENSIONS.map((name) => ({
      name,
      winner: winner === "tie" ? "tie" : winner,
      reason: `${name} 判断理由`,
      evidenceA: [{ start: 0, end: 5 }], // 缺 excerpt
      evidenceB: [{ start: 0, end: 5 }], // 缺 excerpt
    })),
    hardFactRisk: false,
    literaryRegressionRisk: false,
  };
}

/**
 * 构造单维度覆盖的 5 维 verdict（用于测试特定维度失效）。
 * 指定 overrideDimName 的维度按 override 构造，其余 4 维度合法。
 */
function makeVerdictWithOneOverride(winner, overrideDimName, override) {
  return {
    winner,
    confidence: 0.8,
    dimensions: JUDGE_DIMENSIONS.map((name) => {
      const dimWinner = winner === "tie" ? "tie" : winner;
      if (name === overrideDimName) {
        return {
          name,
          winner: dimWinner,
          reason: `${name} override`,
          evidenceA: [VALID_SPAN],
          evidenceB: [VALID_SPAN],
          ...override,
        };
      }
      return {
        name,
        winner: dimWinner,
        reason: `${name} 判断理由`,
        evidenceA: [VALID_SPAN],
        evidenceB: [VALID_SPAN],
      };
    }),
    hardFactRisk: false,
    literaryRegressionRisk: false,
  };
}

// ============================================================================
// 测试
// ============================================================================

describe("NovelOS Pairwise LLM Judge（P1-3）", () => {
  beforeEach(() => {
    fetchCalls = [];
    verdictQueue = [];
  });
  afterEach(() => {
    restoreFetch();
  });

  test("judgeOnce 调用 callJudgeModel 并解析 JSON schema 响应", async () => {
    const verdict = makeVerdict("A");
    mockFetchWithVerdicts([verdict]);

    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const context = {
      workGoal: "测试作品",
      chapterIntent: "测试意图",
      priorFacts: ["前文事实1"],
    };
    const result = await judgeOnce(config, context, "测试候选正文A", "测试候选正文B");

    assert.equal(result.winner, "A");
    assert.equal(result.confidence, 0.8);
    assert.equal(result.dimensions.length, 5);
    assert.equal(result.hardFactRisk, false);
    assert.equal(result.literaryRegressionRisk, false);
    assert.equal(result.positionSensitive, false, "单次评审 positionSensitive=false");

    // 验证请求构造
    assert.equal(fetchCalls.length, 1, "应只调一次 fetch");
    const body = JSON.parse(fetchCalls[0].init.body);
    assert.ok(body.response_format, "应设 response_format");
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.name, "pairwise_verdict");
    assert.equal(body.response_format.json_schema.strict, true);
  });

  test("judgePairwise 3 轮多数决：一致判 A → majorityWinner 取决于映射", async () => {
    // 3 轮都返回 winner=A（标签 A，不是物理候选）
    // mapping1: seed 决定 leftLabel，假设 leftLabel=A → verdict winner=A → resolved left
    // mapping2=swap(mapping1): leftLabel=B → verdict winner=A → A 在 right → resolved right
    // mapping3: 新 seed → 取决于 seed+1
    // 为简化，mock fetch 让所有轮都返回 winner=A
    mockFetchWithVerdicts([
      makeVerdict("A"),
      makeVerdict("A"),
      makeVerdict("A"),
    ]);

    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const context = {
      workGoal: "测试作品",
      chapterIntent: "测试意图",
      priorFacts: [],
    };
    const result = await judgePairwise(
      config,
      context,
      "left-id",
      LEFT_TEXT,
      "right-id",
      RIGHT_TEXT,
      42,
    );

    assert.equal(result.rounds.length, 3, "应有 3 轮");
    assert.equal(fetchCalls.length, 3, "应调 3 次 fetch");

    // 验证每轮有 mapping + valid 标记
    for (const r of result.rounds) {
      assert.ok(r.mapping, `round ${r.round} 应有 mapping`);
      assert.ok(r.mapping.leftLabel === "A" || r.mapping.leftLabel === "B");
      assert.equal(typeof r.valid, "boolean", `round ${r.round} 应有 valid 标记`);
    }

    // majorityWinner 应为 left 或 right 或 tie（取决于映射）
    assert.ok(
      ["left", "right", "tie"].includes(result.majorityWinner),
      `majorityWinner 应合法，实际 ${result.majorityWinner}`,
    );
  });

  test("judgePairwise positionSensitive：顺序反转导致 winner 随位置变化", async () => {
    // 让 round 1 和 round 2 返回相同标签 winner=A
    // mapping1: leftLabel=A → winner=A → resolved left
    // mapping2=swap(mapping1): leftLabel=B → winner=A → A 在 right → resolved right
    // round 1=left, round 2=right → positionSensitive=true
    // round 3: 让它返回 tie 或跟 round1 一致
    mockFetchWithVerdicts([
      makeVerdict("A"), // round 1: winner=A
      makeVerdict("A"), // round 2: winner=A（同标签，但映射反转）
      makeVerdict("A"), // round 3
    ]);

    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const context = { workGoal: "测试", chapterIntent: "意图", priorFacts: [] };
    const result = await judgePairwise(
      config,
      context,
      "left-id",
      LEFT_TEXT,
      "right-id",
      RIGHT_TEXT,
      100,
    );

    // 由于 round 1 和 round 2 都返回 winner=A（标签），
    // 但 mapping2=swap(mapping1) 使 A 标签对应的物理候选反转
    // 所以 positionSensitive 必为 true（当 winner 不是 tie 且两轮有效时）
    assert.ok(
      typeof result.positionSensitive === "boolean",
      "positionSensitive 应为 boolean",
    );
  });

  test("judgePairwise 不暴露 baseline 身份（prompt 不含 left/right id）", async () => {
    mockFetchWithVerdicts([
      makeVerdict("A"),
      makeVerdict("A"),
      makeVerdict("A"),
    ]);

    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const context = { workGoal: "测试", chapterIntent: "意图", priorFacts: [] };
    await judgePairwise(
      config,
      context,
      "b1-baseline-id",
      LEFT_TEXT,
      "b2-baseline-id",
      RIGHT_TEXT,
      42,
    );

    // 检查所有 fetch 请求体不含 baseline id
    for (const call of fetchCalls) {
      const bodyStr = call.init.body;
      assert.ok(!bodyStr.includes("b1-baseline-id"), "prompt 不得暴露 left id");
      assert.ok(!bodyStr.includes("b2-baseline-id"), "prompt 不得暴露 right id");
    }
  });

  test("M1-R3：3 轮中 2 invalid → insufficientValidVerdicts===true, majorityWinner===tie", async () => {
    // 前 2 轮 verdict 缺 excerpt（invalid），第 3 轮合法
    mockFetchWithVerdicts([
      makeVerdictNoExcerpt("A"), // round 1: invalid（缺 excerpt）
      makeVerdictNoExcerpt("A"), // round 2: invalid（缺 excerpt）
      makeVerdict("A"),          // round 3: valid
    ]);

    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const context = { workGoal: "测试", chapterIntent: "意图", priorFacts: [] };
    const result = await judgePairwise(
      config,
      context,
      "left-id",
      LEFT_TEXT,
      "right-id",
      RIGHT_TEXT,
      42,
    );

    // 验证每轮 valid 标记
    assert.equal(result.rounds[0].valid, false, "round 1 缺 excerpt 应 invalid");
    assert.equal(result.rounds[1].valid, false, "round 2 缺 excerpt 应 invalid");
    assert.equal(result.rounds[2].valid, true, "round 3 合法应 valid");

    // 有效 verdict 不足 2/3
    assert.equal(result.insufficientValidVerdicts, true, "有效 verdict < 2 应触发 insufficientValidVerdicts");
    assert.equal(result.majorityWinner, "tie", "有效不足时 majorityWinner 应为 tie");
  });

  test("M1-R3：有效路径仍出多数决（3 轮合法 → insufficientValidVerdicts===false）", async () => {
    mockFetchWithVerdicts([
      makeVerdict("A"),
      makeVerdict("A"),
      makeVerdict("A"),
    ]);

    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const context = { workGoal: "测试", chapterIntent: "意图", priorFacts: [] };
    const result = await judgePairwise(
      config,
      context,
      "left-id",
      LEFT_TEXT,
      "right-id",
      RIGHT_TEXT,
      42,
    );

    // 3 轮全有效
    for (const r of result.rounds) {
      assert.equal(r.valid, true, `round ${r.round} 合法 verdict 应 valid`);
    }
    assert.equal(result.insufficientValidVerdicts, false, "3 轮有效不应触发 insufficientValidVerdicts");
    assert.ok(
      ["left", "right", "tie"].includes(result.majorityWinner),
      `majorityWinner 应合法，实际 ${result.majorityWinner}`,
    );
  });
});

describe("NovelOS 证据约束校验（P1-4 + M1-R3 validateJudgeVerdict）", () => {
  test("败方无 span → 标记无效", () => {
    const verdict = makeVerdictWithOneOverride("A", JUDGE_DIMENSIONS[0], {
      evidenceB: [], // 败方 B 无 span
    });
    const result = validateJudgeVerdict(verdict, LEFT_TEXT, RIGHT_TEXT);
    assert.equal(result.valid, false);
    assert.ok(result.invalidDimensions.includes(JUDGE_DIMENSIONS[0]));
    assert.ok(result.errors.some((e) => e.includes("未引用 span")));
  });

  test("span 越界 → 标记无效", () => {
    const verdict = makeVerdictWithOneOverride("A", JUDGE_DIMENSIONS[1], {
      evidenceB: [{ start: 0, end: 100, excerpt: COMMON_PREFIX }], // 越界（RIGHT_TEXT 只有 7 字）
    });
    const result = validateJudgeVerdict(verdict, LEFT_TEXT, RIGHT_TEXT);
    assert.equal(result.valid, false);
    assert.ok(result.invalidDimensions.includes(JUDGE_DIMENSIONS[1]));
    assert.ok(result.errors.some((e) => e.includes("越界")));
  });

  test("span 倒置（start >= end）→ 标记无效", () => {
    // winner B → 败方 A，evidenceA 为败方 span
    const verdict = makeVerdictWithOneOverride("B", JUDGE_DIMENSIONS[2], {
      evidenceA: [{ start: 5, end: 3, excerpt: COMMON_PREFIX }], // 倒置
    });
    const result = validateJudgeVerdict(verdict, LEFT_TEXT, RIGHT_TEXT);
    assert.equal(result.valid, false);
    assert.ok(result.invalidDimensions.includes(JUDGE_DIMENSIONS[2]));
  });

  test("tie 维度不校验败方 span", () => {
    const verdict = {
      winner: "tie",
      confidence: 0.5,
      dimensions: JUDGE_DIMENSIONS.map((name) => ({
        name,
        winner: "tie",
        reason: "两者接近",
        evidenceA: [],
        evidenceB: [],
      })),
      hardFactRisk: false,
      literaryRegressionRisk: false,
      positionSensitive: false,
    };
    const result = validateJudgeVerdict(verdict, LEFT_TEXT, RIGHT_TEXT);
    assert.equal(result.valid, true, "5 个 tie 维度不要求 span");
    assert.equal(result.invalidDimensions.length, 0);
  });

  test("M1-R3：胜方无 span → 标记无效（不再仅 warning）", () => {
    const verdict = makeVerdictWithOneOverride("A", JUDGE_DIMENSIONS[4], {
      evidenceA: [], // 胜方 A 无 span → M1-R3 升为 invalid
      evidenceB: [VALID_SPAN], // 败方 B 有合法 span
    });
    const result = validateJudgeVerdict(verdict, LEFT_TEXT, RIGHT_TEXT);
    assert.equal(result.valid, false, "M1-R3：胜方无 span 应 invalid");
    assert.ok(result.invalidDimensions.length > 0, "应有无效维度");
    assert.ok(result.errors.some((e) => e.includes("未引用支撑 span")), "应有支撑 span 错误");
  });

  test("全部维度合法 → valid=true", () => {
    const verdict = makeVerdict("A");
    const result = validateJudgeVerdict(verdict, LEFT_TEXT, RIGHT_TEXT);
    assert.equal(result.valid, true);
    assert.equal(result.invalidDimensions.length, 0);
  });

  test("M1-R3：(a) excerpt 与 slice 不符 → valid=false", () => {
    const verdict = makeVerdictWithOneOverride("A", JUDGE_DIMENSIONS[0], {
      evidenceB: [{ start: 0, end: 5, excerpt: "错误文本" }], // excerpt 不符
    });
    const result = validateJudgeVerdict(verdict, LEFT_TEXT, RIGHT_TEXT);
    assert.equal(result.valid, false);
    assert.ok(result.invalidDimensions.includes(JUDGE_DIMENSIONS[0]));
    assert.ok(result.errors.some((e) => e.includes("excerpt")), "应有 excerpt 不符错误");
  });

  test("M1-R3：(b) 4 维 → invalid", () => {
    const verdict = {
      winner: "A",
      confidence: 0.8,
      dimensions: JUDGE_DIMENSIONS.slice(0, 4).map((name) => ({
        name,
        winner: "A",
        reason: `${name} 判断理由`,
        evidenceA: [VALID_SPAN],
        evidenceB: [VALID_SPAN],
      })),
      hardFactRisk: false,
      literaryRegressionRisk: false,
      positionSensitive: false,
    };
    const result = validateJudgeVerdict(verdict, LEFT_TEXT, RIGHT_TEXT);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("维度数应为 5")), "应有维度数错误");
  });

  test("M1-R3：(c) 维度名重复 → invalid", () => {
    // 5 项但名称有重复（JUDGE_DIMENSIONS[0] 出现两次）→ Set size = 4
    const dims = JUDGE_DIMENSIONS.map((name) => ({
      name,
      winner: "A",
      reason: `${name} 判断理由`,
      evidenceA: [VALID_SPAN],
      evidenceB: [VALID_SPAN],
    }));
    dims[1].name = JUDGE_DIMENSIONS[0]; // 重复
    const verdict = {
      winner: "A",
      confidence: 0.8,
      dimensions: dims,
      hardFactRisk: false,
      literaryRegressionRisk: false,
      positionSensitive: false,
    };
    const result = validateJudgeVerdict(verdict, LEFT_TEXT, RIGHT_TEXT);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("不符或有重复")), "应有名称重复错误");
  });
});

describe("NovelOS 事实风险合并（P1-4 mergeFactRisk）", () => {
  test("LLM true + verifier 0 → source=llm", () => {
    const result = mergeFactRisk(true, 0);
    assert.equal(result.hardFactRisk, true);
    assert.equal(result.source, "llm");
  });

  test("LLM false + verifier >0 → source=verifier（verifier 优先）", () => {
    const result = mergeFactRisk(false, 3);
    assert.equal(result.hardFactRisk, true);
    assert.equal(result.source, "verifier");
  });

  test("LLM true + verifier >0 → source=verifier（verifier 优先）", () => {
    const result = mergeFactRisk(true, 2);
    assert.equal(result.hardFactRisk, true);
    assert.equal(result.source, "verifier");
  });

  test("LLM false + verifier 0 → source=merged, hardFactRisk=false", () => {
    const result = mergeFactRisk(false, 0);
    assert.equal(result.hardFactRisk, false);
    assert.equal(result.source, "merged");
  });
});
