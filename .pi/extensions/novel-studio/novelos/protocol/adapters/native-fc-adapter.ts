/**
 * NovelOS Native Function Calling Adapter（Phase 4 — Eval-only）
 *
 * 接入 provider 原生工具调用 API，将原生响应转换为 ModelTurn。
 * 仅在隔离评测路径使用，不进入生产默认路由。
 *
 * 验收标准：
 * - Native 调用能通过统一工具执行层
 * - 未授权工具调用、schema 错误、空调用和提前结束均可被识别
 * - 所有失败都有 FailureEnvelope
 * - 生产构建与生产 route 不包含 Native 默认分支
 * - ReAct 与 Native 可以在同一 fixture 上进行 A/B
 *
 * 安全约束：
 * - 禁止 Native 失败后静默降级为 raw 正文
 * - 生产默认路由不得启用该 adapter
 * - 使用与 ReAct 完全一致的 Prompt、上下文、工具集、工具 schema、检索预算
 */

import {
  type ModelProtocolAdapter,
  type AdapterRequest,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderContinuation,
  type AdapterToolDefinition,
} from "../protocol-adapter.js";
import {
  type ModelTurn,
  type ToolCallEvent,
  type ToolResultEvent,
  type FinishReason,
  type ParseStatus,
  type UsageMetrics,
  emptyUsage,
} from "../model-turn.js";

// ============================================================================
// 类型：Provider 原生响应（OpenAI-compatible Function Calling 格式）
// ============================================================================

/**
 * OpenAI-compatible Function Calling 响应格式。
 * Gemini OpenAI-compatible endpoint 和其他兼容 provider 使用此格式。
 */
interface NativeFunctionCallResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string; // JSON 字符串
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  model?: string;
  error?: {
    message: string;
    type?: string;
    code?: string;
  };
}

// ============================================================================
// NativeFunctionCallingAdapter
// ============================================================================

/**
 * Native Function Calling 协议适配器（Eval-only）。
 *
 * 接入 provider 原生工具调用 API：
 * - createRequest：将 AdapterToolDefinition[] 转换为 provider 原生 tools 格式
 * - parseResponse：解析 provider 原生 tool_calls，转换为 ToolCallEvent[]
 * - serializeToolResults：将 ToolResultEvent[] 转换为 provider 原生 tool result 消息
 *
 * 与 ReAct 适配器的关键差异：
 * - 不需要 tool-schema-injector 注入 system prompt（provider 原生 API 携带 tool definitions）
 * - 不需要 formatToolResultsForPrompt 回灌 userPrompt（provider 原生 API 支持 tool result 消息）
 * - 工具调用通过 provider API 原生传输，不共享文本通道
 */
export class NativeFunctionCallingAdapter implements ModelProtocolAdapter {
  readonly protocol = "native-function-calling" as const;
  readonly version = "native-fc-v1";

  /**
   * 构建 provider 请求。
   * 将 AdapterToolDefinition[] 转换为 OpenAI-compatible tools 格式。
   */
  createRequest(input: AdapterRequest): ProviderRequest {
    const tools = (input.tools ?? []).map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    return {
      body: {
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        route: input.route,
        kind: input.kind ?? "novelos_agentic",
        timeoutMs: input.timeoutMs,
        tools,
        // Native 模式：pendingToolResults 作为原生 tool result 消息传入
        pendingToolResults: input.pendingToolResults ?? [],
      },
      headers: {},
    };
  }

