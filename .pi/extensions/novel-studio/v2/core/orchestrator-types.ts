/**
 * orchestrator-types - 统一主链路编排器的类型与常量定义
 *
 * 从 unified-orchestrator.ts 抽出的纯类型/常量模块（行为保持重构 Step 1）。
 * 包含：路由/kind/超时常量、模型调用遥测条目、编排器输入/输出、失败信封、控制平面 trace。
 * 本文件不含任何运行时逻辑，仅类型定义与字符串/数字常量。
 */

import type {
  Candidate,
  CompiledContext,
  ConstitutionSnapshot,
  QualityExperimentControl,
} from "./types.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { ModelGenerateFn } from "../adapters/legacy-model-route-adapter.js";
import type { ArbitratorResult } from "./judge-arbitrator.js";
import type { StagedStateUpdate } from "./final-state-commit.js";
import type { VoiceFingerprintInput } from "./dialogue-craft-compiler.js";
import type { StrategyPolicyStore } from "../learning/strategy-policy-store.js";
import type { ContextualStrategySelector } from "../learning/contextual-strategy-selector.js";
import type { StrategyOutcomeRecorder } from "../learning/strategy-outcome-recorder.js";
import type { AgenticRawCandidateSource } from "../../novelos/agent/agentic-raw-candidate-source.js";
import type { ContextSafetyResult } from "./context-safety.js";
import type { TrustedControlPlane } from "./control-plane.js";
import type { SceneSolutionCard } from "./scene-solution-search.js";
import type { PortableCraftGene } from "./portable-craft-gene.js";
import type { PromptPatternResolution } from "./prompt-pattern-library.js";
import type { WriterPromptProfile } from "./model-prompt-adapter.js";
import type { MethodologyDiagnosticState } from "./methodology-diagnostic-state.js";
// P0-3 审批闭环接通（2026-07-17）：代理审批阶段类型
// 计划 §6.3：FinalFactRecheck → ChapterProxyApproval → saveProxyApprovedDraft
// → UserRevisionOrAcceptance → FinalFactRecheck(user) → FinalStateCommit → AtomicChapterSave
import type { ChapterProxyApprovalCaller } from "../governance/chapter-proxy-approval-caller.js";
import type { ChapterProxyApprovalRegistry } from "../governance/chapter-proxy-approval-registry.js";

// ============================================================================
// 常量
// ============================================================================

/** raw 候选路由名 */
export const RAW_ROUTE = "v2_rawstage2";

/** editorial 候选路由名 */
export const EDITORIAL_ROUTE = "v2_amplified";

/** raw 候选 kind */
export const RAW_KIND = "context_enhanced";

/** raw 生成 bounded 超时（ms） */
export const DEFAULT_RAW_TIMEOUT_MS = 600000;

/** 空文本重试次数 */
export const MAX_RAW_EMPTY_RETRIES = 1;

// ============================================================================
// 输入/输出类型
// ============================================================================

/**
 * 单次模型调用遥测条目（Step 1c：Trace 遥测）。
 * 由 orchestrate 入口的计数装饰器填充，随 stageResults.modelCalls 落盘到 trace。
 * ModelGenerateOutput 暂无 token 字段，本次 tokenUsage 填 "unknown"（cost 估算留 follow-up）。
 */
