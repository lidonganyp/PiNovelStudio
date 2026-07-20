/**
 * NovelOS Tool Schema Injector（Task A.2）
 *
 * 把 NovelOS 叙事工具的 schema 注入 system prompt，使 text-only 模型能通过
 * ReAct 式 `<tool_call>` 指令主动调用工具。
 *
 * 与 react-tool-call-parser.ts 配合：
 * - 本模块：把工具 name/description/参数 schema 写入 system prompt + 调用约定
 * - parser：解析模型输出的 `<tool_call>` 指令
 *
 * 设计原则：
 * - 幂等：重复调用不重复注入（检查 REACT_CALLING_CONVENTION 标记）
 * - typebox schema → 人类/模型可读的参数描述
 * - 不依赖 pi-ai 类型，只读 AgentTool 的 name/description/parameters
 */

import type { AgentTool } from "./pi-agent-core-adapter.js";

// ============================================================================
// 常量
// ============================================================================

/** 幂等检查标记（注入后存在于 systemPrompt 中） */
export const REACT_CALLING_CONVENTION = "<!-- react-tool-calling-convention -->";

/** 调用约定文本 */
const CALLING_CONVENTION_TEXT = [
  "",
  "## 工具调用约定",
  "",
  "你可以通过以下工具检索历史章节、角色状态、知识边界等证据。",
  "当需要查证事实时，发出一个或多个工具调用指令。格式：",
  "",
  '<tool_call>{"name":"工具名","arguments":{"参数名":"参数值"}}</tool_call>',
  "",
  "规则：",
  "1. 可以在一次回复中发出多个 `<tool_call>` 指令（每个单独一行）",
  "2. 指令外的文字会被保留，但工具调用阶段不要写正文",
  "3. 收到工具结果（『已检索到的证据』块）后，基于证据生成正文",
  "4. 证据不足时可继续调用工具；证据充分时直接输出章节正文（不含任何 `<tool_call>`）",
  "5. 只输出 `<tool_call>` 指令和正文，不要输出分析或注释",
  "",
].join("\n");

// ============================================================================
// injectToolSchemas
// ============================================================================

/**
 * 把工具 schema + 调用约定追加到 system prompt（幂等）。
 *
 * @param systemPrompt 原始 system prompt
 * @param tools 可用工具列表（AgentTool[]）
 * @returns 注入后的 system prompt（已含约定则原样返回）
 */
export function injectToolSchemas(
  systemPrompt: string,
  tools: AgentTool[],
): string {
  // 幂等：已注入则不重复
  if (systemPrompt.includes(REACT_CALLING_CONVENTION)) {
    return systemPrompt;
  }

  // 无工具则不注入
  if (!tools || tools.length === 0) {
    return systemPrompt;
  }

  const parts: string[] = [systemPrompt, REACT_CALLING_CONVENTION, CALLING_CONVENTION_TEXT];

  // 工具列表
  parts.push("## 可用工具");
  parts.push("");
  for (const tool of tools) {
    parts.push(`### ${tool.name}`);
    if (tool.description) {
      parts.push(tool.description);
    }
    const paramsDesc = describeParameters(tool);
    if (paramsDesc) {
      parts.push("");
      parts.push(paramsDesc);
    }
    parts.push("");
  }

  return parts.join("\n").trimEnd() + "\n";
}

// ============================================================================
// 内部：参数 schema → 可读描述
// ============================================================================

/**
 * 把 typebox parameters schema 转换为人类可读的参数描述。
 *
 * typebox Type.Object 产出的 schema 是标准 JSON Schema：
 * - schema.properties: Record<string, propertySchema>
 * - schema.required: string[]
 *
 * 输出格式：
 * ```
 * 参数：
 * - query（string，必填）：搜索关键词或短语
 * - maxChapters（number，可选，默认 10）：搜索最近多少章
 * ```
 */
function describeParameters(tool: AgentTool): string {
  const schema = (tool as { parameters?: unknown }).parameters;
  if (!schema || typeof schema !== "object") return "";

  const s = schema as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const props = s.properties;
  if (!props || Object.keys(props).length === 0) return "";

  const requiredSet = new Set(s.required ?? []);
  const lines: string[] = ["参数："];

  for (const [paramName, propSchema] of Object.entries(props)) {
    const type = (propSchema.type as string) ?? "any";
    const description = (propSchema.description as string) ?? "";
    const isRequired = requiredSet.has(paramName);
    const defaultVal = propSchema.default;

    const reqStr = isRequired ? "必填" : "可选";
    const defaultStr =
      defaultVal !== undefined ? `，默认 ${JSON.stringify(defaultVal)}` : "";
    const descStr = description ? `：${description}` : "";

    lines.push(`- ${paramName}（${type}，${reqStr}${defaultStr}）${descStr}`);
  }

  return lines.join("\n");
}
