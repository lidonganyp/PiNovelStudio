/**
 * NovelOS Phase 4 A/B — B 组 typed facade（eval-only）
 *
 * 假设：9 个 narrow 专用工具是否比单个类型化统一入口（query_narrative）更优？
 * B 组用本 facade 测试"单入口 + 类型化 intent"形态。
 *
 * 铁律：
 * - eval-only：本模块只注册在 tsconfig.eval.json（dist-eval/），不进入生产构建。
 * - 零逻辑复制：内部必须调用 createNarrativeTools 产出的既有 9 个工具对象，
 *   按 intent 路由后调用其 execute()，**原样透传** NarrativeToolResultDetails
 *   （sourceRef / evidenceLevel / resultKind / truncated / nextQueryHint）。
 *   检索、token fallback、limit 截断、nextQueryHint 生成全部由底层工具完成。
 * - intent：必填联合类型，把"模型想查什么"显式化为 9 个意图之一，
 *   避免模型在 9 个窄工具 schema 间自行选择。
 */

import { Type } from "typebox";
import type { ToolProtocol, NarrativeToolResultDetails } from "../tools/tool-protocol.js";
import { createNarrativeTools } from "../tools/narrative-tools.js";
import type { NarrativeSearchService } from "../agent/narrative-search-service.js";

/** facade 统一工具名 */
export const QUERY_NARRATIVE_NAME = "query_narrative";

/** 9 个意图（与底层 9 个专用工具一一对应） */
export type QueryNarrativeIntent =
  | "evidence"
  | "chapter_span"
  | "canon"
  | "character_state"
  | "timeline"
  | "knowledge_boundary"
  | "promise"
  | "pattern"
  | "voice";

/** 意图 → 底层专用工具名 */
export const INTENT_TO_TOOL: Record<QueryNarrativeIntent, string> = {
  evidence: "search_narrative_evidence",
  chapter_span: "search_chapter_span",
  canon: "query_canon",
  character_state: "query_character_state",
  timeline: "query_timeline",
  knowledge_boundary: "query_character_knowledge_boundary",
  promise: "query_promise_ledger",
  pattern: "query_pattern_memory",
  voice: "query_voice_evidence",
};

/** 底层专用工具名 → 意图（供 A/B runner 把 BASELINE_SCENARIOS 的调用映射为 facade 调用） */
export const TOOL_NAME_TO_INTENT: Record<string, QueryNarrativeIntent> = {
  search_narrative_evidence: "evidence",
  search_chapter_span: "chapter_span",
  query_canon: "canon",
  query_character_state: "character_state",
  query_timeline: "timeline",
  query_character_knowledge_boundary: "knowledge_boundary",
  query_promise_ledger: "promise",
  query_pattern_memory: "pattern",
  query_voice_evidence: "voice",
};

/**
 * 英文意图 → 中文标签（模型可见，供 schema 注入）。
 *
 * B 组 facade 的 intent 值必须保持模型可读的中文标签，避免被 llm-language-guard
 * 的 localizeLlmText 把英文意图标识（evidence/canon/...）转成乱码占位。
 * 模型在 `<tool_call>` 中输出中文标签，runner 再经 CHINESE_TO_INTENT_MAP 映射回
 * 英文协议值路由到底层专用工具。
 */

/** 全部意图列表（用于 AB 报告与 schema 联合） */
export const QUERY_NARRATIVE_INTENTS: QueryNarrativeIntent[] = [
  "evidence",
  "chapter_span",
  "canon",
  "character_state",
  "timeline",
  "knowledge_boundary",
  "promise",
  "pattern",
  "voice",
];

export const INTENT_CHINESE_LABEL: Record<QueryNarrativeIntent, string> = {
  evidence: "跨源证据检索",
  chapter_span: "章节原文检索",
  canon: "世界事实查询",
  character_state: "角色状态查询",
  timeline: "时间线查询",
  knowledge_boundary: "知识边界查询",
  promise: "承诺账本查询",
  pattern: "叙事模式查询",
  voice: "声音证据查询",
};

/** 中文标签 → 英文协议值（把模型输出的中文意图映射回底层工具路由） */
export const CHINESE_TO_INTENT_MAP: Record<string, QueryNarrativeIntent> = (() => {
  const m: Record<string, QueryNarrativeIntent> = {};
  for (const [intent, label] of Object.entries(INTENT_CHINESE_LABEL)) {
    m[label] = intent as QueryNarrativeIntent;
  }
  return m;
})();

/**
 * 每个意图的使用说明：何时使用 + 优先级（一行式，尽可能紧凑）。
 *
 * Phase 4.2.2：给 facade intent 明确的「何时使用、优先级」语义，
 * 尤其明确**事实核验优先使用 evidence**，帮助模型在统一入口下做出更准的路由决策，
 * 避免在 9 个窄工具 schema 间或意图之间盲目切换（诊断 SC1-canon 的 canon:empty 降级）。
 *
 * 设计约束：本说明只注入**工具 description 一处**（INTENT_USAGE 不进 intent 参数
 * schema，避免重复膨胀 B 组 schema token 反超 A 组，破坏"facade 降低上下文负担"门禁）。
 * 各意图参数（query/characterId/category/...）已在 parameters schema 中声明，此处不重复。
 */