export interface ModelCallEntry {
  route: string;
  kind: string;
  /** 兼容旧 trace：仅成功调用写实际模型。 */
  model?: string;
  durationMs: number;
  ts: number;
  finishReason?: string;
  maxTokens?: number;
  tokenUsage?: "unknown" | { in: number; out: number };
  /** Step 1d 修复：true 表示该次调用失败（抛异常），用于预算计数正确性 */
  failed?: boolean;
  /**
   * REAL-QUALITY-1-PREFLIGHT：实际使用的 provider（如 "glm" / "doubao"）。
   * 从 ModelGenerateOutput.provider 透传，用于验证 modelTestRoute=glm 时所有调用锁定 GLM。
   * 计划 §trace requestedRoute/actualProvider/actualModel 的 actualProvider 字段。
   */
  provider?: string;
  /**
   * REAL-QUALITY-1-PREFLIGHT：实际请求的路由名（如 "nb4_generate_glm"）。
   * 与 `route` 区分：`route` 是候选语义路由（v2_rawstage2/v2_amplified），保持选择/trace/报告契约；
   * `requestedRoute` 是底层调用真实走的路由，用于验证锁定到 nb4_*_glm。
   * 从 ModelGenerateOutput.requestedRoute 透传；未锁定时省略（与 route 一致）。
   */
  requestedRoute?: string;
  expectedProvider?: string;
  expectedModel?: string;
  actualProvider?: string;
  actualModel?: string;
  failurePhase?: "model.generate" | "model.judge";
  errorClass?: string;
  /** MODEL-PROMPT-ADAPTER-1：模型专用提示词 profile，供按模型版本隔离评测。 */
  promptProfile?: WriterPromptProfile;
  /** raw prompt 实际消费的身份/章卡字段，供共源审计。 */
  consumedFields?: string[];
}

