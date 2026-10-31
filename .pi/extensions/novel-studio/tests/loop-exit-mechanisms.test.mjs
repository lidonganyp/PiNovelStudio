/**
 * Loop 退出机制测试（超时限制退出 + 错误次数退出）
 *
 * 锁定两处此前失效/缺失的 loop 退出：
 * - 超时限制退出：BudgetPolicy.recordLatency 由 runtime 在 turn_start/turn_end 上累计墙钟耗时，
 *   maxLatencyMs 真正生效（此前 recordLatency 全仓无调用方，是死配置）。
 * - 错误次数退出：连续工具失败达到 maxConsecutiveToolErrors（默认 3）即终止 loop，
 *   成功调用归零；终止时写 FailureEnvelope（evidence.gate=tool_error_streak）。
 *
 * 依赖边界：只依赖生产闭包（dist/），通过 stub modelGenerate 驱动真实 NovelOSRuntime。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BudgetPolicy,
  DEFAULT_BUDGET_CONFIG,
  createBudgetConfigFromEnv,
} from "../dist/novelos/runtime/budget-policy.js";
import { createNovelOSRuntime } from "../dist/novelos/runtime/runtime.js";

const TOOL_NAME = "probe_narrative_state";
// 用英文 name/arguments 形式，避免走中文工具名映射表（测试工具不在生产映射表内）
const TOOL_CALL_DIRECTIVE =
  `<tool_call>{"name":"probe_narrative_state","arguments":{"query":"暗流"}}</tool_call>`;

/** 构造一个会失败（execute 抛错 → isError=true）的叙事工具 */
function makeFailingTool(onExecute) {
  return {
    name: TOOL_NAME,
    label: "叙事状态探查",
    description: "探查叙事状态。",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "搜索关键词" } },
      required: ["query"],
    },
    execute: async () => {
      onExecute?.();
      throw new Error("工具执行失败（模拟）");
    },
  };
}

/**
 * 用 stub 驱动一次真实 runtime 运行。
 *
 * @param {object} options
 * @param {string[]} options.script 每次模型调用返回的 step：
 *   "tool" = 单条 probe 工具指令；"text" = 最终正文；其他字符串按原样作为模型输出
 * @param {object} options.tool 被测工具
 * @param {BudgetPolicy} options.budget 预算策略
 * @param {() => number} [options.now] 注入的可控时钟（墙钟超时用例）
 * @param {() => void} [options.onModelCall] 每次模型调用返回后回调（用于推进可控时钟）
 * @returns {{ runtime: object, executed: () => number, calls: () => string[], failures: () => object[] }}
 */
function runLoop({ script, tool, budget, now, onModelCall }) {
  let executed = 0;
  let callIndex = 0;
  const calls = [];
  const failures = [];

  // 包一层计数，避免每个工具自己维护执行计数
  const countedTool = {
    ...tool,
    execute: async (args, ctx) => {
      executed += 1;
      return tool.execute(args, ctx);
    },
  };

  const modelGenerate = async () => {
    const step = script[callIndex] ?? "text";
    callIndex += 1;
    calls.push(step);
    onModelCall?.();
    if (step === "tool") {
      return { text: TOOL_CALL_DIRECTIVE, model: "stub", route: "test", durationMs: 0 };
    }
    if (step === "text") {
      return { text: "最终章节正文。", model: "stub", route: "test", durationMs: 0 };
    }
    return { text: step, model: "stub", route: "test", durationMs: 0 };
  };

  const trajectory = {
    recordToolEvent() {},
    recordMessage() {},
    recordFailure(envelope) {
      failures.push(envelope);
    },
    recordBudget() {},
  };

  const runtime = createNovelOSRuntime({
    session: { sessionId: "loop-exit-test" },
    systemPrompt: "你是网文作家。",
    modelGenerate,
    route: "test",
    tools: [countedTool],
    allowedToolNames: new Set([TOOL_NAME]),
    budget,
    trajectory,
    // 测试合成工具不在自主性动作目录内，默认策略会 fail-closed 阻断（unknown_action），
    // 且 beforeToolCall 阻断产出的是 immediate result —— pi-agent-core 对 immediate result
    // 不调用 afterToolCall，会绕过连续失败计数。测试只需验证错误计数接线，故显式关闭。
    autonomyPolicy: null,
    // 墙钟用例注入可控时钟；未注入时 runtime 使用 Date.now
    ...(now ? { now } : {}),
  });

  return {
    runtime,
    executed: () => executed,
    calls: () => [...calls],
    failures: () => [...failures],
  };
}