export const INTENT_USAGE: Record<QueryNarrativeIntent, string> = {
  evidence: "核心事实/情节元素跨源交叉核验（默认首选，最高优先级）",
  chapter_span: "查看章节原文措辞/前后文（中优先级）",
  canon: "世界设定/既定事实冲突核验（高优先级）",
  character_state: "角色当前状态/经历/情感（中优先级）",
  timeline: "事件先后顺序/时间点核验（中优先级）",
  knowledge_boundary: "角色知道什么/不该知道什么（中优先级）",
  promise: "伏笔/承诺建立与兑现状态（中优先级）",
  pattern: "叙事模式/桥段/意象用法（低优先级，非硬事实）",
  voice: "角色声音/说话习惯证据（低优先级）",
};

/** 拼接单个意图的「何时使用 + 优先级」说明 */
export function describeIntentUsage(intent: QueryNarrativeIntent): string {
  const label = INTENT_CHINESE_LABEL[intent];
  return `${label}：${INTENT_USAGE[intent]}`;
}

/** 全部意图的「何时使用 + 优先级」说明（仅用于工具 description，不重复注入参数 schema） */
export const QUERY_NARRATIVE_INTENT_GUIDANCE: string = QUERY_NARRATIVE_INTENTS.map(
  (i) => `- ${describeIntentUsage(i)}`,
).join("\n");

/**
 * 创建 B 组 typed facade 工具。
 *
 * facade 本身不持有检索逻辑：它在内部用 createNarrativeTools 构造 9 个底层工具，
 * execute 时按 intent 取出对应底层工具并调用其 execute()，把（intent 之外的）
 * 参数原样透传。返回的 details 与底层工具完全一致。
 *
 * @param ctx 需提供 searchService（与 createNarrativeTools 相同契约）
 */
export function createTypedFacadeTool(ctx: {
  searchService: NarrativeSearchService;
}): ToolProtocol {
  const underlyingTools = createNarrativeTools({ searchService: ctx.searchService });
  const byName = new Map(underlyingTools.map((t) => [t.name, t]));

  return {
    name: QUERY_NARRATIVE_NAME,
    description:
      "统一叙事查询入口：按查询意图路由到对应的叙事专用工具。" +
      "事实核验类查询**优先使用「跨源证据检索」意图**；返回的结果带来源引用与证据等级。\n" +
      `各意图「何时使用/优先级」：\n${QUERY_NARRATIVE_INTENT_GUIDANCE}`,
    label: "Query Narrative (Typed Facade)",
    parameters: Type.Object({
      intent: Type.Union(
        QUERY_NARRATIVE_INTENTS.map((i) => Type.Literal(i)),
        {
          description:
            "查询意图（决定路由到哪个专用工具）。事实核验优先选择「跨源证据检索」。各意图用法见工具说明。",
        },
      ),
      query: Type.Optional(Type.String({ description: "搜索关键词/短语（跨源证据检索、章节原文检索意图使用）" })),
      category: Type.Optional(Type.String({ description: "世界事实查询过滤类别：时间线/地点/实体/能力规则" })),
      characterId: Type.Optional(Type.String({ description: "角色标识/名称（角色状态查询、知识边界查询、声音证据查询意图使用）" })),
      status: Type.Optional(Type.String({ description: "承诺账本查询过滤状态：进行中/推进/已兑现/已破坏" })),
      patternType: Type.Optional(Type.String({ description: "叙事模式查询过滤类型：桥段/意象/句式风险/冲突解决/钩子类型" })),
      maxResults: Type.Optional(Type.Number({ description: "最大返回数（搜索类意图）", default: 10 })),
      maxChapters: Type.Optional(Type.Number({ description: "搜索最近多少章（章节原文检索意图）", default: 10 })),
    }),
    requiredPermission: "workspace_read",
    sideEffect: "read_only",
    timeoutMs: 15_000,
    async execute(_toolCallId, params) {
      const { intent, ...rest } = params as { intent?: string } & Record<string, unknown>;
      // 兼容模型输出中文意图标签（schema 注入展示中文）；映射回英文协议值路由。
      const protocolIntent = (intent && CHINESE_TO_INTENT_MAP[intent]) || intent;
      const toolName = protocolIntent ? INTENT_TO_TOOL[protocolIntent as QueryNarrativeIntent] : undefined;
      const tool = toolName ? byName.get(toolName) : undefined;
      if (!tool) {
        throw new Error(`query_narrative: 未知 intent "${String(intent)}" 或底层工具缺失 "${toolName}"`);
      }
      // 原样透传（intent 之外的所有参数直接交给底层工具），不复制任何检索/截断逻辑。
      return tool.execute(_toolCallId, rest ?? {}) as Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: NarrativeToolResultDetails;
      }>;
    },
  };
}