export interface UnifiedOrchestratorInput {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  /**
   * @deprecated 历史短路径开关（FactGuard 后直接返回 raw）。被 fullPipelinePreview 取代，
   * 保留为向后兼容别名：入口处 normalize 为 fullPipelinePreview（同一行为）。
   */
  previewOnly?: boolean;
  /**
   * FULL-PIPELINE-PREVIEW-1：完整链路只读预览模式。
   *
   * 与旧的 previewOnly 短路不同——本模式执行完整主链路：
   * Preflight → ContextCompiler → ChapterIntent → Raw → FactGuard →
   * EditorialOpportunity → EditorialCandidate (0-2) → 中文校准候选（如机会命中）→
   * PairwiseJudge → SelectionPolicy → SpanRepair → FinalFactRecheck → FinalStateCommit
   *
   * 但跳过所有副作用：
   * - 不写章节文件（chapterFilePath=null）
   * - 不提交长期状态（stateCommit=null）
   * - 不写 trace / strategy-policy / quality-evidence / blocked-candidate-evidence
   * - 不执行代理审批阶段
   * - 不记录 Phase 6 在线学习 outcome
   *
   * 用于：预览候选生成与裁判结果，不污染工作区状态。
   */
  fullPipelinePreview?: boolean;
  /** Isolated read-only quality-ceiling sample; never used for normal delivery. */
  qualityExperiment?: QualityExperimentControl;
  /** Optional wall-clock budget for all model calls in one read-only preview. */
  previewTotalTimeoutMs?: number;
  projectRoot: string;
  /** 章节意图（ChapterIntentBuilder 输出） */
  intent: ChapterIntent;
  /** SCENE-SOLUTION-SEARCH-1：显式选择的写前方案卡；未提供时保持普通 raw。 */
  sceneSolution?: SceneSolutionCard | null;
  /** PORTABLE-CRAFT-GENE-1：显式实验臂使用的抽象叙事工艺。 */
  craftGenes?: PortableCraftGene[];
  /** PROMPT-PATTERN-ADMISSION-1：入口解析后的有准入状态提示模式。 */
  promptPatternResolution?: PromptPatternResolution;
  /** @deprecated 固定场景候选已退出生产主链路。 */
  positiveGainPromptPatternResolution?: PromptPatternResolution;
  /** @deprecated 生产主链路忽略此字段。 */
  positiveGainProductionEnabled?: boolean;
  /** CEILING-BEST-OF-3-1：1=raw+1 场景候选；2=raw+2 不同场景候选。 */
  positiveGainCandidateLimit?: 1 | 2;
  /** False while model-based literary preference is not aligned with natural-human gold. */
  allowAutomaticLiterarySelection?: boolean;
  /** 正文模型提示词表达层；生产入口按实际生成 provider 解析，eval 可显式覆盖。 */
  rawPromptProfile?: WriterPromptProfile;
  /** 编译后的上下文（ContextCompiler 输出） */
  context: CompiledContext;
  /** 作品宪法快照（可空） */
  constitution: ConstitutionSnapshot | null;
  /** Optional preloaded read-only state for post-raw methodology diagnosis. */
  methodologyDiagnosticState?: MethodologyDiagnosticState;
  /** 本章已知角色名（用于 ensemble 扫描） */
  characterNames: string[];
  /** WORLD-ONTOLOGY-1：workspace config 中声明的 closed-world levels。 */
  ontologyLevels?: string[];
  /**
   * DIALOGUE-CRAFT-1：本章可用角色声音指纹（来自接受稿/样章抽取）。
   * L0 阶段调用方可传 undefined 或空数组（无指纹加载器）；
   * 缺失时 dialogue-craft-compiler 降级为 CharacterVoice 弱代理（mentality/pendingTension）。
   */
  voiceFingerprints?: VoiceFingerprintInput[];
  /**
   * EMOTION-RHYTHM-1：本章前态情绪（来自 longTermState 或 seed.previousChapterContinuation.endingEmotion）。
   * L0 阶段调用方可传 undefined 或 null（无前态来源）；
   * 缺失时 emotion-rhythm-compiler 只输出目标情绪（intent.readerExperience），不伪造前态。
   */
  previousEmotionState?: string | null;
  /**
   * KNOWLEDGE-CONSUMPTION-1：本章可用的 few-shot 检索结果（来自 FewshotSelector）。
   *
   * L0 阶段调用方可传 undefined（无 fewshot 加载器或 manifest 未批准）；
   * 缺失时 knowledge-consumption-compiler 降级为 empty selection
   * （emptyReason="未提供 fewshot 检索结果"，不阻断生成）。
   *
   * 调用方负责：
   * 1. 实例化 FewshotSelector 并调用 select(context) 得到 FewshotSelectionResult
   * 2. 检查 manifest 准入状态（runtime/manifest.json approved）
   * 3. 把 examples / query / channel / sources / manifestApproved 传入本字段
   *
   * 编译器不直接调用 FewshotSelector（保持纯函数，便于测试）；
   * 无 manifest 准入数据不得静默加载（manifestApproved=false 强制返回 empty）。
   */
  fewshotSelection?: {
    /** FewshotSelector 选中的示例（FewshotExample 结构子集） */
    examples: ReadonlyArray<{
      id: string;
      sceneType?: string;
      text: string;
      qualityScore: number;
      source: string;
      narrativeBeat?: string;
      conflictLevel?: number;
      emotionTarget?: string;
    }>;
    /** 检索查询条件（用于推导 selectionReason；与调用 FewshotSelector 时的 context 一致） */
    query: {
      sceneType?: string;
      narrativeBeat?: string;
      conflictLevel?: number;
      emotionTarget?: string;
    };
    /** FewshotSelector 报告的通道 */
    channel: "runtime" | "flat" | "mixed" | "empty";
    /** FewshotSelector 报告的来源列表 */
    sources: ReadonlyArray<string>;
    /** manifest 准入状态（false 时强制返回 empty） */
    manifestApproved: boolean;
  };
  /** 主模型调用函数（raw + editorial + judge 的默认回退） */
  modelGenerate: ModelGenerateFn;
  /**
   * 可选异构仲裁模型（两轮冲突时用）。
   *
   * 向后兼容：B4 eval 调用方传 evalArbitratorModelGenerate 用于第三轮仲裁。
   * REAL-QUALITY-1-PREFLIGHT 路径下，仲裁应与首轮/反向同走 nb4_judge_glm，
   * 故调用方应传 judgeModelGenerate（本字段留 undefined，由编排器 fallback 到 judgeModelGenerate）。
   */
  arbitratorModelGenerate?: ModelGenerateFn;
  /**
   * REAL-QUALITY-1-PREFLIGHT：生成调用专用 modelGenerate（raw + editorial candidate + agentic_raw）。
   *
   * 当 modelTestRoute=glm 时，unified-entry 传入锁定 nb4_generate_glm 的 wrap 版本，
   * 使生成调用与判断调用分轨：raw/editorial -> nb4_generate_glm，opportunity/judge -> nb4_judge_glm。
   *
   * 未传时回退用 modelGenerate（保持原行为，向后兼容 evalMode B4 与无 routeLock 生产路径）。
   */
  generationModelGenerate?: ModelGenerateFn;
  /**
   * REAL-QUALITY-1-PREFLIGHT：判断调用专用 modelGenerate（opportunity judge + pairwise 首轮 + 反向复判 + 冲突仲裁）。
   *
   * 当 modelTestRoute=glm 时，unified-entry 传入锁定 nb4_judge_glm 的 wrap 版本。
   * 不得只把 judge wrapper 用于第三轮仲裁--opportunity/pairwise 首轮/反向复判也必须走此 fn。
   *
   * 未传时回退用 modelGenerate（保持原行为，向后兼容）。
   * 仲裁路径：arbitratorModelGenerate ?? judgeModelGenerate ?? modelGenerate（优先用显式仲裁器）。
   */
  judgeModelGenerate?: ModelGenerateFn;
  /** 由可信入口构建的控制平面；公开工具入参不暴露此字段。 */
  controlPlane?: TrustedControlPlane;
  contextSafety?: ContextSafetyResult;
  /** 随机种子（judge 匿名化，可复现） */
  seed?: number;
  /** 单候选超时 ms */
  timeoutMs?: number;
  /**
   * 可选：预暂存的状态更新（候选生成期间缓冲，最终正文选定后 commit）。
   * 由调用方在候选生成前 stage；编排器在最终正文选定后 commit。
   */
  stagedStateUpdate?: StagedStateUpdate;
  /**
   * Phase 6 在线学习：策略信誉库（可选，不传则不学习）。
   * 传入时，编排器用 Thompson Sampling 调整策略调用概率，并在裁判后记录胜负。
   */
  policyStore?: StrategyPolicyStore;
  /** Phase 6 在线学习：策略选择器（Thompson Sampling） */
  strategySelector?: ContextualStrategySelector;
  /** Phase 6 在线学习：策略结果记录器 */
  outcomeRecorder?: StrategyOutcomeRecorder;
  /**
   * Step 5：NovelOS agentic_raw 候选源（可选）。
   *
   * 当 PINOVEL_NOVELOS_SHADOW=1 时，编排器在 raw 候选生成后调用此源，
   * 产出 agentic_raw Candidate（shadow 模式下只进 trace，不影响正式交付）。
   * agentic 失败 -> 返回 null candidate，编排器回退 one_shot_raw（不 hard block）。
   *
   * 模型调用经传入的 modelGenerate（已被 wrapModelFn 包装）计入章节 SOFT/HARD 预算，
   * 但 SOFT 检查排除 agentic 调用（kind=AGENTIC_RAW_KIND="agentic_raw"），确保 shadow 不影响 editorial 路径。
   */
  agenticCandidateSource?: AgenticRawCandidateSource;
  /**
   * Eval mode（NB-4 Generation Matrix 用）：控制主链路在哪个阶段提前 return，
   * 让 B0-B4 五层共享同一 `orchestrate` 入口，禁止独立正文生成器。
   *
   * 冻结计划 §8.1 层级定义（B0-B4 逐层消融）：
   * - "B0" PureModel：one_shot_raw（空 intent + 空 context），raw 后直接交付。
   *   无 agentic、无 FactGuard、无 editorial、无 judge。
   * - "B1" CompiledContext：one_shot_raw（含 compiled context），raw 后直接交付。
   *   无 agentic、无 FactGuard、无 editorial、无 judge。
   * - "B2" AgenticRetrieval：one_shot_raw + agentic(retrieval=true, verify=false)，
   *   交付 agentic_raw。无 FactGuard、无 editorial、无 judge。
   * - "B3" VerifiedAgenticRaw：one_shot_raw + agentic(retrieval=true, verify=true) +
   *   FactGuard，交付 verified agentic_raw。无 editorial、无 judge。
   * - "B4" EditorialSelection：B3 + opportunity-driven editorial candidates +
   *   pairwise judge + select。FactGuard 启用（raw + editorial 均校验）。
   *
   * undefined = 正常生产模式（完整流程 + commit）。
   * Eval 模式不写章节文件、不提交状态（stateCommit=null, chapterFilePath=null）。
   * B0/B1/B2 跳过 FactGuard（基线层不阻断）；B3/B4 启用 FactGuard（验证层及以上）。
   */
  evalMode?: "B0" | "B1" | "B2" | "B3" | "B4";
  /**
   * Eval prefix（前文，NB-4 续写评估用）：作为 raw prompt 的"【前文】"段。
   * 由调用方从 generation-inputs 加载，B0-B4 共用同一 prefix。
   * 仅在 evalMode 非 undefined 时有意义；生产模式忽略。
   */
  evalPrefix?: string;
  /**
   * P0-3 审批闭环接通（2026-07-17）：是否在 commitAndSave 前执行代理审批阶段。
   *
   * 计划 §6.3 line 117-122 正确流程：
   * FinalFactRecheck → ChapterProxyApproval(gpt5.6-sol) → saveProxyApprovedDraft
   * → UserRevisionOrAcceptance → FinalFactRecheck(user) → FinalStateCommit → AtomicChapterSave
   *
   * - false（默认）：编排器在 finalTextCompleteness 后直接 commitAndSave（保持向后兼容）
   * - true：编排器在 finalTextCompleteness 后、commitAndSave 前插入代理审批阶段：
   *   1. 构造 packetInput（raw + selectedCandidate 作为双候选）
   *   2. 调用 runStubChapterProxyReview / runRealChapterProxyReview（透传 draftCheckpoint）
   *   3. PROXY_APPROVED + draftSaved=true → hasPendingProxyDraft=true → commitAndSave 被守护阻止
   *      → 编排器返回 status="ok" 但 chapterFilePath=null（pending 状态，等用户 finalization）
   *   4. HOLD_FOR_REGENERATION 或 draftSaved=false → shouldHardBlock=true（hard block，不写正式章节）
   *      fail-closed（核验结论第二轮 2026-07-17）：违反计划 §6.3 完成定义"用户确认前不写正式章节"
   *
   * 与 evalMode 互斥：evalMode 非 undefined 时忽略此字段（eval 不走 commit）。
   */
  enableProxyApproval?: boolean;
  /**
   * P0-3：代理审批阶段配置。enableProxyApproval=true 时必填。
   */
  proxyApprovalOptions?: {
    /** 关联的 release ID（写入 artifact） */
    releaseId: string;
    /**
     * 授权卡 JSON 路径。提供时走 runRealChapterProxyReview（真实 gpt5.6-sol）；
     * 不提供时走 runStubChapterProxyReview（stub caller，零网络调用，仅测试用）。
     */
    authorizationCardPath?: string;
    /**
     * 可注入的 caller（仅测试用 mock）。提供时优先使用，不创建新 caller。
     * 生产留 undefined 走 env 加载或 stub。
     */
    callerOverride?: ChapterProxyApprovalCaller;
    /** 审批 prompt hash */
    promptHash: string;
    /** reviewer 精确模型版本（如 "gpt5.6-sol-2026-07"） */
    modelVersion: string;
    /** 预算（forward+reverse=2 calls） */
    budget: { maxCalls: number; timeoutMs: number };
    /** 匿名映射种子（默认 Date.now()） */
    anonymousSeed?: number;
    /**
     * 可注入的 registry（仅测试用）。提供时优先使用。
     * 不提供时编排器从 workspace 路径自动加载/创建 registry。
     */
    _registryOverride?: ChapterProxyApprovalRegistry;
  };
}

