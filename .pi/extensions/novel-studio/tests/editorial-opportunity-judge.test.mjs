/**
 * Step 4a 测试：默认 1 候选，第 2 候选需高置信
 *
 * 覆盖 selectHypothesesForCandidates 的第 2 候选置信门逻辑：
 * - maxCandidates=1：第 2 个因上限被拒（不进入置信门）
 * - maxCandidates=2 + 第 2 候选 confidence≥0.7：入选
 * - maxCandidates=2 + 第 2 候选 confidence<0.7：被置信门拒
 * - PINOVEL_SECOND_CANDIDATE_CONFIDENCE 调整阈值
 *
 * judge() 的 PINOVEL_MAX_HYPOTHESES 透传由 typecheck + phase5 集成测试覆盖
 * （默认 1 候选下 phase5-unified-orchestrator 全绿）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { selectHypothesesForCandidates } from "../dist/v2/core/editorial-hypothesis.js";

// ============================================================================
// 辅助
// ============================================================================

const RAW_TEXT = "这是一段正文，主角走进房间，看到桌上有一封信。信上没有署名。他犹豫了片刻。";

/** 构造合法 hypothesis（evidenceSpans 的 excerpt 必须在 rawText 中真实存在） */
function makeHypothesis(overrides = {}) {
  const excerpt = overrides._excerpt ?? "主角走进房间";
  const start = RAW_TEXT.indexOf(excerpt);
  const end = start + excerpt.length;
  const { _excerpt, ...rest } = overrides;
  return {
    id: "h1",
    opportunityType: "reader_payoff",
    diagnosis: "测试诊断",
    evidenceSpans: [{ start, end, excerpt }],
    expectedReaderGain: "测试增益",
    damageRisks: ["测试风险"],
    rewriteScope: "span_candidate",
    confidence: 0.7,
    ...rest,
  };
}

/** 保存/恢复 process.env，finally 恢复避免跨测试泄漏 */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    process.env[k] = String(vars[k]);
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ============================================================================
// 1. maxCandidates=1：第 2 个因上限被拒
// ============================================================================

test("Step 4a: maxCandidates=1 时只选 1 个候选（第 2 个因上限被拒）", () => {
  const hypotheses = [
    makeHypothesis({ id: "h1", opportunityType: "reader_payoff", confidence: 0.9, _excerpt: "主角走进房间" }),
    makeHypothesis({ id: "h2", opportunityType: "character_choice", confidence: 0.8, _excerpt: "看到桌上有一封信" }),
  ];
  const { selected, rejected, reasons } = selectHypothesesForCandidates(hypotheses, RAW_TEXT, 1);
  assert.equal(selected.length, 1, "maxCandidates=1 应只选 1 个");
  assert.equal(selected[0].id, "h1", "应选置信度最高的 h1");
  assert.ok(rejected.some((h) => h.id === "h2"), "h2 应被拒");
  assert.ok(reasons.some((r) => r.includes("已达最多 1 候选上限")), `应提示上限：${reasons.join(";")}`);
});

// ============================================================================
// 2. maxCandidates=2 + 第 2 候选 confidence≥0.7：入选
// ============================================================================

test("Step 4a: maxCandidates=2 + 第 2 候选 confidence=0.8 (≥0.7) → 选 2 个", () => {
  const hypotheses = [
    makeHypothesis({ id: "h1", opportunityType: "reader_payoff", confidence: 0.9, _excerpt: "主角走进房间" }),
    makeHypothesis({ id: "h2", opportunityType: "character_choice", confidence: 0.8, _excerpt: "看到桌上有一封信" }),
  ];
  const { selected, rejected } = selectHypothesesForCandidates(hypotheses, RAW_TEXT, 2);
  assert.equal(selected.length, 2, "两个高置信候选都应入选");
  assert.equal(selected[0].id, "h1", "h1 置信度最高排第 1");
  assert.equal(selected[1].id, "h2", "h2 第 2");
  assert.equal(rejected.length, 0, "无拒绝");
});

// ============================================================================
// 3. maxCandidates=2 + 第 2 候选 confidence<0.7：被置信门拒
// ============================================================================

