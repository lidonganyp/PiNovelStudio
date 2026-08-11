/**
 * AGENTIC-EVIDENCE-MERGE-1：证据决策合并测试
 *
 * 验收口径（开发计划 §5.1）：
 * - 独立 EvidenceDecision 模型回合已退役，生产不出现 kind="novelos_evidence_decision"
 * - EvidencePlan 收敛为系统安全计划（known / mustVerify / allowedTools / stopConditions / retrievalCallLimit）
 * - Agentic 首轮可自主选择直接生成正文或调用系统授权工具
 * - mustVerify 非空时 coverage gate 仍阻断缺少证据的直生成
 * - 模型不能调用 allowedTools 之外的工具（runtime 白名单 fail-closed）
 * - 检索调用达到 retrievalCallLimit 后 runtime 阻断后续检索
 * - 无 mustVerify 且上下文充分时可零检索完成
 *
 * 原 phase2d-evidence-decision.test.mjs 证明 runEvidenceDecisionRound 已接线；
 * 本文件证明独立回合已退役、Agentic 内生决策和系统边界仍然有效。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createEvidencePlan } from "../dist-test/novelos/agent/evidence-plan.js";
import { NarrativeAgentLoop } from "../dist/novelos/agent/narrative-agent-loop.js";
import { injectToolSchemas } from "../dist/novelos/adapters/tool-schema-injector.js";
import { NARRATIVE_TOOL_NAMES } from "../dist-test/novelos/tools/narrative-tools.js";

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// ============================================================================
// 1. EvidencePlan 系统化：retrievalCallLimit 替代旧字段
// ============================================================================

test("AGENTIC-EVIDENCE-MERGE-1 · EvidencePlan 不含 unknown/queries/needRetrieval/retrievalDepth", () => {
  const plan = createEvidencePlan({
    chapterIntent: "本章推进追踪者剧情",
    seedContext: "角色：林默",
  });
  assert.equal("unknown" in plan, false, "EvidencePlan 不应再含 unknown 字段");
  assert.equal("queries" in plan, false, "EvidencePlan 不应再含 queries 字段");
  assert.equal("needRetrieval" in plan, false, "EvidencePlan 不应再含 needRetrieval 字段");
  assert.equal("retrievalDepth" in plan, false, "EvidencePlan 不应再含 retrievalDepth 字段");
  assert.equal(typeof plan.retrievalCallLimit, "number", "应含 retrievalCallLimit 字段");
  assert.ok(plan.retrievalCallLimit >= 0, "retrievalCallLimit 应为非负数");
});

test("AGENTIC-EVIDENCE-MERGE-1 · 无 mustVerify 时 retrievalCallLimit=2", () => {
  const plan = createEvidencePlan({
    chapterIntent: "普通过渡章节",
    seedContext: "无特殊验证需求",
  });
  assert.equal(plan.mustVerify.length, 0, "无 mustVerify");
  assert.equal(plan.retrievalCallLimit, 2, "无 mustVerify 时上限为 2");
});

test("AGENTIC-EVIDENCE-MERGE-1 · 有 mustVerify 时 retrievalCallLimit=4", () => {
  const plan = createEvidencePlan({
    chapterIntent: "本章涉及叶尘封印解除",
    seedContext: "角色：林默、叶尘",
    intent: {
      chapterFunction: "revelation",
      readerExperience: ["震惊"],
      currentPressure: ["封印松动"],
      meaningfulChoices: [],
      relevantCharacters: ["林默", "叶尘"],
      inviolableFacts: ["叶尘封印不可被普通手段解除"],
      selectedPromisesToAdvance: [],
      causalEndPressure: [],
      authorEventSummaries: [],
      authorMustInclude: [],
      authorStateChanges: [],
      endingTarget: [],
      characterMotivations: [],
      focusCharacterGoals: [],
      resistance: [],
      choicesAndCosts: [],
      expectedIrreversibleChange: [],
      selectedExpectationsToAdvance: [],
      factAndCharacterKnowledgeForbiddenZones: [],
      causalRelations: [],
    },
    compiledContext: {
      facts: [],
      characterStates: [],
      openLoops: [],
      worldRules: [],
      styleReferences: [],
      sourceMap: [],
    },
  });
  assert.ok(plan.mustVerify.length > 0, "应有 mustVerify");
  assert.equal(plan.retrievalCallLimit, 4, "有 mustVerify 时上限为 4");
});

// ============================================================================
// 2. 独立 EvidenceDecision 已物理删除
// ============================================================================

test("AGENTIC-EVIDENCE-MERGE-1 · evidence-decision.ts 已物理删除", () => {
  const filePath = join(SOURCE_DIR, "novelos", "agent", "evidence-decision.ts");
  assert.equal(existsSync(filePath), false, "evidence-decision.ts 应已物理删除");
});

test("AGENTIC-EVIDENCE-MERGE-1 · 生产源码不调用 runEvidenceDecisionRound", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /runEvidenceDecisionRound/, "不得调用 runEvidenceDecisionRound");
  assert.doesNotMatch(source, /novelos_evidence_decision/, "不得包含 novelos_evidence_decision kind");
  assert.doesNotMatch(source, /recordContextDecision/, "不得调用 recordContextDecision");
});

test("AGENTIC-EVIDENCE-MERGE-1 · 生产源码不导入 evidence-decision", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /from.*evidence-decision/, "不得导入 evidence-decision 模块");
});

test("AGENTIC-EVIDENCE-MERGE-1 · narrative-agent-loop 不引用旧 plan 字段", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "narrative-agent-loop.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /plan\.unknown/, "不得引用 plan.unknown");
  assert.doesNotMatch(source, /plan\.needRetrieval/, "不得引用 plan.needRetrieval");
  assert.doesNotMatch(source, /plan\.queries/, "不得引用 plan.queries");
  assert.doesNotMatch(source, /plan\.retrievalDepth/, "不得引用 plan.retrievalDepth");
  // 保留项
  assert.match(source, /plan\.mustVerify/, "应保留 plan.mustVerify 注入");
  assert.match(source, /plan\.known/, "应保留 plan.known 注入");
});

// ============================================================================
// 3. Agentic 首轮可直接生成或调用工具
// ============================================================================

const EMPTY_CONTEXT = {
  facts: [],
  characterStates: [],
  openLoops: [],
  worldRules: [],
  styleReferences: [],
  sourceMap: [],
};

function makeLoopHarness() {
  const prompts = [];
  const runtime = {
    agent: { state: { messages: [] } },
    subscribe() {},
    async prompt(prompt) {
      prompts.push(prompt);
      this.agent.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "草稿正文。" }],
      });
    },
    async waitForIdle() {},
  };
  const noOpStore = new Proxy({}, { get: () => () => {} });
  const budget = {
    isExhausted: () => false,
    getSnapshot: () => ({ turns: prompts.length, toolCalls: 0 }),
  };
  const loop = new NarrativeAgentLoop({
    runtime,
    registry: {},
    searchService: {},
    candidateWorkspace: noOpStore,
    permissionPolicy: {},
    budget,
    trajectory: noOpStore,
  });
  return { loop, prompts };
}

function makePlan(overrides = {}) {
  return {
    known: [],
    mustVerify: [],
    allowedTools: [],
    stopConditions: { maxStagnantRounds: 2, verifierHardErrorsCleared: true, modelDeclaresSufficient: true },
    retrievalCallLimit: 2,
    ...overrides,
  };
}

test("AGENTIC-EVIDENCE-MERGE-1 · 无 mustVerify 时 prompt 不强制检索", async () => {
  const { loop, prompts } = makeLoopHarness();
  await loop.run({
    chapterIntent: "本章推进追踪者剧情",
    seedContext: "角色：林默",
    context: EMPTY_CONTEXT,
    evidencePlan: makePlan({ mustVerify: [], retrievalCallLimit: 2 }),
  });
  const userPrompt = prompts[0];
  assert.match(userPrompt, /如无必要可直接基于本章意图与种子上下文生成正文/, "应提示可直接生成");
  assert.doesNotMatch(userPrompt, /检索执行计划/, "不应注入旧检索执行计划 block");
  assert.doesNotMatch(userPrompt, /需查证的未知点/, "不应注入旧未知点 block");
});

test("AGENTIC-EVIDENCE-MERGE-1 · 有 mustVerify 时 prompt 注入必须验证点", async () => {
  const { loop, prompts } = makeLoopHarness();
  await loop.run({
    chapterIntent: "本章涉及封印解除",
    seedContext: "角色：林默",
    context: EMPTY_CONTEXT,
    evidencePlan: makePlan({
      mustVerify: ["叶尘封印未解", "林默伤势未愈"],
      retrievalCallLimit: 4,
    }),
  });
  const userPrompt = prompts[0];
  assert.match(userPrompt, /叶尘封印未解/, "应注入 mustVerify 项");
  assert.match(userPrompt, /林默伤势未愈/, "应注入 mustVerify 项");
  assert.match(userPrompt, /本章必须验证的事实点/, "应注入 mustVerify block 标题");
});

test("AGENTIC-EVIDENCE-MERGE-1 · known 事实注入 prompt", async () => {
  const { loop, prompts } = makeLoopHarness();
  await loop.run({
    chapterIntent: "本章推进剧情",
    seedContext: "角色：林默",
    context: EMPTY_CONTEXT,
    evidencePlan: makePlan({
      known: ["林默伤势已愈", "苏雨在青鱼嘴等候"],
    }),
  });
  const userPrompt = prompts[0];
  assert.match(userPrompt, /林默伤势已愈/, "应注入 known 事实");
  assert.match(userPrompt, /苏雨在青鱼嘴等候/, "应注入 known 事实");
  assert.match(userPrompt, /已知事实摘要/, "应注入 known block 标题");
});

// ============================================================================
// 4. 工具白名单 fail-closed（保留行为）
// ============================================================================

test("AGENTIC-EVIDENCE-MERGE-1 · injectToolSchemas 注入白名单内的合法叙事工具集", () => {
  const tools = [...NARRATIVE_TOOL_NAMES].map((name) => ({
    name,
    description: `工具 ${name}`,
    parameters: { type: "object", properties: {} },
  }));
  const out = injectToolSchemas("你是网文作家。", tools, NARRATIVE_TOOL_NAMES);
  assert.match(out, /工具调用约定/, "应注入调用约定");
  assert.match(out, /跨源叙事证据检索/, "应注入 search_narrative_evidence 的中文 schema");
  assert.match(out, /世界事实查询/, "应注入 query_canon 的中文 schema");
});

test("AGENTIC-EVIDENCE-MERGE-1 · injectToolSchemas 白名单外工具 fail-closed 拒绝", () => {
  const tools = [
    ...NARRATIVE_TOOL_NAMES,
    { name: "diagnostic_inspect_workspace", description: "诊断工具", parameters: { type: "object", properties: {} } },
  ];
  assert.throws(
    () => injectToolSchemas("你是网文作家。", tools, NARRATIVE_TOOL_NAMES),
    /拒绝注入白名单外工具/,
    "白名单外工具应被 fail-closed 拒绝",
  );
});

// ============================================================================
// 5. 检索预算接线（retrievalCallLimit -> runtime retrievalBudget）
// ============================================================================

test("AGENTIC-EVIDENCE-MERGE-1 · agentic-raw-candidate-source 把 retrievalCallLimit 接线进 runtime", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  assert.match(source, /retrievalBudget:\s*evidencePlan\.retrievalCallLimit/, "应把 retrievalCallLimit 传给 runtime");
  assert.doesNotMatch(source, /retrievalCallBudgetForDepth/, "不得再使用 retrievalCallBudgetForDepth");
  assert.doesNotMatch(source, /evidencePlan\.retrievalDepth/, "不得再引用 retrievalDepth");
});

// ============================================================================
// 6. 检索预算 runtime 黑盒（保留行为：retrievalBudget 上限强制）
// ============================================================================

// Note: runtime 黑盒测试在 phase2d-retrieval-budget-runtime.test.mjs 中已覆盖
// 这里只验证接线，不重复 runtime 级测试

test("AGENTIC-EVIDENCE-MERGE-1 · runtime.ts 仍保留 beforeToolCall 检索预算阻断", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "runtime", "runtime.ts"),
    "utf8",
  );
  assert.match(source, /retrievalCallCount/, "应统计检索工具调用次数");
  assert.match(source, /retrievalToolNames\.has\(toolName\)/, "应按工具名命中检索集判断");
  assert.match(source, /RETRIEVAL_BUDGET_BLOCK_REASON/, "预算用尽应有阻断 reason 文本");
  assert.match(source, /block: true/, "预算用尽应在 beforeToolCall 返回阻断");
});

// ============================================================================
// 7. ToolVisibilitySnapshot 只记录系统允许和可见工具
// ============================================================================

test("AGENTIC-EVIDENCE-MERGE-1 · agentic-raw-candidate-source 工具可见性快照不记录 selectedTools/rejectedTools", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  assert.match(source, /systemAllowedTools:/, "应记录 systemAllowedTools");
  assert.match(source, /visibleTools:/, "应记录 visibleTools");
  assert.doesNotMatch(source, /selectedTools:/, "不应再记录 selectedTools");
  assert.doesNotMatch(source, /rejectedTools:/, "不应再记录 rejectedTools");
});

// ============================================================================
// 8. 不确定性驱动检索规则保留
// ============================================================================

test("AGENTIC-EVIDENCE-MERGE-1 · narrative-agent-loop 保留不确定性驱动检索规则", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "narrative-agent-loop.ts"),
    "utf8",
  );
  assert.match(source, /如果现有上下文已经足以保证事实、人物状态和因果关系正确，可以直接输出正文/, "应保留不确定性驱动规则");
  assert.match(source, /不要为了.*完成流程.*而进行无必要检索/, "应保留不强制检索规则");
});

// ============================================================================
// 9. EvidencePlan 保留 mustVerify/known/allowedTools 提取逻辑
// ============================================================================

test("AGENTIC-EVIDENCE-MERGE-1 · evidence-plan 保留 extractMustVerifyFromIntent", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "evidence-plan.ts"),
    "utf8",
  );
  assert.match(source, /export function extractMustVerifyFromIntent/, "应保留 extractMustVerifyFromIntent");
  assert.match(source, /export function inferAllowedToolsFromIntent/, "应保留 inferAllowedToolsFromIntent");
  assert.match(source, /export function extractKnownFromContext/, "应保留 extractKnownFromContext");
});

test("AGENTIC-EVIDENCE-MERGE-1 · evidence-plan 不导出旧决策类型", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "evidence-plan.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /EvidenceDecisionRequest/, "不应导出 EvidenceDecisionRequest");
  assert.doesNotMatch(source, /EvidenceDecisionValidation/, "不应导出 EvidenceDecisionValidation");
  assert.doesNotMatch(source, /EvidenceDecisionRoundInput/, "不应导出 EvidenceDecisionRoundInput");
});
