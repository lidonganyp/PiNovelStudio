/**
 * IMMUTABLE-FACTS-COMPILER-1 测试（RED）
 *
 * 验收口径（来自任务清单 D:\CODE\PiNovelStudio\delete\任务列表\项目优化20260718.md P1-2）：
 *
 * 从以下来源编译本章硬事实：
 * - 世界观 Canon
 * - 当前有效角色状态
 * - 上一接受章节
 * - 显式章节锚点
 * - 本体层级
 * - 当前开放伏笔
 *
 * 重点阻止模型凭空新增"秘法、封印、组织计划、神器、升级结果"等事实。
 * FactGuard 不只检查"与已知事实冲突"，还要检查高影响新设定是否存在来源授权。
 *
 * 本测试验证：
 * 1. compileImmutableFacts 从 6 个来源编译事实，每条带 category + sourceRef
 * 2. authorizedHighImpactTerms 从源材料提取授权的高影响术语
 * 3. checkUnauthorizedHighImpactSettings 检测正文中的未授权高影响设定
 * 4. 已在源材料中授权的术语不被误报
 * 5. FactGuard 报告包含 unauthorized_high_impact_setting 诊断类型
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { compileImmutableFacts, checkUnauthorizedHighImpactSettings } from "../dist-test/v2/core/immutable-facts-compiler.js";

// ── 测试用最小输入 ──────────────────────────────────────────────────────

function buildMinimalInput(overrides = {}) {
  return {
    // 1. 世界观 Canon
    worldRules: [
      { id: "wr1", description: "修真界分九重境界", type: "world_rule", affectedCharacters: [], sourceIds: ["world-canon"] },
    ],
    constitution: {
      workIdentity: "测试作品",
      readerPromise: ["沉浸式阅读"],
      genrePromises: ["修真节奏"],
      protagonistCoreConflict: "复仇 vs 修行",
      thematicQuestions: ["力量代价？"],
      aestheticDirection: ["冷峻"],
      forbiddenDrift: ["不得违反九重境界体系"],
      narrativePreferences: {},
    },
    // 2. 当前有效角色状态
    characterStates: [
      {
        characterId: "c1",
        name: "林轩",
        state: { realm: "筑基境", role: "主角" },
        sourceIds: ["narrative-state:character:林轩"],
      },
    ],
    // 3. 上一接受章节
    bridgeContext: {
      available: true,
      lastEventSummary: "林轩击败黑衣人，获得古卷",
      openHooks: ["古卷内容未揭晓"],
      unresolvedTensions: ["黑衣人身份未明"],
      introducedCharacters: ["黑衣人"],
      sourceIds: ["prev-chapter:ch3"],
    },
    // 4. 显式章节锚点
    chapterAnchors: [
      "林轩是筑基境修士",
      "古卷来自上古遗迹",
    ],
    // 5. 本体层级
    ontologyLevels: ["筑基境", "金丹境", "元婴境"],
    // 6. 当前开放伏笔
    openPromises: [
      { id: "p1", description: "古卷秘密：古卷中隐藏着一门上古秘法" },
    ],
    openLoops: [
      { id: "ol1", description: "黑衣人组织计划未明", openedAt: "ch3", urgency: 0.8, sourceIds: ["narrative-state:openLoop:ol1"] },
    ],
    ...overrides,
  };
}

// ============================================================================
// 1. compileImmutableFacts 从 6 个来源编译事实
// ============================================================================

test("IMMUTABLE-FACTS-COMPILER-1 · compileImmutableFacts 返回非空 facts 数组", () => {
  const result = compileImmutableFacts(buildMinimalInput());
  assert.ok(
    Array.isArray(result.facts) && result.facts.length > 0,
    `facts 必须为非空数组，实际: ${JSON.stringify(result.facts)}`,
  );
});

test("IMMUTABLE-FACTS-COMPILER-1 · facts 含全部 6 个 category", () => {
  const result = compileImmutableFacts(buildMinimalInput());
  const categories = new Set(result.facts.map((f) => f.category));
  // 6 个来源 category
  assert.ok(categories.has("world_canon"), `必须有 world_canon category，实际: ${[...categories].join(", ")}`);
  assert.ok(categories.has("character_state"), `必须有 character_state category，实际: ${[...categories].join(", ")}`);
  assert.ok(categories.has("prev_chapter"), `必须有 prev_chapter category，实际: ${[...categories].join(", ")}`);
  assert.ok(categories.has("chapter_anchor"), `必须有 chapter_anchor category，实际: ${[...categories].join(", ")}`);
  assert.ok(categories.has("ontology"), `必须有 ontology category，实际: ${[...categories].join(", ")}`);
  assert.ok(categories.has("open_promise"), `必须有 open_promise category，实际: ${[...categories].join(", ")}`);
});

test("IMMUTABLE-FACTS-COMPILER-1 · 每条 fact 含 fact/category/sourceRef", () => {
  const result = compileImmutableFacts(buildMinimalInput());
  for (const f of result.facts) {
    assert.ok(typeof f.fact === "string" && f.fact.length > 0, `fact.fact 必须非空字符串，实际: ${JSON.stringify(f)}`);
    assert.ok(typeof f.category === "string", `fact.category 必须字符串，实际: ${JSON.stringify(f)}`);
    assert.ok(typeof f.sourceRef === "string" && f.sourceRef.length > 0, `fact.sourceRef 必须非空字符串，实际: ${JSON.stringify(f)}`);
  }
});

test("IMMUTABLE-FACTS-COMPILER-1 · sourceRefs 聚合所有来源引用", () => {
  const result = compileImmutableFacts(buildMinimalInput());
  assert.ok(
    Array.isArray(result.sourceRefs) && result.sourceRefs.length > 0,
    `sourceRefs 必须为非空数组，实际: ${JSON.stringify(result.sourceRefs)}`,
  );
  // 至少含 world-canon / narrative-state / prev-chapter 等来源
  const joined = result.sourceRefs.join(";");
  assert.ok(joined.includes("world"), `sourceRefs 应含 world 来源，实际: ${joined}`);
});

// ============================================================================
// 2. authorizedHighImpactTerms 从源材料提取授权的高影响术语
// ============================================================================

test("IMMUTABLE-FACTS-COMPILER-1 · authorizedHighImpactTerms 含源材料中的秘法术语", () => {
  const result = compileImmutableFacts(buildMinimalInput());
  assert.ok(
    Array.isArray(result.authorizedHighImpactTerms),
    `authorizedHighImpactTerms 必须为数组，实际: ${typeof result.authorizedHighImpactTerms}`,
  );
  // openPromises 中提到"上古秘法" → 秘法 应被授权
  const terms = result.authorizedHighImpactTerms.map((t) => t.term);
  assert.ok(
    terms.some((t) => t.includes("秘法") || t === "秘法"),
    `authorizedHighImpactTerms 应含 "秘法"（来自 openPromises "上古秘法"），实际: ${JSON.stringify(terms)}`,
  );
});

test("IMMUTABLE-FACTS-COMPILER-1 · authorizedHighImpactTerms 含源材料中的组织计划术语", () => {
  const result = compileImmutableFacts(buildMinimalInput());
  // openLoops 中提到"黑衣人组织计划" → 组织计划 应被授权
  const terms = result.authorizedHighImpactTerms.map((t) => t.term);
  assert.ok(
    terms.some((t) => t.includes("组织") || t.includes("计划")),
    `authorizedHighImpactTerms 应含 "组织"/"计划"（来自 openLoops），实际: ${JSON.stringify(terms)}`,
  );
});

test("IMMUTABLE-FACTS-COMPILER-1 · 每条 authorizedHighImpactTerms 含 term/category/sourceRef", () => {
  const result = compileImmutableFacts(buildMinimalInput());
  for (const t of result.authorizedHighImpactTerms) {
    assert.ok(typeof t.term === "string" && t.term.length > 0, `term 必须非空字符串，实际: ${JSON.stringify(t)}`);
    assert.ok(typeof t.category === "string", `category 必须字符串，实际: ${JSON.stringify(t)}`);
    assert.ok(typeof t.sourceRef === "string" && t.sourceRef.length > 0, `sourceRef 必须非空字符串，实际: ${JSON.stringify(t)}`);
  }
});

// ============================================================================
// 3. checkUnauthorizedHighImpactSettings 检测未授权高影响新设定
// ============================================================================

test("IMMUTABLE-FACTS-COMPILER-1 · 检测未授权的'神器'新设定", () => {
  const compiled = compileImmutableFacts(buildMinimalInput());
  // 正文中出现"神器"，但源材料中没有"神器" → 应被检测
  const text = "林轩从遗迹中取出一柄神器，神光万丈。";
  const diagnostics = checkUnauthorizedHighImpactSettings(text, compiled);
  assert.ok(
    Array.isArray(diagnostics) && diagnostics.length > 0,
    `未授权"神器"应被检测，实际: ${JSON.stringify(diagnostics)}`,
  );
  const hasArtifact = diagnostics.some((d) =>
    d.category === "artifact" || (d.term && d.term.includes("神器")),
  );
  assert.ok(hasArtifact, `诊断应含 artifact 类别或神器术语，实际: ${JSON.stringify(diagnostics)}`);
});

test("IMMUTABLE-FACTS-COMPILER-1 · 检测未授权的'封印'新设定", () => {
  const compiled = compileImmutableFacts(buildMinimalInput());
  const text = "遗迹深处有一道远古封印，正在松动。";
  const diagnostics = checkUnauthorizedHighImpactSettings(text, compiled);
  assert.ok(
    diagnostics.length > 0,
    `未授权"封印"应被检测，实际: ${JSON.stringify(diagnostics)}`,
  );
});

test("IMMUTABLE-FACTS-COMPILER-1 · 检测未授权的'升级结果'新设定", () => {
  const compiled = compileImmutableFacts(buildMinimalInput());
  // 源材料中角色是"筑基境"，正文写"突破到化神境"（未授权的境界跃迁）
  const text = "林轩猛然突破，直接跨过金丹境，到达化神境。";
  const diagnostics = checkUnauthorizedHighImpactSettings(text, compiled);
  assert.ok(
    diagnostics.length > 0,
    `未授权"化神境"升级应被检测，实际: ${JSON.stringify(diagnostics)}`,
  );
});

// ============================================================================
// 4. 已授权术语不被误报
// ============================================================================

test("IMMUTABLE-FACTS-COMPILER-1 · 已授权的'秘法'不被误报", () => {
  const compiled = compileImmutableFacts(buildMinimalInput());
  // openPromises 中已授权"上古秘法" → 正文提到秘法不应被检测
  const text = "林轩翻开古卷，上古秘法的气息扑面而来。";
  const diagnostics = checkUnauthorizedHighImpactSettings(text, compiled);
  const hasSecretTechnique = diagnostics.some((d) => d.category === "secret_technique");
  assert.ok(
    !hasSecretTechnique,
    `已授权"秘法"不应被误报，实际诊断: ${JSON.stringify(diagnostics)}`,
  );
});

test("IMMUTABLE-FACTS-COMPILER-1 · 已授权的'组织计划'不被误报", () => {
  const compiled = compileImmutableFacts(buildMinimalInput());
  // openLoops 中已授权"组织计划" → 正文提到组织不应被检测
  const text = "黑衣人组织计划逐渐浮出水面。";
  const diagnostics = checkUnauthorizedHighImpactSettings(text, compiled);
  const hasOrgPlan = diagnostics.some((d) => d.category === "organization_plan");
  assert.ok(
    !hasOrgPlan,
    `已授权"组织计划"不应被误报，实际诊断: ${JSON.stringify(diagnostics)}`,
  );
});

test("IMMUTABLE-FACTS-COMPILER-1 · 已授权的'筑基境'本体层级不被误报", () => {
  const compiled = compileImmutableFacts(buildMinimalInput());
  // ontologyLevels 已授权"筑基境" → 正文提到筑基境不应被检测
  const text = "林轩稳固筑基境修为，继续修行。";
  const diagnostics = checkUnauthorizedHighImpactSettings(text, compiled);
  const hasUpgrade = diagnostics.some((d) => d.category === "upgrade_result");
  assert.ok(
    !hasUpgrade,
    `已授权"筑基境"不应被误报为升级结果，实际诊断: ${JSON.stringify(diagnostics)}`,
  );
});

// ============================================================================
// 5. 诊断结构完整性
// ============================================================================

test("IMMUTABLE-FACTS-COMPILER-1 · 诊断含 span/category/term/reason/sourceRef", () => {
  const compiled = compileImmutableFacts(buildMinimalInput());
  const text = "遗迹深处有一柄神器。";
  const diagnostics = checkUnauthorizedHighImpactSettings(text, compiled);
  assert.ok(diagnostics.length > 0, "应有至少一条诊断");
  const d = diagnostics[0];
  assert.ok(typeof d.category === "string", `诊断.category 必须字符串，实际: ${JSON.stringify(d)}`);
  assert.ok(typeof d.term === "string", `诊断.term 必须字符串，实际: ${JSON.stringify(d)}`);
  assert.ok(typeof d.reason === "string" && d.reason.length > 0, `诊断.reason 必须非空字符串，实际: ${JSON.stringify(d)}`);
  // span 可选但应存在（定位到正文位置）
  assert.ok(d.span && typeof d.span.start === "number" && typeof d.span.end === "number",
    `诊断.span 必须含 start/end，实际: ${JSON.stringify(d)}`);
});
