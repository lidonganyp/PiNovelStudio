/**
 * Phase 2C：EvidencePlan 执行测试
 *
 * 验收口径（计划 §2C）：
 * - mustVerify 出现在 agentic prompt 中（"本章必须验证的事实点" block）
 * - allowedTools 限制工具集（只保留白名单内工具）
 * - stopConditions.maxStagnantRounds 驱动 verifyAndPatch 停滞退出
 *
 * 测试策略：
 * 1. 直接测试 createEvidencePlan：验证 mustVerify 提取、allowedTools 默认值、stopConditions 默认值
 * 2. 通过 mock agenticCandidateSource 验证 plan 被传递给 loop
 * 3. 通过源码静态检查验证 mustVerify 注入 prompt 的代码路径存在
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createEvidencePlan,
  extractMustVerifyFromIntent,
  inferAllowedToolsFromIntent,
  extractKnownFromContext,
  ALL_NARRATIVE_TOOLS,
  DEFAULT_STOP_CONDITIONS,
} from "../dist-test/novelos/agent/evidence-plan.js";

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// ============================================================================
// 1. createEvidencePlan 基础行为
// ============================================================================

test("Phase 2C · createEvidencePlan 默认 allowedTools 包含全部 9 工具", () => {
  const plan = createEvidencePlan({
    chapterIntent: "测试意图",
    seedContext: "测试种子",
  });
  assert.equal(plan.allowedTools.length, ALL_NARRATIVE_TOOLS.length, "默认应包含全部工具");
  for (const tool of ALL_NARRATIVE_TOOLS) {
    assert.ok(plan.allowedTools.includes(tool), `默认应包含 ${tool}`);
  }
});

test("Phase 2C · createEvidencePlan 默认 stopConditions 与 DEFAULT_STOP_CONDITIONS 一致", () => {
  const plan = createEvidencePlan({
    chapterIntent: "测试",
    seedContext: "测试",
  });
  assert.equal(plan.stopConditions.maxStagnantRounds, DEFAULT_STOP_CONDITIONS.maxStagnantRounds);
  assert.equal(plan.stopConditions.verifierHardErrorsCleared, DEFAULT_STOP_CONDITIONS.verifierHardErrorsCleared);
  assert.equal(plan.stopConditions.modelDeclaresSufficient, DEFAULT_STOP_CONDITIONS.modelDeclaresSufficient);
});

test("Phase 2C · createEvidencePlan 支持自定义 stopConditions 覆盖", () => {
  const plan = createEvidencePlan({
    chapterIntent: "测试",
    seedContext: "测试",
    stopConditions: { maxStagnantRounds: 5 },
  });
  assert.equal(plan.stopConditions.maxStagnantRounds, 5, "应覆盖 maxStagnantRounds");
  assert.equal(
    plan.stopConditions.verifierHardErrorsCleared,
    DEFAULT_STOP_CONDITIONS.verifierHardErrorsCleared,
    "未覆盖字段保持默认",
  );
});

test("Phase 2C · createEvidencePlan 支持自定义 allowedTools", () => {
  const customTools = ["search_narrative_evidence", "query_canon"];
  const plan = createEvidencePlan({
    chapterIntent: "测试",
    seedContext: "测试",
    allowedTools: customTools,
  });
  assert.deepEqual(plan.allowedTools, customTools, "应使用自定义 allowedTools");
});

// ============================================================================
// 2. mustVerify 提取
// ============================================================================

test("Phase 2C · mustVerify 从 chapterIntent 引号内容提取", () => {
  const plan = createEvidencePlan({
    chapterIntent: '本章必须验证「玉衡星」和「叶尘的封印」相关设定',
    seedContext: "",
  });
  assert.ok(plan.mustVerify.length > 0, "应提取到 mustVerify 项");
  // 引号内容应被提取
  const allMustVerify = plan.mustVerify.join(" ");
  assert.ok(allMustVerify.includes("玉衡星") || allMustVerify.includes("叶尘"), "应包含引号内实体");
});

test("Phase 2C · mustVerify 从 '关于X'/'涉及X' 后的短语提取", () => {
  const plan = createEvidencePlan({
    chapterIntent: "本章涉及黑煞宗的追踪术，关于封印解除需要查证",
    seedContext: "",
  });
  assert.ok(plan.mustVerify.length > 0, "应提取到 mustVerify 项");
  const allMustVerify = plan.mustVerify.join(" ");
  assert.ok(
    allMustVerify.includes("黑煞宗") || allMustVerify.includes("封印"),
    "应包含'涉及/关于'后的短语",
  );
});

test("Phase 2C · mustVerify 从 seedContext 角色名/地名提取", () => {
  const plan = createEvidencePlan({
    chapterIntent: "推进剧情",
    seedContext: "角色：叶尘\n地点：玉衡星\n能力：炼体期",
  });
  assert.ok(plan.mustVerify.length > 0, "应提取到 mustVerify 项");
  const allMustVerify = plan.mustVerify.join(" ");
  assert.ok(
    allMustVerify.includes("叶尘") || allMustVerify.includes("玉衡星"),
    "应包含 seed 中的实体",
  );
});

test("Phase 2C · mustVerify 最多 8 项（防无界遍历）", () => {
  const manyQuotes = Array.from({ length: 20 }, (_, i) => `「实体${i}」`).join("");
  const plan = createEvidencePlan({
    chapterIntent: manyQuotes,
    seedContext: "",
  });
  assert.ok(plan.mustVerify.length <= 8, `应限制在 8 项以内，实际: ${plan.mustVerify.length}`);
});

test("Phase 2C · 显式 '作者章纲必须包含：' 优先提取", () => {
  const plan = createEvidencePlan({
    chapterIntent: "作者章纲必须包含：传承激活；追踪者出现；封印解除",
    seedContext: "其他「引号内容」不应被提取",
  });
  assert.ok(plan.mustVerify.length >= 2, "应提取到至少 2 项");
  const allMustVerify = plan.mustVerify.join(" ");
  assert.ok(allMustVerify.includes("传承激活"), "应包含'传承激活'");
  assert.ok(allMustVerify.includes("追踪者出现"), "应包含'追踪者出现'");
});

// ============================================================================
// 3. 源码静态检查：mustVerify 注入 prompt + stopConditions 驱动停止
// ============================================================================

test("Phase 2C · narrative-agent-loop.ts 源码包含 mustVerify 注入逻辑", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "narrative-agent-loop.ts"),
    "utf8",
  );
  assert.match(source, /plan\.mustVerify/, "应引用 plan.mustVerify");
  assert.match(source, /本章必须验证的事实点/, "应注入'本章必须验证的事实点' block");
});

test("Phase 2C · narrative-agent-loop.ts 源码用 plan.stopConditions.maxStagnantRounds 驱动停止", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "narrative-agent-loop.ts"),
    "utf8",
  );
  assert.match(
    source,
    /plan\.stopConditions\.maxStagnantRounds/,
    "应读取 plan.stopConditions.maxStagnantRounds",
  );
  assert.match(
    source,
    /stagnantRounds\s*>=\s*maxStagnant/,
    "应用 maxStagnant 判断停滞退出",
  );
});

test("Phase 2C · agentic-raw-candidate-source.ts 源码用 plan.allowedTools 过滤工具集", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  assert.match(source, /createEvidencePlan/, "应在 runtime 创建前创建 EvidencePlan");
  assert.match(
    source,
    /evidencePlan\.allowedTools/,
    "应用 evidencePlan.allowedTools 过滤工具集",
  );
  assert.match(
    source,
    /allowedToolSet/,
    "应构造 allowedToolSet 进行过滤",
  );
});

test("Phase 2C · agentic-raw-candidate-source.ts 把 evidencePlan 传给 loop.run", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  assert.match(
    source,
    /evidencePlan,/,
    "应在 loop.run 参数中传入 evidencePlan",
  );
});

test("Phase 2C · AgentLoopInput 类型包含 evidencePlan 可选字段", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "narrative-agent-loop-types.ts"),
    "utf8",
  );
  assert.match(source, /evidencePlan\?\s*:\s*EvidencePlan/, "AgentLoopInput 应有 evidencePlan 可选字段");
});

// ============================================================================
// 4. Phase 2D：intent 驱动的 EvidencePlan（缺口三核心）
// ============================================================================

/** 构造测试用 ChapterIntent（最小完整章卡子集） */
function makeTestIntent(overrides = {}) {
  return {
    chapterFunction: "推进核心情节",
    readerExperience: ["悬念"],
    currentPressure: ["主角面临挑战"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林默", "叶尘"],
    inviolableFacts: ["林默伤势未愈", "叶尘封印未解"],
    sourceRefs: [],
    ...overrides,
  };
}

/** 构造测试用 CompiledContext（最小子集） */
function makeTestContext(overrides = {}) {
  return {
    facts: [],
    characterStates: [
      { characterId: "c1", name: "林默", state: { 伤势: "未愈" }, sourceIds: ["s1"] },
      { characterId: "c2", name: "叶尘", state: { 封印: "未解" }, sourceIds: ["s2"] },
    ],
    openLoops: [
      { id: "p1", description: "林默的承诺", openedAt: "ch1", urgency: 0.5, sourceIds: ["s3"] },
    ],
    worldRules: [
      { id: "w1", description: "林默伤势未愈时不得全力出手", type: "constraint", affectedCharacters: ["林默"], sourceIds: ["s4"] },
    ],
    styleReferences: [],
    sourceMap: [],
    ...overrides,
  };
}

// ── extractMustVerifyFromIntent ──

test("Phase 2D · extractMustVerifyFromIntent 从 inviolableFacts 提取 mustVerify", () => {
  const intent = makeTestIntent();
  const items = extractMustVerifyFromIntent(intent);
  assert.ok(items.includes("林默伤势未愈"), "应包含 inviolableFacts 条目");
  assert.ok(items.includes("叶尘封印未解"), "应包含 inviolableFacts 条目");
});

test("Phase 2D · extractMustVerifyFromIntent 从 authorMustInclude 提取", () => {
  const intent = makeTestIntent({
    authorMustInclude: ["确认封印解除条件", "追踪者首次出现"],
  });
  const items = extractMustVerifyFromIntent(intent);
  assert.ok(items.includes("确认封印解除条件"), "应包含 authorMustInclude 条目");
  assert.ok(items.includes("追踪者首次出现"), "应包含 authorMustInclude 条目");
});

test("Phase 2D · extractMustVerifyFromIntent 从 factAndCharacterKnowledgeForbiddenZones 提取", () => {
  const intent = makeTestIntent({
    factAndCharacterKnowledgeForbiddenZones: ["叶尘不知道林默的真实身份"],
  });
  const items = extractMustVerifyFromIntent(intent);
  assert.ok(items.includes("叶尘不知道林默的真实身份"), "应包含角色知识禁区");
});

test("Phase 2D · extractMustVerifyFromIntent 从 selectedPromisesToAdvance 提取", () => {
  const intent = makeTestIntent({
    selectedPromisesToAdvance: [
      { promiseId: "p1", description: "林默的承诺" },
    ],
  });
  const items = extractMustVerifyFromIntent(intent);
  assert.ok(items.some((s) => s.includes("林默的承诺")), "应包含伏笔前缀 + 描述");
});

test("Phase 2D · extractMustVerifyFromIntent 从 expectedIrreversibleChange 提取", () => {
  const intent = makeTestIntent({
    expectedIrreversibleChange: ["林默觉醒传承"],
  });
  const items = extractMustVerifyFromIntent(intent);
  assert.ok(items.some((s) => s.includes("林默觉醒传承")), "应包含不可逆变化前缀 + 描述");
});

test("Phase 2D · extractMustVerifyFromIntent 去重 + 最多 8 项", () => {
  const intent = makeTestIntent({
    authorMustInclude: Array.from({ length: 10 }, (_, i) => `项${i}`),
    inviolableFacts: ["项0", "项1"], // 与 authorMustInclude 重复
  });
  const items = extractMustVerifyFromIntent(intent);
  assert.ok(items.length <= 8, `应限制在 8 项以内，实际: ${items.length}`);
  // 重复项应去重
  const uniqueSet = new Set(items);
  assert.equal(uniqueSet.size, items.length, "不应有重复项");
});

// ── inferAllowedToolsFromIntent ──

test("Phase 2D · inferAllowedToolsFromIntent 始终包含通用检索 + 模式记忆", () => {
  const intent = makeTestIntent({
    inviolableFacts: [],
    factAndCharacterKnowledgeForbiddenZones: [],
    focusCharacterGoals: [],
    resistance: [],
    choicesAndCosts: [],
    causalEndPressure: [],
    selectedPromisesToAdvance: [],
    characterMotivations: [],
  });
  const tools = inferAllowedToolsFromIntent(intent);
  assert.ok(tools.includes("search_narrative_evidence"), "应始终包含 search_narrative_evidence");
  assert.ok(tools.includes("query_pattern_memory"), "应始终包含 query_pattern_memory");
});

test("Phase 2D · inferAllowedToolsFromIntent inviolableFacts 非空时加 canon + knowledge_boundary", () => {
  const intent = makeTestIntent(); // inviolableFacts 非空
  const tools = inferAllowedToolsFromIntent(intent);
  assert.ok(tools.includes("query_canon"), "inviolableFacts 非空应加 query_canon");
  assert.ok(tools.includes("query_character_knowledge_boundary"), "应加 query_character_knowledge_boundary");
});

test("Phase 2D · inferAllowedToolsFromIntent focusCharacterGoals 非空时加 character_state", () => {
  const intent = makeTestIntent({
    focusCharacterGoals: [{ character: "林默", goal: "突破封印" }],
  });
  const tools = inferAllowedToolsFromIntent(intent);
  assert.ok(tools.includes("query_character_state"), "focusCharacterGoals 非空应加 query_character_state");
});

test("Phase 2D · inferAllowedToolsFromIntent causalEndPressure 非空时加 timeline", () => {
  const intent = makeTestIntent({
    causalEndPressure: ["章末留下追踪者逼近的因果压力"],
  });
  const tools = inferAllowedToolsFromIntent(intent);
  assert.ok(tools.includes("query_timeline"), "causalEndPressure 非空应加 query_timeline");
});

test("Phase 2D · inferAllowedToolsFromIntent selectedPromisesToAdvance 非空时加 promise_ledger + chapter_span", () => {
  const intent = makeTestIntent({
    selectedPromisesToAdvance: [{ promiseId: "p1", description: "承诺" }],
  });
  const tools = inferAllowedToolsFromIntent(intent);
  assert.ok(tools.includes("query_promise_ledger"), "应加 query_promise_ledger");
  assert.ok(tools.includes("search_chapter_span"), "应加 search_chapter_span");
});

test("Phase 2D · inferAllowedToolsFromIntent bridgeContextAvailable=true 加 chapter_span", () => {
  const intent = makeTestIntent({
    selectedPromisesToAdvance: [],
  });
  const tools = inferAllowedToolsFromIntent(intent, true);
  assert.ok(tools.includes("search_chapter_span"), "bridgeContextAvailable 应加 search_chapter_span");
});

test("Phase 2D · inferAllowedToolsFromIntent 空白 intent 只返回 2 个基础工具", () => {
  const intent = makeTestIntent({
    inviolableFacts: [],
    factAndCharacterKnowledgeForbiddenZones: [],
    focusCharacterGoals: [],
    resistance: [],
    choicesAndCosts: [],
    causalEndPressure: [],
    authorEventSummaries: [],
    selectedPromisesToAdvance: [],
    characterMotivations: [],
  });
  const tools = inferAllowedToolsFromIntent(intent, false);
  assert.equal(tools.length, 2, `空白 intent 应只返回 2 个基础工具，实际: ${tools.length}`);
});

// ── extractKnownFromContext ──

test("Phase 2D · extractKnownFromContext 提取相关角色 state 摘要", () => {
  const intent = makeTestIntent({ relevantCharacters: ["林默"] });
  const context = makeTestContext();
  const known = extractKnownFromContext(intent, context);
  assert.ok(known.length > 0, "应提取到已知事实");
  assert.ok(known.some((k) => k.includes("林默")), "应包含林默的 state");
  // 不相关角色不应被提取
  assert.ok(!known.some((k) => k.startsWith("叶尘")), "不应包含不相关角色");
});

test("Phase 2D · extractKnownFromContext 提取与 inviolableFacts 重叠的 worldRule", () => {
  const intent = makeTestIntent({ inviolableFacts: ["林默伤势未愈"] });
  const context = makeTestContext();
  const known = extractKnownFromContext(intent, context);
  assert.ok(
    known.some((k) => k.includes("林默伤势未愈")),
    "应包含与 inviolableFacts 重叠的 worldRule",
  );
});

test("Phase 2D · extractKnownFromContext 提取 selectedPromisesToAdvance 对应的 openLoop", () => {
  const intent = makeTestIntent({
    selectedPromisesToAdvance: [{ promiseId: "p1", description: "林默的承诺" }],
  });
  const context = makeTestContext();
  const known = extractKnownFromContext(intent, context);
  assert.ok(
    known.some((k) => k.includes("林默的承诺")),
    "应包含 selectedPromisesToAdvance 对应的 openLoop",
  );
});

test("Phase 2D · extractKnownFromContext 每条 ≤ 80 字（防 prompt 过载）", () => {
  const intent = makeTestIntent({ relevantCharacters: ["林默"] });
  const longState = { detail: "x".repeat(200) };
  const context = makeTestContext({
    characterStates: [{ characterId: "c1", name: "林默", state: longState, sourceIds: ["s1"] }],
  });
  const known = extractKnownFromContext(intent, context);
  for (const item of known) {
    assert.ok(item.length <= 80, `每条 known 应 ≤ 80 字，实际: ${item.length}（${item.slice(0, 30)}...）`);
  }
});

test("Phase 2D · extractKnownFromContext 最多 12 条", () => {
  const manyCharacters = Array.from({ length: 20 }, (_, i) => `角色${i}`);
  const intent = makeTestIntent({ relevantCharacters: manyCharacters });
  const context = makeTestContext({
    characterStates: manyCharacters.map((name, i) => ({
      characterId: `c${i}`,
      name,
      state: { val: i },
      sourceIds: [`s${i}`],
    })),
  });
  const known = extractKnownFromContext(intent, context);
  assert.ok(known.length <= 12, `应限制在 12 条以内，实际: ${known.length}`);
});

// ── createEvidencePlan 集成（intent 驱动） ──

test("Phase 2D · createEvidencePlan 传入 intent 时用结构化提取（非字符串启发式）", () => {
  const intent = makeTestIntent({
    inviolableFacts: ["林默伤势未愈"],
    authorMustInclude: ["确认追踪者出现"],
  });
  const plan = createEvidencePlan({
    chapterIntent: "无关的字符串（不应被使用）",
    seedContext: "",
    intent,
  });
  // mustVerify 应来自 intent 结构化字段，不是字符串启发式
  assert.ok(plan.mustVerify.includes("林默伤势未愈"), "应从 intent.inviolableFacts 提取");
  assert.ok(plan.mustVerify.includes("确认追踪者出现"), "应从 intent.authorMustInclude 提取");
});

test("Phase 2D · createEvidencePlan 传入 intent 时收窄 allowedTools（缺口一）", () => {
  // 只激活部分条件，验证工具集 < 全量 9
  // 激活 inviolableFacts + focusCharacterGoals + causalEndPressure
  // 不激活 selectedPromisesToAdvance + characterMotivations → 少 query_promise_ledger + query_voice_evidence
  const intent = makeTestIntent({
    inviolableFacts: ["林默伤势未愈"],
    factAndCharacterKnowledgeForbiddenZones: ["叶尘不知道真相"],
    focusCharacterGoals: [{ character: "林默", goal: "突破" }],
    causalEndPressure: ["章末压力"],
    selectedPromisesToAdvance: [],
    characterMotivations: [],
  });
  const plan = createEvidencePlan({
    chapterIntent: "测试",
    seedContext: "",
    intent,
  });
  // 应收窄到 < 全量 9 工具
  assert.ok(
    plan.allowedTools.length < ALL_NARRATIVE_TOOLS.length,
    `应收窄工具集，实际 ${plan.allowedTools.length} < ${ALL_NARRATIVE_TOOLS.length}`,
  );
  // 应包含因 intent 字段而推断出的工具
  assert.ok(plan.allowedTools.includes("query_canon"), "应包含 query_canon");
  assert.ok(plan.allowedTools.includes("query_character_state"), "应包含 query_character_state");
  assert.ok(plan.allowedTools.includes("query_timeline"), "应包含 query_timeline");
  // 不应包含未激活条件的工具
  assert.ok(!plan.allowedTools.includes("query_promise_ledger"), "不应包含 query_promise_ledger");
  assert.ok(!plan.allowedTools.includes("query_voice_evidence"), "不应包含 query_voice_evidence");
});

test("Phase 2D · createEvidencePlan 传入 intent + compiledContext 时提取 known 摘要（缺口三）", () => {
  const intent = makeTestIntent({ relevantCharacters: ["林默"] });
  const context = makeTestContext();
  const plan = createEvidencePlan({
    chapterIntent: "测试",
    seedContext: "",
    intent,
    compiledContext: context,
  });
  assert.ok(plan.known.length > 0, "应提取到 known 摘要");
  assert.ok(plan.known.some((k) => k.includes("林默")), "known 应包含林默的 state");
});

test("Phase 2D · createEvidencePlan 不传 intent 时回退 M1（向后兼容）", () => {
  // 不传 intent → 行为与 Phase 2C 完全一致
  const plan = createEvidencePlan({
    chapterIntent: "作者章纲必须包含：测试项A；测试项B",
    seedContext: "",
  });
  assert.deepEqual(plan.mustVerify, ["测试项A", "测试项B"], "应使用 M1 启发式提取");
  assert.equal(plan.allowedTools.length, ALL_NARRATIVE_TOOLS.length, "默认应包含全部工具");
  assert.equal(plan.known.length, 0, "不传 intent 时 known 为空");
});

test("Phase 2D · createEvidencePlan 传 intent 但不传 compiledContext 时 known 为空", () => {
  const intent = makeTestIntent();
  const plan = createEvidencePlan({
    chapterIntent: "测试",
    seedContext: "",
    intent,
    // 不传 compiledContext
  });
  assert.equal(plan.known.length, 0, "不传 compiledContext 时 known 应为空");
  // mustVerify 仍应从 intent 提取
  assert.ok(plan.mustVerify.length > 0, "mustVerify 仍应从 intent 提取");
});

test("Phase 2D · createEvidencePlan bridgeContextAvailable 传入时影响 allowedTools", () => {
  const intent = makeTestIntent({
    inviolableFacts: [],
    factAndCharacterKnowledgeForbiddenZones: [],
    focusCharacterGoals: [],
    resistance: [],
    choicesAndCosts: [],
    causalEndPressure: [],
    authorEventSummaries: [],
    selectedPromisesToAdvance: [],
    characterMotivations: [],
  });
  // bridgeContextAvailable=false → 不含 search_chapter_span
  const planNoBridge = createEvidencePlan({
    chapterIntent: "",
    seedContext: "",
    intent,
    bridgeContextAvailable: false,
  });
  assert.ok(!planNoBridge.allowedTools.includes("search_chapter_span"), "无 bridge 时不应含 chapter_span");

  // bridgeContextAvailable=true → 含 search_chapter_span
  const planWithBridge = createEvidencePlan({
    chapterIntent: "",
    seedContext: "",
    intent,
    bridgeContextAvailable: true,
  });
  assert.ok(planWithBridge.allowedTools.includes("search_chapter_span"), "有 bridge 时应含 chapter_span");
});

// ============================================================================
// 5. Phase 2D：源码静态检查 — 三缺口修复
// ============================================================================

test("Phase 2D · narrative-agent-loop.ts 注入 plan.known 已知事实摘要", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "narrative-agent-loop.ts"),
    "utf8",
  );
  assert.match(source, /plan\.known/, "应引用 plan.known");
  assert.match(source, /已知事实摘要/, "应注入'已知事实摘要' block");
});

