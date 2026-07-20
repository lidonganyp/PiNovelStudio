/**
 * PiNovelStudio — ChapterSeed 类型定义
 *
 * P22：细节锚点先行生成链路
 *
 * 写前输入统一为 ChapterSeed 种子包 + 感知锚点。
 * 旧章纲（series/outline.md / ch{X}-outline-explicit.md）只可作为
 * 高层背景/主题/不可违背事实参考，不再作为生成前置条件，也不能被
 * 编译为事件蓝图。
 *
 * ChapterSeed 由 ChapterSeedBuilder 从以下种子源构造：
 *  - config.json（世界观、类型、角色列表、字数预算）
 *  - 角色档案（characters/*.md）
 *  - 前章 skeleton.json（第 1 章例外）
 *  - narrative-state.json
 *  - detail ledger / unsettled-details.json
 *  - foreshadowing / closure tracker（arc-registry.json）
 *  - 可选 series/outline.md 高层方向（仅作为背景参考）
 */

import { Type, Static } from "@sinclair/typebox";

// ============================================================================
// ChapterSeed 核心类型
// ============================================================================

/** 角色状态摘要（来自 narrative-state.json / 角色档案） */
export const CharacterStateSummarySchema = Type.Object({
  name: Type.String({ description: "角色名" }),
  role: Type.Optional(Type.String({ description: "角色定位：protagonist/antagonist/supporting" })),
  mentality: Type.Optional(Type.String({ description: "当前心智状态描述" })),
  recentAction: Type.Optional(Type.String({ description: "最近一次行动/登场动作" })),
  pendingTension: Type.Optional(Type.String({ description: "未解决张力" })),
  aliases: Type.Optional(Type.Array(Type.String())),
});
export type CharacterStateSummary = Static<typeof CharacterStateSummarySchema>;

/** 前章承接摘要（来自前章 skeleton.json） */
export const PreviousChapterContinuationSchema = Type.Object({
  available: Type.Boolean({ description: "是否存在前章 skeleton" }),
  lastEventId: Type.Optional(Type.String()),
  lastEventSummary: Type.Optional(Type.String()),
  endingEmotion: Type.Optional(Type.String()),
  openHooks: Type.Array(Type.String(), { default: [] }),
  introducedCharacters: Type.Array(Type.String(), { default: [] }),
  unresolvedTensions: Type.Array(Type.String(), { default: [] }),
  sourceIds: Type.Optional(Type.Array(Type.String())),
});
export type PreviousChapterContinuation = Static<typeof PreviousChapterContinuationSchema>;

/** 当前压力摘要（来自 narrative-state.json + arc-registry.json） */
export const CurrentPressureSchema = Type.Object({
  pendingForeshadowing: Type.Array(
    Type.Object({
      id: Type.String(),
      description: Type.String(),
      level: Type.Optional(Type.String()),
    }),
    { default: [] }
  ),
  openArcs: Type.Array(
    Type.Object({
      arcId: Type.String(),
      name: Type.String(),
      priority: Type.Optional(Type.String()),
      coreQuestion: Type.Optional(Type.String()),
    }),
    { default: [] }
  ),
  pendingCosts: Type.Array(
    Type.Object({
      action: Type.String(),
      cost: Type.String(),
      chapterIncurred: Type.Optional(Type.Number()),
    }),
    { default: [] }
  ),
  readerExpectation: Type.Optional(
    Type.Object({
      unresolvedCount: Type.Number(),
      chaptersSinceLastPeak: Type.Number(),
    })
  ),
});
export type CurrentPressure = Static<typeof CurrentPressureSchema>;

/** 未结账细节摘要（来自 unsettled-details.json） */
export const UnsettledDetailSummarySchema = Type.Object({
  id: Type.String(),
  type: Type.String(),
  description: Type.String(),
  chapterId: Type.String(),
});
export type UnsettledDetailSummary = Static<typeof UnsettledDetailSummarySchema>;

/** 世界约束摘要（来自 config.json + power-system.md 等） */
export const WorldConstraintSummarySchema = Type.Object({
  genre: Type.String(),
  subGenres: Type.Array(Type.String(), { default: [] }),
  powerSystem: Type.Optional(Type.String()),
  immutableFacts: Type.Array(Type.String(), { default: [] }),
});
export type WorldConstraintSummary = Static<typeof WorldConstraintSummarySchema>;

/** 候选感知锚点（来自前章 skeleton + 当前压力 + 角色状态） */
export const CandidateAnchorSchema = Type.Object({
  id: Type.String(),
  description: Type.String(),
  channel: Type.Optional(
    Type.Union([
      Type.Literal("visual"),
      Type.Literal("auditory"),
      Type.Literal("tactile"),
      Type.Literal("olfactory"),
      Type.Literal("gustatory"),
      Type.Literal("cognitive"),
      Type.Literal("emotional"),
    ])
  ),
  weight: Type.Number({ minimum: 0, maximum: 1 }),
  source: Type.Optional(
    Type.Union([
      Type.Literal("previousSkeleton"),
      Type.Literal("pendingForeshadowing"),
      Type.Literal("characterState"),
      Type.Literal("unsettledDetail"),
      Type.Literal("worldConstraint"),
      Type.Literal("explicitOutline"),
    ])
  ),
});
export type CandidateAnchor = Static<typeof CandidateAnchorSchema>;

