/**
 * NovelOS 协议适配器抽象（Phase 3）
 *
 * 定义统一适配器接口，使 ReAct、Native Function Calling、Structured JSON 等
 * 实现统一为可替换适配器。适配器只负责协议转换，不修改业务编排逻辑。
 *
 * 设计要求：
 * - 适配器只负责协议转换
 * - 工具权限、schema、预算和状态提交由系统层负责
 * - parser failure、schema failure、provider failure 必须分类
 * - 适配器版本写入 Prompt Bundle fingerprint 和 trace
 * - 协议切换不得改变业务工具定义
 * - 不绕过工具白名单和 schema
 * - 不绕过权限接口
 * - 不绕过检索预算、coverage gate、FactGuard
 * - 所有失败统一转换为结构化 parseStatus 或 FailureEnvelope
 * - ReAct 与 Native 使用同一套指标口径
 */

import type { ModelTurn, ProtocolKind } from "./model-turn.js";

// ============================================================================
// 适配器请求/响应类型
// ============================================================================

/**
 * 适配器请求输入（编排器 → 适配器）。
 * 与 provider 无关，适配器负责将其转换为 provider 特定格式。
 */
export interface AdapterRequest {
  /** 系统 prompt（已注入工具 schema 后） */
  systemPrompt: string;
  /** 用户 prompt（含上下文 + 证据回灌） */
  userPrompt: string;
  /** 模型路由名（如 "gemini_writer_v2" / "v2_rawstage2"） */
  route: string;
  /** 候选 kind 标签 */
  kind?: string;
  /** 超时 ms */
  timeoutMs?: number;
  /**
   * 工具定义（适配器据此构建 provider 特定工具 schema）。
   * ReAct 适配器忽略此字段（schema 已注入 systemPrompt）。
   * Native 适配器将此转换为 provider 原生 tool definitions。
   */
  tools?: AdapterToolDefinition[];
  /**
   * 上一轮工具结果（适配器据此构建 provider continuation）。
   * ReAct 适配器将其序列化为文本追加到 userPrompt。
   * Native 适配器将其转换为 provider 原生 tool result 消息。
   */
  pendingToolResults?: AdapterToolResult[];
}

/**
 * 适配器可见的工具定义（与 provider 无关）。
 */
export interface AdapterToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 参数定义 */
  parameters: Record<string, unknown>;
}

/**
 * 适配器可见的工具结果（与 provider 无关）。
 */
export interface AdapterToolResult {
  toolCallId: string;
  toolName: string;
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError: boolean;
}

/**
 * Provider 请求（适配器 → provider）。
 * 这是一个抽象类型，具体适配器将其转换为 provider 特定格式。
 */
export interface ProviderRequest {
  /** 序列化后的完整请求（provider 特定格式） */
  body: unknown;
  /** 请求 headers（provider 特定） */
  headers?: Record<string, string>;
  /** 请求 URL（provider 特定） */
  url?: string;
}

/**
 * Provider 响应（provider → 适配器）。
 * 适配器 parseResponse 将其转换为 ModelTurn。
 */
export interface ProviderResponse {
  /** provider 原始响应体 */
  body: unknown;
  /** HTTP 状态码 */
  status: number;
  /** 响应 headers */
  headers?: Record<string, string>;
}

/**
 * Provider continuation（适配器产出的下一轮请求增量）。
 * 适配器 serializeToolResults 将 ModelTurn.toolResults 转换为此格式。
 */
export interface ProviderContinuation {
  /** 追加到下一轮请求的消息/内容（provider 特定格式） */
  messages: unknown[];
  /** 追加到 userPrompt 的文本（ReAct 适配器使用） */
  textAppend?: string;
}

// ============================================================================
// ModelProtocolAdapter 接口
// ============================================================================

/**
 * 统一协议适配器接口。
 *
 * 适配器必须满足：
 * - 不直接修改业务编排逻辑
 * - 不绕过工具白名单和 schema
 * - 不绕过权限接口
 * - 不绕过检索预算、coverage gate、FactGuard
 * - 所有失败统一转换为结构化 parseStatus 或 FailureEnvelope
 * - ReAct 与 Native 使用同一套指标口径
 */
export interface ModelProtocolAdapter {
  /** 协议类型标识 */
  readonly protocol: ProtocolKind;

  /** 适配器版本（写入 Prompt Bundle fingerprint 和 trace） */
  readonly version: string;

  /**
   * 构建 provider 请求。
   * 将统一 AdapterRequest 转换为 provider 特定格式。
   *
   * - ReAct：tools 已注入 systemPrompt，body = { systemPrompt, userPrompt, route, ... }
   * - Native：tools 转换为 provider 原生 tool definitions，body = provider API 格式
   */
  createRequest(input: AdapterRequest): ProviderRequest;

  /**
   * 解析 provider 响应为 ModelTurn。
   *
   * - ReAct：解析 `<tool_call>` 指令，转换为 ToolCallEvent[]
   * - Native：解析 provider 原生 tool_calls，转换为 ToolCallEvent[]
   * - 所有解析失败统一转换为 parseStatus（parse_failure / empty_response / provider_error 等）
   * - 保留 rawResponse 用于回放和诊断
   */
  parseResponse(response: ProviderResponse): ModelTurn;

  /**
   * 序列化工具结果为 provider continuation。
   *
   * - ReAct：格式化为「已检索到的证据」文本块，追加到 userPrompt
   * - Native：转换为 provider 原生 tool result 消息
   */
  serializeToolResults(turn: ModelTurn): ProviderContinuation;
}

// ============================================================================
// 适配器版本管理
// ============================================================================

/**
 * 已注册的适配器版本。
 */
export interface AdapterVersionInfo {
  protocol: ProtocolKind;
  version: string;
  /** 适配器类名/标识 */
  name: string;
  /** 是否为 eval-only（true = 不进生产构建） */
  evalOnly: boolean;
  /** 描述 */
  description: string;
}

/**
 * 已知适配器版本清单。
 * 用于 Prompt Bundle fingerprint 和 trace 记录。
 */
export const ADAPTER_VERSIONS: readonly AdapterVersionInfo[] = [
  {
    protocol: "react-text",
    version: "react-text-v1",
    name: "ReactTextAdapter",
    evalOnly: false,
    description: "生产默认：text-only ReAct 协议，模型输出 <tool_call> 指令由 parser 解析",
  },
  {
    protocol: "native-function-calling",
    version: "native-fc-v1",
    name: "NativeFunctionCallingAdapter",
    evalOnly: true,
    description: "Eval-only：provider 原生 Function Calling API，不进生产默认路由",
  },
  {
    protocol: "structured-json",
    version: "structured-json-v0",
    name: "StructuredJsonAdapter",
    evalOnly: true,
    description: "预留：结构化 JSON 输出协议，本阶段不实现",
  },
];

/**
 * 获取适配器版本信息。
 */
export function getAdapterVersionInfo(
  protocol: ProtocolKind,
  version: string,
): AdapterVersionInfo | undefined {
  return ADAPTER_VERSIONS.find(
    (v) => v.protocol === protocol && v.version === version,
  );
}

/**
 * 适配器 fingerprint（写入 Prompt Bundle fingerprint）。
 */
export function computeAdapterFingerprint(
  protocol: ProtocolKind,
  version: string,
): string {
  return `${protocol}:${version}`;
}