export interface UnifiedOrchestratorOutput {
  /** "ok" = 成功交付（raw 或 editorial）；"blocked" = raw 失败结构化阻断 */
  status: "ok" | "blocked";
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  /** 最终交付正文 */
  text: string;
  /** 最终选中的来源：raw 或 editorial */
  selectedSource: "raw" | "editorial";
  /** 最终选中的候选 id */
  selectedCandidateId: string;
  /** 所有候选（raw + editorial） */
  candidates: Candidate[];
  /** 裁判结果（无 editorial 候选时为 null） */
  judgeResult: ArbitratorResult | null;
  /**
   * B4：全部裁判结果（每个 editorial 候选 vs raw 的完整 ArbitratorResult）。
   * judgeResult 只含最终选中候选的仲裁结果；allArbitrationResults 含全部候选的
   * 完整证据（匿名映射/verdict/spans），供 trace 完整持久化裁判过程。
   */
  allArbitrationResults: Array<{ candidateId: string; result: ArbitratorResult }>;
  /** 编辑机会扫描的 hypothesis（0-2） */
  hypotheses: import("./editorial-hypothesis.js").EditorialHypothesis[];
  /** 警告（编辑/裁判失败但仍交付 raw 时记录） */
  warnings: string[];
  /** 结构化阻断原因（status=blocked 时） */
  failureEnvelope: UnifiedFailureEnvelope | null;
  /** 阶段产物（供 trace 审计） */
  stageResults: Record<string, unknown>;
  /** 状态提交结果 */
  stateCommit: { committed: number; rejected: number } | null;
  /** 章节文件保存路径 */
  chapterFilePath: string | null;
  /**
   * FULL-PIPELINE-PREVIEW-1：标记本次运行为完整链路只读预览。
   *
   * true = 编排器执行完整 raw→editorial→judge→select→factrecheck 链路，
   * 但跳过所有副作用（不写章节、不提交状态、不写 trace/策略库/证据文件、
   * 不执行代理审批、不记录 Phase 6 学习 outcome）。
   * 调用方可据此区分正式交付与预览运行。
   */
  isPreviewRun?: boolean;
  /**
   * INTENT-COMPLETENESS-1：标记本次 ChapterIntent 含空关键字段（under-specified）。
   *
   * true = intent.underSpecifiedFields 非空（5 个关键字段中至少一个为空）。
   * 普通生成模式不阻断（仅作标记，调用方/trace 可见）；evalMode + 关键字段为空时阻断。
   * false / undefined = 未检测到空关键字段，或检测逻辑未执行（向后兼容旧 stub intent）。
   */
  isUnderSpecified?: boolean;
}

export interface UnifiedFailureEnvelope {
  stage: string;
  severity: "preflight" | "hard" | "fatal";
  reason: string;
  recoverable: boolean;
  /** raw 失败 -> hard_block（无 legacy 回退） */
  degradedTo: "hard_block";
}

export interface ControlPlaneTrace {
  packet: {
    packetId: string;
    packetHash: string;
    taskId: string;
    objective: string;
    source: string;
    valid: boolean;
    errors: string[];
  };
  policy: Record<string, unknown>;
  decisions: TrustedControlPlane["policy"]["decisions"];
  denials: TrustedControlPlane["policy"]["decisions"];
  modelLocks: {
    generation: Record<string, unknown>;
    judge: Record<string, unknown>;
  };
}
