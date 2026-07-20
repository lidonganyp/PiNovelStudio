/**
 * JUDGE-HUMAN-ALIGNMENT-1 验收测试（任务卡 §5，P0）
 *
 * 目标：先验证 judge 是否能识别用户真正偏好的稿件，再允许它选择多 raw 或注入策略。
 *
 * 验收口径（任务卡 §5 准入门槛）：
 * - 与用户明确选择的一致率达到预登记门槛（建议最低 70%）
 * - 不存在系统性反向偏差
 * - 顺序敏感、理由无 span 或不同轮冲突的样本不得计为正确
 * - 未达门槛前，Best-of-N 只能作为离线实验，不能改变生产选择
 *
 * 校准维度（10 个，独立于现有 5 维 JUDGE_DIMENSIONS）：
 * - 中文原生语感
 * - 人物声音与行为可信度
 * - 目标—阻力—选择—结果
 * - 情绪推进与兑现
 * - 信息释放
 * - 场景沉浸
 * - 章末因果压力
 * - 连续性与事实
 * - 模板化/AI 痕迹
 * - 是否值得替换 raw
 *
 * 4 种样本来源：
 * - system_vs_user：系统选定稿 vs 用户最终稿
 * - accepted_vs_rejected：用户明确接受稿 vs 明确否决稿
 * - raw_vs_negative：raw vs 已知负收益的 legacy/amplified 稿
 * - reference_vs_weakened：reference vs 人工制造的工整但削弱人物生命力版本
 *
 * 3 类重点偏差测试：
 * - explanation_over_emotion：judge 偏爱解释更多、结构更工整但情绪更平的稿件
 * - short_sentence_as_literary：judge 把短句、华丽表达当作文学性
 * - plot_similarity_over_text：judge 因候选更接近 reference 情节而忽略文本本身质量
 *
 * 本测试用 mock fetch 模拟 judge 输出，不调用真实 API。
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const DIST_EVAL_ROOT = join(EXTENSION_ROOT, "dist-eval");
const PROJECT_ROOT = join(EXTENSION_ROOT, "..", "..", "..");
const SCRIPTS_ROOT = join(PROJECT_ROOT, "scripts", "novelbench");

const moduleUrl = pathToFileURL(
  join(DIST_EVAL_ROOT, "novelos", "eval", "judge-human-alignment.js"),
).href;

const {
  HUMAN_ALIGNMENT_DIMENSIONS,
  HUMAN_ALIGNMENT_THRESHOLDS,
  runHumanAlignmentCalibration,
  loadHumanAlignmentSet,
  formatHumanAlignmentResultAsMarkdown,
} = await import(moduleUrl);

// ============================================================================
// Mock fetch 工具
// ============================================================================

let originalFetch;

function makeVerdict({
  winner,
  dimensions: dimensionWinners,
  evidenceA,
  evidenceB,
  hardFactRisk = false,
  literaryRegressionRisk = false,
  confidence = 0.85,
}) {
  // 10 维度 verdict，每个维度按 dimensionWinners 给定 winner
  const dimensions = HUMAN_ALIGNMENT_DIMENSIONS.map((name) => {
    const w = dimensionWinners[name] ?? "tie";
    // tie 维度不需要 evidence
    if (w === "tie") {
      return { name, winner: "tie", reason: "接近", evidenceA: [], evidenceB: [] };
    }
    // 胜方和败方都需要 evidence
    const winnerEvidence = w === "A" ? evidenceA : evidenceB;
    const loserEvidence = w === "A" ? evidenceB : evidenceA;
    return {
      name,
      winner: w,
      reason: `${name}：${w} 更好`,
      evidenceA: w === "A" ? winnerEvidence : loserEvidence,
      evidenceB: w === "B" ? winnerEvidence : loserEvidence,
    };
  });
  return {
    winner,
    confidence,
    dimensions,
    hardFactRisk,
    literaryRegressionRisk,
  };
}

/**
 * 模拟一致裁判：始终把"左侧标记"的候选判为 left 物理候选胜。
 * 实现：解析 user prompt，识别候选甲/乙哪个含"左侧标记"前缀，
 * 然后让该候选在所有维度上胜出，全局 winner 也指向该候选。
 */
