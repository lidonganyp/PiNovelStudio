/**
 * PiNovelStudio — DAG 引擎核心类型定义
 *
 * StoryDAG 是故事因果骨架，每个节点是事件，每条边代表因果关系。
 * 使用 TypeBox 进行类型验证，确保数据完整性。
 */

import { Type, Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// ============================================================================
// 基础枚举类型
// ============================================================================

/** 章节功能类型 */
export const ChapterFunction = Type.Union([
  Type.Literal("setup"),
  Type.Literal("escalation"),
  Type.Literal("payoff"),
  Type.Literal("climax"),
]);
export type ChapterFunction = Static<typeof ChapterFunction>;

/** 事件节点类型 */
export const EventType = Type.Union([
  Type.Literal("scene"),
  Type.Literal("dialogue"),
  Type.Literal("action"),
  Type.Literal("revelation"),
  Type.Literal("transition"),
]);
export type EventType = Static<typeof EventType>;

/** 因果边类型 */
export const CausalEdgeType = Type.Union([
  Type.Literal("temporal"),
  Type.Literal("causal"),
  Type.Literal("motivational"),
  Type.Literal("informational"),
]);
export type CausalEdgeType = Static<typeof CausalEdgeType>;

/** 叙事节拍类型 */
export const NarrativeBeat = Type.Union([
  Type.Literal("establishment"),
  Type.Literal("rising"),
  Type.Literal("revelation"),
  Type.Literal("crisis"),
  Type.Literal("climax"),
  Type.Literal("resolution"),
  Type.Literal("cliffhanger"),
]);
export type NarrativeBeat = Static<typeof NarrativeBeat>;

/** 情绪类型 */
export const EmotionType = Type.Union([
  Type.Literal("燃"),
  Type.Literal("爽"),
  Type.Literal("紧张"),
  Type.Literal("压抑"),
  Type.Literal("好奇"),
  Type.Literal("感动"),
  Type.Literal("愤怒"),
  Type.Literal("释然"),
  Type.Literal("寒意"),
  Type.Literal("温馨"),
]);
export type EmotionType = Static<typeof EmotionType>;

/** Agent 输出状态 */
export const AgentStatus = Type.Union([
  Type.Literal("success"),
  Type.Literal("needs_human"),
  Type.Literal("blocked"),
  Type.Literal("error"),
]);
export type AgentStatus = Static<typeof AgentStatus>;

// ============================================================================
// 核心数据结构
// ============================================================================

/** 情绪弧线 */
export const EmotionalArc = Type.Object({
  from: Type.String({ description: "起始情绪" }),
  to: Type.String({ description: "目标情绪" }),
});
export type EmotionalArc = Static<typeof EmotionalArc>;

/** 字数目标 */
export const WordCountTarget = Type.Object({
  min: Type.Number({ minimum: 0 }),
  max: Type.Number({ minimum: 0 }),
});
export type WordCountTarget = Static<typeof WordCountTarget>;

/** 事件节点 */
export const EventNodeSchema = Type.Object({
  id: Type.String({
    description: "事件ID，如 'E1', 'E2'",
    pattern: "^E\\d+$",
  }),
  name: Type.String({ description: "事件名称" }),
  type: EventType,
  preconditions: Type.Array(Type.String(), {
    description: "前置条件（如 'E1.completed'）",
  }),
  effects: Type.Array(Type.String(), { description: "产生的影响" }),
  characters: Type.Array(Type.String(), { description: "参与角色ID列表" }),
  location: Type.String({ description: "场景地点" }),
  emotionalArc: EmotionalArc,
  conflictLevel: Type.Number({ minimum: 1, maximum: 5 }),
  narrativeBeat: NarrativeBeat,
  hooks: Type.Array(Type.String(), {
    description: "本事件埋设的钩子",
    default: [],
  }),
  /**
   * 内容要点列表（P2-A 新增）
   * Architect 从大纲中提取每个事件必须包含的关键内容点，
   * Narrator 将其作为硬约束注入到事件提示词中。
   * 用于解决"元数据驱动"vs"大纲驱动"的偏差问题。
   *
   * 示例：E1 应包含 ["林衡进入轨道城北站排查停电", "许棠调取门禁记录", "维修队恢复核心街区供电"]
   */
  contentPoints: Type.Array(Type.String(), {
    description: "大纲要求本事件必须包含的关键内容点",
    default: [],
  }),
  allowedNewCharacters: Type.Optional(Type.Array(Type.String(), {
    description: "本事件允许显式引入并行动/发言的新角色名",
    default: [],
  })),
  introducedCharacters: Type.Optional(Type.Array(Type.String(), {
    description: "本事件显式引入的新角色名（allowedNewCharacters 的兼容别名）",
    default: [],
  })),
  newCharacters: Type.Optional(Type.Array(Type.String(), {
    description: "本事件新增角色名（allowedNewCharacters 的兼容别名）",
    default: [],
  })),
  worldbuildingReveal: Type.Optional(
    Type.String({ description: "揭示的世界观信息" })
  ),
  powerAdvancement: Type.Optional(
    Type.String({ description: "实力提升描述" })
  ),
  keyEmotion: Type.Optional(Type.String()),
  wordCountTarget: WordCountTarget,
  // 运行时属性
  status: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("completed"),
    ])
  ),
  generatedText: Type.Optional(Type.String()),
});
export type EventNode = Static<typeof EventNodeSchema>;

/** 因果边 */
export const CausalEdgeSchema = Type.Object({
  from: Type.String({ description: "源事件ID" }),
  to: Type.String({ description: "目标事件ID" }),
  type: CausalEdgeType,
  description: Type.Optional(Type.String()),
});
export type CausalEdge = Static<typeof CausalEdgeSchema>;

/** 情绪节拍 */
export const EmotionBeatSchema = Type.Object({
  position: Type.Number({ description: "字数位置" }),
  emotion: EmotionType,
  intensity: Type.Number({ minimum: 1, maximum: 10 }),
  trigger: Type.String({ description: "触发机制" }),
  duration: Type.Number({ description: "持续字数" }),
});
export type EmotionBeat = Static<typeof EmotionBeatSchema>;

/** 情绪曲线 */
export const EmotionalCurveSchema = Type.Object({
  beats: Type.Array(EmotionBeatSchema, { default: [] }),
  metrics: Type.Object({
    satisfactionDensity: Type.Number({ default: 0 }),
    tensionWaveCount: Type.Number({ default: 0 }),
    maxOppressionLength: Type.Number({ default: 0 }),
    cliffhangerStrength: Type.Number({ minimum: 1, maximum: 10, default: 5 }),
    emotionDiversity: Type.Number({ default: 0 }),
    curveSmoothness: Type.Number({ default: 0 }),
    climaxTiming: Type.Number({ minimum: 0, maximum: 1, default: 0.75 }),
  }),
});
export type EmotionalCurve = Static<typeof EmotionalCurveSchema>;

