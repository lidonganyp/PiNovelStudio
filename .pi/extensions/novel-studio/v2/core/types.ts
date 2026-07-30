/**
 * Quality Amplifier v2 — 核心类型定义
 *
 * 集中定义 V2 内核全部 TS 类型，对应规格文档 P1-P9。
 * 设计原则：
 * - 候选-比较-选择范式：少约束生成，多约束选择
 * - 所有修订必须 A/B 赢过原文（CandidateComparator 是唯一权威）
 * - 诊断不改文，RepairPlanner 默认 no_op
 * - 防止 gate 污染 prompt：promptProfile 审计
 *
 * 来源：delete/V2质量放大器内核.md P1-P9（spec 已遗失：delete/ 目录 gitignored 未跟踪，SLIMDOWN 清理时丢失，不可恢复；设计原则已沉淀于 docs/top-tier-chinese-novel-system-development-plan.md）
 */

import type { SceneSolutionCard } from "./scene-solution-search.js";
import type { PortableCraftGene } from "./portable-craft-gene.js";
// P4 M3 修复（2026-07-23）：type-only import，编译期擦除，无运行时耦合。
// LongTermStateSnapshot.overdueAlerts 复用 post-raw 通道的 OverdueAlertEntry 形状，
// 供 pre-write 链路把逾期期待暴露给 writer 模型。
import type { OverdueAlertEntry } from "./methodology-diagnostic-derived.js";

// ============================================================================
// P1 CompiledContext — 上下文编译器输出
// ============================================================================

export type ContextSourceType =
  | "config"
  | "chapter"
  | "character"
  | "skeleton"
  | "detail_ledger"
  | "foreshadow"
  | "world_rule"
  | "style"
  | "fewshot"
  | "runtime_rule";

export interface SourceMapEntry {
  sourceId: string;
  sourceType: ContextSourceType;
  path: string;
  locator?: string;
}

export type ContextFactKind = "fact" | "suggestion" | "style_ref" | "candidate_experience";

export interface ContextFact {
  id: string;
  content: string;
  sourceIds: string[];
  kind: ContextFactKind;
}

export interface CharacterStateFact {
  characterId: string;
  name: string;
  state: Record<string, unknown>;
  sourceIds: string[];
}

export interface OpenLoopFact {
  id: string;
  description: string;
  openedAt: string;
  urgency: number;
  sourceIds: string[];
}

export interface WorldRuleFact {
  id: string;
  description: string;
  type: string;
  affectedCharacters: string[];
  sourceIds: string[];
}

export interface StyleReference {
  id: string;
  kind: "fingerprint" | "signature_pattern" | "fewshot";
  content: string;
  sourceIds: string[];
}

/**
 * 作品宪法快照：CreativeConstitution 的只读分层视图（Phase 1，计划 §4.1）。
 * 表达"这本书想成为什么"，只含作品目标，不含句式配额。
 */
export interface ConstitutionSnapshot {
  workIdentity: string;
  readerPromise: string[];
  genrePromises: string[];
  protagonistCoreConflict: string;
  thematicQuestions: string[];
  aestheticDirection: string[];
  forbiddenDrift: string[];
  sourceIds: string[];
}

/**
 * 长期叙事状态快照：四类状态的只读视图（Phase 1，计划 §4.2）。
 * 候选生成期间只能读取快照，写入延迟到 final selection 之后（FinalStateCommit）。
 */