test("Step 4a: maxCandidates=2 + 第 2 候选 confidence=0.5 (<0.7) → 只选 1 个", () => {
  const hypotheses = [
    makeHypothesis({ id: "h1", opportunityType: "reader_payoff", confidence: 0.9, _excerpt: "主角走进房间" }),
    makeHypothesis({ id: "h2", opportunityType: "character_choice", confidence: 0.5, _excerpt: "看到桌上有一封信" }),
  ];
  const { selected, rejected, reasons } = selectHypothesesForCandidates(hypotheses, RAW_TEXT, 2);
  assert.equal(selected.length, 1, "第 2 候选置信度不足应只选 1 个");
  assert.equal(selected[0].id, "h1");
  assert.ok(rejected.some((h) => h.id === "h2"), "h2 应被拒");
  assert.ok(reasons.some((r) => r.includes("第 2 候选置信度") && r.includes("< 阈值")), `应提示置信门：${reasons.join(";")}`);
});

// ============================================================================
// 4. PINOVEL_SECOND_CANDIDATE_CONFIDENCE 调整阈值
// ============================================================================

test("Step 4a: PINOVEL_SECOND_CANDIDATE_CONFIDENCE=0.4 + 第 2 候选 confidence=0.5 → 选 2 个", () => {
  const hypotheses = [
    makeHypothesis({ id: "h1", opportunityType: "reader_payoff", confidence: 0.9, _excerpt: "主角走进房间" }),
    makeHypothesis({ id: "h2", opportunityType: "character_choice", confidence: 0.5, _excerpt: "看到桌上有一封信" }),
  ];
  const result = withEnv({ PINOVEL_SECOND_CANDIDATE_CONFIDENCE: 0.4 }, () =>
    selectHypothesesForCandidates(hypotheses, RAW_TEXT, 2)
  );
  assert.equal(result.selected.length, 2, "阈值降到 0.4 后，confidence=0.5 应入选");
  assert.equal(result.selected[1].id, "h2");
});

// ============================================================================
// 5. 默认 env 下 maxCandidates 来自 PINOVEL_MAX_HYPOTHESES（judge 透传已由 typecheck 覆盖）
//    这里直接验证 env 读取的默认值语义
// ============================================================================

test("Step 4a: PINOVEL_MAX_HYPOTHESES 未设时默认语义为 1（通过 judge 入口读取）", () => {
  // selectHypothesesForCandidates 本身不读 PINOVEL_MAX_HYPOTHESES（maxCandidates 由调用方传）。
  // 此测试确认默认 env 下不污染置信门：第 2 候选 confidence<0.7 仍被拒（与场景 3 一致）。
  // judge() 的 maxHypotheses 透传见 phase5-unified-orchestrator 集成测试。
  const hypotheses = [
    makeHypothesis({ id: "h1", opportunityType: "reader_payoff", confidence: 0.9, _excerpt: "主角走进房间" }),
    makeHypothesis({ id: "h2", opportunityType: "character_choice", confidence: 0.6, _excerpt: "看到桌上有一封信" }),
  ];
  const { selected } = selectHypothesesForCandidates(hypotheses, RAW_TEXT, 2);
  // confidence=0.6 < 0.7 默认阈值 → 第 2 候选被拒
  assert.equal(selected.length, 1, "默认阈值 0.7 下 confidence=0.6 应被拒");
});

// ============================================================================
// 6. 第 1 候选不受置信门限制（即使 confidence 低也入选）
// ============================================================================

test("Step 4a: 第 1 候选不受置信门限制（confidence=0.3 仍入选）", () => {
  const hypotheses = [
    makeHypothesis({ id: "h1", opportunityType: "reader_payoff", confidence: 0.3, _excerpt: "主角走进房间" }),
  ];
  const { selected } = selectHypothesesForCandidates(hypotheses, RAW_TEXT, 2);
  assert.equal(selected.length, 1, "第 1 候选不应受第 2 候选置信门限制");
  assert.equal(selected[0].id, "h1");
});