/** 伏笔计划 */
export const ForeshadowingPlanSchema = Type.Object({
  planted: Type.Array(
    Type.Object({
      id: Type.String(),
      hook: Type.String(),
      plantedAt: Type.String(),
      plantedBy: Type.String(),
      payoffCondition: Type.String(),
      payoffPlan: Type.String(),
    }),
    { default: [] }
  ),
  pending: Type.Array(Type.String(), { default: [] }),
  resolved: Type.Array(Type.String(), { default: [] }),
});
export type ForeshadowingPlan = Static<typeof ForeshadowingPlanSchema>;

/** 世界约束 */
export const WorldConstraintSchema = Type.Object({
  id: Type.String(),
  description: Type.String(),
  type: Type.Union([
    Type.Literal("power_limit"),
    Type.Literal("social_rule"),
    Type.Literal("magical_law"),
    Type.Literal("plot_armor"),
    Type.Literal("other"),
  ]),
  affectedCharacters: Type.Array(Type.String()),
});
export type WorldConstraint = Static<typeof WorldConstraintSchema>;

/** DAG 增强信息 */
export const DAGEnhancementsSchema = Type.Object({
  brainholeInjections: Type.Array(
    Type.Object({
      patternId: Type.String(),
      targetEventId: Type.String(),
      description: Type.String(),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
    }),
    { default: [] }
  ),
  worldBuilderAdditions: Type.Array(
    Type.Object({
      eventId: Type.String(),
      additions: Type.Record(Type.String(), Type.String()),
    }),
    { default: [] }
  ),
  dramaCoachAdjustments: Type.Array(
    Type.Object({
      eventId: Type.String(),
      adjustment: Type.String(),
      reason: Type.String(),
    }),
    { default: [] }
  ),
  // P13新增：大纲意图分类
  outlineIntent: Type.Optional(
    Type.Object({
      primary: Type.String({ description: "主要意图：foreshadow/character/reversal/romance/setting/combat" }),
      secondary: Type.Array(Type.String(), { description: "次要意图列表" }),
      keywords: Type.Array(Type.String(), { description: "本章关键词" }),
      chapterTheme: Type.String({ description: "本章主题描述" }),
      targetEmotions: Type.Array(Type.String(), { description: "目标情绪列表" }),
      // P3优化：章节段落是否精确匹配（false=回退到完整大纲）
      chapterFound: Type.Optional(Type.Boolean()),
    })
  ),
});
export type DAGEnhancements = Static<typeof DAGEnhancementsSchema>;

/** 章节情绪评分 */
export const ChapterEmotionScoreSchema = Type.Object({
  beats: Type.Array(EmotionBeatSchema),
  metrics: Type.Object({
    satisfactionDensity: Type.Number(),
    tensionWaveCount: Type.Number(),
    maxOppressionLength: Type.Number(),
    cliffhangerStrength: Type.Number({ minimum: 1, maximum: 10 }),
    emotionDiversity: Type.Number(),
    curveSmoothness: Type.Number(),
    climaxTiming: Type.Number(),
  }),
  issues: Type.Object({
    flatSegments: Type.Array(
      Type.Object({
        start: Type.Number(),
        end: Type.Number(),
      }),
      { default: [] }
    ),
    overOppressive: Type.Array(
      Type.Object({
        start: Type.Number(),
        end: Type.Number(),
      }),
      { default: [] }
    ),
    emotionlessBlocks: Type.Array(
      Type.Object({
        start: Type.Number(),
        end: Type.Number(),
      }),
      { default: [] }
    ),
    brokenCliffhanger: Type.Boolean({ default: false }),
    singleEmotionChapter: Type.Boolean({ default: false }),
    prematureClimax: Type.Boolean({ default: false }),
  }),
});
export type ChapterEmotionScore = Static<typeof ChapterEmotionScoreSchema>;

// ============================================================================
// StoryDAG 主类型
// ============================================================================

export const StoryDAGSchema = Type.Object({
  chapterId: Type.String({ description: "章节ID" }),
  title: Type.String({ description: "章节标题" }),
  chapterFunction: ChapterFunction,
  events: Type.Array(EventNodeSchema, { description: "事件节点列表" }),
  causalGraph: Type.Array(CausalEdgeSchema, { description: "因果边列表" }),
  emotionalCurve: EmotionalCurveSchema,
  foreshadowing: ForeshadowingPlanSchema,
  worldConstraints: Type.Array(WorldConstraintSchema, { default: [] }),
  enhancements: Type.Optional(DAGEnhancementsSchema),
  // 元数据
  metadata: Type.Object({
    createdAt: Type.String(),
    updatedAt: Type.String(),
    version: Type.String({ default: "1.0.0" }),
    status: Type.Union([
      Type.Literal("draft"),
      Type.Literal("approved"),
      Type.Literal("in_progress"),
      Type.Literal("completed"),
    ]),
  }),
});
export type StoryDAG = Static<typeof StoryDAGSchema>;

// ============================================================================
// 叙事状态机类型定义
// ============================================================================

export type RelationshipState = 'warming' | 'stable' | 'cooling' | 'broken';

export type HorrorTechnique =
  | 'spatial_distortion'
  | 'familiar_becomes_monster'
  | 'unknown_rule'
  | 'countdown_pressure'
  | 'sensory_horror'
  | 'isolation'
  | 'body_horror';

export type RuleExposureStatus = 'hidden' | 'hinted' | 'revealed' | 'weaponized';

export type ExtractionTask =
  | 'ability_cost'
  | 'mentality_change'
  | 'horror_technique'
  | 'foreshadowing_update'
  | 'world_rule_exposure';

export interface ReaderExpectation {
  unresolvedCount: number;
  lastPayoffChapter: number;
  lastPeakMoment: string;
  chaptersSinceLastPeak: number;
}

export interface RelationshipEntry {
  state: RelationshipState;
  lastInteractionChapter: number;
  pendingTension: string | null;
}

export interface HorrorFatigue {
  recentTechniques: HorrorTechnique[];
  consecutiveSameTechnique: number;
}

export interface RuleExposureEntry {
  ruleKey: string;
  description: string;
  status: RuleExposureStatus;
  chaptersSinceRevealed: number;
}

export interface CostEntry {
  action: string;
  cost: string;
  chapterIncurred: number;
  resolved: boolean;
}

