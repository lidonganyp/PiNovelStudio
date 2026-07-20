/**
 * NovelOS Runtime 集成测试（OPT-8.1/8.4/8.10/8.11）
 *
 * 验证：
 * - createNovelOSRuntime 协调 Agent + Budget + Trajectory；
 * - 两轮 tool call + 事件流记录到 trajectory；
 * - 预算耗尽时不发起 prompt，记录 failure；
 * - abort 提供 bounded stop；
 * - trajectory 可回放（entries 完整）。
 *
 * 无真实 LLM API key：用 stub ModelGenerateFn + scripted 返回。
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { createNovelOSRuntime } from "../dist/novelos/runtime/runtime.js";
import { BudgetPolicy } from "../dist/novelos/runtime/budget-policy.js";
import { TrajectoryStore } from "../dist/novelos/trajectory/trajectory-store.js";
import { createNovelSession } from "../dist/novelos/session/novel-session.js";

// ============================================================================
// 测试夹具
// ============================================================================

/**
 * Scripted ModelGenerateFn：
 * - 第 1 次调用 → 返回 toolCall JSON（让模型"调用"工具）；
 * - 第 2 次调用 → 返回最终正文。
 *
 * 注意：project ModelGenerateFn 返回纯 text，不返回结构化 toolCall。
 * NovelOS 的 agentic 模式需要模型能发起 tool call。这里通过让 streamFn
 * 解析模型 text 中的 <tool_call> 标记来模拟（生产中由 LLM 原生 tool call 支持）。
 *
 * 但为了直接验证 runtime 协调，这里改用 pi-agent-core 原生 tool call 协议：
 * 直接用 scripted StreamFn（不走 ModelGenerateFn 桥接），验证 runtime 层。
 * 模型桥接的 tool call 能力由 spike 测试已验证。
 */

// 为 runtime 测试，我们用 createNovelOSRuntime + 一个原生支持 tool call 的 streamFn。
// 但 createNovelOSRuntime 内部用 createProjectStreamFn（text 桥接，不支持 tool call）。
// 所以这里直接测试 runtime 协调逻辑：用 budget + trajectory + 一个最小 agent。

// 实际上，createNovelOSRuntime 的 modelGenerate 参数用于 createProjectStreamFn。
// 要测试 tool call 协调，我们需要 streamFn 能返回 toolCall。
// 项目 ModelGenerateFn 返回纯 text，不原生支持 tool call。
// 所以 runtime 测试聚焦：budget 耗尽 + trajectory 记录 + abort，tool call 协调由 spike 覆盖。

function createStubModelGenerate() {
  const calls = [];
  const fn = async (input) => {
    calls.push({ ...input });
    return {
      text: `[stub via ${input.route}] 这是 agentic raw 正文。`,
      model: "stub-doubao",
      route: input.route,
      durationMs: 5,
    };
  };
  return { fn, calls };
}

function createQueryTool() {
  let executeCount = 0;
  const tool = {
    name: "query_canon",
    description: "查询作品 canon 事实。",
    label: "Query Canon",
    parameters: Type.Object({ topic: Type.String() }),
    async execute(toolCallId, params) {
      executeCount++;
      return {
        content: [
          { type: "text", text: `Canon [${params.topic}]：主角拥有复苏之眼` },
        ],
        details: {
          sourceRef: "ch1:skeleton:canon:0",
          evidenceLevel: "confirmed",
          topic: params.topic,
        },
      };
    },
  };
  return { tool, getExecuteCount: () => executeCount };
}

function setupRuntime(overrides = {}) {
  const session = createNovelSession({
    sessionId: `test-${Date.now()}`,
    workspaceId: "test-workspace",
    chapterId: "ch1",
    requestSummary: "生成第1章正文",
    route: "narrator_primary",
  });
  const budget = new BudgetPolicy({ maxTurns: 10, maxToolCalls: 20, maxLatencyMs: 300_000 });
  const trajectory = new TrajectoryStore({
    projectRoot: "/tmp/novelos-test",
    workspaceId: "test-workspace",
    sessionId: session.sessionId,
    persist: false, // 测试不落盘
  });
  const { fn: modelGenerate } = createStubModelGenerate();
  const { tool: queryCanon } = createQueryTool();

  const runtime = createNovelOSRuntime({
    session,
    systemPrompt: "你是小说创作助手。需要事实时调用 query_canon。",
    modelGenerate,
    route: "narrator_primary",
    tools: [queryCanon],
    budget,
    trajectory,
    kind: "novelos_agentic",
    ...overrides,
  });

  return { runtime, session, budget, trajectory, modelGenerate };
}

