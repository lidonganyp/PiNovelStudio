/**
 * NovelOS M1 — OPT-8.2 pi-agent-core spike 测试
 *
 * 目标：验证 @earendil-works/pi-agent-core@0.80.6 是否可复用于 NovelOS Runtime。
 * 用户列出的 6 项能力：
 *   1. 能独立创建 stateful agent（不依赖 PI 外层 session）；
 *   2. 完成至少两轮真实 tool call（model → tool → model）；
 *   3. 接收 tool/turn 事件流；
 *   4. 使用 context transform、steering、stop hook；
 *   5. NovelOS 自主管理 session（无 PI UI 交互）；
 *   6. 在无 UI 测试 runner（node --test）中运行。
 *
 * 此外验证模型层桥接：project ModelGenerateFn → pi-agent-core StreamFn。
 *
 * 本测试不依赖真实 LLM API key：使用 scripted StreamFn 确定性模拟 2 轮 tool call。
 * 真实模型桥接用 createStubModelGenerateFn 语义的 inline stub 验证签名兼容。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";

// ============================================================================
// 测试夹具：最小 Model + scripted StreamFn + 一个只读工具
// ============================================================================

/** 最小 Model<Api>，api="faux" 不触发任何真实 provider 注册。 */
const FAUX_MODEL = {
  id: "novelos-spike-faux",
  name: "NovelOS Spike Faux Model",
  api: "faux",
  provider: "faux",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  contextWindow: 8000,
  maxTokens: 1000,
};

