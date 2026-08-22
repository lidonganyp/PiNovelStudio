/**
 * PiNovelStudio — ChapterSeed 类型定义
 *
 * 统一主链路：作者权威叙事契约优先
 *
 * ChapterSeed 负责把作者给出的整体方向、章节功能、事件内容、人物动机、
 * 伏笔、因果、状态变化和章末目标原样交给统一主链路。感知锚点仅保留为
 * 历史诊断数据，不是事实、生成前置条件或正文执行指令。
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

/** 角色档案中会影响选择、关系和连续性的叙事信息。 */
export const CharacterNarrativeProfileSchema = Type.Object({
  personality: Type.Array(Type.String(), { default: [] }),
  desires: Type.Array(Type.String(), { default: [] }),
  fears: Type.Array(Type.String(), { default: [] }),
  decisionLogic: Type.Array(Type.String(), { default: [] }),
  voice: Type.Array(Type.String(), { default: [] }),
  relationships: Type.Array(Type.String(), { default: [] }),
  knowledgeBoundaries: Type.Array(Type.String(), { default: [] }),
  capabilityCosts: Type.Array(Type.String(), { default: [] }),
  unfinishedChoices: Type.Array(Type.String(), { default: [] }),
  establishedHistory: Type.Array(Type.String(), { default: [] }),
  boundaries: Type.Array(Type.String(), { default: [] }),
  sourceId: Type.String(),
});
export type CharacterNarrativeProfile = Static<typeof CharacterNarrativeProfileSchema>;

/** 角色状态摘要（来自 narrative-state.json / 角色档案） */
export const CharacterStateSummarySchema = Type.Object({
  name: Type.String({ description: "角色名" }),
  role: Type.Optional(Type.String({ description: "角色定位：protagonist/antagonist/supporting" })),
  mentality: Type.Optional(Type.String({ description: "当前心智状态描述" })),
  recentAction: Type.Optional(Type.String({ description: "最近一次行动/登场动作" })),
  pendingTension: Type.Optional(Type.String({ description: "未解决张力" })),
  aliases: Type.Optional(Type.Array(Type.String())),
  narrativeProfile: Type.Optional(CharacterNarrativeProfileSchema),
});
export type CharacterStateSummary = Static<typeof CharacterStateSummarySchema>;

/** 前章承接摘要（来自 chapter-continuity 快照、已接受正文或 skeleton.json） */
export const PreviousChapterContinuationSchema = Type.Object({
  available: Type.Boolean({ description: "是否存在前章承接（快照 / 正文 / skeleton）" }),
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

/** 作者显式声明的章节叙事契约，不含感官、句式、对白或段落执行方式。 */
export const AuthorChapterContractSchema = Type.Object({
  available: Type.Boolean(),
  chapterFunction: Type.Optional(Type.String()),
  readerExperience: Type.Array(Type.String(), { default: [] }),
  currentPressure: Type.Array(Type.String(), { default: [] }),
  focusCharacterGoals: Type.Array(Type.Object({
    character: Type.String(),
    goal: Type.String(),
  }), { default: [] }),
  resistance: Type.Array(Type.String(), { default: [] }),
  choicesAndCosts: Type.Array(Type.Object({
    choice: Type.String(),
    cost: Type.String(),
  }), { default: [] }),
  expectedIrreversibleChange: Type.Array(Type.String(), { default: [] }),
  causalEndPressure: Type.Array(Type.String(), { default: [] }),
  eventSummaries: Type.Array(Type.String(), { default: [] }),
  mustInclude: Type.Array(Type.String(), { default: [] }),
  stateChanges: Type.Array(Type.String(), { default: [] }),
  foreshadowing: Type.Array(Type.String(), { default: [] }),
  causalRelations: Type.Array(Type.String(), { default: [] }),
  endingTarget: Type.Optional(Type.String()),
  relevantCharacters: Type.Array(Type.String(), { default: [] }),
  characterMotivations: Type.Array(Type.Object({
    character: Type.String(),
    motivation: Type.String(),
  }), { default: [] }),
  sourceIds: Type.Array(Type.String(), { default: [] }),
});
export type AuthorChapterContract = Static<typeof AuthorChapterContractSchema>;

/** 章节意图（替代旧 outlineIntent 的写前来源） */
export const ChapterIntentSchema = Type.Object({
  primary: Type.String({ description: "主要意图：foreshadow/character/reversal/romance/setting/combat" }),
  secondary: Type.Array(Type.String()),
  keywords: Type.Array(Type.String()),
  chapterTheme: Type.String(),
  targetEmotions: Type.Array(Type.String()),
  /** Explicit chapter contract facts. They must come from user/workspace seed data. */
  choicesAndCosts: Type.Optional(Type.Array(Type.Object({
    choice: Type.String(),
    cost: Type.String(),
  }))),
  expectedIrreversibleChange: Type.Optional(Type.Array(Type.String())),
  causalEndPressure: Type.Optional(Type.Array(Type.String())),
  /** Author/chapter-card supplied REM window. Absence means no deadline. */
  expectationWindow: Type.Optional(Type.Object({
    earliest: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
    optimal: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
    latest: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  })),
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
  /** 作者权威章节契约；只描述叙事内容，不描述正文执行方式。 */
  authorChapterContract: AuthorChapterContractSchema,
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