export interface ProtagonistCostLedger {
  pendingCosts: CostEntry[];
  mentalityTrend: number[];
}

export interface NarrativeState {
  currentChapter: number;
  readerExpectation: ReaderExpectation;
  relationshipTemperature: Record<string, RelationshipEntry>;
  horrorFatigue: HorrorFatigue;
  worldRuleExposure: Record<string, RuleExposureEntry>;
  protagonistCostLedger: ProtagonistCostLedger;
  lastAnchorChapter: number;
  lastAnchorName: string;
}

// ============================================================================
// 衔接润色类型定义
// ============================================================================

export enum ContentIssueType {
  TAIL_HANGING = 'TAIL_HANGING',
  HEAD_MISMATCH = 'HEAD_MISMATCH',
  FULL_REGENERATE = 'FULL_REGENERATE',
}

export interface NodeTailAnchor {
  rawText: string;
  endingEmotion: string;
  lastSentenceType: 'action' | 'dialogue' | 'inner' | 'environment';
  openLoops: string[];
}

export interface ConnectionInput {
  nodeA_tail: string;
  nodeB_head: string;
  nodeA_function: string;
  nodeB_function: string;
  expectedEmotionalShift: string;
  nodeA_endingType: 'action' | 'dialogue' | 'inner' | 'environment';
}

export interface ConnectionIssue {
  type: ContentIssueType;
  description: string;
}

export interface ConnectionResult {
  polished: boolean;
  insertBeforeB: string | null;
  modifyBFirstSentences: string | null;
  issues: ConnectionIssue[];
  diagnosis: {
    timeJump: boolean;
    emotionBreak: boolean;
    rhythmBreak: boolean;
  };
}

export interface GenerationSegment {
  eventId: string;
  eventName: string;
  text: string;
  wordCount: number;
  tokens: number;
  tailAnchor?: NodeTailAnchor;
  /**
   * P35 新增：Stage 2 事件级范式评分快照（8 维度本地评分）。
   *
   * 由 NarratorAgent.generateEvent 在事件级范式 gate 评测后写入，
   * 供 execute() 主循环聚合到 stage2ParadigmSummary，再由 index.ts
   * 落位到 stageResults.stage2.perEventResults[*].paradigm +
   * stageResults.stage2_chinese_webnovel_paradigm 顶层字段。
   *
   * 留空表示该事件未触发范式评分（如纯观察事件或评分异常）。
   */
  paradigm?: {
    totalScore: number;
    verdict: "pass" | "revise" | "block";
    translationToneDensity: number;
    nativeNaturalnessVerdict: "pass" | "repair" | "block";
    /** 维度摘要（id/label/score/verdict/evidence），不含 issues 全量 */
    dimensions: Array<{
      id: string;
      label: string;
      score: number;
      verdict: "pass" | "revise" | "block";
      evidence: string;
    }>;
    /** 触发重写时的原因摘要（含 retryCount），未触发重写时留空 */
    reason?: string;
  };
  /**
   * P41 任务4/5 新增：Stage 2 事件级流水账扫描快照（FlatNarrationScanner）。
   *
   * 由 NarratorAgent.generateEvent 在所有事件级 gate 通过后调用 scanFlatNarration 写入，
   * 供 execute() 主循环聚合到 stage2FlatNarrationSummary，再由 index.ts
   * 落位到 stageResults.stage2.perEventResults[*].flatNarration +
   * stageResults.stage2_flat_narration 顶层字段。
   *
   * Stage 8 categorized report 从 stage2.perEventResults 解析 narrative_selection 类别。
   * 留空表示该事件未触发流水账扫描（如异常路径）。
   */
  flatNarration?: {
    score: number;
    verdict: "pass" | "review" | "block";
    issueCount: number;
    issueTypes: string[];
    densityPerThousand: number;
    functionlessDetailCount: number;
    measurementRelationshipCount: number;
    weightClass?: string;
    rewriteAttempted: boolean;
    summary: string;
  };
  /**
   * P42 任务6 新增：Stage 2 事件级中文搭配扫描快照（ChineseNarrativeNaturalnessScanner）。
   *
   * 由 NarratorAgent.generateEvent 在 P42 三检查 callsite 写入，
   * 供 execute() 主循环聚合到 stage2P42Summary，再由 index.ts
   * 落位到 stageResults.stage2.perEventResults[*].chineseCollocation +
   * stage2_chinese_collocation 顶层字段。
   *
   * Stage 8 categorized report 从 stage2.perEventResults 解析 chinese_naturalness 类别。
   */
  chineseCollocation?: {
    findingsCount: number;
    issueTypes: string[];
    densityPerThousand: number;
    verdict: "pass" | "review" | "block";
    rewriteAttempted: boolean;
    summary: string;
  };
  /**
   * P42 任务6 新增：Stage 2 事件级群像聚焦门禁快照（GroupCastFocusGate）。
   *
   * 由 NarratorAgent.generateEvent 在 P42 三检查 callsite 写入，
   * 供 execute() 主循环聚合到 stage2P42Summary，再由 index.ts
   * 落位到 stageResults.stage2.perEventResults[*].groupCastFocus +
   * stage2_group_cast_focus 顶层字段。
   *
   * Stage 8 categorized report 从 stage2.perEventResults 解析 character_boundary 类别。
   */
  groupCastFocus?: {
    violationCount: number;
    violationTypes: string[];
    verdict: "pass" | "review" | "block";
    hasEnsemblePlan: boolean;
    rewriteAttempted: boolean;
    summary: string;
  };
  /**
   * P42 任务6 新增：Stage 2 事件级无功能细节门禁快照（DetailFunctionGate）。
   *
   * 由 NarratorAgent.generateEvent 在 P42 三检查 callsite 写入，
   * 供 execute() 主循环聚合到 stage2P42Summary，再由 index.ts
   * 落位到 stageResults.stage2.perEventResults[*].detailFunction +
   * stage2_detail_function 顶层字段。
   *
   * Stage 8 categorized report 从 stage2.perEventResults 解析 narrative_selection 类别。
   */
  detailFunction?: {
    verdict: "pass" | "review" | "compress" | "block";
    violationCount: number;
    matchedTags: string[];
    functionlessSpanCount: number;
    weightClass: string | null;
    rewriteAttempted: boolean;
    summary: string;
  };
  /**
   * P42 任务6 新增：Stage 2 事件级镜头权重硬约束快照（NarrativeWeightCompiler 7 字段）。
   *
   * 由 NarratorAgent.generateEvent 在 P42 三检查 callsite 写入，
   * 供 execute() 主循环聚合到 stage2P42Summary，再由 index.ts
   * 落位到 stageResults.stage2.perEventResults[*].narrativeWeightConstraints +
   * stage2_narrative_weight_constraints 顶层字段。
   *
   * null 表示该事件未触发镜头权重编译（如 weightClass 未定义）。
   */
  narrativeWeightConstraints?: {
    weightClass: string;
    allowedFocusCharacters: string[];
    maxNamedCharacterActions: number;
    detailFunctionRequired: boolean;
    microSectionFunctions: string[];
    forbiddenExpansion: string[];
    maxParagraphs: number;
    wordBudgetHardRange: { min: number; max: number };
  } | null;
}

