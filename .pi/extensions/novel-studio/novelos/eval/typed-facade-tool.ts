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
      "统一叙事查询入口：按类型化 intent 路由到对应的叙事专用工具。" +
      "intent 决定查询领域：evidence（跨源结构化检索）/ chapter_span（历史章节原文 span）/ " +
      "canon（世界设定事实）/ character_state（角色状态）/ timeline（时间线）/ " +
      "knowledge_boundary（角色知识边界）/ promise（伏笔与读者期待）/ pattern（重复桥段风险）/ " +
      "voice（声音证据）。返回的结果带 sourceRef 与 evidenceLevel。",
    label: "Query Narrative (Typed Facade)",
    parameters: Type.Object({
      intent: Type.Union(
        QUERY_NARRATIVE_INTENTS.map((i) => Type.Literal(i)),
        { description: "查询意图（决定路由到哪个专用工具）" },
      ),
      query: Type.Optional(Type.String({ description: "搜索关键词/短语（evidence / chapter_span 意图使用）" })),
      category: Type.Optional(Type.String({ description: "canon 过滤类别：timeline/location/entity/ability_rule" })),
      characterId: Type.Optional(Type.String({ description: "角色 ID/名称（character_state / knowledge_boundary / voice 意图使用）" })),
      status: Type.Optional(Type.String({ description: "promise 过滤状态：open/advancing/fulfilled/broken" })),
      patternType: Type.Optional(Type.String({ description: "pattern 过滤类型：trope/imagery/sentence_risk/conflict_resolution/hook_type" })),
      maxResults: Type.Optional(Type.Number({ description: "最大返回数（搜索类意图）", default: 10 })),
      maxChapters: Type.Optional(Type.Number({ description: "搜索最近多少章（chapter_span 意图）", default: 10 })),
    }),
    requiredPermission: "workspace_read",
    sideEffect: "read_only",
    timeoutMs: 15_000,
    async execute(_toolCallId, params) {
      const { intent, ...rest } = params as { intent: QueryNarrativeIntent } & Record<string, unknown>;
      const toolName = INTENT_TO_TOOL[intent];
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