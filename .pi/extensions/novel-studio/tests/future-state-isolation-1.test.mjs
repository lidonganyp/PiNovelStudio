/**
 * FUTURE-STATE-ISOLATION-1 — 阻止未来章节状态进入当前章上下文
 *
 * 验收口径（任务卡）：
 *   1. ch17 不得检索 ch17、ch18、ch19 状态。
 *   2. ch20 可以检索 ch19，但不能检索 ch20+。
 *   3. 必需 promise 只存在于未来章节时，报告 missing，不得回填。
 *   4. 无法解析章节号的状态默认不进入工作集，记录诊断。
 *   5. ContextRetrievalReport 新增 future_state_excluded 记录。
 *   6. 检测到未来状态时不得静默忽略，trace 必须显示来源。
 *
 * 配套：
 *   - 单元测试（retrieveNarrativeContext 直接调用）
 *   - ContextCompiler 集成测试（合成 workspace）
 *   - 真实 xinmo ch17 回归测试
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync } from "node:fs";

import { retrieveNarrativeContext } from "../dist/v2/core/context-retrieval.js";
import { createContextCompiler } from "../dist/v2/core/context-compiler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

const XINMO_STATE_PATH = join(
  PROJECT_ROOT,
  "workspaces",
  "xinmo",
  "narrative-state-store.json"
);
const _xinmoReady = existsSync(XINMO_STATE_PATH);

// ============================================================================
// 工厂：构造最小可用 NarrativeStateEntry
// ============================================================================

function makeCharacter(id, characterId, field, value, sourceChapter) {
  return {
    id,
    kind: "character",
    characterId,
    field,
    value,
    sourceChapter,
    sourceRef: `${sourceChapter}#${id}`,
    confidence: 0.8,
    lastUpdated: "2026-07-18T00:00:00Z",
  };
}

function makePromise(id, promiseId, description, status, sourceChapter, currentHeat = 3) {
  return {
    id,
    kind: "promise",
    promiseId,
    description,
    status,
    currentHeat,
    sourceChapter,
    sourceRef: `${sourceChapter}#${id}`,
    confidence: 0.8,
    lastUpdated: "2026-07-18T00:00:00Z",
  };
}

function makeCanon(id, fact, category, sourceChapter) {
  return {
    id,
    kind: "canon",
    fact,
    category,
    sourceChapter,
    sourceRef: `${sourceChapter}#${id}`,
    confidence: 0.8,
    lastUpdated: "2026-07-18T00:00:00Z",
  };
}

function makePattern(id, patternType, description, sourceChapter, occurrenceCount = 2) {
  return {
    id,
    kind: "pattern",
    patternType,
    description,
    occurrenceCount,
    sourceChapter,
    sourceRef: `${sourceChapter}#${id}`,
    confidence: 0.8,
    lastUpdated: "2026-07-18T00:00:00Z",
  };
}

// ============================================================================
// 1. 单元测试：retrieveNarrativeContext 直接调用
// ============================================================================

test("FUTURE-STATE-ISOLATION-1 单元：ch17 不得检索 ch17/ch18/ch19 状态", () => {
  const state = {
    canon: [
      makeCanon("canon:ch16", "前章已建立的事实", "timeline", "ch16"),
      makeCanon("canon:ch17-leak", "本章派生的未来事实", "timeline", "ch17"),
      makeCanon("canon:ch18-leak", "下章派生的未来事实", "timeline", "ch18"),
    ],
    character: [
      makeCharacter("char:ch16:ling", "凌", "状态", "在ch16已受伤", "ch16"),
      makeCharacter("char:ch18:ling", "凌", "状态", "在ch18已升级", "ch18"),
      makeCharacter("char:ch19:ling", "凌", "状态", "在ch19已闭关", "ch19"),
    ],
    promise: [
      makePromise("promise:ch16", "p1", "前章埋下的伏笔", "open", "ch16"),
      makePromise("promise:ch17-leak", "p2", "本章派生的新伏笔", "advancing", "ch17"),
    ],
    pattern: [
      makePattern("pattern:ch16", "hook_type", "悬念钩子A", "ch16"),
      makePattern("pattern:ch18-leak", "hook_type", "未来钩子", "ch18"),
    ],
  };

  const result = retrieveNarrativeContext({
    chapterNumber: 17,
    relevantCharacters: ["凌"],
    selectedPromiseIds: ["promise:ch16", "promise:ch17-leak"],
    keywords: ["伏笔"],
    state,
    maxItems: 24,
  });

  // 工作集 sourceChapter 必须严格 < 17
  const allWorkingChapters = [
    ...result.workingSet.canon,
    ...result.workingSet.character,
    ...result.workingSet.promise,
    ...result.workingSet.pattern,
  ].map((e) => e.sourceChapter);
  for (const ch of allWorkingChapters) {
    assert.match(
      ch,
      /^ch(\d+)$/,
      `workingSet sourceChapter 应为 chN 形式，实际 ${ch}`
    );
    const n = Number(ch.slice(2));
    assert.ok(
      n < 17,
      `workingSet 不应包含 ch17+ 状态，但发现 ${ch}（编号 ${n}）`
    );
  }

  // future_state_excluded 必须记录被排除的未来条目，且不得静默
  assert.ok(
    Array.isArray(result.report.futureStateExcluded),
    "futureStateExcluded 应为数组"
  );
  const excludedIds = new Set(result.report.futureStateExcluded.map((e) => e.id));
  for (const expectedExcluded of [
    "canon:ch17-leak",
    "canon:ch18-leak",
    "char:ch18:ling",
    "char:ch19:ling",
    "promise:ch17-leak",
    "pattern:ch18-leak",
  ]) {
    assert.ok(
      excludedIds.has(expectedExcluded),
      `futureStateExcluded 应包含被排除的未来状态 ${expectedExcluded}，实际包含：${[...excludedIds].join(", ")}`
    );
  }

  // 每条 future_state_excluded 必须带 sourceChapter 与 sourceRef，证明"trace 必须显示来源"
  for (const ex of result.report.futureStateExcluded) {
    assert.ok(ex.sourceChapter, "futureStateExcluded 条目必须带 sourceChapter");
    assert.ok(ex.sourceRef, "futureStateExcluded 条目必须带 sourceRef");
    assert.ok(ex.reason, "futureStateExcluded 条目必须带 reason");
    assert.ok(ex.kind, "futureStateExcluded 条目必须带 kind");
  }
});

test("FUTURE-STATE-ISOLATION-1 单元：ch20 可以检索 ch19，但不能检索 ch20+", () => {
  const state = {
    canon: [
      makeCanon("canon:ch19-ok", "可接受的过去事实", "timeline", "ch19"),
      makeCanon("canon:ch20-leak", "本章未来事实", "timeline", "ch20"),
      makeCanon("canon:ch21-leak", "更未来事实", "timeline", "ch21"),
    ],
    character: [],
    promise: [
      makePromise("promise:ch19-ok", "p1", "可接受的过去伏笔", "open", "ch19"),
      makePromise("promise:ch20-leak", "p2", "本章未来伏笔", "open", "ch20"),
    ],
    pattern: [],
  };

  const result = retrieveNarrativeContext({
    chapterNumber: 20,
    relevantCharacters: [],
    selectedPromiseIds: ["promise:ch19-ok", "promise:ch20-leak"],
    keywords: [],
    state,
    maxItems: 24,
  });

  // ch19 应被检索，ch20/ch21 应被排除
  const canonIds = result.workingSet.canon.map((e) => e.id);
  const promiseIds = result.workingSet.promise.map((e) => e.id);
  assert.ok(canonIds.includes("canon:ch19-ok"), "ch20 应能检索 ch19 canon");
  assert.ok(promiseIds.includes("promise:ch19-ok"), "ch20 应能检索 ch19 promise");
  assert.ok(!canonIds.includes("canon:ch20-leak"), "ch20 不得检索 ch20+ canon");
  assert.ok(!canonIds.includes("canon:ch21-leak"), "ch20 不得检索 ch21 canon");
  assert.ok(!promiseIds.includes("promise:ch20-leak"), "ch20 不得检索 ch20 promise");

  // 排除的 ch20/ch21 必须在 futureStateExcluded 中
  const excludedIds = new Set(result.report.futureStateExcluded.map((e) => e.id));
  assert.ok(excludedIds.has("canon:ch20-leak"), "futureStateExcluded 应含 ch20 leak");
  assert.ok(excludedIds.has("canon:ch21-leak"), "futureStateExcluded 应含 ch21 leak");
  assert.ok(excludedIds.has("promise:ch20-leak"), "futureStateExcluded 应含 ch20 promise leak");
});

test("ContextRetrieval 为 Canon 和 Pattern 保留跨类型配额，避免被人物状态挤出", () => {
  const state = {
    canon: Array.from({ length: 4 }, (_, index) =>
      makeCanon(`canon:${index}`, `已接受事实${index}`, "timeline", "ch16")),
    character: Array.from({ length: 30 }, (_, index) =>
      makeCharacter(`character:${index}`, "凌", "历史状态", `人物证据${index}`, "ch16")),
    promise: [],
    pattern: Array.from({ length: 4 }, (_, index) =>
      makePattern(`pattern:${index}`, "hook_type", `已用章末模式${index}`, "ch16")),
  };

  const result = retrieveNarrativeContext({
    chapterNumber: 17,
    relevantCharacters: ["凌"],
    selectedPromiseIds: [],
    keywords: [],
    state,
    maxItems: 24,
  });

  assert.equal(result.workingSet.canon.length, 4);
  assert.equal(result.workingSet.pattern.length, 4);
  assert.equal(result.report.retrieved.length, 24);
});

test("FUTURE-STATE-ISOLATION-1 单元：必需 promise 只存在于未来章节时报告 missing，不得回填", () => {
  const state = {
    canon: [],
    character: [],
    promise: [
      // 唯一可用的 promise 来自 ch18（ch17 的未来）
      makePromise("promise:ch18-only", "p-future", "只存在于未来的必需 promise", "open", "ch18"),
    ],
    pattern: [],
  };

  const result = retrieveNarrativeContext({
    chapterNumber: 17,
    relevantCharacters: [],
    selectedPromiseIds: ["promise:ch18-only"],
    keywords: [],
    state,
    maxItems: 24,
  });

  // 工作集不得包含未来 promise
  assert.equal(
    result.workingSet.promise.length,
    0,
    "工作集不得包含未来 promise（不得回填）"
  );

  // recall.missingRequiredIds 必须包含该 id
  assert.ok(
    result.report.recall.missingRequiredIds.includes("promise:ch18-only"),
    `missingRequiredIds 必须包含未来 promise，实际：${JSON.stringify(result.report.recall)}`
  );

  // futureStateExcluded 必须记录该排除
  const excludedIds = result.report.futureStateExcluded.map((e) => e.id);
  assert.ok(
    excludedIds.includes("promise:ch18-only"),
    "futureStateExcluded 必须记录被排除的未来必需 promise"
  );
});

test("FUTURE-STATE-ISOLATION-1 单元：无法解析章节号的状态默认不进入工作集，记录诊断", () => {
  const state = {
    canon: [
      makeCanon("canon:unparseable", "无法解析的旧条目", "timeline", "unknown-chapter"),
      makeCanon("canon:empty", "空 sourceChapter", "timeline", ""),
      makeCanon("canon:valid", "有效条目", "timeline", "ch16"),
    ],
    character: [],
    promise: [],
    pattern: [],
  };

  const result = retrieveNarrativeContext({
    chapterNumber: 17,
    relevantCharacters: [],
    selectedPromiseIds: [],
    keywords: [],
    state,
    maxItems: 24,
  });

  // 工作集只应包含可解析的有效条目
  const canonIds = result.workingSet.canon.map((e) => e.id);
  assert.ok(canonIds.includes("canon:valid"), "可解析的 ch16 条目应进入工作集");
  assert.ok(!canonIds.includes("canon:unparseable"), "无法解析章节号的条目不得进入工作集");
  assert.ok(!canonIds.includes("canon:empty"), "空 sourceChapter 的条目不得进入工作集");

  // futureStateExcluded 必须记录被排除的不可解析条目，且 reason 标明是"无法解析"
  const excludedById = new Map(result.report.futureStateExcluded.map((e) => [e.id, e]));
  assert.ok(excludedById.has("canon:unparseable"), "futureStateExcluded 应记录不可解析条目");
  assert.ok(excludedById.has("canon:empty"), "futureStateExcluded 应记录空 sourceChapter 条目");

  const unparseableEx = excludedById.get("canon:unparseable");
  assert.ok(
    /unparseable|cannot.?parse|无法解析/i.test(unparseableEx.reason),
    `不可解析条目的 reason 应明确为 unparseable/cannot parse，实际：${unparseableEx.reason}`
  );
});

// ============================================================================
// 2. 集成测试：ContextCompiler 不返回未来章节状态
// ============================================================================

test("FUTURE-STATE-ISOLATION-1 集成：ContextCompiler ch17 longTermState 不含 ch17+ 条目", () => {
  const compiler = createContextCompiler();
  const { context } = compiler.compile({
    workspaceId: "xinmo",
    chapterId: "17",
    chapterNumber: 17,
    projectRoot: PROJECT_ROOT,
  });

  const lts = context.longTermState;
  if (!lts) {
    // 无长期状态文件时本测试跳过：但仍应保证不抛错
    return;
  }

  // 收集所有 working set 条目的 sourceChapter
  const allEntries = [
    ...lts.canon,
    ...lts.character,
    ...lts.promise,
    ...lts.pattern,
    ...(lts.expectation ?? []),
  ];

  for (const entry of allEntries) {
    const ch = entry.sourceChapter;
    assert.match(ch, /^ch(\d+)$/, `longTermState sourceChapter 应为 chN 形式，实际 ${ch}`);
    const n = Number(ch.slice(2));
    assert.ok(
      n < 17,
      `ContextCompiler ch17 不得返回 ch17+ 状态，发现 ${ch}（编号 ${n}）：${JSON.stringify(entry)}`
    );
  }

  // retrievalReport.futureStateExcluded 必须存在（如果工作集有未来条目被排除）
  if (lts.retrievalReport) {
    const report = lts.retrievalReport;
    assert.ok(
      Array.isArray(report.futureStateExcluded),
      `retrievalReport.futureStateExcluded 应为数组，实际类型：${typeof report.futureStateExcluded}`
    );
  }
});

// ============================================================================
// 3. 真实 xinmo ch17 回归测试
// ============================================================================

test(
  "[integration:workspace-data] FUTURE-STATE-ISOLATION-1 真实回归：xinmo ch17 不返回 ch18/ch19 状态",
  { skip: !_xinmoReady && "[integration:workspace-data] 需要 xinmo 真实 narrative-state-store.json" },
  () => {
    // 先检查真实状态文件确实包含 ch18/ch19 条目（这是当前污染证据）
    const rawStore = JSON.parse(readFileSync(XINMO_STATE_PATH, "utf-8"));
    const futureStateEntries = [
      ...(rawStore.canon ?? []),
      ...(rawStore.character ?? []),
      ...(rawStore.promise ?? []),
      ...(rawStore.pattern ?? []),
      ...(rawStore.expectation ?? []),
    ].filter((e) => {
      const m = String(e.sourceChapter ?? "").match(/^ch(\d+)$/);
      return m && Number(m[1]) >= 17;
    });

    // 若工作区已清干净（无未来污染条目），跳过 — 因为没什么可回归的
    if (futureStateEntries.length === 0) {
      return;
    }

    const compiler = createContextCompiler();
    const { context } = compiler.compile({
      workspaceId: "xinmo",
      chapterId: "17",
      chapterNumber: 17,
      projectRoot: PROJECT_ROOT,
    });

    const lts = context.longTermState;
    assert.ok(lts, "xinmo 应有长期状态快照");

    // 真实 xinmo 工作区 lastCommittedChapter=ch19，character 含 ch18/ch19 条目
    // 编译 ch17 时 longTermState 必须把 ch18/ch19 过滤掉
    const allWorkingEntries = [
      ...lts.canon,
      ...lts.character,
      ...lts.promise,
      ...lts.pattern,
      ...(lts.expectation ?? []),
    ];

    for (const entry of allWorkingEntries) {
      const m = String(entry.sourceChapter).match(/^ch(\d+)$/);
      assert.ok(m, `longTermState sourceChapter 应为 chN 形式，实际 ${entry.sourceChapter}`);
      const n = Number(m[1]);
      assert.ok(
        n < 17,
        `xinmo ch17 编译不得返回 ch17+ 状态，发现 ${entry.sourceChapter}：${JSON.stringify(entry)}`
      );
    }

    // 同时验证 futureStateExcluded 至少记录了真实存在的 ch18/ch19 条目
    const report = lts.retrievalReport;
    assert.ok(report, "longTermState.retrievalReport 应存在");
    assert.ok(
      Array.isArray(report.futureStateExcluded),
      "futureStateExcluded 应为数组"
    );
    assert.ok(
      report.futureStateExcluded.length >= futureStateEntries.length,
      `futureStateExcluded 应至少记录所有真实未来条目（${futureStateEntries.length} 条），实际 ${report.futureStateExcluded.length} 条`
    );

    // 排除条目的 sourceChapter 必须是 ch17+
    for (const ex of report.futureStateExcluded) {
      const m = String(ex.sourceChapter).match(/^ch(\d+)$/);
      if (!m) continue; // 不可解析的由其他测试覆盖
      const n = Number(m[1]);
      assert.ok(
        n >= 17,
        `futureStateExcluded 应只记录 ch17+ 条目，发现 ${ex.sourceChapter}`
      );
    }
  }
);

// ============================================================================
// 4. 集成测试：合成 workspace 验证 ContextCompiler 完整流程
// ============================================================================

test("FUTURE-STATE-ISOLATION-1 集成：合成 workspace ch17 不返回 ch17+ 派生状态", () => {
  // 使用不存在的 workspace：ContextCompiler 会返回空 longTermState（无污染）
  // 主要验证 ContextCompiler 在没有未来状态时不抛错
  const compiler = createContextCompiler();
  const { context, diagnostics } = compiler.compile({
    workspaceId: "future-state-isolation-synthetic",
    chapterId: "17",
    chapterNumber: 17,
    projectRoot: PROJECT_ROOT,
  });

  // 不存在的 workspace 应有 missing 诊断（不阻断生成）
  assert.ok(diagnostics.length > 0, "合成 workspace 应有 diagnostic");
  // longTermState 应为 null 或空（无状态文件）
  if (context.longTermState) {
    const all = [
      ...context.longTermState.canon,
      ...context.longTermState.character,
      ...context.longTermState.promise,
      ...context.longTermState.pattern,
      ...(context.longTermState.expectation ?? []),
    ];
    assert.equal(all.length, 0, "合成 workspace 不应有任何长期状态");
  }
});