// ============================================================================
// StateObserver 类型定义
// ============================================================================

export interface StateObserverInput {
  nodeText: string;
  activeTasks: ExtractionTask[];
  narrativeBeat: string;
}

export interface AbilityCostResult {
  task: 'ability_cost';
  triggered: boolean;
  entries: CostEntry[];
}

export interface MentalityChangeResult {
  task: 'mentality_change';
  triggered: boolean;
  delta: string;
  triggerEvent: string;
}

export interface HorrorTechniqueResult {
  task: 'horror_technique';
  triggered: boolean;
  techniques: HorrorTechnique[];
  unknownFragment: string | null;
}

export interface ForeshadowingUpdateResult {
  task: 'foreshadowing_update';
  triggered: boolean;
  entries: Array<{ id: string; action: 'hinted' | 'advanced' | 'resolved' }>;
}

export interface WorldRuleExposureResult {
  task: 'world_rule_exposure';
  triggered: boolean;
  entries: Array<{ rule: string; previousStatus: string; newStatus: string }>;
}

export type StateChangeResult =
  | AbilityCostResult
  | MentalityChangeResult
  | HorrorTechniqueResult
  | ForeshadowingUpdateResult
  | WorldRuleExposureResult;

// ============================================================================
// Agent 协议类型
// ============================================================================

/** 章节上下文 */
export const ChapterContextSchema = Type.Object({
  workspaceId: Type.String(),
  chapterId: Type.String(),
  chapterNumber: Type.Number(),
  novelName: Type.String(),
  genre: Type.String(),
  styleProfile: Type.String(),
  outline: Type.Optional(Type.String()),
  previousChapterSummary: Type.Optional(Type.String()),
  previousChapterDAG: Type.Optional(StoryDAGSchema),
  activeForeshadowing: Type.Array(Type.String()),
  characterStates: Type.Optional(
    Type.Record(Type.String(), Type.Record(Type.String(), Type.String()))
  ),
});
export type ChapterContext = Static<typeof ChapterContextSchema>;

/** Agent 报告 */
export const AgentReportSchema = Type.Object({
  agentName: Type.String(),
  timestamp: Type.String(),
  findings: Type.Array(Type.String(), { default: [] }),
  suggestions: Type.Array(Type.String(), { default: [] }),
  scores: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        value: Type.Number(),
        max: Type.Number(),
        notes: Type.Optional(Type.String()),
      })
    )
  ),
  issues: Type.Array(
    Type.Object({
      severity: Type.Union([
        Type.Literal("critical"),
        Type.Literal("warning"),
        Type.Literal("info"),
      ]),
      message: Type.String(),
      location: Type.Optional(Type.String()),
    }),
    { default: [] }
  ),
});
export type AgentReport = Static<typeof AgentReportSchema>;

/** Agent 产物 */
export const ArtifactSchema = Type.Object({
  type: Type.Union([
    Type.Literal("file"),
    Type.Literal("json"),
    Type.Literal("text"),
    Type.Literal("markdown"),
  ]),
  path: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  description: Type.String(),
});
export type Artifact = Static<typeof ArtifactSchema>;

/** Agent 协议接口 */
export const AgentInputSchema = Type.Object({
  workspaceId: Type.String(),
  chapterId: Type.String(),
  dag: Type.Optional(StoryDAGSchema),
  text: Type.Optional(Type.String()),
  context: ChapterContextSchema,
});
export type AgentInput = Static<typeof AgentInputSchema>;

export const AgentOutputSchema = Type.Object({
  status: AgentStatus,
  dag: Type.Optional(StoryDAGSchema),
  anchors: Type.Optional(Type.Array(Type.Any())), // 感知锚点清单
  skeleton: Type.Optional(Type.Any()), // 章节骨架
  text: Type.Optional(Type.String()),
  report: AgentReportSchema,
  artifacts: Type.Array(ArtifactSchema, { default: [] }),
  pendingStateCommit: Type.Optional(Type.Any()),
  // P21修复: 字数预算信息内部包含 overBudgetEvents，确保字段读取一致
  wordCountBudget: Type.Optional(Type.Object({
    totalWordCount: Type.Number(),
    totalBudgetMax: Type.Number(),
    isOverBudget: Type.Boolean(),
    isSeverelyOverBudget: Type.Boolean(),
    overLimitThreshold: Type.Number(),
    overBudgetEvents: Type.Optional(Type.Array(Type.Object({
      index: Type.Number(),
      eventId: Type.String(),
      excess: Type.Number(),
      targetWords: Type.Optional(Type.Number()),
    }))),
  })),
  // P21新增: 重写约束（传递给阶段5/8用于定向修稿）
  rewriteConstraints: Type.Optional(Type.Array(Type.Object({
    eventId: Type.String(),
    targetWords: Type.Number(),
  }))),
  // P29 PR-6新增: 事件 span（assembleChapter 产物，用于局部事件重写定位）
  eventSpans: Type.Optional(Type.Array(Type.Object({
    eventId: Type.String(),
    eventName: Type.String(),
    startOffset: Type.Number(),
    endOffset: Type.Number(),
  }))),
  // P29 PR-6新增: assembleChapter 时的 segments 快照（用于局部事件重写）
  segments: Type.Optional(Type.Array(Type.Any())),
});
export type AgentOutput = Static<typeof AgentOutputSchema>;

// ============================================================================
// 验证器
// ============================================================================

function checkSchema(schema: any, data: unknown): { valid: boolean; errors: string[]; value?: any } {
  if (Value.Check(schema, data)) {
    return { valid: true, errors: [], value: data };
  }
  const errors = [...Value.Errors(schema, data)];
  return {
    valid: false,
    errors: errors.map((e: any) => `${e.path}: ${e.message}`),
  };
}