test("错误次数退出 · 默认阈值 3 次连续失败即耗尽预算", () => {
  const budget = new BudgetPolicy();
  assert.equal(DEFAULT_BUDGET_CONFIG.maxConsecutiveToolErrors, 3, "默认连续失败阈值应为 3");
  assert.equal(budget.isExhausted(), false);

  budget.recordToolError();
  budget.recordToolError();
  assert.equal(budget.isExhausted(), false, "未达阈值不应耗尽");
  assert.equal(budget.getSnapshot().consecutiveToolErrors, 2);

  budget.recordToolError();
  assert.equal(budget.isExhausted(), true, "连续失败达阈值应耗尽");
  assert.match(budget.getSnapshot().exhaustedReason, /maxConsecutiveToolErrors/);
  assert.equal(budget.getSnapshot().consecutiveToolErrors, 3);
});

test("错误次数退出 · 成功调用把连续失败计数归零（只惩罚连续失败）", () => {
  const budget = new BudgetPolicy({ maxConsecutiveToolErrors: 3 });
  budget.recordToolError();
  budget.recordToolError();
  budget.recordToolSuccess();
  assert.equal(budget.getSnapshot().consecutiveToolErrors, 0, "成功调用后应归零");
  budget.recordToolError();
  budget.recordToolError();
  assert.equal(budget.isExhausted(), false, "被成功打断的失败不应计入连续次数");
});

test("错误次数退出 · env PINOVEL_NOVELOS_MAX_CONSECUTIVE_TOOL_ERRORS 可覆盖阈值", () => {
  const previous = process.env.PINOVEL_NOVELOS_MAX_CONSECUTIVE_TOOL_ERRORS;
  process.env.PINOVEL_NOVELOS_MAX_CONSECUTIVE_TOOL_ERRORS = "5";
  try {
    const config = createBudgetConfigFromEnv();
    assert.equal(config.maxConsecutiveToolErrors, 5, "env 应覆盖默认阈值");
  } finally {
    if (previous === undefined) {
      delete process.env.PINOVEL_NOVELOS_MAX_CONSECUTIVE_TOOL_ERRORS;
    } else {
      process.env.PINOVEL_NOVELOS_MAX_CONSECUTIVE_TOOL_ERRORS = previous;
    }
  }
});

test("超时限制退出 · 累计墙钟耗时超过 maxLatencyMs 即耗尽预算", () => {
  const budget = new BudgetPolicy({ maxLatencyMs: 100 });
  budget.recordLatency(60);
  assert.equal(budget.isExhausted(), false, "未超阈值不应耗尽");
  budget.recordLatency(60);
  assert.equal(budget.isExhausted(), true, "累计超过 maxLatencyMs 应耗尽");
  assert.match(budget.getSnapshot().exhaustedReason, /maxLatencyMs/);
  assert.equal(budget.getSnapshot().latencyMs, 120);
});

test("错误次数退出 · 真实 loop 连续工具失败达阈值后终止并写 FailureEnvelope", async () => {
  const budget = new BudgetPolicy({
    maxTurns: 10,
    maxToolCalls: 20,
    maxConsecutiveToolErrors: 2,
  });
  const tool = makeFailingTool();
  const { runtime, executed, calls, failures } = runLoop({
    script: ["tool", "tool", "tool", "text"],
    tool,
    budget,
  });

  await runtime.prompt("开始生成本章。");
  await runtime.waitForIdle();

  assert.equal(executed(), 2, "连续失败达阈值后不应再执行第 3 次工具调用");
  assert.deepEqual(calls(), ["tool", "tool"], "loop 应在第 2 次失败后终止，不进入后续回合");
  assert.equal(runtime.budget.isExhausted(), true);
  assert.match(runtime.budget.getSnapshot().exhaustedReason, /maxConsecutiveToolErrors/);

  const toolFailures = failures().filter(
    (f) => f?.evidence?.gate === "tool_error_streak",
  );
  assert.equal(toolFailures.length, 1, "应写入一条 tool_error_streak FailureEnvelope");
  assert.equal(toolFailures[0].severity, "recoverable");
  assert.equal(toolFailures[0].evidence.consecutiveToolErrors, 2);
});

