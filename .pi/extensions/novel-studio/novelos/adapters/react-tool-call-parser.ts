/**
 * NovelOS ReAct Tool Call Parser（Task A.1）
 *
 * 把 text-only ModelGenerateFn 的输出桥接到 pi-agent-core 的原生 tool call 机制。
 *
 * 核心思路（ReAct 式 prompt 工具调用）：
 * - 工具 schema 注入 system prompt（见 tool-schema-injector.ts）；
 * - 模型在文本中输出 `<tool_call>{"name":"...","arguments":{...}}</tool_call>` 指令；
 * - parseToolCallDirectives 解析指令并产出 `toolCall` 内容块（pi-agent-core 期望的格式）；
 * - createProjectStreamFn 据此 emit stopReason="toolUse"，Agent 原生派发工具。
 *
 * pi-agent-core 类型契约（node_modules 确认）：
 * - toolCall 内容块：{ type: "toolCall", id: string, name: string, arguments: Record<string, any> }
 * - stopReason："toolUse" 触发工具派发
 * - toolResult 消息：{ role: "toolResult", toolCallId, toolName, content, details, isError }
 *
 * 设计原则：
 * - 纯函数，无副作用，可独立单测
 * - 容错：JSON 解析失败时 arguments={}，交给 Agent schema 校验产出 error tool result 让模型自纠
 * - 可回放：id 用 sha8(text+index) 确定性生成
 */

import { createHash } from "node:crypto";

// ============================================================================
// 类型
// ============================================================================

/** 解析出的 text 内容块（剥离指令后的 prose） */
export interface ParsedTextBlock {
  type: "text";
  text: string;
}

/** 解析出的 toolCall 内容块（pi-agent-core 期望格式） */
export interface ParsedToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** parseToolCallDirectives 返回 */
export interface ParsedToolCallOutput {
  /** 剥离 `<tool_call>` 指令后的 prose text 块（可能多个，可能为空） */
  textBlocks: ParsedTextBlock[];
  /** 解析出的 toolCall 块 */
  toolCalls: ParsedToolCallBlock[];
  /** 是否包含至少一个 toolCall 指令 */
  hasToolCall: boolean;
}

/** toolResult 消息的简化视图（供 formatToolResultsForPrompt 消费） */
export interface ToolResultView {
  toolName: string;
  content: Array<{ type: "text"; text: string }>;
  details?: {
    sourceRef?: string;
    evidenceLevel?: string;
    [key: string]: unknown;
  };
}

// ============================================================================
// parseToolCallDirectives
// ============================================================================

/** 匹配 `<tool_call>...</tool_call>` 指令（容许内部空白） */
const TOOL_CALL_PATTERN = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/**
 * 从模型文本输出解析 `<tool_call>` 指令。
 *
 * - 扫描所有 `<tool_call>{...}</tool_call>` 块
 * - 容错 JSON：解析失败时 arguments={}（Agent schema 校验会产出 error tool result）
 * - 剥离指令后的 prose 保留为 textBlocks（跳过空块）
 * - id 确定性生成：`tc-{sha8(rawJson+index)}` 保证可回放
 *
 * @param text 模型输出的原始文本
 */
export function parseToolCallDirectives(text: string): ParsedToolCallOutput {
  const toolCalls: ParsedToolCallBlock[] = [];
  const proseParts: string[] = [];
  let lastIndex = 0;

  TOOL_CALL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  let toolIndex = 0;

  while ((match = TOOL_CALL_PATTERN.exec(text)) !== null) {
    // 指令前的 prose
    const before = text.slice(lastIndex, match.index);
    if (before.trim().length > 0) {
      proseParts.push(before);
    }
    lastIndex = match.index + match[0].length;

    const rawJson = match[1] ?? "";
    const parsed = parseToolCallJson(rawJson, toolIndex);
    toolCalls.push(parsed);
    toolIndex++;
  }

  // 末尾 prose
  const tail = text.slice(lastIndex);
  if (tail.trim().length > 0) {
    proseParts.push(tail);
  }

  const textBlocks: ParsedTextBlock[] = proseParts.map((p) => ({ type: "text", text: p }));

  return {
    textBlocks,
    toolCalls,
    hasToolCall: toolCalls.length > 0,
  };
}

// ============================================================================
// 内部：解析单个 tool_call JSON
// ============================================================================

/**
 * 容错解析 tool_call JSON。
 *
 * - 优先 JSON.parse
 * - 失败时尝试 regex salvage 提取 name/arguments
 * - 最终 fallback：name="unknown", arguments={}
 *
 * id 确定性：`tc-{sha8(rawJson+index).slice(0,8)}`
 */
function parseToolCallJson(rawJson: string, index: number): ParsedToolCallBlock {
  const id = `tc-${sha8(`${rawJson}:${index}`).slice(0, 8)}`;

  // 优先 JSON.parse
  try {
    const obj = JSON.parse(rawJson) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "unknown";
      const args =
        o.arguments && typeof o.arguments === "object" && !Array.isArray(o.arguments)
          ? (o.arguments as Record<string, unknown>)
          : {};
      return { type: "toolCall", id, name, arguments: args };
    }
  } catch {
    // fall through to regex salvage
  }

  // Regex salvage：提取 "name":"..." 和 "arguments":{...}
  const nameMatch = rawJson.match(/"name"\s*:\s*"([^"]+)"/);
  const argsMatch = rawJson.match(/"arguments"\s*:\s*(\{[^}]*\})/);
  const name = nameMatch ? nameMatch[1] : "unknown";
  let args: Record<string, unknown> = {};
  if (argsMatch) {
    try {
      args = JSON.parse(argsMatch[1]) as Record<string, unknown>;
    } catch {
      args = {};
    }
  }
  return { type: "toolCall", id, name, arguments: args };
}

// ============================================================================
// formatToolResultsForPrompt
// ============================================================================

/**
 * 把 toolResult 消息序列化为模型可读的证据块。
 *
 * text-only 模型看不到结构化 toolResult 消息，streamFn 必须把 turn 内的 toolResult
 * 回灌到 userPrompt，模型才能基于证据继续生成。
 *
 * 格式：
 * ```
 * 已检索到的证据：
 * [工具 search_chapter_span 结果]
 * {content text}
 * (来源: {sourceRef}, 等级: {evidenceLevel})
 * ...
 * ```
 *
 * @param toolResults turn 内的 toolResult 消息列表
 * @returns 序列化后的证据块（无结果时返回空字符串）
 */
export function formatToolResultsForPrompt(toolResults: ToolResultView[]): string {
  if (toolResults.length === 0) return "";

  const lines: string[] = ["已检索到的证据："];

  for (const result of toolResults) {
    lines.push(`[工具 ${result.toolName} 结果]`);
    const textContent = result.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    lines.push(textContent || "（无文本内容）");

    const sourceRef = result.details?.sourceRef ?? "unknown";
    const evidenceLevel = result.details?.evidenceLevel ?? "inferred";
    lines.push(`(来源: ${sourceRef}, 等级: ${evidenceLevel})`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ============================================================================
// 内部工具
// ============================================================================

/** SHA-256 取前 n 字符（确定性 id 生成） */
function sha8(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
