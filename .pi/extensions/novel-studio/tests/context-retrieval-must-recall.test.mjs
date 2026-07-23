/**
 * P3 RED — context-retrieval must-recall force channel + dynamic maxItems
 *
 * 真相源：long-form-stability-gaps-fix-plan-v2.md §P3 + 续接计划步骤 1/2
 *
 * 覆盖 H2 两个互补缺口：
 * 1. forcedRecallIds 强制通道：当前 selectedPromiseIds（必需 promise）虽 +120 加分
 *    但仍受 maxItems 上限约束，30 个更高分 canon 可把它挤出 workingSet。
 *    force 通道保证 forcedRecallIds 中通过 FUTURE-STATE-ISOLATION-1 过滤的条目
 *    无论如何都被纳入 workingSet（不计入 itemLimit）。
 * 2. FUTURE-STATE-ISOLATION-1 不被绕过：forcedRecallIds 含未来章节条目时仍被排除。
 * 3. 动态 maxItems：context-compiler 按 state 总量缩放（24..48），不再硬编码 24。
 *
 * 本测试为 RED：在 P3 GREEN 实现前，forcedRecallIds 字段被忽略、computeMaxItems
 * 未导出 → 用例 1/2/3 全部 FAIL。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as contextRetrievalMod from "../dist/v2/core/context-retrieval.js";
import * as contextCompilerMod from "../dist/v2/core/context-compiler.js";

const { retrieveNarrativeContext } = contextRetrievalMod;

// ============================================================================
// helpers
// ============================================================================

function makeCanon(id, fact, sourceChapter = "ch14") {
  return {
    id,
    kind: "canon",
    sourceChapter,
    sourceRef: `${sourceChapter}#${id}`,
    confidence: 1,
    lastUpdated: "2026-07-23T00:00:00.000Z",
    fact,
    category: "entity",
  };
}

function makePromise(id, promiseId, sourceChapter, description, overrides = {}) {
  return {
    id,
    kind: "promise",
    sourceChapter,
    sourceRef: `${sourceChapter}#${id}`,
    confidence: 1,
    lastUpdated: "2026-07-23T00:00:00.000Z",
    promiseId,
    description,
    currentHeat: 0,
    status: "open",
    ...overrides,
  };
}

// 30 个 canon 条目：fact 含 k1/k2/k3 → +120 关键词分 + 19 邻近分 = 139
// 1 个 p_critical：selectedPromiseIds → +120 + 6 邻近 = 126（被 30 个 139 分 canon 挤掉）
function buildForceIncludeState() {
  const canon = [];
  for (let i = 0; i < 30; i++) {
    canon.push(makeCanon(`canon-${i}`, `事实 k1 k2 k3 编号 ${i}`));
  }
  const promise = [
    makePromise("promise:p_critical", "p_critical", "ch1", "关键伏笔 p_critical"),
    makePromise("promise:p_future", "p_future", "ch20", "未来章节伏笔 p_future"),
  ];
  return { canon, character: [], promise, pattern: [] };
}

// ============================================================================
// 用例 1：force-include 重新纳入被挤掉的必需 promise + 不绕过 future 过滤
// ============================================================================

test("P3 RED: forcedRecallIds force-includes dropped required promise and respects future filter", () => {
  const state = buildForceIncludeState();
  const result = retrieveNarrativeContext({
    chapterNumber: 15,
    relevantCharacters: [],
    selectedPromiseIds: ["p_critical"],
    keywords: ["k1", "k2", "k3"],
    state,
    maxItems: 8,
    forcedRecallIds: ["p_critical", "p_future"],
  });

  // p_critical 在 RED 中被 30 个 139 分 canon 挤出（自身 126 分，rank 31）→ FAIL
  assert.ok(
    result.workingSet.promise.some((p) => p.promiseId === "p_critical"),
    "p_critical 应被 forcedRecallIds 强制纳入 workingSet",
  );

  // p_future 来自 ch20（未来章节）→ 即使在 forcedRecallIds 中也必须被
  // FUTURE-STATE-ISOLATION-1 排除（RED/GREEN 均应成立，作守卫断言）
  assert.ok(
    !result.workingSet.promise.some((p) => p.promiseId === "p_future"),
    "p_future 来自未来章节，force 通道不得绕过 future 过滤",
  );
  assert.ok(
    result.report.futureStateExcluded.some((e) => e.id === "promise:p_future"),
    "p_future 应记录在 futureStateExcluded（不静默忽略）",
  );

  // forcedRecallAdded 报告字段：RED 中该字段不存在 → FAIL
  assert.ok(
    Array.isArray(result.report.forcedRecallAdded),
    "report.forcedRecallAdded 应为数组（trace 透明性）",
  );
  // 以下仅在 GREEN 执行（RED 已在上一行失败）
  if (Array.isArray(result.report.forcedRecallAdded)) {
    assert.ok(
      result.report.forcedRecallAdded.includes("promise:p_critical"),
      "forcedRecallAdded 应含 p_critical 条目 id",
    );
    assert.ok(
      !result.report.forcedRecallAdded.includes("promise:p_future"),
      "forcedRecallAdded 不得含未来条目 p_future",
    );
  }
});

// ============================================================================
// 用例 2：动态 maxItems 公式（导出 computeMaxItems helper）
// 公式（续接计划步骤 2）：Math.min(48, Math.max(24, Math.floor(total / 4)))
// ============================================================================

test("P3 RED: computeMaxItems scales maxItems with total state size (24..48)", () => {
  const computeMaxItems = contextCompilerMod.computeMaxItems;
  assert.equal(
    typeof computeMaxItems,
    "function",
    "computeMaxItems 应从 context-compiler 导出",
  );
  // 以下仅在 GREEN 执行（RED 已在上一行失败）
  if (typeof computeMaxItems === "function") {
    assert.equal(computeMaxItems(0), 24, "下限 24");
    assert.equal(computeMaxItems(10), 24, "小 state 仍 24");
    assert.equal(computeMaxItems(100), 25, "100 条 → 25");
    assert.equal(computeMaxItems(192), 48, "192 条 → 48（恰好）");
    assert.equal(computeMaxItems(200), 48, "200 条封顶 48");
    assert.equal(computeMaxItems(500), 48, "500 条仍封顶 48");
  }
});