export interface LongTermStateSnapshot {
  canon: Array<{ id: string; fact: string; category: string; sourceChapter: string }>;
  character: Array<{
    id: string;
    characterId: string;
    field: string;
    value: string;
    sourceChapter: string;
  }>;
  promise: Array<{
    id: string;
    promiseId: string;
    description: string;
    status: string;
    currentHeat: number;
    sourceChapter: string;
  }>;
  pattern: Array<{
    id: string;
    patternType: string;
    description: string;
    occurrenceCount: number;
    sourceChapter: string;
  }>;
  /**
   * 读者期待状态（EXPECTATION-LEDGER-1，计划 §6.3）。
   * 期待关注"读者体验目标"（targetReaderExperience），状态包含 escalated/delayed。
   */
  expectation?: Array<{
    id: string;
    expectationId: string;
    description: string;
    expectationType?: string;
    targetReaderExperience?: string;
    delayReason?: string;
    status: string;
    sourceChapter: string;
    sourceRef?: string;
  }>;
  lastCommittedChapter?: string;
  sourceIds: string[];
  retrievalReport?: unknown;
  promptItems?: Array<{ id: string; kind: string; summary: string; sourceRef: string }>;
  /**
   * P4 M3 修复（2026-07-23）：pre-write overdue alerts，从 retrieval eligible 派生。
   * 经 CompiledContext.longTermState.overdueAlerts → ChapterIntentInput.overdueAlerts
   * → ChapterIntent.overduePressure 暴露给 writer 模型。空数组表示无逾期期待。
   */
  overdueAlerts?: OverdueAlertEntry[];
  /**
   * Phase 3D 计划状态（PlannedState）快照（P2 闭环修复，2026-07-29）。
   *
   * 来自 store.planned，是前序章节 ChapterSeed/Intent 派生的"作者曾意图"状态，
   * 供下一章 Preflight/ContextCompiler 作为连续性参考（不污染权威状态）。
   *
   * 设计要点：
   * - 全量暴露（不经过 retrieveNarrativeContext 过滤）：计划状态总量有限（每章
   *   ~10-30 条），不会撑爆上下文；且需要让下一章完整看到前序意图。
   * - verified/verificationOutcome 字段帮助下游判断计划是否被正文实际兑现：
   *   hit=已兑现、miss=未兑现、conflict=与正文冲突。
   * - 不参与 PromiseLedger / CanonState 的权威查询（仅作连续性参考）。
   */
  planned?: Array<{
    id: string;
    plannedKind: "canon" | "character" | "promise" | "expectation";
    plannedContent: string;
    plannedSource: "chapter_seed" | "chapter_intent";
    plannedField?: string;
    sourceChapter: string;
    verified: boolean;
    verificationOutcome?: "hit" | "miss" | "conflict";
  }>;
}

export interface CompiledContext {
  facts: ContextFact[];
  characterStates: CharacterStateFact[];
  openLoops: OpenLoopFact[];
  worldRules: WorldRuleFact[];
  styleReferences: StyleReference[];
  sourceMap: SourceMapEntry[];
  /** 作品宪法层（Phase 1）：无宪法文件时为 null，不阻断生成 */
  constitution?: ConstitutionSnapshot | null;
  /** 长期状态层（Phase 1）：无状态文件时为 null，不阻断生成 */
  longTermState?: LongTermStateSnapshot | null;
  /**
   * 前章悬置状态桥接上下文（REAL-QUALITY-4）：
   * 从 previousChapterContinuation 派生的结构化字段，作为不可跳过的 bridge context
   * 注入 raw prompt。无前章时为 null，不阻断。
   * 与 facts 中的 fact:prev_continuation 同源，但后者降级为被动参考；
   * bridgeContext 是强制承接语义的独立真相源。
   */
  bridgeContext?: BridgeContext | null;
}

/**
 * 前章悬置状态桥接上下文（REAL-QUALITY-4）。
 * 结构化承载前章 previousChapterContinuation，供 buildRawPrompt 渲染为
 * "前章悬置状态（本章必须承接，不得跳过）"独立 block。
 */
export interface BridgeContext {
  available: boolean;
  lastEventSummary?: string;
  lastEventId?: string;
  endingEmotion?: string;
  openHooks: string[];
  unresolvedTensions: string[];
  introducedCharacters: string[];
  sourceIds: string[];
}

// ============================================================================
// P2 CraftJudgment — 小说判断资产库
// ============================================================================

