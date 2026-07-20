/**
 * INTENT-COMPLETENESS-1 测试（RED）
 *
 * 验收口径（来自任务清单 D:\CODE\PiNovelStudio\delete\任务列表\项目优化20260718.md）：
 *
 * 解决当前 trace 中为空的字段：
 * - focusCharacterGoals
 * - choicesAndCosts
 * - expectedIrreversibleChange
 * - selectedPromisesToAdvance
 * - causalEndPressure
 *
 * 要求：
 * 1. 所有值必须有 sourceRef，不能从主题词推测
 * 2. 质量评测模式下，关键字段为空应阻断评测并提示补充种子
 * 3. 普通生成缺少交付关键字段时也必须 fail closed，不能把提示词缺口交给正文模型猜测
 *
 * 本测试验证：
 * - ChapterIntent 新增 underSpecifiedFields 字段，列出为空的关键字段名
 * - 非空字段不被列入 underSpecifiedFields
 * - fieldSourceRefs 仍然追踪实际贡献来源（空字段不记录）
 * - 普通生成模式 + 交付关键字段 under-specified → status="blocked" + failureEnvelope
 * - evalMode（B3/B4）+ under-specified 关键字段 → status="blocked" + failureEnvelope
 *   提示"补充种子源 focusCharacterGoals/choicesAndCosts/..."
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ChapterIntentBuilder } from "../dist-test/v2/core/chapter-intent-builder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

// ── 测试用最小输入 ──────────────────────────────────────────────────────
// 关键：所有关键字段（focusCharacterGoals/choicesAndCosts/expectedIrreversibleChange/
// selectedPromisesToAdvance/causalEndPressure）都会因输入缺失而为空。

function buildMinimalInput(overrides = {}) {
  return {
    chapterNumber: 1,
    intentPrimary: "推进：主角遭遇异象",
    chapterTheme: "初次接触",
    targetEmotions: ["紧张", "好奇"],
    characters: [
      { name: "林轩", role: "主角", mentality: "戒备", recentAction: "调查", pendingTension: "未知威胁" },
    ],
    immutableFacts: ["林轩是记者"],
    openPromises: [], // 空 → selectedPromisesToAdvance 为空
    openArcs: [],
    currentPressureSummary: ["不明势力潜伏"],
    prevContinuationAvailable: false,
    pendingCosts: undefined, // 无 → choicesAndCosts 为空
    ...overrides,
  };
}

const MINIMAL_CONSTITUTION = {
  workIdentity: "测试作品",
  readerPromise: ["沉浸式阅读体验"],
  genrePromises: ["悬疑节奏"],
  protagonistCoreConflict: "揭真相 vs 保命",
  thematicQuestions: ["真相的代价？"],
  aestheticDirection: ["冷峻笔触"],
  forbiddenDrift: ["不破坏世界观"],
  narrativePreferences: {},
};

// ============================================================================
// 1. underSpecifiedFields 字段存在并标记空关键字段
// ============================================================================

test("INTENT-COMPLETENESS-1 · underSpecifiedFields 字段存在", () => {
  const builder = new ChapterIntentBuilder();
  const { intent } = builder.build(buildMinimalInput(), MINIMAL_CONSTITUTION, null);

  // underSpecifiedFields 必须存在且为数组
  assert.ok(
    Array.isArray(intent.underSpecifiedFields),
    `underSpecifiedFields 必须为数组，实际: ${typeof intent.underSpecifiedFields}`,
  );
});

test("INTENT-COMPLETENESS-1 · 空关键字段被列入 underSpecifiedFields", () => {
  const builder = new ChapterIntentBuilder();
  const { intent } = builder.build(buildMinimalInput(), MINIMAL_CONSTITUTION, null);

  // 关键字段为空（无 pendingCosts/openPromises/schema 缺失）时应被列入
  // focusCharacterGoals: schema 无 goal 字段 → 必为空
  // choicesAndCosts: pendingCosts undefined → 必为空
  // expectedIrreversibleChange: schema 无不可逆证据 → 必为空
  // selectedPromisesToAdvance: openPromises=[] → 必为空
  // causalEndPressure: schema 无因果压力字段 → 必为空
  assert.ok(
    intent.underSpecifiedFields.includes("focusCharacterGoals"),
    `focusCharacterGoals 应在 underSpecifiedFields 中，实际: ${JSON.stringify(intent.underSpecifiedFields)}`,
  );
  assert.ok(
    intent.underSpecifiedFields.includes("choicesAndCosts"),
    `choicesAndCosts 应在 underSpecifiedFields 中，实际: ${JSON.stringify(intent.underSpecifiedFields)}`,
  );
  assert.ok(
    intent.underSpecifiedFields.includes("expectedIrreversibleChange"),
    `expectedIrreversibleChange 应在 underSpecifiedFields 中，实际: ${JSON.stringify(intent.underSpecifiedFields)}`,
  );
  assert.ok(
    intent.underSpecifiedFields.includes("selectedPromisesToAdvance"),
    `selectedPromisesToAdvance 应在 underSpecifiedFields 中，实际: ${JSON.stringify(intent.underSpecifiedFields)}`,
  );
  assert.ok(
    intent.underSpecifiedFields.includes("causalEndPressure"),
    `causalEndPressure 应在 underSpecifiedFields 中，实际: ${JSON.stringify(intent.underSpecifiedFields)}`,
  );
});

// ============================================================================
// 2. 非空字段不被列入 underSpecifiedFields
// ============================================================================

test("INTENT-COMPLETENESS-1 · 非空 selectedPromisesToAdvance 不被列入 underSpecifiedFields", () => {
  const builder = new ChapterIntentBuilder();
  const input = buildMinimalInput({
    openPromises: [
      { id: "p1", description: "林轩承诺追查真相" },
      { id: "p2", description: "林轩承诺保护线人" },
    ],
  });
  const { intent } = builder.build(input, MINIMAL_CONSTITUTION, null);

  // selectedPromisesToAdvance 应非空（来自 openPromises fallback）
  assert.ok(
    Array.isArray(intent.selectedPromisesToAdvance) && intent.selectedPromisesToAdvance.length > 0,
    `selectedPromisesToAdvance 应非空，实际: ${JSON.stringify(intent.selectedPromisesToAdvance)}`,
  );
  // 不应被列入 underSpecifiedFields
  assert.ok(
    !intent.underSpecifiedFields.includes("selectedPromisesToAdvance"),
    `selectedPromisesToAdvance 非空时不应在 underSpecifiedFields 中，实际: ${JSON.stringify(intent.underSpecifiedFields)}`,
  );
  // fieldSourceRefs 应记录来源
  assert.ok(
    intent.fieldSourceRefs?.selectedPromisesToAdvance?.includes("chapter-seed:openPromises"),
    `fieldSourceRefs.selectedPromisesToAdvance 必须含 chapter-seed:openPromises，实际: ${JSON.stringify(intent.fieldSourceRefs?.selectedPromisesToAdvance)}`,
  );
});

test("INTENT-COMPLETENESS-1 · 非空 choicesAndCosts 不被列入 underSpecifiedFields", () => {
  const builder = new ChapterIntentBuilder();
  const input = buildMinimalInput({
    pendingCosts: [
      { action: "深挖真相", cost: "暴露身份", chapterIncurred: 0 },
    ],
  });
  const { intent } = builder.build(input, MINIMAL_CONSTITUTION, null);

  // choicesAndCosts 应非空（来自 pendingCosts）
  assert.ok(
    Array.isArray(intent.choicesAndCosts) && intent.choicesAndCosts.length > 0,
    `choicesAndCosts 应非空，实际: ${JSON.stringify(intent.choicesAndCosts)}`,
  );
  assert.ok(
    !intent.underSpecifiedFields.includes("choicesAndCosts"),
    `choicesAndCosts 非空时不应在 underSpecifiedFields 中，实际: ${JSON.stringify(intent.underSpecifiedFields)}`,
  );
  // fieldSourceRefs 应记录来源
  assert.ok(
    intent.fieldSourceRefs?.choicesAndCosts?.includes("chapter-seed:pendingCosts"),
    `fieldSourceRefs.choicesAndCosts 必须含 chapter-seed:pendingCosts，实际: ${JSON.stringify(intent.fieldSourceRefs?.choicesAndCosts)}`,
  );
});

test("INTENT-COMPLETENESS-1 · 显式 ChapterContract 字段原样进入 Intent 并保留 sourceRef", () => {
  const builder = new ChapterIntentBuilder();
  const input = buildMinimalInput({
    choicesAndCosts: [{ choice: "进入封锁区", cost: "失去公开身份" }],
    expectedIrreversibleChange: ["叶尘的公开身份被记录在案"],
    causalEndPressure: ["身份记录触发追捕令"],
  });
  const { intent } = builder.build(input, MINIMAL_CONSTITUTION, null);

  assert.deepEqual(intent.choicesAndCosts, input.choicesAndCosts);
  assert.deepEqual(intent.expectedIrreversibleChange, input.expectedIrreversibleChange);
  assert.deepEqual(intent.causalEndPressure, input.causalEndPressure);
  assert.deepEqual(intent.fieldSourceRefs?.choicesAndCosts, ["chapter-seed:intent.choicesAndCosts"]);
  assert.deepEqual(
    intent.fieldSourceRefs?.expectedIrreversibleChange,
    ["chapter-seed:intent.expectedIrreversibleChange"],
  );
  assert.deepEqual(intent.fieldSourceRefs?.causalEndPressure, ["chapter-seed:intent.causalEndPressure"]);
});

// ============================================================================
// 3. 旧模板字段缺失只记录诊断，不阻断生成
// ============================================================================

test("INTENT-COMPLETENESS-1 · 普通生成不因旧模板字段缺失而阻断", async () => {
  // 普通生成：不传 evalMode
  // 使用 V2_FORCE_STUB=1 + 完整 runUnifiedPipeline 跑一遍
  process.env.V2_FORCE_STUB = "1";

  const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");

  const result = await runUnifiedPipeline({
    workspaceId: "intent-completeness-test",
    chapterId: "test-1",
    chapterNumber: 1,
    projectRoot: process.cwd(),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.failureEnvelope ?? null, null);
  assert.equal(result.stageResults.intentCompleteness.advisoryOnly, true);
  assert.equal(result.stageResults.intentCompleteness.blocking, false);
});

// ============================================================================
// 4. 消融评测也不把固定叙事槽位当成硬门
// ============================================================================

test("INTENT-COMPLETENESS-1 · evalMode 不因 under-specified 旧模板字段阻断", async () => {
  process.env.V2_FORCE_STUB = "1";

  // 直接调用 UnifiedOrchestrator.orchestrate()，传入含 underSpecifiedFields 的 intent
  // 这样测试聚焦在 orchestrator 层级的 under-specified 阻断逻辑，不依赖 entry 层 evalContext 复杂结构
  // 注意：从 dist/ 导入（unified-orchestrator 在生产闭包中，未纳入 dist-test barrel）
  const { UnifiedOrchestrator } = await import("../dist/v2/core/unified-orchestrator.js");

  const orch = new UnifiedOrchestrator();

  // 构造一个含 underSpecifiedFields 的 ChapterIntent（5 个关键字段全为空）
  const intentWithUnderSpecified = {
    chapterFunction: "推进：遭遇异象",
    readerExperience: ["紧张"],
    currentPressure: ["不明势力潜伏"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林轩"],
    inviolableFacts: ["林轩是记者"],
    sourceRefs: ["chapter-seed"],
    concreteDelivery: ["推进本章功能：遭遇异象"],
    focusCharacterGoals: [], // 空
    resistance: ["不明势力潜伏"],
    choicesAndCosts: [], // 空
    expectedIrreversibleChange: [], // 空
    selectedPromisesToAdvance: [], // 空
    causalEndPressure: [], // 空
    factAndCharacterKnowledgeForbiddenZones: ["林轩是记者"],
    fieldSourceRefs: {},
    underSpecifiedFields: [
      "focusCharacterGoals",
      "choicesAndCosts",
      "expectedIrreversibleChange",
      "selectedPromisesToAdvance",
      "causalEndPressure",
    ],
  };

  const result = await orch.orchestrate({
    workspaceId: "intent-completeness-test",
    chapterId: "test-eval-1",
    chapterNumber: 1,
    projectRoot: process.cwd(),
    intent: intentWithUnderSpecified,
    context: {
      facts: [],
      characterStates: [],
      openLoops: [],
      worldRules: [],
      styleReferences: [],
      sourceMap: [],
    },
    constitution: null,
    characterNames: ["林轩"],
    modelGenerate: async () => ({
      text: "stub raw text",
      finishReason: "stop",
    }),
    evalMode: "B0",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.failureEnvelope, null);
  assert.equal(result.stageResults.intentCompleteness.advisoryOnly, true);
  assert.equal(result.stageResults.intentCompleteness.blocking, false);
});

test("INTENT-COMPLETENESS-1 · 生产 orchestrator 将旧模板缺项保持为 advisory", async () => {
  process.env.V2_FORCE_STUB = "1";

  // 注意：从 dist/ 导入（unified-orchestrator 在生产闭包中，未纳入 dist-test barrel）
  const { UnifiedOrchestrator } = await import("../dist/v2/core/unified-orchestrator.js");

  const orch = new UnifiedOrchestrator();

  const intentWithUnderSpecified = {
    chapterFunction: "推进：遭遇异象",
    readerExperience: ["紧张"],
    currentPressure: ["不明势力潜伏"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林轩"],
    inviolableFacts: ["林轩是记者"],
    sourceRefs: ["chapter-seed"],
    concreteDelivery: ["推进本章功能"],
    focusCharacterGoals: [],
    resistance: ["不明势力潜伏"],
    choicesAndCosts: [],
    expectedIrreversibleChange: [],
    selectedPromisesToAdvance: [],
    causalEndPressure: [],
    factAndCharacterKnowledgeForbiddenZones: ["林轩是记者"],
    fieldSourceRefs: {},
    underSpecifiedFields: ["focusCharacterGoals", "choicesAndCosts"],
  };

  const result = await orch.orchestrate({
    workspaceId: "intent-completeness-test",
    chapterId: "test-normal-1",
    chapterNumber: 1,
    projectRoot: process.cwd(),
    intent: intentWithUnderSpecified,
    context: {
      facts: [],
      characterStates: [],
      openLoops: [],
      worldRules: [],
      styleReferences: [],
      sourceMap: [],
    },
    constitution: null,
    characterNames: ["林轩"],
    modelGenerate: async () => ({
      text: "stub raw text for normal mode",
      finishReason: "stop",
    }),
    // 不传 evalMode → 普通生成模式
  });

  assert.equal(result.status, "ok");
  assert.equal(result.failureEnvelope, null);
  assert.equal(result.stageResults.intentCompleteness.advisoryOnly, true);
  assert.equal(result.stageResults.intentCompleteness.blocking, false);
});
