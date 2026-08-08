/**
 * NovelOS Phase 5 — query_narrative_production（受控生产接入 runtime facade）
 *
 * 受控生产接入（Phase 5）：把 9 个专用叙事工具包成 1 个类型化统一入口的 **runtime 变体**，
 * 仅在 canary workspace 显式 opt-in（toolMode="facade"）时注入；默认生产仍用 9 专用工具
 * （非全量切换）。这是"guided facade vs 9 工具"的受控对照，不推广为"任意单入口 facade 更优"。
 *
 * 与 eval-only 的 query_narrative（novelos/eval/typed-facade-tool.ts）的关系：
 * - 本模块是 **runtime** 版，进入生产闭包（tsconfig.prod.json），工具名为
 *   `query_narrative_production`，与 eval 的 `query_narrative` 区分，避免把 eval-only 代码
 *   拉进 dist/（依赖边界铁律：生产不 import eval 模块）。
 * - 二者共享同一 intent 语义（QUERY_NARRATIVE_PRODUCTION_INTENTS / INTENT_TO_TOOL /
 *   CHINESE_TO_INTENT_MAP / INTENT_USAGE 均为纯数据常量，仅路由映射，无逻辑复制）。
 * - **零逻辑复制**：内部调用 createNarrativeTools 产出的既有 9 个工具对象，按 intent 路由
 *   后调用其 execute()，**原样透传** NarrativeToolResultDetails（sourceRef / evidenceLevel /
 *   resultKind / truncated / nextQueryHint）。检索、token fallback、limit 截断、nextQueryHint
 *   生成全部由底层工具完成。
 *
 * 受控接入边界：
 * - 本工具不进入 createNarrativeTools（9 专用工具集合），只在 registry `enableFacade=true`
 *   时注册（见 narrative-tool-registry.ts），且仅当 evidencePlan.allowedTools 显式含本工具名
 *   时才会被注入（agentic-raw-candidate-source.ts 的 tools 过滤）。
 * - runtime 注入白名单（fail-closed）在 facade 模式下使用 NARRATIVE_TOOL_NAMES_WITH_FACADE，
 *   默认生产仍为 NARRATIVE_TOOL_NAMES（9 工具），行为不变。
 */

import { Type } from "typebox";
import type { ToolProtocol, NarrativeToolResultDetails } from "./tool-protocol.js";
import { createNarrativeTools, QUERY_NARRATIVE_PRODUCTION_NAME } from "./narrative-tools.js";
import type { NarrativeSearchService } from "../agent/narrative-search-service.js";

// QUERY_NARRATIVE_PRODUCTION_NAME 单一来源见 narrative-tools.ts（避免环形依赖），
// 本模块只 re-export，不再各自定义。

/** 9 个意图（与底层 9 个专用工具一一对应） */
export type QueryNarrativeProductionIntent =
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
export const INTENT_TO_TOOL: Record<QueryNarrativeProductionIntent, string> = {
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

/** 全部意图列表（用于 schema 联合） */
export const QUERY_NARRATIVE_PRODUCTION_INTENTS: QueryNarrativeProductionIntent[] = [
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

/** 英文意图 → 中文标签（模型可见，供 schema 注入） */
export const INTENT_CHINESE_LABEL: Record<QueryNarrativeProductionIntent, string> = {
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
export const CHINESE_TO_INTENT_MAP: Record<string, QueryNarrativeProductionIntent> = (() => {
  const m: Record<string, QueryNarrativeProductionIntent> = {};
  for (const [intent, label] of Object.entries(INTENT_CHINESE_LABEL)) {
    m[label] = intent as QueryNarrativeProductionIntent;
  }
  return m;
})();

/**
 * 每个意图的使用说明：何时使用 + 优先级 + 查询构造要点（一行式，尽量紧凑）。
 *
 * 与 eval facade 的 INTENT_USAGE 语义一致：事实核验优先使用 evidence；查询构造要点
 * 帮助模型在统一入口下做出更准的路由决策，避免在 9 个窄工具 schema 间盲目切换。
 */
export const INTENT_USAGE: Record<QueryNarrativeProductionIntent, string> = {
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

/** 拼接单个意图的「何时使用 + 优先级」说明 */
export function describeIntentUsage(intent: QueryNarrativeProductionIntent): string {
  const label = INTENT_CHINESE_LABEL[intent];
  return `${label}：${INTENT_USAGE[intent]}`;
}

/** 全部意图的「何时使用 + 优先级」说明（仅用于工具 description，不重复注入参数 schema） */
export const QUERY_NARRATIVE_PRODUCTION_INTENT_GUIDANCE: string =
  QUERY_NARRATIVE_PRODUCTION_INTENTS
    .map((i) => `- ${describeIntentUsage(i)}`)
    .join("\n");

/**
 * 创建 facade runtime 变体工具。
 *
 * facade 本身不持有检索逻辑：它在内部用 createNarrativeTools 构造 9 个底层工具，
 * execute 时按 intent 取出对应底层工具并调用其 execute()，把（intent 之外的）参数原样
 * 透传。返回的 details 与底层工具完全一致。
 *
 * @param ctx 需提供 searchService（与 createNarrativeTools 相同契约）
 */
export function createQueryNarrativeProductionFacadeTool(ctx: {
  searchService: NarrativeSearchService;
}): ToolProtocol {
  const underlyingTools = createNarrativeTools({ searchService: ctx.searchService });
  const byName = new Map(underlyingTools.map((t) => [t.name, t]));

  return {
    name: QUERY_NARRATIVE_PRODUCTION_NAME,
    description:
      "统一叙事查询入口：按查询意图路由到对应的叙事专用工具。" +
      "事实核验类查询**优先使用「跨源证据检索」意图**；返回的结果带来源引用与证据等级。\n" +
      `各意图「何时使用/优先级」：\n${QUERY_NARRATIVE_PRODUCTION_INTENT_GUIDANCE}\n` +
      "查询构造：evidence/chapter_span 的 query 复用待验证事实原文短语（检索按子串匹配）；" +
      "canon 意图传 category 返回该类全部事实。证据充分后立即输出终止标记，每回合只查一个事实。",
    label: "Query Narrative (Production Facade)",
    parameters: Type.Object({
      intent: Type.Union(
        QUERY_NARRATIVE_PRODUCTION_INTENTS.map((i) => Type.Literal(i)),
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
      const toolName = protocolIntent
        ? INTENT_TO_TOOL[protocolIntent as QueryNarrativeProductionIntent]
        : undefined;
      const tool = toolName ? byName.get(toolName) : undefined;
      if (!tool) {
        throw new Error(
          `${QUERY_NARRATIVE_PRODUCTION_NAME}: 未知 intent "${String(intent)}" 或底层工具缺失 "${toolName}"`,
        );
      }
      // 原样透传（intent 之外的所有参数直接交给底层工具），不复制任何检索/截断逻辑。
      return tool.execute(_toolCallId, rest ?? {}) as Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: NarrativeToolResultDetails;
      }>;
    },
  };
}