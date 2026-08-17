/**
 * NovelOS 统一 ModelTurn 事件模型（Phase 2）
 *
 * 建立与 provider 无关的内部事件模型，使编排器不再依赖 XML、JSON 或特定 provider 字段。
 * ReAct 解析结果和 Native Function Calling 结果都先转换为 ModelTurn，
 * 工具指标、coverage、FailureEnvelope 只依赖 ModelTurn。
 *
 * 设计要求：
 * 1. ReAct 解析结果必须先转换为 ModelTurn。
 * 2. Native Function Calling 结果也必须转换为同一结构。
 * 3. 编排器不得依赖 XML、JSON 或特定 provider 字段。
 * 4. toolResult 不再由各适配器自行拼接业务 Prompt（由 serializeToolResults 统一处理）。
 * 5. 保留协议原始响应，便于回放和故障诊断。
 */

// ============================================================================
// 基础类型
// ============================================================================

/**
 * 协议类型标识。
 * - react-text：模型在文本中输出 `<tool_call>` 指令，由 parser 解析
 * - native-function-calling：provider 原生工具调用 API
 * - structured-json：模型输出结构化 JSON（预留，本阶段不实现）
 */
export type ProtocolKind =
  | "react-text"
  | "native-function-calling"
  | "structured-json";

/**
 * 解析状态：适配器 parseResponse 后的统一状态码。
 * - ok：正常解析，有或无工具调用
 * - parse_failure：协议解析失败（如 JSON malformed、XML 边界损坏）
 * - empty_response：模型返回空文本/空响应
 * - schema_error：工具调用参数 schema 校验失败
 * - provider_error：provider 返回错误（非解析问题）
 * - timeout：模型调用超时
 * - aborted：调用被中止
 */
export type ParseStatus =
  | "ok"
  | "parse_failure"
  | "empty_response"
  | "schema_error"
  | "provider_error"
  | "timeout"
  | "aborted";

/**
 * 完成原因：模型停止生成的原因。
 * - stop：正常结束（模型认为输出完成）
 * - tool_use：模型请求工具调用（需要执行工具后继续）
 * - length：达到 max_tokens 上限
 * - content_filter：内容过滤触发
 * - error：运行时错误
 * - aborted：被中止
 */
export type FinishReason =
  | "stop"
  | "tool_use"
  | "length"
  | "content_filter"
  | "error"
  | "aborted";

/**
 * 工具调用事件（与 provider 无关的统一格式）。
 * 对应 ReAct 的 ParsedToolCallBlock 和 Native 的原生 tool_call。
 */
export interface ToolCallEvent {
  /** 确定性 ID（ReAct 用 sha8(rawJson+index)，Native 用 provider 返回的 id） */
  id: string;
  /** 工具名（已规范化为内部白名单名，中文别名已翻译） */
  name: string;
  /** 工具调用参数（已校验为对象，键名已翻译） */
  arguments: Record<string, unknown>;
}

/**
 * 工具结果事件（与 provider 无关的统一格式）。
 * 工具执行后填充，用于 serializeToolResults 回传给模型。
 */
export interface ToolResultEvent {
  /** 对应的 toolCallId */
  toolCallId: string;
  /** 工具名 */
  toolName: string;
  /** 文本内容块 */
  content: Array<{ type: "text"; text: string }>;
  /** 结构化详情（NarrativeToolResultDetails） */
  details?: {
    sourceRef?: string;
    evidenceLevel?: string;
    resultKind?: string;
    returnedCount?: number;
    truncated?: boolean;
    nextQueryHint?: string | null;
    [key: string]: unknown;
  };
  /** 是否为错误结果 */
  isError: boolean;
}

/**
 * 用量指标（与 provider 无关的统一格式）。
 * ReAct 桥接时可能全 0（text-only 模型不返回 usage）。
 */