  /**
   * 解析 provider 响应为 ModelTurn。
   *
   * - 解析 choices[0].message.tool_calls
   * - 有 tool_calls → toolCalls 非空，finishReason="tool_use"
   * - 无 tool_calls → toolCalls 空，finishReason="stop"
   * - error 字段 → parseStatus="provider_error"
   * - 空响应 → parseStatus="empty_response"
   * - arguments JSON 解析失败 → parseStatus="parse_failure"（best-effort 产出空参数）
   */
  parseResponse(response: ProviderResponse): ModelTurn {
    const body = response.body as NativeFunctionCallResponse;

    // provider 错误检查
    if (body.error) {
      const isTimeout = body.error.code === "timeout" || body.error.type === "timeout";
      return {
        text: undefined,
        toolCalls: [],
        toolResults: [],
        finishReason: "error",
        parseStatus: isTimeout ? "timeout" : "provider_error",
        usage: emptyUsage(),
        protocol: this.protocol,
        adapterVersion: this.version,
        model: body.model,
        rawResponse: response.body,
        parseFailures: [{ index: -1, rawJson: "", reason: body.error.message }],
      };
    }

    // 空响应检查
    if (!body.choices || body.choices.length === 0) {
      return {
        text: undefined,
        toolCalls: [],
        toolResults: [],
        finishReason: "stop",
        parseStatus: "empty_response",
        usage: parseNativeUsage(body.usage),
        protocol: this.protocol,
        adapterVersion: this.version,
        model: body.model,
        rawResponse: response.body,
        parseFailures: [{ index: -1, rawJson: "", reason: "provider 返回空 choices" }],
      };
    }

    const choice = body.choices[0];
    const message = choice.message;
    const text = message?.content ?? undefined;

    // 解析 tool_calls
    const toolCalls: ToolCallEvent[] = [];
    const parseFailures: Array<{ index: number; rawJson: string; reason: string }> = [];

    if (message?.tool_calls && message.tool_calls.length > 0) {
      for (let i = 0; i < message.tool_calls.length; i++) {
        const tc = message.tool_calls[i];
        const rawArgs = tc.function.arguments;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(rawArgs) as Record<string, unknown>;
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            args = {};
            parseFailures.push({
              index: i,
              rawJson: rawArgs,
              reason: "arguments 不是有效 JSON 对象",
            });
          }
        } catch {
          parseFailures.push({
            index: i,
            rawJson: rawArgs,
            reason: "arguments JSON 解析失败（malformed）",
          });
        }
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          arguments: args,
        });
      }
    }

    // 确定 finishReason
    const nativeFinish = choice.finish_reason;
    const finishReason = mapNativeFinishReason(nativeFinish, toolCalls.length > 0);

    // 确定 parseStatus
    let parseStatus: ParseStatus = "ok";
    if (parseFailures.length > 0) {
      parseStatus = "parse_failure";
    }
    if (!text && toolCalls.length === 0 && parseFailures.length === 0) {
      parseStatus = "empty_response";
    }

    return {
      text: text ?? undefined,
      toolCalls,
      toolResults: [],
      finishReason,
      parseStatus,
      usage: parseNativeUsage(body.usage),
      protocol: this.protocol,
      adapterVersion: this.version,
      model: body.model,
      rawResponse: response.body,
      parseFailures: parseFailures.length > 0 ? parseFailures : undefined,
    };
  }

  /**
   * 序列化工具结果为 provider continuation。
   * Native 适配器生成 OpenAI-compatible tool result 消息。
   */
  serializeToolResults(turn: ModelTurn): ProviderContinuation {
    const messages = turn.toolResults.map((r) => ({
      role: "tool" as const,
      tool_call_id: r.toolCallId,
      content: r.content.map((c) => c.text).join("\n"),
    }));

    return {
      messages,
      textAppend: undefined, // Native 模式不追加文本到 userPrompt
    };
  }
}

// ============================================================================
// 工厂
// ============================================================================

/**
 * 创建 Native Function Calling 适配器实例（Eval-only）。
 */
export function createNativeFunctionCallingAdapter(): NativeFunctionCallingAdapter {
  return new NativeFunctionCallingAdapter();
}

// ============================================================================
// 内部工具
// ============================================================================

/**
 * 映射 provider finish_reason 到统一 FinishReason。
 */
function mapNativeFinishReason(
  native: string | undefined,
  hasToolCalls: boolean,
): FinishReason {
  if (!native) {
    return hasToolCalls ? "tool_use" : "stop";
  }
  switch (native) {
    case "stop":
      return hasToolCalls ? "tool_use" : "stop";
    case "tool_calls":
    case "tool_use":
      return "tool_use";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return hasToolCalls ? "tool_use" : "stop";
  }
}

/**
 * 解析 provider usage 到统一 UsageMetrics。
 */
function parseNativeUsage(
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
): UsageMetrics {
  if (!usage) return emptyUsage();
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: usage.total_tokens ?? input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * 将 AdapterToolDefinition[] 转换为 OpenAI-compatible tools 格式（供外部使用）。
 */
export function toNativeTools(
  tools: AdapterToolDefinition[],
): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
