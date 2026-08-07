/**
 * NovelOS 9 个只读叙事工具实现（OPT-9.2 首批工具 + P0-1 新增跨源结构化检索）
 *
 * 所有工具：
 * - 只读（sideEffect="read_only"，requiredPermission="workspace_read"）
 * - 返回 NarrativeToolResultDetails（sourceRef + evidenceLevel）
 * - 使用 typebox Type.Object 定义 parameters schema
 * - 复用 NarrativeSearchService 访问数据（不直接读文件）
 *
 * 工具列表：
 * 0. search_narrative_evidence — 跨源结构化检索（canon/character/chapter_span 排序，P0-1 新增）
 * 1. search_chapter_span     — 在历史章节正文中搜索 span
 * 2. query_canon             — 查询 canon 事实（timeline/location/entity/ability_rule）
 * 3. query_character_state    — 查询角色状态（欲望/恐惧/关系/能力代价等）
 * 4. query_timeline           — 查询时间线事件
 * 5. query_character_knowledge_boundary — 查询角色知识边界（知道/不知道什么）
 * 6. query_promise_ledger     — 查询伏笔/承诺/读者期待
 * 7. query_pattern_memory     — 查询近期重复桥段/意象/句式风险
 * 8. query_voice_evidence     — 查询声音证据（M1 降级 profile_only）
 */

import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { ToolProtocol, NarrativeToolResultDetails } from "./tool-protocol.js";
import { makeNarrativeToolResult } from "./tool-protocol.js";
import type { NarrativeSearchService } from "../agent/narrative-search-service.js";

// ============================================================================
// 叙事工具白名单（Phase 2D 缺口一防御纵深 2026-08-07）
// ============================================================================

/**
 * 唯一允许进入 agent 工具注入的叙事工具名集合。
 *
 * 这是工具注入边界的权威白名单：`injectToolSchemas` 只接受该集合内的工具，
 * 集合外的工具（诊断/未来新增）一律 fail-closed 拒绝，防止"全量注入"绕过
 * 上游 evidencePlan.allowedTools 过滤。集合即工具注入层的最大合法规模，
 * 比"数量上限"更有意义（数量上限会因全量 9 个恰好通过而失效）。
 */
export const NARRATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_narrative_evidence",
  "search_chapter_span",
  "query_canon",
  "query_character_state",
  "query_timeline",
  "query_character_knowledge_boundary",
  "query_promise_ledger",
  "query_pattern_memory",
  "query_voice_evidence",
]);

/** 检索类工具子集（全部 9 个叙事工具都是只读检索/查询工具） */
export const RETRIEVAL_TOOL_NAMES: ReadonlySet<string> = NARRATIVE_TOOL_NAMES;

// ============================================================================
// 工具创建工厂：每个工具接收 searchService，返回 ToolProtocol
// ============================================================================

export interface ToolFactoryContext {
  searchService: NarrativeSearchService;
}

type ToolFactory = (ctx: ToolFactoryContext) => ToolProtocol<TSchema>;

/**
 * Models often emit a short multi-token query (for example "苏明 弟弟")
 * while the legacy index stores each fact as a natural-language sentence.
 * Keep the exact query as the first choice, then recover evidence by querying
 * meaningful whitespace/punctuation-delimited tokens and de-duplicating refs.
 */