export interface UsageMetrics {
  /** 输入 token 数 */
  input: number;
  /** 输出 token 数 */
  output: number;
  /** 缓存读取 token 数 */
  cacheRead: number;
  /** 缓存写入 token 数 */
  cacheWrite: number;
  /** 推理 token 数 */
  reasoning: number;
  /** 总 token 数 */
  totalTokens: number;
  /** 成本（美元） */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

// ============================================================================
// ModelTurn — 核心统一事件模型
// ============================================================================

/**
 * 统一 ModelTurn 事件模型。
 *
 * 所有协议适配器的 parseResponse 都返回此类型，编排器只消费 ModelTurn。
 * 保留 rawResponse 用于回放和故障诊断（不进入编排逻辑）。
 */
export interface ModelTurn {
  /** 模型输出的文本内容（剥离工具指令后的 prose，可能为空） */
  text?: string;
  /** 解析出的工具调用列表（无调用时为空数组） */
  toolCalls: ToolCallEvent[];
  /** 工具执行结果列表（首轮为空，后续 turn 填充） */
  toolResults: ToolResultEvent[];
  /** 模型停止生成的原因 */
  finishReason?: FinishReason;
  /** 解析状态（编排器据此判断是否需要错误处理） */
  parseStatus: ParseStatus;
  /** 用量指标（可能为 0，text-only 桥接不返回真实 usage） */
  usage?: UsageMetrics;
  /**
   * 解析失败详情（parseStatus != "ok" 时填充）。
   * 包含 parseFailures 列表，供 trace 和 FailureEnvelope 消费。
   */
  parseFailures?: Array<{
    index: number;
    rawJson: string;
    reason: string;
  }>;
  /**
   * 协议原始响应（不进入编排逻辑，仅用于 trace/回放/诊断）。
   * ReAct: 原始模型文本
   * Native: provider 原始 JSON 响应
   */
  rawResponse?: unknown;
  /** 产生此 turn 的协议类型 */
  protocol: ProtocolKind;
  /** 产生此 turn 的适配器版本 */
  adapterVersion: string;
  /** 模型标识（如 "gemini-3.1-pro"） */
  model?: string;
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建一个空的 UsageMetrics（text-only 桥接不返回真实 usage 时使用）。
 */
export function emptyUsage(): UsageMetrics {
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

/**
 * 创建一个成功的 ModelTurn（无工具调用，纯文本输出）。
 */
export function createTextTurn(
  text: string,
  opts?: {
    finishReason?: FinishReason;
    usage?: UsageMetrics;
    protocol?: ProtocolKind;
    adapterVersion?: string;
    model?: string;
    rawResponse?: unknown;
  },
): ModelTurn {
  return {
    text,
    toolCalls: [],
    toolResults: [],
    finishReason: opts?.finishReason ?? "stop",
    parseStatus: "ok",
    usage: opts?.usage ?? emptyUsage(),
    protocol: opts?.protocol ?? "react-text",
    adapterVersion: opts?.adapterVersion ?? "react-text-v1",
    model: opts?.model,
    rawResponse: opts?.rawResponse,
  };
}

/**
 * 创建一个工具调用 ModelTurn。
 */
export function createToolCallTurn(
  text: string | undefined,
  toolCalls: ToolCallEvent[],
  opts?: {
    finishReason?: FinishReason;
    usage?: UsageMetrics;
    protocol?: ProtocolKind;
    adapterVersion?: string;
    model?: string;
    rawResponse?: unknown;
    parseFailures?: Array<{ index: number; rawJson: string; reason: string }>;
  },
): ModelTurn {
  return {
    text,
    toolCalls,
    toolResults: [],
    finishReason: opts?.finishReason ?? "tool_use",
    parseStatus: opts?.parseFailures && opts.parseFailures.length > 0 ? "parse_failure" : "ok",
    usage: opts?.usage ?? emptyUsage(),
    protocol: opts?.protocol ?? "react-text",
    adapterVersion: opts?.adapterVersion ?? "react-text-v1",
    model: opts?.model,
    rawResponse: opts?.rawResponse,
    parseFailures: opts?.parseFailures,
  };
}

/**
 * 创建一个错误 ModelTurn。
 */
export function createErrorTurn(
  parseStatus: ParseStatus,
  reason: string,
  opts?: {
    protocol?: ProtocolKind;
    adapterVersion?: string;
    model?: string;
    rawResponse?: unknown;
  },
): ModelTurn {
  return {
    text: undefined,
    toolCalls: [],
    toolResults: [],
    finishReason: "error",
    parseStatus,
    usage: emptyUsage(),
    protocol: opts?.protocol ?? "react-text",
    adapterVersion: opts?.adapterVersion ?? "react-text-v1",
    model: opts?.model,
    rawResponse: opts?.rawResponse,
    parseFailures: [{ index: -1, rawJson: "", reason }],
  };
}

// ============================================================================
// 序列化与反序列化
// ============================================================================

/**
 * 序列化 ModelTurn 为可持久化结构（用于 trace）。
 * rawResponse 被序列化为 JSON 字符串（若可序列化）。
 */
export function serializeModelTurn(turn: ModelTurn): Record<string, unknown> {
  return {
    text: turn.text ?? null,
    toolCalls: turn.toolCalls,
    toolResults: turn.toolResults.map((r) => ({
      toolCallId: r.toolCallId,
      toolName: r.toolName,
      content: r.content,
      details: r.details ?? null,
      isError: r.isError,
    })),
    finishReason: turn.finishReason ?? null,
    parseStatus: turn.parseStatus,
    usage: turn.usage ?? null,
    parseFailures: turn.parseFailures ?? [],
    protocol: turn.protocol,
    adapterVersion: turn.adapterVersion,
    model: turn.model ?? null,
    // rawResponse 可能不可序列化，try-catch
    rawResponse: tryStringify(turn.rawResponse),
  };
}

/**
 * 反序列化 ModelTurn（从 trace 读取回放）。
 */
export function deserializeModelTurn(data: Record<string, unknown>): ModelTurn {
  return {
    text: (data.text as string) ?? undefined,
    toolCalls: (data.toolCalls as ToolCallEvent[]) ?? [],
    toolResults: (data.toolResults as ToolResultEvent[]) ?? [],
    finishReason: (data.finishReason as FinishReason) ?? undefined,
    parseStatus: (data.parseStatus as ParseStatus) ?? "ok",
    usage: (data.usage as UsageMetrics) ?? undefined,
    parseFailures: (data.parseFailures as ModelTurn["parseFailures"]) ?? undefined,
    protocol: (data.protocol as ProtocolKind) ?? "react-text",
    adapterVersion: (data.adapterVersion as string) ?? "unknown",
    model: (data.model as string) ?? undefined,
    rawResponse: data.rawResponse,
  };
}

// ============================================================================
// 内部工具
// ============================================================================

function tryStringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
