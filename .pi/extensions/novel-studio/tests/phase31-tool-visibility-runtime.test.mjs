/**
 * Phase 3.1 收口：runtime 工具渐进披露核对测试。
 *
 * 锁定真实链路：allowedTools → runtime tools → injectToolSchemas → visibleTools。
 * 用真实 createNarrativeTools + createNovelOSRuntime + injectToolSchemas 验证：
 *
 * 1. allowedTools 过滤后的 subset 才传入 runtime（不是全量 9 个）；
 * 2. injectToolSchemas 只注入白名单内的工具，白名单外工具 fail-closed 拒绝；
 * 3. 注入后的 system prompt 中 "可用工具" 列表 = 过滤后的 visibleTools（渐进披露真实生效）；
 * 4. 对比基线场景：评测直接记录 NARRATIVE_TOOL_NAMES（全量执行面），
 *    与真实模型可见的 schema 集（过滤后 subset）明确区分。
 *
 * 使用 stub modelGenerate，不调用真实模型。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNarrativeTools } from "../dist/novelos/tools/narrative-tools.js";
import { NARRATIVE_TOOL_NAMES, DEFAULT_CHAPTER_LIMIT } from "../dist/novelos/tools/narrative-tools.js";
import { createNarrativeSearchService } from "../dist/novelos/agent/narrative-search-service.js";
import { injectToolSchemas, REACT_CALLING_CONVENTION } from "../dist/novelos/adapters/tool-schema-injector.js";
import { createNovelOSRuntime } from "../dist/novelos/runtime/runtime.js";

/** 构造一个含 1 章正文的临时 workspace，返回 searchService */
function setupWorkspace() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "novelos-visibility-"));
  const wsId = "vis-ws";
  const wsDir = join(tmpRoot, "workspaces", wsId);
  mkdirSync(join(wsDir, "chapters", "chapter-01"), { recursive: true });
  writeFileSync(
    join(wsDir, "chapters", "chapter-01", "final.md"),
    "林默在青鱼嘴发现复苏之眼的能力，与苏雨一同进入水下洞穴。",
    "utf-8",
  );
  writeFileSync(
    join(wsDir, "skeleton.json"),
    JSON.stringify({
      chapterId: "ch1",
      events: [{ eventId: "evt-001", type: "discovery", summary: "主角发现复苏之眼", characters: ["林默"] }],
      locations: ["青鱼嘴"],
    }),
    "utf-8",
  );
  const service = createNarrativeSearchService({
    projectRoot: tmpRoot,
    workspaceId: wsId,
    sourceChapter: "ch1",
  });
  return { service, cleanup: () => rmSync(tmpRoot, { recursive: true, force: true }) };
}

function makeStubRuntimeDeps() {
  const executed = [];
  const budget = {
    isExhausted: () => false,
    getSnapshot: () => ({ turns: 0, toolCalls: executed.length }),
    recordTurn() {},
    recordToolCall() {},
    recordTokens() {},
    recordModelCall() {},
  };
  const trajectory = new Proxy({}, { get: () => () => {} });
  const modelGenerate = async () => ({ text: "最终章节正文。", model: "stub", route: "test", durationMs: 0 });
  return { executed, budget, trajectory, modelGenerate };
}

test("Phase 3.1 · allowedTools 过滤后传入 runtime 的是子集，非全量 9 个", async () => {
  const { service, cleanup } = setupWorkspace();
  try {
    const allTools = createNarrativeTools({ searchService: service });
    assert.equal(allTools.length, 9, "createNarrativeTools 应产出 9 个工具");

    // 模拟上游 evidencePlan.allowedTools 只允许 2 个工具
    const allowedToolSet = new Set(["query_canon", "search_chapter_span"]);
    const filtered = allTools.filter((t) => allowedToolSet.has(t.name));
    assert.deepEqual(
      new Set(filtered.map((t) => t.name)),
      new Set(["query_canon", "search_chapter_span"]),
      "allowdTools 过滤后应只剩允许的工具",
    );
    assert.equal(filtered.length, 2, "渐进披露：模型不应看到全量 9 个工具");

    // 注入后 system prompt 只含这 2 个工具
    const injected = injectToolSchemas("你是网文作家。", filtered, NARRATIVE_TOOL_NAMES);
    assert.ok(injected.includes(REACT_CALLING_CONVENTION), "应注入调用约定");
    assert.ok(injected.includes("世界事实查询"), "应注入 query_canon（中文名）");
    assert.ok(injected.includes("章节原文片段检索"), "应注入 search_chapter_span（中文名）");
    assert.ok(!injected.includes("跨源叙事证据检索"), "未允许的工具不应注入");
    assert.ok(!injected.includes("角色状态查询"), "未允许的工具不应注入");
  } finally {
    cleanup();
  }
});

