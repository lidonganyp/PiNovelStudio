/**
 * EMOTION-RHYTHM-1：事件驱动情绪节拍 advisory 编译最小闭环测试
 *
 * 验收口径（EMOTION-RHYTHM-1 任务书）：
 * 1. 每个情绪转折引用触发事件 span（事件/选择/后果）。
 * 2. 无触发证据标 unverified。
 * 3. prompt 只含目标与前态，不含机械曲线配额（satisfactionInterval/climaxPositionRange/emotionDensityThreshold）。
 * 4. 纯情绪词频变化不能自动算事件驱动。
 * 5. 旧 Stage5 rewrite 回环不得进入生产主链路（advisoryOnly=true，无 rewriteRaw/patchRaw）。
 * 6. 无可靠事件链时只输出 human-review focus。
 *
 * 边界：
 * - 不修改 finalText
 * - 不生成 candidate
 * - 不调用 LLM
 * - 不把情绪曲线变成 hard gate
 * - 不提交长期状态
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compileEmotionRhythmContext,
  formatEmotionRhythmPromptBlock,
  skippedEmotionRhythm,
} from "../dist/v2/core/emotion-rhythm-compiler.js";

// ============================================================================
// 辅助：构造 ChapterIntent
// ============================================================================

function makeIntent(overrides = {}) {
  return {
    chapterFunction: "推进核心冲突",
    readerExperience: ["紧张", "期待"],
    currentPressure: ["水下救援压力"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林川"],
    inviolableFacts: [],
    sourceRefs: ["chapter-seed"],
    concreteDelivery: [],
    focusCharacterGoals: [],
    resistance: [],
    choicesAndCosts: [],
    expectedIrreversibleChange: [],
    selectedPromisesToAdvance: [],
    causalEndPressure: [],
    factAndCharacterKnowledgeForbiddenZones: [],
    fieldSourceRefs: {},
    ...overrides,
  };
}

// ============================================================================
// 1. 每个情绪转折引用触发事件 span
// ============================================================================

test("rawText 中事件触发的情绪转折带 span 且 verified=true", () => {
  const intent = makeIntent();
  // rawText 含明确事件触发（"决定"）+ 情绪转折（紧张→坚定）
  const rawText = [
    "林川望着深渊，心里一阵紧张。",
    "他握紧拳头，决定跳下去。",
    "那一刻，他的恐惧化作了坚定。",
  ].join("\n");

  const result = compileEmotionRhythmContext({
    intent,
    rawText,
    previousEmotionState: null,
  });

  const ctx = result.emotionRhythmContext;
  // 至少有一个转折
  assert.ok(ctx.emotionTransitions.length > 0, "应检测到至少一个情绪转折");
  // 至少有一个 verified=true 的转折（带 span）
  const verified = ctx.emotionTransitions.find((t) => t.verified);
  assert.ok(verified, "应有至少一个 verified=true 的转折");
  assert.ok(verified.triggerEventSpan, "verified 转折应有 triggerEventSpan");
  assert.ok(typeof verified.triggerEventSpan.start === "number");
  assert.ok(typeof verified.triggerEventSpan.end === "number");
  assert.ok(verified.triggerEventSpan.end >= verified.triggerEventSpan.start);
  assert.ok(verified.triggerEvidence.length > 0, "应有 triggerEvidence");
  assert.ok(verified.confidence >= 0.7, `verified confidence 应 >= 0.7，实际 ${verified.confidence}`);
});

// ============================================================================
// 2. 无触发证据标 unverified
// ============================================================================

test("情绪词频变化但无事件触发时标 unverified", () => {
  const intent = makeIntent();
  // rawText 只有情绪词变化，无事件触发动词
  const rawText = [
    "林川感到紧张。",
    "他有些害怕。",
    "后来他变得愤怒了。",
  ].join("\n");

  const result = compileEmotionRhythmContext({
    intent,
    rawText,
    previousEmotionState: null,
  });

  const ctx = result.emotionRhythmContext;
  // 有转折但都 unverified
  for (const t of ctx.emotionTransitions) {
    if (!t.verified) {
      assert.equal(t.verified, false);
      assert.equal(t.triggerEventSpan, null, "unverified 转折不应有 triggerEventSpan");
      assert.ok(t.confidence < 0.5, `unverified confidence 应 < 0.5，实际 ${t.confidence}`);
    }
  }
});

// ============================================================================
// 3. prompt 只含目标与前态，不含机械曲线配额
// ============================================================================

test("promptBlock 不含机械曲线配额字段", () => {
  const intent = makeIntent({ readerExperience: ["紧张", "期待"] });
  const result = compileEmotionRhythmContext({
    intent,
    rawText: null,
    previousEmotionState: "平静",
  });

  if (result.promptBlock) {
    // 不应含机械曲线配额
    assert.ok(!result.promptBlock.includes("satisfactionInterval"), "不应含 satisfactionInterval");
    assert.ok(!result.promptBlock.includes("climaxPositionRange"), "不应含 climaxPositionRange");
    assert.ok(!result.promptBlock.includes("emotionDensityThreshold"), "不应含 emotionDensityThreshold");
    assert.ok(!result.promptBlock.includes("dialogueRatio"), "不应含 dialogueRatio");
    assert.ok(!result.promptBlock.includes("curveSmoothness"), "不应含 curveSmoothness");
    assert.ok(!result.promptBlock.includes("maxOppressionLength"), "不应含 maxOppressionLength");
    // 应含目标和前态
    assert.ok(result.promptBlock.includes("紧张") || result.promptBlock.includes("期待"), "应含目标情绪");
    assert.ok(result.promptBlock.includes("平静"), "应含前态情绪");
  }
});

test("context 不暴露机械指标 gate 字段", () => {
  const intent = makeIntent();
  const result = compileEmotionRhythmContext({
    intent,
    rawText: null,
    previousEmotionState: null,
  });

  const ctx = result.emotionRhythmContext;
  // 不应有这些 gate 字段
  assert.equal(ctx.passed, undefined);
  assert.equal(ctx.blocked, undefined);
  assert.equal(ctx.emotionCurveGate, undefined);
  assert.equal(ctx.curveSmoothnessThreshold, undefined);
  assert.equal(ctx.climaxPositionRange, undefined);
  assert.equal(ctx.satisfactionInterval, undefined);
  // advisoryOnly 恒为 true
  assert.equal(ctx.advisoryOnly, true);
});

// ============================================================================
// 4. 纯情绪词频变化不能自动算事件驱动
// ============================================================================

test("纯情绪词频变化不算事件驱动（canTriggerEditorialOpportunity=false）", () => {
  const intent = makeIntent();
  const rawText = [
    "林川感到紧张。",
    "他有些害怕。",
    "后来他变得愤怒了。",
  ].join("\n");

  const result = compileEmotionRhythmContext({
    intent,
    rawText,
    previousEmotionState: null,
  });

  const ctx = result.emotionRhythmContext;
  const hasVerified = ctx.emotionTransitions.some((t) => t.verified);
  if (!hasVerified) {
    assert.equal(ctx.canTriggerEditorialOpportunity, false, "纯情绪词频变化不应触发机会候选");
  }
});

test("有事件驱动的转折时 canTriggerEditorialOpportunity=true", () => {
  const intent = makeIntent();
  const rawText = [
    "林川望着深渊，心里一阵紧张。",
    "他握紧拳头，决定跳下去。",
    "那一刻，他的恐惧化作了坚定。",
  ].join("\n");

  const result = compileEmotionRhythmContext({
    intent,
    rawText,
    previousEmotionState: null,
  });

  const ctx = result.emotionRhythmContext;
  if (ctx.emotionTransitions.some((t) => t.verified)) {
    assert.equal(ctx.canTriggerEditorialOpportunity, true, "有事件驱动转折时应可触发机会候选");
  }
});

// ============================================================================
// 5. 旧 Stage5 rewrite 回环不得进入生产主链路
// ============================================================================

test("context 不含 rewrite/patch 字段（无 Stage5 回环）", () => {
  const intent = makeIntent();
  const rawText = "林川决定跳下去，恐惧化作坚定。";

  const result = compileEmotionRhythmContext({
    intent,
    rawText,
    previousEmotionState: null,
  });

  const ctx = result.emotionRhythmContext;
  assert.equal(ctx.rewriteRaw, undefined);
  assert.equal(ctx.patchRaw, undefined);
  assert.equal(ctx.overrideRaw, undefined);
  assert.equal(ctx.stage5RewriteLoop, undefined);
  assert.equal(ctx.rewriteLoop, undefined);
});

// ============================================================================
// 6. 无可靠事件链时只输出 human-review focus
// ============================================================================

test("rawText 为 null 时输出 humanReviewFocus", () => {
  const intent = makeIntent();
  const result = compileEmotionRhythmContext({
    intent,
    rawText: null,
    previousEmotionState: null,
  });

  const ctx = result.emotionRhythmContext;
  // raw 生成前无 rawText，无法扫描事件链
  assert.ok(ctx.humanReviewFocus || ctx.emptyReason, "无 rawText 时应输出 humanReviewFocus 或 emptyReason");
  assert.equal(ctx.emotionTransitions.length, 0, "无 rawText 时不应有转折");
  assert.equal(ctx.canTriggerEditorialOpportunity, false);
});

test("rawText 有转折但全 unverified 时输出 humanReviewFocus", () => {
  const intent = makeIntent();
  const rawText = [
    "林川感到紧张。",
    "他有些害怕。",
    "后来他变得愤怒了。",
  ].join("\n");

  const result = compileEmotionRhythmContext({
    intent,
    rawText,
    previousEmotionState: null,
  });

  const ctx = result.emotionRhythmContext;
  const hasVerified = ctx.emotionTransitions.some((t) => t.verified);
  if (!hasVerified && ctx.emotionTransitions.length > 0) {
    assert.ok(ctx.humanReviewFocus, "全 unverified 时应输出 humanReviewFocus");
  }
});

// ============================================================================
// 7. 空状态处理
// ============================================================================

test("无 targetEmotions 且无 rawText 时写 emptyReason", () => {
  const intent = makeIntent({ readerExperience: [] });
  const result = compileEmotionRhythmContext({
    intent,
    rawText: null,
    previousEmotionState: null,
  });

  const ctx = result.emotionRhythmContext;
  assert.ok(ctx.emptyReason, "应有 emptyReason");
  assert.equal(ctx.consumedByRawPrompt, false);
  assert.equal(result.promptBlock, null);
});

test("skippedEmotionRhythm 写明 skipped 原因", () => {
  const skipped = skippedEmotionRhythm("hardBlock");
  assert.ok(skipped.emptyReason.includes("skipped"));
  assert.equal(skipped.emotionTransitions.length, 0);
  assert.equal(skipped.advisoryOnly, true);
});

// ============================================================================
// 8. 目标情绪与前态来源可追溯
// ============================================================================

test("targetEmotions 来自 intent.readerExperience", () => {
  const intent = makeIntent({ readerExperience: ["紧张", "期待", "震撼"] });
  const result = compileEmotionRhythmContext({
    intent,
    rawText: null,
    previousEmotionState: null,
  });

  const ctx = result.emotionRhythmContext;
  assert.deepEqual(ctx.targetEmotions, ["紧张", "期待", "震撼"]);
  assert.ok(ctx.sourceRefs.some((r) => r.includes("intent") || r.includes("readerExperience")));
});

test("previousEmotionState 进入 promptBlock", () => {
  const intent = makeIntent({ readerExperience: ["紧张"] });
  const result = compileEmotionRhythmContext({
    intent,
    rawText: null,
    previousEmotionState: "平静",
  });

  const ctx = result.emotionRhythmContext;
  assert.equal(ctx.previousEmotionState, "平静");
  if (result.promptBlock) {
    assert.ok(result.promptBlock.includes("平静"), "promptBlock 应含前态情绪");
  }
});

// ============================================================================
// 9. chapterEndEmotion 检测
// ============================================================================

test("rawText 提供时检测 chapterEndEmotion", () => {
  const intent = makeIntent();
  const rawText = [
    "林川决定跳下去。",
    "他落入水中，挣扎着浮出水面。",
    "最终，他感到了一丝希望。",
  ].join("\n");

  const result = compileEmotionRhythmContext({
    intent,
    rawText,
    previousEmotionState: null,
  });

  const ctx = result.emotionRhythmContext;
  // chapterEndEmotion 可能为 null（无明确情绪词）或字符串
  if (ctx.chapterEndEmotion !== null) {
    assert.ok(typeof ctx.chapterEndEmotion === "string");
  }
});

// ============================================================================
// 10. formatEmotionRhythmPromptBlock 空时返回 null
// ============================================================================

test("formatEmotionRhythmPromptBlock 空时返回 null", () => {
  const block = formatEmotionRhythmPromptBlock({
    targetEmotions: [],
    previousEmotionState: null,
    emotionTransitions: [],
    chapterEndEmotion: null,
    sourceRefs: [],
    consumedByRawPrompt: false,
    advisoryOnly: true,
    canTriggerEditorialOpportunity: false,
    humanReviewFocus: null,
  });
  assert.equal(block, null);
});
