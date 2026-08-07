/**
 * NovelOS pi-agent-core Adapter（OPT-8.2 spike 产物）
 *
 * 把项目现有 ModelGenerateFn（v2/adapters/legacy-model-route-adapter.ts）桥接到
 * @earendil-works/pi-agent-core 的 StreamFn 契约，使 NovelOS 能复用 pi-agent-core 的
 * stateful agent loop（事件流 / tool dispatch / steering / context transform / abort），
 * 而不需要重写通用 agent 基础设施，也不需要 PI Host / PI UI 类型。
 *
 * spike 验证结论（见 ./SPIKE-REPORT.md）：pi-agent-core@0.80.6 可复用，全部 6 项能力通过。
 *
 * 核心契约（spike 发现）：streamFn 收到 options.signal，必须在 abort 时 push done 事件 +
 * end stream，否则 agent loop 的 for-await 会挂死。createProjectStreamFn 已实现此契约。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentState,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/compat";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  StopReason,
  Usage,
} from "@earendil-works/pi-ai";
import type { ModelGenerateFn, ModelGenerateInput, ModelGenerateOutput } from "../../v2/adapters/legacy-model-route-adapter.js";
import {
  parseToolCallDirectives,
  formatToolResultsForPrompt,
  type ToolResultView,
} from "./react-tool-call-parser.js";
import { injectToolSchemas } from "./tool-schema-injector.js";
import { localizeLlmText } from "../../utils/llm-language-guard.js";

// ============================================================================
// Re-exports：NovelOS 模块统一从本 adapter 导入 pi-agent-core / pi-ai 类型
// ============================================================================

export type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentState,
  AgentTool,
};

export type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  StopReason,
  Usage,
};

export type { ModelGenerateFn, ModelGenerateInput, ModelGenerateOutput };

// ============================================================================
// Placeholder Model
// ============================================================================

/**
 * 创建一个最小 Model<Api> 占位对象。
 *
 * 项目 ModelGenerateFn 用 route 字符串路由（不消费 Model 对象），所以传给 Agent 的
 * Model 只是满足类型签名。真实路由由 createProjectStreamFn 内部调 modelGenerate({route}) 完成。
 */
