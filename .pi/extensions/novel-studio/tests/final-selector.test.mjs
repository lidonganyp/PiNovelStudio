/**
 * P8 FinalSelector 测试
 *
 * 验收口径（计划 Task 9）：
 * - v2 amplified 明显胜出 → positive，交付 amplified
 * - v2 amplified 未明显胜出 → neutral，保留 rawStage2
 * - rawStage2 获胜 → negative（v2 输 rawStage2）
 * - direct 获胜 → negative（项目链路负收益）
 * - comparator 拒绝不覆盖：selectedCandidateId 只指向最终交付候选
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FinalSelector,
  createFinalSelector,
  classifyCandidateSource,
  DEFAULT_CLEAR_WIN_THRESHOLD,
} from "../dist/v2/core/final-selector.js";

// ============================================================================
// 测试 fixtures
// ============================================================================

function makeCandidate(id, source, scoreOverrides = {}) {
  // 与 legacy-model-route-adapter V2_ROUTES + candidate-generator.routeForKind 对齐：
  // route 权威，kind 兜底。rawStage2 候选 kind=context_enhanced（走 v2_rawstage2 路由）。
  const routeMap = {
    direct: "v2_direct_gpt",
    rawStage2: "v2_rawstage2",
    amplified: "v2_amplified",
  };
  const kindMap = {
    direct: "direct_baseline",
    rawStage2: "context_enhanced",
    amplified: "scene_contract",
  };
  return {
    id,
    kind: kindMap[source],
    text: `text-${id}`,
    model: "stub",
    route: routeMap[source],
    promptProfile: {
      type: "editorial",
      tokensIn: 100,
      containsDialogueRatio: false,
      containsParagraphLengthConstraint: false,
      contractIds: [],
    },
    contextHash: `h-${id}`,
    generatedAt: "2026-07-08T00:00:00Z",
    durationMs: 100,
    ...scoreOverrides,
  };
}

function makeDimensionScores(score) {
  // 11 维统一分数，便于测试控制总分
  return {
    chineseNaturalness: score,
    webnovelRhythm: score,
    eventProgression: score,
    characterAgency: score,
    ensembleQuality: score,
    payoffQuality: score,
    hookQuality: score,
    infoRelease: score,
    emotionalPayoff: score,
    continuity: score,
    antiRegression: score,
  };
}

function makeComparison(winnerId, dimensionScoresByCandidate, options = {}) {
  const ids = Object.keys(dimensionScoresByCandidate);
  const totals = ids.map((id) => {
    const s = dimensionScoresByCandidate[id];
    return { id, total: Math.round(Object.values(s).reduce((a, b) => a + b, 0) / 11) };
  });
  totals.sort((a, b) => b.total - a.total);
  const winner = totals[0];
  const second = totals[1];
  const confidence = second ? Math.min(1, (winner.total - second.total) / 100) : 1;
  return {
    winnerId,
    loserIds: ids.filter((id) => id !== winnerId),
    confidence,
    dimensionScores: dimensionScoresByCandidate,
    acceptedRepairs: options.acceptedRepairs || [],
    rejectedRepairs: options.rejectedRepairs || [],
    reasons: options.reasons || [`winner=${winnerId} totalScore=${winner.total}`],
  };
}

// ============================================================================
// classifyCandidateSource 测试
// ============================================================================

test("P8: classifyCandidateSource - direct baseline", () => {
  const c = makeCandidate("d1", "direct");
  assert.equal(classifyCandidateSource(c), "direct");
});

test("P8: classifyCandidateSource - rawStage2", () => {
  const c = makeCandidate("r1", "rawStage2");
  assert.equal(classifyCandidateSource(c), "rawStage2");
});

test("P8: classifyCandidateSource - amplified", () => {
  const c = makeCandidate("a1", "amplified");
  assert.equal(classifyCandidateSource(c), "v2_amplified");
});

test("P8: classifyCandidateSource - context_enhanced 归为 rawStage2（route 权威）", () => {
  // context_enhanced 候选走 v2_rawstage2 路由 → 分类为 rawStage2（非 amplified）
  const c = makeCandidate("ce1", "rawStage2");
  c.kind = "context_enhanced";
  assert.equal(classifyCandidateSource(c), "rawStage2");
});

test("P8: classifyCandidateSource - context_enhanced 无 route 时按 kind 兜底为 rawStage2", () => {
  const c = makeCandidate("ce1", "rawStage2");
  c.kind = "context_enhanced";
  c.route = "";
  assert.equal(classifyCandidateSource(c), "rawStage2");
});

// ============================================================================
// 判定矩阵测试
// ============================================================================

test("P8: amplified 明显胜出 → positive，交付 amplified", () => {
  const selector = new FinalSelector();
  // amplified 90, rawStage2 70 → 差距 20 >= 5（默认阈值）
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(90),
    r1: makeDimensionScores(70),
    d1: makeDimensionScores(50),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.equal(result.selectedSource, "v2_amplified");
  assert.equal(result.projectGain, "positive");
  assert.equal(result.selectedCandidateId, "a1");
});

test("P8: amplified 获胜但未明显胜出 → neutral，保留 rawStage2", () => {
  const selector = new FinalSelector();
  // amplified 72, rawStage2 70 → 差距 2 < 5（默认阈值）
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(72),
    r1: makeDimensionScores(70),
    d1: makeDimensionScores(50),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.equal(result.selectedSource, "rawStage2");
  assert.equal(result.projectGain, "neutral");
  assert.equal(result.selectedCandidateId, "r1");
  // amplified 不覆盖原文
  assert.ok(
    result.whyRejected.some((r) => r.includes("未明显胜出") || r.includes("不覆盖")),
    `应说明 amplified 未覆盖原文，实际 ${JSON.stringify(result.whyRejected)}`
  );
});

test("P8: rawStage2 获胜 → negative（v2 输 rawStage2）", () => {
  const selector = new FinalSelector();
  // rawStage2 80, amplified 70 → rawStage2 获胜
  const comparison = makeComparison("r1", {
    a1: makeDimensionScores(70),
    r1: makeDimensionScores(80),
    d1: makeDimensionScores(50),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.equal(result.selectedSource, "rawStage2");
  assert.equal(result.projectGain, "negative");
  assert.equal(result.selectedCandidateId, "r1");
});

test("P8: direct 获胜 → negative（项目链路负收益）", () => {
  const selector = new FinalSelector();
  // direct 90, rawStage2 70, amplified 60 → direct 获胜
  const comparison = makeComparison("d1", {
    a1: makeDimensionScores(60),
    r1: makeDimensionScores(70),
    d1: makeDimensionScores(90),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.equal(result.selectedSource, "direct");
  assert.equal(result.projectGain, "negative");
  assert.equal(result.selectedCandidateId, "d1");
});

// ============================================================================
// 边界场景测试
// ============================================================================

test("P8: 无 amplified 候选时 rawStage2 获胜 → negative", () => {
  const selector = new FinalSelector();
  const comparison = makeComparison("r1", {
    r1: makeDimensionScores(80),
    d1: makeDimensionScores(50),
  });
  const candidates = [
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.equal(result.selectedSource, "rawStage2");
  assert.equal(result.projectGain, "negative");
});

test("P8: 无 rawStage2 候选时 amplified 明显胜出 → positive", () => {
  const selector = new FinalSelector();
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(90),
    d1: makeDimensionScores(50),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.equal(result.selectedSource, "v2_amplified");
  assert.equal(result.projectGain, "positive");
});

test("P8: 空候选列表 → negative", () => {
  const selector = new FinalSelector();
  const result = selector.select({
    comparison: {
      winnerId: "",
      loserIds: [],
      confidence: 0,
      dimensionScores: {},
      acceptedRepairs: [],
      rejectedRepairs: [],
      reasons: [],
    },
    candidates: [],
  });
  assert.equal(result.selectedSource, "direct");
  assert.equal(result.projectGain, "negative");
  assert.equal(result.selectedCandidateId, "");
});

test("P8: winnerId 不在候选列表 → negative", () => {
  const selector = new FinalSelector();
  const comparison = makeComparison("ghost", {
    a1: makeDimensionScores(90),
  });
  const candidates = [makeCandidate("a1", "amplified")];
  const result = selector.select({ comparison, candidates });
  assert.equal(result.projectGain, "negative");
});

// ============================================================================
// 自定义阈值测试
// ============================================================================

test("P8: 自定义 clearWinThreshold=10 → 差距 8 未明显胜出", () => {
  const selector = new FinalSelector();
  // amplified 78, rawStage2 70 → 差距 8 < 10
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(78),
    r1: makeDimensionScores(70),
    d1: makeDimensionScores(50),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({
    comparison,
    candidates,
    clearWinThreshold: 10,
  });
  // 差距 8 < 10 → neutral，保留 rawStage2
  assert.equal(result.projectGain, "neutral");
  assert.equal(result.selectedSource, "rawStage2");
});

test("P8: 自定义 clearWinThreshold=10 → 差距 15 明显胜出", () => {
  const selector = new FinalSelector();
  // amplified 85, rawStage2 70 → 差距 15 >= 10
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(85),
    r1: makeDimensionScores(70),
    d1: makeDimensionScores(50),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({
    comparison,
    candidates,
    clearWinThreshold: 10,
  });
  assert.equal(result.projectGain, "positive");
  assert.equal(result.selectedSource, "v2_amplified");
});

// ============================================================================
// repairs 透传测试
// ============================================================================

test("P8: acceptedRepairs/rejectedRepairs 透传到 FinalSelectionReport", () => {
  const selector = new FinalSelector();
  const acceptedRepairs = [
    {
      candidateId: "a1",
      repair: { kind: "sentence_patch", span: { start: 0, end: 10 }, reason: "去重", expectedGain: "消除重复", possibleDamage: "微小" },
      reason: "accepted",
      dimensionDelta: {},
    },
  ];
  const rejectedRepairs = [
    {
      candidateId: "r1",
      repair: { kind: "chapter_rewrite", reason: "catastrophic_only", failureEvidence: "不可修" },
      reason: "rejected",
      dimensionDelta: {},
    },
  ];
  const comparison = makeComparison(
    "a1",
    {
      a1: makeDimensionScores(90),
      r1: makeDimensionScores(70),
      d1: makeDimensionScores(50),
    },
    { acceptedRepairs, rejectedRepairs }
  );
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.equal(result.acceptedRepairs.length, 1);
  assert.equal(result.rejectedRepairs.length, 1);
  assert.equal(result.acceptedRepairs[0].candidateId, "a1");
  assert.equal(result.rejectedRepairs[0].candidateId, "r1");
});

// ============================================================================
// whySelected / whyRejected 测试
// ============================================================================

test("P8: whySelected 包含总分差距信息", () => {
  const selector = new FinalSelector();
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(90),
    r1: makeDimensionScores(70),
    d1: makeDimensionScores(50),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.ok(result.whySelected.length > 0);
  assert.ok(
    result.whySelected.some((r) => r.includes("amplifiedScore") || r.includes("明显胜出")),
    `whySelected 应包含总分信息，实际 ${JSON.stringify(result.whySelected)}`
  );
});

test("P8: whyRejected 说明未交付候选原因", () => {
  const selector = new FinalSelector();
  // rawStage2 获胜
  const comparison = makeComparison("r1", {
    a1: makeDimensionScores(70),
    r1: makeDimensionScores(80),
    d1: makeDimensionScores(50),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.ok(result.whyRejected.length > 0);
  assert.ok(
    result.whyRejected.some((r) => r.includes("v2_amplified") || r.includes("amplified")),
    `whyRejected 应说明 amplified 未胜出，实际 ${JSON.stringify(result.whyRejected)}`
  );
});

// ============================================================================
// 工厂函数测试
// ============================================================================

test("P8: createFinalSelector 工厂函数可用", () => {
  const selector = createFinalSelector();
  assert.ok(selector instanceof FinalSelector);
});

test("P8: DEFAULT_CLEAR_WIN_THRESHOLD = 5", () => {
  assert.equal(DEFAULT_CLEAR_WIN_THRESHOLD, 5);
});

// ============================================================================
// 综合场景测试
// ============================================================================

test("P8: 综合场景 - 多 amplified 候选 + rawStage2 + direct", () => {
  const selector = new FinalSelector();
  // 3 个 amplified 候选，最高分 95；rawStage2 75；direct 60
  // amplified 95 - rawStage2 75 = 20 >= 5（scoreDiff 门槛）
  // confidence = (95-80)/100 = 0.15 >= 0.15（confidence 门槛，second=a3=80）
  // winner 无 hard 诊断（hardDiags 门槛）
  // → 三重门槛通过 → positive
  const comparison = makeComparison("a2", {
    a1: makeDimensionScores(78),
    a2: makeDimensionScores(95),
    a3: makeDimensionScores(80),
    r1: makeDimensionScores(75),
    d1: makeDimensionScores(60),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("a2", "amplified"),
    makeCandidate("a3", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.equal(result.selectedSource, "v2_amplified");
  assert.equal(result.projectGain, "positive");
  assert.equal(result.selectedCandidateId, "a2");
});

test("P8: 综合场景 - amplified 微弱胜出但未明显胜出 → neutral", () => {
  const selector = new FinalSelector();
  // amplified 77, rawStage2 75 → 差距 2 < 5 → neutral
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(77),
    a2: makeDimensionScores(73),
    r1: makeDimensionScores(75),
    d1: makeDimensionScores(60),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("a2", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.equal(result.projectGain, "neutral");
  assert.equal(result.selectedSource, "rawStage2");
  assert.equal(result.selectedCandidateId, "r1");
});

// ============================================================================
// 三重门槛测试（Issue #3 / #5：confidence floor + hard diagnostics）
// ============================================================================

test("P8: confidence 低于 floor 不得判 positive（Issue #3）", () => {
  const selector = new FinalSelector();
  // amplified 90, rawStage2 88 → scoreDiff=2 < 5 同时 confidence=(90-88)/100=0.02 < 0.15
  // 但即使把 scoreDiff 拉够，单独 confidence 不足也应阻断 positive。
  // 这里 amplified 95, rawStage2 80, second=rawStage2=80 → scoreDiff=15>=5, confidence=0.15
  // 再构造 amplified 96, rawStage2 95 → scoreDiff=1<5, confidence=0.01<0.15
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(96),
    r1: makeDimensionScores(95),
    d1: makeDimensionScores(50),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  // confidence=0.01 < 0.15 → 未明显胜出 → neutral，保留 rawStage2
  assert.equal(result.projectGain, "neutral", `confidence 不足应 neutral，实际 ${result.projectGain}`);
  assert.equal(result.selectedSource, "rawStage2");
  assert.ok(
    result.whyRejected.some((r) => r.includes("confidence")),
    `whyRejected 应说明 confidence 不足，实际 ${JSON.stringify(result.whyRejected)}`
  );
});

test("P8: scoreDiff 足够但 confidence 不足 → neutral（隔离 confidence 门槛）", () => {
  const selector = new FinalSelector();
  // amplified 90, rawStage2 75 → scoreDiff=15>=5
  // 但 second 也是 rawStage2=75 → confidence=(90-75)/100=0.15 正好在 floor
  // 构造 amplified 90, rawStage2 89 → scoreDiff=1<5, confidence=0.01<0.15
  // 改为 amplified 95, rawStage2 80, direct 94 → second=direct=94, confidence=(95-94)/100=0.01<0.15
  // scoreDiff(amplified-rawStage2)=15>=5 但 confidence 不足
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(95),
    r1: makeDimensionScores(80),
    d1: makeDimensionScores(94),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.equal(result.projectGain, "neutral", `scoreDiff 足但 confidence 不足应 neutral，实际 ${result.projectGain}`);
  assert.equal(result.selectedSource, "rawStage2");
});

test("P8: winner 带 hard 诊断不得判 positive（Issue #5）", () => {
  const selector = new FinalSelector();
  // amplified 95, rawStage2 70 → scoreDiff=25>=5, confidence=0.25>=0.15
  // 但 winner a1 带 1 条 hard 诊断 → hardDiagsOk=false → 未明显胜出 → neutral
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(95),
    r1: makeDimensionScores(70),
    d1: makeDimensionScores(50),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const hardDiag = { severity: "hard", candidateId: "a1", code: "entity_hallucination", message: "未注册角色" };
  const result = selector.select({
    comparison,
    candidates,
    hardDiagnosticsByCandidate: { a1: [hardDiag] },
  });
  assert.equal(result.projectGain, "neutral", `winner 带 hard 诊断应 neutral，实际 ${result.projectGain}`);
  assert.equal(result.selectedSource, "rawStage2");
  assert.ok(
    result.whyRejected.some((r) => r.includes("hard") || r.includes("诊断")),
    `whyRejected 应说明 hard 诊断阻断，实际 ${JSON.stringify(result.whyRejected)}`
  );
});

test("P8: winner 无 hard 诊断但其他候选有 hard 诊断不影响 positive", () => {
  const selector = new FinalSelector();
  // amplified 95 winner 无 hard 诊断；rawStage2 候选带 hard 诊断（不影响 winner 判定）
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(95),
    r1: makeDimensionScores(70),
    d1: makeDimensionScores(50),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const hardDiag = { severity: "hard", candidateId: "r1", code: "entity_hallucination", message: "未注册角色" };
  const result = selector.select({
    comparison,
    candidates,
    hardDiagnosticsByCandidate: { r1: [hardDiag] },
  });
  assert.equal(result.projectGain, "positive", `winner 无 hard 诊断应 positive，实际 ${result.projectGain}`);
  assert.equal(result.selectedSource, "v2_amplified");
});

test("P8: 自定义 confidenceFloor=0 可放宽 confidence 门槛", () => {
  const selector = new FinalSelector();
  // amplified 96, rawStage2 95 → confidence=0.01 < 默认 0.15
  // 但 confidenceFloor=0 → confidence 门槛关闭，scoreDiff=1<5 仍阻断
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(96),
    r1: makeDimensionScores(95),
    d1: makeDimensionScores(50),
  });
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({
    comparison,
    candidates,
    confidenceFloor: 0,
  });
  // confidence 门槛关闭，但 scoreDiff=1 < 5 → 仍 neutral
  assert.equal(result.projectGain, "neutral");
  assert.equal(result.selectedSource, "rawStage2");
});

// ============================================================================
// P2 第 4 门测试：antiRegression 退化防护
// ============================================================================

test("P2: amplified 总分胜出但 antiRegression=80 + regressedChecks → neutral（第 4 门阻断）", () => {
  const selector = new FinalSelector();
  // amplified 95, rawStage2 70 → scoreDiff=25>=5, confidence=0.25>=0.15, hard=0
  // 但 antiRegression=80 < 95 且 regressedChecks=[agency_dilution] → 第 4 门未过
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(95),
    r1: makeDimensionScores(70),
    d1: makeDimensionScores(50),
  });
  comparison.antiRegressionDetailsByCandidate = {
    a1: { score: 80, regressedChecks: ["agency_dilution"] },
  };
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  // 第 4 门未过 → neutral，保留 rawStage2
  assert.equal(result.projectGain, "neutral", `antiRegression 不足应 neutral，实际 ${result.projectGain}`);
  assert.equal(result.selectedSource, "rawStage2");
  assert.ok(
    result.whyRejected.some((r) => r.includes("antiRegression")),
    `whyRejected 应说明 antiRegression 阻断，实际 ${JSON.stringify(result.whyRejected)}`
  );
});

test("P2: amplified 总分胜出 + antiRegression=100 + regressedChecks=[] → positive", () => {
  const selector = new FinalSelector();
  // amplified 95, rawStage2 70 → scoreDiff=25>=5, confidence=0.25>=0.15, hard=0
  // antiRegression=100, regressedChecks=[] → 第 4 门通过（无退化证据）
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(95),
    r1: makeDimensionScores(70),
    d1: makeDimensionScores(50),
  });
  comparison.antiRegressionDetailsByCandidate = {
    a1: { score: 100, regressedChecks: [] },
  };
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.equal(result.projectGain, "positive");
  assert.equal(result.selectedSource, "v2_amplified");
  assert.ok(
    result.whySelected.some((r) => r.includes("antiRegression")),
    `whySelected 应包含 antiRegression 信息，实际 ${JSON.stringify(result.whySelected)}`
  );
});

test("P2: amplified 总分胜出 + antiRegressionDetailsByCandidate 缺失 → positive（旧 trace 向后兼容）", () => {
  const selector = new FinalSelector();
  // amplified 95, rawStage2 70 → scoreDiff=25>=5, confidence=0.25>=0.15, hard=0
  // comparison 无 antiRegressionDetailsByCandidate 字段（旧 trace 兼容）→ 按无退化证据处理 → 通过
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(95),
    r1: makeDimensionScores(70),
    d1: makeDimensionScores(50),
  });
  // 故意不设置 antiRegressionDetailsByCandidate
  assert.ok(!comparison.antiRegressionDetailsByCandidate, "旧 trace 无此字段");
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  assert.equal(result.projectGain, "positive", `旧 trace 兼容应 positive，实际 ${result.projectGain}`);
  assert.equal(result.selectedSource, "v2_amplified");
});

test("P2: amplified 总分胜出 + antiRegression=90 + regressedChecks（<95 但 >80）→ neutral", () => {
  const selector = new FinalSelector();
  // antiRegression=90, regressedChecks=[paragraph_rhythm] → 90<95 未过第 4 门，但 90>=80 不算严重退化
  const comparison = makeComparison("a1", {
    a1: makeDimensionScores(95),
    r1: makeDimensionScores(70),
    d1: makeDimensionScores(50),
  });
  comparison.antiRegressionDetailsByCandidate = {
    a1: { score: 90, regressedChecks: ["paragraph_rhythm"] },
  };
  const candidates = [
    makeCandidate("a1", "amplified"),
    makeCandidate("r1", "rawStage2"),
    makeCandidate("d1", "direct"),
  ];
  const result = selector.select({ comparison, candidates });
  // 90<95 → 第 4 门未过 → neutral（非 negative，因为 90>=80 不算严重退化）
  assert.equal(result.projectGain, "neutral");
  assert.equal(result.selectedSource, "rawStage2");
});
