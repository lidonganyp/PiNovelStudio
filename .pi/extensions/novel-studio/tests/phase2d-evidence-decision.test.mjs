/**
 * Phase 2D：EvidenceDecision 回合测试（缺口三：让模型参与 EvidencePlan）
 *
 * 验收口径（用户边界）：
 * - 独立结构化决策回合，模型输出 needRetrieval / unknown / selectedTools / queries / retrievalDepth
 * - 系统强制执行：selectedTools ∩ systemAllowedTools、P0/P1 mustVerify 不得被删除、
 *   模型不能修改事实真值、权限/预算/未来状态过滤仍由系统控制
 * - 决策回合失败 fail-safe 回退系统计划（不阻断生成）
 * - 决策写入 context_decision trace
 *
 * 测试策略：
 * 1. 纯函数直接测试：prompt 构造 / JSON 解析 / 系统校验 / 计划合并
 * 2. runEvidenceDecisionRound：用 stub modelGenerate 验证 model 决策生效 + fallback 路径
 * 3. 源码静态检查：caller 接线 runEvidenceDecisionRound + recordContextDecision，
 *    loop 注入 plan.unknown
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildEvidenceDecisionPrompt,
  parseEvidenceDecision,
  validateEvidenceDecision,
  mergeDecisionIntoPlan,
  runEvidenceDecisionRound,
  retrievalCallBudgetForDepth,
  MAX_MODEL_UNKNOWN,
  MAX_RETRIEVAL_DEPTH,
  MIN_RETRIEVAL_DEPTH_WHEN_REQUIRED,
} from "../dist-test/novelos/agent/evidence-decision.js";
import { NarrativeAgentLoop } from "../dist/novelos/agent/narrative-agent-loop.js";
import { injectToolSchemas } from "../dist/novelos/adapters/tool-schema-injector.js";
import { NARRATIVE_TOOL_NAMES } from "../dist-test/novelos/tools/narrative-tools.js";

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// ============================================================================
// 1. buildEvidenceDecisionPrompt
// ============================================================================

test("Phase 2D · buildEvidenceDecisionPrompt 注入 mustVerify + known + systemAllowedTools", () => {
  const prompt = buildEvidenceDecisionPrompt({
    chapterIntent: "本章推进追踪者剧情",
    seedContext: "角色：林默",
    known: ["林默伤势未愈"],
    mustVerify: ["叶尘封印未解"],
    systemAllowedTools: ["search_narrative_evidence", "query_canon"],
  });
  assert.match(prompt, /林默伤势未愈/, "应注入 known 已知事实");
  assert.match(prompt, /叶尘封印未解/, "应注入 mustVerify");
  assert.match(prompt, /search_narrative_evidence/, "应注入 systemAllowedTools");
  assert.match(prompt, /query_canon/, "应注入 systemAllowedTools");
  assert.match(prompt, /needRetrieval/, "应要求输出 needRetrieval 字段");
  assert.match(prompt, /selectedTools/, "应要求输出 selectedTools 字段");
});

// ============================================================================
// 2. parseEvidenceDecision
// ============================================================================

test("Phase 2D · parseEvidenceDecision 解析合法 JSON 决策", () => {
  const text = JSON.stringify({
    needRetrieval: true,
    unknown: ["封印解除条件", "追踪者真实身份"],
    selectedTools: ["search_narrative_evidence", "query_canon"],
    queries: ["叶尘封印 解除条件", "追踪者 身份"],
    retrievalDepth: 2,
  });
  const req = parseEvidenceDecision(text);
  assert.equal(req.needRetrieval, true);
  assert.deepEqual(req.unknown, ["封印解除条件", "追踪者真实身份"]);
  assert.deepEqual(req.selectedTools, ["search_narrative_evidence", "query_canon"]);
  assert.deepEqual(req.queries, ["叶尘封印 解除条件", "追踪者 身份"]);
  assert.equal(req.retrievalDepth, 2);
});

test("Phase 2D · parseEvidenceDecision 容忍 JSON 前后附带说明文本", () => {
  const text = '以下是决策：\n' + JSON.stringify({ needRetrieval: true, unknown: ["X"] }) + '\n（完毕）';
  const req = parseEvidenceDecision(text);
  assert.equal(req.needRetrieval, true);
  assert.deepEqual(req.unknown, ["X"]);
});

test("Phase 2D · parseEvidenceDecision 不可解析时回退默认（不抛错）", () => {
  const req = parseEvidenceDecision("这不是 JSON，模型输出了正文。");
  assert.equal(req.needRetrieval, false);
  assert.deepEqual(req.unknown, []);
  assert.deepEqual(req.selectedTools, []);
  assert.deepEqual(req.queries, []);
  assert.equal(req.retrievalDepth, 0);
});

test("Phase 2D · parseEvidenceDecision 非法字段类型回退 + 上限裁剪", () => {
  const req = parseEvidenceDecision(JSON.stringify({
    needRetrieval: "yes", // 非 boolean → false
    unknown: "not-array", // 非数组 → []
    selectedTools: ["a", "b"],
    queries: Array.from({ length: 20 }, (_, i) => `q${i}`),
    retrievalDepth: 999, // clamp 到 MAX_RETRIEVAL_DEPTH
  }));
  assert.equal(req.needRetrieval, false);
  assert.deepEqual(req.unknown, []);
  assert.equal(req.retrievalDepth, MAX_RETRIEVAL_DEPTH, "retrievalDepth 应被 clamp 到上限");
});

test("Phase 2D · parseEvidenceDecision unknown 裁剪到 MAX_MODEL_UNKNOWN", () => {
  const many = Array.from({ length: 20 }, (_, i) => `未知${i}`);
  const req = parseEvidenceDecision(JSON.stringify({ unknown: many, needRetrieval: true }));
  assert.ok(req.unknown.length <= MAX_MODEL_UNKNOWN, "unknown 应裁剪到上限");
});

// ============================================================================
// 3. validateEvidenceDecision
// ============================================================================

const SYSTEM_TOOLS = ["search_narrative_evidence", "query_canon", "query_character_state", "query_promise_ledger"];
const MUST_VERIFY = ["叶尘封印未解", "林默伤势未愈"];

test("Phase 2D · validateEvidenceDecision selectedTools 与 systemAllowedTools 取交集", () => {
  const request = {
    needRetrieval: true,
    unknown: ["追踪者身份"],
    selectedTools: ["query_canon", "untrusted_tool"], // untrusted_tool 不在系统内
    queries: [],
    retrievalDepth: 1,
  };
  const v = validateEvidenceDecision(request, SYSTEM_TOOLS, MUST_VERIFY);
  assert.deepEqual(v.allowedTools, ["query_canon"], "应只保留系统内工具");
  assert.deepEqual(v.rejectedTools, ["untrusted_tool"], "系统外工具应被拒绝");
});

test("Phase 2D · validateEvidenceDecision 模型选中空工具但有 mustVerify 时回退系统工具集", () => {
  const request = {
    needRetrieval: false,
    unknown: [],
    selectedTools: [],
    queries: [],
    retrievalDepth: 0,
  };
  const v = validateEvidenceDecision(request, SYSTEM_TOOLS, MUST_VERIFY);
  assert.deepEqual(v.allowedTools, SYSTEM_TOOLS, "mustVerify 存在时应保留系统工具集（不可删）");
});

test("Phase 2D · validateEvidenceDecision 无 mustVerify 且空选择时 allowedTools 为空", () => {
  const request = {
    needRetrieval: false,
    unknown: [],
    selectedTools: [],
    queries: [],
    retrievalDepth: 0,
  };
  const v = validateEvidenceDecision(request, SYSTEM_TOOLS, []);
  assert.deepEqual(v.allowedTools, [], "无 mustVerify 时模型可把工具集缩到空");
});

test("Phase 2D · validateEvidenceDecision 保留 mustVerify（模型不得删除）", () => {
  const request = {
    needRetrieval: false,
    unknown: [],
    selectedTools: [],
    queries: [],
    retrievalDepth: 0,
  };
  const v = validateEvidenceDecision(request, SYSTEM_TOOLS, MUST_VERIFY);
  assert.deepEqual(v.protectedMustVerify, MUST_VERIFY, "mustVerify 应完整保留");
});

test("Phase 2D · validateEvidenceDecision unknown 裁剪 + 记录 droppedUnknown", () => {
  const many = Array.from({ length: 20 }, (_, i) => `未知${i}`);
  const request = {
    needRetrieval: true,
    unknown: many,
    selectedTools: ["query_canon"],
    queries: [],
    retrievalDepth: 1,
  };
  const v = validateEvidenceDecision(request, SYSTEM_TOOLS, MUST_VERIFY);
  assert.ok(v.acceptedUnknown.length <= MAX_MODEL_UNKNOWN, "acceptedUnknown 应裁剪");
  assert.equal(v.acceptedUnknown.length + v.droppedUnknown.length, many.length, "裁剪前后总和应守恒");
});

test("Phase 2D · validateEvidenceDecision mustVerify 强制 needRetrieval=true 时 depth 提升到 ≥1（消除自相矛盾）", () => {
  // 模型请求 depth=0（不检索），但 mustVerify 非空 → 系统强制 needRetrieval=true。
  // 若 depth 仍为 0，retrievalBudget=0 会让 beforeToolCall 阻断全部检索，
  // mustVerify 事实无法被覆盖。系统必须把 depth 提升到 ≥1。
  const request = {
    needRetrieval: false,
    unknown: [],
    selectedTools: [],
    queries: [],
    retrievalDepth: 0,
  };
  const v = validateEvidenceDecision(request, SYSTEM_TOOLS, MUST_VERIFY);
  assert.equal(v.needRetrieval, true, "mustVerify 非空时 needRetrieval 应被强制为 true");
  assert.ok(
    v.retrievalDepth >= MIN_RETRIEVAL_DEPTH_WHEN_REQUIRED,
    `depth 应提升到 ≥${MIN_RETRIEVAL_DEPTH_WHEN_REQUIRED}，实际 ${v.retrievalDepth}`,
  );
  assert.equal(
    v.retrievalDepth,
    MIN_RETRIEVAL_DEPTH_WHEN_REQUIRED,
    "无 mustVerify 强制深度时仅提升到最小 1，不虚增",
  );
});

test("Phase 2D · validateEvidenceDecision 无 mustVerify 且 needRetrieval=false 时 depth 保持 0（不虚增）", () => {
  const request = {
    needRetrieval: false,
    unknown: [],
    selectedTools: [],
    queries: [],
    retrievalDepth: 0,
  };
  const v = validateEvidenceDecision(request, SYSTEM_TOOLS, []);
  assert.equal(v.needRetrieval, false, "无 mustVerify 时不强制检索");
  assert.equal(v.retrievalDepth, 0, "不检索时 depth 应保持 0，不得虚增");
});

// ============================================================================
// 4. mergeDecisionIntoPlan
// ============================================================================

test("Phase 2D · mergeDecisionIntoPlan 保持 known/mustVerify 不可变 + 填充 unknown + 收窄 allowedTools", () => {
  const basePlan = {
    known: ["林默伤势未愈"],
    unknown: [],
    mustVerify: ["叶尘封印未解"],
    allowedTools: SYSTEM_TOOLS,
    stopConditions: { maxStagnantRounds: 2, verifierHardErrorsCleared: true, modelDeclaresSufficient: true },
    needRetrieval: true,
    queries: [],
    retrievalDepth: 2,
  };
  const validation = {
    allowedTools: ["query_canon"],
    rejectedTools: [],
    acceptedUnknown: ["追踪者身份"],
    droppedUnknown: [],
    protectedMustVerify: ["叶尘封印未解"],
    needRetrieval: true,
    queries: ["叶尘封印 解除条件", "追踪者 身份"],
    retrievalDepth: 3,
  };
  const merged = mergeDecisionIntoPlan(basePlan, validation);
  // 事实真值不可改
  assert.deepEqual(merged.known, ["林默伤势未愈"], "known 不可变");
  assert.deepEqual(merged.mustVerify, ["叶尘封印未解"], "mustVerify 不可变（模型不可删）");
  assert.deepEqual(merged.stopConditions, basePlan.stopConditions, "stopConditions 不可变");
  // 可变字段
  assert.deepEqual(merged.unknown, ["追踪者身份"], "应填入模型判定未知点");
  assert.deepEqual(merged.allowedTools, ["query_canon"], "应收窄工具集");
  // 缺口三修复：模型判定的检索计划应并入最终计划（驱动下游工具调用）
  assert.equal(merged.needRetrieval, true, "needRetrieval 应并入计划");
  assert.deepEqual(merged.queries, ["叶尘封印 解除条件", "追踪者 身份"], "queries 应并入计划");
  assert.equal(merged.retrievalDepth, 3, "retrievalDepth 应并入计划");
});

test("Phase 2D · mergeDecisionIntoPlan 模型判定不检索时 needRetrieval=false 覆盖基线", () => {
  const basePlan = {
    known: [],
    unknown: [],
    mustVerify: [],
    allowedTools: [],
    stopConditions: { maxStagnantRounds: 2, verifierHardErrorsCleared: true, modelDeclaresSufficient: true },
    needRetrieval: true,
    queries: [],
    retrievalDepth: 2,
  };
  const merged = mergeDecisionIntoPlan(basePlan, {
    allowedTools: [],
    rejectedTools: [],
    acceptedUnknown: [],
    droppedUnknown: [],
    protectedMustVerify: [],
    needRetrieval: false,
    queries: [],
    retrievalDepth: 0,
  });
  assert.equal(merged.needRetrieval, false, "模型判定不检索应覆盖基线");
  assert.equal(merged.retrievalDepth, 0);
  assert.deepEqual(merged.queries, []);
});

// ============================================================================
// 5. runEvidenceDecisionRound
// ============================================================================

function makeBasePlan() {
  return {
    known: ["林默伤势未愈"],
    unknown: [],
    mustVerify: ["叶尘封印未解"],
    allowedTools: SYSTEM_TOOLS,
    stopConditions: { maxStagnantRounds: 2, verifierHardErrorsCleared: true, modelDeclaresSufficient: true },
    needRetrieval: true,
    queries: [],
    retrievalDepth: 2,
  };
}

test("Phase 2D · runEvidenceDecisionRound 模型决策生效（source=model）", async () => {
  let calledRoute = "";
  let calledKind = "";
  const stubModel = async (input) => {
    calledRoute = input.route;
    calledKind = input.kind;
    return {
      text: JSON.stringify({
        needRetrieval: true,
        unknown: ["追踪者身份", "封印解除条件"],
        selectedTools: ["query_canon"],
        queries: ["追踪者 身份"],
        retrievalDepth: 1,
      }),
      model: "stub-model",
      route: input.route,
      durationMs: 1,
    };
  };
  const result = await runEvidenceDecisionRound({
    evidencePlan: makeBasePlan(),
    chapterIntent: "本章推进追踪者",
    seedContext: "角色：林默",
    modelGenerate: stubModel,
    route: "v2_rawstage2_gemini31",
  });
  assert.equal(result.decision.source, "model");
  assert.equal(calledRoute, "v2_rawstage2_gemini31", "应复用写手路由");
  assert.ok(calledKind.includes("evidence_decision"), "kind 应标记决策回合");
  assert.deepEqual(result.plan.unknown, ["追踪者身份", "封印解除条件"], "模型未知点应进入计划");
  assert.deepEqual(result.plan.allowedTools, ["query_canon"], "模型选择工具应进入计划（交集内）");
  assert.equal(result.decision.request.needRetrieval, true);
  // 缺口三修复：模型判定的检索计划应进入最终 plan（下游工具调用据此执行）
  assert.equal(result.plan.needRetrieval, true, "needRetrieval 应进入计划");
  assert.deepEqual(result.plan.queries, ["追踪者 身份"], "模型 query 应进入计划");
  assert.equal(result.plan.retrievalDepth, 1, "模型检索深度应进入计划");
  assert.deepEqual(result.decision.request.queries, ["追踪者 身份"], "模型 query 应在决策请求中");
});

test("Phase 2D · runEvidenceDecisionRound 模型调用失败时 fail-safe 回退系统计划", async () => {
  const failingModel = async () => {
    throw new Error("network timeout");
  };
  const basePlan = makeBasePlan();
  const result = await runEvidenceDecisionRound({
    evidencePlan: basePlan,
    chapterIntent: "测试",
    seedContext: "测试",
    modelGenerate: failingModel,
    route: "v2_rawstage2_gemini31",
  });
  assert.equal(result.decision.source, "fallback");
  assert.ok(result.decision.error, "应记录失败原因");
  // 回退计划 = 系统计划（工具集保留系统默认）
  assert.deepEqual(result.plan.allowedTools, SYSTEM_TOOLS, "fallback 应保留系统工具集");
  assert.deepEqual(result.plan.unknown, [], "fallback 无模型未知点");
});

test("Phase 2D · runEvidenceDecisionRound 模型输出不可解析时回退默认（不抛错）", async () => {
  const stubModel = async (input) => ({
    text: "模型没有输出 JSON，只输出了正文。",
    model: "stub-model",
    route: input.route,
    durationMs: 1,
  });
  const result = await runEvidenceDecisionRound({
    evidencePlan: makeBasePlan(),
    chapterIntent: "测试",
    seedContext: "测试",
    modelGenerate: stubModel,
    route: "v2_rawstage2_gemini31",
  });
  // 解析失败 → 默认请求（needRetrieval=false），但模型调用本身成功，source 仍为 model
  assert.equal(result.decision.source, "model");
  assert.equal(result.decision.request.needRetrieval, false);
  assert.deepEqual(result.plan.unknown, []);
  // mustVerify 存在 → allowedTools 保留系统工具集
  assert.deepEqual(result.plan.allowedTools, SYSTEM_TOOLS);
});

// ============================================================================
// 6. 源码静态检查：接线完整性
// ============================================================================

test("Phase 2D · agentic-raw-candidate-source.ts 接线 runEvidenceDecisionRound + recordContextDecision", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  assert.match(source, /runEvidenceDecisionRound/, "应调用决策回合");
  assert.match(source, /recordContextDecision/, "应写 context_decision trace");
  assert.match(source, /decisionRound\.plan/, "应使用合并后的计划");
});

test("Phase 2D · narrative-agent-loop.ts 注入 plan.unknown 需查证的未知点", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "narrative-agent-loop.ts"),
    "utf8",
  );
  assert.match(source, /plan\.unknown/, "应引用 plan.unknown");
  assert.match(source, /需查证的未知点/, "应注入'需查证的未知点' block");
});

test("Phase 2D · 缺口二修复：agentic-raw-candidate-source.ts system prompt 不再强制'先检索'", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /先根据证据计划检索/, "system prompt 不得再含强制先检索语义");
  assert.match(source, /仅当现有上下文不足以保证事实、人物状态或因果关系正确时，才调用叙事证据工具查证/, "应改为不确定性驱动语义");
});

test("Phase 2D · 缺口三执行：narrative-agent-loop.ts 让模型检索计划驱动工具调用", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "narrative-agent-loop.ts"),
    "utf8",
  );
  assert.match(source, /plan\.needRetrieval/, "应消费 plan.needRetrieval");
  assert.match(source, /plan\.queries/, "应消费 plan.queries");
  assert.match(source, /plan\.retrievalDepth/, "应消费 plan.retrievalDepth");
  assert.match(source, /检索执行计划/, "应注入'检索执行计划' block 引导实际工具调用");
});

test("Phase 2D · 缺口三执行：needRetrieval=false 时提示不调用工具（降低调用次数）", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "narrative-agent-loop.ts"),
    "utf8",
  );
  assert.match(source, /当前上下文已充分，无需调用证据工具/, "needRetrieval=false 时应提示不调用工具");
});

test("Phase 2D · trajectory-store.ts 提供 recordContextDecision", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "trajectory", "trajectory-store.ts"),
    "utf8",
  );
  assert.match(source, /recordContextDecision/, "trajectory 应提供 recordContextDecision");
  assert.match(source, /context_decision/, "trajectory entry type 应含 context_decision");
});

// ============================================================================
// 7. 实际工具调用验证：模型检索计划驱动 loop 的 userPrompt（缺口三执行）
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
    unknown: [],
    mustVerify: [],
    allowedTools: [],
    stopConditions: { maxStagnantRounds: 2, verifierHardErrorsCleared: true, modelDeclaresSufficient: true },
    needRetrieval: false,
    queries: [],
    retrievalDepth: 0,
    ...overrides,
  };
}

test("Phase 2D · 缺口三执行：模型 needRetrieval=true 时 loop 注入 query + 深度到实际 prompt", async () => {
  const { loop, prompts } = makeLoopHarness();
  await loop.run({
    chapterIntent: "本章推进追踪者剧情",
    seedContext: "角色：林默",
    context: EMPTY_CONTEXT,
    evidencePlan: makePlan({
      needRetrieval: true,
      queries: ["叶尘封印 解除条件", "追踪者 身份"],
      retrievalDepth: 3,
    }),
  });
  const userPrompt = prompts[0];
  assert.match(userPrompt, /检索执行计划/, "应注入检索执行计划 block");
  assert.match(userPrompt, /叶尘封印 解除条件/, "模型 query 应进入实际 prompt");
  assert.match(userPrompt, /追踪者 身份/, "第二个模型 query 应进入实际 prompt");
  assert.match(userPrompt, /深度检索（3）/, "模型检索深度应进入实际 prompt");
});

test("Phase 2D · 缺口三执行：模型 needRetrieval=false 且无 mustVerify 时不鼓励调用工具", async () => {
  const { loop, prompts } = makeLoopHarness();
  await loop.run({
    chapterIntent: "本章推进追踪者剧情",
    seedContext: "角色：林默",
    context: EMPTY_CONTEXT,
    evidencePlan: makePlan({ needRetrieval: false, queries: [], retrievalDepth: 0 }),
  });
  const userPrompt = prompts[0];
  assert.doesNotMatch(userPrompt, /检索执行计划/, "needRetrieval=false 时不应注入检索执行计划");
  assert.match(userPrompt, /当前上下文已充分，无需调用证据工具/, "应明确告知无需调用工具");
});

// ============================================================================
// 8. 缺口一防御纵深：injectToolSchemas 白名单 fail-closed（防止全量注入绕过生产收窄）
// ============================================================================

test("Phase 2D · 缺口一：injectToolSchemas 注入白名单内的合法叙事工具集", () => {
  // 全量 9 个叙事工具恰为允许集合，应能正常注入（数量上限已由语义白名单取代）
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

test("Phase 2D · 缺口一：injectToolSchemas 白名单外工具 fail-closed 拒绝（防全量注入）", () => {
  // 即使工具集包含全部 9 个叙事工具，只要混入一个白名单外工具（诊断/新增），
  // 注入即被拒绝——防止"全量注入"绕过上游 evidencePlan.allowedTools 过滤。
  const tools = [
    ...NARRATIVE_TOOL_NAMES,
    { name: "diagnostic_inspect_workspace", description: "诊断工具", parameters: { type: "object", properties: {} } },
  ];
  assert.throws(
    () => injectToolSchemas("你是网文作家。", tools, NARRATIVE_TOOL_NAMES),
    /拒绝注入白名单外工具/,
    "白名单外工具（含全量注入绕过）应被 fail-closed 拒绝",
  );
});

// ============================================================================
// 9. 缺口三执行：检索深度 → 工具调用次数预算（系统强制，非仅 prompt 建议）
// ============================================================================

test("Phase 2D · 缺口三执行：retrievalCallBudgetForDepth 按深度映射调用次数预算", () => {
  // depth 0 → 0 次（不检索），1 → 2 次，2 → 4 次，3 → 6 次（深度检索）
  assert.equal(retrievalCallBudgetForDepth(0), 0);
  assert.equal(retrievalCallBudgetForDepth(1), 2);
  assert.equal(retrievalCallBudgetForDepth(2), 4);
  assert.equal(retrievalCallBudgetForDepth(3), 6);
});

test("Phase 2D · 缺口三执行：retrievalCallBudgetForDepth 越界被 clamp 到 [0, 3]", () => {
  assert.equal(retrievalCallBudgetForDepth(-5), 0, "负深度 clamp 到 0");
  assert.equal(retrievalCallBudgetForDepth(99), 6, "超深 clamp 到 MAX_RETRIEVAL_DEPTH 预算");
  assert.equal(retrievalCallBudgetForDepth(1.9), 2, "小数深度取整到 2 档");
});

test("Phase 2D · 缺口三执行：agentic-raw-candidate-source.ts 把检索预算接线进 runtime", () => {
  // 关键执行闭合：即使 runtime.ts 具备 retrievalToolNames/retrievalBudget 能力，
  // 若候选源不传入，深度 → 调用次数 → 停止逻辑即为死代码。此测试守护接线。
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  assert.match(source, /retrievalToolNames:/, "应把检索工具集传给 runtime");
  assert.match(source, /retrievalBudget:/, "应把深度推导的调用预算传给 runtime");
  assert.match(source, /retrievalCallBudgetForDepth\(evidencePlan\.retrievalDepth\)/, "预算应源自模型判定的检索深度");
  assert.match(source, /RETRIEVAL_TOOL_NAMES/, "检索工具集应来自叙事工具子集");
});

test("Phase 2D · 缺口三执行：runtime.ts 统计检索调用并用 beforeToolCall 阻断超预算调用", () => {
  const source = readFileSync(
    join(SOURCE_DIR, "novelos", "runtime", "runtime.ts"),
    "utf8",
  );
  assert.match(source, /retrievalCallCount/, "应统计检索工具调用次数");
  assert.match(source, /retrievalToolNames\.has\(toolName\)/, "应按工具名命中检索集判断");
  assert.match(source, /RETRIEVAL_BUDGET_BLOCK_REASON/, "预算用尽应有阻断 reason 文本");
  assert.match(source, /block: true/, "预算用尽应在 beforeToolCall 返回阻断而非终止 loop");
  assert.match(source, /beforeToolCall/, "应使用 beforeToolCall 阻断检索调用");
  // 预算阻断不再通过 afterToolCall terminate（否则 budget=0 仍放行 1 次、且吞掉最终正文回合）
  assert.doesNotMatch(source, /budgetReachedAfterRetrieval/, "不应再依赖旧 afterToolCall 检索预算判断");
});