test("错误次数退出 · 成功调用打断后 loop 不终止（连续失败未达阈值）", async () => {
  const budget = new BudgetPolicy({
    maxTurns: 10,
    maxToolCalls: 20,
    maxConsecutiveToolErrors: 2,
  });

  let callCount = 0;
  const tool = {
    name: TOOL_NAME,
    label: "叙事状态探查",
    description: "探查叙事状态。",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "搜索关键词" } },
      required: ["query"],
    },
    execute: async () => {
      callCount += 1;
      // 第 2 次调用成功，打断连续失败
      if (callCount === 2) {
        return {
          content: [{ type: "text", text: "已检索到的证据。" }],
          details: { sourceRef: "ch1:span", evidenceLevel: "confirmed" },
        };
      }
      throw new Error("工具执行失败（模拟）");
    },
  };

  const { runtime, executed, calls } = runLoop({
    script: ["tool", "tool", "tool", "text"],
    tool,
    budget,
  });

  await runtime.prompt("开始生成本章。");
  await runtime.waitForIdle();

  assert.equal(executed(), 3, "成功的一次调用应打断连续失败，loop 继续执行");
  assert.deepEqual(calls(), ["tool", "tool", "tool", "text"], "应在最后一次失败后的下一回合产出正文");
  assert.equal(runtime.budget.isExhausted(), false);
  assert.equal(runtime.budget.getSnapshot().consecutiveToolErrors, 1, "成功调用已打断连续计数，最后一次失败只计 1");
});

// ============================================================================
// R01 · 预算耗尽的执行边界（真实模型调用前复核，而不是只在工具回调里判定）
// ============================================================================

/** 永远成功的叙事工具（用于隔离"只要 turn/tool 预算耗尽就必须停止"）。 */
function makeSuccessfulTool() {
  return {
    name: TOOL_NAME,
    label: "叙事状态探查",
    description: "探查叙事状态。",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "搜索关键词" } },
      required: ["query"],
    },
    execute: async () => ({
      content: [{ type: "text", text: "已检索到的证据。" }],
      details: { sourceRef: "ch1:span", evidenceLevel: "confirmed" },
    }),
  };
}

test("R01 · maxTurns 耗尽后禁止发起下一次模型请求", async () => {
  const budget = new BudgetPolicy({ maxTurns: 2, maxToolCalls: 40, maxLatencyMs: 900000 });
  const { runtime, calls, failures } = runLoop({
    script: ["tool", "tool", "tool", "text"],
    tool: makeSuccessfulTool(),
    budget,
  });

  await runtime.prompt("开始生成本章。");
  await runtime.waitForIdle();

  assert.deepEqual(calls(), ["tool", "tool"], "2 个回合用尽后不得再发起第 3 次模型调用");
  assert.equal(runtime.budget.isExhausted(), true);

  const budgetFailures = failures().filter((f) => f?.evidence?.budgetReason);
  assert.equal(budgetFailures.length, 1, "停止信封必须且只能写一条");
  assert.equal(budgetFailures[0].evidence.gate, "max_turns");
  assert.equal(budgetFailures[0].evidence.modelCalls, 2, "停止时模型调用次数应可归因");
});

