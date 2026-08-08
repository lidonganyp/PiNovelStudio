/**
 * Phase 2D 缺口三执行：检索预算 runtime 黑盒测试（真实 pi-agent-core loop）。
 *
 * 锁定用户报告的三个黑盒行为：
 * - retrievalBudget=0 → 0 次检索工具调用（旧实现为 1 次，被 beforeToolCall 修复）；
 * - retrievalBudget=1 → 恰 1 次检索工具调用；
 * - retrievalBudget=2 → 连续两次检索后，仍有最终正文回合（旧实现会终止 loop 而无正文）。
 *
 * 机制：runtime 用 beforeToolCall 在执行前阻断超预算检索调用（返回 block 工具结果
 * 提示模型停止检索），不终止整个 loop，因此最终正文回合得以保留。
 *
 * 通过 stub modelGenerate 驱动真实 NovelOSRuntime（pi-agent-core loop）：
 * - 脚本返回 (budget+1) 次检索工具调用指令，最后 1 次返回正文；
 * - 断言实际执行的检索工具调用次数恰等于 budget；
 * - 断言 transcript 存在最终正文（text）回合。
 *
 * 使用 stub，不调用真实模型。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createNovelOSRuntime } from "../dist/novelos/runtime/runtime.js";

const RETRIEVAL_TOOL_NAME = "search_narrative_evidence";
const RETRIEVAL_TOOL_NAMES = new Set([RETRIEVAL_TOOL_NAME]);

const TOOL_CALL_DIRECTIVE =
  `<工具调用>{"工具":"跨源叙事证据检索","参数":{"查询词":"暗流"}}</工具调用>`;

/**
 * 构造一次带检索预算的真实 runtime 运行。
 *
 * @param {number} retrievalBudget 检索预算
 * @returns {{ runtime: import("../dist/novelos/runtime/runtime.js").NovelOSRuntime,
 *            executedCount: () => number, calls: () => string[] }}
 */
function runWithBudget(retrievalBudget) {
  let executedCount = 0;
  let callIndex = 0;
  /** 记录每次模型调用返回的 step（"tool" / "text"），用于断言最终回合存在 */
  const steps = [];

  const tool = {
    name: RETRIEVAL_TOOL_NAME,
    label: "跨源叙事证据检索",
    description: "跨源检索结构化叙事证据。",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "搜索关键词" } },
      required: ["query"],
    },
    execute: async () => {
      executedCount += 1;
      return {
        content: [{ type: "text", text: "已检索到的证据。" }],
        details: { sourceRef: "ch1:span", evidenceLevel: "confirmed" },
      };
    },
  };

  const session = { sessionId: "test-session" };
  const budget = {
    isExhausted: () => false,
    getSnapshot: () => ({ turns: 0, toolCalls: executedCount }),
    recordTurn() {},
    recordToolCall() {},
    recordTokens() {},
    recordModelCall() {},
  };
  const trajectory = new Proxy({}, { get: () => () => {} });

  // 脚本：前 (budget+1) 次返回检索工具调用指令（第 budget+1 次会被预算阻断），
  // 最后 1 次返回正文 → 保证"连续检索后仍有最终正文回合"。
  const script = [...Array(retrievalBudget + 1).fill("tool"), "text"];

  const modelGenerate = async () => {
    const step = script[callIndex] ?? "text";
    callIndex += 1;
    steps.push(step);
    if (step === "tool") {
      return { text: TOOL_CALL_DIRECTIVE, model: "stub", route: "test", durationMs: 0 };
    }
    return { text: "最终章节正文。", model: "stub", route: "test", durationMs: 0 };
  };

  const runtime = createNovelOSRuntime({
    session,
    systemPrompt: "你是网文作家。",
    modelGenerate,
    route: "test",
    tools: [tool],
    allowedToolNames: new Set([RETRIEVAL_TOOL_NAME]),
    retrievalToolNames: RETRIEVAL_TOOL_NAMES,
    retrievalBudget,
    budget,
    trajectory,
  });

  return {
    runtime,
    executedCount: () => executedCount,
    calls: () => [...steps],
  };
}

/** 从 agent transcript 判断是否存在最终正文（text 内容块，非 toolCall）回合 */
function hasFinalTextRound(runtime) {
  const messages = runtime.agent.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const content = Array.isArray(m.content) ? m.content : [];
    // 最后一个 assistant 回合若是纯 text（含正文），即为最终正文回合
    const hasText = content.some((c) => c?.type === "text" && typeof c.text === "string" && c.text.length > 0);
    const hasToolCall = content.some((c) => c?.type === "toolCall");
    if (hasText && !hasToolCall) return true;
    if (hasToolCall) return false; // 后面的 assistant 回合才是最终正文
  }
  return false;
}

test("Phase 2D · 检索预算黑盒：retrievalBudget=0 → 0 次检索调用，仍有最终正文", async () => {
  const { runtime, executedCount, calls } = runWithBudget(0);
  await runtime.prompt("开始生成本章。");
  await runtime.waitForIdle();

  assert.equal(executedCount(), 0, "预算 0 时不应执行任何检索工具（旧实现为 1 次）");
  // 脚本序列：1 次检索请求被阻断，随后 1 次正文 → 共 2 次模型调用
  assert.deepEqual(calls(), ["tool", "text"], "应先请求检索（被阻断），再生成正文");
  assert.equal(hasFinalTextRound(runtime), true, "应保留最终正文回合");
});

test("Phase 2D · 检索预算黑盒：retrievalBudget=1 → 恰 1 次检索调用，仍有最终正文", async () => {
  const { runtime, executedCount, calls } = runWithBudget(1);
  await runtime.prompt("开始生成本章。");
  await runtime.waitForIdle();

  assert.equal(executedCount(), 1, "预算 1 时应恰执行 1 次检索工具");
  assert.deepEqual(calls(), ["tool", "tool", "text"], "第 2 次检索请求被阻断，随后生成正文");
  assert.equal(hasFinalTextRound(runtime), true, "应保留最终正文回合");
});

test("Phase 2D · 检索预算黑盒：retrievalBudget=2 → 连续两次检索后仍有最终正文回合", async () => {
  const { runtime, executedCount, calls } = runWithBudget(2);
  await runtime.prompt("开始生成本章。");
  await runtime.waitForIdle();

  assert.equal(executedCount(), 2, "预算 2 时应恰执行 2 次检索工具");
  // 关键回归：旧实现预算用尽后直接 terminate loop → 无最终正文回合
  assert.deepEqual(calls(), ["tool", "tool", "tool", "text"], "第 3 次检索请求被阻断，随后生成正文");
  assert.equal(hasFinalTextRound(runtime), true, "连续两次检索后仍应保留最终正文回合");
});