export type CraftDomain =
  | "ensemble"
  | "payoff"
  | "hook"
  | "info_release"
  | "emotion"
  | "character_agency"
  | "scene_continuity"
  | "dialogue_subtext"
  | "worldbuilding"
  | "style_naturalness";

export type CraftEvidenceLevel = "doc_claim" | "tested" | "replay_validated";

export type CraftGenerationUse = "scene_contract" | "context_hint" | "forbidden_damage";
export type CraftEvaluationUse = "comparator" | "diagnostic" | "hard_block";

export interface CraftJudgment {
  id: string;
  domain: CraftDomain;
  appliesTo: string[];
  positiveCriteria: string[];
  negativeSignals: string[];
  generationUse: CraftGenerationUse;
  evaluationUse: CraftEvaluationUse;
  evidenceLevel: CraftEvidenceLevel;
}

// ============================================================================
// P3 SceneContract — 场景契约
// ============================================================================

export type SceneType =
  | "rescue"
  | "combat"
  | "dialogue"
  | "revelation"
  | "emotion"
  | "transition"
  | "ensemble"
  | "cliffhanger";

export interface SceneContract {
  sceneId: string;
  sceneType: SceneType;
  readerPayoff: string[];
  mustPreserve: string[];
  mustAvoid: string[];
  qualityLevers: string[];
  relevantJudgments: string[];
  /**
   * 连续性锚点：必须保留的空间/角色/物体/状态锚点（P5 新增）。
   * 用于 antiRegression agency_dilution 防护——contract 显式列出
   * rawStage2/前文已有的关键连续性要素，amplified 不得丢弃。
   * 来源：从 anchors 中筛选 channel=visual/auditory/cognitive 的锚点。
   */
  continuityAnchors?: string[];
}

// ============================================================================
// EditorialPlan — 编辑意图简报（Layer 2 重做：编辑意图驱动的新候选）
// ============================================================================

export type EditorialStrategy =
  | "payoff_first"
  | "character_agency_first"
  | "suspense_info_release"
  | "ensemble_layered"
  | "style_native";

export interface EditorialVariantBrief {
  strategy: EditorialStrategy;
  /** 本变体侧重的写作焦点（编辑型描述，非控制清单） */
  focus: string;
  /** 切入角度提示 */
  angle: string;
}

export interface EditorialPlan {
  /** 本章最值得强化的读者体验 */
  readerExperience: string;
  /** 主角本章必须做出的选择 */
  protagonistChoice: string;
  /** 期待/伏笔/信息释放怎么推进 */
  expectationAdvancement: string;
  /** 章尾要留下什么新的问题或压力 */
  chapterEndPressure: string;
  /** 群像角色分别承担什么叙事功能 */
  ensembleRoles: string;
  /** 哪些事实绝不能破坏 */
  inviolableFacts: string[];
  /** 候选变体策略列表（3-5 个） */
  variantStrategies: EditorialVariantBrief[];
  /** 来源标记：llm | fallback_derived（降级时为 fallback_derived） */
  _source: "llm" | "fallback_derived";
}

// ============================================================================
// P4 Candidate — 候选正文
// ============================================================================

export type CandidateKind =
  | "direct_baseline"
  | "context_enhanced"
  | "scene_contract"
  | "style_aware"
  | "model_variant"
  | "editorial_amplified"
  | "agentic_raw";

export interface CandidatePromptProfile {
  type: "editorial" | "control";
  tokensIn: number;
  containsDialogueRatio: boolean;
  containsParagraphLengthConstraint: boolean;
  /**
   * Phase D 续修复（2026-07-09 第五轮）：补充 4 项检查的完整诊断字段。
   * 原 profile 只暴露 dialogue/paragraph 两项，auditFailure reason 无法定位
   * 到底是 controlChecklist 还是 mechanicalMetric 命中，排查时只能看到
   * "containsDialogueRatio=false, containsParagraphLengthConstraint=false"，
   * 但实际 isControl=true（被 mechanicalMetric 命中）。现在 4 项全暴露。
   */
  containsControlChecklist: boolean;
  containsMechanicalMetric: boolean;
  contractIds: string[];
}