export const validators = {
  storyDAG: { check: (data: unknown) => checkSchema(StoryDAGSchema, data) },
  eventNode: { check: (data: unknown) => checkSchema(EventNodeSchema, data) },
  causalEdge: { check: (data: unknown) => checkSchema(CausalEdgeSchema, data) },
  emotionBeat: { check: (data: unknown) => checkSchema(EmotionBeatSchema, data) },
  agentInput: { check: (data: unknown) => checkSchema(AgentInputSchema, data) },
  agentOutput: { check: (data: unknown) => checkSchema(AgentOutputSchema, data) },
};

/**
 * 验证 StoryDAG 数据
 */
export function validateStoryDAG(data: unknown): {
  valid: boolean;
  errors: string[];
  value?: StoryDAG;
} {
  return validators.storyDAG.check(data);
}

/**
 * 验证事件节点
 */
export function validateEventNode(data: unknown): {
  valid: boolean;
  errors: string[];
  value?: EventNode;
} {
  return validators.eventNode.check(data);
}

/**
   * 创建空 StoryDAG
   */
export function createEmptyDAG(
  chapterId: string,
  title: string,
  chapterFunction: ChapterFunction
): StoryDAG {
  return {
    chapterId,
    title,
    chapterFunction,
    events: [],
    causalGraph: [],
    emotionalCurve: {
      beats: [],
      metrics: {
        satisfactionDensity: 0,
        tensionWaveCount: 0,
        maxOppressionLength: 0,
        cliffhangerStrength: 5,
        emotionDiversity: 0,
        curveSmoothness: 0,
        climaxTiming: 0.75,
      },
    },
    foreshadowing: {
      planted: [],
      pending: [],
      resolved: [],
    },
    worldConstraints: [],
    enhancements: {
      brainholeInjections: [],
      worldBuilderAdditions: [],
      dramaCoachAdjustments: [],
    },
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: "1.0.0",
      status: "draft",
    },
  };
}

// ============================================================================
// 感知锚点与骨架类型（P2-1 Architect 重构）
// ============================================================================

export type SensoryChannel = "视觉" | "听觉" | "嗅觉" | "触觉" | "味觉";

/**
 * P5 锚点叙事功能（文档要求 6 类）
 * - progression：推进（事件因果链向前）
 * - suspense：悬念（埋设 open loop / 读者追问）
 * - emotion：情绪（角色内心或读者共鸣）
 * - worldbuilding：世界观（设定/规则/环境）
 * - relation：角色关系（关系状态变化）
 * - cost：代价（真实损失/让步）
 */
export type AnchorNarrativeFunction =
  | 'progression'
  | 'suspense'
  | 'emotion'
  | 'worldbuilding'
  | 'relation'
  | 'cost';

export interface AnchorPoint {
  id: string;
  description: string;
  sensoryChannel: SensoryChannel;
  sourceStep: 0 | 1 | 2 | 3 | 4;
  weight: number;
  tags: string[];
  /**
   * P5 锚点叙事功能。AnchorPlannerAgent 产出时必填；
   * 旧路径（architect.searchAnchors）可省略，由 AnchorPlannerAgent 后验补全。
   */
  narrativeFunction?: AnchorNarrativeFunction;
  /** P5 角色状态压力标记：该锚点触及哪个角色的当前压力（如未解张力、待付代价） */
  characterPressureRefs?: readonly string[];
  /** P5 open loop 触碰标记：该锚点触及哪条 open arc / pending foreshadowing */
  openLoopRefs?: readonly string[];
}

export interface StateChange {
  subject: string;
  before: string;
  after: string;
  isReversible: boolean;
}

export interface ChapterSkeleton {
  chapterId: string;
  facts: string[];
  stateChanges: StateChange[];
  activeDilemmas: string[];
}

// ============================================================================
// 中盘管理类型（第四轮蒸馏）
// ============================================================================

/** 悬念类型 */
export type SuspenseType = 'info' | 'relation' | 'threat' | 'cognition';

/** 悬念条目 */
export interface SuspenseEntry {
  id: string;
  description: string;
  type: SuspenseType;
  openedChapter: number;
  lastUpdatedChapter: number;
  urgency: number; // 0-1
}

/** 张力阶段 */
export type TensionStage = 'buildup' | 'confrontation' | 'peak' | 'resolution';

/** 张力条目 */
export interface TensionEntry {
  id: string;
  description: string;
  parties: string[];
  stagesSinceOpened: number;
  stage: TensionStage;
}

/** 关系状态 */
export type RelationshipState2 = 'warming' | 'stable' | 'cooling' | 'broken';

/** 关系条目 */
export interface RelationshipEntry2 {
  id: string;
  characters: [string, string];
  state: RelationshipState2;
  lastInteractionChapter: number;
  pendingUnsaid: string | null;
}

/** 悬置债务表 */
export interface NarrativeDebtLedger {
  openSuspense: SuspenseEntry[];
  activeTensions: TensionEntry[];
  interruptedRelationships: RelationshipEntry2[];
}

/** 三层时钟状态 */
export interface ChapterClockState {
  currentChapter: number;
  chaptersSinceLastArcSettlement: number;
  chaptersSinceLastMajorClimax: number;
  requiredAction: {
    debtUpdate: boolean;
    arcSettlement: boolean;
    coordinateReset: boolean;
  };
}

/** 中盘章节必检结果 */
export interface MidChapterCheckResult {
  passed: boolean;
  checks: {
    debtNetPositive: {
      passed: boolean;
      closedCount: number;
      openedCount: number;
      netChange: number;
    };
    protagonistPaidCost: {
      passed: boolean;
      irreversibleChange: string | null;
      costType: 'loss' | 'vulnerability' | 'forcedChoice' | null;
    };
    readerReevaluation: {
      passed: boolean;
      triggerDescription: string | null;
      reevaluationType: 'characterMotive' | 'pastEvent' | 'relationship' | 'worldRule' | null;
    };
  };
}

/** 债务类型 */
export type DebtType = 'power' | 'cognition' | 'relationship';

/** 类型特定中盘约束 */
export interface GenreSpecificMidConstraint {
  debtType: DebtType;
  maxDeferredPaymentChapters: number;
  minMicroPaymentFrequency: number;
  forbiddenPatterns: string[];
}

/** 新角色入场检查 */
export interface NewCharacterIntroCheck {
  isMirror: boolean;
  mirroredCharacter: string | null;
  isInArcSettlementWindow: boolean;
  isIntroducedViaExistingCharacter: boolean;
  introducingCharacter: string | null;
  isInMainSuspenseBuildup: boolean;
}

// ============================================================================
// 模式疲劳检测类型（第四轮蒸馏）
// ============================================================================

/** 叙事动作类型 */
export type NarrativeActionType =
  | 'reveal_info'
  | 'create_conflict'
  | 'advance_relation'
  | 'reevaluate_past'
  | 'incur_cost'
  | 'temporary_rest';