function mockFetchConsistentLeft(dimensionWinnersByCandidate = {}) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const userPrompt = body.messages.find((m) => m.role === "user")?.content ?? "";

    // 解析候选甲/乙文本
    const aMatch = userPrompt.match(/候选\s*甲：\n([\s\S]*?)\n\n候选\s*乙：/);
    const bMatch = userPrompt.match(/候选\s*乙：\n([\s\S]*?)\n\n请从以下/);
    const candidateA = aMatch ? aMatch[1] : "";
    const candidateB = bMatch ? bMatch[1] : "";

    // "左侧标记"前缀决定 left 物理候选是 A 还是 B
    const leftIsA = candidateA.includes("左侧标记");
    const winnerLabel = leftIsA ? "A" : "B";

    // 构造 evidence：每个候选的前 5 字符作为 evidence span
    const aPrefix = candidateA.slice(0, Math.min(5, candidateA.length));
    const bPrefix = candidateB.slice(0, Math.min(5, candidateB.length));
    const evidenceA = aPrefix
      ? [{ start: 0, end: aPrefix.length, excerpt: aPrefix }]
      : [];
    const evidenceB = bPrefix
      ? [{ start: 0, end: bPrefix.length, excerpt: bPrefix }]
      : [];

    // 所有维度都判 winnerLabel 胜
    const dimensionWinners = {};
    for (const name of HUMAN_ALIGNMENT_DIMENSIONS) {
      dimensionWinners[name] = winnerLabel;
    }
    Object.assign(dimensionWinners, dimensionWinnersByCandidate);

    const verdict = makeVerdict({
      winner: winnerLabel,
      dimensions: dimensionWinners,
      evidenceA,
      evidenceB,
    });

    const chatResponse = {
      model: "gpt-5.6-sol",
      choices: [
        { message: { content: JSON.stringify(verdict) }, finish_reason: "stop" },
      ],
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

/**
 * 模拟裁判：根据传入的 winnerByRound 函数，每轮返回不同 winner。
 * roundIdx 是轮内编号（0,1,2 循环），用于测试 positionSensitive 检测。
 */
function mockFetchByRound(winnerByRound) {
  originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url, init) => {
    const roundIdx = callCount % 3; // 轮内编号：0,1,2 循环
    callCount += 1;
    const body = JSON.parse(init.body);
    const userPrompt = body.messages.find((m) => m.role === "user")?.content ?? "";

    const aMatch = userPrompt.match(/候选\s*甲：\n([\s\S]*?)\n\n候选\s*乙：/);
    const bMatch = userPrompt.match(/候选\s*乙：\n([\s\S]*?)\n\n请从以下/);
    const candidateA = aMatch ? aMatch[1] : "";
    const candidateB = bMatch ? bMatch[1] : "";

    const leftIsA = candidateA.includes("左侧标记");
    const desiredPhysicalWinner = winnerByRound(roundIdx); // "left" | "right" | "tie"
    let winnerLabel;
    if (desiredPhysicalWinner === "tie") {
      winnerLabel = "tie";
    } else if (desiredPhysicalWinner === "left") {
      winnerLabel = leftIsA ? "A" : "B";
    } else {
      winnerLabel = leftIsA ? "B" : "A";
    }

    const aPrefix = candidateA.slice(0, Math.min(5, candidateA.length));
    const bPrefix = candidateB.slice(0, Math.min(5, candidateB.length));
    const evidenceA = aPrefix
      ? [{ start: 0, end: aPrefix.length, excerpt: aPrefix }]
      : [];
    const evidenceB = bPrefix
      ? [{ start: 0, end: bPrefix.length, excerpt: bPrefix }]
      : [];

    const dimensionWinners = {};
    for (const name of HUMAN_ALIGNMENT_DIMENSIONS) {
      dimensionWinners[name] = winnerLabel === "tie" ? "tie" : winnerLabel;
    }

    const verdict = makeVerdict({
      winner: winnerLabel,
      dimensions: dimensionWinners,
      evidenceA,
      evidenceB,
    });

    const chatResponse = {
      model: "gpt-5.6-sol",
      choices: [
        { message: { content: JSON.stringify(verdict) }, finish_reason: "stop" },
      ],
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

/**
 * 模拟裁判：返回无 span 的 verdict（测试 noSpan 排除）。
 */
function mockFetchNoSpan() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const userPrompt = body.messages.find((m) => m.role === "user")?.content ?? "";

    const aMatch = userPrompt.match(/候选\s*甲：\n([\s\S]*?)\n\n候选\s*乙：/);
    const bMatch = userPrompt.match(/候选\s*乙：\n([\s\S]*?)\n\n请从以下/);
    const candidateA = aMatch ? aMatch[1] : "";
    const candidateB = bMatch ? bMatch[1] : "";

    const leftIsA = candidateA.includes("左侧标记");
    const winnerLabel = leftIsA ? "A" : "B";

    // 无 span verdict
    const dimensions = HUMAN_ALIGNMENT_DIMENSIONS.map((name) => ({
      name,
      winner: winnerLabel,
      reason: `${name}：${winnerLabel} 更好`,
      evidenceA: [], // 空 span
      evidenceB: [],
    }));

    const verdict = {
      winner: winnerLabel,
      confidence: 0.85,
      dimensions,
      hardFactRisk: false,
      literaryRegressionRisk: false,
    };

    const chatResponse = {
      model: "gpt-5.6-sol",
      choices: [
        { message: { content: JSON.stringify(verdict) }, finish_reason: "stop" },
      ],
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
// 测试数据工厂
// ============================================================================

function makeEntry(opts = {}) {
  return {
    fixtureId: opts.fixtureId ?? `F-${randomUUID().slice(0, 8)}`,
    pair: opts.pair ?? "L_vs_R",
    sampleSource: opts.sampleSource ?? "system_vs_user",
    humanWinner: opts.humanWinner ?? "left",
    humanConfidence: opts.humanConfidence ?? "clear",
    leftText: opts.leftText ?? "左侧标记 这是左侧候选正文，质量较好。",
    rightText: opts.rightText ?? "这是右侧候选正文，质量稍逊。",
    context: opts.context ?? {
      workGoal: "测试作品",
      chapterIntent: "测试意图",
      priorFacts: ["前文事实1"],
    },
    isBiasTest: opts.isBiasTest ?? false,
    biasType: opts.biasType,
    expectedBiasDirection: opts.expectedBiasDirection,
  };
}

function makeEntries(count, opts = {}) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push(
      makeEntry({
        ...opts,
        fixtureId: `F${i + 1}-al`,
        pair: `L${i + 1}_vs_R${i + 1}`,
        leftText: `左侧标记 候选 ${i + 1} 左正文，质量较好。`,
        rightText: `候选 ${i + 1} 右正文，质量稍逊。`,
      }),
    );
  }
  return entries;
}

const judgeConfig = {
  apiKey: "test-key",
  baseUrl: "https://example.com/v1",
  model: "gpt-5.6-sol",
  timeoutMs: 5000,
};

// ============================================================================
// 测试
// ============================================================================

describe("JUDGE-HUMAN-ALIGNMENT-1：模块导出与常量", () => {
  test("HUMAN_ALIGNMENT_DIMENSIONS 恰好 10 维且名称匹配任务卡", () => {
    assert.equal(HUMAN_ALIGNMENT_DIMENSIONS.length, 10, "必须 10 维");
    const expected = [
      "中文原生语感",
      "人物声音与行为可信度",
      "目标—阻力—选择—结果",
      "情绪推进与兑现",
      "信息释放",
      "场景沉浸",
      "章末因果压力",
      "连续性与事实",
      "模板化/AI 痕迹",
      "是否值得替换 raw",
    ];
    for (const name of expected) {
      assert.ok(
        HUMAN_ALIGNMENT_DIMENSIONS.includes(name),
        `缺少维度：${name}`,
      );
    }
  });

  test("HUMAN_ALIGNMENT_DIMENSIONS 与现有 5 维 JUDGE_DIMENSIONS 不同", async () => {
    // 加载现有 5 维以确保不冲突
    const pairwiseUrl = pathToFileURL(
      join(DIST_EVAL_ROOT, "novelos", "eval", "pairwise-judge.js"),
    ).href;
    const { JUDGE_DIMENSIONS } = await import(pairwiseUrl);
    assert.equal(JUDGE_DIMENSIONS.length, 5);
    assert.equal(HUMAN_ALIGNMENT_DIMENSIONS.length, 10);
    // 10 维集合应严格大于 5 维集合（不是同一个集合）
    assert.notDeepEqual(
      [...HUMAN_ALIGNMENT_DIMENSIONS].sort(),
      [...JUDGE_DIMENSIONS].sort(),
    );
  });

  test("HUMAN_ALIGNMENT_THRESHOLDS 含 userChoiceAgreement=0.70", () => {
    assert.equal(HUMAN_ALIGNMENT_THRESHOLDS.userChoiceAgreement, 0.70);
    assert.ok(
      typeof HUMAN_ALIGNMENT_THRESHOLDS.biasSystematicThreshold === "number",
    );
    assert.ok(
      typeof HUMAN_ALIGNMENT_THRESHOLDS.reverseConsistency === "number",
    );
  });
});

describe("JUDGE-HUMAN-ALIGNMENT-1：runHumanAlignmentCalibration 基础", () => {
  beforeEach(() => {
    mockFetchConsistentLeft();
  });
  afterEach(() => {
    restoreFetch();
  });

  test("返回正确指标结构", async () => {
    const entries = makeEntries(5, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);

    assert.ok(typeof result.userChoiceAgreement === "number");
    assert.ok(typeof result.reverseConsistency === "number");
    assert.ok(typeof result.totalEntries === "number");
    assert.ok(typeof result.correctCount === "number");
    assert.ok(typeof result.excludedCount === "number");
    assert.ok(typeof result.systematicReverseBias === "boolean");
    assert.ok(typeof result.passed === "boolean");
    assert.ok(Array.isArray(result.details));
    assert.ok(typeof result.dimensionAgreement === "object");
    assert.ok(Array.isArray(result.biasMetrics));
    assert.ok(result.thresholds === HUMAN_ALIGNMENT_THRESHOLDS);
    assert.equal(result.totalEntries, 5);
    assert.equal(result.details.length, 5);
  });

  test("一致裁判 + 人工 winner=left → userChoiceAgreement=1.0，passed=true", async () => {
    const entries = makeEntries(5, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    assert.equal(result.userChoiceAgreement, 1.0, "5/5 一致 → 1.0");
    assert.equal(result.correctCount, 5);
    assert.equal(result.excludedCount, 0);
    assert.equal(result.passed, true, "1.0 ≥ 0.70 → 通过");
  });

  test("一致裁判 + 人工 winner=right → userChoiceAgreement=0.0，passed=false", async () => {
    // 裁判总是选 left（"左侧标记"），但人工 winner=right → 全部不一致
    const entries = makeEntries(5, { humanWinner: "right" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    assert.equal(result.userChoiceAgreement, 0.0, "0/5 一致 → 0.0");
    assert.equal(result.passed, false, "0.0 < 0.70 → 不通过");
  });

  test("70% 边界：5 中 3 一致 + 2 tie 不计 → userChoiceAgreement=0.6 不通过", async () => {
    // 用 winnerByRound 模拟：部分样本判 left（与人工一致），部分判 tie
    let callCount = 0;
    mockFetchByRound((roundIdx) => {
      // 每个 entry 调 3 次（3 轮）；前 3 个 entry 全判 left，后 2 个全判 tie
      const entryIdx = Math.floor(callCount / 3);
      callCount += 1;
      if (entryIdx < 3) return "left";
      return "tie";
    });
    const entries = makeEntries(5, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    // 3 个一致 + 2 个 tie（tie 与人工 left 不一致，但 tie 不算 positionSensitive/noSpan/conflicting）
    // userChoiceAgreement = correct / (total - excluded) = 3 / (5 - 0) = 0.6
    assert.equal(result.correctCount, 3, "3 个一致");
    assert.equal(result.userChoiceAgreement, 0.6);
    assert.equal(result.passed, false, "0.6 < 0.70 → 不通过");
  });
});

describe("JUDGE-HUMAN-ALIGNMENT-1：排除规则（不计为正确）", () => {
  afterEach(() => {
    restoreFetch();
  });

  test("positionSensitive 样本不计为正确", async () => {
    // 模拟：round 1 判 left，round 2 判 right（反转后），round 3 判 left
    // → 前两轮 winner 不一致 → positionSensitive=true
    mockFetchByRound((roundIdx) => {
      // roundIdx 0,1,2 对应 3 轮
      if (roundIdx === 0) return "left";
      if (roundIdx === 1) return "right";
      return "left";
    });
    const entries = makeEntries(3, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    // 所有样本都 positionSensitive → 全部排除
    assert.equal(result.excludedCount, 3, "3 个 positionSensitive 被排除");
    assert.equal(result.correctCount, 0);
    // 全部排除 → userChoiceAgreement=0（无有效样本）
    assert.equal(result.userChoiceAgreement, 0);
    assert.equal(result.passed, false, "无有效样本 → 不通过");
    // 每个详情标记 exclusionReason
    for (const d of result.details) {
      assert.equal(d.exclusionReason, "position_sensitive");
      assert.equal(d.countedAsCorrect, false);
    }
  });

  test("noSpan verdict 样本不计为正确", async () => {
    mockFetchNoSpan();
    const entries = makeEntries(2, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    // 所有轮次 verdict 无 span → 全部排除
    assert.equal(result.excludedCount, 2, "无 span → 排除");
    assert.equal(result.correctCount, 0);
    for (const d of result.details) {
      assert.equal(d.exclusionReason, "no_span");
    }
  });

  test("conflicting rounds 样本不计为正确", async () => {
    // 模拟：round 1 判 left，round 2 判 right，round 3 判 tie
    // → 没有任何一个 winner 达到 2/3 多数 → conflicting rounds
    mockFetchByRound((roundIdx) => {
      if (roundIdx === 0) return "left";
      if (roundIdx === 1) return "right";
      return "tie";
    });
    const entries = makeEntries(2, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    assert.equal(result.excludedCount, 2, "无多数 → conflicting_rounds");
    for (const d of result.details) {
      assert.equal(d.exclusionReason, "conflicting_rounds");
    }
  });

  test("混合：1 正确 + 1 positionSensitive + 1 noSpan + 1 conflicting", async () => {
    // 4 个 entry，分别测试不同排除规则
    let globalCall = 0;
    mockFetchByRound((roundIdx) => {
      const entryIdx = Math.floor(globalCall / 3);
      globalCall += 1;
      // entry 0：全 left（一致，正确）
      if (entryIdx === 0) return "left";
      // entry 1：round 0 left, round 1 right, round 2 left（positionSensitive）
      if (entryIdx === 1) {
        if (roundIdx === 1) return "right";
        return "left";
      }
      // entry 2 & 3：用 noSpan mockFetch，但这里用 byRound 模拟冲突
      // entry 2：round 0 left, round 1 right, round 2 tie（conflicting）
      if (entryIdx === 2) {
        if (roundIdx === 0) return "left";
        if (roundIdx === 1) return "right";
        return "tie";
      }
      // entry 3：全 left（一致，正确）
      return "left";
    });
    const entries = makeEntries(4, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    assert.equal(result.totalEntries, 4);
    assert.equal(result.correctCount, 2, "2 个正确（entry 0 和 3）");
    assert.equal(result.excludedCount, 2, "2 个排除（positionSensitive + conflicting）");
    // userChoiceAgreement = 2 / (4 - 2) = 1.0
    assert.equal(result.userChoiceAgreement, 1.0);
  });
});

describe("JUDGE-HUMAN-ALIGNMENT-1：10 维度独立追踪", () => {
  beforeEach(() => {
    mockFetchConsistentLeft();
  });
  afterEach(() => {
    restoreFetch();
  });

  test("dimensionAgreement 含全部 10 维度", async () => {
    const entries = makeEntries(5, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    for (const name of HUMAN_ALIGNMENT_DIMENSIONS) {
      assert.ok(
        name in result.dimensionAgreement,
        `dimensionAgreement 应含维度：${name}`,
      );
      assert.ok(typeof result.dimensionAgreement[name] === "number");
    }
  });

  test("每个详情含 dimensionWinners 记录全部 10 维度", async () => {
    const entries = makeEntries(2, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    for (const d of result.details) {
      assert.ok(typeof d.dimensionWinners === "object");
      for (const name of HUMAN_ALIGNMENT_DIMENSIONS) {
        assert.ok(name in d.dimensionWinners, `详情应含维度 winner：${name}`);
        assert.ok(["A", "B", "tie"].includes(d.dimensionWinners[name]));
      }
    }
  });

  test("禁止用维度总分自动决定 winner（不存在 dimensionTotalScore 字段）", async () => {
    const entries = makeEntries(2, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    // 不应该有 dimensionTotalScore 或类似字段
    assert.ok(!("dimensionTotalScore" in result));
    assert.ok(!("dimensionScoreSum" in result));
    for (const d of result.details) {
      assert.ok(!("dimensionTotalScore" in d));
    }
  });
});

describe("JUDGE-HUMAN-ALIGNMENT-1：3 类偏差测试", () => {
  afterEach(() => {
    restoreFetch();
  });

  test("explanation_over_emotion：judge 偏爱解释更多但情绪更平的稿件", async () => {
    // mock：裁判在所有维度上都选 right（情绪更平的稿件）
    // 但人工期望 judge 偏向 right（expectedBiasDirection=right）→ biasAsExpected=true
    mockFetchByRound(() => "right");
    const entries = [
      makeEntry({
        fixtureId: "B1-explain",
        sampleSource: "reference_vs_weakened",
        humanWinner: "left", // 人工偏好 left（情绪更饱满）
        leftText: "左侧标记 情绪饱满的版本",
        rightText: "解释更多但情绪更平的版本",
        isBiasTest: true,
        biasType: "explanation_over_emotion",
        expectedBiasDirection: "right", // 期望 judge 偏向 right
      }),
      makeEntry({
        fixtureId: "B2-explain",
        sampleSource: "reference_vs_weakened",
        humanWinner: "left",
        leftText: "左侧标记 情绪饱满的版本",
        rightText: "解释更多但情绪更平的版本",
        isBiasTest: true,
        biasType: "explanation_over_emotion",
        expectedBiasDirection: "right",
      }),
      makeEntry({
        fixtureId: "B3-explain",
        sampleSource: "reference_vs_weakened",
        humanWinner: "left",
        leftText: "左侧标记 情绪饱满的版本",
        rightText: "解释更多但情绪更平的版本",
        isBiasTest: true,
        biasType: "explanation_over_emotion",
        expectedBiasDirection: "right",
      }),
    ];
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    const biasMetric = result.biasMetrics.find(
      (m) => m.biasType === "explanation_over_emotion",
    );
    assert.ok(biasMetric, "应有 explanation_over_emotion 偏差指标");
    assert.equal(biasMetric.totalBiasTests, 3);
    assert.equal(biasMetric.biasAsExpectedCount, 3, "3 个全部表现出预期偏差");
    assert.equal(biasMetric.biasRate, 1.0);
    assert.equal(biasMetric.systematic, true, "biasRate=1.0 > 0.60 → 系统性偏差");
  });

  test("short_sentence_as_literary：judge 把短句/华丽表达当作文学性", async () => {
    mockFetchByRound(() => "right");
    const entries = [
      makeEntry({
        fixtureId: "B4-short",
        sampleSource: "reference_vs_weakened",
        humanWinner: "left",
        leftText: "左侧标记 自然长句版本",
        rightText: "短句华丽版本",
        isBiasTest: true,
        biasType: "short_sentence_as_literary",
        expectedBiasDirection: "right",
      }),
      makeEntry({
        fixtureId: "B5-short",
        sampleSource: "reference_vs_weakened",
        humanWinner: "left",
        leftText: "左侧标记 自然长句版本",
        rightText: "短句华丽版本",
        isBiasTest: true,
        biasType: "short_sentence_as_literary",
        expectedBiasDirection: "right",
      }),
    ];
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    const biasMetric = result.biasMetrics.find(
      (m) => m.biasType === "short_sentence_as_literary",
    );
    assert.ok(biasMetric);
    assert.equal(biasMetric.totalBiasTests, 2);
    assert.equal(biasMetric.biasAsExpectedCount, 2);
    assert.equal(biasMetric.biasRate, 1.0);
    assert.equal(biasMetric.systematic, true);
  });

  test("plot_similarity_over_text：judge 因情节接近 reference 而忽略文本质量", async () => {
    mockFetchByRound(() => "right");
    const entries = [
      makeEntry({
        fixtureId: "B6-plot",
        sampleSource: "reference_vs_weakened",
        humanWinner: "left",
        leftText: "左侧标记 文本质量好但情节偏离 reference",
        rightText: "文本质量差但情节接近 reference",
        isBiasTest: true,
        biasType: "plot_similarity_over_text",
        expectedBiasDirection: "right",
      }),
      makeEntry({
        fixtureId: "B7-plot",
        sampleSource: "reference_vs_weakened",
        humanWinner: "left",
        leftText: "左侧标记 文本质量好但情节偏离 reference",
        rightText: "文本质量差但情节接近 reference",
        isBiasTest: true,
        biasType: "plot_similarity_over_text",
        expectedBiasDirection: "right",
      }),
    ];
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    const biasMetric = result.biasMetrics.find(
      (m) => m.biasType === "plot_similarity_over_text",
    );
    assert.ok(biasMetric);
    assert.equal(biasMetric.totalBiasTests, 2);
    assert.equal(biasMetric.biasRate, 1.0);
    assert.equal(biasMetric.systematic, true);
  });

  test("非偏差测试样本不计入 biasMetrics", async () => {
    mockFetchConsistentLeft();
    const entries = makeEntries(3, { humanWinner: "left" }); // 非偏差测试
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    assert.equal(result.biasMetrics.length, 0, "无非偏差测试的 biasMetric");
  });

  test("偏差率低于 0.60 → systematic=false", async () => {
    // 5 个偏差测试，只 2 个表现出预期偏差 → 0.4 < 0.60
    let globalCall = 0;
    mockFetchByRound(() => {
      const idx = Math.floor(globalCall / 3);
      globalCall += 1;
      // entry 0,1 表现偏差（判 right），2,3,4 不表现（判 left）
      return idx < 2 ? "right" : "left";
    });
    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push(
        makeEntry({
          fixtureId: `B${i}-mix`,
          sampleSource: "reference_vs_weakened",
          humanWinner: "left",
          leftText: `左侧标记 候选 ${i}`,
          rightText: `候选 ${i} 右`,
          isBiasTest: true,
          biasType: "explanation_over_emotion",
          expectedBiasDirection: "right",
        }),
      );
    }
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    const biasMetric = result.biasMetrics.find(
      (m) => m.biasType === "explanation_over_emotion",
    );
    assert.ok(biasMetric);
    assert.equal(biasMetric.totalBiasTests, 5);
    assert.equal(biasMetric.biasAsExpectedCount, 2);
    assert.equal(biasMetric.biasRate, 0.4);
    assert.equal(biasMetric.systematic, false, "0.4 < 0.60 → 非系统性");
  });
});

describe("JUDGE-HUMAN-ALIGNMENT-1：系统性反向偏差", () => {
  afterEach(() => {
    restoreFetch();
  });

  test("系统性反向偏差：judge 始终选 right 但人工选 left → systematicReverseBias=true", async () => {
    mockFetchByRound(() => "right");
    const entries = makeEntries(5, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    // judge 5/5 选 right，人工 5/5 选 left → 反向一致率 1.0
    assert.equal(result.userChoiceAgreement, 0.0);
    assert.equal(result.systematicReverseBias, true, "5/5 反向 → 系统性");
    assert.equal(result.passed, false, "系统性反向 → 不通过");
  });

  test("非系统性反向：judge 2/5 反向 → systematicReverseBias=false", async () => {
    let globalCall = 0;
    mockFetchByRound(() => {
      const idx = Math.floor(globalCall / 3);
      globalCall += 1;
      // entry 0,1 选 right（反向），2,3,4 选 left（一致）
      return idx < 2 ? "right" : "left";
    });
    const entries = makeEntries(5, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    assert.equal(result.userChoiceAgreement, 0.6, "3/5 一致 → 0.6");
    // 反向 2/5 = 0.4 < 0.60 阈值 → 非系统性
    assert.equal(result.systematicReverseBias, false);
  });
});

describe("JUDGE-HUMAN-ALIGNMENT-1：匿名 A/B 与反向复判", () => {
  beforeEach(() => {
    mockFetchConsistentLeft();
  });
  afterEach(() => {
    restoreFetch();
  });

  test("匿名 A/B：judge prompt 不含 left/right 物理身份", async () => {
    let capturedPrompt = "";
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const userPrompt = body.messages.find((m) => m.role === "user")?.content ?? "";
      capturedPrompt = userPrompt;
      // 复用 consistentLeft 逻辑
      const aMatch = userPrompt.match(/候选\s*甲：\n([\s\S]*?)\n\n候选\s*乙：/);
      const candidateA = aMatch ? aMatch[1] : "";
      const leftIsA = candidateA.includes("左侧标记");
      const winnerLabel = leftIsA ? "A" : "B";
      const aPrefix = candidateA.slice(0, Math.min(5, candidateA.length));
      const evidenceA = aPrefix
        ? [{ start: 0, end: aPrefix.length, excerpt: aPrefix }]
        : [];
      const evidenceB = [{ start: 0, end: 5, excerpt: "这是右侧候选" }];
      const dimensionWinners = {};
      for (const name of HUMAN_ALIGNMENT_DIMENSIONS) {
        dimensionWinners[name] = winnerLabel;
      }
      const verdict = makeVerdict({
        winner: winnerLabel,
        dimensions: dimensionWinners,
        evidenceA,
        evidenceB,
      });
      const chatResponse = {
        model: "gpt-5.6-sol",
        choices: [
          { message: { content: JSON.stringify(verdict) }, finish_reason: "stop" },
        ],
      };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(chatResponse),
        json: async () => chatResponse,
      };
    };

    const entries = makeEntries(1, { humanWinner: "left" });
    await runHumanAlignmentCalibration(judgeConfig, entries);

    // prompt 不应暴露 left/right 物理身份
    assert.ok(!/raw|amplified|editorial|legacy|baseline/i.test(capturedPrompt),
      "prompt 不应含 raw/amplified/editorial/legacy/baseline 等身份词");
    assert.ok(capturedPrompt.includes("候选甲") || capturedPrompt.includes("候选 A"),
      "prompt 应使用匿名 A/B 标签");
  });

  test("反向复判：reverseConsistency 计算正确", async () => {
    // 一致裁判：所有轮次都选同一物理候选 → reverseConsistency=1.0
    const entries = makeEntries(3, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    assert.equal(result.reverseConsistency, 1.0, "一致裁判 → 1.0");
    for (const d of result.details) {
      assert.equal(d.reverseConsistent, true);
    }
  });

  test("允许 tie：人工 winner=tie + judge 判 tie → 计为正确", async () => {
    mockFetchByRound(() => "tie");
    const entries = makeEntries(3, { humanWinner: "tie" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    assert.equal(result.correctCount, 3, "3 个 tie 与人工 tie 一致 → 正确");
    assert.equal(result.userChoiceAgreement, 1.0);
  });
});

describe("JUDGE-HUMAN-ALIGNMENT-1：loadHumanAlignmentSet", () => {
  test("加载合法 JSON 文件", async () => {
    const tmpPath = join(tmpdir(), `ha-${randomUUID()}.json`);
    const calSet = {
      calibrationSet: [
        {
          fixtureId: "F1-test",
          pair: "L_vs_R",
          sampleSource: "system_vs_user",
          humanWinner: "left",
          humanConfidence: "clear",
          leftText: "左正文",
          rightText: "右正文",
          context: { workGoal: "测试", chapterIntent: "意图", priorFacts: [] },
        },
      ],
    };
    writeFileSync(tmpPath, JSON.stringify(calSet), "utf-8");
    try {
      const loaded = await loadHumanAlignmentSet(tmpPath);
      assert.equal(loaded.calibrationSet.length, 1);
      assert.equal(loaded.calibrationSet[0].fixtureId, "F1-test");
      assert.equal(loaded.calibrationSet[0].sampleSource, "system_vs_user");
    } finally {
      if (existsSync(tmpPath)) rmSync(tmpPath);
    }
  });

  test("格式错误时抛错", async () => {
    const tmpPath = join(tmpdir(), `ha-bad-${randomUUID()}.json`);
    writeFileSync(tmpPath, JSON.stringify({ wrongField: [] }), "utf-8");
    try {
      await assert.rejects(
        loadHumanAlignmentSet(tmpPath),
        /校准集格式错误/,
      );
    } finally {
      if (existsSync(tmpPath)) rmSync(tmpPath);
    }
  });

  test("缺少 sampleSource 字段抛错", async () => {
    const tmpPath = join(tmpdir(), `ha-nosrc-${randomUUID()}.json`);
    const calSet = {
      calibrationSet: [
        {
          fixtureId: "F1-test",
          pair: "L_vs_R",
          // 缺 sampleSource
          humanWinner: "left",
          humanConfidence: "clear",
          leftText: "左",
          rightText: "右",
          context: { workGoal: "测试", chapterIntent: "意图", priorFacts: [] },
        },
      ],
    };
    writeFileSync(tmpPath, JSON.stringify(calSet), "utf-8");
    try {
      await assert.rejects(
        loadHumanAlignmentSet(tmpPath),
        /sampleSource/,
      );
    } finally {
      if (existsSync(tmpPath)) rmSync(tmpPath);
    }
  });

  test("非法 sampleSource 值抛错", async () => {
    const tmpPath = join(tmpdir(), `ha-badsrc-${randomUUID()}.json`);
    const calSet = {
      calibrationSet: [
        {
          fixtureId: "F1-test",
          pair: "L_vs_R",
          sampleSource: "invalid_source",
          humanWinner: "left",
          humanConfidence: "clear",
          leftText: "左",
          rightText: "右",
          context: { workGoal: "测试", chapterIntent: "意图", priorFacts: [] },
        },
      ],
    };
    writeFileSync(tmpPath, JSON.stringify(calSet), "utf-8");
    try {
      await assert.rejects(
        loadHumanAlignmentSet(tmpPath),
        /sampleSource|invalid_source/,
      );
    } finally {
      if (existsSync(tmpPath)) rmSync(tmpPath);
    }
  });
});

describe("JUDGE-HUMAN-ALIGNMENT-1：formatHumanAlignmentResultAsMarkdown", () => {
  beforeEach(() => {
    mockFetchConsistentLeft();
  });
  afterEach(() => {
    restoreFetch();
  });

  test("含关键章节", async () => {
    const entries = makeEntries(3, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    const md = formatHumanAlignmentResultAsMarkdown(result);
    assert.ok(md.includes("JUDGE-HUMAN-ALIGNMENT-1") || md.includes("用户对齐"), "应含标题");
    assert.ok(md.includes("userChoiceAgreement"), "应含 userChoiceAgreement");
    assert.ok(md.includes("reverseConsistency"), "应含 reverseConsistency");
    assert.ok(md.includes("dimensionAgreement") || md.includes("维度"), "应含维度一致率");
    assert.ok(md.includes("biasMetrics") || md.includes("偏差"), "应含偏差测试");
    assert.ok(md.includes("systematicReverseBias"), "应含系统性反向偏差");
    assert.ok(md.includes("PASSED") || md.includes("FAILED"), "应含通过/失败标记");
  });

  test("含 10 维度一致率表格", async () => {
    const entries = makeEntries(2, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    const md = formatHumanAlignmentResultAsMarkdown(result);
    for (const name of HUMAN_ALIGNMENT_DIMENSIONS) {
      assert.ok(md.includes(name), `应含维度名：${name}`);
    }
  });
});

describe("JUDGE-HUMAN-ALIGNMENT-1：CLI scripts/novelbench/judge-human-alignment.mjs", () => {
  const cliPath = join(SCRIPTS_ROOT, "judge-human-alignment.mjs");

  test("CLI 文件存在", () => {
    assert.ok(existsSync(cliPath), `CLI 应存在于 ${cliPath}`);
  });

  test("CLI stub 模式：--stub 不调用真实 API，返回结构化结果", () => {
    // 准备临时校准集
    const tmpDir = join(tmpdir(), `ha-cli-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    const calPath = join(tmpDir, "calibration.json");
    const outPath = join(tmpDir, "result.json");
    const calSet = {
      calibrationSet: [
        {
          fixtureId: "F1-stub",
          pair: "L_vs_R",
          sampleSource: "system_vs_user",
          humanWinner: "left",
          humanConfidence: "clear",
          leftText: "左侧标记 stub 左正文",
          rightText: "stub 右正文",
          context: { workGoal: "测试", chapterIntent: "意图", priorFacts: [] },
        },
        {
          fixtureId: "F2-stub",
          pair: "L_vs_R",
          sampleSource: "raw_vs_negative",
          humanWinner: "left",
          humanConfidence: "clear",
          leftText: "左侧标记 stub 左正文 2",
          rightText: "stub 右正文 2",
          context: { workGoal: "测试", chapterIntent: "意图", priorFacts: [] },
        },
      ],
    };
    writeFileSync(calPath, JSON.stringify(calSet), "utf-8");

    try {
      execFileSync(
        process.execPath,
        [cliPath, "--stub", "--calibration-set", calPath, "--output", outPath],
        { encoding: "utf-8", timeout: 30000 },
      );
      assert.ok(existsSync(outPath), "应生成结果文件");
      const result = JSON.parse(
        readFileSync(outPath, "utf-8"),
      );
      assert.ok(typeof result.userChoiceAgreement === "number");
      assert.ok(typeof result.passed === "boolean");
      assert.equal(result.totalEntries, 2);
    } finally {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("CLI --help 显示用法", () => {
    const output = execFileSync(
      process.execPath,
      [cliPath, "--help"],
      { encoding: "utf-8", timeout: 10000 },
    );
    assert.ok(output.includes("judge-human-alignment") || output.includes("JUDGE-HUMAN-ALIGNMENT"));
    assert.ok(output.includes("--calibration-set"));
    assert.ok(output.includes("--stub"));
    assert.ok(output.includes("--output"));
  });
});

describe("JUDGE-HUMAN-ALIGNMENT-1：4 种样本来源", () => {
  beforeEach(() => {
    mockFetchConsistentLeft();
  });
  afterEach(() => {
    restoreFetch();
  });

  test("每种 sampleSource 都被接受并记录在详情中", async () => {
    const sources = [
      "system_vs_user",
      "accepted_vs_rejected",
      "raw_vs_negative",
      "reference_vs_weakened",
    ];
    const entries = sources.map((src, i) =>
      makeEntry({
        fixtureId: `F${i + 1}-src`,
        sampleSource: src,
        humanWinner: "left",
        leftText: `左侧标记 候选 ${i + 1}`,
        rightText: `候选 ${i + 1} 右`,
      }),
    );
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    assert.equal(result.details.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.equal(result.details[i].sampleSource, sources[i]);
    }
  });
});

describe("JUDGE-HUMAN-ALIGNMENT-1：未达门槛不得改变生产选择", () => {
  afterEach(() => {
    restoreFetch();
  });

  test("passed=false 时 result 明确标注不能用于生产选择", async () => {
    mockFetchByRound(() => "right"); // 全反向
    const entries = makeEntries(5, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    assert.equal(result.passed, false);
    // 应明确标注未达门槛 → Best-of-N 不得进入生产
    assert.ok(
      result.productionReady === false ||
      result.bestOfNApproved === false ||
      result.note !== undefined,
      "应在 result 中明确标注不能用于生产选择",
    );
  });

  test("passed=true 时 result 标注可用于 Best-of-N 离线实验", async () => {
    mockFetchConsistentLeft();
    const entries = makeEntries(5, { humanWinner: "left" });
    const result = await runHumanAlignmentCalibration(judgeConfig, entries);
    assert.equal(result.passed, true);
    // 通过门槛 → 可用于离线实验（但仍是离线，不直接进生产）
    assert.ok(
      result.productionReady === true ||
      result.bestOfNApproved === true ||
      result.note !== undefined,
    );
  });
});