export interface Candidate {
  id: string;
  kind: CandidateKind;
  text: string;
  model: string;
  route: string;
  promptProfile: CandidatePromptProfile;
  contextHash: string;
  generatedAt: string;
  durationMs: number;
  finishReason?: string;
  maxTokens?: number;
  sourceCandidateId?: string;
  /** editorial_amplified 候选的变体策略（其他 kind 留空） */
  editorialStrategy?: EditorialStrategy;
  /**
   * Phase 3 新增：机会驱动候选所基于的 EditorialHypothesis id。
   *
   * 每个 editorial 候选只携带一个主要 hypothesis（避免目标互相稀释）。
   * raw 候选与其他 kind 留空。用于追溯候选的编辑假设来源，
   * 以及 Phase 6 在线策略学习记录 hypothesis→candidate→selection 链路。
   */
  hypothesisId?: string;
}

// ============================================================================
// P5 Diagnostic — 诊断（只诊断不改文）
// ============================================================================

export type DiagnosticSeverity = "fatal" | "hard" | "review" | "info";

export interface TextSpan {
  start: number;
  end: number;
  excerpt?: string;
}

export interface Diagnostic {
  id: string;
  source: string;
  severity: DiagnosticSeverity;
  domain: CraftDomain | "format" | "continuity" | "naturalness";
  span?: TextSpan;
  evidence: string;
  suggestedRepair?: RepairPlan;
}

// ============================================================================
// P6 RepairPlan — 最小修复规划（默认 no_op）
// ============================================================================

export type RepairPlan =
  | { kind: "no_op"; reason: string }
  | { kind: "sentence_patch"; span: TextSpan; reason: string; expectedGain: string; possibleDamage: string }
  | { kind: "paragraph_patch"; span: TextSpan; reason: string; expectedGain: string; possibleDamage: string }
  | { kind: "bridge_patch"; location: string; reason: string; expectedGain: string; possibleDamage: string }
  | { kind: "event_patch"; eventId: string; reason: string; expectedGain: string; possibleDamage: string }
  | { kind: "event_rewrite"; eventId: string; reason: string; expectedGain: string; possibleDamage: string; failureEvidence: string }
  | { kind: "chapter_rewrite"; reason: "catastrophic_only"; failureEvidence: string };

// ============================================================================
// P7 CandidateComparison — 候选比较器输出（V2 核心）
// ============================================================================

export interface DimensionScores {
  chineseNaturalness: number;
  webnovelRhythm: number;
  eventProgression: number;
  characterAgency: number;
  ensembleQuality: number;
  payoffQuality: number;
  hookQuality: number;
  infoRelease: number;
  emotionalPayoff: number;
  continuity: number;
  antiRegression: number;
}

export interface AcceptedRepair {
  candidateId: string;
  repair: RepairPlan;
  reason: string;
  dimensionDelta: Partial<DimensionScores>;
}

export interface RejectedRepair {
  candidateId: string;
  repair: RepairPlan;
  reason: string;
  dimensionDelta: Partial<DimensionScores>;
}

