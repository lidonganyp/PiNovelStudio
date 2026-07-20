/**
 * NovelOS 裁判校准测试（P1-5）
 *
 * 用 mock fetch 测试 runCalibration 控制流（不调真实 API）。
 *
 * 验证：
 * - runCalibration 返回正确指标（directionConsistency/reverseConsistency/repeatConsistency/hardFactMissRate/noCitationDefinitiveRate）
 * - 门槛 pass/fail 逻辑
 * - details 数组结构完整
 * - formatCalibrationResultAsMarkdown 含关键章节
 * - loadCalibrationSet 加载 JSON
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
// novelos/eval/* 模块是 dormant-from-prod（PROD-BUILD-BOUNDARY-1 后退出生产构建），
// 只存在于 dist-eval/novelos/eval/。生产 dist/novelos/ 不含 eval 子目录。
const DIST_ROOT = join(EXTENSION_ROOT, "dist-eval");

const calibrationUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "eval", "judge-calibration.js"),
).href;

const {
  runCalibration,
  formatCalibrationResultAsMarkdown,
  loadCalibrationSet,
  CALIBRATION_THRESHOLDS,
} = await import(calibrationUrl);

// M1-R3：从 pairwise-judge 导入 JUDGE_DIMENSIONS，用于构造合法 verdict
// （维度名必须精确匹配 JUDGE_DIMENSIONS 集合，否则 validateJudgeVerdict 判 invalid）
const pairwiseJudgeUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "eval", "pairwise-judge.js"),
).href;
const { JUDGE_DIMENSIONS } = await import(pairwiseJudgeUrl);

// ============================================================================
// Mock fetch
// ============================================================================

let fetchCalls = [];
let originalFetch;

function mockFetchTie() {
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    // 模拟一致判 tie 的裁判
    const verdict = {
      winner: "tie",
      confidence: 0.5,
      // M1-R3：维度名必须匹配 JUDGE_DIMENSIONS；tie 维度不校验 span
      dimensions: JUDGE_DIMENSIONS.map((name) => ({
        name, winner: "tie", reason: "接近", evidenceA: [], evidenceB: [],
      })),
      hardFactRisk: false,
      literaryRegressionRisk: false,
    };
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

function mockFetchConsistentWinner(pickLeft) {
  // 模拟一致裁判：总是选同一个物理候选
  // 需要根据 prompt 判断 A/B 标签对应哪个物理候选
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    const body = JSON.parse(init.body);
    const userPrompt = body.messages.find((m) => m.role === "user")?.content ?? "";

    // 从中文模型协议中解析候选甲和乙的文本
    const aMatch = userPrompt.match(/候选\s*甲：\n([\s\S]*?)\n\n候选\s*乙：/);
    const bMatch = userPrompt.match(/候选\s*乙：\n([\s\S]*?)\n\n请从以下/);
    const candidateA = aMatch ? aMatch[1] : "";
    const candidateB = bMatch ? bMatch[1] : "";

    // pickLeft=true 时总是选 left 物理候选
    // left 在 prompt 中可能是 A 或 B（取决于 mapping）
    // 通过检查哪个候选包含 leftText 的特征判断
    // 简化：第一个候选（候选甲）如果包含中文哨兵则 left=A
    const leftIsA = candidateA.includes("左侧标记");
    const winnerLabel = pickLeft ? (leftIsA ? "A" : "B") : (leftIsA ? "B" : "A");

    // M1-R3：excerpt 必须 === text.slice(start, end)；动态计算各候选前缀
    const aPrefix = candidateA.slice(0, Math.min(5, candidateA.length));
    const bPrefix = candidateB.slice(0, Math.min(5, candidateB.length));
    const evidenceA = [{ start: 0, end: aPrefix.length, excerpt: aPrefix }];
    const evidenceB = [{ start: 0, end: bPrefix.length, excerpt: bPrefix }];

    const verdict = {
      winner: winnerLabel,
      confidence: 0.85,
      // M1-R3：维度名匹配 JUDGE_DIMENSIONS，胜负双方 excerpt 一致
      dimensions: JUDGE_DIMENSIONS.map((name) => ({
        name, winner: winnerLabel, reason: "更好",
        evidenceA, evidenceB,
      })),
      hardFactRisk: false,
      literaryRegressionRisk: false,
    };
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
// 测试数据
// ============================================================================

function makeEntries(count, opts = {}) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      fixtureId: `F${i + 1}-cal`,
      pair: `B1_vs_B${i + 2}`,
      humanWinner: opts.humanWinner ?? "tie",
      humanConfidence: "clear",
      leftText: `左侧标记 候选 ${i + 1} 左正文`,
      rightText: `候选 ${i + 1} 右正文`,
      context: {
        workGoal: "测试作品",
        chapterIntent: "测试意图",
        priorFacts: ["前文事实1"],
      },
      expectedHardFactRisk: opts.expectedHardFactRisk ?? false,
    });
  }
  return entries;
}

// ============================================================================
// 测试
// ============================================================================

describe("NovelOS 裁判校准（P1-5）", () => {
  beforeEach(() => {
    fetchCalls = [];
  });
  afterEach(() => {
    restoreFetch();
  });

  test("runCalibration 返回正确指标结构", async () => {
    mockFetchTie();
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const entries = makeEntries(2, { humanWinner: "tie" });
    const result = await runCalibration(config, entries);

    assert.ok(typeof result.directionConsistency === "number");
    assert.ok(typeof result.reverseConsistency === "number");
    assert.ok(typeof result.repeatConsistency === "number");
    assert.ok(typeof result.hardFactMissRate === "number");
    assert.ok(typeof result.noCitationDefinitiveRate === "number");
    assert.ok(typeof result.passed === "boolean");
    assert.equal(result.totalEntries, 2);
    assert.equal(result.details.length, 2);
    assert.ok(result.thresholds === CALIBRATION_THRESHOLDS);
  });

  test("一致判 tie + 人工 winner=tie → directionConsistency=1.0", async () => {
    mockFetchTie();
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const entries = makeEntries(3, { humanWinner: "tie" });
    const result = await runCalibration(config, entries);
    assert.equal(result.directionConsistency, 1.0, "全部一致 → 1.0");
    assert.equal(result.reverseConsistency, 1.0, "tie 反转一致 → 1.0");
    assert.equal(result.repeatConsistency, 1.0, "tie 重复一致 → 1.0");
  });

  test("一致判 tie + 人工 winner=left → directionConsistency=0.0", async () => {
    mockFetchTie();
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const entries = makeEntries(2, { humanWinner: "left" });
    const result = await runCalibration(config, entries);
    assert.equal(result.directionConsistency, 0.0, "LLM tie vs 人工 left → 不一致");
  });

  test("一致裁判 + 人工 winner=left → directionConsistency=1.0", async () => {
    // 裁判总是选 left 物理候选
    mockFetchConsistentWinner(true);
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const entries = makeEntries(2, { humanWinner: "left" });
    const result = await runCalibration(config, entries);
    assert.equal(result.directionConsistency, 1.0, "一致选 left + 人工 left → 1.0");
    assert.equal(result.repeatConsistency, 1.0, "一致裁判重复一致 → 1.0");
  });

  test("门槛全过 → passed=true", async () => {
    mockFetchTie();
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const entries = makeEntries(5, { humanWinner: "tie" });
    const result = await runCalibration(config, entries);
    assert.equal(result.passed, true, "tie + 人工 tie → 全部门槛通过");
  });

  test("directionConsistency 低于门槛 → passed=false", async () => {
    mockFetchTie();
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    // 人工 winner=left，但 LLM 判 tie → directionConsistency=0 < 0.85
    const entries = makeEntries(5, { humanWinner: "left" });
    const result = await runCalibration(config, entries);
    assert.equal(result.directionConsistency, 0.0);
    assert.equal(result.passed, false, "directionConsistency 0 < 0.85 → 不通过");
  });

  test("hardFactMissRate：期望有硬伤但 LLM 未检出 → 影响通过", async () => {
    mockFetchTie(); // verdict.hardFactRisk=false
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const entries = makeEntries(2, { humanWinner: "tie", expectedHardFactRisk: true });
    const result = await runCalibration(config, entries);
    assert.equal(result.hardFactMissRate, 1.0, "期望硬伤但未检出 → miss rate=1.0");
    assert.equal(result.passed, false, "hardFactMissRate 1.0 > 0.05 → 不通过");
  });

  test("details 包含每条目的完整信息", async () => {
    mockFetchTie();
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const entries = makeEntries(2, { humanWinner: "tie" });
    const result = await runCalibration(config, entries);
    for (const d of result.details) {
      assert.ok(d.fixtureId, "应有 fixtureId");
      assert.ok(d.pair, "应有 pair");
      assert.ok(typeof d.humanWinner === "string");
      assert.ok(typeof d.llmWinner === "string");
      assert.ok(typeof d.consistent === "boolean");
      assert.ok(typeof d.reverseConsistent === "boolean");
      assert.ok(typeof d.repeatConsistent === "boolean");
    }
  });

  test("formatCalibrationResultAsMarkdown 含关键章节", async () => {
    mockFetchTie();
    const config = {
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "gpt-5.6-sol",
      timeoutMs: 5000,
    };
    const entries = makeEntries(2, { humanWinner: "tie" });
    const result = await runCalibration(config, entries);
    const md = formatCalibrationResultAsMarkdown(result);
    assert.ok(md.includes("裁判校准结果"), "应含标题");
    assert.ok(md.includes("聚合指标"), "应含聚合指标章节");
    assert.ok(md.includes("directionConsistency"), "应含 directionConsistency");
    assert.ok(md.includes("reverseConsistency"), "应含 reverseConsistency");
    assert.ok(md.includes("repeatConsistency"), "应含 repeatConsistency");
    assert.ok(md.includes("hardFactMissRate"), "应含 hardFactMissRate");
    assert.ok(md.includes("noCitationDefinitiveRate"), "应含 noCitationDefinitiveRate");
    assert.ok(md.includes("各条目详情"), "应含详情章节");
    assert.ok(md.includes("PASSED") || md.includes("FAILED"), "应含通过/失败标记");
  });

  test("loadCalibrationSet 加载 JSON 文件", async () => {
    const tmpPath = join(tmpdir(), `cal-${randomUUID()}.json`);
    const calSet = {
      calibrationSet: [
        {
          fixtureId: "F1-test",
          pair: "B1_vs_B2",
          humanWinner: "left",
          humanConfidence: "clear",
          leftText: "左正文",
          rightText: "右正文",
          context: { workGoal: "测试", chapterIntent: "意图", priorFacts: [] },
          expectedHardFactRisk: false,
        },
      ],
    };
    writeFileSync(tmpPath, JSON.stringify(calSet), "utf-8");
    try {
      const loaded = await loadCalibrationSet(tmpPath);
      assert.equal(loaded.calibrationSet.length, 1);
      assert.equal(loaded.calibrationSet[0].fixtureId, "F1-test");
      assert.equal(loaded.calibrationSet[0].humanWinner, "left");
    } finally {
      if (existsSync(tmpPath)) rmSync(tmpPath);
    }
  });

  test("loadCalibrationSet 格式错误时抛错", async () => {
    const tmpPath = join(tmpdir(), `cal-bad-${randomUUID()}.json`);
    writeFileSync(tmpPath, JSON.stringify({ wrongField: [] }), "utf-8");
    try {
      await assert.rejects(
        loadCalibrationSet(tmpPath),
        /校准集格式错误/,
      );
    } finally {
      if (existsSync(tmpPath)) rmSync(tmpPath);
    }
  });
});