/** 章末钩子子类型 */
export type HookSubType =
  | 'info_suspense'
  | 'relation_suspense'
  | 'threat_suspense'
  | 'cognition_suspense';

/** 情感触发器类型 */
export type EmotionTriggerType =
  | 'external_threat'
  | 'internal_conflict'
  | 'relational_rupture';

/** 崩溃形式 */
export type BreakdownForm = 'explosion' | 'silence' | 'actionization';

/** 核心层疲劳检测结果 */
export interface CoreFatigueResult {
  narrativeActionDistribution: {
    last10Chapters: NarrativeActionType[];
    consecutiveSameType: number;
    alert: boolean;
  };
  emotionPatternMatrix: {
    recentCombinations: Array<{ trigger: EmotionTriggerType; breakdown: BreakdownForm }>;
    newCombinationsInLast5: number;
    alert: boolean;
  };
  protagonistCostDecay: {
    last5Decisions: Array<{ hasVisibleCost: boolean; costScore: number }>;
    trend: 'rising' | 'stable' | 'declining';
    alert: boolean;
  };
}

/** 增强层疲劳检测结果 */
export interface EnhancedFatigueResult {
  hookRotation: {
    last10Hooks: HookSubType[];
    consecutiveSameType: number;
    alert: boolean;
  };
  imageryDrift: Array<{
    imageryName: string;
    occurrences: number;
    lastDriftChapter: number;
    alert: boolean;
  }>;
  suspenseNetCurve: {
    last10Chapters: number[];
    approachingZeroStreak: number;
    alert: boolean;
  };
}

/** 完整疲劳检测报告 */
export interface FatigueDetectionReport {
  core: CoreFatigueResult;
  enhanced: EnhancedFatigueResult;
  overallRisk: 'low' | 'medium' | 'high';
  recommendations: string[];
}

/** 一次性武器分类 */
export interface OneTimeWeapon {
  name: string;
  category: 'pure_one_time' | 'near_one_time' | 'needs_interval_variant' | 'needs_semantic_drift' | 'type_rotatable' | 'accumulative';
  minInterval?: number;
  intervalUnit?: 'chapter' | 'scene';
  additionalConstraints?: string[];
}

// ============================================================================
// 第五轮蒸馏：配角深度与功能角色类型（规则 #79-#123）
// ============================================================================

/** 叙事功能类型 - 第一层：结构性功能 */
export type NarrativeFunctionPrimary =
  | 'pressure_vessel'     // 压力容器：承受"如果不是因为他，主角就可以彻底放弃"
  | 'moral_mirror'        // 道德镜：和主角相似起点但做出不同选择
  | 'cost_carrier'        // 代价载体：用真实损失告诉读者世界冲突有重量
  | 'narrative_anchor';   // 叙事信使：传递主角在世界的坐标信息

/** 叙事功能类型 - 第二层：局部性功能 */
export type NarrativeFunctionSecondary =
  | 'proxy_conflict'       // 代理冲突者
  | 'info_carrier'        // 信息载体
  | 'emotion_bridge'      // 情绪共鸣桥
  | 'rhythm_regulator';   // 节奏调节器

/** 功能状态 */
export type FunctionStatus = 'latent' | 'active' | 'depleted';

/** 投资度状态 */
export type RetirementStatus = 'active' | 'recommended' | 'retired';

/** 功能完成日志条目 */
export interface FunctionCompletionEntry {
  chapter: number;
  event: string;
  completionDegree: number; // 0-100
}

/** 独立欲望 - 驱动强度 */
export type DesireUrgency = 'dormant' | 'active' | 'urgent' | 'terminal';

/** 主角对配角色欲望的知晓程度 */
export type ProtagonistAwareness = 'unknown' | 'partial' | 'full';

/** 独立欲望接口 */
export interface IndependentDesire {
  goal: string;                    // 具体目标，不是"想变强"
  urgency: DesireUrgency;          // 当前驱动强度
  conflictWithProtagonist: string | null; // 与主角目标的摩擦点
  protagonistAwareness: ProtagonistAwareness;
  everActivated: boolean;          // 是否曾被激活（系统追踪用）
}

/** 信息盲区接口 */
export interface BlindSpot {
  fact: string;                    // 他不知道的一个具体事实
  narrativeConsequence: string;    // 如果他知道，行为会怎么改变
  revealTrigger: string | null;   // 预计揭示时机
}

/** 错误信念接口 */
export interface FalseBelief {
  belief: string;                  // 他相信的命题，但这是错的
  origin: string;                  // 信念的来源（必须有）
  behavioralSignature: string;     // 信念如何影响行为（最重要）
  crack: string | null;           // 信念是否已有裂缝
}

/** 弧线耦合类型 */
export type ArcCouplingType = 'parallel' | 'causal' | 'cost' | 'counterpoint';

/** 字段更新日志 */
export interface FieldUpdateLog {
  field: string;
  updatedChapter: number;
  previousValue: unknown;
  newValue: unknown;
}

/** 配角档案接口 */
export interface SupportingCharacterProfile {
  id: string;
  name: string;
  narrativeFunction: {
    primary: NarrativeFunctionPrimary;
    secondary: NarrativeFunctionSecondary[];
    functionStatus: FunctionStatus;
    functionCompletionLog: FunctionCompletionEntry[];
  };
  arc: {
    holding: string;           // 持有的信念/立场
    challenge: string;         // 被什么挑战
    choice: string;            // 做出什么选择
    couplings: ArcCouplingType[];
  };
  depthDimensions: {
    independentDesire: IndependentDesire;
    blindSpots: BlindSpot[];
    falseBeliefs: FalseBelief[];
  };
  readerInvestment: {
    meaningfulAppearances: number;
    lastActiveChapter: number;
    firstAppearanceChapter: number;
    emotionalAnchorEvents: string[];
    retirementStatus: RetirementStatus;
  };
  /** R046: 叙述基线 — 视角切换时的叙述处方性基线 */
  narrativeBaseline?: NarrativeBaseline;
  fieldUpdateLog: FieldUpdateLog[];
}

/**
 * R046: 叙述基线 — 每个视角角色的叙述处方性基线
 * 用于确保视角切换时叙述语气保持一致
 */