export interface CandidateComparison {
  winnerId: string;
  loserIds: string[];
  confidence: number;
  dimensionScores: Record<string, DimensionScores>;
  acceptedRepairs: AcceptedRepair[];
  rejectedRepairs: RejectedRepair[];
  reasons: string[];
  /**
   * P2 新增：antiRegression check 级明细，按候选 id 索引。
   *
   * 用于：
   * - FinalSelector 第 4 门判定（antiRegressionOk = score>=95 || regressedChecks 为空）
   * - positive-acceptance 模块的 post-hoc 验收判定
   * - replay 报告可解释性（退化来源标注）
   *
   * score 语义：100 ⟺ 无退化证据；<100 ⟺ 有退化证据（regressedChecks 非空）。
   * 向后兼容：旧 trace 无此字段，FinalSelector 按无退化证据处理（通过第 4 门）。
   */
  antiRegressionDetailsByCandidate?: Record<
    string,
    { score: number; regressedChecks: string[] }
  >;
  /**
   * Phase D 新增：amplified 候选相对 rawStage2 baseline 的总分差。
   *
   * 语义：amplifiedScore - rawStage2Score（无 amplified 或无 rawStage2 候选时为 undefined）。
   * 用于 FinalSelector clearWin 判定 amplified-vs-rawStage2 胜出，
   * 替代原 confidenceOk（confidence 测量 winner-vs-runnerup，在 tie 场景下失效）。
   *
   * 与 confidence 的区别：
   * - confidence = (topScore - secondScore) / 100，测量 winner 与 runner-up 差距（可解释性指标）
   * - amplifiedBaselineMargin = amplifiedScore - rawStage2Score，测量 amplified 是否胜过项目基线（决策指标）
   *
   * 典型场景：ch5 s1 amplified=70 与 direct_claude=70 并列 tie，confidence=(70-70)/100=0，
   * 但 amplified 胜过 rawStage2=65，amplifiedBaselineMargin=5 >= threshold=5 → clearWin 通过。
   *
   * 向后兼容：旧 trace 无此字段，FinalSelector fallback 到原 confidenceOk 逻辑。
   */
  amplifiedBaselineMargin?: number;
  /** Phase D 新增：amplified 候选 id（便于 FinalSelector 定位，无 amplified 候选时为 undefined） */
  amplifiedCandidateId?: string;
  /** Phase D 新增：rawStage2 候选 id（便于 FinalSelector 定位，无 rawStage2 候选时为 undefined） */
  rawStage2CandidateId?: string;
}

// ============================================================================
// P8 FinalSelectionReport — 最终选择器输出
// ============================================================================

export type FinalSelectedSource = "direct" | "rawStage2" | "v2_amplified";
export type ProjectGain = "positive" | "neutral" | "negative";

export interface FinalSelectionReport {
  selectedCandidateId: string;
  selectedSource: FinalSelectedSource;
  projectGain: ProjectGain;
  whySelected: string[];
  whyRejected: string[];
  acceptedRepairs: AcceptedRepair[];
  rejectedRepairs: RejectedRepair[];
}

// ============================================================================
// P9 RuleStatus — 正收益规则晋级
// ============================================================================

export type RuleStatus = "candidate" | "diagnostic_only" | "validated" | "deprecated";

export interface RulePromotionRecord {
  ruleId: string;
  status: RuleStatus;
  sampleSize: number;
  validatedWinRate: number;
  lastUpdated: string;
  evidence: string[];
}

export interface PromotionDecision {
  ruleId: string;
  from: RuleStatus;
  to: RuleStatus;
  reason: string;
  eligible: boolean;
}

// ============================================================================
// V2 编排器输入/输出
// ============================================================================

