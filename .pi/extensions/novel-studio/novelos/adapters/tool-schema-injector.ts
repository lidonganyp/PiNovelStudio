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
import { localizeLlmText } from "../../utils/llm-language-guard.js";

// ============================================================================
// 常量
// ============================================================================

/** 幂等检查标记（注入后存在于 systemPrompt 中） */
export const REACT_CALLING_CONVENTION = "<!-- 工具调用约定 -->";

/**
 * 调用约定文本 — 头部（生产与 decision-only 共享）。
 * 不含「收到证据后生成正文」的指令，该部分由尾部变体决定。
 */
const CALLING_CONVENTION_HEAD = [
  "",
  "## 工具调用约定",
  "",
  "你可以通过以下工具检索历史章节、角色状态、知识边界等证据。",
  "当需要查证事实时，发出一个或多个工具调用指令。格式：",
  "",
  '<工具调用>{"工具":"工具名","参数":{"参数名":"参数值"}}</工具调用>',
  "",
  "规则：",
  "1. 可以在一次回复中发出多个 `<工具调用>` 指令（每个单独一行）",
  "2. 指令外的文字会被保留，但工具调用阶段不要写正文",
  "",
].join("\n");

/**
 * 调用约定文本 — 生产默认尾部：收到证据后生成正文。
 * 这是生产正文生成链路（统一编排器）的调用约定。
 */
const CALLING_CONVENTION_FULL_TAIL = [
  "3. 收到工具结果（『已检索到的证据』块）后，基于证据生成正文",
  "4. 证据不足时可继续调用工具；证据充分时直接输出章节正文（不含任何 `<工具调用>`）",
  "5. 只输出 `<工具调用>` 指令和正文，不要输出分析或注释",
  "",
].join("\n");

/**
 * 调用约定文本 — decision-only 尾部（仅 eval/隔离评测）。
 *
 * 评测链路只做「按检索计划决定调用哪个工具、收集证据」，不生产正文。
 * 收到证据后评估是否充分，充分则只输出终止标记（doneMarker），禁止生成/输出任何正文。
 * 该模式只允许在 eval 边界显式开启（tool-ab-real-runner），不得改变生产默认行为。
 *
 * Phase 4.2.2 修复：覆盖 head 的「可一次输出多个工具调用」规则（生产批量检索需要）。
 * decision-only 明确**每回合只输出一个工具调用指令**——模型在单次回复批量输出多个
 * `<工具调用>` 时，后续指令的 XML/JSON 边界易污染（如实测 `{"工具调用>{"工具":...`），
 * 导致整轮回合被标记 parseError 丢弃。单指令输出显著降低格式损坏率。
 */
const CALLING_CONVENTION_DECISION_ONLY_TAIL = (doneMarker: string) => [
  "3. 收到工具结果（『已检索到的证据』块）后，评估证据是否充分",
  `4. 证据不足时可继续调用工具；证据充分时只输出终止标记 ${doneMarker}，禁止生成或输出任何章节正文`,
  "5. **每回合只输出一个 `<工具调用>` 指令**，不要在同一回复里批量输出多个工具调用",
  "6. 只输出单个 `<工具调用>` 指令或终止标记，不要输出分析、注释或正文",
  "",
].join("\n");

/** 生产默认调用约定文本（正文生成链路） */
const CALLING_CONVENTION_TEXT = CALLING_CONVENTION_HEAD + CALLING_CONVENTION_FULL_TAIL;

// ============================================================================
// injectToolSchemas
// ============================================================================

/**
 * 把工具 schema + 调用约定追加到 system prompt（幂等）。
 *
 * @param systemPrompt 原始 system prompt
 * @param tools 可用工具列表（AgentTool[]）
 * @param allowedToolNames 工具注入白名单（必填）。集合外的工具一律 fail-closed 拒绝。
 *   这是注入边界的权威防御（Phase 2D 缺口一）：允许注入的工具必须显式声明，
 *   任何未声明的工具（诊断/新增/全量注入绕过）都会被拒绝，无法"全量注入"。
 *   必填参数使该边界不可绕过——调用方无法在不声明白名单的情况下注入任何工具。
 * @param options 注入选项
 *   - `decisionOnly`：仅对 eval/隔离评测开启。为 true 时，调用约定尾部替换为
 *     "只输出终止标记、禁止生成正文" 的 decision-only 指令（Phase 4.2.2），
 *     去除"基于证据生成正文/证据充分时直接输出章节正文"的正文诱导。
 *     生产正文生成链路默认全量约定，不受影响（不得直接修改生产默认模式）。
 *   - `doneMarker`：decision-only 模式下的终止标记（默认 `<done>`）。
 * @returns 注入后的 system prompt（已含约定则原样返回）
 */