function searchNarrativeEvidenceWithTokenFallback(
  searchService: NarrativeSearchService,
  query: string,
  maxResults: number,
): ReturnType<NarrativeSearchService["searchRanked"]> {
  const exact = searchService.searchRanked(query, { maxResults });
  if (exact.length > 0) return exact;

  const tokens = [...new Set(
    query
      .split(/[\s,，、;；:：/|]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  )];
  if (tokens.length < 2) return [];

  const merged = new Map<string, (typeof exact)[number]>();
  for (const token of tokens) {
    for (const evidence of searchService.searchRanked(token, { maxResults })) {
      const key = `${evidence.sourceRef}\u0000${evidence.excerpt}`;
      if (!merged.has(key)) merged.set(key, evidence);
    }
  }
  return [...merged.values()].slice(0, maxResults);
}

// ============================================================================
// 0. search_narrative_evidence（跨源结构化检索，P0-1 新增）
// ============================================================================

const searchNarrativeEvidenceFactory: ToolFactory = (ctx) => ({
  name: "search_narrative_evidence",
  description:
    "跨源结构化检索：同时搜索 canon 事实、角色状态和历史章节正文 span，按证据等级排序返回。" +
    "排序优先级：confirmed_state > exact_chapter_span > confirmed > inferred > profile_only。" +
    "优先使用此工具获取结构化事实证据，再用 search_chapter_span 查证具体原文。",
  label: "Search Narrative Evidence (Ranked)",
  parameters: Type.Object({
    query: Type.String({ description: "搜索关键词或短语" }),
    maxResults: Type.Optional(
      Type.Number({ description: "最大返回数（默认 10）", default: 10 }),
    ),
  }),
  requiredPermission: "workspace_read",
  sideEffect: "read_only",
  timeoutMs: 15_000,
  async execute(_toolCallId, params) {
    const { query, maxResults } = params as { query: string; maxResults?: number };
    const evidences = searchNarrativeEvidenceWithTokenFallback(
      ctx.searchService,
      query,
      maxResults ?? 10,
    );
    if (evidences.length === 0) {
      return makeNarrativeToolResult(
        `未找到与 "${query}" 相关的结构化证据。`,
        { sourceRef: "ranked:no-match", evidenceLevel: "inferred", query },
      );
    }
    const lines = evidences.map(
      (e, i) =>
        `[${i + 1}] (${e.evidenceLevel}, score=${e.relevanceScore.toFixed(2)}, origin=${e.origin})\n` +
        `  ${e.sourceRef}\n  ${e.excerpt.replace(/\n/g, " ")}`,
    );
    return makeNarrativeToolResult(
      `找到 ${evidences.length} 条排序证据：\n${lines.join("\n")}`,
      {
        sourceRef: evidences[0].sourceRef,
        evidenceLevel: evidences[0].evidenceLevel,
        query,
        rankedEvidences: evidences,
      },
    );
  },
});

// ============================================================================
// 1. search_chapter_span
// ============================================================================

const searchChapterSpanFactory: ToolFactory = (ctx) => ({
  name: "search_chapter_span",
  description:
    "在历史章节正文中搜索包含指定关键词/短语的原文 span。返回匹配片段、章节定位与 sourceRef。用于查证某个事实/细节是否在已发布章节中出现过。",
  label: "Search Chapter Span",
  parameters: Type.Object({
    query: Type.String({ description: "搜索关键词或短语" }),
    maxChapters: Type.Optional(
      Type.Number({ description: "搜索最近多少章（默认 10）", default: 10 }),
    ),
    maxResults: Type.Optional(
      Type.Number({ description: "最大返回数（默认 10）", default: 10 }),
    ),
  }),
  requiredPermission: "workspace_read",
  sideEffect: "read_only",
  timeoutMs: 15_000,
  async execute(_toolCallId, params) {
    const { query, maxChapters, maxResults } = params as {
      query: string;
      maxChapters?: number;
      maxResults?: number;
    };
    const spans = ctx.searchService.searchChapterSpan(
      query,
      maxChapters ?? 10,
      maxResults ?? 10,
    );
    if (spans.length === 0) {
      return makeNarrativeToolResult(
        `未在历史章节中找到包含 "${query}" 的原文。`,
        { sourceRef: "search:chapter_span:no-match", evidenceLevel: "inferred", query },
      );
    }
    const lines = spans.map(
      (s) =>
        `[${s.chapterId}] ${s.sourceRef}\n  ...${s.excerpt.replace(/\n/g, " ")}...`,
    );
    return makeNarrativeToolResult(
      `找到 ${spans.length} 处匹配：\n${lines.join("\n")}`,
      {
        sourceRef: spans[0].sourceRef,
        evidenceLevel: "confirmed",
        query,
        spans,
      },
    );
  },
});

// ============================================================================
// 2. query_canon
// ============================================================================

const queryCanonFactory: ToolFactory = (ctx) => ({
  name: "query_canon",
  description:
    "查询作品 canon 事实（世界设定、时间线、地点、实体、能力规则）。可按 category 过滤。返回事实描述与 sourceRef。",
  label: "Query Canon",
  parameters: Type.Object({
    category: Type.Optional(
      Type.Union([
        Type.Literal("timeline"),
        Type.Literal("location"),
        Type.Literal("entity"),
        Type.Literal("ability_rule"),
      ], { description: "过滤类别" }),
    ),
  }),
  requiredPermission: "workspace_read",
  sideEffect: "read_only",
  timeoutMs: 10_000,
  async execute(_toolCallId, params) {
    const { category } = params as { category?: string };
    const entries = ctx.searchService.queryCanon(category as any);
    if (entries.length === 0) {
      return makeNarrativeToolResult(
        `未找到 canon 事实${category ? `（category=${category}）` : ""}。`,
        { sourceRef: "canon:empty", evidenceLevel: "inferred", category },
      );
    }
    const lines = entries.map(
      (e) => `[${e.category}] ${e.fact} (来源: ${e.sourceRef}, 置信度: ${e.confidence})`,
    );
    return makeNarrativeToolResult(
      `找到 ${entries.length} 条 canon 事实：\n${lines.join("\n")}`,
      {
        sourceRef: entries[0].sourceRef,
        evidenceLevel: "confirmed",
        category,
        entries,
      },
    );
  },
});

// ============================================================================
// 3. query_character_state
// ============================================================================

const queryCharacterStateFactory: ToolFactory = (ctx) => ({
  name: "query_character_state",
  description:
    "查询角色状态（欲望、恐惧、关系、能力代价、未完成选择等）。按 characterId 过滤。返回状态字段、值与 sourceRef。",
  label: "Query Character State",
  parameters: Type.Object({
    characterId: Type.Optional(
      Type.String({ description: "角色 ID/名称（不填则返回全部角色）" }),
    ),
  }),
  requiredPermission: "workspace_read",
  sideEffect: "read_only",
  timeoutMs: 10_000,
  async execute(_toolCallId, params) {
    const { characterId } = params as { characterId?: string };
    const entries = ctx.searchService.queryCharacterState(characterId);
    if (entries.length === 0) {
      return makeNarrativeToolResult(
        `未找到角色状态${characterId ? `（characterId=${characterId}）` : ""}。`,
        { sourceRef: "character:empty", evidenceLevel: "inferred", characterId },
      );
    }
    const lines = entries.map(
      (e) => `[${e.characterId}] ${e.field}: ${e.value} (来源: ${e.sourceRef})`,
    );
    return makeNarrativeToolResult(
      `找到 ${entries.length} 条角色状态：\n${lines.join("\n")}`,
      {
        sourceRef: entries[0].sourceRef,
        evidenceLevel: "confirmed",
        characterId,
        entries,
      },
    );
  },
});

// ============================================================================
// 4. query_timeline
// ============================================================================

const queryTimelineFactory: ToolFactory = (ctx) => ({
  name: "query_timeline",
  description:
    "查询时间线事件（canon category=timeline）。返回事件序列与 sourceRef，用于检查时间顺序连续性。",
  label: "Query Timeline",
  parameters: Type.Object({}),
  requiredPermission: "workspace_read",
  sideEffect: "read_only",
  timeoutMs: 10_000,
  async execute() {
    const entries = ctx.searchService.queryTimeline();
    if (entries.length === 0) {
      return makeNarrativeToolResult(
        "未找到时间线事件。",
        { sourceRef: "timeline:empty", evidenceLevel: "inferred" },
      );
    }
    const lines = entries.map(
      (e) => `${e.fact} (来源: ${e.sourceRef}, 章节: ${e.sourceChapter})`,
    );
    return makeNarrativeToolResult(
      `找到 ${entries.length} 条时间线事件：\n${lines.join("\n")}`,
      {
        sourceRef: entries[0].sourceRef,
        evidenceLevel: "confirmed",
        entries,
      },
    );
  },
});

// ============================================================================
// 5. query_character_knowledge_boundary
// ============================================================================

const queryCharacterKnowledgeBoundaryFactory: ToolFactory = (ctx) => ({
  name: "query_character_knowledge_boundary",
  description:
    "查询角色知识边界——某个角色当前知道/不知道什么。用于防止角色说出他们不应该知道的信息。返回知识边界条目与 sourceRef。",
  label: "Query Character Knowledge Boundary",
  parameters: Type.Object({
    characterId: Type.Optional(
      Type.String({ description: "角色 ID/名称（不填则返回全部角色）" }),
    ),
  }),
  requiredPermission: "workspace_read",
  sideEffect: "read_only",
  timeoutMs: 10_000,
  async execute(_toolCallId, params) {
    const { characterId } = params as { characterId?: string };
    const entries = ctx.searchService.queryCharacterKnowledgeBoundary(characterId);
    if (entries.length === 0) {
      return makeNarrativeToolResult(
        `未找到角色知识边界${characterId ? `（characterId=${characterId}）` : ""}。可能 legacy 状态未记录知识边界字段。`,
        { sourceRef: "knowledge_boundary:empty", evidenceLevel: "inferred", characterId },
      );
    }
    const lines = entries.map(
      (e) => `[${e.characterId}] ${e.field}: ${e.value} (来源: ${e.sourceRef})`,
    );
    return makeNarrativeToolResult(
      `找到 ${entries.length} 条知识边界：\n${lines.join("\n")}`,
      {
        sourceRef: entries[0].sourceRef,
        evidenceLevel: "confirmed",
        characterId,
        entries,
      },
    );
  },
});

// ============================================================================
// 6. query_promise_ledger
// ============================================================================

const queryPromiseLedgerFactory: ToolFactory = (ctx) => ({
  name: "query_promise_ledger",
  description:
    "查询伏笔/承诺/读者期待（PromiseLedger）。可按 status 过滤（open/advancing/fulfilled/broken）。返回承诺描述、当前热度与 sourceRef。",
  label: "Query Promise Ledger",
  parameters: Type.Object({
    status: Type.Optional(
      Type.Union([
        Type.Literal("open"),
        Type.Literal("advancing"),
        Type.Literal("fulfilled"),
        Type.Literal("broken"),
      ], { description: "过滤状态" }),
    ),
  }),
  requiredPermission: "workspace_read",
  sideEffect: "read_only",
  timeoutMs: 10_000,
  async execute(_toolCallId, params) {
    const { status } = params as { status?: string };
    const entries = ctx.searchService.queryPromiseLedger(status as any);
    if (entries.length === 0) {
      return makeNarrativeToolResult(
        `未找到 promise 条目${status ? `（status=${status}）` : ""}。`,
        { sourceRef: "promise:empty", evidenceLevel: "inferred", status },
      );
    }
    const lines = entries.map(
      (e) => `[${e.status}] ${e.description} (热度: ${e.currentHeat}, 来源: ${e.sourceRef})`,
    );
    return makeNarrativeToolResult(
      `找到 ${entries.length} 条 promise：\n${lines.join("\n")}`,
      {
        sourceRef: entries[0].sourceRef,
        evidenceLevel: "confirmed",
        status,
        entries,
      },
    );
  },
});

// ============================================================================
// 7. query_pattern_memory
// ============================================================================

const queryPatternMemoryFactory: ToolFactory = (ctx) => ({
  name: "query_pattern_memory",
  description:
    "查询近期重复桥段/意象/句式风险/冲突解决方式/章末钩子类型（PatternMemory）。可按 patternType 过滤。用于避免重复与检测退化模式。",
  label: "Query Pattern Memory",
  parameters: Type.Object({
    patternType: Type.Optional(
      Type.Union([
        Type.Literal("trope"),
        Type.Literal("imagery"),
        Type.Literal("sentence_risk"),
        Type.Literal("conflict_resolution"),
        Type.Literal("hook_type"),
      ], { description: "过滤模式类型" }),
    ),
  }),
  requiredPermission: "workspace_read",
  sideEffect: "read_only",
  timeoutMs: 10_000,
  async execute(_toolCallId, params) {
    const { patternType } = params as { patternType?: string };
    const entries = ctx.searchService.queryPatternMemory(patternType as any);
    if (entries.length === 0) {
      return makeNarrativeToolResult(
        `未找到 pattern 条目${patternType ? `（patternType=${patternType}）` : ""}。legacy 状态无直接对应的 pattern memory，Phase 6 在线学习填充。`,
        { sourceRef: "pattern:empty", evidenceLevel: "inferred", patternType },
      );
    }
    const lines = entries.map(
      (e) => `[${e.patternType}] ${e.description} (出现 ${e.occurrenceCount} 次, 来源: ${e.sourceRef})`,
    );
    return makeNarrativeToolResult(
      `找到 ${entries.length} 条 pattern：\n${lines.join("\n")}`,
      {
        sourceRef: entries[0].sourceRef,
        evidenceLevel: "confirmed",
        patternType,
        entries,
      },
    );
  },
});

// ============================================================================
// 8. query_voice_evidence（M1 降级 profile_only）
// ============================================================================

const queryVoiceEvidenceFactory: ToolFactory = (_ctx) => ({
  name: "query_voice_evidence",
  description:
    "查询角色/叙述声音证据（voice evidence）。M1 无 Voice Foundation，降级为 profile_only 证据等级。不冒充确定事实。用于获取风格档案中的声音参考。",
  label: "Query Voice Evidence (Degraded)",
  parameters: Type.Object({
    characterId: Type.Optional(
      Type.String({ description: "角色 ID/名称" }),
    ),
  }),
  requiredPermission: "workspace_read",
  sideEffect: "read_only",
  timeoutMs: 5_000,
  async execute(_toolCallId, params) {
    const { characterId } = params as { characterId?: string };
    // M1 降级：无 Voice Foundation，返回 profile_only 证据
    return makeNarrativeToolResult(
      `声音证据降级（M1 无 Voice Foundation）：${
        characterId ? `角色 ${characterId} 的` : ""
      }声音特征仅来自风格档案，无正文 span 证据。请勿将此结果当作确定事实使用。`,
      {
        sourceRef: "voice:profile_only:degraded",
        evidenceLevel: "profile_only",
        characterId,
        degradedReason: "M1 无 Voice Foundation",
      },
    );
  },
});

// ============================================================================
// 工具注册表
// ============================================================================

export const NARRATIVE_TOOL_FACTORIES: ToolFactory[] = [
  searchNarrativeEvidenceFactory,
  searchChapterSpanFactory,
  queryCanonFactory,
  queryCharacterStateFactory,
  queryTimelineFactory,
  queryCharacterKnowledgeBoundaryFactory,
  queryPromiseLedgerFactory,
  queryPatternMemoryFactory,
  queryVoiceEvidenceFactory,
];

/**
 * 创建全部 9 个叙事工具（接收 NarrativeSearchService）。
 */
export function createNarrativeTools(
  ctx: ToolFactoryContext,
): ToolProtocol<TSchema>[] {
  return NARRATIVE_TOOL_FACTORIES.map((f) => f(ctx));
}