test("Phase 2D · narrative-agent-loop.ts 默认使用不确定性驱动 prompt（缺口二）", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "narrative-agent-loop.ts"),
    "utf8",
  );
  assert.match(source, /DEFAULT_UNCERTAINTY_DRIVEN_PROMPT/, "应定义不确定性驱动 prompt 常量");
  assert.match(source, /检索决策规则/, "prompt 应包含'检索决策规则'");
  assert.match(source, /不调用任何工具/, "应允许上下文足够时不调工具");
  // 不应再硬编码旧的强制检索 prompt 作为默认
  assert.doesNotMatch(
    source,
    /请先使用跨源叙事证据检索工具查找结构化事实证据/,
    "默认 prompt 不应再是旧强制检索文本",
  );
});

test("Phase 2D · agentic-raw-candidate-source.ts 传入 intent + compiledContext + bridgeContextAvailable", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  assert.match(source, /intent,\s*$/m, "应传入 intent 给 createEvidencePlan");
  assert.match(source, /compiledContext:\s*context/, "应传入 compiledContext");
  assert.match(source, /bridgeContextAvailable:\s*context\.bridgeContext/, "应传入 bridgeContextAvailable");
});

test("Phase 2D · uncertainty-driven-ablation.ts 导出 FORCED_RETRIEVAL_PROMPT 常量", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "eval", "uncertainty-driven-ablation.ts"),
    "utf8",
  );
  assert.match(source, /export const FORCED_RETRIEVAL_PROMPT/, "应导出 FORCED_RETRIEVAL_PROMPT");
  assert.match(source, /请先使用跨源叙事证据检索工具查找/, "FORCED_RETRIEVAL_PROMPT 应包含旧强制检索文本");
  // A 组应使用 FORCED_RETRIEVAL_PROMPT（非 undefined）
  // 检查 runAblationArm 中 A 组分支使用 FORCED_RETRIEVAL_PROMPT
  assert.match(
    source,
    /arm === "B"\s*\?\s*UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT\s*:\s*FORCED_RETRIEVAL_PROMPT/,
    "A 组应使用 FORCED_RETRIEVAL_PROMPT，B 组使用 UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT",
  );
});
