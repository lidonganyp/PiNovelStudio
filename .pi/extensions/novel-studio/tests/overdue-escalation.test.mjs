/**
 * P4 RED — pre-write overdue alerts (伏笔/期待逾期 escalate)
 *
 * 真相源：long-form-stability-gaps-fix-plan-v2.md §P4 + 续接计划步骤 3/4
 *
 * 覆盖 M3：buildOverdueAlerts 仅作 post-raw advisory，writer 模型写前看不到。
 * GREEN 把 overdue alerts 从 retrieval eligible 派生，经 LongTermStateSnapshot
 * → CompiledContext.longTermState.overdueAlerts → ChapterIntentInput.overdueAlerts
 * → ChapterIntent.overduePressure 暴露给写前链路。
 *
 * 数据形状约束（Phase 1 探查）：
 * - PromiseEntry.status ∈ {open,advancing,fulfilled,broken}，无 escalated/delayed，
 *   也无 overdueWindow → pre-write overdue 只能由 ExpectationEntry 产生
 *   （ExpectationEntry 有 overdueWindow + delayed/escalated 状态）。
 * - overdueAlerts 必须从 `eligible`（已过 FUTURE-STATE-ISOLATION-1）派生，而非
 *   workingSet——低相关度（score<10）的 overdue 期待不在 workingSet，但仍逾期，
 *   writer 应被告知。
 *
 * 本测试为 RED：computeOverdueAlertsFromRetrievalState 未导出、
 * ContextRetrievalResult.overdueAlerts / ChapterIntent.overduePressure 不存在 →
 * 三个用例全部 FAIL。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as contextRetrievalMod from "../dist/v2/core/context-retrieval.js";
import * as chapterIntentBuilderMod from "../dist/v2/core/chapter-intent-builder.js";

const { retrieveNarrativeContext } = contextRetrievalMod;
const { createChapterIntentBuilder } = chapterIntentBuilderMod;

// ============================================================================
// helpers
// ============================================================================

function makeExpectation(id, expectationId, overrides = {}) {
  return {
    id,
    kind: "expectation",
    sourceChapter: "ch3",
    sourceRef: `ch3#${expectationId}`,
    confidence: 1,
    lastUpdated: "2026-07-23T00:00:00.000Z",
    expectationId,
    description: `读者期待 ${expectationId}`,
    status: "open",
    overdueWindow: { earliest: 5, optimal: 8, latest: 10 },
    ...overrides,
  };
}

function makeCanon(id) {
  return {
    id,
    kind: "canon",
    sourceChapter: "ch14",
    sourceRef: `ch14#${id}`,
    confidence: 1,
    lastUpdated: "2026-07-23T00:00:00.000Z",
    fact: `事实 k1 k2 k3 ${id}`,
    category: "entity",
  };
}

// ============================================================================
// 用例 1：computeOverdueAlertsFromRetrievalState — red / yellow / fulfilled
// ============================================================================

test("P4 RED: computeOverdueAlertsFromRetrievalState — red when past latest, yellow in window, skip fulfilled", () => {
  const computeOverdueAlertsFromRetrievalState = contextRetrievalMod.computeOverdueAlertsFromRetrievalState;
  assert.equal(
    typeof computeOverdueAlertsFromRetrievalState,
    "function",
    "computeOverdueAlertsFromRetrievalState 应从 context-retrieval 导出",
  );
  if (typeof computeOverdueAlertsFromRetrievalState !== "function") return;

  // red：latest=10, chapter=15 → 超 5 章
  const redState = { canon: [], character: [], promise: [], pattern: [], expectation: [makeExpectation("expectation:e1", "e1")] };
  const redAlerts = computeOverdueAlertsFromRetrievalState(redState, 15);
  const redAlert = redAlerts.find((a) => a.itemId === "e1");
  assert.ok(redAlert, "应产出 e1 alert");
  assert.equal(redAlert.severity, "red");
  assert.equal(redAlert.chaptersOverdue, 5);
  assert.equal(redAlert.itemType, "expectation");

  // yellow：latest=10, chapter=9 → 落入 latest-2 窗口
  const yellowAlerts = computeOverdueAlertsFromRetrievalState(redState, 9);
  const yellowAlert = yellowAlerts.find((a) => a.itemId === "e1");
  assert.ok(yellowAlert, "应产出 e1 yellow alert");
  assert.equal(yellowAlert.severity, "yellow");
  assert.equal(yellowAlert.chaptersOverdue, null);

  // fulfilled 排除：status=fulfilled → 无 alert
  const fulfilledState = {
    canon: [], character: [], promise: [], pattern: [],
    expectation: [makeExpectation("expectation:e1", "e1", { status: "fulfilled" })],
  };
  const fulfilledAlerts = computeOverdueAlertsFromRetrievalState(fulfilledState, 15);
  assert.equal(
    fulfilledAlerts.some((a) => a.itemId === "e1"),
    false,
    "fulfilled 期待不应产 alert",
  );
});

// ============================================================================
// 用例 2：retrieveNarrativeContext 从 eligible（非 workingSet）派生 overdueAlerts
// 低相关度 overdue 期待不在 workingSet，但仍应被 overdueAlerts 暴露
// ============================================================================

test("P4 RED: retrieveNarrativeContext exposes overdueAlerts from eligible (not workingSet)", () => {
  // overdue expectation 无关键词 → score 仅 proximity(8) < 10 → 不进 workingSet
  const state = {
    canon: [makeCanon("canon-1")], // 高分 canon 占据 workingSet
    character: [],
    promise: [],
    pattern: [],
    expectation: [makeExpectation("expectation:e1", "e1")], // ch3, latest=10
  };
  const result = retrieveNarrativeContext({
    chapterNumber: 15,
    relevantCharacters: [],
    selectedPromiseIds: [],
    keywords: ["k1", "k2", "k3"],
    state,
    maxItems: 8,
  });

  // 守卫：overdue 期待确实不在 workingSet（低相关度）
  assert.equal(
    result.workingSet.expectation.length,
    0,
    "低相关度 overdue 期待不应进入 workingSet（证明 overdueAlerts 来自 eligible 而非 workingSet）",
  );

  // RED 关键断言：overdueAlerts 字段不存在 → FAIL
  assert.ok(
    Array.isArray(result.overdueAlerts),
    "result.overdueAlerts 应为数组",
  );
  if (Array.isArray(result.overdueAlerts)) {
    const e1Alert = result.overdueAlerts.find((a) => a.itemId === "e1");
    assert.ok(e1Alert, "应含 e1 alert");
    assert.equal(e1Alert.severity, "red");
    assert.equal(e1Alert.chaptersOverdue, 5);
  }
});

// ============================================================================
// 用例 3：ChapterIntentBuilder 把 input.overdueAlerts 映射为 intent.overduePressure
// ============================================================================

test("P4 RED: ChapterIntentBuilder populates overduePressure from input.overdueAlerts", () => {
  const builder = createChapterIntentBuilder();
  const input = {
    chapterNumber: 15,
    targetEmotions: [],
    characters: [],
    immutableFacts: [],
    openPromises: [],
    openArcs: [],
    currentPressureSummary: [],
    prevContinuationAvailable: false,
    overdueAlerts: [
      { itemId: "e1", itemType: "expectation", severity: "red", description: "读者期待 e1 已逾期" },
    ],
  };
  const { intent } = builder.build(input, null, null);

  // RED：ChapterIntent.overduePressure 字段不存在 → FAIL
  assert.ok(
    Array.isArray(intent.overduePressure),
    "intent.overduePressure 应为数组",
  );
  if (Array.isArray(intent.overduePressure)) {
    assert.equal(intent.overduePressure.length, 1);
    assert.equal(intent.overduePressure[0].itemId, "e1");
    assert.equal(intent.overduePressure[0].severity, "red");
  }
});