test("R01 · 墙钟超时（运行级截止）不再发起下一次模型请求", async () => {
  // 可控时钟：每次模型调用固定推进 30ms，启动开销与工具执行不推进。
  // 旧写法用 maxLatencyMs=1 + 真实 setTimeout(20ms)：首个模型调用前的准备开销
  // 一旦跨过 1ms 就会在第一次模型请求前触发运行级截止（calls().length 变 0），
  // 造成偶发失败。这里把阈值与时钟都变成确定量。
  let clockMs = 1_000;
  const budget = new BudgetPolicy({ maxTurns: 10, maxToolCalls: 40, maxLatencyMs: 20 });
  const { runtime, calls, failures } = runLoop({
    script: ["tool", "tool", "text"],
    tool: makeSuccessfulTool(),
    budget,
    now: () => clockMs,
    onModelCall: () => {
      clockMs += 30;
    },
  });

  await runtime.prompt("开始生成本章。");
  await runtime.waitForIdle();

  assert.equal(calls().length, 1, "墙钟超过 maxLatencyMs 后不得再发起模型调用");
  assert.equal(runtime.budget.isExhausted(), true);
  const budgetFailures = failures().filter((f) => f?.evidence?.budgetReason);
  assert.equal(budgetFailures.length, 1);
  assert.equal(budgetFailures[0].evidence.gate, "max_latency");
});

test("R01 · 工具不存在（immediate result）也受总步数边界约束", async () => {
  const budget = new BudgetPolicy({ maxTurns: 2, maxToolCalls: 40, maxConsecutiveToolErrors: 10 });
  const unknownCall =
    `<tool_call>{"name":"missing_tool","arguments":{"query":"暗流"}}</tool_call>`;
  const { runtime, calls, failures } = runLoop({
    script: [unknownCall, unknownCall, unknownCall, "text"],
    tool: makeSuccessfulTool(),
    budget,
  });

  await runtime.prompt("开始生成本章。");
  await runtime.waitForIdle();

  assert.deepEqual(
    calls(),
    [unknownCall, unknownCall],
    "immediate result 不经过 afterToolCall，仍必须由模型调用边界挡住第 3 轮",
  );
  const budgetFailures = failures().filter((f) => f?.evidence?.budgetReason);
  assert.equal(budgetFailures.length, 1);
  assert.equal(budgetFailures[0].evidence.gate, "max_turns");
});

test("R01 · 同批多工具中最后一个触发阈值时也不再进入下一模型轮", async () => {
  const budget = new BudgetPolicy({ maxTurns: 10, maxToolCalls: 40, maxConsecutiveToolErrors: 2 });
  const batch =
    `<tool_call>{"name":"probe_narrative_state","arguments":{"query":"暗流"}}</tool_call>`
    + `<tool_call>{"name":"probe_narrative_state","arguments":{"query":"伏笔"}}</tool_call>`;
  const { runtime, calls, failures } = runLoop({
    script: [batch, "text"],
    tool: makeFailingTool(),
    budget,
  });

  await runtime.prompt("开始生成本章。");
  await runtime.waitForIdle();

  assert.equal(calls().length, 1, "同批最后一个工具触发阈值后不得再发起模型调用");
  assert.equal(runtime.budget.isExhausted(), true);
  const budgetFailures = failures().filter((f) => f?.evidence?.budgetReason);
  assert.equal(budgetFailures.length, 1, "同批次只能写一条失败信封");
  assert.equal(budgetFailures[0].evidence.gate, "tool_error_streak");
});

test("R01 · 单次工具失败不会被误归因为连续失败阈值", async () => {
  const budget = new BudgetPolicy({ maxTurns: 1, maxToolCalls: 40, maxConsecutiveToolErrors: 3 });
  const { runtime, failures } = runLoop({
    script: ["tool", "tool", "text"],
    tool: makeFailingTool(),
    budget,
  });

  await runtime.prompt("开始生成本章。");
  await runtime.waitForIdle();

  const budgetFailures = failures().filter((f) => f?.evidence?.budgetReason);
  assert.equal(budgetFailures.length, 1);
  assert.equal(budgetFailures[0].evidence.gate, "max_turns", "耗尽原因是 maxTurns，不应写成 tool_error_streak");
  assert.equal(budgetFailures[0].evidence.consecutiveToolErrors, 1);
});