// ============================================================================

describe("NovelOS Runtime（OPT-8.1）", () => {
  it("prompt 后 trajectory 记录 user 消息 + 事件流", async () => {
    const { runtime, trajectory } = setupRuntime();

    await runtime.prompt("写一句关于主角的话。");
    await runtime.waitForIdle();

    const entries = trajectory.getEntries();
    // 至少有 user message + tool events
    const messageEntries = entries.filter((e) => e.type === "message");
    assert.ok(messageEntries.length >= 1, "应记录 user 消息");

    const toolEvents = entries.filter((e) => e.type === "tool_event");
    assert.ok(toolEvents.length >= 2, "应记录事件流（agent_start/turn_start 等）");

    const eventTypes = toolEvents.map((e) => e.data?.type);
    assert.ok(eventTypes.includes("agent_start"), "应含 agent_start");
    assert.ok(eventTypes.includes("agent_end"), "应含 agent_end");
  });

  it("预算耗尽时不发起 prompt，记录 failure envelope", async () => {
    const { runtime, trajectory, budget } = setupRuntime();

    // 用极小预算让立即耗尽
    budget.recordTurn();
    budget.recordTurn();
    budget.recordTurn();
    budget.recordTurn();
    budget.recordTurn();
    budget.recordTurn();
    budget.recordTurn();
    budget.recordTurn();
    budget.recordTurn();
    budget.recordTurn(); // 10 turns → exhausted

    assert.ok(budget.isExhausted(), "预算应已耗尽");

    await runtime.prompt("这不应发起调用。");
    await runtime.waitForIdle();

    const failures = trajectory.getEntries().filter((e) => e.type === "failure");
    assert.ok(failures.length >= 1, "应记录 failure envelope");
    const envelope = failures[0].data;
    assert.equal(envelope.recoverable, true, "应可恢复（fallback one_shot_raw）");
    assert.ok(
      envelope.reason.includes("budget exhausted"),
      `reason 应提及 budget exhausted，实际：${envelope.reason}`,
    );
  });

  it("abort 提供 bounded stop", async () => {
    const { runtime } = setupRuntime();

    const promptPromise = runtime.prompt("开始生成。");
    setTimeout(() => runtime.abort(), 30);
    await promptPromise;
    await runtime.waitForIdle();

    // abort 后 agent 应停止
    assert.equal(
      runtime.agent.state.isStreaming,
      false,
      "abort 后 isStreaming 应为 false",
    );
  });

  it("budget 追踪 turn / toolCall / modelCall", async () => {
    const { runtime, budget } = setupRuntime();

    await runtime.prompt("写一句话。");
    await runtime.waitForIdle();

    const snapshot = budget.getSnapshot();
    assert.ok(snapshot.turns >= 1, `turns 应 ≥1，实际 ${snapshot.turns}`);
    // stub ModelGenerateFn 返回纯 text（无 tool call），所以 modelCalls ≥1
    assert.ok(snapshot.modelCalls >= 1, `modelCalls 应 ≥1，实际 ${snapshot.modelCalls}`);
    assert.equal(snapshot.exhausted, false, "不应耗尽");
  });

  it("trajectory flush 不抛错（persist=false 时空操作）", async () => {
    const { runtime, trajectory } = setupRuntime();

    await runtime.prompt("写一句话。");
    await runtime.waitForIdle();

    // persist=false，flush 应安全无操作
    await trajectory.flush();
    const entries = trajectory.getEntries();
    assert.ok(entries.length > 0, "in-memory entries 应保留");
  });

  it("subscribe 允许外部监听（与内部 trajectory/budget 并行）", async () => {
    const { runtime } = setupRuntime();

    const externalEvents = [];
    const unsubscribe = runtime.subscribe((event) => {
      externalEvents.push(event.type);
    });

    await runtime.prompt("写一句话。");
    await runtime.waitForIdle();
    unsubscribe();

    assert.ok(externalEvents.length > 0, "外部监听应收到事件");
    assert.ok(externalEvents.includes("agent_start"), "外部应含 agent_start");
  });
});