function makeUsage() {
  return {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 30,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function makeAssistantMessage(content, stopReason) {
  return {
    role: "assistant",
    content,
    api: "faux",
    provider: "faux",
    model: FAUX_MODEL.id,
    usage: makeUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * Scripted StreamFn：确定性模拟 2 轮。
 * - 无 toolResult 时 → 返回带 toolCall 的 assistant（stopReason="toolUse"）
 * - 有 toolResult 时 → 返回最终文本（stopReason="stop"）
 * 记录调用次数与每轮 context 快照，供断言。
 */
function createScriptedStreamFn() {
  const calls = [];
  const fn = (_model, context, _options) => {
    const hasToolResult = context.messages.some((m) => m.role === "toolResult");
    let message;
    if (!hasToolResult) {
      message = makeAssistantMessage(
        [
          {
            type: "toolCall",
            id: `tc-${calls.length + 1}`,
            name: "query_canon",
            arguments: { topic: "主角能力" },
          },
        ],
        "toolUse",
      );
    } else {
      message = makeAssistantMessage(
        [{ type: "text", text: "根据设定，主角拥有复苏之眼。" }],
        "stop",
      );
    }
    calls.push({
      round: calls.length + 1,
      messageCount: context.messages.length,
      hasToolResult,
    });
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end(message);
    return stream;
  };
  return { fn, calls };
}

/** 只读叙事工具：query_canon，返回带 sourceRef + evidenceLevel 的结果。 */
function createQueryCanonTool() {
  let executeCount = 0;
  const tool = {
    name: "query_canon",
    description: "查询作品 canon 事实。返回带 sourceRef 与证据等级的结果。",
    label: "Query Canon",
    parameters: Type.Object({ topic: Type.String() }),
    async execute(toolCallId, params, _signal, _onUpdate) {
      executeCount++;
      return {
        content: [
          {
            type: "text",
            text: `Canon fact [${params.topic}]：主角拥有复苏之眼（来源 ch1 skeleton）`,
          },
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

// ============================================================================
// 测试用例
// ============================================================================

describe("OPT-8.2 spike: pi-agent-core 可复用性验证", () => {
  it("能力 1+6：独立创建 stateful agent，在无 UI node --test runner 中运行", async () => {
    const { fn: streamFn } = createScriptedStreamFn();
    const { tool: queryCanon } = createQueryCanonTool();

    const agent = new Agent({
      initialState: {
        systemPrompt: "你是小说创作助手。需要事实时调用 query_canon。",
        model: FAUX_MODEL,
        thinkingLevel: "off",
        tools: [queryCanon],
      },
      convertToLlm: (msgs) => msgs,
      streamFn,
      sessionId: "spike-session-1",
    });

    assert.equal(typeof agent.prompt, "function", "Agent 应有 prompt 方法");
    assert.equal(typeof agent.subscribe, "function", "Agent 应有 subscribe 方法");
    assert.equal(typeof agent.steer, "function", "Agent 应有 steer 方法");
    assert.equal(typeof agent.abort, "function", "Agent 应有 abort 方法");
    assert.equal(agent.sessionId, "spike-session-1", "sessionId 自主管理");

    await agent.prompt("查询主角能力并写一句话。");
    await agent.waitForIdle();

    // 验证 stateful：transcript 非空，包含 user + 2 轮 assistant + toolResult
    const messages = agent.state.messages;
    assert.ok(messages.length >= 4, `transcript 应含 ≥4 条消息，实际 ${messages.length}`);
    const roles = messages.map((m) => m.role);
    assert.ok(roles.includes("user"), "transcript 应含 user 消息");
    assert.ok(roles.includes("assistant"), "transcript 应含 assistant 消息");
    assert.ok(roles.includes("toolResult"), "transcript 应含 toolResult 消息");
  });

  it("能力 2：完成至少两轮真实 tool call（model → tool → model）", async () => {
    const { fn: streamFn, calls } = createScriptedStreamFn();
    const { tool: queryCanon, getExecuteCount } = createQueryCanonTool();

    const agent = new Agent({
      initialState: {
        systemPrompt: "需要事实时调用 query_canon。",
        model: FAUX_MODEL,
        thinkingLevel: "off",
        tools: [queryCanon],
      },
      convertToLlm: (msgs) => msgs,
      streamFn,
      sessionId: "spike-2round",
    });

    await agent.prompt("查询主角能力并写一句话。");
    await agent.waitForIdle();

    // StreamFn 被调用 ≥2 次（2 轮 LLM 请求）
    assert.ok(
      calls.length >= 2,
      `streamFn 应被调用 ≥2 次（2 轮），实际 ${calls.length}`,
    );
    // 工具被执行 ≥1 次
    assert.ok(
      getExecuteCount() >= 1,
      `query_canon 应被执行 ≥1 次，实际 ${getExecuteCount()}`,
    );
    // 第 2 轮 context 含 toolResult（证明第 1 轮 tool call 完成并回灌）
    assert.ok(
      calls[1] && calls[1].hasToolResult,
      "第 2 轮 LLM 请求时 context 应含 toolResult",
    );
    // 最终 assistant 消息含最终文本（非 toolCall）
    const finalAssistant = [...agent.state.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    assert.ok(finalAssistant, "应存在最终 assistant 消息");
    const hasText = finalAssistant.content.some(
      (c) => c.type === "text" && c.text.length > 0,
    );
    assert.ok(hasText, "最终 assistant 应含文本内容");
  });

  it("能力 3：接收 tool/turn 事件流", async () => {
    const { fn: streamFn } = createScriptedStreamFn();
    const { tool: queryCanon } = createQueryCanonTool();

    const events = [];
    const agent = new Agent({
      initialState: {
        systemPrompt: "需要事实时调用 query_canon。",
        model: FAUX_MODEL,
        thinkingLevel: "off",
        tools: [queryCanon],
      },
      convertToLlm: (msgs) => msgs,
      streamFn,
      sessionId: "spike-events",
    });

    agent.subscribe((event) => {
      events.push(event.type);
    });

    await agent.prompt("查询主角能力。");
    await agent.waitForIdle();

    assert.ok(events.includes("agent_start"), "应收到 agent_start 事件");
    assert.ok(events.includes("agent_end"), "应收到 agent_end 事件");
    assert.ok(events.includes("turn_start"), "应收到 turn_start 事件");
    assert.ok(events.includes("turn_end"), "应收到 turn_end 事件");
    assert.ok(
      events.includes("tool_execution_start"),
      "应收到 tool_execution_start 事件",
    );
    assert.ok(
      events.includes("tool_execution_end"),
      "应收到 tool_execution_end 事件",
    );
    // 至少 2 轮 turn（round1 tool call + round2 final）
    const turnStartCount = events.filter((e) => e === "turn_start").length;
    assert.ok(
      turnStartCount >= 2,
      `应至少 2 轮 turn_start，实际 ${turnStartCount}`,
    );
  });

  it("能力 4a：context transform 在每次 LLM 调用前被调用", async () => {
    const { fn: streamFn } = createScriptedStreamFn();
    const { tool: queryCanon } = createQueryCanonTool();

    let transformCalls = 0;
    const agent = new Agent({
      initialState: {
        systemPrompt: "需要事实时调用 query_canon。",
        model: FAUX_MODEL,
        thinkingLevel: "off",
        tools: [queryCanon],
      },
      convertToLlm: (msgs) => msgs,
      transformContext: async (messages) => {
        transformCalls++;
        return messages; // 透传，仅计数
      },
      streamFn,
      sessionId: "spike-transform",
    });

    await agent.prompt("查询主角能力。");
    await agent.waitForIdle();

    assert.ok(
      transformCalls >= 2,
      `transformContext 应被调用 ≥2 次（每轮 LLM 调用前），实际 ${transformCalls}`,
    );
  });

  it("能力 4b：steering 可在运行中注入消息", async () => {
    const { fn: streamFn } = createScriptedStreamFn();
    const { tool: queryCanon } = createQueryCanonTool();

    const agent = new Agent({
      initialState: {
        systemPrompt: "需要事实时调用 query_canon。",
        model: FAUX_MODEL,
        thinkingLevel: "off",
        tools: [queryCanon],
      },
      convertToLlm: (msgs) => msgs,
      streamFn,
      sessionId: "spike-steer",
    });

    // 在 prompt 前注入 steering 消息（drain 时机：round1 tool 执行后、round2 LLM 调用前）
    agent.steer({
      role: "user",
      content: "[steering] 请确保提到复苏之眼的代价。",
      timestamp: Date.now(),
    });

    await agent.prompt("查询主角能力。");
    await agent.waitForIdle();

    const messages = agent.state.messages;
    const hasSteer = messages.some(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("[steering]"),
    );
    assert.ok(
      hasSteer,
      "steering 消息应出现在最终 transcript 中（证明 steer API 生效）",
    );
  });

  it("能力 4c+5：prepareNextTurn stop hook 被调用，session 自主管理", async () => {
    const { fn: streamFn } = createScriptedStreamFn();
    const { tool: queryCanon } = createQueryCanonTool();

    let prepareCalls = 0;
    const agent = new Agent({
      initialState: {
        systemPrompt: "需要事实时调用 query_canon。",
        model: FAUX_MODEL,
        thinkingLevel: "off",
        tools: [queryCanon],
      },
      convertToLlm: (msgs) => msgs,
      prepareNextTurnWithContext: (_ctx) => {
        prepareCalls++;
        return undefined; // 不替换 context/model，继续自然停止
      },
      streamFn,
      sessionId: "spike-stop-hook",
    });

    await agent.prompt("查询主角能力。");
    await agent.waitForIdle();

    assert.ok(
      prepareCalls >= 1,
      `prepareNextTurnWithContext 应被调用 ≥1 次，实际 ${prepareCalls}`,
    );
    // 自然停止：最终无 isStreaming
    assert.equal(
      agent.state.isStreaming,
      false,
      "运行结束后 isStreaming 应为 false",
    );
  });

  it("能力 4d：abort() 提供 bounded stop（超时/取消语义）", async () => {
    // 契约：streamFn 收到 options.signal，必须在 abort 时 push done 事件 + end stream。
    // 否则空 stream 的 async iterator 永不结束，prompt 会挂死。
    // 这也是生产 createProjectStreamFn 必须遵守的契约。
    const slowStreamFn = (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const signal = options?.signal;
      const abortMsg = makeAssistantMessage([], "aborted");
      if (signal?.aborted) {
        stream.push({ type: "done", reason: "aborted", message: abortMsg });
        stream.end(abortMsg);
      } else if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            stream.push({ type: "done", reason: "aborted", message: abortMsg });
            stream.end(abortMsg);
          },
          { once: true },
        );
      }
      return stream;
    };
    const agent = new Agent({
      initialState: {
        systemPrompt: "test",
        model: FAUX_MODEL,
        thinkingLevel: "off",
        tools: [],
      },
      convertToLlm: (msgs) => msgs,
      streamFn: slowStreamFn,
      sessionId: "spike-abort",
    });

    const promptPromise = agent.prompt("开始");
    // 立即 abort
    setTimeout(() => agent.abort(), 50);
    await promptPromise;
    await agent.waitForIdle();

    // abort 后 isStreaming 为 false，stopReason 为 aborted，bounded stop 生效
    assert.equal(
      agent.state.isStreaming,
      false,
      "abort 后 isStreaming 应为 false（bounded stop 生效）",
    );
    const finalAssistant = [...agent.state.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    assert.ok(finalAssistant, "abort 后应有 assistant 消息（aborted）");
    assert.equal(
      finalAssistant.stopReason,
      "aborted",
      "最终 assistant stopReason 应为 aborted",
    );
  });

  it("模型层桥接：project ModelGenerateFn → pi-agent-core StreamFn", async () => {
    // 模拟项目 ModelGenerateFn（与 legacy-model-route-adapter.ts:30-50 签名一致）
    /** @type {(input: {route:string; systemPrompt:string; userPrompt:string; kind:string; timeoutMs?:number}) => Promise<{text:string; model:string; route:string; durationMs:number}>} */
    const projectModelGenerate = async (input) => {
      return {
        text: `[bridged via ${input.route}] 主角拥有复苏之眼。`,
        model: "stub-doubao",
        route: input.route,
        durationMs: 5,
      };
    };

    // 桥接器：把 ModelGenerateFn 包装成 StreamFn。
    // 契约：必须尊重 options.signal —— abort 时结束 stream（push aborted done + end），
    // 否则 agent loop 的 for-await 会挂死。modelGenerate 结果到达时若已 aborted 则丢弃。
    const createProjectStreamFn = (modelGenerate, route = "narrator_primary") => {
      return (_model, context, options) => {
        const systemPrompt = context.systemPrompt ?? "";
        // 取最后一条 user 消息作为 userPrompt
        const lastUser = [...context.messages]
          .reverse()
          .find((m) => m.role === "user");
        const userPrompt =
          typeof lastUser?.content === "string"
            ? lastUser.content
            : JSON.stringify(lastUser?.content ?? "");
        const stream = createAssistantMessageEventStream();
        const signal = options?.signal;
        let aborted = false;
        const finishAborted = () => {
          if (aborted) return;
          aborted = true;
          const msg = makeAssistantMessage([], "aborted");
          stream.push({ type: "done", reason: "aborted", message: msg });
          stream.end(msg);
        };
        if (signal?.aborted) {
          finishAborted();
          return stream;
        }
        signal?.addEventListener("abort", finishAborted, { once: true });
        // 异步调用 project 模型层，把结果包装成 AssistantMessage 事件
        (async () => {
          try {
            const out = await modelGenerate({
              route,
              systemPrompt,
              userPrompt,
              kind: "novelos_agentic",
            });
            if (aborted) return; // 已 abort，丢弃过期结果
            const message = makeAssistantMessage(
              [{ type: "text", text: out.text }],
              "stop",
            );
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end(message);
          } catch (err) {
            if (aborted) return; // 已 abort，丢弃过期错误
            const errMsg = err instanceof Error ? err.message : String(err);
            const error = makeAssistantMessage([], "error");
            error.errorMessage = errMsg;
            stream.push({ type: "error", reason: "error", error });
            stream.end(error);
          }
        })();
        return stream;
      };
    };

    const agent = new Agent({
      initialState: {
        systemPrompt: "你是小说创作助手。",
        model: FAUX_MODEL,
        thinkingLevel: "off",
        tools: [],
      },
      convertToLlm: (msgs) => msgs,
      streamFn: createProjectStreamFn(projectModelGenerate, "narrator_primary"),
      sessionId: "spike-bridge",
    });

    await agent.prompt("写一句关于主角的话。");
    await agent.waitForIdle();

    const finalAssistant = [...agent.state.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    assert.ok(finalAssistant, "桥接后应有 assistant 消息");
    const text = finalAssistant.content.find((c) => c.type === "text");
    assert.ok(text, "assistant 应含文本");
    assert.ok(
      text.text.includes("[bridged via narrator_primary]"),
      `文本应来自 project ModelGenerateFn 桥接，实际：${text.text}`,
    );
    assert.ok(
      text.text.includes("主角拥有复苏之眼"),
      "桥接应保留 project 模型层输出内容",
    );
  });
});