export function createPlaceholderModel(route: string): Model<string> {
  return {
    id: `novelos-placeholder-${route}`,
    name: `NovelOS Placeholder (${route})`,
    api: "faux",
    provider: "novelos",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

// ============================================================================
// createProjectStreamFn — 核心桥接：ModelGenerateFn → StreamFn
// ============================================================================

/**
 * 把项目 ModelGenerateFn 包装成 pi-agent-core StreamFn。
 *
 * ReAct 桥接（Task A.3）：
 * - userPrompt 构建：取最后一条 `role:"user"` 消息为 basePrompt；收集该 user 消息之后的
 *   所有 `role:"toolResult"` 消息（同一 turn 内工具结果），用 `formatToolResultsForPrompt`
 *   序列化为「已检索到的证据」块追加到 basePrompt。text-only 模型只能通过这种方式看到证据。
 * - 模型输出解析：`parseToolCallDirectives(out.text)`；有 toolCall 指令 → content 含 toolCall
 *   块 + stopReason="toolUse"（Agent 原生派发工具、追加 toolResult、再调 streamFn）；
 *   无指令 → 现状（text + stop），模型输出最终正文。
 * - 契约：尊重 options.signal —— abort 时 push aborted done + end stream，丢弃过期结果。
 *
 * @param modelGenerate 项目模型调用函数（来自 legacy-model-route-adapter 或 stub）
 * @param route 模型路由名（如 narrator_primary / narrator_testing_ernie）
 * @param kind 候选 kind 标签（默认 novelos_agentic）
 */
export function createProjectStreamFn(
  modelGenerate: ModelGenerateFn,
  route: string,
  kind = "novelos_agentic",
): (model: Model<string>, context: Context, options?: { signal?: AbortSignal; timeoutMs?: number }) => AssistantMessageEventStream {
  return (_model: Model<string>, context: Context, options?: { signal?: AbortSignal; timeoutMs?: number }) => {
    const systemPrompt = localizeLlmText(context.systemPrompt ?? "");
    const userPrompt = localizeLlmText(buildUserPromptWithContext(context));

    const stream = createAssistantMessageEventStream();
    const signal = options?.signal;
    let aborted = false;

    const finishAborted = (): void => {
      if (aborted) return;
      aborted = true;
      const msg = makeAssistantMessage([], "aborted");
      // "error" 事件的 reason 接受 "aborted"（"done" 事件只接受 stop/length/toolUse）
      stream.push({ type: "error", reason: "aborted", error: msg });
      stream.end(msg);
    };

    if (signal?.aborted) {
      finishAborted();
      return stream;
    }
    signal?.addEventListener("abort", finishAborted, { once: true });

    void (async () => {
      try {
        const out: ModelGenerateOutput = await modelGenerate({
          route,
          systemPrompt,
          userPrompt,
          kind,
          timeoutMs: options?.timeoutMs,
        });
        if (aborted) return; // 已 abort，丢弃过期结果

        // 解析 ReAct `<tool_call>` 指令
        const parsed = parseToolCallDirectives(out.text);

        let message: AssistantMessage;
        if (parsed.hasToolCall) {
          // 有工具调用指令 → emit toolCall 内容块 + stopReason="toolUse"
          // Agent 原生派发工具、追加 toolResult 消息、再调 streamFn（下一 turn 回灌证据）
          const content: AssistantMessage["content"] = [
            ...parsed.textBlocks,
            ...parsed.toolCalls,
          ];
          // 若 textBlocks 为空（模型只发指令），至少保留一个空 text 块避免 content 全空
          if (content.length === 0) {
            content.push({ type: "text", text: "" });
          }
          message = makeAssistantMessage(content, "toolUse", out.model);
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "toolUse", message });
        } else {
          // 无指令 → 最终正文，模型停止
          message = makeAssistantMessage(
            [{ type: "text", text: out.text }],
            "stop",
            out.model,
          );
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
        }
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
}

// ============================================================================
// 内部：构建 userPrompt（basePrompt + toolResult 回灌）
// ============================================================================

/**
 * 从 context.messages 构建 userPrompt：
 * - 取最后一条 `role:"user"` 消息为 basePrompt（string 或序列化 content）；
 * - 收集该 user 消息之后的所有 `role:"toolResult"` 消息（同一 turn 内工具结果），
 *   用 `formatToolResultsForPrompt` 序列化为「已检索到的证据」块追加。
 *
 * text-only 模型看不到结构化 toolResult 消息，必须回灌到 userPrompt 才能基于证据继续生成。
 */
function buildUserPromptWithContext(context: Context): string {
  const messages = context.messages;
  // 找最后一条 user 消息的索引
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const lastUser = lastUserIdx >= 0 ? messages[lastUserIdx] : undefined;
  const basePrompt =
    typeof (lastUser as { content?: unknown } | undefined)?.content === "string"
      ? (lastUser as { content: string }).content
      : JSON.stringify((lastUser as { content?: unknown } | undefined)?.content ?? "");

  // 收集 user 消息之后的 toolResult 消息
  const toolResults: ToolResultView[] = [];
  if (lastUserIdx >= 0) {
    for (let i = lastUserIdx + 1; i < messages.length; i++) {
      const m = messages[i] as { role?: string };
      if (m && m.role === "toolResult") {
        const tr = messages[i] as unknown as {
          toolName?: string;
          content?: Array<{ type: string; text?: string }>;
          details?: ToolResultView["details"];
        };
        const textContent = Array.isArray(tr.content)
          ? tr.content
              .filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => ({ type: "text" as const, text: c.text as string }))
          : [];
        toolResults.push({
          toolName: tr.toolName ?? "unknown",
          content: textContent,
          details: tr.details,
        });
      }
    }
  }

  const evidenceBlock = formatToolResultsForPrompt(toolResults);
  return evidenceBlock.length > 0
    ? `${basePrompt}\n\n${evidenceBlock}`
    : basePrompt;
}

// ============================================================================
// createNovelOSAgent — NovelOS 约定工厂
// ============================================================================

/**
 * NovelOS Agent 创建选项。
 * NovelOS 不直接使用 PI Host session，自主管理 sessionId。
 */
export interface CreateNovelOSAgentOptions {
  /** 系统 prompt */
  systemPrompt: string;
  /** 模型路由名（用于 createPlaceholderModel + createProjectStreamFn） */
  route: string;
  /** 项目模型调用函数 */
  modelGenerate: ModelGenerateFn;
  /** 可用工具列表 */
  tools: AgentTool[];
  /**
   * 工具注入白名单（Phase 2D 缺口一防御纵深，必填）。
   * injectToolSchemas 只接受白名单内工具，集合外工具 fail-closed 拒绝，
   * 防止绕过上游 allowedTools 过滤的全量注入。生产路径传叙事工具白名单。
   */
  allowedToolNames: ReadonlySet<string>;
  /** 自主管理的 session ID（不依赖 PI Host） */
  sessionId: string;
  /** 候选 kind 标签（默认 novelos_agentic） */
  kind?: string;
  /** context transform（每轮 LLM 调用前对 messages 做变换） */
  transformContext?: AgentOptions["transformContext"];
  /** stop hook（每轮结束后评估是否需要下一轮 / 替换 context） */
  prepareNextTurnWithContext?: AgentOptions["prepareNextTurnWithContext"];
  /**
   * afterToolCall hook（Task A.4）：工具执行完成后调用。
   * NovelOS 用它在 budget.isExhausted() 时返回 { terminate: true } 停止 loop。
   * 注意：shouldStopAfterTurn 不在高层 AgentOptions 中（仅低层 AgentLoopConfig），
   * 故用 afterToolCall terminate 实现 bounded stop。
   */
  afterToolCall?: AgentOptions["afterToolCall"];
  /**
   * beforeToolCall hook（Phase 2D 缺口三执行）：工具执行前调用。
   * runtime 用它阻断检索预算用尽后的检索调用（{ block: true }），不终止 loop。
   */
  beforeToolCall?: AgentOptions["beforeToolCall"];
  /** 超时 ms（传给 modelGenerate） */
  timeoutMs?: number;
}

/**
 * 创建一个 NovelOS Agent（封装 pi-agent-core Agent 的 NovelOS 约定）。
 *
 * - 用 createPlaceholderModel(route) 提供 Model 占位；
 * - 用 createProjectStreamFn(modelGenerate, route, kind) 提供 StreamFn 桥接；
 * - convertToLlm 为 identity（AgentMessage 与 LLM Message 结构兼容）；
 * - 不依赖 PI UI 类型，可在无 UI 的 node --test runner 中运行。
 */
export function createNovelOSAgent(options: CreateNovelOSAgentOptions): Agent {
  const {
    systemPrompt,
    route,
    modelGenerate,
    tools,
    allowedToolNames,
    sessionId,
    kind,
    transformContext,
    prepareNextTurnWithContext,
    afterToolCall,
    beforeToolCall,
    timeoutMs,
  } = options;

  const model = createPlaceholderModel(route);
  const streamFn = createProjectStreamFn(modelGenerate, route, kind);
  // 注入 ReAct 工具调用约定 + 工具 schema 到 system prompt（幂等）
  // 缺口一：allowedToolNames 白名单使注入边界 fail-closed，拒绝白名单外工具。
  const systemPromptWithTools = injectToolSchemas(systemPrompt, tools, allowedToolNames);

  const agentOptions: AgentOptions = {
    initialState: {
      systemPrompt: systemPromptWithTools,
      model,
      thinkingLevel: "off",
      tools,
    },
    convertToLlm: (msgs: AgentMessage[]) => msgs as unknown as Context["messages"],
    streamFn: streamFn as AgentOptions["streamFn"],
    sessionId,
    ...(transformContext ? { transformContext } : {}),
    ...(prepareNextTurnWithContext ? { prepareNextTurnWithContext } : {}),
    ...(afterToolCall ? { afterToolCall } : {}),
    ...(beforeToolCall ? { beforeToolCall } : {}),
  };

  return new Agent(agentOptions);
}

// ============================================================================
// 内部工具：构造 AssistantMessage（与 spike 测试一致的极简实现）
// ============================================================================

function makeUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function makeAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: StopReason,
  model = "novelos-bridged",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "faux",
    provider: "novelos",
    model,
    usage: makeUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}