export interface V2Input {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  projectRoot: string;
  /** Production-eligible prose writer. Undefined uses the configured Gemini default. */
  writerModel?: "claude" | "gemini31";
  modelTestRoute?: string;
  /**
   * @deprecated 历史短路径开关，被 fullPipelinePreview 取代；入口 normalize 为 fullPipelinePreview。
   */
  previewOnly?: boolean;
  /**
   * FULL-PIPELINE-PREVIEW-1：完整链路只读预览模式。
   * 执行完整主链路但跳过所有副作用（不写章节、不提交状态、不写 trace/策略库/证据文件）。
   * 与 previewOnly 短路不同——后者在 FactGuard 后直接返回 raw，跳过 editorial/judge/select。
   */
  fullPipelinePreview?: boolean;
  /** Read-only ceiling sample isolated from production candidate expansion. */
  qualityExperiment?: QualityExperimentControl;
  /** @deprecated 固定场景多候选已退出生产主链路。 */
  boundedBestOf3?: boolean;
  styleShaperRoute?: string;
  /** Explicitly reuse a strictly verified raw_fact_guard raw from the selected writer model. */
  recoverBlockedRaw?: boolean;
  stopAfterV2Stage?: "rawStage2";
  onUpdate?: (event: unknown) => void;
  /**
   * 单候选模型调用的 bounded 超时预算（ms），默认 600000（10 分钟）。
   *
   * Issue #6 修复：legacy fallback-manager 默认 totalTimeoutMs=120000（2 分钟），
   * GPT 生成整章正文常超此预算导致 direct baseline 缺失。V2 在编排入口将此值写入
   * PINOVEL_MODEL_TOTAL_TIMEOUT_MS 环境变量（仅当用户未显式设置时），把 fallback
   * chain 总预算提升到 bounded 10 分钟；同时在 adapter 层加 Promise.race 防御性
   * 超时，保证单候选调用不会无限等待。
   */
  candidateTimeoutMs?: number;
  /** Total wall-clock model-call budget for fullPipelinePreview. */
  previewTotalTimeoutMs?: number;
  /**
   * 随机种子（可选，用于 Thompson Sampling 策略过滤与 judge 匿名 A/B 随机化）。
   *
   * REAL-QUALITY-1-PREFLIGHT：未传时编排器内部 rng 回退到 Math.random（非确定性），
   * Thompson Sampling 冷启动 Beta(1,1) 采样可能 < 阈值导致策略被过滤、editorial
   * 候选不生成。传入 seed 可让生成可复现（replay / benchmark / 测试用）。
   *
   * 不影响模型调用本身（路由锁定由 modelTestRoute 控制）；只影响策略采样与匿名映射的随机性。
   */
  seed?: number;
  /** SCENE-SOLUTION-SEARCH-1：评测/显式实验传入的写前方案卡。 */
  sceneSolution?: SceneSolutionCard | null;
  /** PORTABLE-CRAFT-GENE-1：显式实验臂使用的抽象叙事工艺，不含 reference 正文。 */
  craftGenes?: PortableCraftGene[];
  /** 受控评测可显式激活 candidate；生产模式忽略并只消费 active。 */
  promptPatternIds?: string[];
}

export interface QualityExperimentControl {
  arm: "raw" | "scene" | "oracle_scene";
  sampleIndex: number;
}

export interface V2Output {
  status: "ok" | "error" | "blocked";
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  text?: string;
  finalSelection?: FinalSelectionReport;
  candidates?: Candidate[];
  comparison?: CandidateComparison;
  diagnostics?: Diagnostic[];
  failureEnvelope?: unknown;
  stageResults?: Record<string, unknown>;
  v2NotImplemented?: boolean;
  /**
   * FULL-PIPELINE-PREVIEW-1：本次运行为完整链路只读预览。
   * true 时调用方可知：完整链路已执行，但无任何副作用落盘。
   */
  isPreviewRun?: boolean;
  /**
   * FULL-PIPELINE-PREVIEW-1：最终交付正文来源（raw 或 editorial）。
   * 由编排器在 SelectionPolicy 后填入，便于调用方区分基线交付与编辑胜出。
   *
   * P0-1 修复（Phase 1 整改）：blocked 路径返回 null（无交付来源），
   * 表示未优化 Agentic 初稿未交付。仅 status="ok" 才标记 raw/editorial。
   */
  selectedSource?: "raw" | "editorial" | null;
  /**
   * FULL-PIPELINE-PREVIEW-1：最终选中的候选 id。
   * 与 finalSelection.selectedCandidateId 一致，但在无 finalSelection 时也可访问。
   */
  selectedCandidateId?: string;
  /**
   * INTENT-COMPLETENESS-1：本次 ChapterIntent 含空关键字段（under-specified）。
   * true 时调用方/trace 可见意图未完整（5 个关键字段中至少一个为空）。
   * 普通生成模式不阻断；evalMode + 关键字段为空时编排器阻断。
   */
  isUnderSpecified?: boolean;
}