export interface NarrativeBaseline {
  characterId: string;
  /** 平均句长区间 [min, max] 字 */
  sentenceLengthRange: [number, number];
  /** 段落节奏: sparse(稀疏) / normal(正常) / dense(密集) */
  paragraphRhythm: "sparse" | "normal" | "dense";
  /** 词汇倾向: colloquial(口语) / mixed(混合) / formal(书面) */
  vocabularyTendency: "colloquial" | "mixed" | "formal";
  /** 感知颗粒度: macro(宏观/事件层) / micro(微观/细节层) */
  perceptionGranularity: "macro" | "micro";
  /** 句式偏好: short(短句为主) / mixed(混合) / long(长句为主) */
  sentencePattern: "short" | "mixed" | "long";
  /** 标志性句式（角色的签名句式） */
  signaturePatterns: string[];
}

/** CharacterContextBuilder 输出 */
export interface CharacterContextOutput {
  characterId: string;
  activatedDimensions: Array<keyof SupportingCharacterProfile['depthDimensions']>;
  suppressedDimensions: Array<keyof SupportingCharacterProfile['depthDimensions']>;
  sceneRole: NarrativeFunctionSecondary | null;
  injectionNote: string;
  firstAppearanceConstraints: FirstAppearanceConstraints | null;
  /** R046: 叙述基线 — 视角切换时注入 */
  narrativeBaseline?: NarrativeBaseline;
}

/** 首次登场约束 */
export interface FirstAppearanceConstraints {
  active: boolean;
  rules: string[];
  selfCheck: string; // Narrator 生成后必须能回答"读者将产生什么悬而未决的问题"
}

/** 配角扁平化检测结果 */
export interface SupportingCharacterFlatnessResult {
  characterId: string;
  checks: {
    /** 检测A：功能暴露指数 */
    functionExposureIndex: number; // > 0.85 警告，> 0.95 红线
    nonPredictableAppearances: number;
    totalAppearances: number;
    /** 检测B：独立欲望活性 */
    desireActivitySignal: 'strong' | 'medium' | 'weak' | 'none';
    chaptersSinceDesireActivated: number;
    /** 检测C：配角互动多样性 */
    protagonistInteractionRatio: number; // > 0.9 警告
    uniqueInteractionPartners: number;
    /** 检测D：弧线停滞 */
    arcStagnant: boolean;
    chaptersSinceArcUpdate: number;
    /** 检测E：代价载体消费前置条件 */
    costCarrierReady: boolean | null; // null = 非代价载体
    missingConditions: string[];
  };
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  recommendations: string[];
}

/** 退场推荐 */
export interface RetirementRecommendation {
  characterId: string;
  urgency: 'high' | 'low';
  score: number; // 40+30+20+10 评分公式
  reasons: string[];
  suggestedExitType: 'active' | 'cost' | 'fade';
}

/** 配角回归验证结果 */
export interface ReturnValidationResult {
  approved: boolean;
  reason?: string;
  requirePreparation?: boolean;
  preparationNote?: string;
  activatedDimension?: string;
}

/** 代价载体消费前置条件检查结果 */
export interface CostCarrierReadinessResult {
  characterId: string | null;
  passed: boolean;
  conditions: {
    meaningfulAppearances: { passed: boolean; actual: number; required: number };
    desireActivated: { passed: boolean };
    recentActivity: { passed: boolean; actual: number; max: number };
    emotionalAnchors: { passed: boolean; actual: number };
  };
  warnings: Array<{ level: 'critical' | 'warning'; message: string }>;
  blocked: boolean;
}

/** 配角互动质量评估 */
export interface SupportingCharacterInteractionResult {
  interactionBetween: [string, string];
  valueAdded: boolean;
  conditionsMet: number; // 满足 105 规则的条件数 (0-3)
  conditions: {
    readerUnderstandingChanged: boolean;
    desireOrBeliefExposed: boolean;
    relationshipStateChanged: boolean;
  };
  devaluationFactors: string[]; // 106 规则减值特征
  worthWriting: boolean;
  reason: string;
}

/** 配角-配角互动化学反应矩阵结果 */
export interface SupportingCharacterChemistryResult {
  combination: [NarrativeFunctionPrimary, NarrativeFunctionPrimary];
  chemistry: string;
  value: string;
}

// ============================================================================
// 第六轮蒸馏：世界观展示 vs 介绍工艺类型（规则 #124-#177）
// ============================================================================

/** 嵌入技法类型 */
export type EmbeddingTechnique =
  | 'character_question'        // 角色无知提问（新手代入法）
  | 'conflict_exposure'         // 冲突暴露规则（规则压力法）
  | 'object_scene_hint'         // 道具/场景暗示（环境叙事法）
  | 'asymmetric_dialogue'       // 信息不对称对话（对话博弈法）
  | 'misconception_correction'  // 错误认知纠正（反转教学法）
  | 'functional_narration';     // 功能性叙述（工具人说明法）

/** 揭示深度 */
export type RevealDepth = 'surface' | 'intermediate' | 'full';

/** 释放优先级 */
export type ReleasePriority = 'MUST' | 'SHOULD' | 'CAN' | 'DEFER';

/** 释放状态 */
export type ReleaseStatus = 'unassigned' | 'planned' | 'released' | 'overdue' | 'suppressed';

/** 释放策略类型 */
export type ReleaseStyle = 'aggressive' | 'balanced' | 'conservative';

/** 情节绑定类型 */
export type PlotBindingType = 'TRIGGER' | 'BACKGROUND' | 'CONSEQUENCE';

/** 说明性类型 */
export type WorldItemType =
  | 'POWER_SYSTEM'     // 力量体系
  | 'HISTORY'          // 历史背景
  | 'GEOGRAPHY'        // 地理环境
  | 'FACTION'          // 势力组织
  | 'CULTURE'          // 文化习俗
  | 'PLOT_TWIST'       // 剧情反转
  | 'CHARACTER_BACKGROUND' // 角色背景
  | 'RULE'             // 世界规则
  | 'OTHER';           // 其他

/** 揭示版本 */
export interface RevealVersion {
  depth: RevealDepth;
  content: string;
  chapter: number | null;
  spoilerProtection: boolean;
  explainability: 'active' | 'passive' | 'never';
}

/** 情节绑定 */
export interface PlotBinding {
  bindingType: PlotBindingType;
  triggerEvent: string;
  intensity: number; // 0-1
}

/** 依赖关系 */
export interface WorldItemDependency {
  hard: string[];  // 缺失会导致困惑
  soft: string[];   // 缺失降低理解深度但不阻断
}

/** 手动覆盖记录 */
export interface ManualOverride {
  field: string;
  previousValue: unknown;
  newValue: unknown;
  reason: string;
  timestamp: string;
}

/** 释放策略 */
export interface WorldItemReleaseStrategy {
  explainability: 'active' | 'passive' | 'never';
  preferredTechnique: EmbeddingTechnique | null;
  forbiddenChapters: number[];
  forcedChapter: number | null;
  styleOverride: ReleaseStyle | null;
  deferability: number; // 0-1, 0=不可延迟, 1=可延迟
  manualOverrides: ManualOverride[];
}

