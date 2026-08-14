/**
 * NovelOS ReAct Text Protocol Adapter（Phase 3）
 *
 * 封装现有 react-tool-call-parser，实现 ModelProtocolAdapter 接口。
 * 这是生产默认适配器，将 text-only 模型的 `<tool_call>` 指令解析为 ModelTurn。
 *
 * 与现有代码的关系：
 * - createRequest：透传 systemPrompt + userPrompt（schema 已由 tool-schema-injector 注入）
 * - parseResponse：调用 parseToolCallDirectives，转换为 ModelTurn
 * - serializeToolResults：调用 formatToolResultsForPrompt，生成证据文本块
 *
 * 验收标准：
 * - 编排器可通过 route 配置选择 adapter
 * - 默认生产仍使用唯一 ReAct Adapter
 * - 非法调用不能绕过系统安全检查
 */

import {
  parseToolCallDirectives,
  formatToolResultsForPrompt,
  type ToolResultView,
} from "../../adapters/react-tool-call-parser.js";
import {
  type ModelProtocolAdapter,
  type AdapterRequest,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderContinuation,
  type AdapterToolResult,
} from "../protocol-adapter.js";
import {
  type ModelTurn,
  type ToolCallEvent,
  type ToolResultEvent,
  type UsageMetrics,
  emptyUsage,
} from "../model-turn.js";

// ============================================================================
// ReactTextAdapter
// ============================================================================

/**
 * ReAct 文本协议适配器（生产默认）。
 *
 * 模型在文本中输出 `<tool_call>{"name":"...","arguments":{...}}</tool_call>` 指令，
 * parser 解析后转换为 ModelTurn。
 *
 * 适配器不负责：
 * - 工具 schema 注入（由 tool-schema-injector 在上游完成）
 * - 工具权限校验（由 PermissionPolicy 在系统层完成）
 * - 检索预算控制（由 BudgetPolicy 在系统层完成）
 */
export class ReactTextAdapter implements ModelProtocolAdapter {
  readonly protocol = "react-text" as const;
  readonly version = "react-text-v1";

  /**
   * 构建 provider 请求。
   * ReAct 适配器直接透传 systemPrompt + userPrompt（schema 已注入 systemPrompt）。
   * tools 和 pendingToolResults 在 ReAct 协议中不需要传入 provider
   * （tools 已在 systemPrompt 中，toolResults 已在 userPrompt 中）。
   */
  createRequest(input: AdapterRequest): ProviderRequest {
    return {
      body: {
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        route: input.route,
        kind: input.kind ?? "novelos_agentic",
        timeoutMs: input.timeoutMs,
      },
      headers: {},
    };
  }

  /**
   * 解析 provider 响应为 ModelTurn。
   *
   * - 调用 parseToolCallDirectives 解析 `<tool_call>` 指令
   * - 有工具调用 → toolCalls 非空，finishReason="tool_use"
   * - 无工具调用 → toolCalls 空，finishReason="stop"（最终正文）
   * - 空响应 → parseStatus="empty_response"
   * - 解析失败 → parseStatus="parse_failure"，但 best-effort 产出 toolCalls
   */
  parseResponse(response: ProviderResponse): ModelTurn {
    const body = response.body as { text?: string; model?: string; usage?: Partial<UsageMetrics> };

    // 空响应检查
    if (!body || typeof body.text !== "string" || body.text.trim().length === 0) {
      return {
        text: undefined,
        toolCalls: [],
        toolResults: [],
        finishReason: "stop",
        parseStatus: "empty_response",
        usage: body?.usage ? mergeUsage(body.usage) : emptyUsage(),
        protocol: this.protocol,
        adapterVersion: this.version,
        model: body?.model,
        rawResponse: response.body,
        parseFailures: [{ index: -1, rawJson: "", reason: "模型返回空文本" }],
      };
    }

    // 解析 ReAct `<tool_call>` 指令
    const parsed = parseToolCallDirectives(body.text);

    // 合并 textBlocks 为单一 text
    const text = parsed.textBlocks.length > 0
      ? parsed.textBlocks.map((b) => b.text).join("\n")
      : undefined;

    // 转换 toolCalls 为 ToolCallEvent[]
    const toolCalls: ToolCallEvent[] = parsed.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    }));

    // 确定 parseStatus
    const parseStatus = parsed.parseFailures.length > 0 ? "parse_failure" : "ok";

    // 确定 finishReason
    const finishReason = parsed.hasToolCall ? "tool_use" : "stop";

    return {
      text,
      toolCalls,
      toolResults: [],
      finishReason,
      parseStatus,
      usage: body.usage ? mergeUsage(body.usage) : emptyUsage(),
      protocol: this.protocol,
      adapterVersion: this.version,
      model: body.model,
      rawResponse: body.text,
      parseFailures: parsed.parseFailures.length > 0 ? parsed.parseFailures : undefined,
    };
  }

  /**
   * 序列化工具结果为 provider continuation。
   * ReAct 适配器调用 formatToolResultsForPrompt 生成证据文本块。
   */
  serializeToolResults(turn: ModelTurn): ProviderContinuation {
    const toolResults: ToolResultView[] = turn.toolResults.map((r) => ({
      toolName: r.toolName,
      content: r.content,
      details: r.details,
    }));

    const textAppend = formatToolResultsForPrompt(toolResults);
    return {
      messages: [],
      textAppend: textAppend.length > 0 ? textAppend : undefined,
    };
  }
}

// ============================================================================
// 工厂
// ============================================================================

/**
 * 创建 ReAct 文本协议适配器实例。
 */
export function createReactTextAdapter(): ReactTextAdapter {
  return new ReactTextAdapter();
}

// ============================================================================
// 内部工具
// ============================================================================

/**
 * 合并 provider 返回的 usage（可能部分字段缺失）。
 */
function mergeUsage(partial: Partial<UsageMetrics>): UsageMetrics {
  const base = emptyUsage();
  return {
    input: partial.input ?? base.input,
    output: partial.output ?? base.output,
    cacheRead: partial.cacheRead ?? base.cacheRead,
    cacheWrite: partial.cacheWrite ?? base.cacheWrite,
    reasoning: partial.reasoning ?? base.reasoning,
    totalTokens: partial.totalTokens ?? base.totalTokens,
    cost: {
      input: partial.cost?.input ?? base.cost.input,
      output: partial.cost?.output ?? base.cost.output,
      cacheRead: partial.cost?.cacheRead ?? base.cost.cacheRead,
      cacheWrite: partial.cost?.cacheWrite ?? base.cost.cacheWrite,
      total: partial.cost?.total ?? base.cost.total,
    },
  };
}

/**
 * 将 AdapterToolResult[] 转换为 ToolResultEvent[]（供适配器内部使用）。
 */
export function adapterResultsToToolEvents(
  results: AdapterToolResult[],
): ToolResultEvent[] {
  return results.map((r) => ({
    toolCallId: r.toolCallId,
    toolName: r.toolName,
    content: r.content,
    details: r.details,
    isError: r.isError,
  }));
}