export function injectToolSchemas(
  systemPrompt: string,
  tools: AgentTool[],
  allowedToolNames: ReadonlySet<string>,
  options?: { decisionOnly?: boolean; doneMarker?: string },
): string {
  // 幂等：已注入则不重复
  if (systemPrompt.includes(REACT_CALLING_CONVENTION)) {
    return systemPrompt;
  }

  // 无工具则不注入
  if (!tools || tools.length === 0) {
    return systemPrompt;
  }

  // Phase 2D 缺口一防御纵深：白名单 fail-closed（必填，不可绕过）。
  // 只允许注入白名单内的叙事工具；白名单外工具（含"全量注入"绕过）一律拒绝。
  // 相比"数量上限"，白名单是语义更强的防御：合法工具集恰为 9 个，全量 9 个
  // 正是允许集合，而任何集合外工具（诊断/新增）都会被拦截。
  const unknown = tools
    .map((t) => t.name)
    .filter((name) => !allowedToolNames.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `injectToolSchemas 拒绝注入白名单外工具：${unknown.join(", ")}。` +
        "工具集必须为叙事白名单（NARRATIVE_TOOL_NAMES）内的工具，禁止注入集合外/全量工具。",
    );
  }

  // 调用约定：生产默认 = 全量（生成正文）；decision-only（仅 eval）= 只输出终止标记。
  const tail = options?.decisionOnly
    ? CALLING_CONVENTION_DECISION_ONLY_TAIL(options?.doneMarker ?? "<done>")
    : CALLING_CONVENTION_FULL_TAIL;
  const conventionText = CALLING_CONVENTION_HEAD + tail;

  const parts: string[] = [systemPrompt, REACT_CALLING_CONVENTION, conventionText];

  // 工具列表
  parts.push("## 可用工具");
  parts.push("");
  for (const tool of tools) {
    parts.push(`### ${toChineseToolName(tool.name)}`);
    if (tool.description) {
      parts.push(localizeLlmText(tool.description));
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
    const type = toChineseType((propSchema.type as string) ?? "any");
    const description = (propSchema.description as string) ?? "";
    const isRequired = requiredSet.has(paramName);
    const defaultVal = propSchema.default;

    const reqStr = isRequired ? "必填" : "可选";
    const defaultStr =
      defaultVal !== undefined ? `，默认 ${JSON.stringify(defaultVal)}` : "";
    const descStr = description ? `：${description}` : "";

    lines.push(`- ${toChineseParameterName(paramName)}（${type}，${reqStr}${defaultStr}）${localizeLlmText(descStr)}`);
  }

  return lines.join("\n");
}

const TOOL_NAME_MAP: Record<string, string> = {
  search_narrative_evidence: "跨源叙事证据检索",
  search_chapter_span: "章节原文片段检索",
  query_canon: "世界事实查询",
  query_character_state: "角色状态查询",
  query_timeline: "时间线查询",
  query_character_knowledge_boundary: "角色知识边界查询",
  query_promise_ledger: "承诺账本查询",
  query_pattern_memory: "叙事模式记忆查询",
  query_voice_evidence: "角色声音证据查询",
  query_narrative: "统一叙事查询",
  query_narrative_production: "统一叙事查询（受控接入）",
};

const PARAMETER_NAME_MAP: Record<string, string> = {
  query: "查询词",
  maxResults: "最大结果数",
  maxChapters: "最大章节数",
  chapterNumber: "章节号",
  characterName: "角色名",
  characterId: "角色标识",
  category: "类别",
  promiseId: "承诺标识",
  patternType: "模式类型",
  limit: "返回上限",
  intent: "意图",
  status: "状态",
};

function toChineseToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? "叙事证据工具";
}

function toChineseParameterName(name: string): string {
  return PARAMETER_NAME_MAP[name] ?? "参数";
}

function toChineseType(type: string): string {
  const map: Record<string, string> = {
    string: "字符串",
    number: "数字",
    integer: "整数",
    boolean: "布尔值",
    array: "数组",
    object: "对象",
    any: "任意值",
  };
  return map[type] ?? "任意值";
}