/** 世界观条目（核心数据模型） */
export interface WorldItem {
  id: string;
  name: string;
  type: WorldItemType;
  tags: string[];

  // 内容层
  summary: string;
  fullDescription: string;

  // 渐进揭示层
  revealVersions: RevealVersion[];

  // 依赖关系层
  dependencies: WorldItemDependency;

  // 情节绑定层
  plotBindings: PlotBinding[];

  // 投放策略层
  releaseStrategy: WorldItemReleaseStrategy;

  // 状态追踪层
  status: ReleaseStatus;
  earliestChapter: number | null;
  optimalChapter: number | null;
  latestChapter: number | null;
  actualChapter: number | null;

  // 元数据
  createdBy: string;
  createdAt: string;
  lastModified: string;
  priorityScore: number; // 优先级排序公式计算值
}

/** infodump 警报严重度 */
export type InfodumpSeverity = 'critical' | 'warning' | 'info';

/** infodump 警报类型 */
export type InfodumpAlertType =
  | 'consecutive_exposition'      // 连续说明段落
  | 'exposition_ratio_high'       // 说明句占比过高
  | 'wrong_position'              // 位置不当（章头连续说明）
  | 'technique_monotonous';       // 技法单调

/** infodump 警报 */
export interface InfodumpAlert {
  id: string;
  paragraphIndex: number;
  startChar: number;
  endChar: number;
  severity: InfodumpSeverity;
  type: InfodumpAlertType;
  description: string;
  suggestedTechnique: EmbeddingTechnique | null;
  suggestedRewrite: string | null;
  fourDimensionScore: {
    characterBinding: number;    // 角色感知绑定 (0-4)
    conflictRelevance: number;   // 冲突相关性 (0-4)
    sensoryDensity: number;      // 感官密度 (0-4)
    suspenseContribution: number; // 读者悬念贡献 (0-4)
  };
}

/** 章节指标 */
export interface ChapterMetrics {
  chapterId: string;
  wordCount: number;
  expositionRatio: number;        // 说明句占比 0-1
  maxConsecutiveExposition: number; // 最大连续说明段落字数
  techniquesUsed: EmbeddingTechnique[];
  techniqueDiversityScore: number; // 技法多样性分数 0-1
  infodumpAlerts: InfodumpAlert[];
  alertCount: {
    critical: number;
    warning: number;
    info: number;
  };
}

/** 释放地图条目 */
export interface ReleaseMapEntry {
  worldItemId: string;
  worldItemName: string;
  targetChapter: number;
  priority: ReleasePriority;
  recommendedTechnique: EmbeddingTechnique;
  status: ReleaseStatus;
  reasoning: string;
  conflictBinding: string | null;
  earliestPossible: number;
  latestAllowed: number;
  isPlotTwist: boolean;
}

/** 释放地图 */
export interface ReleaseMap {
  workspaceId: string;
  novelTitle: string;
  totalChapters: number;
  entries: ReleaseMapEntry[];
  conceptGroups: string[][];  // 循环依赖合并的概念组
  overview: {
    totalItems: number;
    assignedItems: number;
    overdueItems: number;
    suppressedItems: number;
    unassignedItems: number;
  };
  chapterAssignments: Record<number, string[]>;  // chapter -> worldItemIds
  lastUpdated: string;
  status: 'draft' | 'approved' | 'in_progress';
}

/** WorldPresenter 双层输出 */
export interface WorldPresenterOutput {
  machine_layer: {
    infodump_alerts: InfodumpAlert[];
    release_plan: ReleaseMapEntry[];
    chapter_metrics: ChapterMetrics;
  };
  human_layer: {
    summary: string;
    top_actions: string[];
    next_chapter_briefing: string;
  };
}

/** 壁垒交互命令 */
export interface InteractionCommand {
  type: 'move' | 'suppress' | 'force' | 'style' | 'detail' | 'approve' | 'auto';
  worldItemId?: string;
  targetChapter?: number;
  style?: ReleaseStyle;
  reason?: string;
}

/** 依赖断裂检查结果 */
export interface DependencyBreakResult {
  forward: {
    broken: boolean;
    brokenDeps: Array<{
      itemId: string;
      missingDep: string;
      requiredChapter: number;
    }>;
    suggestedActions: string[];
  };
  backward: {
    broken: boolean;
    brokenDeps: Array<{
      itemId: string;
      dependentItem: string;
      targetChapter: number;
    }>;
  };
  resolution: 'auto' | 'manual_required';
  options: Array<{
    action: 'cascade_move' | 'downgrade_soft' | 'cancel';
    description: string;
    itemIds: string[];
  }>;
}

/** 世界观展示质量报告 */
export interface WorldPresentationReport {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  chapterMetrics: ChapterMetrics;
  infodumpAlerts: InfodumpAlert[];
  releasePlanStatus: {
    plannedItems: number;
    releasedItems: number;
    overdueItems: number;
  };
  recommendations: string[];
  reportTimestamp: string;
}

/** 释放风格配置 */
export interface ReleaseStyleConfig {
  global: ReleaseStyle;
  typeOverrides: Record<WorldItemType, ReleaseStyle>;
  itemOverrides: Record<string, ReleaseStyle>;
}

// ============================================================================
// DAG 不可变性保护
// ============================================================================

/** DAG 核心字段 — Stage 2 以后禁止直接修改 */
const DAG_CORE_FIELDS = [
  "events",
  "causalGraph",
  "emotionalCurve",
  "foreshadowing",
  "worldConstraints",
] as const;

/**
 * 深冻结 DAG 核心字段。
 * 调用后对 events / causalGraph / emotionalCurve / foreshadowing / worldConstraints
 * 的直接修改将抛出 TypeError（strict mode）或静默失败（sloppy mode）。
 * enhancements、metadata 不冻结 — 允许后续 Agent 写入增强信息。
 */
export function deepFreezeCoreDAG(dag: StoryDAG): StoryDAG {
  for (const field of DAG_CORE_FIELDS) {
    deepFreeze((dag as Record<string, unknown>)[field]);
  }
  return dag;
}

function deepFreeze(obj: unknown): void {
  if (obj === null || typeof obj !== "object") return;
  Object.freeze(obj);
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
}

/**
 * 检测 DAG 核心字段是否已被冻结。
 * 用于测试和运行时断言。
 */
export function isCoreDAGFrozen(dag: StoryDAG): boolean {
  return Object.isFrozen(dag.events);
}
