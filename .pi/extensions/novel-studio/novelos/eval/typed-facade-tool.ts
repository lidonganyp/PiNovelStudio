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
import { renderCompactEnvelope } from "../tools/tool-protocol.js";
import {
  createNarrativeTools,
  CANON_CATEGORY_VALUES,
  PROMISE_STATUS_VALUES,
  PATTERN_TYPE_VALUES,
} from "../tools/narrative-tools.js";
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
  "chapter_span",
  "canon",
  "character_state",
  "evidence",
  "timeline",
  "knowledge_boundary",
  "promise",
  "pattern",
  "voice",
];

/**
 * Phase 5.3.2 消融：旧版意图顺序（evidence 在首位，标记为"默认首选"）。
 * 通过 PINOVEL_FACADE_GUIDANCE_VARIANT=old 切换。
 */
const QUERY_NARRATIVE_INTENTS_OLD: QueryNarrativeIntent[] = [
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
 * 每个意图的使用说明：何时使用 + 优先级 + 查询构造要点（一行式，尽可能紧凑）。
 *
 * Phase 4.2.2：给 facade intent 明确的「何时使用、优先级、查询构造」语义，
 * 尤其明确**事实核验优先使用 evidence**，并给出查询构造指引，帮助模型在统一入口下
 * 做出更准的路由决策，避免在 9 个窄工具 schema 间或意图之间盲目切换
 * （诊断 SC1-canon 的 canon:empty / ranked:no-match 降级）。
 *
 * 查询构造要点（检索按子串匹配事实）：
 * - evidence / chapter_span 的 query 尽量**复用待验证事实的原文短语**，不随意改写/删字，
 *   否则子串匹配失败 → no-match / empty。
 * - canon 意图传 `category`（timeline/location/entity/ability_rule）即可返回该类别全部
 *   事实，**无需精确 query**，比构造易失配的长短语更稳（对齐 A 组 query_canon 的稳健用法）。
 *
 * 设计约束：本说明只注入**工具 description 一处**（INTENT_USAGE 不进 intent 参数
 * schema，避免重复膨胀 B 组 schema token 反超 A 组，破坏"facade 降低上下文负担"门禁）。
 * 各意图参数（query/characterId/category/...）已在 parameters schema 中声明，此处不重复。
 */
export const INTENT_USAGE: Record<QueryNarrativeIntent, string> = {
  evidence: "跨源检索（无法确定具体来源时使用）；query 复用待验证事实原文短语",
  chapter_span: "章节原文措辞/前后文核验（查询章节内文时首选）；query 复用原文短语",
  canon: "世界设定/既定事实核验（查询世界设定时首选）；传 category 返回该类别全部事实，无需精确短语",
  character_state: "角色当前状态/经历/情感（中优先级）",
  timeline: "事件先后顺序/时间点核验（中优先级）",
  knowledge_boundary: "角色知道什么/不该知道什么（中优先级）",
  promise: "伏笔/承诺建立与兑现状态（中优先级）",
  pattern: "叙事模式/桥段/意象用法（低优先级，非硬事实）",
  voice: "角色声音/说话习惯证据（低优先级）",
};

/**
 * Phase 5.3.2 消融：旧版 INTENT_USAGE（evidence 为"默认首选，最高优先级"）。
 */
const INTENT_USAGE_OLD: Record<QueryNarrativeIntent, string> = {
  evidence: "核心事实跨源核验（默认首选，最高优先级）；query 复用待验证事实原文短语",
  chapter_span: "查看章节原文措辞/前后文（中优先级）；query 复用原文短语",
  canon: "世界设定/既定事实核验（高优先级）；传 category 返回该类别全部事实，无需精确短语",
  character_state: "角色当前状态/经历/情感（中优先级）",
  timeline: "事件先后顺序/时间点核验（中优先级）",
  knowledge_boundary: "角色知道什么/不该知道什么（中优先级）",
  promise: "伏笔/承诺建立与兑现状态（中优先级）",
  pattern: "叙事模式/桥段/意象用法（低优先级，非硬事实）",
  voice: "角色声音/说话习惯证据（低优先级）",
};

/**
 * Phase 5.3.2 消融：按 PINOVEL_FACADE_GUIDANCE_VARIANT 选择引导变体。
 * - "old"：旧版（evidence 首位，"默认首选"）
 * - "new"（默认）：新版（chapter_span/canon 首位，evidence "无法确定具体来源时使用"）
 */
export function resolveGuidanceVariant(): {
  intents: QueryNarrativeIntent[];
  usage: Record<QueryNarrativeIntent, string>;
  variant: string;
} {
  const variant = process.env.PINOVEL_FACADE_GUIDANCE_VARIANT ?? "new";
  if (variant === "old") {
    return { intents: QUERY_NARRATIVE_INTENTS_OLD, usage: INTENT_USAGE_OLD, variant };
  }
  return { intents: QUERY_NARRATIVE_INTENTS, usage: INTENT_USAGE, variant };
}

/** 拼接单个意图的「何时使用 + 优先级」说明 */
export function describeIntentUsage(intent: QueryNarrativeIntent): string {
  const { usage } = resolveGuidanceVariant();
  const label = INTENT_CHINESE_LABEL[intent];
  return `${label}：${usage[intent]}`;
}

/** 全部意图的「何时使用 + 优先级」说明（仅用于工具 description，不重复注入参数 schema） */
export const QUERY_NARRATIVE_INTENT_GUIDANCE: string = resolveGuidanceVariant().intents.map(
  (i) => `- ${describeIntentUsage(i)}`,
).join("\n");

/**
 * 创建 B 组 typed facade 工具。
 *
 * facade 本身不持有检索逻辑：它在内部用 createNarrativeTools 构造 9 个底层工具，
 * execute 时按 intent 取出对应底层工具并调用其 execute()，把（intent 之外的）
 * 参数原样透传。返回的 details 与底层工具完全一致。
 *
 * @param ctx.searchService 与 createNarrativeTools 相同契约
 * @param ctx.includeIntentGuidance 是否在工具 description 注入「何时使用/优先级/查询构造」
 *   引导（INTENT_USAGE）。默认 true（受引导 facade，B 组）。B0 对照传 false 以解耦
 *   "单入口收益"（interface surface）与"描述引导收益"（intent guidance）：
 *   B0 仅含类型化 intent 联合，不含路由引导说明。
 * @param ctx.useCompactEnvelope 是否用紧凑结果 envelope 渲染模型可见 content（默认 false）。
 *   开启时只剪裁文本（renderCompactEnvelope），完整 details 原样保留。与 facade 路由正交。
 */
export function createTypedFacadeTool(ctx: {
  searchService: NarrativeSearchService;
  includeIntentGuidance?: boolean;
  useCompactEnvelope?: boolean;
  /** Phase 5.3.2 消融：显式指定引导变体，不依赖环境变量 */
  guidanceVariant?: "old" | "new";
}): ToolProtocol {
  const includeGuidance = ctx.includeIntentGuidance !== false;
  const useEnvelope = ctx.useCompactEnvelope === true;
  const variant = ctx.guidanceVariant ?? process.env.PINOVEL_FACADE_GUIDANCE_VARIANT ?? "new";
  const underlyingTools = createNarrativeTools({ searchService: ctx.searchService });
  const byName = new Map(underlyingTools.map((t) => [t.name, t]));

  // Phase 5.3.2：按 variant 解析引导文本和 intent 顺序
  const { intents, usage } = variant === "old"
    ? { intents: QUERY_NARRATIVE_INTENTS_OLD, usage: INTENT_USAGE_OLD }
    : { intents: QUERY_NARRATIVE_INTENTS, usage: INTENT_USAGE };
  const guidanceText = intents.map(
    (i) => `- ${INTENT_CHINESE_LABEL[i]}：${usage[i]}`,
  ).join("\n");

  const guidanceBlock = includeGuidance
    ? `\n各意图「何时使用/优先级」：\n${guidanceText}\n`
    : "\n";

  return {
    name: QUERY_NARRATIVE_NAME,
    description:
      "统一叙事查询入口：按查询意图路由到对应的叙事专用工具。" +
      "事实核验类查询优先使用「跨源证据检索」意图；返回结果带来源引用与证据等级。" +
      guidanceBlock +
      "查询构造：evidence/chapter_span 的 query 复用待验证事实原文短语；canon 意图传 category 返回该类全部事实。",
    label: "Query Narrative (Typed Facade)",
    parameters: Type.Object({
      intent: Type.Union(
        intents.map((i) => Type.Literal(i)),
        {
          description:
            "查询意图（决定路由到哪个专用工具）。事实核验优先选择「跨源证据检索」。各意图用法见工具说明。",
        },
      ),
      query: Type.Optional(Type.String({ description: "搜索关键词/短语（跨源证据检索、章节原文检索意图使用）" })),
      category: Type.Optional(
        Type.Union(
          CANON_CATEGORY_VALUES.map((v) => Type.Literal(v)),
          { description: "世界事实查询过滤类别（query_canon 同枚举）" },
        ),
      ),
      characterId: Type.Optional(Type.String({ description: "角色标识/名称（角色状态查询、知识边界查询、声音证据查询意图使用）" })),
      status: Type.Optional(
        Type.Union(
          PROMISE_STATUS_VALUES.map((v) => Type.Literal(v)),
          { description: "承诺账本查询过滤状态（query_promise_ledger 同枚举）" },
        ),
      ),
      patternType: Type.Optional(
        Type.Union(
          PATTERN_TYPE_VALUES.map((v) => Type.Literal(v)),
          { description: "叙事模式查询过滤类型（query_pattern_memory 同枚举）" },
        ),
      ),
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
      const result = await tool.execute(_toolCallId, rest ?? {}) as {
        content: Array<{ type: "text"; text: string }>;
        details: NarrativeToolResultDetails;
      };
      // 紧凑 envelope：仅重渲染模型可见 content 文本，details 原样保留。
      if (useEnvelope) {
        return {
          content: [{ type: "text", text: renderCompactEnvelope(result.details) }],
          details: result.details,
        };
      }
      return result;
    },
  };
}