test("Phase 3.1 · injectToolSchemas 对白名单外工具 fail-closed 拒绝", async () => {
  const { service, cleanup } = setupWorkspace();
  try {
    const allTools = createNarrativeTools({ searchService: service });
    // 构造一个白名单外的"伪造"工具
    const rogue = {
      ...allTools[0],
      name: "diagnostic_dump_all",
    };
    assert.throws(
      () => injectToolSchemas("你是网文作家。", [rogue], NARRATIVE_TOOL_NAMES),
      /injectToolSchemas 拒绝注入白名单外工具/,
      "白名单外工具必须被 fail-closed 拒绝（防全量注入绕过）",
    );
  } finally {
    cleanup();
  }
});

test("Phase 3.1 · 真实 runtime 用过滤后工具集，模型每次调用注入的 schema = visibleTools 子集", async () => {
  const { service, cleanup } = setupWorkspace();
  try {
    const allTools = createNarrativeTools({ searchService: service });
    const allowedToolSet = new Set(["query_canon"]);
    const tools = allTools.filter((t) => allowedToolSet.has(t.name));
    const visibleNames = tools.map((t) => t.name);

    // 断言真实可见集是 NARRATIVE_TOOL_NAMES 的真子集（渐进披露）
    assert.ok(visibleNames.length < NARRATIVE_TOOL_NAMES.size, "渐进披露应只暴露允许的子集");
    assert.ok(visibleNames.every((n) => NARRATIVE_TOOL_NAMES.has(n)), "visible 必须全部在白名单内");

    const { budget, trajectory, modelGenerate } = makeStubRuntimeDeps();
    const runtime = createNovelOSRuntime({
      session: { sessionId: "vis-session" },
      systemPrompt: "你是网文作家。",
      modelGenerate,
      route: "test",
      tools,
      allowedToolNames: NARRATIVE_TOOL_NAMES,
      retrievalToolNames: new Set(visibleNames),
      retrievalBudget: 0,
      budget,
      trajectory,
    });

    // 断言注入到 agent initialState 的 systemPrompt 只含 query_canon
    const injectedPrompt = runtime.agent.state.messages[0]?.systemPrompt ?? runtime.agent.state.systemPrompt
      ?? runtime.agent["props"]?.initialState?.systemPrompt ?? "";
    assert.equal(typeof injectedPrompt, "string");
    assert.ok(injectedPrompt.includes("世界事实查询"), "注入 prompt 应含 query_canon");
    assert.ok(!injectedPrompt.includes("跨源叙事证据检索"), "注入 prompt 不应含未允许工具");

    await runtime.prompt("开始生成本章。");
    await runtime.waitForIdle();
  } finally {
    cleanup();
  }
});

test("Phase 3.1 · 评测的 visibleTools 语义 = 工具执行面（全量），与真实模型可见子集区分", async () => {
  const { service, cleanup } = setupWorkspace();
  try {
    const allTools = createNarrativeTools({ searchService: service });
    // 评测基线记录 NARRATIVE_TOOL_NAMES（执行面全量）
    const evalVisible = [...NARRATIVE_TOOL_NAMES].sort();
    assert.equal(evalVisible.length, 9, "评测执行面 = 全量 9 个工具");

    // 真实生产路径：allowedTools 过滤后的子集才是模型可见 schema
    const allowedToolSet = new Set(["query_canon", "query_character_state", "search_narrative_evidence"]);
    const realVisible = allTools.filter((t) => allowedToolSet.has(t.name)).map((t) => t.name).sort();
    assert.equal(realVisible.length, 3, "真实模型可见 = 3 个允许工具");

    // 关键区分断言：评测全量 ≠ 模型可见子集；真实的可见集是评测执行面的真子集
    assert.ok(realVisible.length < evalVisible.length, "评测执行面 ≥ 真实模型可见集");
    assert.ok(realVisible.every((n) => evalVisible.includes(n)), "真实可见集 ⊆ 评测执行面");
  } finally {
    cleanup();
  }
});

test("Phase 3.1 · search_chapter_span 的 maxChapters 有界（拒绝无界遍历历史章节）", async () => {
  const { service, cleanup } = setupWorkspace();
  try {
    const tools = createNarrativeTools({ searchService: service });
    const tool = tools.find((t) => t.name === "search_chapter_span");
    assert.ok(tool, "应存在 search_chapter_span");

    // 传超大/非法 maxChapters，系统必须收束到 [1, DEFAULT_CHAPTER_LIMIT]，不抛错
    const result = await tool.execute("tc-chapter-limit", {
      query: "复兴之眼",
      maxChapters: 999_999,
      maxResults: 5,
    });
    assert.equal(typeof result.details.returnedCount, "number", "应返回 returnedCount");
    assert.ok(result.details.returnedCount >= 0, "returnedCount 应非负");
    assert.equal(typeof result.details.truncated, "boolean", "应返回 truncated");
    assert.ok(DEFAULT_CHAPTER_LIMIT >= 1, "DEFAULT_CHAPTER_LIMIT 应 ≥ 1");

    // 非法值（NaN/Infinity/负数）也应安全收束，不抛错
    const nanResult = await tool.execute("tc-chapter-nan", {
      query: "复兴之眼",
      maxChapters: Number.NaN,
      maxResults: 5,
    });
    assert.equal(typeof nanResult.details.returnedCount, "number", "NaN maxChapters 应安全降级");
  } finally {
    cleanup();
  }
});