/**
 * EXPECTATION-LEDGER-1：读者期待账本编译与 final-only commit 最小闭环测试
 *
 * 验收口径（EXPECTATION-LEDGER-1 任务书）：
 * 1. 期待有 source chapter/span、目标读者体验、当前状态和延期理由。
 * 2. 未胜出候选不更新期待状态（final-only）。
 * 3. fulfilled 期待不重新选入 advance/fulfill，只能 inspect 历史背景。
 * 4. 无期待时不伪造，写 emptyReason 不静默。
 * 5. 不用固定"每N章兑现"硬门；不阻断正文生成。
 * 6. final-state-commit 支持 expectation kind 的 reanchor + 语义支持校验。
 * 7. prompt compact block 不含 aggregateQualityScore / totalScore / 固定兑现章数等机械指标。
 *
 * 边界：
 * - 不修改 finalText
 * - 不生成 candidate（expectationContext 不触发）
 * - 不提交长期状态（仅编译 + raw 消费证明）
 * - 不是 hard gate，不阻断正文
 * - 无可靠期待时空 ledger + diagnostic 时不阻断正文
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compileExpectationContext,
  formatExpectationContextPromptBlock,
  skippedExpectationContext,
} from "../dist/v2/core/expectation-context-compiler.js";
import {
  reanchorStagedStateToFinalText,
  computeFinalTextHash,
} from "../dist/v2/core/final-state-commit.js";

// ============================================================================
// 辅助：构造 ChapterIntent / longTermState
// ============================================================================

/** 构造含 selectedExpectationsToAdvance 的 ChapterIntent */
function makeIntentWithSelected(overrides = {}) {
  return {
    chapterFunction: "推进核心冲突",
    readerExperience: ["紧张"],
    currentPressure: ["水下救援压力"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林川"],
    inviolableFacts: ["水下暗流不可消除"],
    sourceRefs: ["chapter-seed"],
    concreteDelivery: ["推进本章功能：推进核心冲突"],
    focusCharacterGoals: [],
    resistance: [],
    choicesAndCosts: [],
    expectedIrreversibleChange: [],
    selectedPromisesToAdvance: [],
    selectedExpectationsToAdvance: [
      {
        expectationId: "exp-001",
        description: "读者期待林川揭开暗流真相",
        targetReaderExperience: "悬念释放后的恍然",
      },
    ],
    causalEndPressure: [],
    factAndCharacterKnowledgeForbiddenZones: [],
    fieldSourceRefs: {
      selectedExpectationsToAdvance: ["chapter-intent:selectedExpectationsToAdvance"],
    },
    ...overrides,
  };
}

/** 构造 longTermState snapshot 含 expectation 视图 */
function makeLongTermState(expectations = []) {
  return {
    canon: [],
    character: [],
    promise: [],
    pattern: [],
    expectation: expectations,
    sourceIds: ["narrative-state-store"],
  };
}

// ============================================================================
// 测试 1：open 期待 → expectedAction=advance
// ============================================================================

test("EXPECTATION-LEDGER-1: open 期待编译为 advance 方向，带目标读者体验", () => {
  const intent = makeIntentWithSelected();
  const longTermState = makeLongTermState([
    {
      id: "expectation:exp-001",
      expectationId: "exp-001",
      description: "读者期待林川揭开暗流真相",
      expectationType: "TYPE-1-information",
      targetReaderExperience: "悬念释放后的恍然",
      status: "open",
      sourceChapter: "ch10",
      sourceRef: "ch10#finalText:abc123abc123:120-180",
    },
  ]);

  const result = compileExpectationContext({ intent, longTermState });
  assert.equal(result.expectationContext.entries.length, 1);
  const entry = result.expectationContext.entries[0];
  assert.equal(entry.expectationId, "exp-001");
  assert.equal(entry.status, "open");
  assert.equal(entry.expectedAction, "advance");
  assert.equal(entry.targetReaderExperience, "悬念释放后的恍然");
  assert.ok(entry.relevanceReason.length > 0, "relevanceReason 不得为空");
  assert.ok(entry.sourceRef.includes("chapter-intent"), "sourceRef 必须引用 chapter-intent");
  assert.ok(entry.confidence > 0 && entry.confidence <= 1, "confidence 必须在 (0,1]");
});

// ============================================================================
// 测试 2：fulfilled 期待 → inspect only，不重新选入 advance/fulfill
// ============================================================================

test("EXPECTATION-LEDGER-1: fulfilled 期待降级为 inspect，不重新选入 advance/fulfill", () => {
  const intent = makeIntentWithSelected();
  const longTermState = makeLongTermState([
    {
      id: "expectation:exp-001",
      expectationId: "exp-001",
      description: "读者期待林川揭开暗流真相",
      expectationType: "TYPE-1-information",
      targetReaderExperience: "悬念释放后的恍然",
      status: "fulfilled",
      sourceChapter: "ch15",
      sourceRef: "ch15#finalText:def456def456:200-260",
    },
  ]);

  const result = compileExpectationContext({ intent, longTermState });
  const entry = result.expectationContext.entries[0];
  assert.equal(entry.status, "fulfilled");
  assert.equal(entry.expectedAction, "inspect", "fulfilled 期待必须 inspect，不得 advance/fulfill");
  assert.ok(entry.relevanceReason.includes("fulfilled") || entry.relevanceReason.includes("历史背景"),
    "relevanceReason 必须标明历史背景");
});

// ============================================================================
// 测试 3：delayed 期待 → 带 delayReason
// ============================================================================

test("EXPECTATION-LEDGER-1: delayed 期待保留 delayReason，方向为 advance", () => {
  const intent = makeIntentWithSelected({
    selectedExpectationsToAdvance: [
      {
        expectationId: "exp-002",
        description: "读者期待主角报仇",
        targetReaderExperience: "因果兑现的爽感",
      },
    ],
  });
  const longTermState = makeLongTermState([
    {
      id: "expectation:exp-002",
      expectationId: "exp-002",
      description: "读者期待主角报仇",
      expectationType: "TYPE-8-justice",
      targetReaderExperience: "因果兑现的爽感",
      status: "delayed",
      delayReason: "仇人尚未现身，本章只能蓄势",
      sourceChapter: "ch12",
      sourceRef: "ch12#finalText:abc789abc789:50-90",
    },
  ]);

  const result = compileExpectationContext({ intent, longTermState });
  const entry = result.expectationContext.entries[0];
  assert.equal(entry.status, "delayed");
  assert.equal(entry.delayReason, "仇人尚未现身，本章只能蓄势");
  assert.equal(entry.expectedAction, "advance", "delayed 期待仍可推进，方向 advance");
});

// ============================================================================
// 测试 4：escalated 期待 → expectedAction=escalate
// ============================================================================

test("EXPECTATION-LEDGER-1: escalated 期待方向为 escalate", () => {
  const intent = makeIntentWithSelected({
    selectedExpectationsToAdvance: [
      {
        expectationId: "exp-003",
        description: "读者期待揭秘主角身世",
        targetReaderExperience: "身份揭示的震撼",
      },
    ],
  });
  const longTermState = makeLongTermState([
    {
      id: "expectation:exp-003",
      expectationId: "exp-003",
      description: "读者期待揭秘主角身世",
      expectationType: "TYPE-7-identity",
      targetReaderExperience: "身份揭示的震撼",
      status: "escalated",
      sourceChapter: "ch14",
      sourceRef: "ch14#finalText:abc012abc012:300-360",
    },
  ]);

  const result = compileExpectationContext({ intent, longTermState });
  const entry = result.expectationContext.entries[0];
  assert.equal(entry.status, "escalated");
  assert.equal(entry.expectedAction, "escalate");
});

// ============================================================================
// 测试 5：无期待时不伪造，写 emptyReason
// ============================================================================

test("EXPECTATION-LEDGER-1: 无 selectedExpectationsToAdvance 且无 state expectation 时写 emptyReason", () => {
  const intent = makeIntentWithSelected({ selectedExpectationsToAdvance: [] });
  const longTermState = makeLongTermState([]);

  const result = compileExpectationContext({ intent, longTermState });
  assert.equal(result.expectationContext.entries.length, 0, "不得伪造期待");
  assert.ok(result.expectationContext.emptyReason.length > 0, "emptyReason 不得为空");
  assert.equal(result.expectationContext.consumedByRawPrompt, false);
  assert.equal(result.promptBlock, null, "空状态不生成 prompt block");
});

// ============================================================================
// 测试 6：prompt block 格式正确，无机械指标
// ============================================================================

test("EXPECTATION-LEDGER-1: prompt block 含期待状态与方向，无机械指标", () => {
  const intent = makeIntentWithSelected();
  const longTermState = makeLongTermState([
    {
      id: "expectation:exp-001",
      expectationId: "exp-001",
      description: "读者期待林川揭开暗流真相",
      expectationType: "TYPE-1-information",
      targetReaderExperience: "悬念释放后的恍然",
      status: "open",
      sourceChapter: "ch10",
      sourceRef: "ch10#finalText:abc123abc123:120-180",
    },
  ]);

  const result = compileExpectationContext({ intent, longTermState });
  const block = result.promptBlock;
  assert.ok(block, "非空期待必须生成 prompt block");
  assert.ok(block.includes("exp-001"), "block 必须包含 expectationId");
  assert.ok(block.includes("open"), "block 必须包含状态");
  assert.ok(block.includes("advance"), "block 必须包含方向");
  // 禁止机械指标
  assert.ok(!block.includes("aggregateQualityScore"), "不得包含 aggregateQualityScore");
  assert.ok(!block.includes("totalScore"), "不得包含 totalScore");
  assert.ok(!/每\s*\d+\s*章/.test(block), "不得包含固定兑现章数硬门");
});

// ============================================================================
// 测试 7：seed_only（state 无记录）期待 → 仍可 advance，置信度降低
// ============================================================================

test("EXPECTATION-LEDGER-1: seed_only 期待（state 无记录）可 advance，置信度降低", () => {
  const intent = makeIntentWithSelected();
  const longTermState = makeLongTermState([]); // state 无 expectation 记录

  const result = compileExpectationContext({ intent, longTermState });
  const entry = result.expectationContext.entries[0];
  assert.equal(entry.status, "seed_only");
  assert.equal(entry.expectedAction, "advance");
  assert.ok(entry.confidence < 0.7, "seed_only 置信度应低于 state 确认");
});

// ============================================================================
// 测试 8：final-state-commit 支持 expectation kind reanchor + 语义支持
// ============================================================================

test("EXPECTATION-LEDGER-1: final-state-commit 支持 expectation kind reanchor", () => {
  const finalText = "林川终于看清了暗流的全貌，那些被掩盖的真相一一浮现。";
  const hash = computeFinalTextHash(finalText);
  const stagedUpdate = {
    additions: [
      {
        kind: "expectation",
        id: "expectation:exp-001",
        expectationId: "exp-001",
        description: "读者期待林川揭开暗流真相",
        expectationType: "TYPE-1-information",
        targetReaderExperience: "悬念释放后的恍然",
        status: "fulfilled",
        sourceChapter: "ch16",
        sourceRef: "candidate:amp-1",
        confidence: 0.5,
        lastUpdated: "2026-07-14T00:00:00.000Z",
      },
    ],
    invalidations: [],
    sourceChapter: "ch16",
    finalCandidateId: "candidate:amp-1",
  };

  const reanchored = reanchorStagedStateToFinalText(stagedUpdate, finalText, 16);
  const entry = reanchored.additions[0];
  assert.equal(entry.kind, "expectation");
  assert.ok(entry.sourceRef.includes(hash), "sourceRef 必须包含 finalText hash");
  // 正文实际触及"暗流"和"真相"，应提升置信度
  assert.ok(entry.confidence >= 0.7, "正文触及的期待置信度应提升");
  assert.equal(entry.status, "fulfilled", "fulfilled 状态保持");
});

// ============================================================================
// 测试 9：final-state-commit expectation 未触及正文 → 降级 not-found
// ============================================================================

test("EXPECTATION-LEDGER-1: 正文未触及的期待降级为 not-found，不声称 fulfilled", () => {
  const finalText = "今天的天气很好，主角去公园散步。"; // 与期待无关
  const stagedUpdate = {
    additions: [
      {
        kind: "expectation",
        id: "expectation:exp-999",
        expectationId: "exp-999",
        description: "读者期待揭开暗流真相",
        expectationType: "TYPE-1-information",
        targetReaderExperience: "悬念释放",
        status: "fulfilled",
        sourceChapter: "ch16",
        sourceRef: "candidate:amp-1",
        confidence: 0.5,
        lastUpdated: "2026-07-14T00:00:00.000Z",
      },
    ],
    invalidations: [],
    sourceChapter: "ch16",
    finalCandidateId: "candidate:amp-1",
  };

  const reanchored = reanchorStagedStateToFinalText(stagedUpdate, finalText, 16);
  const entry = reanchored.additions[0];
  assert.ok(entry.sourceRef.includes("not-found") || entry.confidence < 0.5,
    "正文未触及的期待必须降级，不得声称 fulfilled");
});

// ============================================================================
// 测试 10：skippedExpectationContext 失败路径不静默
// ============================================================================

test("EXPECTATION-LEDGER-1: skippedExpectationContext 写 reason 不静默", () => {
  const skipped = skippedExpectationContext("hardBlock: contextSafety");
  assert.equal(skipped.entries.length, 0);
  assert.equal(skipped.consumedByRawPrompt, false);
  assert.ok(skipped.emptyReason.includes("skipped"));
  assert.ok(skipped.emptyReason.includes("contextSafety"));
});

// ============================================================================
// 测试 11：反向验证 — 不全量灌入 state expectation（保守相关性）
// ============================================================================

test("EXPECTATION-LEDGER-1: 只编译 selectedExpectationsToAdvance 命中项，不全量灌入 state expectation", () => {
  const intent = makeIntentWithSelected({
    selectedExpectationsToAdvance: [
      { expectationId: "exp-001", description: "期待A", targetReaderExperience: "体验A" },
    ],
  });
  // state 有 3 条期待，但只 exp-001 被选中
  const longTermState = makeLongTermState([
    { id: "expectation:exp-001", expectationId: "exp-001", description: "期待A", status: "open", sourceChapter: "ch10" },
    { id: "expectation:exp-002", expectationId: "exp-002", description: "期待B", status: "open", sourceChapter: "ch11" },
    { id: "expectation:exp-003", expectationId: "exp-003", description: "期待C", status: "open", sourceChapter: "ch12" },
  ]);

  const result = compileExpectationContext({ intent, longTermState });
  assert.equal(result.expectationContext.entries.length, 1, "只编译选中项，不全量灌入");
  assert.equal(result.expectationContext.entries[0].expectationId, "exp-001");
});

// ============================================================================
// 测试 12：formatExpectationContextPromptBlock 空状态返回 null
// ============================================================================

test("EXPECTATION-LEDGER-1: formatExpectationContextPromptBlock 空状态返回 null", () => {
  const block = formatExpectationContextPromptBlock({
    entries: [],
    sourceRefs: [],
    consumedByRawPrompt: false,
    emptyReason: "无期待",
  });
  assert.equal(block, null);
});