/** 高层方向（可选，来自 series/outline.md） */
export const HighLevelDirectionSchema = Type.Object({
  available: Type.Boolean(),
  /** 仅作为背景/主题/不可违背事实参考，不能被编译为事件蓝图 */
  backgroundNotes: Type.Array(Type.String(), { default: [] }),
  /** 章节主题提示（可选，非约束） */
  chapterThemeHint: Type.Optional(Type.String()),
  /** 不可违背事实列表 */
  immutableFacts: Type.Array(Type.String(), { default: [] }),
});
export type HighLevelDirection = Static<typeof HighLevelDirectionSchema>;

/** 章节意图（替代旧 outlineIntent 的写前来源） */
export const ChapterIntentSchema = Type.Object({
  primary: Type.String({ description: "主要意图：foreshadow/character/reversal/romance/setting/combat" }),
  secondary: Type.Array(Type.String()),
  keywords: Type.Array(Type.String()),
  chapterTheme: Type.String(),
  targetEmotions: Type.Array(Type.String()),
  /**
   * P22新增：标记 outlineIntent 的来源
   * - "chapterSeed"：来自 ChapterSeed（新链路）
   * - "outline"：来自旧章纲（仅归档参考用，主链路不再产生）
   */
  _source: Type.Literal("chapterSeed"),
});
export type ChapterIntent = Static<typeof ChapterIntentSchema>;

/** ChapterSeed 主类型 */
export const ChapterSeedSchema = Type.Object({
  workspaceId: Type.String(),
  chapterId: Type.String(),
  chapterNumber: Type.Number(),
  /** 章节功能类型 */
  chapterFunction: Type.Union([
    Type.Literal("setup"),
    Type.Literal("escalation"),
    Type.Literal("payoff"),
    Type.Literal("climax"),
  ]),
  /** 世界约束摘要 */
  worldConstraint: WorldConstraintSummarySchema,
  /** 角色状态摘要列表 */
  characters: Type.Array(CharacterStateSummarySchema, { default: [] }),
  /** 前章承接（第 1 章 available=false） */
  previousChapterContinuation: PreviousChapterContinuationSchema,
  /** 当前压力 */
  currentPressure: CurrentPressureSchema,
  /** 未结账细节 */
  unsettledDetails: Type.Array(UnsettledDetailSummarySchema, { default: [] }),
  /** 候选感知锚点 */
  candidateAnchors: Type.Array(CandidateAnchorSchema, { default: [] }),
  /**
   * [FIX D 2026-06-25] 显式章纲事件角色列表。
   * 来自 series/ch{N}-outline-explicit.md 每个事件块下的"参与角色：a、b、c"行。
   * 这是章纲作者为每个事件显式声明的出场角色，质量远高于
   * extractEventCharactersFromSeed 的"按事件索引切片全章角色"fallback。
   * 不解析事件蓝图，仅解析角色名单，不违反 P22 "章纲不作为事件蓝图" 约束。
   */
  explicitEventCharacters: Type.Optional(
    Type.Array(
      Type.Object({
        eventIndex: Type.Number({ minimum: 1 }),
        characters: Type.Array(Type.String(), { default: [] }),
      }),
      { default: [] }
    )
  ),
  /** 高层方向（可选，仅背景参考） */
  highLevelDirection: HighLevelDirectionSchema,
  /** 章节意图（替代旧 outlineIntent 的写前来源） */
  intent: ChapterIntentSchema,
  /** 字数预算 */
  wordCountTarget: Type.Optional(
    Type.Object({
      min: Type.Number({ minimum: 0 }),
      max: Type.Number({ minimum: 0 }),
    })
  ),
  /** 构建元数据 */
  builtAt: Type.String(),
});
export type ChapterSeed = Static<typeof ChapterSeedSchema>;

// ============================================================================
// SeedReadinessReport 类型
// ============================================================================

export type SeedReadinessStatus = "ready" | "warning" | "blocked";

export interface SeedReadinessDimensionReport {
  /** 维度名：worldConstraint / characterState / previousContinuation / currentPressure / candidateAnchors */
  dimension: string;
  /** 是否充足 */
  sufficient: boolean;
  /** 当前观测值摘要 */
  observed: string[];
  /** 缺失项 */
  missing: string[];
  /** 修复建议（不得要求"补章纲"） */
  suggestions: string[];
}

export interface SeedReadinessReport {
  status: SeedReadinessStatus;
  /** 综合评分 0-100 */
  score: number;
  /** 是否阻断生成 */
  shouldBlockGeneration: boolean;
  /** 维度报告 */
  dimensions: SeedReadinessDimensionReport[];
  /** 警告（不阻断） */
  warnings: string[];
  /** 阻断原因（阻断时填） */
  blockingReasons: string[];
  /** 来源标识 */
  source: "chapterSeed";
}
