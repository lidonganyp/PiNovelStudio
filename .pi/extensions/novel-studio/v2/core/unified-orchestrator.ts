/**
 * UnifiedOrchestrator — 统一主链路编排器（Phase 5，计划 §3 + §Phase 5）
 *
 * 正式生产主链路：NovelOS Agentic → 作者风格整章优化 → 事实复检 → commit
 *
 * 设计原则（计划 §Phase 5）：
 * - 无 whitelist：所有 workspace/chapter 走统一入口
 * - 无 generationMode：不再有 legacy/v2 双模式切换
 * - 无 v2NotImplemented → legacy 回退
 * - Agentic 或风格优化失败时结构化阻断，不静默交付 one-shot raw
 * - 机器文学裁判不进入生产；用户反馈是文学评价权威
 * - 最终正文选定后统一执行状态提交和原子保存
 *
 * 旧 raw/editorial/judge 代码仅保留给 evalMode B0-B4 与历史回放。
 *
 * 替换关系（计划 §Phase 4 + §Phase 5）：
 * - 旧 CandidateComparator（机械总分 winner）→ 不再使用
 * - 旧 FinalSelector（机械总分选择）→ 由 JudgeArbitrator + SelectionPolicy 取代
 * - 旧 v2-orchestrator 降级链（→ legacy）→ 改为 raw → hard block
 *
 * context/intent/constitution 由调用方构建传入；编排器只额外读取紧凑、只读的
 * MethodologyDiagnosticState，且该状态只能进入 raw 后诊断，不能进入 raw prompt。
 */

import { writeFileSync, mkdirSync, renameSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "node:crypto";
import type {
  Candidate,
  CandidateKind,
  CompiledContext,
  ConstitutionSnapshot,
} from "./types.js";
import { captureGenerationBaseline } from "./commit-stale-guard.js";
import { loadVerifiedDraft, saveVerifiedDraft, verifiedDraftPath } from './verified-draft-checkpoint.js';
import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { ModelGenerateFn, ModelGenerateInput } from "../adapters/legacy-model-route-adapter.js";
import { createEditorialOpportunityJudge } from "./editorial-opportunity-judge.js";
import { createLanguageRiskLibrary } from "./language-risk-library.js";
import { buildChineseAiLanguageGuidance } from "../../craft/chinese-ai-language-guidance.js";
import type { EditorialHypothesis } from "./editorial-hypothesis.js";
import {
  createEditorialCandidateGenerator,
} from "./editorial-candidate-generator.js";
import { createAuthorStyleOptimizer } from "./author-style-optimizer.js";
import type { AuthorStyleOptimizationResult } from "./author-style-optimizer.js";
import {
  selectAuthorStyleStrategies,
  mergeStrategyParams,
  buildAuthorStyleStrategyContext,
  type AuthorStyleStrategyDef,
  type AuthorStyleStrategySelection,
} from "../learning/author-style-strategy-registry.js";
import {
  loadStrategyPolicyStore,
  saveStrategyPolicyStore,
} from "../learning/strategy-policy-store.js";
import {
  createEditorialStrategyRegistry,
  type EditorialStrategyRegistry,
  type EditorialStrategyDef,
} from "./editorial-strategy-registry.js";
import { createJudgeArbitrator } from "./judge-arbitrator.js";
import type { ArbitratorResult } from "./judge-arbitrator.js";
import { getJudgeConstitutionConsumedFields } from "./judge-prompt-builder.js";
import {
  createFinalStateCommit,
  loadStateStore,
  reanchorStagedStateToFinalText,
  computeFinalTextHash,
  type StagedStateUpdate,
  type NarrativeStateEntry,
  type PatternEntry,
} from "./final-state-commit.js";
import {
  createFactContinuityGuard,
  type FactContinuityInput,
  type FactContinuityReport,
} from "./fact-continuity-guard.js";
import { scanFinalTextCompleteness } from "./final-text-completeness-guard.js";
// BLOCKED-CANDIDATE-EVIDENCE-1：hard-block raw 候选安全证据留存（派工计划 P0-A）
// 在 raw 被 FactGuard/completeness/control_plane hard block 时，保留完整 redacted raw、
// SHA-256、长度、finishReason、诊断 span 到隔离 artifact，不保存章节、不提交状态。
import {
  buildBlockedCandidateEvidence,
  saveBlockedCandidateEvidence,
  saveBlockedCandidateEvidenceToRecoveryPath,
  type BlockedCandidateEvidence,
} from "./blocked-candidate-evidence.js";
import { compileIdentityContract, collectAllKnownNames } from "./identity-contract-compiler.js";
import { compileOntologyContract, type OntologyContract } from "./ontology-contract-compiler.js";
// DEMO-3-R2：editorial 故事骨架保持门禁（stage5a.1）
// 在 FactGuard（事实硬伤）之后、JudgeArbitrator（LLM 裁判）之前插入，
// 确定性检查 editorial 是否删除 raw 关键事件并替换故事线。
import {
  checkEditorialStoryPreservation,
  type StoryPreservationGateReport,
} from "./editorial-story-preservation-gate.js";
// QUALITY-3：最小章节结构证据提取（只诊断不改文，不触发语言润色/候选生成）
import {
  scanStructuralEvidence,
  toChapterQualityEvidence,
  skippedChapterQualityEvidence,
  type StructuralEvidenceScanInput,
} from "./structural-evidence-scanner.js";
import type { ChapterQualityEvidence } from "./chapter-quality-evidence.js";
// QUALITY-4：本章相关承诺状态编译（只编译 selectedPromisesToAdvance 命中项，不灌全量 PromiseLedger）
import {
  compilePromiseContext,
  type PromiseContext,
} from "./promise-context-compiler.js";
// EXPECTATION-LEDGER-1：本章相关读者期待状态编译（只编译 selectedExpectationsToAdvance 命中项，不灌全量 ExpectationLedger）
import {
  compileExpectationContext,
  type ExpectationContext,
} from "./expectation-context-compiler.js";
// GENRE-CONTRACT-1：本章类型读者承诺编译（声明类型 + 漂移检测 + constitution.genrePromises + 清洗后 type-dataset；advisory 非硬门）
import {
  compileGenreContract,
  type GenreContractContext,
} from "./genre-contract-compiler.js";
// DIALOGUE-CRAFT-1：本章发言角色声音指纹 + 对白工艺 advisory 编译（仅本章发言角色；指纹带来源；advisory 非硬门；不强制对白比例）
import {
  compileDialogueCraftContext,
  type DialogueCraftContext,
  type VoiceFingerprintInput,
} from "./dialogue-craft-compiler.js";
// EMOTION-RHYTHM-1：事件驱动情绪节拍 advisory 编译（目标+前态+rawText 转折扫描；不含机械曲线配额；advisory 非硬门）
import {
  compileEmotionRhythmContext,
  type EmotionRhythmContext,
} from "./emotion-rhythm-compiler.js";
// SUPPORTING-FUNCTION-1：配角章节功能层 advisory 编译（foil/witness/obstacle/helper/cost-bearer；功能需正文行为 span 支持）
import {
  compileSupportingFunctionContext,
  type SupportingFunctionContext,
} from "./supporting-function-compiler.js";
// KNOWLEDGE-CONSUMPTION-1：few-shot/contrastive 生产消费审计（包装 FewshotSelector 检索结果为带审计字段的 compact block；advisory 非强制模仿）
import {
  compileKnowledgeConsumptionContext,
  type KnowledgeConsumptionContext,
} from "./knowledge-consumption-compiler.js";
// QUALITY-5：本章相关角色声音/状态提示编译（只编译 focusCharacterGoals ∪ relevantCharacters 命中项，不灌全量 characterStates）
import {
  compileCharacterVoiceContext,
  type CharacterVoiceContext,
} from "./character-voice-compiler.js";
// QUALITY-6：本章世界约束与类型承诺编译（所有 worldRules 进入 entries + immutable_fact 交叉引用 intent.inviolableFacts + genrePromises 新数据）
import {
  compileWorldPresentationContext,
  type WorldPresentationContext,
} from "./world-presentation-compiler.js";
// QUALITY-7：本章角色层次编译（焦点/在场分层，focusCharacterGoals ∪ relevantCharacters 命中项）
import {
  compileEnsembleLayeringContext,
  type EnsembleLayeringContext,
} from "./ensemble-layering-compiler.js";
// QUALITY-8：信息释放证据扫描（finalText 确定后扫描信息灌输/行动承载，只诊断不改文）
import {
  scanInformationReleaseEvidence,
  toInformationReleaseEvidenceReport,
  skippedInformationReleaseEvidence,
  type InformationReleaseScanInput,
  type InformationReleaseEvidenceReport,
} from "./information-release-evidence-scanner.js";
// QUALITY-9：章末收束/钩子证据扫描（finalText 确定后扫描尾段压力/总结式结尾/钩子问句，只诊断不改文）
import {
  scanEndingCraftEvidence,
  toEndingCraftEvidenceReport,
  skippedEndingCraftEvidence,
  type EndingCraftScanInput,
  type EndingCraftEvidenceReport,
} from "./ending-craft-evidence-scanner.js";
// QUALITY-10：质量证据统一汇总（聚合 QUALITY-3/8/9 三源诊断证据为可读可回放证据包，只汇总不评分）
import {
  buildCraftEvidenceEnvelope,
  skippedCraftEvidenceEnvelope,
  type BuildCraftEvidenceEnvelopeInput,
} from "./craft-evidence-envelope.js";
// QUALITY-11：证据感知编辑机会 advisory（raw 阶段 craft evidence → editorial opportunity/candidate 的诊断上下文）
import {
  compileEditorialOpportunityAdvisory,
  skippedEditorialOpportunityAdvisory,
  type EditorialOpportunityAdvisory,
} from "./editorial-opportunity-advisory.js";
// QUALITY-12：候选对诊断证据的响应 trace（editorial candidate 是否回应了 raw craft evidence advisory）
import {
  compileEditorialEvidenceResponseTrace,
  skippedEditorialEvidenceResponseTraceSet,
  type EditorialEvidenceResponseTrace,
  type CompileTraceInput,
} from "./editorial-evidence-response-trace.js";
// QUALITY-13：候选是否未回应关键诊断证据的风险审计 advisory（基于 QUALITY-12 trace，只审计不评胜负）
import {
  compileEditorialCandidateRiskAdvisory,
  skippedEditorialCandidateRiskAdvisorySet,
  type CompileRiskAdvisoryInput,
} from "./editorial-candidate-risk-advisory.js";
// QUALITY-14：裁判证据审计附件（把 QUALITY-12/13 输出挂到 judge evidence，post-judge 只读，不改 prompt/winner）
import {
  compileJudgeEvidenceAdvisoryAttachment,
  skippedJudgeEvidenceAdvisoryAttachment,
  type CompileAttachmentInput,
} from "./judge-evidence-advisory-attachment.js";
// QUALITY-15：单次生成运行质量证据报告（汇总 QUALITY-10~14 证据链为可读报告，只做报告不做裁判/门禁）
import {
  compileQualityEvidenceRunReport,
  skippedQualityEvidenceRunReport,
  type CompileRunReportInput,
} from "./quality-evidence-run-report.js";
import type { StrategyPolicyStore } from "../learning/strategy-policy-store.js";
import { detectModelVersion } from "../learning/model-version-migration.js";
import type {
  ContextualStrategySelector,
} from "../learning/contextual-strategy-selector.js";
import type {
  StrategyOutcomeRecorder,
  JudgeOutcome,
  SelectionOutcome,
} from "../learning/strategy-outcome-recorder.js";
// Step 5：NovelOS agentic_raw 候选源接口（type-only，无运行时依赖）
// 编排器通过此接口调用 NovelOS agentic 生成，不直接依赖 NovelOS 内部模块。
import type {
  AgenticRawCandidateSource,
  AgenticRawSourceResult,
} from "../../novelos/agent/agentic-raw-candidate-source.js";
// Step 1d 修复：导入 AGENTIC_RAW_KIND 共享常量，SOFT 预算过滤器用此 kind
// 排除 agentic 调用（与路由名 AGENTIC_RAW_ROUTE="novelos_agentic" 区分，二者不可混用）。
import { AGENTIC_RAW_KIND } from "../../novelos/agent/agentic-raw-candidate-source.js";
import { checkCandidateTextHashBinding, hashText } from "./candidate-revision-store.js";
import {
  mergeChapterContinuation,
  hasContinuationPrefixMismatch,
  hasCompleteChapterEcho,
  repairAdjacentDuplicateParagraphs,
} from "./chapter-continuation.js";
import {
  assessTargetLength,
  repairDuplicateFindings,
  type DuplicateFindingLike,
} from "./generation-recovery.js";
import type { ContextSafetyResult } from "./context-safety.js";
import { buildProtectedContextOverflowFailure } from "./context-package-production.js";
import { createMethodologyDiagnosticStateLoader } from "./methodology-diagnostic-state.js";
import {
  buildTrustedControlPlane,
  validateModelLock,
  validateNovelTaskPacket,
  type CapabilityName,
  type ModelLock,
  type TrustedControlPlane,
} from "./control-plane.js";
import { assertModelCallMatchesLock } from "./run-routing-context.js";
import {
  assertOrchestratorCommitActor,
} from "./autonomy-policy.js";
import {
  buildProductionFailureEnvelope,
  toUnifiedFailureEnvelope,
  budgetSnapshotForTrace,
} from "./failure-envelope.js";
import { mapLegacyFailureClass } from "./failure-types.js";
import { createRecoveryStateMachine } from "./recovery-state-machine.js";
import { saveRecoveryCheckpoint } from "./recovery-checkpoint.js";
import { matchRecoveryPolicy } from "./recovery-policy.js";
import {
  createRecoveryBudget,
  reserveBudget,
  snapshotBudget,
} from "./recovery-budget.js";
import type { RecoveryBudget } from "./recovery-types.js";
// BG-01：统一预算账本（真实模型调用前 reserve / 调用后 settle）。
// 与 layered budget / RecoveryBudget 并存接线；别名避免与 recovery-budget 的 reserveBudget 冲突。
import {
  createBudgetLedger,
  getBudgetLedger,
  type BudgetLedger,
  type BudgetStage as LedgerBudgetStage,
} from "./budget-ledger.js";
import {
  admitProductionModelCall,
  settleProductionModelCall,
} from "./budget-admission.js";
import { seedBudgetLedgerStoreIfAbsent } from "./budget-ledger-store.js";
import {
  createRoutingGovernanceState,
  projectModelCall,
  recordFailureStrategy,
  buildGovernanceReports,
  attachGovernanceReports,
  getGovernanceState,
  setGovernanceState,
  type RoutingGovernanceState,
} from "./routing-governance-runtime.js";
// MA：多代理工作包 / 结果契约 / 编排器裁决（写入 stageResults.agentCollaboration）
import {
  attachCollaborationToStageResults,
  buildRoleWorkPackage,
  createCollaborationTraceState,
  guardCommitStages,
  recordAgentResult,
  recordSystemDecision,
  recordWorkPackage,
  requireWorkPackageInput,
  type CollaborationTraceState,
} from "./agent-collaboration-runtime.js";
import {
  adaptCommitResult,
  adaptDraftFromAgenticSource,
  adaptEditorialResult,
  adaptFactGuardResult,
  adaptStoryPreservationResult,
} from "./agent-result-adapters.js";
import {
  classifyCollaborationContractError,
  collaborationFailureGuidance,
  formatCollaborationFailureReason,
} from "./agent-collaboration-fail-closed.js";
import { buildAgentLineageIndex } from "./agent-lineage-index.js";
import { getModelRequestTimeoutMs } from "../../api/request-timeout.js";
import { runWithTransportRecovery } from '../../api/transport-scope.js';

// ============================================================================
// 类型与常量（行为保持重构 Step 1：已抽出到 orchestrator-types.ts）
// ============================================================================
import {
  RAW_ROUTE,
  EDITORIAL_ROUTE,
  RAW_KIND,
  DEFAULT_RAW_TIMEOUT_MS,
  MAX_RAW_EMPTY_RETRIES,
  type ModelCallEntry,
  type UnifiedOrchestratorInput,
  type UnifiedOrchestratorOutput,
  type UnifiedFailureEnvelope,
  type ControlPlaneTrace,
  type HardBlockGuidance,
  type ProgressEvent,
} from "./orchestrator-types.js";
// 公共类型 re-export：保留 unified-orchestrator.js 原有导出面（unified-entry / legacy-trace-adapter 等消费）
export type {
  ModelCallEntry,
  UnifiedOrchestratorInput,
  UnifiedOrchestratorOutput,
  UnifiedFailureEnvelope,
  HardBlockGuidance,
  ProgressEvent,
} from "./orchestrator-types.js";

import {
  commitAndSave,
  atomicSave,
  extractPatternEntriesFromText,
  chapterFilePath,
} from "./orchestrator-commit-save.js";
// P0-3 审批闭环接通（2026-07-17）：代理审批阶段（在 commitAndSave 前，opt-in）
// 计划 §6.3：FinalFactRecheck → ChapterProxyApproval → saveProxyApprovedDraft
// → UserRevisionOrAcceptance → FinalFactRecheck(user) → FinalStateCommit → AtomicChapterSave
import { runProxyApprovalStage, type ProxyApprovalOutcome } from "./orchestrator-proxy-approval.js";
import {
  generateRaw,
  buildRawPrompt,
  buildIntentSummary,
} from "./orchestrator-raw.js";
import {
  runEditorialEvidenceResponseTraces,
  runEditorialCandidateRiskAdvisory,
  runJudgeEvidenceAdvisoryAttachment,
  runQualityEvidenceRunReport,
  exportQualityEvidenceReport,
  qualityEvidenceReportFilePath,
} from "./orchestrator-quality.js";
import {
  checkCandidateFactGuard,
  runLanguageRiskAnalysis,
  runStructuralEvidenceScan,
  runInformationReleaseScan,
  runEndingCraftScan,
  runCraftEvidenceEnvelope,
  runRawCraftAdvisory,
  scanRawStructuralEvidence,
  scanRawInformationRelease,
  scanRawEndingCraft,
} from "./orchestrator-factguard.js";




function preserveContinuationStyleResult(
  result: AuthorStyleOptimizationResult,
  input: UnifiedOrchestratorInput,
  sourceCandidateText?: string,
): AuthorStyleOptimizationResult {
  if (!result.candidate) {
    return result;
  }
  if (
    input.continuationMode === "append" &&
    input.currentChapterDraft?.trim() &&
    hasContinuationPrefixMismatch(input.currentChapterDraft, result.candidate.text)
  ) {
    return {
      ...result,
      candidate: null,
      failureKind: "continuation_prefix_mismatch",
      failureReason: "风格优化结果改写了作者续写前缀，已拒绝静默合并并请求定向重试。",
    };
  }
  const mergedText = input.continuationMode === "append" && input.currentChapterDraft?.trim()
    ? mergeChapterContinuation(input.currentChapterDraft, result.candidate.text)
    : result.candidate.text;
  // Check both the raw model response and the host-merged continuation. In
  // append mode a provider may return only a rewritten suffix; merging the
  // protected draft can then create the same full-chapter + rewrite echo even
  // though the response itself did not start with the source chapter.
  if (
    sourceCandidateText
    && hasCompleteChapterEcho(sourceCandidateText, mergedText)
  ) {
    return {
      ...result,
      candidate: null,
      failureKind: "complete_chapter_echo",
      failureReason: "风格优化结果先完整复制初稿，又追加大段二次整章改写，已拒绝重复候选并请求定向重试。",
    };
  }
  const text = repairAdjacentDuplicateParagraphs(
    mergedText,
    input.continuationMode === "append" ? input.currentChapterDraft ?? "" : "",
  );
  if (text === result.candidate.text) return result;
  return {
    ...result,
    candidate: {
      ...result.candidate,
      id: `${result.candidate.id}:continuation:${hashText(text).slice(0, 16)}`,
      text,
    },
  };
}

// ============================================================================
// UnifiedOrchestrator 主类
// ============================================================================

export class UnifiedOrchestrator {
  /**
   * 执行单一生成主链路。
   *
   * 流程：
   * 1. 生成 raw（模型调用 + 空文本重试）
   * 2. FactGuard 校验 raw（失败 → hard block）
   * 3. EditorialOpportunityJudge 扫描 raw → hypotheses（0-2）
   * 4. 无 hypothesis → 交付 raw + warning
   * 5. EditorialCandidateGenerator 生成 editorial 候选
   * 6. 无 editorial 候选 → 交付 raw + warning
   * 7. JudgeArbitrator 裁判 raw vs editorial
   * 8. 选择：amplified 胜出 → 交付 editorial；否则 → 交付 raw
   * 9. FinalStateCommit + 原子保存
   */
  async orchestrate(input: UnifiedOrchestratorInput): Promise<UnifiedOrchestratorOutput> {
    const {
      workspaceId, chapterId, chapterNumber, projectRoot,
      intent, context, constitution, characterNames,
      modelGenerate, arbitratorModelGenerate,
      generationModelGenerate,
      judgeModelGenerate,
    } = input;

    const warnings: string[] = [];
    const stageResults: Record<string, unknown> = {};
    // CONCURRENCY-WAVE4：生成开始时捕获环境基线（active releaseId + constitutionHash
    // + narrative-state-store 磁盘 revision）。commitAndSave 提交边界与基线比对，
    // 漂移 -> stale_release / constitution_changed / stale_state_revision 阻断；
    // 状态提交另有 FinalStateCommit.commit 内 baseStateRevision CAS 第二道防线。
    // 捕获失败（pointer 损坏）→ 记录结构化错误并保留 null 基线：提交边界检测时
    // readActiveProductionReleaseId 会再次抛错并 fail-closed，不会静默跳过。
    try {
      stageResults.generationBaseline = captureGenerationBaseline(
        projectRoot,
        workspaceId,
        input.executionReleaseId,
      );
    } catch (e) {
      stageResults.generationBaselineCaptureError = {
        reason: (e as Error).message,
        at: new Date().toISOString(),
      };
    }
    const automaticQualityWinnerSelectionEnabled = input.allowAutomaticLiterarySelection !== false;
    stageResults.qualitySelectionPolicy = {
      mode: automaticQualityWinnerSelectionEnabled ? "quality_winner" : "advisory_only",
      automaticQualityWinnerSelectionEnabled,
      rawRole: "baseline_and_unresolved_comparison_fallback",
    };
    // Backward-compatible trace key. Human alignment is no longer inferred
    // from whether automatic product selection is enabled.
    stageResults.judgeAlignmentGate = {
      naturalHumanAlignmentPassed: null,
      automaticLiterarySelectionEnabled: automaticQualityWinnerSelectionEnabled,
      mode: automaticQualityWinnerSelectionEnabled
        ? "quality_winner_selection"
        : "advisory_candidates_human_review",
    };
    const candidates: Candidate[] = [];
    const previewStartedAt = Date.now();
    const previewBudget = input.fullPipelinePreview && input.previewTotalTimeoutMs
      ? { totalMs: input.previewTotalTimeoutMs, capped: false, elapsedMs: 0 }
      : null;
    if (previewBudget) stageResults.previewBudget = previewBudget;

    const controlPlane = input.controlPlane ?? buildTrustedControlPlane({
      taskId: "UNIFIED-PIPELINE-COMPAT",
      objective: "兼容既有内部调用并提供控制平面审计",
      scope: ["unified-orchestrator"],
      allowedResources: ["internal:model", "internal:workspace"],
      forbiddenResources: ["public:capability-escalation"],
      generationLock: { route: "runtime", provider: "runtime", model: "runtime" },
      judgeLock: { route: "runtime", provider: "runtime", model: "runtime" },
      modelTransport: "local",
      enforceModelLocks: false,
      source: "internal-compat",
    });
    const packetErrors = validateNovelTaskPacket(controlPlane.packet);
    input.controlPlane = controlPlane;
    const controlTrace: ControlPlaneTrace = {
      packet: {
        packetId: controlPlane.packet.packetId,
        packetHash: controlPlane.packet.packetHash,
        taskId: controlPlane.packet.taskId,
        objective: controlPlane.packet.objective,
        source: controlPlane.packet.source,
        valid: packetErrors.length === 0,
        errors: packetErrors,
      },
      policy: controlPlane.policy.summary(),
      decisions: controlPlane.policy.decisions,
      denials: [],
      modelLocks: {
        generation: this.modelLockEvidence(controlPlane.packet.modelLocks.generation, controlPlane.executionLocks.generation),
        judge: this.modelLockEvidence(controlPlane.packet.modelLocks.judge, controlPlane.executionLocks.judge),
      },
      ...(input.runRouting
        ? {
            runRouting: {
              orchestratorRunId: input.runRouting.orchestratorRunId,
              generationRoute: input.runRouting.generationRoute,
              editorialRoute: input.runRouting.editorialRoute,
              provider: input.runRouting.provider,
              model: input.runRouting.model,
              modelVersion: input.runRouting.modelVersion,
              routeClass: input.runRouting.routeClass,
              fallbackPolicy: input.runRouting.fallbackPolicy,
              budgetProfile: input.runRouting.budgetProfile,
              explicitWriterSelection: input.runRouting.explicitWriterSelection,
              writerModel: input.runRouting.writerModel,
              temperature: input.runRouting.temperature,
              maxTokens: input.runRouting.maxTokens,
              timeout: input.runRouting.timeout,
              promptBundleHash: input.runRouting.promptBundleHash,
              contextHash: input.runRouting.contextHash,
            },
          }
        : {}),
    };
    stageResults.controlPlane = controlTrace;

    // MA：多代理协作 trace 状态（工作包 / 结果契约 / 裁决记录）
    const collabState: CollaborationTraceState = createCollaborationTraceState({
      orchestratorRunId:
        typeof (stageResults as { orchestratorRunId?: string }).orchestratorRunId === "string"
          ? String((stageResults as { orchestratorRunId?: string }).orchestratorRunId)
          : `run:${workspaceId ?? "default"}:${chapterId}:${Date.now()}`,
      workspaceId: workspaceId ?? "default",
      chapterId: chapterId ?? String(chapterNumber),
      taskId: controlPlane.packet.taskId,
      contextHash:
        typeof (input.context as { contextHash?: unknown } | undefined)?.contextHash === "string"
          ? String((input.context as { contextHash?: string }).contextHash)
          : `ctx:${workspaceId}:${chapterId}`,
      constraintManifestHash: input.contextSafety?.manifest
        ? String(
            (input.contextSafety.manifest as { hash?: string }).hash ??
              "manifest-present",
          )
        : undefined,
      modelLock: controlPlane.executionLocks?.generation,
    });
    stageResults.orchestratorRunId = collabState.orchestratorRunId;
    // 挂到 stageResults，供 hardBlock 出口统一 attach（hardBlock 不接收 collabState 参数）
    (stageResults as Record<string, unknown>)._agentCollabState = collabState;
    const finishWithCollab = <T extends UnifiedOrchestratorOutput>(out: T): T => {
      attachCollaborationToStageResults(stageResults, collabState);
      const lineageIndex = buildAgentLineageIndex({
        stageResults,
        orchestratorRunId: collabState.orchestratorRunId,
        workspaceId: collabState.workspaceId,
        chapterId: collabState.chapterId,
      });
      const deliveredCandidateId =
        typeof (out as { selectedCandidateId?: unknown }).selectedCandidateId === "string"
          ? String((out as { selectedCandidateId: string }).selectedCandidateId)
          : typeof stageResults.selectedCandidateId === "string"
            ? stageResults.selectedCandidateId
          : null;
      if (out.status === "ok" && deliveredCandidateId) {
        const deliveredEntries = lineageIndex.byCandidate[deliveredCandidateId] ?? [];
        if (deliveredEntries.length === 0) {
          return this.hardBlock(
            input,
            "agent_lineage",
            `最终候选缺少可查询血缘：${deliveredCandidateId}`,
            stageResults,
            undefined,
            {
              gate: "agent_lineage",
              severityOverride: "hard",
              recoverable: false,
              evidence: [`candidate=${deliveredCandidateId}`],
              candidateDisposition: "blocked_evidence_only",
            },
          ) as T;
        }
      }
      stageResults.agentLineageIndex = lineageIndex;
      // WP-03..07：成功/阻断出口统一挂载治理报告（可从 quality-trace 验收）
      // 状态只从 stageResults 读取，避免与下方 recoveryBudget 初始化顺序耦合。
      const govState =
        getGovernanceState(stageResults) ??
        createRoutingGovernanceState({
          runRouting: input.runRouting,
          recoveryBudget: stageResults.recoveryBudget as RecoveryBudget | undefined,
        });
      const reports = buildGovernanceReports(govState, {
        modelCalls: (stageResults.modelCalls as ModelCallEntry[] | undefined) ?? [],
        delivered: out.status === "ok",
        factGuardPassed:
          typeof stageResults.agenticFactGuard === "object" && stageResults.agenticFactGuard
            ? (stageResults.agenticFactGuard as { passed?: boolean }).passed !== false
            : out.status === "ok",
        storyPreservationPassed:
          typeof stageResults.storyPreservation === "object" && stageResults.storyPreservation
            ? (stageResults.storyPreservation as { passed?: boolean }).passed !== false
            : out.status === "ok",
        recoveryAssisted: govState.layeredBudget.recovery.usedModelCalls > 0,
        lastFailureDecision: (stageResults._lastFailureStrategyDecision as
          | ReturnType<typeof recordFailureStrategy>["decision"]
          | undefined),
        lastFailureType: stageResults._lastFailureType as
          | import("./failure-strategy-matrix.js").FailureType
          | undefined,
      });
      attachGovernanceReports(stageResults, reports);
      // 同步 layered → legacy recovery 快照（外层重试可读）
      stageResults.recoveryBudget = govState.layeredBudget.legacyRecovery;
      stageResults.recoveryBudgetSnapshot = budgetSnapshotForTrace(
        govState.layeredBudget.legacyRecovery,
      );
      // BG-01：落盘最终统一预算账本快照（trace 验收 + 外层重试读取 budgetLedger 延续）
      stageResults.budgetLedger = getBudgetLedger(budgetLedgerState);
      delete (stageResults as Record<string, unknown>)._budgetLedgerState;
      delete (stageResults as Record<string, unknown>)._agentCollabState;
      delete (stageResults as Record<string, unknown>)._routingGovernanceState;
      delete (stageResults as Record<string, unknown>)._lastFailureStrategyDecision;
      delete (stageResults as Record<string, unknown>)._lastFailureType;
      return out;
    };

    // RECOVERY-P2：章节级全局恢复预算（贯穿本 orchestrate 调用）
    // 总预算不因阶段切换重置；外层重试通过 _priorRecoveryBudget 延续累计消耗。
    const recoveryBudget: RecoveryBudget = input._priorRecoveryBudget
      ? { ...input._priorRecoveryBudget }
      : createRecoveryBudget(
          input.recoveryBudgetOverrides as Partial<RecoveryBudget> | undefined,
        );
    const recoveryMachine = createRecoveryStateMachine("running");
    // 挂到 stageResults，供 hardBlock / deliverRaw 守卫读写（同一次 orchestrate 共享）
    stageResults.recoveryBudget = recoveryBudget;
    stageResults.recoveryBudgetSnapshot = budgetSnapshotForTrace(recoveryBudget);
    stageResults.recoveryLifecycle = { state: recoveryMachine.state };
    stageResults._recoveryMachine = recoveryMachine;

    // BG-01：统一预算账本（真实模型调用前 reserve / 调用后 settle）。
    // 外层 model_timeout 重试通过 _priorBudgetLedger 延续累计消耗，禁止每轮重置。
    let budgetLedgerState: BudgetLedger = input._priorBudgetLedger
      ? { ...input._priorBudgetLedger }
      : createBudgetLedger();
    stageResults._budgetLedgerState = budgetLedgerState;
    stageResults.budgetLedger = getBudgetLedger(budgetLedgerState);

    // WP-03..07：分层预算仅作兼容投影；生产准入权威是 BudgetLedger。
    let routingGovernance: RoutingGovernanceState = createRoutingGovernanceState({
      runRouting: input.runRouting,
      recoveryBudget,
    });
    setGovernanceState(stageResults, routingGovernance);

    if (input.contextSafety) {
      stageResults.contextBudgetReport = input.contextSafety.report;
      if (!input.contextSafety.ok) {
        const overflow = input.contextSafety.blockReason === "protected_context_overflow"
          || input.contextSafety.blockReason === "context_overflow";
        const overflowFailure = overflow
          ? buildProtectedContextOverflowFailure(input.contextSafety)
          : null;
        return this.hardBlock(
          input,
          "context_safety",
          overflowFailure?.reason ?? `上下文安全阻断：${input.contextSafety.blockReason}`,
          stageResults,
          undefined,
          {
            gate: overflowFailure?.gate ?? "context_package_validation",
            recoverable: false,
            evidence: overflowFailure?.evidence ?? { blockReason: input.contextSafety.blockReason },
            userActionRequired: overflowFailure?.userActionRequired
              ?? ["检查硬约束冲突或缩短本章作者契约后重试"],
            retryPlan: { strategy: "revise_inputs_and_retry_same_chapter", maxAttempts: 1 },
          },
        );
      }
    }
    if (input.context.longTermState?.retrievalReport) {
      stageResults.contextRetrievalReport = input.context.longTermState.retrievalReport;
      stageResults.contextRetrievalPromptItems = input.context.longTermState.promptItems ?? [];
    }
    // ── Phase 2A：风格档案兜底检查（advisory，不阻断） ──────────────────
    // Phase 1 曾用 hardBlock 阻断缺风格档案的运行；Phase 2A 起，完整 Preflight 已在
    // runUnifiedPipeline 入口执行（含 style_profile 检查），此处仅作兜底 advisory：
    // - 生产路径若绕过 runUnifiedPipeline 直接调 orchestrate（如 eval 直调），此处仍能
    //   记录缺失证据到 stageResults.preflightStyleProfile，但不阻断生成。
    // - 真正的阻断由 runUnifiedPipeline 的 preflightWorkspace 负责（severity=preflight）。
    // evalMode / qualityExperiment / fullPipelinePreview 跳过（不交付正式正文）。
    if (!input.evalMode && !input.qualityExperiment && !input.fullPipelinePreview) {
      const hasStyleFingerprint = input.context.styleReferences.some(
        (entry) => entry.kind === "fingerprint",
      );
      if (!hasStyleFingerprint) {
        // Phase 2A：降级为 advisory warning，不再 hardBlock。
        // 缺风格档案会让风格优化无候选 → 由作者风格整章优化阶段自身的 hard block 处理
        // （Phase 1 已确保风格优化失败 = hard block，selectedSource=null）。
        // 此处只记录 advisory，让 trace 读者知道预检缺口。
        const advisoryMsg = "workspace 缺少 style_profile 风格指纹文档（kind=fingerprint）；作者风格优化阶段可能无候选，建议在 workspaces/{id}/ 下创建风格档案或合成默认档案";
        warnings.push(advisoryMsg);
        stageResults.preflightStyleProfile = {
          passed: false,
          advisory: true,
          reason: advisoryMsg,
        };
      } else {
        stageResults.preflightStyleProfile = { passed: true };
      }
    }
    if (packetErrors.length > 0) {
      return this.hardBlock(input, "control_plane_packet", `NovelTaskPacket 校验失败：${packetErrors.join("; ")}`, stageResults);
    }
    if (controlPlane.enforceModelLocks) {
      const generationLockErrors = validateModelLock(
        controlPlane.packet.modelLocks.generation,
        controlPlane.executionLocks.generation,
      );
      if (generationLockErrors.length > 0) {
        return this.hardBlock(input, "control_plane_generation_lock", `generation model lock 冲突：${generationLockErrors.join("; ")}`, stageResults);
      }
    }

    // ── Step 1c：模型调用遥测 + 阶段计时 ─────────────────────────────
    // modelCallLog/stageTiming 作为 live 引用挂到 stageResults，所有 return 路径
    // （含 deliverRaw/hardBlock）自动带上最新遥测，无需在每个 return 前重复赋值。
    const modelCallLog: ModelCallEntry[] = [];
    const stageTiming: Record<string, number> = {};
    stageResults.modelCalls = modelCallLog;
    stageResults.stageTiming = stageTiming;
    if (input.qualityExperiment) {
      stageResults.qualityExperiment = {
        arm: input.qualityExperiment.arm,
        sampleIndex: input.qualityExperiment.sampleIndex,
        isolated: true,
        sceneSolutionSource: input.qualityExperiment.arm === "raw"
          ? "none"
          : input.qualityExperiment.arm === "oracle_scene"
            ? "human_oracle"
            : "automated_search",
      };
    }

    // 计数装饰器：拦截每次模型调用，记录 route/kind/model/duration/ts。
    // 包装后的 fn 传给 oppJudge/candGen/arb；generateRaw 经 orchInput 使用包装版。
    // Step 1d 修复：
    //   - 失败请求也计数（catch 里 push failed:true），否则 used=0 但 attempts=1，预算门控失效。
    //   - 硬上限每次调用前检查（所有 LLM 调用都经此包装），拦截 arbitrate 内部多轮穿透 HARD。
    const wrapModelFn = (
      fn: ModelGenerateFn | undefined,
      fnKind: string,
    ): ModelGenerateFn | undefined => {
      if (!fn) return undefined;
      return async (genInput: ModelGenerateInput) => {
        const start = Date.now();
        if (previewBudget) {
          const elapsedMs = Date.now() - previewStartedAt;
          const remainingMs = previewBudget.totalMs - elapsedMs;
          previewBudget.elapsedMs = elapsedMs;
          if (remainingMs <= 0) {
            previewBudget.capped = true;
            throw new Error(`fullPipelinePreview total timeout exceeded ${previewBudget.totalMs}ms`);
          }
          genInput = {
            ...genInput,
            timeoutMs: Math.max(1, Math.min(genInput.timeoutMs ?? remainingMs, remainingMs)),
          };
        }
        const capability: CapabilityName = fnKind === "generationModelGenerate"
          ? "model.generate"
          : "model.judge";
        const permission = this.authorizeCapability(
          controlPlane,
          controlTrace,
          capability,
          `${fnKind}:${genInput.kind}`,
        );
        if (!permission.allowed) {
          throw new Error(`capability denied: ${capability}`);
        }
        if (controlPlane.modelTransport === "network") {
          const networkPermission = this.authorizeCapability(
            controlPlane,
            controlTrace,
            "network.model_call",
            `${fnKind}:${genInput.kind}`,
          );
          if (!networkPermission.allowed) {
            throw new Error("capability denied: network.model_call");
          }
        }
        const expectedLock = capability === "model.generate"
          ? controlPlane.packet.modelLocks.generation
          : controlPlane.packet.modelLocks.judge;
        // WP-01：任务级运行锁 — 每次模型调用前校验身份/参数，不匹配则不发起调用。
        if (input.runRouting && controlPlane.enforceModelLocks) {
          const role =
            capability === "model.judge"
              ? "judge"
              : genInput.route?.includes("amplified") || genInput.kind?.includes("style")
                ? "editorial"
                : "generation";
          // 生产主链路（agentic_style）禁止文学裁判调用
          const lockCheck = assertModelCallMatchesLock({
            routing: input.runRouting,
            stage: genInput.kind ?? fnKind,
            route: genInput.requestedRoute ?? genInput.route,
            provider: expectedLock.provider,
            model: expectedLock.model,
            modelVersion: input.runRouting.modelVersion,
            temperature: genInput.temperature,
            maxTokens: genInput.maxTokens,
            timeout: genInput.timeoutMs,
            role: input.productionFlow === "agentic_style" && role === "judge" ? "judge" : role,
          });
          // judge 在 agentic_style 生产流：直接阻断
          if (
            input.productionFlow === "agentic_style" &&
            input.runRouting.routeClass === "production" &&
            capability === "model.judge"
          ) {
            throw new Error(
              `model lock conflict: production literary judge calls are forbidden (${genInput.route})`,
            );
          }
          // provider/model 漂移：若 output 侧将来回填，前置用 expectedLock 与 runRouting 比对
          if (
            expectedLock.provider !== input.runRouting.provider &&
            capability === "model.generate"
          ) {
            throw new Error(
              `model lock conflict: provider expected=${input.runRouting.provider} actual=${expectedLock.provider}`,
            );
          }
          if (
            expectedLock.model !== input.runRouting.model &&
            capability === "model.generate"
          ) {
            throw new Error(
              `model lock conflict: model expected=${input.runRouting.model} actual=${expectedLock.model}`,
            );
          }
          if (!lockCheck.ok && capability === "model.generate") {
            // 仅当错误包含跨 class / provider / model 时硬阻断；纯 route 别名告警由 assert 内部消化
            const hard = lockCheck.errors.some(
              (e) =>
                e.includes("provider") ||
                e.includes("model ") ||
                e.includes("cannot call") ||
                e.includes("forbidden") ||
                e.includes("mismatch"),
            );
            if (hard) {
              throw new Error(`model lock conflict: ${lockCheck.errors.join("; ")}`);
            }
          }
        }
        // Step 1d 修复：硬上限每次调用前检查。所有 LLM 调用都经 wrapModelFn，
        // 此处是唯一能拦截 arbitrate 内部多轮（首轮+反向+仲裁）穿透 HARD 的位置。
        if (modelCallLog.length >= HARD) {
          modelBudget.capped = true;
          throw new Error(`模型调用达硬上限（${modelCallLog.length}/${HARD}），拒绝本次调用`);
        }
        const govBefore = getGovernanceState(stageResults);
        const outerRetry =
          typeof input._modelTimeoutRetryAttempt === "number"
            ? input._modelTimeoutRetryAttempt
            : 0;
        const priorFailedCalls = modelCallLog.filter((c) => c.failed).length;
        const kindBlob = `${genInput.kind ?? fnKind} ${genInput.route ?? ""}`;
        const kindLooksRecovery =
          /retry|recover|timeout|model_timeout/i.test(kindBlob);
        const isRecoveryCall =
          outerRetry > 0 || priorFailedCalls > 0 || kindLooksRecovery;
        const ledgerStage: LedgerBudgetStage = (() => {
          const s = String(genInput.kind ?? fnKind);
          if (/style|amplif/i.test(s)) return "styleOptimization";
          if (/preserv/i.test(s)) return "storyPreservation";
          if (/fact.?recheck/i.test(s)) return "finalFactRecheck";
          if (/verif/i.test(s)) return "agenticVerification";
          if (/agentic|raw/i.test(s)) return "agenticDraft";
          return "other";
        })();
        const layeredStage = (() => {
          if (ledgerStage === "styleOptimization") return "authorStyleOptimization" as const;
          if (ledgerStage === "storyPreservation") return "storyPreservation" as const;
          if (ledgerStage === "finalFactRecheck") return "finalFactRecheck" as const;
          if (ledgerStage === "agenticVerification") return "agenticVerification" as const;
          if (ledgerStage === "agenticDraft") return "agenticGeneration" as const;
          return "other" as const;
        })();
        const provider =
          expectedLock.provider ??
          input.runRouting?.provider ??
          genInput.requestedRoute ??
          "unknown";
        // 仅 fullPipelinePreview 是零文件副作用的只读预览。qualityExperiment 由
        // unified-entry 强制要求 fullPipelinePreview=true（co-set），故已被覆盖；
        // evalMode 是真实评测运行（NovelBench），预算账本仍需落盘，不得跳过。
        const previewBudgetPath = Boolean(input.fullPipelinePreview);
        let productionReservation: {
          reservationId: string;
          providerReservationId: string | undefined;
          provider: string;
          layeredStage: typeof layeredStage;
          budgetType: "recovery" | "normal";
        };
        if (previewBudgetPath) {
          // 预览路径：预算账本只读，不落盘，避免 budget-ledger.json /
          // provider-budget-ledger.json 副作用（preview 必须零文件副作用）。
          productionReservation = {
            reservationId: "",
            providerReservationId: undefined,
            provider,
            layeredStage,
            budgetType: isRecoveryCall ? "recovery" : "normal",
          };
        } else {
          seedBudgetLedgerStoreIfAbsent(
            budgetLedgerState,
            input.workspaceId,
            input.projectRoot,
          );
          const admitted = admitProductionModelCall({
            workspaceId: input.workspaceId,
            projectRoot: input.projectRoot,
            ownerRunId:
              input.runRouting?.orchestratorRunId ??
              budgetLedgerState.runIdentity.runId,
            stage: ledgerStage,
            budgetType: isRecoveryCall ? "recovery" : "normal",
            provider,
            modelCalls: 1,
          });
          if (!admitted.ok || !admitted.reservationId) {
            throw new Error(
              `budget ledger exhausted: ${admitted.reason ?? "unknown"}`,
            );
          }
          budgetLedgerState = admitted.ledger;
          stageResults._budgetLedgerState = budgetLedgerState;
          productionReservation = {
            reservationId: admitted.reservationId,
            providerReservationId: admitted.providerReservationId,
            provider,
            layeredStage,
            budgetType: isRecoveryCall ? "recovery" : "normal",
          };
        }
        // AUDIT-1：模型回合 started（细事件；失败不抛）
        const modelTurnStartedId = input.auditSink?.recordModelTurn({
          phase: "started",
          kind: genInput.kind ?? fnKind,
          requestedRoute: genInput.requestedRoute ?? genInput.route,
        }) ?? null;
        const resolvedTimeoutMs =
          genInput.timeoutMs
          ?? input.timeoutMs
          ?? input.runRouting?.timeout
          ?? getModelRequestTimeoutMs();
        genInput = {
          ...genInput,
          timeoutMs: resolvedTimeoutMs,
        };
        try {
          const output = await runWithTransportRecovery(isRecoveryCall || (ledgerStage === 'styleOptimization'
            && modelCallLog.some((call) => /style|amplif/i.test(call.kind))), () => fn(genInput));
          const durationMs = output.durationMs ?? Date.now() - start;
          const ledgerTokens =
            output.tokenUsage && output.tokenUsage !== "unknown"
              ? output.tokenUsage
              : { in: 0, out: 0 };
          if (!previewBudgetPath) {
            budgetLedgerState = settleProductionModelCall({
              workspaceId: input.workspaceId,
              projectRoot: input.projectRoot,
              reservationId: productionReservation.reservationId,
              providerReservationId: productionReservation.providerReservationId,
              provider: output.provider ?? productionReservation.provider,
              modelCalls: 1,
              inputTokens: ledgerTokens.in,
              outputTokens: ledgerTokens.out,
              latencyMs: durationMs,
              failed: false,
            });
            stageResults._budgetLedgerState = budgetLedgerState;
          }
          if (govBefore) {
            const projected = projectModelCall(govBefore, {
              stage: productionReservation.layeredStage,
              budgetType: productionReservation.budgetType,
              durationMs,
              tokenUsage: output.tokenUsage ?? "unknown",
              failed: false,
              route: output.route ?? genInput.route,
              provider: output.provider,
              model: output.model,
            });
            setGovernanceState(stageResults, projected);
            stageResults.recoveryBudget = projected.layeredBudget.legacyRecovery;
          }
          const successCost =
            !previewBudgetPath && budgetLedgerState?.costSnapshots?.length
              ? budgetLedgerState.costSnapshots[budgetLedgerState.costSnapshots.length - 1]?.actualCost
              : undefined;
          const successRetryIndex = outerRetry + priorFailedCalls;
          modelCallLog.push({
            route: output.route ?? genInput.route,
            kind: genInput.kind ?? fnKind,
            model: output.model ?? "unknown",
            durationMs,
            ts: start,
            ...(output.finishReason !== undefined ? { finishReason: output.finishReason } : {}),
            ...(output.maxTokens !== undefined ? { maxTokens: output.maxTokens } : {}),
            // P0-2（第二轮 P0 修复）：从 provider 响应抽取的真实 token 用量。
            // legacy-model-route-adapter.extractTokenUsageFromFallbackResult 读取
            // result.response.usage.{prompt_tokens, completion_tokens}；
            // stub 路径返回 {in:100, out:200}。直连旧路径无 usage 时返回 "unknown"，
            // 下游 metering-binder 按 0 估算但 settle 仍上报，保持账本完整。
            // 改前：tokenUsage: "unknown"（硬编码）→ actualCharge 恒为 0。
            tokenUsage: output.tokenUsage ?? "unknown",
            // REAL-QUALITY-1-PREFLIGHT：透传 provider/requestedRoute 证据（计划 §trace）。
            // 未锁定时 output.provider/requestedRoute 可省略，modelCallLog 字段为 undefined（向后兼容）。
            provider: output.provider,
            requestedRoute: output.requestedRoute,
            expectedProvider: expectedLock.provider,
            expectedModel: expectedLock.model,
            actualProvider: output.provider,
            actualModel: output.model,
            ...(output.fallbackTrace ? { fallbackTrace: output.fallbackTrace } : {}),
            ...(genInput.promptProfile ? { promptProfile: genInput.promptProfile as ModelCallEntry["promptProfile"] } : {}),
            // WP-05：可观测字段
            runId: input.runRouting?.orchestratorRunId,
            stage: genInput.kind ?? fnKind,
            modelVersion: output.model ?? input.runRouting?.modelVersion,
            promptBundleHash: input.runRouting?.promptBundleHash,
            contextHash: input.runRouting?.contextHash,
            temperature: genInput.temperature ?? input.runRouting?.temperature,
            timeout: genInput.timeoutMs ?? input.runRouting?.timeout,
            retryIndex: successRetryIndex,
            budgetType: productionReservation.budgetType,
            ...(typeof successCost === "number" ? { cost: successCost } : {}),
          });
          input.auditSink?.recordModelTurn({
            phase: "completed",
            kind: genInput.kind ?? fnKind,
            requestedRoute: output.requestedRoute ?? genInput.requestedRoute ?? genInput.route,
            actualProvider: output.provider,
            actualModel: output.model,
            durationMs,
            startedEventId: modelTurnStartedId ?? undefined,
          });
          if (previewBudget) previewBudget.elapsedMs = Date.now() - previewStartedAt;
          return output;
        } catch (e) {
          // Step 1d 修复：失败请求也计数，否则 used=0 但 attempts=1，预算门控失效。
          // REAL-QUALITY-1-PREFLIGHT：失败也记录 requestedRoute/provider 证据
          // （总控要求"至少记录锁定目标 provider=glm"）。
          // 失败时拿不到 output，无法读 output.provider/requestedRoute；
          // 改从 genInput 推导：wrapModelGenerateLockedToRoute 已把 input.requestedRoute
          // 设为 forcedRoute（如 nb4_generate_glm），deriveProviderFromRoute 据此推导 provider=glm。
          // 未锁定时 genInput.requestedRoute 省略，回退用 genInput.route（语义 route），
          // deriveProviderFromRoute 返回 "stub"（向后兼容，不锁定即无 provider 证据）。
          const failRequestedRoute = genInput.requestedRoute ?? genInput.route;
          const failDurationMs = Date.now() - start;
          if (!previewBudgetPath) {
            budgetLedgerState = settleProductionModelCall({
              workspaceId: input.workspaceId,
              projectRoot: input.projectRoot,
              reservationId: productionReservation.reservationId,
              providerReservationId: productionReservation.providerReservationId,
              provider: productionReservation.provider,
              modelCalls: 1,
              inputTokens: 0,
              outputTokens: 0,
              latencyMs: failDurationMs,
              failed: true,
            });
            stageResults._budgetLedgerState = budgetLedgerState;
          }
          if (govBefore) {
            const projected = projectModelCall(govBefore, {
              stage: productionReservation.layeredStage,
              budgetType: productionReservation.budgetType,
              durationMs: failDurationMs,
              tokenUsage: "unknown",
              failed: true,
              route: genInput.route,
              provider: expectedLock.provider,
              model: expectedLock.model,
            });
            setGovernanceState(stageResults, projected);
            stageResults.recoveryBudget = projected.layeredBudget.legacyRecovery;
          }
          const failCost =
            !previewBudgetPath && budgetLedgerState?.costSnapshots?.length
              ? budgetLedgerState.costSnapshots[budgetLedgerState.costSnapshots.length - 1]?.actualCost
              : undefined;
          const failRetryIndex = outerRetry + priorFailedCalls;
          modelCallLog.push({
            route: genInput.route ?? "unknown",
            kind: genInput.kind ?? fnKind,
            durationMs: failDurationMs,
            ts: start,
            tokenUsage: "unknown",
            failed: true,
            requestedRoute: failRequestedRoute,
            expectedProvider: expectedLock.provider,
            expectedModel: expectedLock.model,
            failurePhase: capability,
            errorClass: e instanceof Error ? e.constructor.name : typeof e,
            ...(genInput.promptProfile ? { promptProfile: genInput.promptProfile as ModelCallEntry["promptProfile"] } : {}),
            runId: input.runRouting?.orchestratorRunId,
            stage: genInput.kind ?? fnKind,
            modelVersion: input.runRouting?.modelVersion,
            promptBundleHash: input.runRouting?.promptBundleHash,
            contextHash: input.runRouting?.contextHash,
            temperature: genInput.temperature ?? input.runRouting?.temperature,
            timeout: genInput.timeoutMs ?? input.runRouting?.timeout,
            retryIndex: failRetryIndex,
            budgetType: productionReservation.budgetType,
            failureType: "network_timeout",
            ...(typeof failCost === "number" ? { cost: failCost } : {}),
          });
          input.auditSink?.recordModelTurn({
            phase: "failed",
            kind: genInput.kind ?? fnKind,
            requestedRoute: failRequestedRoute,
            durationMs: failDurationMs,
            errorClass: e instanceof Error ? e.constructor.name : typeof e,
            startedEventId: modelTurnStartedId ?? undefined,
          });
          if (previewBudget) previewBudget.elapsedMs = Date.now() - previewStartedAt;
          throw e;
        }
      };
    };
    // REAL-QUALITY-1-PREFLIGHT：三轨 wrap（generation / judge / arbitrator）。
    // - generationFn：raw + editorial candidate + agentic_raw（generationModelGenerate ?? modelGenerate）
    // - judgeFn：opportunity judge + pairwise 首轮 + 反向复判（judgeModelGenerate ?? modelGenerate）
    // - arbitrateFn：冲突仲裁（arbitratorModelGenerate ?? judgeModelGenerate ?? modelGenerate）
    //   优先用显式仲裁器（B4 eval 向后兼容）；REAL-QUALITY-1 路径下 arbitratorModelGenerate 未传，
    //   fallback 到 judgeModelGenerate（仲裁也走 nb4_judge_glm，符合总控要求"opportunity/pairwise 首轮/反向复判/冲突仲裁 → nb4_judge_glm"）。
    // 未传新字段时三个 fn 都回退到 modelGenerate（保持原行为，向后兼容）。
    const generationFn = generationModelGenerate ?? modelGenerate;
    const judgeFn = judgeModelGenerate ?? modelGenerate;
    const arbitrateFn = arbitratorModelGenerate ?? judgeModelGenerate ?? modelGenerate;
    const wrappedModelGenerate = wrapModelFn(generationFn, "generationModelGenerate");
    const wrappedJudgeModelGenerate = wrapModelFn(judgeFn, "judgeModelGenerate");
    const wrappedArbitratorModelGenerate = wrapModelFn(arbitrateFn, "arbitratorModelGenerate");
    // generateRaw 读 input.modelGenerate，用浅拷贝注入 generation 包装版（其余字段不变）。
    const orchInput: UnifiedOrchestratorInput = {
      ...input,
      modelGenerate: wrappedModelGenerate!,
      arbitratorModelGenerate: wrappedArbitratorModelGenerate,
      generationModelGenerate: wrappedModelGenerate,
      judgeModelGenerate: wrappedJudgeModelGenerate,
    };

    // 阶段计时 helper：async 与 sync 两种，finally 保证早返回也记录已完成阶段。
    // 同时通过 onUpdate 向前端推送阶段进度（ProgressEvent），避免长时间无响应被前端误判超时。
    const STAGE_MESSAGES: Record<string, string> = {
      stage1_novelosAgentic: "NovelOS Agentic 生成初稿中（最耗时，约 5-15 分钟）",
      stage2_agenticFactGuard: "Agentic 事实守门检查中",
      stage3_authorStyleOptimization: "作者风格整章优化中（通常 5-15 分钟，超时会自动重试一次）",
      stage4_storyPreservation: "故事保持性检查中",
      stage4a_authorStyleRetryUnverifiable: "作者风格优化重试中（事实不可验证，已缩减指导）",
      stage4a_authorStyleRetryDrift: "作者风格优化重试中（漂移修正）",
      // 注：两条 stage4b 重试路径故意不映射中文——acceptance-probes 测试用其 stage 名作源码
      // 锚点扫描 retry 代码块，映射会引入提前出现的位置干扰测试。这两阶段 fallback 到 stage 名。
      stage5_finalFactRecheck: "最终事实复检中",
      stage6_commitAndSave: "提交并原子保存章节中",
      stage7_commitAndSave: "提交并原子保存章节中",
      stage1_raw: "正文初稿生成中",
      stage2_rawFactGuard: "正文事实守门检查中",
      stage1_5_novelosAgenticRaw: "NovelOS Agentic 原始候选生成中",
    };
    const emitProgress = (
      stage: string,
      status: "start" | "done",
      durationMs?: number,
    ) => {
      if (!input.onUpdate) return;
      try {
        const event: ProgressEvent = {
          stage,
          status,
          message: STAGE_MESSAGES[stage] ?? stage,
          ...(durationMs !== undefined ? { durationMs } : {}),
          timestamp: new Date().toISOString(),
        };
        input.onUpdate(event);
      } catch {
        // 进度推送失败不影响生成（与 legacy-tool-wrapper.ts _onUpdate 包装策略一致）
      }
    };
    const timeAsync = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const start = Date.now();
      emitProgress(name, "start");
      try { return await fn(); }
      finally {
        const dur = Date.now() - start;
        stageTiming[name] = dur;
        emitProgress(name, "done", dur);
      }
    };
    const timeSync = <T>(name: string, fn: () => T): T => {
      const start = Date.now();
      emitProgress(name, "start");
      try { return fn(); }
      finally {
        const dur = Date.now() - start;
        stageTiming[name] = dur;
        emitProgress(name, "done", dur);
      }
    };

    // ── Step 1d：模型调用预算门控 ─────────────────────────────────────
    // soft：stage4（候选生成）前检查，超限跳过候选生成、交付 raw。
    // hard：wrapModelFn 每次调用前检查（覆盖所有 LLM 调用，含 arbitrate 内部多轮），
    //       超限抛错；stage5b 串行循环仍有 break 作为双保险。
    // used 用 Object.defineProperty 作 live getter（= modelCallLog.length，含 failed 调用），
    // 所有早返回路径（deliverRaw/hardBlock）自动带准确 used，无需改 helper 签名。
    const SOFT = Number(process.env.PINOVEL_MODEL_CALL_SOFT ?? (input.positiveGainProductionEnabled ? 8 : 6));
    const HARD = Number(process.env.PINOVEL_MODEL_CALL_HARD ?? (input.positiveGainProductionEnabled ? 14 : 10));
    const modelBudget: {
      soft: number; hard: number; used: number; capped: boolean;
    } = { soft: SOFT, hard: HARD, used: 0, capped: false };
    Object.defineProperty(modelBudget, "used", {
      get: () => modelCallLog.length,
      enumerable: true,
      configurable: true,
    });
    stageResults.modelBudget = modelBudget;

    // ── INTENT-1：章卡摘要写入 stageResults（早写，确保 hardBlock 路径也带 intent 证据） ──
    // 修复轮：buildRawPrompt 在 try 块前预计算一次，consumedFields 立即写入 stageResults。
    // 这样 raw 模型调用抛错时 hardBlock 路径仍保留实际 consumedFields（不再丢失为 []）。
    // 不重复构建 prompt：buildRawPrompt 只调用一次，结果传给 generateRaw。
    const rawPrompt = buildRawPrompt(orchInput);
    if (orchInput.promptPatternResolution) {
      stageResults.promptPatterns = {
        ...orchInput.promptPatternResolution.trace,
        patternIds: orchInput.promptPatternResolution.patternIds,
        consumedByRawPrompt: rawPrompt.consumedFields.includes("promptPatterns"),
      };
    }
    if (orchInput.capabilityActivation) {
      const selected = orchInput.capabilityActivation.decisions.filter((d) => d.decision === "selected");
      if (rawPrompt.consumedFields.includes("promptPatterns")) {
        throw new Error("raw_injection_forbidden:capability_or_pattern");
      }
      stageResults.capabilityPackages = {
        catalogHash: orchInput.capabilityActivation.catalogHash,
        capabilityPackageSetHash: orchInput.capabilityActivation.capabilityPackageSetHash,
        manifestHash: orchInput.capabilityActivation.manifestHash,
        selected: selected.map((decision) => decision.packageId),
        skipped: orchInput.capabilityActivation.decisions
          .filter((decision) => decision.decision !== "selected")
          .map((decision) => ({ packageId: decision.packageId, reasons: decision.reasons })),
        consumption: [],
        modelInputHash: null,
      };
    }
    stageResults.chapterIntent = {
      summary: buildIntentSummary(intent),
      fieldSourceRefs: intent.fieldSourceRefs ?? {},
      consumedFields: rawPrompt.consumedFields,
    };
    stageResults.chapterContract = rawPrompt.chapterContract;
    stageResults.promptAdapter = {
      profile: rawPrompt.promptAdapter.profile,
      runtimePolicy: rawPrompt.promptAdapter.runtimePolicy,
      route: RAW_ROUTE,
    };
    stageResults.rawPromptConstraintAudit = rawPrompt.promptConstraintAudit;
    stageResults.methodologyPolicy = rawPrompt.methodologyPolicy;
    stageResults.constitutionConsumption = {
      raw: rawPrompt.constitutionConsumedFields,
      editorial: [],
      judge: [],
    };
    // QUALITY-4：本章相关承诺状态写入 stageResults.promiseContext 供 trace 审计。
    // 含 selected promise list、sourceRefs、consumedByRawPrompt；空时写 emptyReason 不静默。
    // 本任务不提交长期状态，不更新 PromiseLedger，只做"生成前相关状态编译 + raw 消费证明"。
    stageResults.promiseContext = rawPrompt.promiseContext;
    // EXPECTATION-LEDGER-1：本章相关读者期待状态写入 stageResults.expectationContext 供 trace 审计。
    // 含 selected expectation list、sourceRefs、consumedByRawPrompt；空时写 emptyReason 不静默。
    // 本任务不提交长期状态，不更新 ExpectationLedger，只做"生成前相关状态编译 + raw 消费证明"。
    stageResults.expectationContext = rawPrompt.expectationContext;
    // GENRE-CONTRACT-1：本章类型读者承诺写入 stageResults.genreContract 供 trace 审计。
    // 含 declaredGenre/driftGenre、entries（constitution + type-dataset 命中）、sourceRefs、
    // consumedByRawPrompt；空时写 emptyReason 不静默。本任务不提交长期状态，不调用 LLM，
    // 不接管 immutable_fact（仍由 P0/WorldPresentationContext 管理），只做"生成前相关类型承诺编译 + raw 消费证明"。
    stageResults.genreContract = rawPrompt.genreContract;
    // DIALOGUE-CRAFT-1：本章发言角色声音指纹 + 对白工艺 advisory 写入 stageResults.dialogueCraft 供 trace 审计。
    // 含 speakingCharacters（focusCharacterGoals ∪ relevantCharacters 命中）、blindTestEligible、
    // dialogueCraftAdvisory（raw 生成前为空，raw 生成后由 opportunity detector 二次扫描）、sourceRefs、
    // consumedByRawPrompt、advisoryOnly=true、canTriggerEditorialOpportunity、proxyNote；
    // 空时写 emptyReason 不静默。本任务不提交长期状态，不调用 LLM，不强制对白比例，
    // 不接管 finalText（advisory 不直接覆盖 raw），只做"生成前相关发言角色声音指纹编译 + raw 消费证明"。
    stageResults.dialogueCraft = rawPrompt.dialogueCraft;
    // EMOTION-RHYTHM-1：事件驱动情绪节拍 advisory 写入 stageResults.emotionRhythm 供 trace 审计。
    // 含 targetEmotions（intent.readerExperience）、previousEmotionState、emotionTransitions（raw 生成前为空，
    // raw 生成后由 opportunity detector 二次扫描）、chapterEndEmotion、sourceRefs、consumedByRawPrompt、
    // advisoryOnly=true、canTriggerEditorialOpportunity、humanReviewFocus、emptyReason；
    // 空时写 emptyReason 不静默。本任务不提交长期状态，不调用 LLM，不是 gate，
    // 不接管 finalText（advisory 不直接覆盖 raw），只做"生成前情绪节拍目标/前态编译 + raw 消费证明"。
    stageResults.emotionRhythm = rawPrompt.emotionRhythm;
    // SUPPORTING-FUNCTION-1：配角章节功能层 advisory 写入 stageResults.supportingFunction 供 trace 审计。
    // 含 assignments（激活配角 = relevantCharacters - focusCharacterGoals）、primaryFunction（5 类，每个配角最多一个）、
    // functionEvidenceSpan（raw 生成前为空，raw 生成后由 opportunity detector 二次扫描）、conflictAdvisory、
    // sourceRefs、consumedByRawPrompt、advisoryOnly=true、canTriggerEditorialOpportunity、humanReviewFocus、emptyReason；
    // 空时写 emptyReason 不静默。本任务不提交长期状态，不调用 LLM，不更新永久角色身份，
    // 不接管 finalText（advisory 不直接覆盖 raw），不恢复固定群像人数配额，
    // 只做"生成前激活配角功能 hypothesis 编译 + raw 消费证明"。
    stageResults.supportingFunction = rawPrompt.supportingFunction;
    // KNOWLEDGE-CONSUMPTION-1：few-shot/contrastive 生产消费审计写入 stageResults.knowledgeConsumption 供 trace 审计。
    // 含 entries（每条示例 id/source/qualityScore/selectionReason/tokenCost/text）、totalTokenCost、totalChars、
    // channel（runtime/flat/mixed/empty）、sourceRefs、manifestApproved、consumedByRawPrompt、advisoryOnly=true、
    // emptyReason、proxyNote；
    // 空时写 emptyReason 不静默。本任务不提交长期状态，不调用 LLM，不是 gate，
    // 不接管 finalText（advisory 不直接覆盖 raw），不强制模仿模板，
    // 只做"few-shot 检索结果审计包装 + raw 消费证明"。
    stageResults.knowledgeConsumption = rawPrompt.knowledgeConsumption;
    // QUALITY-5：本章相关角色声音/状态提示写入 stageResults.characterVoiceContext 供 trace 审计。
    // 含 entries（state 命中 + intent-only）、sourceRefs、consumedByRawPrompt、proxyNote；
    // 空时写 emptyReason 不静默。本任务不提交长期状态，不更新角色档案，
    // 只做"生成前相关状态编译 + raw 消费证明"。
    stageResults.characterVoiceContext = rawPrompt.characterVoiceContext;
    // QUALITY-6：本章世界约束与类型承诺写入 stageResults.worldPresentationContext 供 trace 审计。
    // 含 entries（全部 worldRules + chapterActivated 标记）、genrePromises、sourceRefs、consumedByRawPrompt；
    // 空时写 emptyReason 不静默。本任务不提交长期状态，不更新世界设定，
    // 只做"生成前相关状态编译 + raw 消费证明"。
    stageResults.worldPresentationContext = rawPrompt.worldPresentationContext;
    // QUALITY-7：本章角色层次写入 stageResults.ensembleLayeringContext 供 trace 审计。
    // 含 entries（焦点/在场分层）、sourceRefs、consumedByRawPrompt、proxyNote；
    // 空时写 emptyReason 不静默。本任务不提交长期状态，不更新角色档案，
    // 只做"生成前相关状态编译 + raw 消费证明"。
    stageResults.ensembleLayeringContext = rawPrompt.ensembleLayeringContext;
    // CANON-IDENTITY-1：角色身份契约写入 stageResults.identityContract 供 trace 审计。
    // 从 characterStates 编译，含 name/aliases/role/stableIdentity；
    // raw prompt 与 FactGuard 消费同一 contract（id/hash 一致）。
    stageResults.identityContract = rawPrompt.identityContract;
    // WORLD-ONTOLOGY-1：raw prompt 与 FactGuard 共用同一 ontology contract。
    stageResults.ontologyContract = rawPrompt.ontologyContract;

    if (input.productionFlow === "agentic_style" && !input.evalMode) {
      stageResults.productionFlow = {
        mode: "agentic_style_full_pipeline",
        literaryAuthority: "user_feedback",
        oneShotRawCalled: false,
        machineJudgeCalled: false,
      };
      stageResults.positiveGainCandidates = {
        status: "retired_from_production",
        failureReason: "global_scene_candidate_admission_retired",
      };
      stageResults.qualitySelectionPolicy = {
        mode: "user_feedback",
        automaticQualityWinnerSelectionEnabled: false,
        rawRole: "not_deliverable",
      };
      stageResults.judgeAlignmentGate = {
        automaticLiterarySelectionEnabled: false,
        mode: "disabled_by_user_decision",
      };
      stageResults.judgeArbitration = {
        skipped: true,
        reason: "机器文学裁判已退出生产；最终章节由用户评价反馈",
      };

      if (!input.agenticCandidateSource) {
        return this.hardBlock(
          input,
          "novelos_agentic_missing",
          "正式生产流程要求 NovelOS Agentic，但入口未提供 agenticCandidateSource",
          stageResults,
        );
      }

      const chineseAiLanguageGuidance = buildChineseAiLanguageGuidance(projectRoot);
      stageResults.chineseAiLanguageGuidance = {
        source: chineseAiLanguageGuidance.source,
        datasetId: chineseAiLanguageGuidance.datasetId,
        recordCount: chineseAiLanguageGuidance.recordCount,
        recordIds: chineseAiLanguageGuidance.recordIds,
        blockHash: chineseAiLanguageGuidance.blockHash,
        appliedTo: ["novelos_agentic", "author_style_optimization"],
        softDiagnosticOnly: true,
      };

      let agenticResult: AgenticRawSourceResult;
      try {
        const checkpoint = input.verifiedDraftBinding && !input.fullPipelinePreview
          ? loadVerifiedDraft(verifiedDraftPath(projectRoot, workspaceId, chapterId), input.verifiedDraftBinding) : undefined;
        stageResults.verifiedDraftCheckpoint = { reused: Boolean(checkpoint), binding: input.verifiedDraftBinding ?? null };
        agenticResult = checkpoint ?? await timeAsync("stage1_novelosAgentic", () =>
          input.agenticCandidateSource!.generate({
            workspaceId,
            chapterId,
            chapterNumber,
            projectRoot,
            continuationMode: input.continuationMode,
            currentChapterDraft: input.currentChapterDraft,
            chineseAiLanguageGuidance,
            evidenceSnapshot: input.evidenceSnapshot,
            contextPackage: input.contextPackage,
            intent,
            context,
            characterNames,
            modelGenerate: wrappedModelGenerate!,
            route: RAW_ROUTE,
            timeoutMs: input.timeoutMs,
            evalPrefix: input.evalPrefix,
            // Phase 2B：字数软目标转发给 Agentic GenerationPacket
            targetWordCount: input.targetWordCount,
            // P0-1 修复：预览模式透传给 CandidateWorkspace/TrajectoryStore
            fullPipelinePreview: input.fullPipelinePreview,
            // P1 修复：few-shot 黄金示例透传给 Agentic prompt
            fewshotSelection: input.fewshotSelection,
            // CONTRACT-LAYERING-ABLATION-1：透传渲染策略（生产路径 undefined = 平铺）
            writerPromptProfile: input.rawPromptProfile,
            // eval-only：A/B 对照实验用，覆盖 Agentic 检索决策规则（生产 undefined = 默认强制检索）
            retrievalPromptOverride: input.retrievalPromptOverride,
            // Phase 5 受控接入：透传 toolMode（facade 时 registry 注册统一入口、
            // allowedTools 收窄、runtime 白名单/检索预算扩展；undefined = 默认 standard）
            toolMode: input.toolMode,
            // AUDIT-1：透传细事件 sink（工具授权/结果）
            auditSink: input.auditSink,
            capabilityActivation: input.capabilityActivation,
            capabilityPackageSet: input.capabilityPackageSet,
            capabilityCatalog: input.capabilityCatalog,
            capabilityConsumptionLedger: input.capabilityConsumptionLedger,
            // MA：run 身份透传给 Agentic 工作包 / 工具门闩
            orchestratorRunId: collabState.orchestratorRunId,
            taskId: collabState.taskId,
            contextHash: collabState.contextHash,
            promptBundleHash: collabState.promptBundleHash,
            constraintManifestHash: collabState.constraintManifestHash,
          }),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const failureKind = classifyTimeoutFromReason(message) === "model_timeout"
          ? "model_timeout"
          : "model_error";
        stageResults.novelosInitialFailure = { message, failureKind };
        // 首轮直接抛错与 source 返回 candidate=null 走同一条有界恢复路径。
        // 这里构造的是失败证据，不是可交付候选；所有成功恢复稿仍需重新通过
        // verifier、hash、完整性、字数、FactGuard 和后续风格/终检。
        agenticResult = {
          candidate: null,
          sessionId: `agentic-initial-failure-${chapterId}`,
          trajectoryPath: "",
          budgetSnapshot: {
            turns: 0,
            toolCalls: 0,
            latencyMs: 0,
            tokensIn: 0,
            tokensOut: 0,
            modelCalls: 0,
            exhausted: false,
          },
          stopReason: "not_run",
          failureReason: message,
          failureKind,
          sourceRefs: [],
          toolCalls: 0,
          decisionMode: "agentic_inline",
          firstAction: "not_run",
          actualRetrievalCalls: 0,
          mustVerifyCount: 0,
          mustVerifyCoveredCount: 0,
          modelCallsByKind: { draft: 0, patch: 0, newCandidate: 0, authorStyle: 0 },
          verifierCleared: false,
          repairRounds: 0,
          hardFindingCount: 0,
          unresolvedFindings: [],
        };
      }

      const consumptionEvents = input.capabilityConsumptionLedger?.events() ?? agenticResult.capabilityConsumption ?? [];
      const deliveredHash = agenticResult.modelInputHash
        ?? consumptionEvents.find((event) => event.event === "delivered_to_model")?.modelInputHash
        ?? null;
      if (stageResults.capabilityPackages) {
        const capabilityTrace = stageResults.capabilityPackages as {
          consumption?: unknown;
          modelInputHash?: string | null;
        };
        capabilityTrace.consumption = [...consumptionEvents];
        capabilityTrace.modelInputHash = deliveredHash;
      }
      const leakedPayload = consumptionEvents.some((event) =>
        event.event === "delivered_to_model" && event.reason === "activation_tool_result",
      );
      if (leakedPayload) {
        return this.hardBlock(
          input,
          "capability_package",
          "candidate-only capability payload entered Agentic draft model input",
          stageResults,
        );
      }
      stageResults.novelos = {
        shadowEnabled: false,
        required: true,
        sessionId: agenticResult.sessionId,
        trajectoryPath: agenticResult.trajectoryPath,
        candidateId: agenticResult.candidate?.id ?? null,
        candidateLength: agenticResult.candidate?.text.length ?? 0,
        stopReason: agenticResult.stopReason,
        failureReason: agenticResult.failureReason ?? null,
        // P1-3：传播 failureKind 到 trace，便于 replay 仪表盘区分
        // model_timeout / model_error / runtime_init / budget_exhausted / empty_draft。
        failureKind: agenticResult.failureKind ?? null,
        budgetSnapshot: agenticResult.budgetSnapshot,
        sourceRefs: agenticResult.sourceRefs,
        toolCalls: agenticResult.toolCalls,
        verifierCleared: agenticResult.verifierCleared,
        repairRounds: agenticResult.repairRounds,
        hardFindingCount: agenticResult.hardFindingCount ?? null,
        unresolvedFindings: agenticResult.unresolvedFindings ?? [],
        // AGENTIC-EVIDENCE-MERGE-1 可观测性：证据/检索判断合并进 Agentic 首轮后，
        // 记录实际决策模式、首动作、实际检索调用数、mustVerify 覆盖与按阶段模型调用数。
        // 这些聚合字段直接解释 Agentic 在 ReAct 循环内做了什么，不记录原始思维链。
        decisionMode: agenticResult.decisionMode,
        firstAction: agenticResult.firstAction,
        actualRetrievalCalls: agenticResult.actualRetrievalCalls,
        mustVerifyCount: agenticResult.mustVerifyCount,
        mustVerifyCoveredCount: agenticResult.mustVerifyCoveredCount,
        coverageResult: agenticResult.coverageResult ?? null,
        modelCallsByKind: agenticResult.modelCallsByKind,
      };
      type AgenticSourceInput = Parameters<AgenticRawCandidateSource["generate"]>[0];
      type AgenticSourceResult = Awaited<ReturnType<AgenticRawCandidateSource["generate"]>>;
      const recoveryAttempts: Array<{
        attempt: number;
        reason: "empty_result" | "verifier_findings" | "target_length" | "completeness" | "fact_guard";
        sourceCandidateId: string | null;
        resultCandidateId: string | null;
        outcome: "candidate" | "no_candidate" | "error" | "budget_exhausted";
        evidence: string[];
      }> = [];
      const generationRecoveryTrace = {
        maxAttempts: (stageResults.recoveryBudget as RecoveryBudget).maxTotalAttempts,
        attempts: recoveryAttempts,
        exhausted: false,
        succeeded: false,
      };
      stageResults.generationRecovery = generationRecoveryTrace;

      const recoveryModelGenerate: ModelGenerateFn = async (modelInput) =>
        wrappedModelGenerate!({
          ...modelInput,
          kind: /recovery/i.test(modelInput.kind ?? "")
            ? modelInput.kind
            : `${modelInput.kind ?? "agentic"}_recovery`,
        });
      const runAgenticRecovery = async (
        reason: (typeof recoveryAttempts)[number]["reason"],
        sourceCandidateId: string | null,
        evidence: string[],
        overrides: Partial<AgenticSourceInput>,
      ): Promise<AgenticSourceResult | null> => {
        const currentBudget = (stageResults.recoveryBudget as RecoveryBudget | undefined)
          ?? recoveryBudget;
        const reserved = reserveBudget(currentBudget, {
          totalAttempts: 1,
          recoveryModelCalls: 1,
          modelCalls: 1,
        });
        const attempt = recoveryAttempts.length + 1;
        if (!reserved.ok) {
          generationRecoveryTrace.exhausted = true;
          recoveryAttempts.push({
            attempt,
            reason,
            sourceCandidateId,
            resultCandidateId: null,
            outcome: "budget_exhausted",
            evidence: [...evidence],
          });
          return null;
        }
        stageResults.recoveryBudget = reserved.budget;
        const governance = getGovernanceState(stageResults);
        if (governance) {
          setGovernanceState(stageResults, {
            ...governance,
            layeredBudget: {
              ...governance.layeredBudget,
              legacyRecovery: reserved.budget,
            },
          });
        }
        try {
          const result = await timeAsync(
            `stage1_novelosAgenticRecovery_${attempt}_${reason}`,
            () => input.agenticCandidateSource!.generate({
              workspaceId,
              chapterId,
              chapterNumber,
              projectRoot,
              continuationMode: input.continuationMode,
              currentChapterDraft: input.currentChapterDraft,
              chineseAiLanguageGuidance,
              evidenceSnapshot: input.evidenceSnapshot,
              contextPackage: input.contextPackage,
              intent,
              context,
              characterNames,
              route: RAW_ROUTE,
              timeoutMs: input.timeoutMs,
              evalPrefix: input.evalPrefix,
              targetWordCount: input.targetWordCount,
              fullPipelinePreview: input.fullPipelinePreview,
              fewshotSelection: input.fewshotSelection,
              writerPromptProfile: input.rawPromptProfile,
              retrievalPromptOverride: input.retrievalPromptOverride,
              toolMode: input.toolMode,
              auditSink: input.auditSink,
              capabilityActivation: input.capabilityActivation,
              capabilityPackageSet: input.capabilityPackageSet,
              capabilityCatalog: input.capabilityCatalog,
              capabilityConsumptionLedger: input.capabilityConsumptionLedger,
              orchestratorRunId: collabState.orchestratorRunId,
              taskId: collabState.taskId,
              contextHash: collabState.contextHash,
              promptBundleHash: collabState.promptBundleHash,
              constraintManifestHash: collabState.constraintManifestHash,
              ...overrides,
              modelGenerate: recoveryModelGenerate,
            }),
          );
          recoveryAttempts.push({
            attempt,
            reason,
            sourceCandidateId,
            resultCandidateId: result.candidate?.id ?? null,
            outcome: result.candidate ? "candidate" : "no_candidate",
            evidence: [...evidence],
          });
          return result;
        } catch (error: unknown) {
          recoveryAttempts.push({
            attempt,
            reason,
            sourceCandidateId,
            resultCandidateId: null,
            outcome: "error",
            evidence: [
              ...evidence,
              error instanceof Error ? error.message : String(error),
            ],
          });
          return null;
        }
      };

      let pendingAgenticCandidate = agenticResult.candidate;
      let latestAgenticCompleteness = pendingAgenticCandidate
        ? scanFinalTextCompleteness(pendingAgenticCandidate.text, {
            finishReason: pendingAgenticCandidate.finishReason,
            chapterNumber,
          })
        : null;
      let latestAgenticFactGuard = pendingAgenticCandidate
        ? checkCandidateFactGuard(pendingAgenticCandidate.text, input)
        : null;

      const ensureAgenticCandidateReady = async (): Promise<void> => {
        while (true) {
        if (!pendingAgenticCandidate) {
          const failureKind = agenticResult.failureKind
            ?? classifyTimeoutFromReason(agenticResult.failureReason ?? agenticResult.stopReason);
          if (!["model_timeout", "model_error", "empty_draft", "continuation_prefix_mismatch"].includes(failureKind)) {
            break;
          }
          const recovered = await runAgenticRecovery(
            "empty_result",
            null,
            [agenticResult.failureReason ?? String(agenticResult.stopReason)],
            {},
          );
          if (!recovered) break;
          agenticResult = recovered;
          pendingAgenticCandidate = recovered.candidate;
          continue;
        }

        if (agenticResult.verifierCleared !== true) {
          const findings = (agenticResult.unresolvedFindings ?? []).map((finding) => ({
            code: finding.id,
            message: `${finding.description}; ${finding.conflictFact}`,
            evidenceRef: finding.sourceRef,
          }));
          const recovered = await runAgenticRecovery(
            "verifier_findings",
            pendingAgenticCandidate.id,
            findings.map((finding) => `${finding.code}: ${finding.message}`),
            {
              recoveryDirective: {
                kind: "verifier",
                previousCandidateText: pendingAgenticCandidate.text,
                findings,
              },
            },
          );
          if (!recovered) break;
          agenticResult = recovered;
          pendingAgenticCandidate = recovered.candidate;
          continue;
        }

        const integrity = checkCandidateTextHashBinding(pendingAgenticCandidate);
        if (!integrity.ok) break;

        latestAgenticCompleteness = scanFinalTextCompleteness(pendingAgenticCandidate.text, {
          finishReason: pendingAgenticCandidate.finishReason,
          chapterNumber,
        });
        const lengthAssessment = input.targetWordCount
          ? assessTargetLength(pendingAgenticCandidate.text, input.targetWordCount)
          : null;
        stageResults.agenticTargetLength = lengthAssessment;
        if (!latestAgenticCompleteness.passed || lengthAssessment?.needsContinuation) {
          const reason = lengthAssessment?.needsContinuation ? "target_length" : "completeness";
          const evidence = lengthAssessment?.needsContinuation
            ? [`remaining=${lengthAssessment.remaining}`, `minimum=${lengthAssessment.minimum}`]
            : latestAgenticCompleteness.findings.map((finding) => finding.reason);
          const recovered = await runAgenticRecovery(
            reason,
            pendingAgenticCandidate.id,
            evidence,
            {
              continuationMode: "append",
              currentChapterDraft: pendingAgenticCandidate.text,
              targetWordCount: input.targetWordCount,
            },
          );
          if (!recovered) break;
          agenticResult = recovered;
          pendingAgenticCandidate = recovered.candidate;
          continue;
        }

        latestAgenticFactGuard = checkCandidateFactGuard(pendingAgenticCandidate.text, input);
        if (!latestAgenticFactGuard.ok) {
          const findings = latestAgenticFactGuard.report.hardBlocks.map((finding) => ({
            code: finding.id,
            message: finding.evidence,
            evidenceRef: finding.source,
          }));
          const recovered = await runAgenticRecovery(
            "fact_guard",
            pendingAgenticCandidate.id,
            latestAgenticFactGuard.errors,
            {
              recoveryDirective: {
                kind: "fact_guard",
                previousCandidateText: pendingAgenticCandidate.text,
                findings,
              },
            },
          );
          if (!recovered) break;
          agenticResult = recovered;
          pendingAgenticCandidate = recovered.candidate;
          continue;
        }
          generationRecoveryTrace.succeeded = recoveryAttempts.length > 0;
          break;
        }
      };
      await ensureAgenticCandidateReady();

      const finalConsumptionEvents = input.capabilityConsumptionLedger?.events()
        ?? agenticResult.capabilityConsumption
        ?? [];
      const finalDeliveredHash = agenticResult.modelInputHash
        ?? finalConsumptionEvents.find((event) => event.event === "delivered_to_model")?.modelInputHash
        ?? null;
      if (stageResults.capabilityPackages) {
        const capabilityTrace = stageResults.capabilityPackages as {
          consumption?: unknown;
          modelInputHash?: string | null;
        };
        capabilityTrace.consumption = [...finalConsumptionEvents];
        capabilityTrace.modelInputHash = finalDeliveredHash;
      }

      if (finalConsumptionEvents.some((event) =>
        event.event === "delivered_to_model" && event.reason === "activation_tool_result"
      )) {
        return this.hardBlock(
          input,
          "capability_package",
          "candidate-only capability payload entered Agentic draft model input",
          stageResults,
        );
      }
      stageResults.novelos = {
        shadowEnabled: false,
        required: true,
        sessionId: agenticResult.sessionId,
        trajectoryPath: agenticResult.trajectoryPath,
        candidateId: agenticResult.candidate?.id ?? null,
        candidateLength: agenticResult.candidate?.text.length ?? 0,
        stopReason: agenticResult.stopReason,
        failureReason: agenticResult.failureReason ?? null,
        failureKind: agenticResult.failureKind ?? null,
        budgetSnapshot: agenticResult.budgetSnapshot,
        sourceRefs: agenticResult.sourceRefs,
        toolCalls: agenticResult.toolCalls,
        verifierCleared: agenticResult.verifierCleared,
        repairRounds: agenticResult.repairRounds,
        hardFindingCount: agenticResult.hardFindingCount ?? null,
        unresolvedFindings: agenticResult.unresolvedFindings ?? [],
        decisionMode: agenticResult.decisionMode,
        firstAction: agenticResult.firstAction,
        actualRetrievalCalls: agenticResult.actualRetrievalCalls,
        mustVerifyCount: agenticResult.mustVerifyCount,
        mustVerifyCoveredCount: agenticResult.mustVerifyCoveredCount,
        coverageResult: agenticResult.coverageResult ?? null,
        modelCallsByKind: agenticResult.modelCallsByKind,
        recovered: recoveryAttempts.length > 0,
      };

      if (!pendingAgenticCandidate) {
        const failureKind = agenticResult.failureKind
          ?? classifyTimeoutFromReason(agenticResult.failureReason ?? agenticResult.stopReason);
        const timeoutRecovery = failureKind === "model_timeout";
        return this.hardBlock(
          input,
          "novelos_agentic_generation",
          `NovelOS Agentic 内部恢复后仍未产出有效正文（${failureKind}）：${agenticResult.failureReason ?? agenticResult.stopReason}`,
          stageResults,
          undefined,
          {
            gate: timeoutRecovery ? "model_timeout" : "agentic_generation",
            severityOverride: timeoutRecovery ? "recoverable" : "hard",
            recoverable: timeoutRecovery,
            retryPlan: timeoutRecovery
              ? { strategy: "chapter_level_retry", maxAttempts: 1 }
              : { strategy: "terminal_block_no_retry", maxAttempts: 0 },
          },
        );
      }
      let agenticCandidate: Candidate = pendingAgenticCandidate;
      // MA-1：只为恢复循环最终选定的 Agentic 结果登记工作包和 Draft 契约，
      // 防止 lineage 仍指向首轮失败稿或已被替换的候选。
      try {
        const agenticPkg = buildRoleWorkPackage(collabState, "novelos_agentic", {
          stage: recoveryAttempts.length > 0
            ? "stage1_novelosAgenticRecovered"
            : "stage1_novelosAgentic",
          sessionId: agenticResult.sessionId || `agentic-${chapterId}`,
          objective: "NovelOS Agentic 初稿生成（不直接交付）",
        });
        requireWorkPackageInput(agenticPkg, {
          workspaceId,
          chapterId,
          chapterNumber,
          chapterIntent: intent,
          seedContext: context,
          context,
          knownCharacterNames: characterNames,
          inviolableFacts: intent.inviolableFacts,
          targetWordCount: input.targetWordCount,
          toolMode: input.toolMode,
          evalPrefix: input.evalPrefix,
          retrievalPromptOverride: input.retrievalPromptOverride,
        });
        recordWorkPackage(collabState, agenticPkg);
        if (agenticResult.workPackageSummary) {
          stageResults.agenticWorkPackage = agenticResult.workPackageSummary;
        }
        const draftContract = adaptDraftFromAgenticSource(agenticResult, {
          workPackage: agenticPkg,
          candidateId: agenticCandidate.id,
        });
        recordAgentResult(collabState, draftContract, "fact_guard", agenticPkg.packageId);
      } catch (collabErr: unknown) {
        const failure = classifyCollaborationContractError(
          "novelos_agentic_contract",
          "novelos_agentic",
          collabErr,
        );
        stageResults.agentCollaborationError = failure;
        return this.hardBlock(
          input,
          failure.stage,
          formatCollaborationFailureReason(failure),
          stageResults,
          {
            rawText: agenticCandidate.text,
            rawFinishReason: agenticCandidate.finishReason ?? null,
            rawMaxTokens: agenticCandidate.maxTokens ?? null,
            rawModel: agenticCandidate.model,
            modelVersion: detectModelVersion(agenticCandidate.model),
            candidateId: agenticCandidate.id,
          },
          collaborationFailureGuidance(failure),
        );
      }
      if (agenticResult.verifierCleared !== true) {
        const hardFindingCount = agenticResult.hardFindingCount
          ?? agenticResult.unresolvedFindings?.length
          ?? 0;
        const repairRounds = agenticResult.repairRounds ?? 0;
        stageResults.pipelineProgress = {
          lastCompletedStage: "novelos_agentic_draft",
          blockedAt: "novelos_agentic_verification",
          authorStyleOptimizationExecuted: false,
          finalFactRecheckExecuted: false,
          stateCommitExecuted: false,
          chapterSaveExecuted: false,
        };
        const blockGuidance = classifyAgenticVerificationBlock(
          agenticResult.unresolvedFindings ?? [],
          chapterNumber,
        );
        return this.hardBlock(
          input,
          "novelos_agentic_verification",
          `NovelOS Agentic 在 ${repairRounds} 轮修复（内部恢复）后仍有 ${hardFindingCount} 个硬失败`,
          stageResults,
          {
            rawText: agenticCandidate.text,
            rawFinishReason: agenticCandidate.finishReason ?? null,
            rawMaxTokens: agenticCandidate.maxTokens ?? null,
            rawModel: agenticCandidate.model,
            modelVersion: detectModelVersion(agenticCandidate.model),
            candidateId: agenticCandidate.id,
            selectedSource: "raw",
            finalText: agenticCandidate.text,
          },
          blockGuidance,
        );
      }
      const hashBinding = checkCandidateTextHashBinding(agenticCandidate);
      if (!hashBinding.ok) {
        stageResults.candidateIntegrity = {
          ok: false,
          reason: hashBinding.reason,
          candidateId: agenticCandidate.id,
        };
        return this.hardBlock(
          input,
          "novelos_agentic_integrity",
          `NovelOS Agentic 候选正文与 candidateId 的 hash 绑定失败（${hashBinding.reason}）`,
          stageResults,
          {
            rawText: agenticCandidate.text,
            rawFinishReason: agenticCandidate.finishReason ?? null,
            rawMaxTokens: agenticCandidate.maxTokens ?? null,
            rawModel: agenticCandidate.model,
            modelVersion: detectModelVersion(agenticCandidate.model),
            candidateId: agenticCandidate.id,
            selectedSource: "raw",
            finalText: agenticCandidate.text,
          },
        );
      }
      candidates.push(agenticCandidate);

      const agenticCompleteness = latestAgenticCompleteness
        ?? scanFinalTextCompleteness(agenticCandidate.text, {
          finishReason: agenticCandidate.finishReason,
          chapterNumber,
        });
      const agenticTargetLength = input.targetWordCount
        ? assessTargetLength(agenticCandidate.text, input.targetWordCount)
        : null;
      stageResults.agenticCompleteness = agenticCompleteness;
      stageResults.agenticTargetLength = agenticTargetLength;
      if (!agenticCompleteness.passed || agenticTargetLength?.needsContinuation) {
        const reason = agenticTargetLength?.needsContinuation
          ? `初稿仍少 ${agenticTargetLength.remaining} 字，未达到 ${agenticTargetLength.minimum} 字交付下限`
          : agenticCompleteness.findings[0]?.reason ?? "NovelOS Agentic 初稿疑似截断";
        return this.hardBlock(
          input,
          "agentic_completeness",
          reason,
          stageResults,
          {
            rawText: agenticCandidate.text,
            rawFinishReason: agenticCandidate.finishReason ?? null,
            rawMaxTokens: agenticCandidate.maxTokens ?? null,
            rawModel: agenticCandidate.model,
            modelVersion: detectModelVersion(agenticCandidate.model),
            candidateId: agenticCandidate.id,
            selectedSource: "raw",
            finalText: agenticCandidate.text,
          },
        );
      }

      const agenticFactGuard = timeSync("stage2_agenticFactGuard", () =>
        latestAgenticFactGuard ?? checkCandidateFactGuard(agenticCandidate.text, input),
      );
      stageResults.agenticFactGuard = agenticFactGuard;
      // MA-1：FactGuard 结果契约
      try {
        const fgPkg = buildRoleWorkPackage(collabState, "fact_guard", {
          stage: "stage2_agenticFactGuard",
          sessionId: `fact-guard-${agenticCandidate.id}`,
          objective: "Agentic 初稿事实核验",
          parentCandidateId: agenticCandidate.id,
          sourceCandidateId: agenticCandidate.id,
        });
        requireWorkPackageInput(fgPkg, {
          workspaceId,
          chapterId,
          candidateId: agenticCandidate.id,
          text: agenticCandidate.text,
          context,
          knownCharacterNames: characterNames,
          constraintManifest: input.contextSafety?.manifest,
        });
        recordWorkPackage(collabState, fgPkg);
        const fgContract = adaptFactGuardResult(agenticFactGuard, {
          workPackage: fgPkg,
          candidateId: agenticCandidate.id,
          role: "fact_guard",
        });
        recordAgentResult(collabState, fgContract, "author_style", fgPkg.packageId);
      } catch (collabErr: unknown) {
        const failure = classifyCollaborationContractError(
          "fact_guard_contract",
          "fact_guard",
          collabErr,
        );
        stageResults.agentCollaborationError = failure;
        return this.hardBlock(
          input,
          failure.stage,
          formatCollaborationFailureReason(failure),
          stageResults,
          {
            rawText: agenticCandidate.text,
            rawFinishReason: agenticCandidate.finishReason ?? null,
            rawMaxTokens: agenticCandidate.maxTokens ?? null,
            rawModel: agenticCandidate.model,
            modelVersion: detectModelVersion(agenticCandidate.model),
            candidateId: agenticCandidate.id,
          },
          collaborationFailureGuidance(failure),
        );
      }
      if (!agenticFactGuard.ok) {
        return this.hardBlock(
          input,
          "agentic_fact_guard",
          `NovelOS Agentic 初稿在内部恢复后仍有事实硬伤：${agenticFactGuard.errors.join("; ")}`,
          stageResults,
          {
            rawText: agenticCandidate.text,
            rawFinishReason: agenticCandidate.finishReason ?? null,
            rawMaxTokens: agenticCandidate.maxTokens ?? null,
            rawModel: agenticCandidate.model,
            modelVersion: detectModelVersion(agenticCandidate.model),
            factGuardErrors: agenticFactGuard.errors,
            candidateId: agenticCandidate.id,
            selectedSource: "raw",
            finalText: agenticCandidate.text,
          },
        );
      }

      if (input.verifiedDraftBinding && !input.fullPipelinePreview) {
        saveVerifiedDraft(verifiedDraftPath(projectRoot, workspaceId, chapterId), input.verifiedDraftBinding,
          { ...agenticResult, candidate: agenticCandidate });
      }
      // Phase 4B：作者风格优化策略选择（Thompson Sampling）
      // 在 optimize 调用前选择 0-2 个策略，合并参数后传入。
      // 策略信誉按 modelVersion 隔离；新模型版本无历史经验时使用弱先验 Beta(1,1)。
      let authorStyleStrategySelection: AuthorStyleStrategySelection | null = null;
      let authorStyleStrategyParams: import("../learning/author-style-strategy-registry.js").AuthorStyleStrategyParams | undefined;
      try {
        const policyStore = loadStrategyPolicyStore(
          workspaceId ?? "default",
          projectRoot,
        );
        const modelVersionKey = detectModelVersion(agenticCandidate.model);
        authorStyleStrategySelection = selectAuthorStyleStrategies({
          modelVersion: modelVersionKey,
          policyStore,
          seed: input.strategySeed,
        });
        authorStyleStrategyParams = mergeStrategyParams(authorStyleStrategySelection.selected);
        // 记录策略上下文到 stageResults（供后续 outcome / 反馈血缘使用）
        const selectedStrategyIds = authorStyleStrategySelection.selected.map(
          (s) => s.strategyId,
        );
        const exposureSnapshot = authorStyleStrategySelection.exposureSnapshot;
        // 生产路径尚无独立 runId 字段；用 workspace+chapter+时间戳派生可追溯 run 键
        const orchestratorRunId = `run:${workspaceId ?? "default"}:ch${chapterNumber}:${Date.now()}`;
        const exposureId = `exp:${orchestratorRunId}:author_style`;
        const strategyBundleId = exposureSnapshot.strategyBundleId;
        const promptBundleId = "prompt:author_style:default";
        stageResults.authorStyleStrategySelection = {
          selectedStrategyIds,
          staticFallbackIds: authorStyleStrategySelection.staticFallback.map(
            (s) => s.strategyId,
          ),
          samples: authorStyleStrategySelection.samples,
          notes: authorStyleStrategySelection.notes,
          modelVersion: modelVersionKey,
          // USER-FEEDBACK-EVIDENCE-PIPELINE-1：完整 StrategyExposure 字段
          exposureSnapshot,
          strategyBundleId,
          orchestratorRunId,
          exposureId,
          promptBundleId,
          candidateId: agenticCandidate.id,
          deliveredSource: "editorial" as const,
          sourceChapter: `ch${chapterNumber}`,
          opportunityType: "author_style" as const,
        };
      } catch (strategyError) {
        // 策略选择失败不阻断生成；降级为无策略参数（默认行为）
        stageResults.authorStyleStrategySelection = {
          selectedStrategyIds: [],
          staticFallbackIds: [],
          samples: [],
          notes: [`策略选择失败，降级为无策略：${strategyError instanceof Error ? strategyError.message : String(strategyError)}`],
          modelVersion: detectModelVersion(agenticCandidate.model),
          exposureSnapshot: {
            strategyIds: [],
            strategyBundleId: "bundle:empty",
            selectedCount: 0,
          },
          strategyBundleId: "bundle:empty",
          orchestratorRunId: `run:${workspaceId ?? "default"}:ch${chapterNumber}:fallback`,
          exposureId: `exp:fallback:ch${chapterNumber}`,
          promptBundleId: "prompt:author_style:default",
          candidateId: agenticCandidate.id,
          deliveredSource: "editorial" as const,
          sourceChapter: `ch${chapterNumber}`,
          opportunityType: "author_style" as const,
        };
      }

      const styleOptimizationInput = {
        sourceCandidate: agenticCandidate,
        chapterNumber,
        continuationMode: input.continuationMode,
        currentChapterDraft: input.currentChapterDraft,
        intent,
        context,
        constitution,
        writerPromptProfile: input.rawPromptProfile,
        modelGenerate: wrappedModelGenerate!,
        timeoutMs: input.timeoutMs,
        strategyParams: authorStyleStrategyParams,
            targetWordCount: input.targetWordCount,
      };
      let styleResult = await timeAsync("stage3_authorStyleOptimization", () =>
        createAuthorStyleOptimizer().optimize(styleOptimizationInput),
      );
      styleResult = preserveContinuationStyleResult(styleResult, input, agenticCandidate.text);
      stageResults.authorStyleOptimization = {
        styleProfileLoaded: styleResult.styleProfileLoaded,
        styleGuidanceConsumed: styleResult.styleGuidanceConsumed,
        styleReferenceIds: styleResult.styleReferenceIds,
        guidanceCount: styleResult.guidanceCount,
        candidateId: styleResult.candidate?.id ?? null,
        failureReason: styleResult.failureReason,
        retryWithReducedGuidance: styleResult.retryWithReducedGuidance,
      };
      // MA-1：AuthorStyle 结果契约（首次优化；重试后在下方再记一次）
      try {
        const stylePkg = buildRoleWorkPackage(collabState, "author_style", {
          stage: "stage3_authorStyleOptimization",
          sessionId: `style-${agenticCandidate.id}`,
          objective: "作者风格整章优化",
          parentCandidateId: agenticCandidate.id,
          sourceCandidateId: agenticCandidate.id,
          strategyBundleId:
            typeof stageResults.authorStyleStrategySelection === "object" &&
            stageResults.authorStyleStrategySelection &&
            "strategyBundleId" in (stageResults.authorStyleStrategySelection as object)
              ? String(
                  (stageResults.authorStyleStrategySelection as { strategyBundleId?: string })
                    .strategyBundleId ?? "",
                ) || undefined
              : undefined,
        });
        requireWorkPackageInput(stylePkg, {
          workspaceId,
          chapterId,
          chapterNumber,
          sourceCandidate: agenticCandidate,
          intent,
          context,
          constitution,
          strategyParams: authorStyleStrategyParams,
          targetWordCount: input.targetWordCount,
          writerPromptProfile: input.rawPromptProfile,
        });
        recordWorkPackage(collabState, stylePkg);
        const styleContract = adaptEditorialResult(styleResult, {
          workPackage: stylePkg,
          sourceCandidateId: agenticCandidate.id,
          candidateId: styleResult.candidate?.id,
        });
        // 暂存 packageId；若后续 in-stage retry 成功会再 record
        (stageResults as Record<string, unknown>)._authorStyleWorkPackageId = stylePkg.packageId;
        if (styleResult.candidate) {
          recordAgentResult(collabState, styleContract, "story_preservation", stylePkg.packageId);
        } else if (
          styleResult.failureKind !== "empty_result" &&
          styleResult.failureKind !== "model_timeout"
        ) {
          recordAgentResult(collabState, styleContract, "story_preservation", stylePkg.packageId);
        }
      } catch (collabErr: unknown) {
        const failure = classifyCollaborationContractError(
          "author_style_contract",
          "author_style",
          collabErr,
        );
        stageResults.agentCollaborationError = failure;
        return this.hardBlock(
          input,
          failure.stage,
          formatCollaborationFailureReason(failure),
          stageResults,
          {
            rawText: agenticCandidate.text,
            rawFinishReason: agenticCandidate.finishReason ?? null,
            rawMaxTokens: agenticCandidate.maxTokens ?? null,
            rawModel: agenticCandidate.model,
            modelVersion: detectModelVersion(agenticCandidate.model),
            candidateId: agenticCandidate.id,
          },
          collaborationFailureGuidance(failure),
        );
      }
      const transientStyleFailure = !styleResult.candidate
        && (
          styleResult.failureKind === "empty_result" ||
          styleResult.failureKind === "model_timeout" ||
          styleResult.failureKind === "output_contract" ||
          styleResult.failureKind === "continuation_prefix_mismatch" ||
          styleResult.failureKind === "complete_chapter_echo"
        );
      if (transientStyleFailure) {
        const firstFailureKind = styleResult.failureKind;
        const firstFailureReason = styleResult.failureReason ?? "未产出候选";
        const retryInput = styleResult.failureKind === "continuation_prefix_mismatch"
          ? { ...styleOptimizationInput, continuationPrefixRecovery: true }
          : styleResult.failureKind === "complete_chapter_echo"
            ? { ...styleOptimizationInput, completeChapterEchoRecovery: true }
            : styleOptimizationInput;
        let retryResult = await timeAsync("stage3_authorStyleOptimizationRetry", () =>
          createAuthorStyleOptimizer().optimize(retryInput),
        );
        retryResult = preserveContinuationStyleResult(retryResult, input, agenticCandidate.text);
        stageResults.authorStyleOptimizationRetry = {
          attempted: true,
          scope: "author_style_stage",
          maxAttempts: 1,
          triggerFailureKind: firstFailureKind,
          triggerFailureReason: firstFailureReason,
          succeeded: !!retryResult.candidate,
          retryFailureKind: retryResult.failureKind,
          retryFailureReason: retryResult.failureReason,
          candidateId: retryResult.candidate?.id ?? null,
        };
        styleResult = retryResult;
      }
      const initialStyledCandidate = styleResult.candidate;
      if (!initialStyledCandidate) {
        // P0-1 修复（Phase 1 整改）：风格优化未产出候选 → 不再回退 raw 初稿。
        // 按失败归因分类处理：
        // - empty_result/model_timeout 已在本阶段复用同一 Agentic 候选重试一次；耗尽后 hard block。
        // - model_error/no_guidance/prompt_rejected 不伪装成超时，直接 hard block。
        // 工具层 chapter_level_retry 只保留给 Agentic 生成超时。
        // Agentic raw 初稿只作为 blocked evidence 保留在 trace，不交付、不保存。
        const failureKind = styleResult.failureKind ?? "no_guidance";
        stageResults.styleOptimizationBlocked = {
          reason: "no_candidate",
          failureKind,
          failureReason: styleResult.failureReason ?? "未产出候选",
          recoverable: false,
          inStageRetryAttempted: transientStyleFailure,
        };
        return this.hardBlock(
          input,
          "style_optimization_no_candidate",
          `作者风格整章优化未产出候选（${failureKind}）：${styleResult.failureReason ?? "未产出候选"}。Agentic 初稿仅作 blocked evidence 保留，不交付。`,
          stageResults,
          {
            rawText: agenticCandidate.text,
            rawFinishReason: agenticCandidate.finishReason ?? null,
            rawMaxTokens: agenticCandidate.maxTokens ?? null,
            rawModel: agenticCandidate.model,
            modelVersion: detectModelVersion(agenticCandidate.model),
            candidateId: agenticCandidate.id,
          },
          {
            gate: "style_optimization",
            severityOverride: "hard",
            recoverable: false,
            candidateDisposition: "blocked_evidence_only",
            prohibitedActions: [
              "accept_or_deliver_blocked_candidate",
              "save_blocked_candidate_as_chapter",
            ],
          },
        );
      }
      let styledCandidate: Candidate = initialStyledCandidate;
      // MA：若首次未记（transient 失败后重试成功），此处补记 author_style ok
      if (
        transientStyleFailure &&
        styledCandidate &&
        !collabState.completedStages.includes("author_style")
      ) {
        try {
          const styleRetryPkg = buildRoleWorkPackage(collabState, "author_style", {
            stage: "stage3_authorStyleOptimizationRetry",
            sessionId: `style-retry-${agenticCandidate.id}`,
            objective: "作者风格整章优化（阶段内重试成功）",
            parentCandidateId: agenticCandidate.id,
            sourceCandidateId: agenticCandidate.id,
          });
          recordWorkPackage(collabState, styleRetryPkg);
          const styleRetryContract = adaptEditorialResult(styleResult, {
            workPackage: styleRetryPkg,
            sourceCandidateId: agenticCandidate.id,
            candidateId: styledCandidate.id,
          });
          recordAgentResult(
            collabState,
            styleRetryContract,
            "story_preservation",
            styleRetryPkg.packageId,
          );
        } catch (collabErr: unknown) {
          const failure = classifyCollaborationContractError(
            "author_style_retry_contract",
            "author_style",
            collabErr,
          );
          stageResults.agentCollaborationError = failure;
          return this.hardBlock(
            input,
            failure.stage,
            formatCollaborationFailureReason(failure),
            stageResults,
            {
              rawText: agenticCandidate.text,
              rawFinishReason: agenticCandidate.finishReason ?? null,
              rawMaxTokens: agenticCandidate.maxTokens ?? null,
              rawModel: agenticCandidate.model,
              modelVersion: detectModelVersion(agenticCandidate.model),
              candidateId: agenticCandidate.id,
            },
            collaborationFailureGuidance(failure),
          );
        }
      }
      candidates.push(styledCandidate);

      // P0-2 修复（Phase 1 整改）：Story Preservation 使用完整实体表。
      // knownEntities 由 unified-entry 从 characters（含别名）+ worldKeyTerms（factions/places/
      // currencies/professions/specialAbilities）汇聚。缺失时回退 characterNames + characters_only。
      const knownEntities = input.knownEntities ?? characterNames;
      const entityCoverage = input.knownEntities ? "full_entities" : "characters_only";

      const preservation = timeSync("stage4_storyPreservation", () =>
        checkEditorialStoryPreservation({
          rawText: agenticCandidate.text,
          editorialText: styledCandidate!.text,
          knownEntities,
          entityCoverage,
          // P0 第五轮 P1 修复：传入别名→规范名映射，使 raw/editorial 用不同称呼时 subject 比对仍命中。
          aliasToCanonical: input.aliasToCanonical,
        }),
      );
      stageResults.storyPreservation = preservation;
      // MA-1：StoryPreservation 结果契约
      try {
        const spPkg = buildRoleWorkPackage(collabState, "story_preservation", {
          stage: "stage4_storyPreservation",
          sessionId: `sp-${styledCandidate!.id}`,
          objective: "故事保持核验",
          parentCandidateId: agenticCandidate.id,
          sourceCandidateId: agenticCandidate.id,
        });
        requireWorkPackageInput(spPkg, {
          workspaceId,
          chapterId,
          rawText: agenticCandidate.text,
          editorialText: styledCandidate!.text,
          knownEntities: input.knownEntities ?? characterNames,
          entityCoverage: input.knownEntities ? "full_entities" : "characters_only",
          aliasToCanonical: input.aliasToCanonical,
          sourceCandidateId: agenticCandidate.id,
          optimizedCandidateId: styledCandidate!.id,
        });
        recordWorkPackage(collabState, spPkg);
        const spContract = adaptStoryPreservationResult(preservation, {
          workPackage: spPkg,
          sourceCandidateId: agenticCandidate.id,
          optimizedCandidateId: styledCandidate!.id,
        });
        recordAgentResult(collabState, spContract, "final_fact_recheck", spPkg.packageId);
      } catch (collabErr: unknown) {
        const failure = classifyCollaborationContractError(
          "story_preservation_contract",
          "story_preservation",
          collabErr,
        );
        stageResults.agentCollaborationError = failure;
        return this.hardBlock(
          input,
          failure.stage,
          formatCollaborationFailureReason(failure),
          stageResults,
          {
            rawText: styledCandidate!.text,
            rawFinishReason: styledCandidate!.finishReason ?? null,
            rawMaxTokens: styledCandidate!.maxTokens ?? null,
            rawModel: styledCandidate!.model,
            modelVersion: detectModelVersion(styledCandidate!.model),
            candidateId: styledCandidate!.id,
          },
          collaborationFailureGuidance(failure),
        );
      }

      // P0-1 修复（Phase 1 整改）：Story Preservation 失败一律 hard block，不再回退 raw。
      // 分类恢复：
      // - unverifiable（事件抽取失败/空文本/无实体）→ 缩减风格指导重试一次；仍不可验证 → hard block。
      // - 明确漂移（missing_event/replaced_event/order_violation）→ 缩减风格指导重试一次；仍漂移 → hard block。
      // - 重试未产出候选 → hard block（in-stage 重试预算已耗尽，不再触发 chapter_level_retry）。
      // Agentic raw 初稿只作为 blocked evidence 保留在 trace，不交付、不保存、不提交状态。
      // 铁律：Agentic 初稿不直接交付；作者风格整章优化是必经阶段。
      const blockedEvidenceForPreservation = {
        rawText: agenticCandidate.text,
        rawFinishReason: agenticCandidate.finishReason ?? null,
        rawMaxTokens: agenticCandidate.maxTokens ?? null,
        rawModel: agenticCandidate.model,
        modelVersion: detectModelVersion(agenticCandidate.model),
        candidateId: styledCandidate.id,
      };
      const preservationBlockGuidance: HardBlockGuidance = {
        gate: "story_preservation",
        severityOverride: "hard",
        recoverable: false,
        candidateDisposition: "blocked_evidence_only",
        prohibitedActions: [
          "accept_or_deliver_blocked_candidate",
          "save_blocked_candidate_as_chapter",
        ],
      };

      if (!preservation.preserved && preservation.unverifiable) {
        let retryStyleResult = await timeAsync("stage4a_authorStyleRetryUnverifiable", () =>
          createAuthorStyleOptimizer().optimize({
            sourceCandidate: agenticCandidate,
            chapterNumber,
            continuationMode: input.continuationMode,
            currentChapterDraft: input.currentChapterDraft,
            chineseAiLanguageGuidanceBlock: chineseAiLanguageGuidance.block,
            intent,
            context,
            constitution,
            writerPromptProfile: input.rawPromptProfile,
            modelGenerate: wrappedModelGenerate!,
            timeoutMs: input.timeoutMs,
            targetWordCount: input.targetWordCount,
            reducedGuidanceRatio: 0.5,
          }),
        );
        retryStyleResult = preserveContinuationStyleResult(retryStyleResult, input, agenticCandidate.text);
        stageResults.authorStyleOptimizationUnverifiableRetry = {
          styleProfileLoaded: retryStyleResult.styleProfileLoaded,
          styleGuidanceConsumed: retryStyleResult.styleGuidanceConsumed,
          styleReferenceIds: retryStyleResult.styleReferenceIds,
          guidanceCount: retryStyleResult.guidanceCount,
          candidateId: retryStyleResult.candidate?.id ?? null,
          failureReason: retryStyleResult.failureReason,
          retryWithReducedGuidance: retryStyleResult.retryWithReducedGuidance,
          firstPreservationUnverifiable: true,
          firstPreservationReason: preservation.reason,
        };
        const retryCandidate = retryStyleResult.candidate;
        if (retryCandidate) {
          const retryPreservation = timeSync("stage4b_retryStoryPreservation", () =>
            checkEditorialStoryPreservation({
              rawText: agenticCandidate.text,
              editorialText: retryCandidate.text,
              knownEntities,
              entityCoverage,
              aliasToCanonical: input.aliasToCanonical,
            }),
          );
          stageResults.retryStoryPreservation = retryPreservation;
          if (retryPreservation.preserved) {
            // 重试通过：用重试候选替换原 styledCandidate
            const staleCandidateIndex = candidates.findIndex((c) => c.id === styledCandidate!.id);
            if (staleCandidateIndex >= 0) candidates.splice(staleCandidateIndex, 1);
            styledCandidate = retryCandidate;
            candidates.push(styledCandidate);
            // MA：重试通过后补记 story_preservation ok（首次可能为 blocked/recoverable）
            try {
              const spRetryPkg = buildRoleWorkPackage(collabState, "story_preservation", {
                stage: "stage4b_retryStoryPreservation",
                sessionId: `sp-retry-${styledCandidate.id}`,
                objective: "故事保持核验（缩减指导重试后）",
                parentCandidateId: agenticCandidate.id,
                sourceCandidateId: agenticCandidate.id,
              });
              recordWorkPackage(collabState, spRetryPkg);
              const spRetryContract = adaptStoryPreservationResult(retryPreservation, {
                workPackage: spRetryPkg,
                sourceCandidateId: agenticCandidate.id,
                optimizedCandidateId: styledCandidate.id,
              });
              recordAgentResult(
                collabState,
                spRetryContract,
                "final_fact_recheck",
                spRetryPkg.packageId,
              );
            } catch (collabErr: unknown) {
              const failure = classifyCollaborationContractError(
                "story_preservation_retry_contract",
                "story_preservation",
                collabErr,
              );
              stageResults.agentCollaborationError = failure;
              return this.hardBlock(
                input,
                failure.stage,
                formatCollaborationFailureReason(failure),
                stageResults,
                blockedEvidenceForPreservation,
                collaborationFailureGuidance(failure),
              );
            }
          } else if (!retryPreservation.preserved && !retryPreservation.unverifiable) {
            // 重试出现明确漂移 → hard block（不再回退 raw）
            stageResults.styleOptimizationBlocked = {
              reason: "unverifiable_retry_drift",
              firstUnverifiableReason: preservation.reason,
              retryDriftReason: retryPreservation.reason,
            };
            return this.hardBlock(
              input,
              "story_preservation_retry_drift",
              `作者风格优化重试出现明确故事漂移：首次不可验证（${preservation.reason}），重试漂移（${retryPreservation.reason}）。Agentic 初稿仅作 blocked evidence，不交付。`,
              stageResults,
              blockedEvidenceForPreservation,
              preservationBlockGuidance,
            );
          } else {
            // 重试仍 unverifiable → hard block（不再回退 raw）
            stageResults.styleOptimizationBlocked = {
              reason: "unverifiable_retry_failed",
              firstUnverifiableReason: preservation.reason,
              retryUnverifiableReason: retryPreservation.reason,
            };
            return this.hardBlock(
              input,
              "story_preservation_unverifiable_retry_failed",
              `作者风格优化缩减指导重试仍不可验证：首次（${preservation.reason}），重试（${retryPreservation.reason}）。Agentic 初稿仅作 blocked evidence，不交付。`,
              stageResults,
              blockedEvidenceForPreservation,
              preservationBlockGuidance,
            );
          }
        } else {
          // 重试未产出候选 → hard block（in-stage 重试预算已耗尽）
          stageResults.styleOptimizationBlocked = {
            reason: "unverifiable_retry_no_candidate",
            firstUnverifiableReason: preservation.reason,
            retryFailureReason: retryStyleResult.failureReason ?? "未产出",
          };
          return this.hardBlock(
            input,
            "story_preservation_unverifiable_retry_no_candidate",
            `作者风格优化缩减指导重试未产出候选：${retryStyleResult.failureReason ?? "未产出"}。Agentic 初稿仅作 blocked evidence，不交付。`,
            stageResults,
            blockedEvidenceForPreservation,
            preservationBlockGuidance,
          );
        }
      } else if (!preservation.preserved) {
        // 明确故事漂移（非 unverifiable）→ 缩减风格指导重试一次；仍漂移 → hard block。
        // P1 修复：把 Story Preservation 检测到的 replacedEvents 作为 driftFeedback 传入，
        // 让重试 prompt 明确告知模型哪些事件被改写了（而非仅缩减 style guidance）。
        // canary 证据：100% 阻断率源于 amplified 模型改写事件内容（如"看不见"→"清晰看到"），
        // 单纯缩减 guidance 不足以纠正；需要具体事件保持约束。
        let driftRetryStyleResult = await timeAsync("stage4a_authorStyleRetryDrift", () =>
          createAuthorStyleOptimizer().optimize({
            sourceCandidate: agenticCandidate,
            chapterNumber,
            continuationMode: input.continuationMode,
              currentChapterDraft: input.currentChapterDraft,
              chineseAiLanguageGuidanceBlock: chineseAiLanguageGuidance.block,
            intent,
            context,
            constitution,
            writerPromptProfile: input.rawPromptProfile,
            modelGenerate: wrappedModelGenerate!,
            timeoutMs: input.timeoutMs,
        targetWordCount: input.targetWordCount,
            reducedGuidanceRatio: 0.5,
            driftFeedback: {
              replacedEvents: (preservation.replacedEvents ?? []).map((e) => ({
                subject: e.subject,
                rawSentence: e.rawSentence,
                editorialSentence: e.editorialSentence,
                reason: e.reason,
              })),
              stateChangeLosses: (preservation.stateChangeLosses ?? []).map((e) => ({
                subject: e.subject,
                afterState: e.afterState,
                rawSentence: e.rawSentence,
                reason: e.reason,
              })),
            },
          }),
        );
        driftRetryStyleResult = preserveContinuationStyleResult(driftRetryStyleResult, input, agenticCandidate.text);
        stageResults.authorStyleOptimizationDriftRetry = {
          styleProfileLoaded: driftRetryStyleResult.styleProfileLoaded,
          styleGuidanceConsumed: driftRetryStyleResult.styleGuidanceConsumed,
          styleReferenceIds: driftRetryStyleResult.styleReferenceIds,
          guidanceCount: driftRetryStyleResult.guidanceCount,
          candidateId: driftRetryStyleResult.candidate?.id ?? null,
          failureReason: driftRetryStyleResult.failureReason,
          retryWithReducedGuidance: driftRetryStyleResult.retryWithReducedGuidance,
          firstDriftReason: preservation.reason,
        };
        const driftRetryCandidate = driftRetryStyleResult.candidate;
        if (driftRetryCandidate) {
          const driftRetryPreservation = timeSync("stage4b_retryStoryPreservationDrift", () =>
            checkEditorialStoryPreservation({
              rawText: agenticCandidate.text,
              editorialText: driftRetryCandidate.text,
              knownEntities,
              entityCoverage,
              aliasToCanonical: input.aliasToCanonical,
            }),
          );
          stageResults.retryStoryPreservationDrift = driftRetryPreservation;
          if (driftRetryPreservation.preserved) {
            // 重试通过：用重试候选替换原 styledCandidate
            const staleCandidateIndex = candidates.findIndex((c) => c.id === styledCandidate!.id);
            if (staleCandidateIndex >= 0) candidates.splice(staleCandidateIndex, 1);
            styledCandidate = driftRetryCandidate;
            candidates.push(styledCandidate);
            // MA：重试通过后补记 story_preservation ok（首次为 blocked，未进入 completedStages）
            try {
              const spDriftRetryPkg = buildRoleWorkPackage(collabState, "story_preservation", {
                stage: "stage4b_retryStoryPreservationDrift",
                sessionId: `sp-drift-retry-${styledCandidate.id}`,
                objective: "故事保持核验（漂移缩减指导重试后）",
                parentCandidateId: agenticCandidate.id,
                sourceCandidateId: agenticCandidate.id,
              });
              recordWorkPackage(collabState, spDriftRetryPkg);
              const spDriftRetryContract = adaptStoryPreservationResult(driftRetryPreservation, {
                workPackage: spDriftRetryPkg,
                sourceCandidateId: agenticCandidate.id,
                optimizedCandidateId: styledCandidate.id,
              });
              recordAgentResult(
                collabState,
                spDriftRetryContract,
                "final_fact_recheck",
                spDriftRetryPkg.packageId,
              );
            } catch (collabErr: unknown) {
              // fail-closed：契约记录失败不得伪装 completedStages 后继续提交
              const failure = classifyCollaborationContractError(
                "story_preservation_drift_retry_contract",
                "story_preservation",
                collabErr,
              );
              stageResults.agentCollaborationError = failure;
              return this.hardBlock(
                input,
                failure.stage,
                formatCollaborationFailureReason(failure),
                stageResults,
                blockedEvidenceForPreservation,
                collaborationFailureGuidance(failure),
              );
            }
          } else {
            // 重试仍漂移 → hard block（不再回退 raw）
            stageResults.styleOptimizationBlocked = {
              reason: "drift_retry_failed",
              firstDriftReason: preservation.reason,
              retryDriftReason: driftRetryPreservation.reason,
            };
            return this.hardBlock(
              input,
              "story_preservation_drift_retry_failed",
              `作者风格优化缩减指导重试仍漂移：首次（${preservation.reason}），重试（${driftRetryPreservation.reason}）。Agentic 初稿仅作 blocked evidence，不交付。`,
              stageResults,
              blockedEvidenceForPreservation,
              preservationBlockGuidance,
            );
          }
        } else {
          // 重试未产出候选 → hard block
          stageResults.styleOptimizationBlocked = {
            reason: "drift_retry_no_candidate",
            firstDriftReason: preservation.reason,
            retryFailureReason: driftRetryStyleResult.failureReason ?? "未产出",
          };
          return this.hardBlock(
            input,
            "story_preservation_drift_retry_no_candidate",
            `作者风格优化缩减指导重试未产出候选：${driftRetryStyleResult.failureReason ?? "未产出"}。Agentic 初稿仅作 blocked evidence，不交付。`,
            stageResults,
            blockedEvidenceForPreservation,
            preservationBlockGuidance,
          );
        }
      }

      // P1 修复：人工审阅包 — 永久保留初稿/优化稿差异、事实复检结果与用户修改量占位
      // 在获得用户样本前，不宣称整章风格优化稳定优于 Agentic 初稿
      stageResults.authorStyleHumanReviewPackage = buildAuthorStyleHumanReviewPackage(
        agenticCandidate,
        styledCandidate,
        chapterNumber,
      );

      let finalFactRecheck = timeSync("stage5_finalFactRecheck", () =>
        checkCandidateFactGuard(styledCandidate!.text, input, agenticCandidate.text),
      );
      const duplicateHardBlocks = finalFactRecheck.report.hardBlocks.filter(
        (finding) => finding.source === "duplicate_scan",
      );
      if (
        !finalFactRecheck.ok
        && duplicateHardBlocks.length > 0
        && duplicateHardBlocks.length === finalFactRecheck.report.hardBlocks.length
      ) {
        const repaired = repairDuplicateFindings(
          styledCandidate.text,
          duplicateHardBlocks as DuplicateFindingLike[],
          input.continuationMode === "append" ? input.currentChapterDraft ?? "" : "",
        );
        if (repaired.changed) {
          const patchedCandidate: Candidate = {
            ...styledCandidate,
            id: `${styledCandidate.id}:dedupe:${hashText(repaired.text).slice(0, 16)}`,
            text: repaired.text,
            sourceCandidateId: styledCandidate.sourceCandidateId ?? agenticCandidate.id,
          };
          const duplicatePreservation = timeSync("stage4_storyPreservationAfterDedupe", () =>
            checkEditorialStoryPreservation({
              rawText: agenticCandidate.text,
              editorialText: patchedCandidate.text,
              knownEntities,
              entityCoverage,
              aliasToCanonical: input.aliasToCanonical,
            }),
          );
          const duplicateFactRecheck = timeSync("stage5_finalFactRecheckAfterDedupe", () =>
            checkCandidateFactGuard(patchedCandidate.text, input, agenticCandidate.text),
          );
          const duplicateCompleteness = scanFinalTextCompleteness(patchedCandidate.text, {
            finishReason: patchedCandidate.finishReason,
            chapterNumber,
          });
          const duplicateLength = input.targetWordCount
            ? assessTargetLength(patchedCandidate.text, input.targetWordCount)
            : null;
          const accepted = duplicatePreservation.preserved
            && duplicateFactRecheck.ok
            && duplicateCompleteness.passed
            && !duplicateLength?.needsContinuation;
          stageResults.finalDuplicateRepair = {
            changed: true,
            accepted,
            removed: repaired.removed,
            storyPreservation: duplicatePreservation,
            factRecheck: duplicateFactRecheck,
            completeness: duplicateCompleteness,
            targetLength: duplicateLength,
          };
          if (accepted) {
            const staleCandidateIndex = candidates.findIndex((candidate) => candidate.id === styledCandidate!.id);
            if (staleCandidateIndex >= 0) candidates.splice(staleCandidateIndex, 1);
            styledCandidate = patchedCandidate;
            candidates.push(styledCandidate);
            stageResults.storyPreservation = duplicatePreservation;
            finalFactRecheck = duplicateFactRecheck;
            stageResults.authorStyleHumanReviewPackage = buildAuthorStyleHumanReviewPackage(
              agenticCandidate,
              styledCandidate,
              chapterNumber,
            );
          }
        } else {
          stageResults.finalDuplicateRepair = {
            changed: false,
            accepted: false,
            reason: "no_exact_duplicate_segment",
          };
        }
      }

      type FinalRecoveryReason = "target_length" | "fact_guard" | "completeness";
      const finalRecoveryAttempts: Array<{
        attempt: number;
        reason: FinalRecoveryReason;
        sourceCandidateId: string;
        resultCandidateId: string | null;
        outcome: "accepted" | "rejected" | "no_candidate" | "budget_exhausted";
        evidence: string[];
      }> = [];
      const finalGenerationRecovery = {
        maxAttempts: (stageResults.recoveryBudget as RecoveryBudget).maxTotalAttempts,
        attempts: finalRecoveryAttempts,
        exhausted: false,
        succeeded: false,
      };
      stageResults.finalGenerationRecovery = finalGenerationRecovery;

      let finalCompleteness = scanFinalTextCompleteness(styledCandidate.text, {
        finishReason: styledCandidate.finishReason,
        chapterNumber,
      });
      let finalTargetLength = input.targetWordCount
        ? assessTargetLength(styledCandidate.text, input.targetWordCount)
        : null;

      const reserveFinalStyleRecovery = (): boolean => {
        const currentBudget = (stageResults.recoveryBudget as RecoveryBudget | undefined)
          ?? recoveryBudget;
        const reserved = reserveBudget(currentBudget, {
          totalAttempts: 1,
          recoveryModelCalls: 1,
          modelCalls: 1,
        });
        if (!reserved.ok) {
          finalGenerationRecovery.exhausted = true;
          return false;
        }
        stageResults.recoveryBudget = reserved.budget;
        const governance = getGovernanceState(stageResults);
        if (governance) {
          setGovernanceState(stageResults, {
            ...governance,
            layeredBudget: {
              ...governance.layeredBudget,
              legacyRecovery: reserved.budget,
            },
          });
        }
        return true;
      };

      const recordRecoveredStyleContracts = (
        recoveredStyleResult: AuthorStyleOptimizationResult,
        recoveredCandidate: Candidate,
        recoveredPreservation: StoryPreservationGateReport,
        reason: FinalRecoveryReason,
      ): void => {
        const stylePkg = buildRoleWorkPackage(collabState, "author_style", {
          stage: `stage3_authorStyleFinalRecovery_${reason}`,
          sessionId: `style-final-recovery-${reason}-${recoveredCandidate.id}`,
          objective: "作者风格整章优化（最终门禁恢复）",
          parentCandidateId: agenticCandidate.id,
          sourceCandidateId: agenticCandidate.id,
        });
        requireWorkPackageInput(stylePkg, {
          workspaceId,
          chapterId,
          chapterNumber,
          sourceCandidate: agenticCandidate,
          intent,
          context,
          constitution,
          strategyParams: authorStyleStrategyParams,
          targetWordCount: input.targetWordCount,
          writerPromptProfile: input.rawPromptProfile,
        });
        recordWorkPackage(collabState, stylePkg);
        const styleContract = adaptEditorialResult(recoveredStyleResult, {
          workPackage: stylePkg,
          sourceCandidateId: agenticCandidate.id,
          candidateId: recoveredCandidate.id,
        });
        recordAgentResult(collabState, styleContract, "story_preservation", stylePkg.packageId);

        const spPkg = buildRoleWorkPackage(collabState, "story_preservation", {
          stage: `stage4_storyPreservationFinalRecovery_${reason}`,
          sessionId: `sp-final-recovery-${reason}-${recoveredCandidate.id}`,
          objective: "故事保持核验（最终门禁恢复）",
          parentCandidateId: agenticCandidate.id,
          sourceCandidateId: agenticCandidate.id,
        });
        requireWorkPackageInput(spPkg, {
          workspaceId,
          chapterId,
          rawText: agenticCandidate.text,
          editorialText: recoveredCandidate.text,
          knownEntities,
          entityCoverage,
          aliasToCanonical: input.aliasToCanonical,
          sourceCandidateId: agenticCandidate.id,
          optimizedCandidateId: recoveredCandidate.id,
        });
        recordWorkPackage(collabState, spPkg);
        const spContract = adaptStoryPreservationResult(recoveredPreservation, {
          workPackage: spPkg,
          sourceCandidateId: agenticCandidate.id,
          optimizedCandidateId: recoveredCandidate.id,
        });
        recordAgentResult(collabState, spContract, "final_fact_recheck", spPkg.packageId);
      };

      const regenerateStyledCandidate = async (
        reason: FinalRecoveryReason,
        evidence: string[],
        recoveryFeedback?: {
          kind: "fact_guard" | "completeness";
          previousEditorialText: string;
          findings: Array<{ code: string; message: string; evidenceRef?: string }>;
        },
      ): Promise<boolean> => {
        const attempt = finalRecoveryAttempts.length + 1;
        if (!reserveFinalStyleRecovery()) {
          finalRecoveryAttempts.push({
            attempt,
            reason,
            sourceCandidateId: styledCandidate.id,
            resultCandidateId: null,
            outcome: "budget_exhausted",
            evidence: [...evidence],
          });
          return false;
        }

        let recoveredStyleResult = await timeAsync(
          `stage3_authorStyleFinalRecovery_${attempt}_${reason}`,
          () => createAuthorStyleOptimizer().optimize({
            ...styleOptimizationInput,
            sourceCandidate: agenticCandidate,
            ...(recoveryFeedback ? { recoveryFeedback } : {}),
          }),
        );
        recoveredStyleResult = preserveContinuationStyleResult(recoveredStyleResult, input, agenticCandidate.text);
        const recoveredCandidate = recoveredStyleResult.candidate;
        if (!recoveredCandidate) {
          finalRecoveryAttempts.push({
            attempt,
            reason,
            sourceCandidateId: styledCandidate.id,
            resultCandidateId: null,
            outcome: "no_candidate",
            evidence: [
              ...evidence,
              recoveredStyleResult.failureReason ?? "作者风格恢复未产出候选",
            ],
          });
          return false;
        }

        const recoveredPreservation = timeSync(
          `stage4_storyPreservationFinalRecovery_${attempt}_${reason}`,
          () => checkEditorialStoryPreservation({
            rawText: agenticCandidate.text,
            editorialText: recoveredCandidate.text,
            knownEntities,
            entityCoverage,
            aliasToCanonical: input.aliasToCanonical,
          }),
        );
        const recoveredFactRecheck = timeSync(
          `stage5_finalFactRecheckRecovery_${attempt}_${reason}`,
          () => checkCandidateFactGuard(recoveredCandidate.text, input, agenticCandidate.text),
        );
        const recoveredCompleteness = scanFinalTextCompleteness(recoveredCandidate.text, {
          finishReason: recoveredCandidate.finishReason,
          chapterNumber,
        });
        const recoveredLength = input.targetWordCount
          ? assessTargetLength(recoveredCandidate.text, input.targetWordCount)
          : null;
        const accepted = recoveredPreservation.preserved
          && recoveredFactRecheck.ok
          && recoveredCompleteness.passed
          && !recoveredLength?.needsContinuation;
        finalRecoveryAttempts.push({
          attempt,
          reason,
          sourceCandidateId: styledCandidate.id,
          resultCandidateId: recoveredCandidate.id,
          outcome: accepted ? "accepted" : "rejected",
          evidence: [
            ...evidence,
            ...(recoveredPreservation.preserved ? [] : [recoveredPreservation.reason]),
            ...recoveredFactRecheck.errors,
            ...recoveredCompleteness.findings.map((finding) => finding.reason),
            ...(recoveredLength?.needsContinuation
              ? [`仍少 ${recoveredLength.remaining} 字`]
              : []),
          ],
        });
        if (!accepted) return false;

        const staleCandidateIndex = candidates.findIndex(
          (candidate) => candidate.id === styledCandidate.id,
        );
        if (staleCandidateIndex >= 0) candidates.splice(staleCandidateIndex, 1);
        styledCandidate = recoveredCandidate;
        candidates.push(styledCandidate);
        stageResults.storyPreservation = recoveredPreservation;
        finalFactRecheck = recoveredFactRecheck;
        finalCompleteness = recoveredCompleteness;
        finalTargetLength = recoveredLength;
        stageResults.authorStyleOptimizationFinalRecovery = {
          reason,
          styleProfileLoaded: recoveredStyleResult.styleProfileLoaded,
          styleGuidanceConsumed: recoveredStyleResult.styleGuidanceConsumed,
          styleReferenceIds: recoveredStyleResult.styleReferenceIds,
          guidanceCount: recoveredStyleResult.guidanceCount,
          candidateId: recoveredCandidate.id,
        };
        stageResults.authorStyleHumanReviewPackage = buildAuthorStyleHumanReviewPackage(
          agenticCandidate,
          styledCandidate,
          chapterNumber,
        );
        recordRecoveredStyleContracts(
          recoveredStyleResult,
          recoveredCandidate,
          recoveredPreservation,
          reason,
        );
        return true;
      };

      while (true) {
        if (finalTargetLength?.needsContinuation) {
          const shortStyledCandidateId = styledCandidate.id;
          const previousAgenticCandidate = agenticCandidate;
          const rawLength = assessTargetLength(agenticCandidate.text, input.targetWordCount!);
          const expansionBuffer = Math.max(
            50,
            Math.ceil(input.targetWordCount!.min * 0.05),
          );
          const expandedMinimum = rawLength.contentCharacters
            + finalTargetLength.remaining
            + expansionBuffer;
          const expandedTarget = {
            min: expandedMinimum,
            max: Math.max(
              expandedMinimum + expansionBuffer,
              input.targetWordCount!.max + finalTargetLength.remaining,
            ),
          };
          const recoveredAgenticResult = await runAgenticRecovery(
            "target_length",
            agenticCandidate.id,
            [
              `优化稿仍少 ${finalTargetLength.remaining} 字`,
              `最终最低字数=${finalTargetLength.minimum}`,
            ],
            {
              continuationMode: "append",
              currentChapterDraft: agenticCandidate.text,
              targetWordCount: expandedTarget,
            },
          );
          if (!recoveredAgenticResult) {
            finalRecoveryAttempts.push({
              attempt: finalRecoveryAttempts.length + 1,
              reason: "target_length",
              sourceCandidateId: shortStyledCandidateId,
              resultCandidateId: null,
              outcome: "budget_exhausted",
              evidence: [`优化稿仍少 ${finalTargetLength.remaining} 字`],
            });
            finalGenerationRecovery.exhausted = true;
            break;
          }
          agenticResult = recoveredAgenticResult;
          pendingAgenticCandidate = recoveredAgenticResult.candidate;
          latestAgenticCompleteness = null;
          latestAgenticFactGuard = null;
          await ensureAgenticCandidateReady();
          const expandedAgenticCandidate = pendingAgenticCandidate;
          if (
            !expandedAgenticCandidate
            || agenticResult.verifierCleared !== true
            || !checkCandidateTextHashBinding(expandedAgenticCandidate).ok
          ) {
            finalRecoveryAttempts.push({
              attempt: finalRecoveryAttempts.length + 1,
              reason: "target_length",
              sourceCandidateId: shortStyledCandidateId,
              resultCandidateId: expandedAgenticCandidate?.id ?? null,
              outcome: "rejected",
              evidence: ["扩充后的 Agentic 候选未通过 verifier 或 hash 绑定"],
            });
            break;
          }
          agenticCandidate = expandedAgenticCandidate;
          const expandedCompleteness = scanFinalTextCompleteness(expandedAgenticCandidate.text, {
            finishReason: expandedAgenticCandidate.finishReason,
            chapterNumber,
          });
          const expandedFactGuard = checkCandidateFactGuard(expandedAgenticCandidate.text, input);
          if (!expandedCompleteness.passed || !expandedFactGuard.ok) {
            finalRecoveryAttempts.push({
              attempt: finalRecoveryAttempts.length + 1,
              reason: "target_length",
              sourceCandidateId: shortStyledCandidateId,
              resultCandidateId: expandedAgenticCandidate.id,
              outcome: "rejected",
              evidence: [
                ...expandedCompleteness.findings.map((finding) => finding.reason),
                ...expandedFactGuard.errors,
              ],
            });
            break;
          }
          if (!candidates.some((candidate) => candidate.id === expandedAgenticCandidate.id)) {
            candidates.push(expandedAgenticCandidate);
          }
          stageResults.agenticCompleteness = expandedCompleteness;
          stageResults.agenticFactGuard = expandedFactGuard;
          stageResults.novelos = {
            ...(stageResults.novelos as Record<string, unknown>),
            sessionId: agenticResult.sessionId,
            trajectoryPath: agenticResult.trajectoryPath,
            candidateId: expandedAgenticCandidate.id,
            candidateLength: expandedAgenticCandidate.text.length,
            verifierCleared: agenticResult.verifierCleared,
            recovered: true,
            recoveredFromCandidateId: previousAgenticCandidate.id,
          };

          try {
            const recoveredAgenticPkg = buildRoleWorkPackage(collabState, "novelos_agentic", {
              stage: "stage1_novelosAgenticFinalLengthRecovery",
              sessionId: agenticResult.sessionId,
              objective: "NovelOS Agentic 初稿扩充（不直接交付）",
              parentCandidateId: previousAgenticCandidate.id,
              sourceCandidateId: previousAgenticCandidate.id,
            });
            requireWorkPackageInput(recoveredAgenticPkg, {
              workspaceId,
              chapterId,
              chapterNumber,
              chapterIntent: intent,
              seedContext: context,
              context,
              knownCharacterNames: characterNames,
              inviolableFacts: intent.inviolableFacts,
              targetWordCount: expandedTarget,
              toolMode: input.toolMode,
              evalPrefix: input.evalPrefix,
              retrievalPromptOverride: input.retrievalPromptOverride,
            });
            recordWorkPackage(collabState, recoveredAgenticPkg);
            const recoveredDraftContract = adaptDraftFromAgenticSource(agenticResult, {
              workPackage: recoveredAgenticPkg,
              candidateId: expandedAgenticCandidate.id,
            });
            recordAgentResult(
              collabState,
              recoveredDraftContract,
              "fact_guard",
              recoveredAgenticPkg.packageId,
            );

            const recoveredFactPkg = buildRoleWorkPackage(collabState, "fact_guard", {
              stage: "stage2_agenticFactGuardFinalLengthRecovery",
              sessionId: `fact-guard-final-length-${expandedAgenticCandidate.id}`,
              objective: "扩充后 Agentic 初稿事实核验",
              parentCandidateId: expandedAgenticCandidate.id,
              sourceCandidateId: expandedAgenticCandidate.id,
            });
            requireWorkPackageInput(recoveredFactPkg, {
              workspaceId,
              chapterId,
              candidateId: expandedAgenticCandidate.id,
              text: expandedAgenticCandidate.text,
              context,
              knownCharacterNames: characterNames,
              constraintManifest: input.contextSafety?.manifest,
            });
            recordWorkPackage(collabState, recoveredFactPkg);
            const recoveredFactContract = adaptFactGuardResult(expandedFactGuard, {
              workPackage: recoveredFactPkg,
              candidateId: expandedAgenticCandidate.id,
              role: "fact_guard",
            });
            recordAgentResult(
              collabState,
              recoveredFactContract,
              "author_style",
              recoveredFactPkg.packageId,
            );
          } catch (collabErr: unknown) {
            const failure = classifyCollaborationContractError(
              "final_length_recovery_contract",
              "novelos_agentic",
              collabErr,
            );
            stageResults.agentCollaborationError = failure;
            return this.hardBlock(
              input,
              failure.stage,
              formatCollaborationFailureReason(failure),
              stageResults,
              {
                rawText: expandedAgenticCandidate.text,
                rawFinishReason: expandedAgenticCandidate.finishReason ?? null,
                rawMaxTokens: expandedAgenticCandidate.maxTokens ?? null,
                rawModel: expandedAgenticCandidate.model,
                modelVersion: detectModelVersion(expandedAgenticCandidate.model),
                candidateId: expandedAgenticCandidate.id,
              },
              collaborationFailureGuidance(failure),
            );
          }

          const recovered = await regenerateStyledCandidate(
            "target_length",
            [`优化稿仍少 ${finalTargetLength.remaining} 字`],
          );
          if (!recovered && finalGenerationRecovery.exhausted) break;
          continue;
        }

        if (!finalFactRecheck.ok) {
          const recovered = await regenerateStyledCandidate(
            "fact_guard",
            finalFactRecheck.errors,
            {
              kind: "fact_guard",
              previousEditorialText: styledCandidate.text,
              findings: finalFactRecheck.report.hardBlocks.map((finding) => ({
                code: finding.id,
                message: finding.evidence,
                evidenceRef: finding.source,
              })),
            },
          );
          if (!recovered && finalGenerationRecovery.exhausted) break;
          if (!recovered && finalRecoveryAttempts.length >= finalGenerationRecovery.maxAttempts) {
            finalGenerationRecovery.exhausted = true;
            break;
          }
          continue;
        }

        if (!finalCompleteness.passed) {
          const recovered = await regenerateStyledCandidate(
            "completeness",
            finalCompleteness.findings.map((finding) => finding.reason),
            {
              kind: "completeness",
              previousEditorialText: styledCandidate.text,
              findings: finalCompleteness.findings.map((finding) => ({
                code: finding.code ?? "incomplete_output",
                message: finding.reason,
                evidenceRef: finding.span
                  ? `span:${finding.span.start}-${finding.span.end}`
                  : undefined,
              })),
            },
          );
          if (!recovered && finalGenerationRecovery.exhausted) break;
          if (!recovered && finalRecoveryAttempts.length >= finalGenerationRecovery.maxAttempts) {
            finalGenerationRecovery.exhausted = true;
            break;
          }
          continue;
        }
        break;
      }

      finalGenerationRecovery.succeeded = finalRecoveryAttempts.length > 0
        && finalFactRecheck.ok
        && finalCompleteness.passed
        && !finalTargetLength?.needsContinuation;
      stageResults.finalFactRecheck = finalFactRecheck;
      stageResults.finalTargetLength = finalTargetLength;
      // MA-1：FinalFactRecheck 结果契约
      try {
        const rePkg = buildRoleWorkPackage(collabState, "final_fact_recheck", {
          stage: "stage5_finalFactRecheck",
          sessionId: `recheck-${styledCandidate.id}`,
          objective: "最终事实复核",
          parentCandidateId: styledCandidate.id,
          sourceCandidateId: agenticCandidate.id,
        });
        requireWorkPackageInput(rePkg, {
          workspaceId,
          chapterId,
          candidateId: styledCandidate.id,
          finalText: styledCandidate.text,
          context,
          knownCharacterNames: characterNames,
          inviolableFacts: intent.inviolableFacts,
          constraintManifest: input.contextSafety?.manifest,
        });
        recordWorkPackage(collabState, rePkg);
        const reContract = adaptFactGuardResult(finalFactRecheck, {
          workPackage: rePkg,
          candidateId: styledCandidate.id,
          role: "final_fact_recheck",
        });
        recordAgentResult(collabState, reContract, "final_state_commit", rePkg.packageId);
      } catch (collabErr: unknown) {
        const failure = classifyCollaborationContractError(
          "final_fact_recheck_contract",
          "final_fact_recheck",
          collabErr,
        );
        stageResults.agentCollaborationError = failure;
        return this.hardBlock(
          input,
          failure.stage,
          formatCollaborationFailureReason(failure),
          stageResults,
          {
            rawText: styledCandidate.text,
            rawFinishReason: styledCandidate.finishReason ?? null,
            rawMaxTokens: styledCandidate.maxTokens ?? null,
            rawModel: styledCandidate.model,
            modelVersion: detectModelVersion(styledCandidate.model),
            candidateId: styledCandidate.id,
          },
          collaborationFailureGuidance(failure),
        );
      }
      // P1 修复：回填人工审阅包的事实复检结果
      if (stageResults.authorStyleHumanReviewPackage) {
        (stageResults.authorStyleHumanReviewPackage as AuthorStyleHumanReviewPackage).factRecheckResult = {
          ok: finalFactRecheck.ok,
          errors: finalFactRecheck.errors,
        };
      }
      // P1 修复（审阅包回填）：持久化 sidecar，供用户反馈时回填 userModificationDelta
      // 预览/eval/skip-commit 模式不写 sidecar（与 chapterFilePath=null 一致，不写副作用）
      if (
        stageResults.authorStyleHumanReviewPackage
        && !input.evalMode
        && !input.fullPipelinePreview
      ) {
        const reviewPackagePath = persistAuthorStyleReviewPackage(
          input.projectRoot,
          input.workspaceId,
          input.chapterId,
          stageResults.authorStyleHumanReviewPackage as AuthorStyleHumanReviewPackage,
        );
        if (reviewPackagePath) {
          (stageResults as Record<string, unknown>).reviewPackagePath = reviewPackagePath;
        }
      }
      if (!finalFactRecheck.ok) {
        return this.hardBlock(
          input,
          "final_fact_recheck",
          `作者风格优化稿事实复检失败：${finalFactRecheck.errors.join("; ")}`,
          stageResults,
          {
            rawText: agenticCandidate.text,
            rawFinishReason: agenticCandidate.finishReason ?? null,
            rawMaxTokens: agenticCandidate.maxTokens ?? null,
            rawModel: agenticCandidate.model,
            modelVersion: detectModelVersion(agenticCandidate.model),
            factGuardErrors: finalFactRecheck.errors,
            candidateId: styledCandidate.id,
            selectedSource: "editorial",
            finalText: styledCandidate.text,
          },
        );
      }

      if (finalTargetLength?.needsContinuation) {
        return this.hardBlock(
          input,
          "final_target_length",
          `作者风格优化稿在内部恢复后仍少 ${finalTargetLength.remaining} 字，未达到 ${finalTargetLength.minimum} 字交付下限`,
          stageResults,
          {
            rawText: agenticCandidate.text,
            rawFinishReason: agenticCandidate.finishReason ?? null,
            rawMaxTokens: agenticCandidate.maxTokens ?? null,
            rawModel: agenticCandidate.model,
            modelVersion: detectModelVersion(agenticCandidate.model),
            candidateId: styledCandidate.id,
            selectedSource: "editorial",
            finalText: styledCandidate.text,
          },
          {
            gate: "target_length",
            severityOverride: "recoverable",
            recoverable: true,
            candidateDisposition: "blocked_evidence_only",
            retryPlan: { strategy: "revise_inputs_and_retry_same_chapter", maxAttempts: 1 },
          },
        );
      }

      stageResults.finalTextCompleteness = {
        ...finalCompleteness,
        selectedSource: "editorial",
        selectedCandidateId: styledCandidate.id,
      };
      if (!finalCompleteness.passed) {
        return this.hardBlock(
          input,
          "final_text_completeness",
          finalCompleteness.findings[0]?.reason ?? "作者风格优化稿疑似截断",
          stageResults,
          {
            rawText: agenticCandidate.text,
            rawFinishReason: agenticCandidate.finishReason ?? null,
            rawMaxTokens: agenticCandidate.maxTokens ?? null,
            rawModel: agenticCandidate.model,
            modelVersion: detectModelVersion(agenticCandidate.model),
            candidateId: styledCandidate.id,
            selectedSource: "editorial",
            finalText: styledCandidate.text,
          },
        );
      }

      stageResults.finalSelection = {
        selectedSource: "editorial",
        selectedCandidateId: styledCandidate.id,
        finalTextLength: styledCandidate.text.length,
        selectionAuthority: "user_feedback",
        machineSelection: false,
      };
      runLanguageRiskAnalysis(candidates, characterNames, stageResults, warnings);
      runStructuralEvidenceScan(styledCandidate.text, styledCandidate.id, input, stageResults, warnings);
      runInformationReleaseScan(styledCandidate.text, styledCandidate.id, input, stageResults, warnings);
      runEndingCraftScan(styledCandidate.text, styledCandidate.id, input, stageResults, warnings);
      runCraftEvidenceEnvelope(styledCandidate.text, styledCandidate.id, stageResults, warnings);
      stageResults.strategyOutcomes = {
        skipped: true,
        reason: "机器裁判已移除；等待用户修改稿与评价反馈后学习",
        // P1-3：记录本次选中的策略 id，供 novel_strategy_feedback 的自然语言反馈编译器归因
        selectedStrategyIds: authorStyleStrategySelection?.selected.map((s) => s.strategyId) ?? [],
      };

      // MA-4.3：提交前阶段守卫（Agentic→风格→故事保持→终检）
      // 注意：不得用“业务门通过 + 手动 push completedStages”伪装契约成功。
      // completedStages 只能由 recordAgentResult(status=ok) 写入；契约失败必须 hardBlock。
      const preCommit = guardCommitStages(collabState);
      stageResults.preCommitStageGuard = preCommit;
      if (!preCommit.ok && !input.fullPipelinePreview) {
        return this.hardBlock(
          input,
          "orchestrator_stage_guard",
          `提交前缺少必经阶段：${preCommit.missing.join(", ")}`,
          stageResults,
          {
            rawText: agenticCandidate.text,
            rawFinishReason: agenticCandidate.finishReason ?? null,
            rawMaxTokens: agenticCandidate.maxTokens ?? null,
            rawModel: agenticCandidate.model,
            modelVersion: detectModelVersion(agenticCandidate.model),
            candidateId: styledCandidate.id,
            selectedSource: "editorial",
            finalText: styledCandidate.text,
          },
        );
      }

      let commitOutcome: { ok: boolean; error?: string; stateCommit: { committed: number; rejected: number } | null };
      if (input.fullPipelinePreview) {
        commitOutcome = { ok: true, stateCommit: null };
        stageResults.commitAndSave = { skipped: true, reason: "fullPipelinePreview" };
      } else {
        const statePermission = this.authorizeCapability(controlPlane, controlTrace, "state.commit", "agentic style final state commit");
        const savePermission = this.authorizeCapability(controlPlane, controlTrace, "chapter.save", "agentic style atomic chapter save");
        if (!statePermission.allowed || !savePermission.allowed) {
          return this.hardBlock(input, "control_plane_commit", "Agentic 风格流程保存权限被拒绝", stageResults);
        }
        commitOutcome = timeSync("stage6_commitAndSave", () =>
          commitAndSave(input, styledCandidate.id, styledCandidate.text, stageResults),
        );
      }
      if (!commitOutcome.ok) {
        return this.hardBlock(input, "atomic_save", `正文原子保存失败：${commitOutcome.error}`, stageResults);
      }

      // MA-1：Commit 结果契约
      try {
        const commitPkg = buildRoleWorkPackage(collabState, "final_state_commit", {
          stage: "stage6_commitAndSave",
          sessionId: `commit-${styledCandidate.id}`,
          objective: "状态提交与原子保存",
          parentCandidateId: styledCandidate.id,
          sourceCandidateId: agenticCandidate.id,
        });
        requireWorkPackageInput(commitPkg, {
          workspaceId,
          chapterId,
          finalText: styledCandidate.text,
          selectedCandidateId: styledCandidate.id,
          stagedStateUpdate: input.stagedStateUpdate,
        });
        recordWorkPackage(collabState, commitPkg);
        const commitContract = adaptCommitResult(
          {
            committed: commitOutcome.ok && !input.fullPipelinePreview,
            chapterFilePath: input.fullPipelinePreview
              ? null
              : chapterFilePath(input),
            stateCommitted: commitOutcome.stateCommit?.committed ?? 0,
            stateRejected: commitOutcome.stateCommit?.rejected ?? 0,
            reason: input.fullPipelinePreview ? "preview_skip" : undefined,
          },
          {
            workPackage: commitPkg,
            candidateId: styledCandidate.id,
          },
        );
        // preview 路径：committed=false 但 status 可能 blocked；标记为系统 skip
        if (input.fullPipelinePreview) {
          recordSystemDecision(collabState, {
            fromStage: "final_state_commit",
            toStage: null,
            transition: "continue",
            allowed: true,
            reason: "fullPipelinePreview 跳过正式提交",
            priority: "state_transaction",
            candidateId: styledCandidate.id,
          });
          if (!collabState.completedStages.includes("final_state_commit")) {
            collabState.completedStages.push("final_state_commit");
          }
        } else {
          recordAgentResult(collabState, commitContract, "done", commitPkg.packageId);
        }
      } catch (collabErr: unknown) {
        const failure = classifyCollaborationContractError(
          "final_state_commit_contract",
          "final_state_commit",
          collabErr,
        );
        stageResults.agentCollaborationError = failure;
        return this.hardBlock(
          input,
          failure.stage,
          formatCollaborationFailureReason(failure),
          stageResults,
          {
            rawText: styledCandidate.text,
            rawFinishReason: styledCandidate.finishReason ?? null,
            rawMaxTokens: styledCandidate.maxTokens ?? null,
            rawModel: styledCandidate.model,
            modelVersion: detectModelVersion(styledCandidate.model),
            candidateId: styledCandidate.id,
          },
          collaborationFailureGuidance(failure),
        );
      }

      return finishWithCollab({
        status: "ok",
        workspaceId,
        chapterId,
        chapterNumber,
        text: styledCandidate.text,
        selectedSource: "editorial",
        selectedCandidateId: styledCandidate.id,
        candidates,
        judgeResult: null,
        allArbitrationResults: [],
        hypotheses: [],
        warnings,
        failureEnvelope: null,
        stageResults,
        stateCommit: commitOutcome.stateCommit,
        chapterFilePath: input.fullPipelinePreview ? null : chapterFilePath(input),
        isPreviewRun: Boolean(input.fullPipelinePreview),
        isUnderSpecified: Boolean(intent.underSpecifiedFields?.length),
      });
    }

    // ── INTENT-COMPLETENESS-1：质量评测模式（B3/B4）+ under-specified 关键字段 → 阻断 ──
    // 任务规格（delete/任务列表/项目优化20260718.md P1-1）：
    //   - 普通生成模式 + under-specified：不阻断，仅标记 isUnderSpecified=true（调用方/trace 可见）
    //   - evalMode（B3/B4）+ under-specified 关键字段：阻断评测，提示补充种子源
    //
    // 必须在 raw 生成前执行（节省模型调用），且在 evalMode B0-B4 分层前执行
    // （避免 under-specified 被掩盖为 eval_agentic_missing）。
    //
    // 关键字段（5 个，与 chapter-intent-builder 计算口径一致）：
    //   focusCharacterGoals / choicesAndCosts / expectedIrreversibleChange /
    //   selectedPromisesToAdvance / causalEndPressure
    //
    // B0/B1/B2 不阻断：B0=PureModel 空意图、B1=CompiledContext、B2=AgenticRetrieval
    // 均为消融基线，不声称做质量评测，允许 under-specified。
    // B3/B4 阻断：B3=VerifiedAgenticRaw + FactGuard、B4=EditorialSelection + judge，
    // 均声称质量评测，关键字段为空时无法可靠评测，必须阻断并提示补充种子源。
    const underSpecifiedFields = intent.underSpecifiedFields ?? [];
    const isUnderSpecified = underSpecifiedFields.length > 0;
    stageResults.intentCompleteness = {
      underSpecifiedFields,
      advisoryOnly: true,
      blocking: false,
      reason: isUnderSpecified
        ? "字段缺失只表示本章没有可靠来源，不强迫每章具备选择代价、不可逆变化或固定章末压力"
        : null,
    };

    // ── 阶段 1: 生成 raw ──────────────────────────────────────────────
    let rawText: string;
    let rawModel = "unknown";
    let rawFinishReason: string | undefined;
    let rawMaxTokens: number | undefined;
    try {
      const rawGen = await timeAsync("stage1_raw", () => generateRaw(orchInput, rawPrompt));
      rawText = rawGen.text;
      rawModel = rawGen.model;
      rawFinishReason = rawGen.finishReason;
      rawMaxTokens = rawGen.maxTokens;
    } catch (e: unknown) {
      // raw 生成异常 → hard block
      // consumedFields 已在 try 块前写入 stageResults（buildRawPrompt 成功，模型调用抛错不丢失）
      const msg = e instanceof Error ? e.message : String(e);
      return this.hardBlock(input, "raw_generation", `raw 生成异常：${msg}`, stageResults);
    }

    if (!rawText || rawText.trim().length === 0) {
      return this.hardBlock(input, "raw_generation", "raw 生成返回空文本", stageResults);
    }

    const rawCompletion = scanFinalTextCompleteness(rawText, {
      finishReason: rawFinishReason,
      chapterNumber: input.chapterNumber,
    });
    stageResults.rawGeneration = {
      model: rawModel,
      finishReason: rawFinishReason ?? null,
      maxTokens: rawMaxTokens ?? null,
      completeness: rawCompletion,
    };
    if (!rawCompletion.passed) {
      // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR：raw 在候选构造前被 completeness 阻断时，
      // raw 即为"准最终候选"（B0/B1/raw-only 路径下 raw 就是 finalText）。
      // candidateId 与 line 888 同一确定性公式，selectedSource=raw，finalText=rawText，
      // 使 final candidate hard-block 证据留存覆盖此早期路径。
      const earlyRawCandidateId = `candidate:raw:${chapterId}`;
      stageResults.finalTextCompleteness = {
        ...rawCompletion,
        selectedSource: "raw",
        selectedCandidateId: earlyRawCandidateId,
        finishReason: rawFinishReason ?? null,
        maxTokens: rawMaxTokens ?? null,
      };
      return this.hardBlock(
        input,
        "final_text_completeness",
        rawCompletion.findings[0]?.reason ?? "raw 正文疑似模型截断",
        stageResults,
        {
          // BLOCKED-CANDIDATE-EVIDENCE-1：截断 raw 仍保留完整正文 + finishReason + 截断 span
          rawText,
          rawFinishReason: rawFinishReason ?? null,
          rawMaxTokens: rawMaxTokens ?? null,
          rawModel,
          modelVersion: null, // modelVersion 在 completeness 检查后才派生，此处未计算
          factGuardErrors: [],
          completenessFindings: rawCompletion.findings.map((f) => ({
            reason: f.reason,
            kind: f.code ? `completeness_${f.code}` : "completeness_truncation",
            span: f.span,
          })),
          // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR：早期 raw completeness 阻断同样记录候选上下文
          candidateId: earlyRawCandidateId,
          selectedSource: "raw",
          finalText: rawText,
        },
      );
    }

    // Phase 6：从 raw 实际使用的模型派生稳定版本键，隔离策略信誉。
    // raw 与 editorial 走同一 fallback-manager，raw 模型是 editorial 模型版本的合理代理。
    const modelVersion = detectModelVersion(rawModel);
    stageResults.modelVersion = modelVersion;

    const rawCandidateId = `candidate:raw:${chapterId}`;
    let rawCandidate = this.makeCandidate(
      rawCandidateId,
      rawText,
      RAW_KIND,
      RAW_ROUTE,
      input,
      { finishReason: rawFinishReason, maxTokens: rawMaxTokens },
    );
    candidates.push(rawCandidate);
    stageResults.rawCandidate = { id: rawCandidateId, length: rawText.length };
    // 将实际消费的身份 contract 绑定到本次模型调用遥测，便于 prompt/guard 共源审计。
    for (const call of modelCallLog) {
      call.consumedFields = rawPrompt.consumedFields;
    }

    // INTENT-1：consumedFields 已在 try 块前由 buildRawPrompt 预计算并写入
    // stageResults.chapterIntent.consumedFields（修复轮：异常路径不再丢失为 []）。

    // ── Eval mode 分层（冻结计划 §8.1，B0-B4 逐层消融）─────────────────
    // NB-4 Generation Matrix：B0-B4 共享 orchestrate 入口，层级差异由 evalMode 控制。
    // - B0/B1：one_shot_raw 后直接交付（无 agentic / FactGuard / editorial / judge）。
    //   B0=PureModel（空 intent+空 context），B1=CompiledContext（含 compiled context）。
    // - B2 AgenticRetrieval：运行 agentic(retrieval=true, verify=false)，交付 agentic_raw。
    // - B3 VerifiedAgenticRaw：运行 agentic(retrieval=true, verify=true) + FactGuard，
    //   交付 verified agentic_raw（无 editorial / judge）。
    // - B4 EditorialSelection：运行 agentic(retrieval=true, verify=true)，agentic_raw 作为
    //   primary raw 继续 editorial + judge + select 路径（FactGuard 启用）。
    //
    // 走 deliverRaw 以复用 LanguageRiskAnalysis + stageResults.finalSelection，
    // eval 模式下 deliverRaw 跳过 commitAndSave（不写章节文件、不提交状态）。
    if (input.evalMode === "B0" || input.evalMode === "B1") {
      warnings.push(`evalMode=${input.evalMode}：one_shot_raw 后直接交付，跳过 agentic/FactGuard/editorial/judge/commit`);
      return this.deliverRaw(input, rawCandidate, warnings, stageResults, null, [], candidates);
    }

    if (input.evalMode === "B2" || input.evalMode === "B3" || input.evalMode === "B4") {
      // B2/B3/B4 必须有 agenticCandidateSource（由 runUnifiedPipeline 按 evalMode 构造）
      if (!input.agenticCandidateSource) {
        return this.hardBlock(
          input, "eval_agentic_missing",
          `evalMode=${input.evalMode} 需要 agenticCandidateSource（由 runUnifiedPipeline 按 evalMode 构造）`,
          stageResults
        );
      }
      // 运行 agentic 生成 agentic_raw（retrieval/verify 能力由 source 构造时决定）
      let agenticCandidate: Candidate | null = null;
      try {
        const agenticResult = await timeAsync("stage1.5_evalAgenticRaw", () =>
          input.agenticCandidateSource!.generate({
            workspaceId, chapterId, chapterNumber, projectRoot,
            intent, context, characterNames,
            modelGenerate: wrappedModelGenerate!,
            route: RAW_ROUTE,
            timeoutMs: input.timeoutMs,
            evalPrefix: input.evalPrefix,
            // Phase 2B：字数软目标转发给 Agentic GenerationPacket
            targetWordCount: input.targetWordCount,
            // P0-1 修复：预览模式透传给 CandidateWorkspace/TrajectoryStore
            fullPipelinePreview: input.fullPipelinePreview,
            fewshotSelection: input.fewshotSelection,
            // CONTRACT-LAYERING-ABLATION-1：透传渲染策略（evalMode 实验用）
            writerPromptProfile: input.rawPromptProfile,
            // eval-only：A/B 对照实验用，覆盖 Agentic 检索决策规则（生产 undefined = 默认强制检索）
            retrievalPromptOverride: input.retrievalPromptOverride,
            // Phase 5 受控接入：透传 toolMode（受控接入同样适用于 evalMode 对照实验）
            toolMode: input.toolMode,
            auditSink: input.auditSink,
            capabilityActivation: input.capabilityActivation,
            capabilityPackageSet: input.capabilityPackageSet,
            capabilityCatalog: input.capabilityCatalog,
            capabilityConsumptionLedger: input.capabilityConsumptionLedger,
          })
        );
        agenticCandidate = agenticResult.candidate;
        stageResults.evalAgentic = {
          sessionId: agenticResult.sessionId,
          trajectoryPath: agenticResult.trajectoryPath,
          candidateId: agenticCandidate?.id ?? null,
          candidateLength: agenticCandidate?.text.length ?? 0,
          // CONTRACT-LAYERING-ABLATION-1 数据完整性修复：
          // 记录 agentic candidate 的 SHA-256，供 eval 调用方校验最终交付文本
          // 是否确实等于 agentic candidate（B3 FactGuard 失败会回退 one_shot_raw，
          // 但 evalAgentic.candidateId 仍非 null，导致 fallback 被误记为有效样本）。
          candidateHash: agenticCandidate
            ? createHash("sha256").update(agenticCandidate.text, "utf8").digest("hex")
            : null,
          stopReason: agenticResult.stopReason,
          failureReason: agenticResult.failureReason ?? null,
          toolCalls: agenticResult.toolCalls,
          verifierCleared: agenticResult.verifierCleared,
          repairRounds: agenticResult.repairRounds,
          // AGENTIC-EVIDENCE-MERGE-1 可观测性（eval 回放路径同构）
          decisionMode: agenticResult.decisionMode,
          firstAction: agenticResult.firstAction,
          actualRetrievalCalls: agenticResult.actualRetrievalCalls,
          mustVerifyCount: agenticResult.mustVerifyCount,
          mustVerifyCoveredCount: agenticResult.mustVerifyCoveredCount,
          coverageResult: agenticResult.coverageResult ?? null,
          modelCallsByKind: agenticResult.modelCallsByKind,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`evalMode=${input.evalMode} agentic 生成异常：${msg}`);
        stageResults.evalAgentic = { error: msg, candidateId: null };
      }

      if (agenticCandidate) {
        candidates.push(agenticCandidate);
      }

      // B2 AgenticRetrieval：交付 agentic_raw（retrieval=true, verify=false），无 FactGuard
      if (input.evalMode === "B2") {
        const deliverCandidate = agenticCandidate ?? rawCandidate;
        warnings.push(
          `evalMode=B2：交付 agentic_raw（retrieval=true, verify=false），跳过 FactGuard/editorial/judge/commit`
        );
        return this.deliverRaw(
          input, deliverCandidate, warnings, stageResults, null, [], candidates
        );
      }

      // B3 VerifiedAgenticRaw：FactGuard 校验 agentic_raw，交付 verified agentic_raw
      // 无 editorial、无 judge（B3 的"验证"由 agentic source 内部 verifier+patch 闭环完成）
      if (input.evalMode === "B3") {
        const deliverCandidate = agenticCandidate ?? rawCandidate;
        const factGuardResult = timeSync("stage2_evalAgenticFactGuard", () =>
          checkCandidateFactGuard(deliverCandidate.text, input)
        );
        stageResults.rawFactGuard = factGuardResult;
        if (!factGuardResult.ok) {
          // B3 FactGuard 阻断 → 回退 one_shot_raw 基线（保留评估信号，不 hard block）
          warnings.push(
            `evalMode=B3 FactGuard 阻断：${factGuardResult.errors.join("; ")}，回退 one_shot_raw`
          );
          return this.deliverRaw(
            input, rawCandidate, warnings, stageResults, null, [], candidates
          );
        }
        warnings.push(
          `evalMode=B3：交付 verified agentic_raw（retrieval=true, verify=true + FactGuard 通过），跳过 editorial/judge/commit`
        );
        stageResults.finalSelection = {
          selectedSource: "raw",
          selectedCandidateId: deliverCandidate.id,
          finalTextLength: deliverCandidate.text.length,
          evalMode: "B3",
        };
        // B3 交付 verified agentic_raw，不进入 editorial/judge 路径
        if (!stageResults.languageRisk) {
          runLanguageRiskAnalysis(
            candidates, input.characterNames, stageResults, warnings
          );
        }
        // ── QUALITY-3：B3 eval 路径也写入 structuralEvidence ──
        // 只诊断不改文，不触发语言润色/候选生成，不阻断生成。
        runStructuralEvidenceScan(
          deliverCandidate.text, deliverCandidate.id, input, stageResults, warnings
        );
        // ── QUALITY-8：B3 eval 路径也写入 informationReleaseEvidence ──
        // 只诊断不改文，不触发语言润色/候选生成，不阻断生成。
        runInformationReleaseScan(
          deliverCandidate.text, deliverCandidate.id, input, stageResults, warnings
        );
        // ── QUALITY-9：B3 eval 路径也写入 endingCraftEvidence ──
        // 只诊断不改文，不触发语言润色/候选生成，不阻断生成。
        runEndingCraftScan(
          deliverCandidate.text, deliverCandidate.id, input, stageResults, warnings
        );
        // ── QUALITY-10：B3 eval 路径也写入 craftEvidenceEnvelope（三源扫描后汇总）──
        // 只汇总不评分，不触发语言润色/候选生成，不阻断生成。
        runCraftEvidenceEnvelope(
          deliverCandidate.text, deliverCandidate.id, stageResults, warnings
        );
        // ── QUALITY-15：B3 eval 路径也生成运行报告（raw-only，无 editorial candidate）──
        // 任务规格 §接入边界："no-op/raw-only 路径应能生成报告，说明无 editorial candidate"。
        // 只做报告不做裁判/门禁，不改 finalText，不阻断生成。
        runQualityEvidenceRunReport(
          "raw",
          deliverCandidate.id,
          deliverCandidate.text,
          candidates.some((c) => c.kind === "editorial_amplified"),
          stageResults,
          warnings
        );
        // ── QUALITY-16 REPAIR-1：B3 成功分支补齐导出调用 ──
        // 修复前：runQualityEvidenceRunReport 后直接 return，qualityEvidenceReportPath
        // 与 qualityEvidenceReportExport 缺失（undefined）。B0/B1/B2 经 deliverRaw 导出，
        // 但 B3 成功分支不进 deliverRaw，需在此显式调用。evalMode=B3 仍禁写文件，
        // 返回 path=null/exported=false/reason 含 B3。不改 prompt/winner/finalText/
        // candidate/judge，不阻断生成。
        exportQualityEvidenceReport(this, input, stageResults, warnings);
        // WP-03..07：B3 成功出口挂载治理报告
        this.attachRoutingGovernanceOnExit(input, stageResults, {
          delivered: true,
          factGuardPassed: true,
          storyPreservationPassed: true,
        });
        return {
          status: "ok",
          workspaceId,
          chapterId,
          chapterNumber,
          text: deliverCandidate.text,
          selectedSource: "raw",
          selectedCandidateId: deliverCandidate.id,
          candidates,
          judgeResult: null,
          allArbitrationResults: [],
          hypotheses: [],
          warnings,
          failureEnvelope: null,
          stageResults,
          stateCommit: null,
          chapterFilePath: null,
        };
      }

      // B4 EditorialSelection：agentic_raw 作为 primary raw，继续 editorial + judge 路径
      // 把 rawCandidate 替换为 verified agentic_raw（editorial 基于它改写，judge 与它比较）
      if (agenticCandidate) {
        rawCandidate = agenticCandidate;
        rawText = agenticCandidate.text;
      }
      // 继续 FactGuard（启用）→ editorial → judge → select 路径
    }

    // ── Step 5：NovelOS shadow agentic_raw（PINOVEL_NOVELOS_SHADOW=1 时同跑） ──
    // shadow 模式：agentic_raw 与 one_shot_raw 同跑，但只进 trace，不影响正式交付。
    // agentic 失败 → record failure + 回退 one_shot_raw（不 hard block）。
    // SOFT 检查排除 agentic 调用（kind=AGENTIC_RAW_KIND="agentic_raw"），确保 shadow 不影响 editorial。
    // agentic_raw 不参与 FactGuard/judge/selection，仅作为 trace 对照候选。
    const shadowEnabled =
      process.env.PINOVEL_NOVELOS_SHADOW === "1" && !!input.agenticCandidateSource;
    if (shadowEnabled && input.agenticCandidateSource) {
      try {
        const agenticResult = await timeAsync("stage1.5_novelosAgenticRaw", () =>
          input.agenticCandidateSource!.generate({
            workspaceId, chapterId, chapterNumber, projectRoot,
            intent, context, characterNames,
            modelGenerate: wrappedModelGenerate!,
            route: RAW_ROUTE,
            timeoutMs: input.timeoutMs,
            evalPrefix: input.evalPrefix,
            // Phase 2B：字数软目标转发给 Agentic GenerationPacket
            targetWordCount: input.targetWordCount,
            // P0-1 修复：预览模式透传给 CandidateWorkspace/TrajectoryStore
            fullPipelinePreview: input.fullPipelinePreview,
            fewshotSelection: input.fewshotSelection,
            // CONTRACT-LAYERING-ABLATION-1：透传渲染策略（shadow 路径 undefined = 平铺）
            writerPromptProfile: input.rawPromptProfile,
            // Phase 5 受控接入：透传 toolMode（shadow 路径同样受控）
            toolMode: input.toolMode,
            auditSink: input.auditSink,
            capabilityActivation: input.capabilityActivation,
            capabilityPackageSet: input.capabilityPackageSet,
            capabilityCatalog: input.capabilityCatalog,
            capabilityConsumptionLedger: input.capabilityConsumptionLedger,
          })
        );
        stageResults.novelos = {
          shadowEnabled: true,
          sessionId: agenticResult.sessionId,
          trajectoryPath: agenticResult.trajectoryPath,
          candidateId: agenticResult.candidate?.id ?? null,
          candidateLength: agenticResult.candidate?.text.length ?? 0,
          stopReason: agenticResult.stopReason,
          failureReason: agenticResult.failureReason ?? null,
          budgetSnapshot: agenticResult.budgetSnapshot,
          sourceRefs: agenticResult.sourceRefs,
          toolCalls: agenticResult.toolCalls,
          // AGENTIC-EVIDENCE-MERGE-1 可观测性（shadow 路径同构）
          decisionMode: agenticResult.decisionMode,
          firstAction: agenticResult.firstAction,
          actualRetrievalCalls: agenticResult.actualRetrievalCalls,
          mustVerifyCount: agenticResult.mustVerifyCount,
          mustVerifyCoveredCount: agenticResult.mustVerifyCoveredCount,
          coverageResult: agenticResult.coverageResult ?? null,
          modelCallsByKind: agenticResult.modelCallsByKind,
        };
        if (agenticResult.candidate) {
          // agentic_raw 进入 candidates 供 trace 审计，但不参与 FactGuard/judge/selection
          candidates.push(agenticResult.candidate);
        } else {
          warnings.push(
            `NovelOS agentic_raw fallback（${agenticResult.failureReason ?? agenticResult.stopReason}），回退 one_shot_raw`
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`NovelOS agentic_raw 异常（不阻断生成）：${msg}`);
        stageResults.novelos = {
          shadowEnabled: true,
          error: msg,
          candidateId: null,
        };
      }
    } else {
      stageResults.novelos = { shadowEnabled: false };
    }

    // ── 阶段 2: FactGuard 校验 raw（硬阻断限于事实硬伤） ─────────────
    // 冻结计划 §8.1：B0/B1/B2/B3 在 eval 分支已返回；此处只有 B4 eval 和非 eval 生产路径。
    // B4 启用 FactGuard（验证层及以上）；非 eval 生产路径同样启用。
    // B4 eval：raw（=verified agentic_raw）FactGuard 阻断时回退 one_shot_raw 基线（保留评估信号）；
    // 非 eval：raw 有事实硬伤 → hard block（不回退 legacy）。
    const factGuardResult = timeSync("stage2_rawFactGuard", () =>
      checkCandidateFactGuard(rawText, input)
    );
    stageResults.rawFactGuard = factGuardResult;
    if (!factGuardResult.ok) {
      if (input.fullPipelinePreview) {
        stageResults.productionFinalPreviewBlockedCandidate = {
          id: rawCandidate.id,
          textHash: createHash("sha256").update(rawText, "utf8").digest("hex"),
          characterCount: rawText.length,
          contextHash: rawCandidate.contextHash,
          route: rawCandidate.route,
          candidateCount: 1,
        };
      }
      if (input.qualityExperiment) {
        stageResults.qualityExperimentRawCandidate = {
          id: rawCandidate.id,
          textHash: createHash("sha256").update(rawText, "utf8").digest("hex"),
          characterCount: rawText.length,
          contextHash: rawCandidate.contextHash,
          route: rawCandidate.route,
        };
      }
      if (input.evalMode === "B4") {
        // B4 eval：raw FactGuard 阻断 → 回退 one_shot_raw 基线（保留评估信号，不 hard block）
        warnings.push(
          `evalMode=B4 raw FactGuard 阻断：${factGuardResult.errors.join("; ")}，回退 one_shot_raw`
        );
        const oneShotRaw = candidates.find((c) => c.id === rawCandidateId) ?? rawCandidate;
        return this.deliverRaw(input, oneShotRaw, warnings, stageResults, null, [], candidates);
      }
      return this.hardBlock(
        input, "raw_fact_guard",
        `raw 事实硬伤：${factGuardResult.errors.join("; ")}`,
        stageResults,
        {
          // BLOCKED-CANDIDATE-EVIDENCE-1：FactGuard 阻断的 raw 保留完整正文 + 事实硬伤诊断 span
          rawText,
          rawFinishReason: rawFinishReason ?? null,
          rawMaxTokens: rawMaxTokens ?? null,
          rawModel,
          modelVersion,
          factGuardErrors: factGuardResult.errors,
        },
      );
    }

    // ── 阶段 2.5: QUALITY-11 raw craft evidence advisory 编译 ───────────
    // 在 raw 通过 FactGuard 后、EditorialOpportunityJudge 前，基于 rawText 运行
    // QUALITY-3/8/9 三源本地证据扫描 → QUALITY-10 envelope → QUALITY-11 advisory。
    // advisory 是诊断上下文（非命令，非评分），注入下游 oppJudge/candGen prompt。
    // **不改变机会判定/候选生成逻辑**：advisory 只是额外上下文；
    // opportunity 返回 no-op 时仍交付 raw（advisory 不强制 candidate）。
    // scanner/advisory 异常只写 skipped + warning，不阻断流程。
    if (input.qualityExperiment) {
      warnings.push(
        `qualityExperiment=${input.qualityExperiment.arm}:${input.qualityExperiment.sampleIndex}; isolated after raw FactGuard`,
      );
      return this.deliverRaw(input, rawCandidate, warnings, stageResults, null, [], candidates);
    }

    // 方法论状态只在 raw 通过 FactGuard 后加载，并且只提供给 post-raw judge。
    // 它不参与 raw prompt，也不能独立授权 candidate。
    const methodologyDiagnosticState = input.methodologyDiagnosticState
      ?? createMethodologyDiagnosticStateLoader().load({
        workspacePath: typeof projectRoot === "string" && projectRoot.trim()
          ? join(projectRoot, "workspaces", workspaceId)
          : undefined,
        chapterNumber,
      });
    stageResults.methodologyDiagnosticState = methodologyDiagnosticState;

    const rawCraftAdvisory = timeSync("stage2.5_rawCraftAdvisory", () =>
      runRawCraftAdvisory(rawText, rawCandidateId, input, stageResults, warnings)
    );

    // FULL-PIPELINE-PREVIEW-1：旧 previewOnly 短路径已被移除。
    // 旧的 `if (input.previewOnly) return deliverRaw(...)` 在 FactGuard 后直接返回 raw，
    // 跳过 editorial/judge/select 阶段——这与"完整链路只读预览"语义冲突，已被移除。
    // fullPipelinePreview 模式继续走完整 editorial/judge/select 链路，在阶段 7 跳过 commitAndSave。

    if (controlPlane.enforceModelLocks) {
      const judgeLockErrors = validateModelLock(
        controlPlane.packet.modelLocks.judge,
        controlPlane.executionLocks.judge,
      );
      if (judgeLockErrors.length > 0) {
        return this.hardBlock(
          input,
          "control_plane_judge_lock",
          `judge model lock 冲突：${judgeLockErrors.join("; ")}`,
          stageResults,
          {
            // BLOCKED-CANDIDATE-EVIDENCE-1：control plane 阻断前 raw 已生成，保留完整正文供复盘
            rawText,
            rawFinishReason: rawFinishReason ?? null,
            rawMaxTokens: rawMaxTokens ?? null,
            rawModel,
            modelVersion,
          },
        );
      }
    }

    // ── 阶段 3: EditorialOpportunityJudge 扫描 raw（P1-9：LLM 主导） ────
    const oppJudge = createEditorialOpportunityJudge();
    const oppResult = await timeAsync("stage3_editorialOpportunity", () =>
      oppJudge.judge({
        rawText,
        rawCandidateId,
        intent,
        longTermState: context.longTermState ?? null,
        constitution: constitution,
        context,
        voiceFingerprints: input.voiceFingerprints,
        previousEmotionState: input.previousEmotionState,
        methodologyDiagnosticState,
        characterNames,
        // P1-9：传入 modelGenerate 启用 LLM 结构化判断；失败时本地信号只写 trace 并保留 raw
        // REAL-QUALITY-1-PREFLIGHT：opportunity judge 走 judge 轨（nb4_judge_glm），
        // 不再用 generation 轨（nb4_generate_glm）。
        modelGenerate: wrappedJudgeModelGenerate!,
        seed: input.seed,
        timeoutMs: input.timeoutMs,
        // QUALITY-11：raw 阶段 craft evidence advisory（诊断上下文，注入 LLM prompt）。
        // **不改变机会判定逻辑**：本地扫描器仍照常运行，准入控制仍照常过滤；
        // advisory 只是额外上下文，LLM 可参考也可忽略。promptBlock=null 时不注入。
        craftAdvisory: rawCraftAdvisory,
      })
    );
    stageResults.editorialOpportunity = {
      hypothesesCount: oppResult.hypotheses.length,
      noOpReason: oppResult.noOpReason ?? null,
      llmJudged: oppResult.llmJudged,
      llmFallbackReason: oppResult.llmFallbackReason ?? null,
      schemaRepairAttempts: oppResult.schemaRepairAttempts,
      signals: oppResult.scannedSignals.map((s) => ({
        opportunityType: s.opportunityType,
        triggered: s.triggered,
      })),
    };
    stageResults.craftPhenomenonReport = oppResult.craftPhenomenonReport;

    // 无可引用 raw span 的 hypothesis 时，任何正收益候选都不得生成。
    // 这保持统一主链路的机会驱动边界：raw 是基线，候选数量必须为 0。
    if (oppResult.hypotheses.length === 0) {
      stageResults.positiveGainCandidates = {
        status: "retired_from_production",
        rawBaselineMutated: false,
        failureReason: "global_scene_candidate_admission_retired",
      };
      warnings.push(
        `无编辑机会（${oppResult.noOpReason ?? "无 hypothesis"}），交付 raw`
      );
      return this.deliverRaw(input, rawCandidate, warnings, stageResults, null, oppResult.hypotheses, candidates);
    }

    const positiveGainCandidates: Candidate[] = [];
    stageResults.positiveGainCandidates = {
      status: "retired_from_production",
      rawBaselineMutated: false,
      failureReason: "global_scene_candidate_admission_retired",
    };
    // 策略注册表（Stage 3.5 过滤与 Stage 4 候选生成共用）
    const strategyRegistry = createEditorialStrategyRegistry();

    // ── 阶段 3.5: Phase 6 在线学习 — Thompson Sampling 策略过滤 ──────────
    // 当传入 policyStore + strategySelector 时，仅对已准入 active 策略做
    // Thompson Sampling。candidate 策略跳过在线采样，但继续走静态 registry，
    // 避免未验证 bandit 随机过滤有效 opportunity hypothesis。
    // 未传入学习组件时跳过此阶段（保持原有行为，测试可用无学习模式）。
    // 计划 §Phase 6 退出条件：策略会根据正常写作反馈调整调用概率。
    let activeHypotheses = oppResult.hypotheses;
    if (input.policyStore && input.strategySelector && activeHypotheses.length > 0) {
      // 捕获 narrowed locals，避免 timeSync 闭包内再次放宽为 optional。
      const policyStore = input.policyStore;
      const strategySelector = input.strategySelector;
      const candidateStrategies = this.collectCandidateStrategies(
        strategyRegistry, activeHypotheses
      );
      const strategySelection = timeSync("stage3.5_strategyFilter", () =>
        strategySelector.select({
          candidates: candidateStrategies,
          modelVersion,
          policyStore,
          seed: input.seed,
        })
      );
      stageResults.strategySelection = {
        sampled: strategySelection.samples.map((s) => ({
          strategyId: s.strategyId,
          sampled: s.sampled,
          selected: s.selected,
          status: s.status,
        })),
        notes: strategySelection.notes,
        mode: strategySelection.staticFallback.length > 0
          ? strategySelection.selected.length > 0 ? "hybrid" : "static_registry"
          : "thompson",
        selectedCount: strategySelection.selected.length + strategySelection.staticFallback.length,
        onlineSelectedCount: strategySelection.selected.length,
        staticFallbackCount: strategySelection.staticFallback.length,
      };

      const selectedStrategyIds = new Set(
        [...strategySelection.selected, ...strategySelection.staticFallback].map((s) => s.strategyId)
      );
      activeHypotheses = activeHypotheses.filter((h) => {
        const strat = strategyRegistry.pickStrategyForHypothesis(h);
        return strat ? selectedStrategyIds.has(strat.strategyId) : false;
      });

      // 无已准入选中策略且无 candidate 静态 fallback 时，合法交付 raw。
      if (activeHypotheses.length === 0 && positiveGainCandidates.length === 0) {
        warnings.push(
          `策略选择后无可用策略（${strategySelection.notes.join("; ")}），交付 raw`
        );
        return this.deliverRaw(input, rawCandidate, warnings, stageResults, null, oppResult.hypotheses, candidates);
      }
    }

    // ── Step 1d 软上限：stage4 前检查模型调用预算 ─────────────────────
    // raw（stage1）+ opportunity-judge（stage3）是必需调用，不被门控；
    // 超过 soft 预算时跳过 editorial 候选生成，交付 raw 基线。
    // Step 5：SOFT 检查排除 agentic 调用（kind=AGENTIC_RAW_KIND="agentic_raw"），
    // 确保 shadow agentic_raw 不影响 editorial 路径（HARD 仍计入总数）。
    // Step 1d 修复：此前过滤器误用路由名 "novelos_agentic"（=AGENTIC_RAW_ROUTE）
    // 与实际 kind "agentic_raw" 不匹配，导致 0 个 agentic 调用被排除，
    // shadow 下 raw(1)+agentic(4)+opp-judge(1)=6 全部计入 nonAgentic → 6>=SOFT(6) 误 cap。
    const nonAgenticCallCount = modelCallLog.filter(
      (e) => e.kind !== AGENTIC_RAW_KIND
    ).length;
    if (nonAgenticCallCount >= SOFT && positiveGainCandidates.length === 0) {
      modelBudget.capped = true;
      warnings.push(
        `模型调用达软上限（非 agentic ${nonAgenticCallCount}/${SOFT}，总 ${modelCallLog.length}），跳过 editorial 候选生成，交付 raw`
      );
      return this.deliverRaw(input, rawCandidate, warnings, stageResults, null, oppResult.hypotheses, candidates);
    }

    // ── 阶段 4: EditorialCandidateGenerator 生成 editorial 候选 ───────
    const candGen = createEditorialCandidateGenerator();
    let editorialCandidates: Candidate[] = [...positiveGainCandidates];
    try {
      if (positiveGainCandidates.length > 0) {
        stageResults.editorialCandidateGeneration = {
          count: positiveGainCandidates.length,
          failures: [],
          noOpReason: null,
          source: "positive_gain_production",
        };
      } else {
      const genResult = await timeAsync("stage4_editorialCandidate", () =>
        candGen.generate({
          rawText,
          evalPrefix: input.evalPrefix,
          rawCandidateId,
          hypotheses: activeHypotheses,
          intent,
          context,
          constitution,
          contextHash: rawCandidate.contextHash,
          chapterNumber,
          // Step 1c：传 wrappedModelGenerate 以计入 modelCallLog 遥测
          modelGenerate: wrappedModelGenerate!,
          writerPromptProfile: input.rawPromptProfile,
          strategyRegistry,
          timeoutMs: input.timeoutMs ?? DEFAULT_RAW_TIMEOUT_MS,
          // QUALITY-11：raw 阶段 craft evidence advisory（诊断上下文，注入 candidate prompt）。
          // **不改变候选生成逻辑**：hypothesis 仍由 EditorialOpportunityJudge 独立判定；
          // advisory 只是额外上下文，模型可参考也可忽略。promptBlock=null 时不注入。
          craftAdvisory: rawCraftAdvisory,
        })
      );
      editorialCandidates = genResult.candidates;
      (stageResults.constitutionConsumption as {
        raw: string[];
        editorial: string[];
        judge: string[];
      }).editorial = genResult.constitutionConsumedFields;
      stageResults.editorialCandidateGeneration = {
        count: genResult.candidates.length,
        failures: genResult.failures,
        noOpReason: genResult.noOpReason ?? null,
      };
      if (genResult.failures.length > 0) {
        warnings.push(
          `editorial 候选生成部分失败：${genResult.failures.map((f) => f.reason).join("; ")}`
        );
      }
      }
    } catch (e: unknown) {
      // editorial 生成异常 → 交付 raw + warning
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`editorial 候选生成异常，交付 raw：${msg}`);
      stageResults.editorialCandidateGeneration = { error: msg };
      // QUALITY-12：无候选故不伪造 trace，写 skipped 标记
      stageResults.editorialEvidenceResponseTraces =
        skippedEditorialEvidenceResponseTraceSet(`editorial 候选生成异常：${msg}`);
      // QUALITY-13：无候选故不伪造 candidate risk advisory，写 skipped 标记
      stageResults.editorialCandidateRiskAdvisory =
        skippedEditorialCandidateRiskAdvisorySet(`editorial 候选生成异常：${msg}`);
      return this.deliverRaw(input, rawCandidate, warnings, stageResults, null, oppResult.hypotheses, candidates);
    }

    candidates.push(...editorialCandidates);

    // ── 阶段 4.5: QUALITY-12 EditorialEvidenceResponseTrace — 候选对诊断证据的响应 trace ──
    // editorial candidate 生成后、FactGuard 之前，对每个 editorial candidate 编译响应 trace。
    // trace 只读 rawText / editorialText / advisory，不改 finalText，不触发 StyleShaper，
    // 不改 judge/selection，不是 hard gate。trace 异常 → skipped，不阻断流程。
    // 无 editorial candidate 时（no-op）不伪造 trace，写 skipped 标记。
    timeSync("stage4.5_editorialEvidenceResponseTrace", () =>
      runEditorialEvidenceResponseTraces(
        editorialCandidates,
        rawText,
        rawCraftAdvisory,
        stageResults,
        warnings
      )
    );

    // ── 阶段 4.6: QUALITY-13 EditorialCandidateRiskAdvisory — 候选是否未回应关键诊断证据 ──
    // 基于 QUALITY-12 的 response trace，为每个 editorial candidate 编译风险审计 advisory。
    // 只做 candidate-level 风险审计与提示，不直接改 winner，不做 hard gate，不做评分。
    // 只读 trace / candidate，不改 finalText，不触发 StyleShaper，不改 judge/selection。
    // advisory 异常 → skipped，不阻断流程。无 editorial candidate 时（no-op）不伪造 advisory。
    timeSync("stage4.6_editorialCandidateRiskAdvisory", () =>
      runEditorialCandidateRiskAdvisory(
        editorialCandidates,
        stageResults,
        warnings
      )
    );

    // 无 editorial 候选 → 交付 raw + warning
    if (editorialCandidates.length === 0) {
      warnings.push("无 editorial 候选生成，交付 raw");
      return this.deliverRaw(input, rawCandidate, warnings, stageResults, null, oppResult.hypotheses, candidates);
    }

    // ── 阶段 5a: FactGuard 校验每个 editorial 候选（P0-3） ─────────────
    // editorial 候选必须通过事实硬伤检查才能进入裁判。
    // 有硬阻断的 editorial 候选被过滤，不参与裁判（不覆盖 raw）。
    // 冻结计划 §8.1：B0/B1/B2/B3 在 eval 分支已返回；此处只有 B4 eval 和非 eval 生产路径，
    // 均启用 FactGuard（B4 = 验证层 + editorial selection）。
    const validEditorialCandidates: Candidate[] = [];
    const editorialFactGuardResults: Array<{ candidateId: string; passed: boolean; errors: string[] }> = [];
    timeSync("stage5a_editorialFactGuard", () => {
      for (const ec of editorialCandidates) {
        const fg = checkCandidateFactGuard(ec.text, input, rawCandidate.text);
        editorialFactGuardResults.push({
          candidateId: ec.id,
          passed: fg.ok,
          errors: fg.errors,
        });
        if (fg.ok) {
          validEditorialCandidates.push(ec);
        } else {
          warnings.push(`editorial 候选 ${ec.id} 事实硬伤被过滤：${fg.errors.join("; ")}`);
        }
      }
    });
    stageResults.editorialFactGuard = editorialFactGuardResults;

    // 所有 editorial 候选都有事实硬伤 → 交付 raw + warning
    if (validEditorialCandidates.length === 0) {
      warnings.push("所有 editorial 候选均未通过 FactGuard，交付 raw");
      return this.deliverRaw(input, rawCandidate, warnings, stageResults, null, oppResult.hypotheses, candidates);
    }

    // EditorialStoryPreservation 只提供结构诊断证据。其事件抽取是启发式的，
    // 不得在事实/完整性门禁之外机械淘汰文学候选。
    const storyPreservedCandidates: Candidate[] = [];
    const storyPreservationResults: Array<{
      candidateId: string;
      report: StoryPreservationGateReport;
    }> = [];
    timeSync("stage5a.1_editorialStoryPreservation", () => {
      for (const ec of validEditorialCandidates) {
        // B/C 是从同一事实与意图重新生成的替代 raw 草稿，不是对 A 的编辑改写；
        // 要求其复制 A 的事件骨架会错误消灭搜索差异。事实/连续性仍由 FactGuard
        // 校验，文学胜负仍由异源 judge 与 raw 比较。
        if (ec.kind !== "editorial_amplified") {
          storyPreservedCandidates.push(ec);
          continue;
        }
        const report = checkEditorialStoryPreservation({
          rawText: rawCandidate.text,
          editorialText: ec.text,
          // R2.2: 实体仅来自运行输入（characterNames），不靠频率提取。
          // orchestrator 当前只持有角色名，明确标记能力边界为 characters_only。
          // 当 FactGuard context 能提供地点/组织/物品实体时，应改为 full_entities。
          knownEntities: input.characterNames,
          entityCoverage: "characters_only",
          // Phase 3C：eval B4 诊断流保留 similarity 模式（与历史回放对齐）。
          // 生产 agentic_style 流默认走 event_ledger 模式（见上方 stage4 调用）。
          mode: "similarity",
        });
        storyPreservationResults.push({ candidateId: ec.id, report });
        storyPreservedCandidates.push(ec);
        if (!report.preserved) warnings.push(`editorial 候选 ${ec.id} 故事保持诊断：${report.reason}`);
      }
    });
    stageResults.editorialStoryPreservation = storyPreservationResults.map(
      ({ candidateId, report }) => ({
        candidateId,
        preserved: report.preserved,
        unverifiable: report.unverifiable,
        rejectionType: report.rejectionType,
        missingEventCount: report.missingEvents.length,
        replacedEventCount: report.replacedEvents.length,
        orderViolationCount: report.orderViolations.length,
        reason: report.reason,
        // 完整 missingEvents/replacedEvents/orderViolations 供 trace 审计（含证据 span）
        missingEvents: report.missingEvents,
        replacedEvents: report.replacedEvents,
        orderViolations: report.orderViolations,
        // R2.3：结构化事件锚点 findings（含 subject/action/objectOrResult/span/extractable）。
        // 任务规范第七章要求"trace 含真实动作/对象"，必须在序列化中输出该字段，
        // 否则管线测试无法校验事件结构是否真实落地到 trace。
        rawEventAnchorFindings: report.rawEventAnchorFindings,
        entityCoverage: report.entityCoverage,
        // Phase 3C：event_ledger 模式新增字段（similarity 模式为 undefined/空数组）
        mode: report.mode,
        causalBreaks: report.causalBreaks ?? [],
        stateChangeLosses: report.stateChangeLosses ?? [],
        advisorySimilarities: report.advisorySimilarities ?? [],
        editorialEventCount: report.editorialEventCount,
      })
    );

    // 所有通过事实门禁的候选继续进入逐章比较；诊断只附在 trace。
    validEditorialCandidates.length = 0;
    validEditorialCandidates.push(...storyPreservedCandidates);

    if (validEditorialCandidates.length === 0) {
      warnings.push("通过最终候选前置门禁的 editorial 候选为空，交付 raw");
      return this.deliverRaw(
        input, rawCandidate, warnings, stageResults, null, oppResult.hypotheses, candidates,
      );
    }

    // ── 阶段 5a.5: LanguageRiskAnalyzer — 全候选语言风险扫描（A4，计划 §3）──
    // 对进入裁判的全部候选（raw + 有效 editorial）调用 LanguageRiskLibrary.scan()，
    // 记录 per-candidate 报告到 stageResults.languageRisk 供 trace 审计。
    // 软风险最高 review，不 hard block；red-level density 推送 warning（不阻断）。
    // 本地扫描（legacy AntiAIDetector，无 LLM 调用），成本可接受。
    timeSync("stage5a.5_languageRisk", () =>
      runLanguageRiskAnalysis(
        [rawCandidate, ...validEditorialCandidates],
        characterNames, stageResults, warnings,
      )
    );

    // ── 阶段 5b: JudgeArbitrator 对每个有效 editorial 候选做裁判（P1-6） ──
    // 冻结计划 §8.1：B0/B1/B2/B3 在 eval 分支已返回；此处只有 B4 eval 和非 eval 生产路径。
    // 对全部 0-2 个有效 editorial 候选分别与 raw 做 pairwise 裁判，
    // 选出胜出的 editorial（若有多个胜出，取胜因最强的）。
    const arb = createJudgeArbitrator();
    (stageResults.constitutionConsumption as {
      raw: string[];
      editorial: string[];
      judge: string[];
    }).judge = getJudgeConstitutionConsumedFields(constitution);
    const arbitrationResults: Array<{ candidate: Candidate; result: ArbitratorResult }> = [];
    // Step 4c：opt-in 并行裁判。默认 1=串行（行为零变化）；PINOVEL_PARALLEL_CANDIDATES=2 启用并行。
    const parallelJudge = Number(process.env.PINOVEL_PARALLEL_CANDIDATES ?? 1) === 2;
    await timeAsync("stage5b_judge", async () => {
      if (parallelJudge && validEditorialCandidates.length > 1) {
        // 并行预算预检：并发数 + 已用不超 HARD，否则降级串行保留硬上限保护。
        if (modelCallLog.length + validEditorialCandidates.length > HARD) {
          warnings.push(
            `并行裁判预算不足（${modelCallLog.length}+${validEditorialCandidates.length}>${HARD}），降级串行`
          );
        } else {
          const outcomes = await Promise.all(
            validEditorialCandidates.map(async (ec) => {
              try {
                const result = await arb.arbitrate({
                  rawCandidate,
                  editorialCandidate: ec,
                  intent,
                  constitution,
                  // REAL-QUALITY-1-PREFLIGHT：pairwise 首轮 + 反向复判走 judge 轨（nb4_judge_glm），
                  // 冲突仲裁走 arbitrator 轨（routeLock 时也=nb4_judge_glm，未锁定时回退 judge 轨）。
                  // 不得只用 wrappedArbitratorModelGenerate 覆盖第三轮——首轮/反向也必须走 judge fn。
                  modelGenerate: wrappedJudgeModelGenerate!,
                  arbitratorModelGenerate: wrappedArbitratorModelGenerate,
                  seed: input.seed,
                  timeoutMs: input.timeoutMs,
                  allowAutomaticLiterarySelection: input.allowAutomaticLiterarySelection,
                });
                return { candidate: ec, result };
              } catch (e: unknown) {
                // 单个候选裁判异常不中断整体；记录后继续其余候选
                const msg = e instanceof Error ? e.message : String(e);
                warnings.push(`候选 ${ec.id} 裁判异常，跳过：${msg}`);
                return null;
              }
            })
          );
          // 按输入序展开（Promise.all 保持顺序），过滤异常 null
          for (const o of outcomes) if (o) arbitrationResults.push(o);
          return;
        }
      }
      // 串行（默认 / 并行预算不足降级）
      for (const ec of validEditorialCandidates) {
        // Step 1d 硬上限：每次裁判前检查，超限停止剩余裁判。
        // 已完成的裁判结果进入既有 selection 路径；无结果则循环后 deliverRaw。
        if (modelCallLog.length >= HARD) {
          modelBudget.capped = true;
          warnings.push(
            `模型调用达硬上限（${modelCallLog.length}/${HARD}），停止剩余裁判`
          );
          break;
        }
        try {
          const result = await arb.arbitrate({
            rawCandidate,
            editorialCandidate: ec,
            intent,
            constitution,
            // REAL-QUALITY-1-PREFLIGHT：pairwise 首轮 + 反向复判走 judge 轨（nb4_judge_glm），
            // 冲突仲裁走 arbitrator 轨（routeLock 时也=nb4_judge_glm，未锁定时回退 judge 轨）。
            modelGenerate: wrappedJudgeModelGenerate!,
            arbitratorModelGenerate: wrappedArbitratorModelGenerate,
            seed: input.seed,
            timeoutMs: input.timeoutMs,
            allowAutomaticLiterarySelection: input.allowAutomaticLiterarySelection,
          });
          arbitrationResults.push({ candidate: ec, result });
        } catch (e: unknown) {
          // 单个候选裁判异常不中断整体；记录后继续其余候选
          const msg = e instanceof Error ? e.message : String(e);
          warnings.push(`候选 ${ec.id} 裁判异常，跳过：${msg}`);
        }
      }
    });

    // 所有裁判均异常 → 交付 raw + warning
    if (arbitrationResults.length === 0) {
      warnings.push("所有 editorial 候选裁判均异常，交付 raw");
      stageResults.judgeArbitration = { error: "全部裁判异常" };
      // QUALITY-14：无仲裁故无 judge evidence 附件，写 skipped 标记（不伪造附件，不阻断交付）
      stageResults.judgeEvidenceAdvisoryAttachment =
        skippedJudgeEvidenceAdvisoryAttachment("所有 editorial 候选裁判均异常，无仲裁结果故未编译 judge evidence advisory attachment");
      return this.deliverRaw(input, rawCandidate, warnings, stageResults, null, oppResult.hypotheses, candidates);
    }

    // ── 阶段 6: 选择最终正文（P1-6 多候选比较） ────────────────────────
    // 从所有裁判结果中选出最终正文：
    // 1. 收集 editorial 胜出的结果（finalSelectedCandidateId === editorial.id）
    // 2. 若有 editorial 胜出，取胜因最强者（clear > 两轮一致 > 仲裁）
    // 3. 若无 editorial 胜出，交付 raw
    const editorialWins = arbitrationResults.filter(
      ({ candidate, result }) => result.finalSelectedCandidateId === candidate.id,
    );
    let editorialFinal: {
      leftCandidateId: string;
      rightCandidateId: string;
      result: ArbitratorResult;
    } | null = null;
    if (editorialWins.length > 1) {
      if (modelCallLog.length >= HARD) {
        modelBudget.capped = true;
        warnings.push("多个 editorial 均胜过 raw，但模型调用预算不足，无法直接决赛，保留 raw");
      } else {
        try {
          const [left, right] = editorialWins;
          const result = await timeAsync("stage5b_editorialFinal", () =>
            arb.arbitrate({
              rawCandidate: left.candidate,
              editorialCandidate: right.candidate,
              intent,
              constitution,
              modelGenerate: wrappedJudgeModelGenerate!,
              arbitratorModelGenerate: wrappedArbitratorModelGenerate,
              seed: input.seed,
              timeoutMs: input.timeoutMs,
              allowAutomaticLiterarySelection: input.allowAutomaticLiterarySelection,
            })
          );
          editorialFinal = {
            leftCandidateId: left.candidate.id,
            rightCandidateId: right.candidate.id,
            result,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          warnings.push(`editorial 胜者直接决赛异常，保留 raw：${msg}`);
        }
      }
    }

    const selectionOutcome = timeSync("stage6_selection", () =>
      this.selectBestCandidate(rawCandidate, arbitrationResults, editorialFinal));
    const { finalText, selectedSource, selectedCandidateId, judgeResult, selectionWarnings } = selectionOutcome;
    warnings.push(...selectionWarnings);

    stageResults.judgeArbitration = {
      reverseReviewed: judgeResult?.reverseReviewed ?? false,
      arbitrationTriggered: judgeResult?.arbitrationTriggered ?? false,
      conflicted: judgeResult?.conflicted ?? false,
      finalSelectedCandidateId: judgeResult?.finalSelectedCandidateId ?? null,
      selectionStatus: judgeResult?.selectionStatus ?? "judge_unavailable",
      auditSummary: judgeResult?.auditSummary ?? "machine judge unavailable; raw baseline preserved",
      rounds: judgeResult?.rounds.map((r) => ({
        round: r.round,
        winnerCandidateId: r.winnerCandidateId,
        degraded: r.result.degraded,
      })) ?? [],
      advisoryOnly: input.allowAutomaticLiterarySelection === false,
      allArbitrations: arbitrationResults.map(({ candidate, result }) => ({
        candidateId: candidate.id,
        finalSelectedCandidateId: result.finalSelectedCandidateId,
        conflicted: result.conflicted,
        reverseReviewed: result.reverseReviewed,
        arbitrationTriggered: result.arbitrationTriggered,
      })),
      editorialFinal: editorialFinal ? {
        leftCandidateId: editorialFinal.leftCandidateId,
        rightCandidateId: editorialFinal.rightCandidateId,
        finalSelectedCandidateId: editorialFinal.result.finalSelectedCandidateId,
        decisive: this.isDecisiveEditorialFinal(editorialFinal.result),
        conflicted: editorialFinal.result.conflicted,
        reverseReviewed: editorialFinal.result.reverseReviewed,
        arbitrationTriggered: editorialFinal.result.arbitrationTriggered,
        auditSummary: editorialFinal.result.auditSummary,
      } : null,
    };

    // ── 阶段 5c: QUALITY-14 JudgeEvidenceAdvisoryAttachment — 裁判证据审计附件 ──
    // 在 judge 返回后（stageResults.judgeArbitration 写入后）、Stage 6.5 最终事实复检前，
    // 把 QUALITY-12/13 的 trace/advisory 作为匿名、非决定性、只读审计附件挂到 judge evidence。
    // **只增强裁判证据可解释性，不改变 judge prompt，不改变 judge winner，不改变 SelectionPolicy。**
    // 附件通过 result.firstRound.mapping 反查 raw/editorial 的匿名 side（A/B），
    // 关联 QUALITY-12 trace 与 QUALITY-13 advisory，写入 stageResults.judgeEvidenceAdvisoryAttachment。
    // 附件不进入 judge prompt（judge 已返回），不影响 finalText，不阻断交付。
    // 编译异常 → skipped 附件 + warning，不阻断流程。
    timeSync("stage5c_judgeEvidenceAdvisoryAttachment", () =>
      runJudgeEvidenceAdvisoryAttachment(
        arbitrationResults,
        rawCandidate.id,
        stageResults,
        warnings
      )
    );

    // ── 阶段 6.5: 最终事实复检（P0-3） ────────────────────────────────
    // 对最终选定的正文（raw 或 editorial）做最终 FactGuard 复检。
    // 冻结计划 §8.1：B0/B1/B2/B3 在 eval 分支已返回；此处只有 B4 eval 和非 eval 生产路径。
    // 非 eval：硬伤 → hard block（不交付有事实硬伤的正文）。
    // B4 eval：硬伤 → 回退 raw 基线（保留评估信号，不 hard block）。
    const selectedCandidate = candidates.find((candidate) => candidate.id === selectedCandidateId);
    const finalFactRecheck = timeSync("stage6.5_finalFactRecheck", () =>
      checkCandidateFactGuard(
        finalText,
        input,
        selectedSource === "raw" ? undefined : rawCandidate.text,
      )
    );
    stageResults.finalFactRecheck = {
      selectedSource,
      passed: finalFactRecheck.ok,
      errors: finalFactRecheck.errors,
    };
    if (!finalFactRecheck.ok) {
      if (input.evalMode === "B4") {
        // B4 eval：final FactGuard 阻断 → 回退 raw 基线（保留评估信号）
        warnings.push(
          `evalMode=B4 final FactGuard 阻断：${finalFactRecheck.errors.join("; ")}，回退 raw`
        );
        return this.deliverRaw(input, rawCandidate, warnings, stageResults, null, oppResult.hypotheses, candidates);
      }
      return this.hardBlock(
        input, "final_fact_recheck",
        `最终正文事实硬伤：${finalFactRecheck.errors.join("; ")}`,
        stageResults,
        {
          // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR：final FactGuard 阻断保留最终候选正文 + 候选上下文
          rawText: rawCandidate.text,
          rawFinishReason: rawFinishReason ?? null,
          rawMaxTokens: rawMaxTokens ?? null,
          rawModel,
          modelVersion,
          factGuardErrors: finalFactRecheck.errors,
          candidateId: selectedCandidateId,
          selectedSource,
          finalText,
        },
      );
    }

    // ── 阶段 6.6: 最终正文灾难级完整性门禁 ───────────────────────────
    // 只阻断确定性的模型/传输截断；开放式钩子和普通缺标点仅进入 review。
    // 必须位于 state.commit / chapter.save 之前，确保不完整正文零副作用。
    const finalTextCompleteness = timeSync("stage6.6_finalTextCompleteness", () =>
      scanFinalTextCompleteness(finalText, {
        finishReason: selectedCandidate?.finishReason,
        chapterNumber: input.chapterNumber,
        minWordCount: input.targetWordCount?.min ?? 2000,
      })
    );
    stageResults.finalTextCompleteness = {
      ...finalTextCompleteness,
      selectedSource,
      selectedCandidateId,
      finishReason: selectedCandidate?.finishReason ?? null,
      maxTokens: selectedCandidate?.maxTokens ?? null,
    };
    if (!finalTextCompleteness.passed) {
      return this.hardBlock(
        input,
        "final_text_completeness",
        finalTextCompleteness.findings[0]?.reason ?? "最终正文疑似截断",
        stageResults,
        {
          // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR：final completeness 阻断保留最终候选正文 + 截断 span
          rawText: rawCandidate.text,
          rawFinishReason: rawFinishReason ?? null,
          rawMaxTokens: rawMaxTokens ?? null,
          rawModel,
          modelVersion,
          completenessFindings: finalTextCompleteness.findings.map((f) => ({
            reason: f.reason,
            kind: f.code ? `completeness_${f.code}` : "completeness_truncation",
            span: f.span,
          })),
          candidateId: selectedCandidateId,
          selectedSource,
          finalText,
        },
      );
    }

    stageResults.finalSelection = {
      selectedSource,
      selectedCandidateId,
      finalTextLength: finalText.length,
      evalMode: input.evalMode ?? null,
    };
    runStructuralEvidenceScan(finalText, selectedCandidateId, input, stageResults, warnings);
    runInformationReleaseScan(finalText, selectedCandidateId, input, stageResults, warnings);
    runEndingCraftScan(finalText, selectedCandidateId, input, stageResults, warnings);
    runCraftEvidenceEnvelope(finalText, selectedCandidateId, stageResults, warnings);
    runQualityEvidenceRunReport(
      selectedSource,
      selectedCandidateId,
      finalText,
      candidates.some((candidate) => candidate.kind === "editorial_amplified"),
      stageResults,
      warnings,
    );
    exportQualityEvidenceReport(this, input, stageResults, warnings);

    // ── 阶段 6.7: P0-3 代理审批（opt-in，在 commitAndSave 前） ──────────
    // 计划 §6.3 line 117-122：FinalFactRecheck → ChapterProxyApproval → saveProxyApprovedDraft
    // → UserRevisionOrAcceptance → FinalFactRecheck(user) → FinalStateCommit → AtomicChapterSave
    //
    // enableProxyApproval=true + selectedSource="editorial" → 构造 packetInput，调用 runner
    // PROXY_APPROVED + draftSaved=true → pending sentinel 落盘 → commitAndSave 被守护阻止
    // → 编排器返回 status="ok" 但 chapterFilePath=null（pending 状态，等用户 finalization）
    //
    // enableProxyApproval=false（默认）/ evalMode / selectedSource="raw" → no-op，直接进入 commitAndSave
    //
    // FULL-PIPELINE-PREVIEW-1：完整链路预览跳过代理审批阶段——预览运行只读不动审批状态。
    // 直接构造 no-op outcome（shouldHardBlock=false / shouldSkipCommit=false），不调用 runProxyApprovalStage。
    let proxyApprovalOutcome: ProxyApprovalOutcome;
    if (input.fullPipelinePreview) {
      proxyApprovalOutcome = {
        ran: false,
        skipReason: "fullPipelinePreview=true（预览模式不执行代理审批）",
        shouldSkipCommit: false,
        shouldHardBlock: false,
      };
      stageResults.proxyApproval = { skipped: true, reason: proxyApprovalOutcome.skipReason };
    } else {
      proxyApprovalOutcome = await runProxyApprovalStage(
        input, rawCandidate, selectedCandidateId, selectedSource, finalText, stageResults,
      );
    }

    // ── 阶段 7: FinalStateCommit + 原子保存（P0-4 事务一致性） ──────────
    // 事务顺序：先原子保存正文（失败 = hard block，不污染状态），
    //           后提交状态（失败 = warning，正文已交付）。
    // Eval 模式（B4）跳过 commitAndSave：不写章节文件、不提交状态（B3 已在 stage5b 前返回）。
    // P0-3：代理审批 pending 时跳过 commitAndSave（hasPendingProxyDraft 会阻止，直接跳过避免 error path）。
    // FULL-PIPELINE-PREVIEW-1：完整链路预览跳过 commitAndSave（不写章节、不提交状态）。
    let commitOutcome: { ok: boolean; error?: string; stateCommit: { committed: number; rejected: number } | null };
    // PRODUCTION-ROLLOUT-AUDIT-1（P0-1d）：标记"遗留 raw/judge 分支 commit 被关闭"，
    // 供下方 chapterFilePath 三元判空（跳过 commit 时不返回章节路径）。
    let commitSkippedForProduction = false;
    if (input.evalMode || input.fullPipelinePreview) {
      commitOutcome = { ok: true, stateCommit: null };
      stageResults.commitAndSave = {
        skipped: true,
        reason: input.evalMode ? `evalMode=${input.evalMode}` : "fullPipelinePreview",
      };
    } else if (proxyApprovalOutcome.shouldHardBlock) {
      // P0-3 fail-closed（核验结论第二轮 2026-07-17）：
      // HOLD_FOR_REGENERATION 或 PROXY_APPROVED + draftSaved=false → hard block
      // 不能继续 commitAndSave（违反计划 §6.3 line 117-122 完成定义"用户确认前不写正式章节"）
      return this.hardBlock(
        input, "proxy_approval_hard_block",
        proxyApprovalOutcome.hardBlockReason ?? "代理审批阻断",
        stageResults,
        {
          // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR：代理审批阻断时仍保留已生成候选正文供复盘
          rawText: rawCandidate.text,
          rawFinishReason: rawFinishReason ?? null,
          rawMaxTokens: rawMaxTokens ?? null,
          rawModel,
          modelVersion,
          candidateId: selectedCandidateId,
          selectedSource,
          finalText,
        },
      );
    } else if (proxyApprovalOutcome.shouldSkipCommit) {
      // P0-3：代理审批 PROXY_APPROVED + draftSaved=true → pending sentinel 已落盘
      // commitAndSave 会被 hasPendingProxyDraft 守护阻止，跳过调用避免 error path
      commitOutcome = { ok: true, stateCommit: null };
      stageResults.commitAndSave = {
        skipped: true,
        reason: "proxy_approval_pending",
        proxyApproval: proxyApprovalOutcome,
      };
    } else {
      const statePermission = this.authorizeCapability(
        controlPlane, controlTrace, "state.commit", "final state commit",
      );
      if (!statePermission.allowed) {
        return this.hardBlock(
          input, "control_plane_state_commit", "capability denied: state.commit", stageResults,
          {
            // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR：capability 拒绝时仍保留已生成候选正文
            rawText: rawCandidate.text,
            rawFinishReason: rawFinishReason ?? null,
            rawMaxTokens: rawMaxTokens ?? null,
            rawModel,
            modelVersion,
            candidateId: selectedCandidateId,
            selectedSource,
            finalText,
          },
        );
      }
      const savePermission = this.authorizeCapability(
        controlPlane, controlTrace, "chapter.save", "atomic chapter save",
      );
      if (!savePermission.allowed) {
        return this.hardBlock(
          input, "control_plane_chapter_save", "capability denied: chapter.save", stageResults,
          {
            // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR：capability 拒绝时仍保留已生成候选正文
            rawText: rawCandidate.text,
            rawFinishReason: rawFinishReason ?? null,
            rawMaxTokens: rawMaxTokens ?? null,
            rawModel,
            modelVersion,
            candidateId: selectedCandidateId,
            selectedSource,
            finalText,
          },
        );
      }
      // PRODUCTION-ROLLOUT-AUDIT-1（P0-1d）：遗留 raw/judge 分支（productionFlow 未设置，
      // 即 orchestrator-direct / 测试 flag 命中）不得提交章节 / 状态 / 生产 trace。
      // 仅显式授权（qualityExperiment）允许 commit；agentic 生产路径已在 finishWithCollab
      // 提前返回（line 2585），不会到达此处。evalMode / fullPipelinePreview 已在上方跳过。
      if (input.productionFlow === "agentic_style" || input.qualityExperiment) {
        commitOutcome = timeSync("stage7_commitAndSave", () =>
          commitAndSave(
            input, selectedCandidateId, finalText, stageResults
          )
        );
      } else {
        commitOutcome = { ok: true, stateCommit: null };
        commitSkippedForProduction = true;
        stageResults.commitAndSave = {
          skipped: true,
          reason: "production_raw_commit_forbidden",
        };
      }
    }
    if (!commitOutcome.ok) {
      // 正文保存失败 → hard block（状态未提交，无污染）
      return this.hardBlock(
        input, "atomic_save",
        `正文原子保存失败：${commitOutcome.error}`,
        stageResults,
        {
          // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR：原子保存失败时保留已生成候选正文供复盘
          rawText: rawCandidate.text,
          rawFinishReason: rawFinishReason ?? null,
          rawMaxTokens: rawMaxTokens ?? null,
          rawModel,
          modelVersion,
          candidateId: selectedCandidateId,
          selectedSource,
          finalText,
        },
      );
    }

    // ── 阶段 7.1: Phase 6 在线学习 — 记录策略结果（A5 修复：移到正文保存后）──
    // 为每个裁判过的 editorial 候选记录 win/loss/tie evidence 到策略信誉库。
    // 一个策略一次章节只记录一条（去重），驱动 Thompson Sampling 在线学习。
    // 计划 §Phase 6 退出条件：正常写作会记录结果并调整调用概率。
    // 学习失败不阻断生成（学习是增强，不是硬约束）。
    // A5 修复：outcome 记录必须在最终事实复检 + 正文保存成功之后，
    // 避免学习一次未交付结果（hard block 时不应污染策略信誉库）。
    // Eval 模式（B4）跳过学习记录：eval 结果不应污染策略信誉库。
    // FULL-PIPELINE-PREVIEW-1：完整链路预览跳过学习记录——预览结果不应污染策略信誉库。
    if (!input.evalMode && !input.fullPipelinePreview && input.policyStore && input.outcomeRecorder) {
      try {
        const learningResults = this.recordLearningOutcomes({
          arbitrationResults,
          activeHypotheses,
          selectedCandidateId,
          selectedSource,
          rawCandidateId: rawCandidate.id,
          chapterNumber,
          modelVersion,
          outcomeRecorder: input.outcomeRecorder,
          policyStore: input.policyStore,
        });
        stageResults.strategyOutcomes = learningResults;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(`策略学习记录异常（不阻断生成）：${msg}`);
        stageResults.strategyOutcomes = { error: msg };
      }
    } else if (input.evalMode) {
      stageResults.strategyOutcomes = { skipped: true, reason: `evalMode=${input.evalMode}` };
    } else if (input.fullPipelinePreview) {
      stageResults.strategyOutcomes = { skipped: true, reason: "fullPipelinePreview=true（预览模式不记录策略学习 outcome）" };
    }

    // WP-03..07：主路径成功出口（非 agentic_style finishWithCollab）挂载治理报告
    this.attachRoutingGovernanceOnExit(input, stageResults, {
      delivered: true,
      factGuardPassed: true,
      storyPreservationPassed: true,
    });

    return {
      status: "ok",
      workspaceId,
      chapterId,
      chapterNumber,
      text: finalText,
      selectedSource,
      selectedCandidateId,
      candidates,
      judgeResult,
      allArbitrationResults: arbitrationResults.map(({ candidate, result }) => ({
        candidateId: candidate.id,
        result,
      })),
      hypotheses: oppResult.hypotheses,
      warnings,
      failureEnvelope: null,
      stageResults,
      stateCommit: commitOutcome.stateCommit,
      // P0-3：代理审批 pending 时 chapterFilePath=null（pending 稿已落盘到
      // chapter-approvals/{approvalId}.draft.md，等用户 finalization 后才写正式章节）。
      // FULL-PIPELINE-PREVIEW-1：预览模式不写章节文件。
      chapterFilePath: (input.evalMode || input.fullPipelinePreview || proxyApprovalOutcome.shouldSkipCommit || commitSkippedForProduction)
        ? null
        : chapterFilePath(input),
      // FULL-PIPELINE-PREVIEW-1：标记本次运行为完整链路只读预览。
      isPreviewRun: Boolean(input.fullPipelinePreview),
      // 固定字段完整性只保留为 trace 诊断，不阻断生成或评测。
      isUnderSpecified,
    };
  }

  // ==========================================================================
  // raw 生成 -> 已抽出到 orchestrator-raw.ts（行为保持重构 Step 3）
  // ==========================================================================
  // ==========================================================================
  // FactGuard + 证据扫描 -> 已抽出到 orchestrator-factguard.ts（行为保持重构 Step 5）
  // ==========================================================================
  // ==========================================================================
  // QUALITY 证据相位 -> 已抽出到 orchestrator-quality.ts（行为保持重构 Step 4）
  // ==========================================================================
  // ==========================================================================
  // 多候选选择（P1-6）
  // ==========================================================================

  /**
   * 从多个裁判结果中选出最终正文。
   *
   * 选择逻辑：
   * 1. 收集 editorial 胜出的结果（finalSelectedCandidateId === editorial.id）
   * 2. 若有 editorial 胜出，按胜因强度排序取胜因最强者：
   *    - clear 首轮胜出（无需反向复判）> 两轮一致胜出 > 仲裁胜出
   * 3. 若无 editorial 胜出（raw 胜/tie/冲突/降级），交付 raw，
   *    judgeResult 取第一个裁判结果（供 trace 审计）
   *
   * 胜因强度评分（越高越强）：
   * - clear 首轮胜出且证据有效：3（最强，首轮即确认无需复判）
   * - 两轮一致确认胜出：2（反向复判确认）
   * - 仲裁确认胜出：1（需第三模型仲裁）
   */
  private selectBestCandidate(
    rawCandidate: Candidate,
    arbitrationResults: Array<{ candidate: Candidate; result: ArbitratorResult }>,
    editorialFinal: {
      leftCandidateId: string;
      rightCandidateId: string;
      result: ArbitratorResult;
    } | null = null,
  ): {
    finalText: string;
    selectedSource: "raw" | "editorial";
    selectedCandidateId: string;
    judgeResult: ArbitratorResult;
    selectionWarnings: string[];
  } {
    const selectionWarnings: string[] = [];

    // 收集 editorial 胜出的结果
    const editorialWins = arbitrationResults.filter(
      ({ candidate, result }) => result.finalSelectedCandidateId === candidate.id
    );

    // 无 editorial 胜出 → 交付 raw
    if (editorialWins.length === 0) {
      const firstResult = arbitrationResults[0].result;
      if (firstResult.firstRound.degraded) {
        selectionWarnings.push(`裁判降级（${firstResult.firstRound.degradeReason}），保留 raw`);
      } else if (firstResult.conflicted) {
        selectionWarnings.push("两轮裁判冲突，保留 raw");
      } else if (firstResult.firstRound.verdict?.winner === "tie") {
        selectionWarnings.push("裁判判 tie，保留 raw");
      } else {
        selectionWarnings.push("所有 editorial 候选均未胜出，保留 raw");
      }
      return {
        finalText: rawCandidate.text,
        selectedSource: "raw",
        selectedCandidateId: rawCandidate.id,
        judgeResult: firstResult,
        selectionWarnings,
      };
    }

    if (editorialWins.length > 1) {
      const finalWinnerId = editorialFinal?.result.finalSelectedCandidateId ?? null;
      const finalWinner = editorialWins.find(({ candidate }) => candidate.id === finalWinnerId);
      if (!editorialFinal || !finalWinner || !this.isDecisiveEditorialFinal(editorialFinal.result)) {
        selectionWarnings.push("多个 editorial 均胜过 raw，但直接决赛未形成明确胜者，保留 raw");
        return {
          finalText: rawCandidate.text,
          selectedSource: "raw",
          selectedCandidateId: rawCandidate.id,
          judgeResult: editorialFinal?.result ?? editorialWins[0].result,
          selectionWarnings,
        };
      }
      selectionWarnings.push(`editorial 直接决赛选中 ${finalWinner.candidate.id}`);
      return {
        finalText: finalWinner.candidate.text,
        selectedSource: "editorial",
        selectedCandidateId: finalWinner.candidate.id,
        judgeResult: editorialFinal.result,
        selectionWarnings,
      };
    }

    // 有 editorial 胜出 → 按胜因强度排序，取最强
    const ranked = editorialWins
      .map(({ candidate, result }) => ({
        candidate,
        result,
        strength: this.rankWinStrength(result),
      }))
      .sort((a, b) => b.strength - a.strength);

    const best = ranked[0];
    selectionWarnings.push(
      `editorial 候选 ${best.candidate.id} 胜出（胜因强度=${best.strength}，` +
      `${editorialWins.length} 个候选胜出中取胜因最强者）`
    );

    return {
      finalText: best.candidate.text,
      selectedSource: "editorial",
      selectedCandidateId: best.candidate.id,
      judgeResult: best.result,
      selectionWarnings,
    };
  }

  /**
   * 评估 editorial 胜出的胜因强度（越高越强）。
   * - clear 首轮胜出（无需反向复判）：3
   * - 两轮一致确认胜出（无冲突、无仲裁）：2
   * - 仲裁确认胜出（有冲突、触发仲裁）：1
   */
  private rankWinStrength(result: ArbitratorResult): number {
    if (!result.reverseReviewed) {
      // 首轮 clear 胜出，无需反向复判
      return 3;
    }
    if (!result.conflicted) {
      // 两轮一致确认
      return 2;
    }
    // 需要仲裁（或冲突保留但最终选中 editorial —— 实际上冲突时保留 raw，
    // 此分支仅覆盖仲裁后选中 editorial 的情况）
    return 1;
  }

  private isDecisiveEditorialFinal(result: ArbitratorResult): boolean {
    if (result.firstRound.degraded || result.firstRound.winnerCandidateId === null) {
      return false;
    }
    if (!result.reverseReviewed) return true;
    if (!result.conflicted) {
      return result.reverseRound?.winnerCandidateId === result.finalSelectedCandidateId;
    }
    return Boolean(
      result.arbitrationTriggered
      && result.arbitrationRound
      && !result.arbitrationRound.degraded
      && result.arbitrationRound.winnerCandidateId === result.finalSelectedCandidateId,
    );
  }

  // ==========================================================================
  // Phase 6 在线学习辅助
  // ==========================================================================

  /**
   * 收集 hypotheses 对应的候选策略（去重）。
   * 每个 hypothesis 通过 registry.pickStrategyForHypothesis 取其首选策略，
   * 合并去重后供 Thompson Sampling 采样。
   */
  private collectCandidateStrategies(
    registry: EditorialStrategyRegistry,
    hypotheses: EditorialHypothesis[]
  ): EditorialStrategyDef[] {
    const seen = new Set<string>();
    const result: EditorialStrategyDef[] = [];
    for (const h of hypotheses) {
      const strat = registry.pickStrategyForHypothesis(h);
      if (strat && !seen.has(strat.strategyId)) {
        seen.add(strat.strategyId);
        result.push(strat);
      }
    }
    return result;
  }

  /**
   * 把 ArbitratorResult 映射为 Phase 6 JudgeOutcome（计划 §7.3 胜负语义）。
   *
   * 映射规则：
   * - confidence: 首轮 verdict 的 confidence（clear/slight/uncertain）
   * - hadReverseReview: arbitrator.reverseReviewed
   * - reverseConsensus: 触发反向复判且两轮无冲突（异构双裁判一致信号）
   * - tie: 首轮 verdict winner === "tie"
   * - selectedCandidateId: arbitrator.finalSelectedCandidateId（null = 保留 raw）
   */
  private mapArbitrationToJudgeOutcome(
    result: ArbitratorResult,
    editorialCandidateId: string,
    rawCandidateId: string
  ): JudgeOutcome {
    const firstVerdict = result.firstRound.verdict;
    const confidence = firstVerdict?.confidence ?? "uncertain";
    const tie = firstVerdict?.winner === "tie";
    // reverseConsensus：触发反向复判且两轮一致（无冲突）
    const reverseConsensus = result.reverseReviewed && !result.conflicted;
    return {
      editorialCandidateId,
      rawCandidateId,
      selectedCandidateId: result.finalSelectedCandidateId,
      confidence,
      hadReverseReview: result.reverseReviewed,
      reverseConsensus,
      tie,
    };
  }

  /**
   * 为每个裁判过的 editorial 候选记录策略学习结果（计划 §Phase 6）。
   *
   * 一个策略一次章节只记录一条 evidence（按 strategyId 去重，避免重复计数）。
   * 胜出的候选优先记录；同 strategyId 的后续候选跳过。
   *
   * 返回每条记录的摘要供 trace 审计。
   */
  private recordLearningOutcomes(params: {
    arbitrationResults: Array<{ candidate: Candidate; result: ArbitratorResult }>;
    activeHypotheses: EditorialHypothesis[];
    selectedCandidateId: string;
    selectedSource: "raw" | "editorial";
    rawCandidateId: string;
    chapterNumber: number;
    modelVersion: string;
    policyStore: StrategyPolicyStore;
    outcomeRecorder: StrategyOutcomeRecorder;
  }): Array<{
    strategyId: string;
    candidateId: string;
    outcome: "win" | "loss" | "tie";
    weight: number;
    recorded: boolean;
  }> {
    const {
      arbitrationResults,
      activeHypotheses,
      selectedCandidateId,
      selectedSource,
      rawCandidateId,
      chapterNumber,
      modelVersion,
      policyStore,
      outcomeRecorder,
    } = params;

    // hypothesis id → opportunityType 映射（StrategyContext 需要）
    const hypothesisMap = new Map(
      activeHypotheses.map((h) => [h.id, h] as const)
    );
    const sourceChapter = `ch${chapterNumber}`;
    const recordedStrategies = new Set<string>();
    const summaries: Array<{
      strategyId: string;
      candidateId: string;
      outcome: "win" | "loss" | "tie";
      weight: number;
      recorded: boolean;
    }> = [];

    // 胜出的候选优先记录（确保同 strategyId 去重时保留 win 而非 loss）
    const sorted = [...arbitrationResults].sort((a, b) => {
      const aWon = a.result.finalSelectedCandidateId === a.candidate.id ? 0 : 1;
      const bWon = b.result.finalSelectedCandidateId === b.candidate.id ? 0 : 1;
      return aWon - bWon;
    });

    for (const { candidate: ec, result } of sorted) {
      // 从候选读取 strategyId（editorial-candidate-generator 写入 editorialStrategy 字段）
      const strategyId = ec.editorialStrategy as string | undefined;
      const hypothesis = ec.hypothesisId
        ? hypothesisMap.get(ec.hypothesisId)
        : undefined;
      if (!strategyId || !hypothesis) continue;

      // 去重：同 strategyId 只记录第一条（胜出优先）
      if (recordedStrategies.has(strategyId)) continue;
      recordedStrategies.add(strategyId);

      const judge = this.mapArbitrationToJudgeOutcome(
        result, ec.id, rawCandidateId
      );
      const selection: SelectionOutcome = {
        deliveredCandidateId: selectedCandidateId,
        deliveredSource: selectedSource,
        fellBackToRaw: false, // 到达 Stage 6.1 的候选都经过裁判，无编辑层失败回退
      };
      const recorded = outcomeRecorder.record(policyStore, {
        context: {
          sourceChapter,
          modelVersion,
          strategyId,
          opportunityType: hypothesis.opportunityType,
        },
        judge,
        selection,
      });

      summaries.push({
        strategyId,
        candidateId: ec.id,
        outcome: recorded.outcome,
        weight: recorded.weight,
        recorded: recorded.recorded,
      });
    }

    return summaries;
  }

  // ==========================================================================
  // 状态提交 + 原子保存 -> 已抽出到 orchestrator-commit-save.ts（行为保持重构 Step 2）
  // ==========================================================================
  // ==========================================================================
  // 降级辅助
  // ==========================================================================

  /**
   * 交付 raw（编辑/裁判失败时）。执行状态提交 + 原子保存。
   * 正文保存失败 → hard block（不交付空文本，不污染状态）。
   *
   * Eval 模式（B0/B1/B2 raw 后直接 return，或 B3/B4 无 editorial/无 hypothesis 时降级）：
   * 跳过 commitAndSave（不写章节文件、不提交状态），chapterFilePath/stateCommit=null。
   */
  private async deliverRaw(
    input: UnifiedOrchestratorInput,
    rawCandidate: Candidate,
    warnings: string[],
    stageResults: Record<string, unknown>,
    judgeResult: ArbitratorResult | null,
    hypotheses: import("./editorial-hypothesis.js").EditorialHypothesis[],
    candidates: Candidate[]
  ): Promise<UnifiedOrchestratorOutput> {
    // RECOVERY-P4：生产 agentic_style 路径禁止静默 raw 降级交付。
    // evalMode / qualityExperiment 允许 deliverRaw（消融与只读实验）。
    // 正式生产：Agentic 初稿必须经作者风格优化；失败只能 retry/checkpoint/blocked。
    if (
      input.productionFlow === "agentic_style" &&
      !input.evalMode &&
      !input.qualityExperiment
    ) {
      return this.hardBlock(
        input,
        "production_raw_degrade_forbidden",
        "生产路径禁止静默交付 raw（Agentic 初稿不可直接交付；仅允许 retry_stage / checkpoint / blocked）",
        stageResults,
        {
          rawText: rawCandidate.text,
          rawFinishReason: rawCandidate.finishReason ?? null,
          rawMaxTokens: rawCandidate.maxTokens ?? null,
          rawModel: (stageResults.rawGeneration as { model?: string } | undefined)?.model ?? "unknown",
          modelVersion: (stageResults.modelVersion as string | null) ?? null,
          candidateId: rawCandidate.id,
          selectedSource: "raw",
          finalText: rawCandidate.text,
        },
        {
          gate: "recovery_policy",
          severityOverride: "hard",
          recoverable: false,
          candidateDisposition: "blocked_evidence_only",
          prohibitedActions: [
            "accept_or_deliver_blocked_candidate",
            "save_blocked_candidate_as_chapter",
          ],
        },
      );
    }

    // A4：early-return 路径也接入 LanguageRiskAnalyzer，确保交付 raw 的章节
    // 同样有语言风险证据入 trace。guard 避免与主路径 Stage 5a.5 重复扫描
    // （line-418 全裁判异常 → deliverRaw 时 stageResults.languageRisk 已设）。
    if (!stageResults.languageRisk) {
      runLanguageRiskAnalysis(
        candidates, input.characterNames, stageResults, warnings,
      );
    }

    // raw fallback/soft-cap/no-op 也必须在任何保存或状态提交前经过同一完整性门禁。
    const finalTextCompleteness = scanFinalTextCompleteness(rawCandidate.text, {
      finishReason: rawCandidate.finishReason,
      chapterNumber: input.chapterNumber,
    });
    stageResults.finalTextCompleteness = {
      ...finalTextCompleteness,
      selectedSource: "raw",
      selectedCandidateId: rawCandidate.id,
      finishReason: rawCandidate.finishReason ?? null,
      maxTokens: rawCandidate.maxTokens ?? null,
    };
    if (!finalTextCompleteness.passed) {
      return this.hardBlock(
        input,
        "final_text_completeness",
        finalTextCompleteness.findings[0]?.reason ?? "最终正文疑似截断",
        stageResults,
        {
          // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR：deliverRaw completeness 阻断保留 raw 候选正文 + 截断 span
          rawText: rawCandidate.text,
          rawFinishReason: rawCandidate.finishReason ?? null,
          rawMaxTokens: rawCandidate.maxTokens ?? null,
          rawModel: (stageResults.rawGeneration as { model?: string } | undefined)?.model ?? "unknown",
          modelVersion: (stageResults.modelVersion as string | null) ?? null,
          completenessFindings: finalTextCompleteness.findings.map((f) => ({
            reason: f.reason,
            kind: f.code ? `completeness_${f.code}` : "completeness_truncation",
            span: f.span,
          })),
          candidateId: rawCandidate.id,
          selectedSource: "raw",
          finalText: rawCandidate.text,
        },
      );
    }

    stageResults.finalSelection = {
      selectedSource: "raw",
      selectedCandidateId: rawCandidate.id,
      finalTextLength: rawCandidate.text.length,
      degradedToRaw: !input.evalMode,
      evalMode: input.evalMode ?? null,
    };
    runStructuralEvidenceScan(
      rawCandidate.text, rawCandidate.id, input, stageResults, warnings,
    );
    runInformationReleaseScan(
      rawCandidate.text, rawCandidate.id, input, stageResults, warnings,
    );
    runEndingCraftScan(
      rawCandidate.text, rawCandidate.id, input, stageResults, warnings,
    );
    runCraftEvidenceEnvelope(
      rawCandidate.text, rawCandidate.id, stageResults, warnings,
    );
    runQualityEvidenceRunReport(
      "raw",
      rawCandidate.id,
      rawCandidate.text,
      candidates.some((candidate) => candidate.kind === "editorial_amplified"),
      stageResults,
      warnings,
    );
    exportQualityEvidenceReport(this, input, stageResults, warnings);

    // Eval 模式：跳过 commitAndSave（不写章节文件、不提交状态）
    // FULL-PIPELINE-PREVIEW-1：完整链路预览也跳过 commitAndSave（不写章节、不提交状态）。
    let commitOutcome: { ok: boolean; error?: string; stateCommit: { committed: number; rejected: number } | null };
    // PRODUCTION-ROLLOUT-AUDIT-1（P0-1d）：标记"遗留 raw/judge 分支 commit 被关闭"，
    // 供下方 chapterFilePath 三元判空（跳过 commit 时不返回章节路径）。
    let commitSkippedForProduction = false;
    if (input.evalMode || input.fullPipelinePreview) {
      commitOutcome = { ok: true, stateCommit: null };
      stageResults.commitAndSave = {
        skipped: true,
        reason: input.evalMode ? `evalMode=${input.evalMode}` : "fullPipelinePreview",
      };
    } else {
      // STATE-PARTICIPATION-2：raw-only 降级路径同样必须在正文保存/状态提交前
      // 记录并消费 capability 决策；拒绝时零副作用，不能绕过主路径控制面。
      const controlPlane = input.controlPlane;
      const controlTrace = stageResults.controlPlane as ControlPlaneTrace | undefined;
      if (controlPlane && controlTrace) {
        const statePermission = this.authorizeCapability(
          controlPlane, controlTrace, "state.commit", "raw-only final state commit",
        );
        if (!statePermission.allowed) {
          return this.hardBlock(
            input, "control_plane_state_commit", "capability denied: state.commit", stageResults,
            {
              // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR：deliverRaw capability 拒绝时仍保留已生成候选正文
              rawText: rawCandidate.text,
              rawFinishReason: rawCandidate.finishReason ?? null,
              rawMaxTokens: rawCandidate.maxTokens ?? null,
              rawModel: (stageResults.rawGeneration as { model?: string } | undefined)?.model ?? "unknown",
              modelVersion: (stageResults.modelVersion as string | null) ?? null,
              candidateId: rawCandidate.id,
              selectedSource: "raw",
              finalText: rawCandidate.text,
            },
          );
        }
        const savePermission = this.authorizeCapability(
          controlPlane, controlTrace, "chapter.save", "raw-only atomic chapter save",
        );
        if (!savePermission.allowed) {
          return this.hardBlock(
            input, "control_plane_chapter_save", "capability denied: chapter.save", stageResults,
            {
              // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR：deliverRaw capability 拒绝时仍保留已生成候选正文
              rawText: rawCandidate.text,
              rawFinishReason: rawCandidate.finishReason ?? null,
              rawMaxTokens: rawCandidate.maxTokens ?? null,
              rawModel: (stageResults.rawGeneration as { model?: string } | undefined)?.model ?? "unknown",
              modelVersion: (stageResults.modelVersion as string | null) ?? null,
              candidateId: rawCandidate.id,
              selectedSource: "raw",
              finalText: rawCandidate.text,
            },
          );
        }
      }
      // PRODUCTION-ROLLOUT-AUDIT-1（P0-1d）：遗留 raw/judge 分支（productionFlow 未设置，
      // 即 orchestrator-direct / 测试 flag 命中）不得提交章节 / 状态 / 生产 trace。
      // 仅显式授权（qualityExperiment）或 agentic 生产路径（实际不会到达 deliverRaw）允许 commit。
      // evalMode / fullPipelinePreview 已在上方跳过；此处兜底关闭"无授权即提交 raw"的泄漏。
      if (input.productionFlow === "agentic_style" || input.qualityExperiment) {
        commitOutcome = commitAndSave(
          input, rawCandidate.id, rawCandidate.text, stageResults
        );
      } else {
        commitOutcome = { ok: true, stateCommit: null };
        commitSkippedForProduction = true;
        stageResults.commitAndSave = {
          skipped: true,
          reason: "production_raw_commit_forbidden",
        };
      }
    }

    // 正文保存失败 → hard block（不假装成功）
    if (!commitOutcome.ok) {
      return this.hardBlock(
        input, "atomic_save",
        `交付 raw 时正文原子保存失败：${commitOutcome.error}`,
        stageResults,
        {
          // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR：deliverRaw 原子保存失败时保留已生成候选正文供复盘
          rawText: rawCandidate.text,
          rawFinishReason: rawCandidate.finishReason ?? null,
          rawMaxTokens: rawCandidate.maxTokens ?? null,
          rawModel: (stageResults.rawGeneration as { model?: string } | undefined)?.model ?? "unknown",
          modelVersion: (stageResults.modelVersion as string | null) ?? null,
          candidateId: rawCandidate.id,
          selectedSource: "raw",
          finalText: rawCandidate.text,
        },
      );
    }

    // WP-03..07：deliverRaw 成功出口挂载治理报告（eval B0/B1/B2 / raw-only 路径）
    this.attachRoutingGovernanceOnExit(input, stageResults, {
      delivered: true,
      factGuardPassed: true,
      storyPreservationPassed: true,
    });

    return {
      status: "ok",
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      chapterNumber: input.chapterNumber,
      text: rawCandidate.text,
      selectedSource: "raw",
      selectedCandidateId: rawCandidate.id,
      candidates,
      judgeResult,
      allArbitrationResults: [],
      hypotheses,
      warnings,
      failureEnvelope: null,
      stageResults,
      stateCommit: commitOutcome.stateCommit,
      // FULL-PIPELINE-PREVIEW-1：预览模式不写章节文件（与主路径一致）。
      chapterFilePath: (input.evalMode || input.fullPipelinePreview || commitSkippedForProduction) ? null : chapterFilePath(input),
      // FULL-PIPELINE-PREVIEW-1：标记本次运行为完整链路只读预览。
      isPreviewRun: Boolean(input.fullPipelinePreview),
      // INTENT-COMPLETENESS-1：deliverRaw 路径也透传 under-specified 标记。
      // B0/B1/B2 走 deliverRaw，under-specified 不阻断但需透传给调用方/trace。
      isUnderSpecified: Boolean(
        input.intent?.underSpecifiedFields && input.intent.underSpecifiedFields.length > 0,
      ),
    };
  }

  /**
   * Hard block：raw 失败结构化阻断。无 legacy 回退。
   *
   * BLOCKED-CANDIDATE-EVIDENCE-1（派工计划 P0-A）：
   * 当 blockedEvidenceInput 携带非空 rawText 时，保留完整 redacted raw、SHA-256、长度、
   * finishReason、诊断 span 到隔离 artifact（traces/{chapterId}-blocked-candidate-evidence.json）。
   * 不保存章节、不提交状态；写入失败不得放行正文（hardBlock 已返回 blocked）。
   */
  private hardBlock(
    input: UnifiedOrchestratorInput,
    stage: string,
    reason: string,
    stageResults: Record<string, unknown>,
    blockedEvidenceInput?: {
      rawText: string;
      rawFinishReason: string | null;
      rawMaxTokens: number | null;
      rawModel: string;
      modelVersion: string | null;
      factGuardErrors?: string[];
      completenessFindings?: Array<{
        reason: string;
        kind: string;
        anchor?: string;
        span?: { start: number; end: number };
      }>;
      // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR: final candidate hard-block 上下文
      candidateId?: string | null;
      selectedSource?: "raw" | "editorial" | null;
      finalText?: string | null;
    },
    /**
     * P1 修复（Phase 1 整改）：覆盖默认 severity。
     *
     * 默认 severity = stage === "raw_generation" ? "fatal" : "hard"。
     * 模型超时/空结果类阻断传 "recoverable"，使工具层 register-tools.ts
     * 的 `severity === "recoverable" && gate === "model_timeout"` 重试条件可达。
     */
    guidance?: HardBlockGuidance,
  ): UnifiedOrchestratorOutput {
    // hardBlock 不接收调用方 warnings（阻断路径独立维护局部 warnings，
    // 仅供 QUALITY-16 导出失败等局部 warning 使用，不与主链路 warnings 合并）。
    const warnings: string[] = [];
    // RECOVERY-P0/P2/P5：统一 failureClass + recoveryAction；预算贯穿；checkpoint 落盘
    const attemptRaw = (input as unknown as { _modelTimeoutRetryAttempt?: number })
      ._modelTimeoutRetryAttempt;
    const attempt = typeof attemptRaw === "number" ? attemptRaw : 0;

    // 章节级恢复预算：优先本轮 stageResults → 外层重试传入的 prior → 新建
    // 外层 register-tools 重试必须透传 prior，否则每次 orchestrate 重置预算
    const priorBudget = (
      input as unknown as { _priorRecoveryBudget?: RecoveryBudget }
    )._priorRecoveryBudget;
    let recoveryBudget =
      (stageResults.recoveryBudget as RecoveryBudget | undefined) ??
      (priorBudget ? { ...priorBudget } : undefined) ??
      createRecoveryBudget(input.recoveryBudgetOverrides as Partial<RecoveryBudget> | undefined);
    const recoveryMachine =
      (stageResults._recoveryMachine as ReturnType<typeof createRecoveryStateMachine> | undefined) ??
      createRecoveryStateMachine("running");

    // 可恢复失败：预扣预算；不足则强制 checkpoint（不得再发起模型/工具调用）
    let budgetForceCheckpoint = false;
    const isRecoverableHint =
      guidance?.severityOverride === "recoverable" ||
      guidance?.recoverable === true ||
      guidance?.gate === "model_timeout";
    // Internal bounded recovery already reserved the model/attempt budget. A
    // later hardBlock is only the terminal report for that same run; charging
    // it again would consume a second attempt without making another call.
    const hasInternalRecoveryAttempt = [
      stageResults.generationRecovery,
      stageResults.finalGenerationRecovery,
    ].some((trace) => {
      if (!trace || typeof trace !== "object") return false;
      const attempts = (trace as { attempts?: unknown }).attempts;
      return Array.isArray(attempts) && attempts.length > 0;
    });
    const internalRecoveryHadNoCall = [
      stageResults.generationRecovery,
      stageResults.finalGenerationRecovery,
    ].some((trace) => {
      if (!trace || typeof trace !== "object") return false;
      const attempts = (trace as {
        attempts?: Array<{ outcome?: string }>;
      }).attempts;
      return Array.isArray(attempts)
        && attempts.length === 1
        && attempts[0]?.outcome === "budget_exhausted";
    });
    if (isRecoverableHint && !hasInternalRecoveryAttempt) {
      const reserved = reserveBudget(recoveryBudget, {
        stageAttempts: 1,
        totalAttempts: 1,
        recoveryModelCalls: 1,
        modelCalls: 1,
      });
      if (!reserved.ok) {
        budgetForceCheckpoint = true;
        stageResults.recoveryBudgetExhausted = {
          reason: reserved.reason,
          snapshot: reserved.snapshot,
        };
      } else {
        recoveryBudget = reserved.budget;
        stageResults.recoveryBudget = recoveryBudget;
      }
    } else if (isRecoverableHint && internalRecoveryHadNoCall) {
      budgetForceCheckpoint = true;
      stageResults.recoveryBudgetExhausted ??= {
        reason: "internal_recovery_budget_exhausted",
        snapshot: snapshotBudget(recoveryBudget),
      };
    }

    const policyHit = matchRecoveryPolicy({
      failureClass:
        guidance?.severityOverride === "recoverable"
          ? "recoverable"
          : guidance?.severityOverride === "preflight"
            ? "preflight"
            : undefined,
      gate: guidance?.gate,
      stage,
    });

    const guidanceMaxAttempts =
      guidance?.retryPlan?.maxAttempts ?? policyHit?.maxAttempts ?? 1;
    const canRetrySameChapterAfterCheckpoint =
      guidance?.recoverable === true
      && guidance.retryPlan?.strategy === "revise_inputs_and_retry_same_chapter";
    // attempt 已达/超过 maxAttempts：禁止再 retry，强制 checkpoint（跨外层重试闭环）
    const attemptExhausted =
      isRecoverableHint && attempt >= guidanceMaxAttempts && !budgetForceCheckpoint;

    // WP-04：失败策略矩阵 — 记录 attemptHistory / prohibited / failureType
    // 与 buildProductionFailureEnvelope 并存；矩阵提供可审计策略证据，不替换主 envelope。
    const govStateForFailure =
      getGovernanceState(stageResults) ??
      createRoutingGovernanceState({
        runRouting: input.runRouting,
        recoveryBudget,
      });
    const failureRecord = recordFailureStrategy(govStateForFailure, {
      stage,
      gate: guidance?.gate ?? policyHit?.match.gateIncludes?.[0],
      reason,
      attempt,
      failureClassHint:
        guidance?.severityOverride === "recoverable"
          ? "recoverable"
          : guidance?.severityOverride === "preflight"
            ? "preflight"
            : undefined,
    });
    setGovernanceState(stageResults, failureRecord.state);
    stageResults._lastFailureStrategyDecision = failureRecord.decision;
    stageResults._lastFailureType = failureRecord.failureType;
    stageResults.failureStrategyDecision = {
      failureType: failureRecord.failureType,
      recoveryAction: failureRecord.decision.decision.recoveryAction,
      failureClass: failureRecord.decision.decision.failureClass,
      attemptHistory: failureRecord.decision.attemptHistory,
      prohibited: failureRecord.decision.rule.prohibited,
      silentDegradeForbidden: failureRecord.decision.silentDegradeForbidden,
      preserveIntermediateEvidence: failureRecord.decision.preserveIntermediateEvidence,
      ruleDescription: failureRecord.decision.rule.description,
    };

    const built = buildProductionFailureEnvelope({
      stage,
      reason: budgetForceCheckpoint
        ? `${reason}（恢复预算耗尽：${(stageResults.recoveryBudgetExhausted as { reason?: string } | undefined)?.reason ?? "budget"}）`
        : attemptExhausted
          ? `${reason}（重试次数耗尽 attempt=${attempt} max=${guidanceMaxAttempts}）`
          : reason,
      gate: guidance?.gate ?? policyHit?.match.gateIncludes?.[0],
      evidence: guidance?.evidence,
      severity:
        budgetForceCheckpoint || attemptExhausted
          ? "hard"
          : (guidance?.severityOverride ??
            (stage === "raw_generation" ? "fatal" : "hard")),
      recoverable:
        budgetForceCheckpoint || attemptExhausted
          ? canRetrySameChapterAfterCheckpoint
          : guidance?.recoverable,
      attempt,
      maxAttempts: guidanceMaxAttempts,
      budget: recoveryBudget,
      userActionRequired: guidance?.userActionRequired,
      candidateDisposition: guidance?.candidateDisposition,
      // 失败策略矩阵的 prohibited 写入 stageResults.failureStrategyDecision；
      // envelope.prohibitedActions 仍使用 guidance 的类型化集合，避免跨 schema 强转。
      prohibitedActions: guidance?.prohibitedActions,
      blockCategory: guidance?.blockCategory,
      // 预算耗尽 / attempt 耗尽：强制 checkpoint，禁止 guidance.retryPlan 覆盖为 retry
      forceRecoveryAction:
        budgetForceCheckpoint || attemptExhausted
          ? "checkpoint"
          : guidance?.retryPlan
            ? guidance.retryPlan.strategy === "retry_gate"
              ? "retry_gate"
              : guidance.retryPlan.strategy === "chapter_level_retry"
                ? "retry_stage"
              : guidance.retryPlan.strategy === "revise_inputs_and_retry_same_chapter"
                  ? "user_fix"
                  : guidance.retryPlan.strategy === "terminal_block_no_retry"
                    ? "stop"
                    : undefined
            : policyHit?.action,
      recoveryHints: {
        schemaOrParseError: guidance?.gate === "schema" || guidance?.gate === "parse",
        coverageInsufficient:
          guidance?.gate === "must_verify_coverage" ||
          guidance?.gate === "coverage",
        confirmedFactConflict:
          guidance?.gate === "fact_guard" && guidance?.recoverable === false,
        chapterSaveFailed: stage === "atomic_save",
        stateCommitFailed: stage.includes("state_commit"),
        staleRevision: guidance?.gate === "stale_revision",
      },
    });
    // 仅当仍可 retry 时保留调用方 retryPlan；attempt/budget 耗尽后不得覆盖为 retry
    if (guidance?.retryPlan && !budgetForceCheckpoint && !attemptExhausted) {
      const strategy = guidance.retryPlan.strategy;
      built.retryPlan = {
        strategy:
          strategy === "retry_gate" ||
            strategy === "chapter_level_retry" ||
          strategy === "revise_inputs_and_retry_same_chapter" ||
          strategy === "terminal_block_no_retry"
            ? strategy
            : "chapter_level_retry",
        maxAttempts: guidance.retryPlan.maxAttempts,
      };
      built.recoverable = guidance.recoverable ?? built.recoverable;
      if (guidance.severityOverride === "recoverable") {
        built.failureClass = "recoverable";
        built.severity = "recoverable";
      }
    } else if (budgetForceCheckpoint || attemptExhausted) {
      // 耗尽后停止自动重试并清除 retryPlan。作者输入修订/同章重新执行仍是
      // 可恢复操作，不能把“本轮预算耗尽”误写成该章节永久不可恢复。
      built.recoverable = canRetrySameChapterAfterCheckpoint;
      built.retryPlan = undefined;
      if (built.failureClass === "recoverable") {
        // 保留 failureClass 语义为 recoverable 的历史原因，但 action=checkpoint
        // severity 用 hard 让工具层不再重试
        built.severity = "hard";
      }
    }
    const envelope = toUnifiedFailureEnvelope(built) as UnifiedFailureEnvelope;
    // 确保 failureClass 始终存在（生产真相源）
    if (!envelope.failureClass) {
      envelope.failureClass = mapLegacyFailureClass(envelope.severity);
    }
    // 外层重试可读取累计预算
    stageResults.recoveryBudget = recoveryBudget;
    // BG-01：阻断路径同样落盘统一预算账本（外层重试读取 budgetLedger 延续消耗）
    const priorLedgerState = (
      stageResults as Record<string, unknown>
    )._budgetLedgerState as BudgetLedger | undefined;
    if (priorLedgerState) {
      stageResults.budgetLedger = getBudgetLedger(priorLedgerState);
      delete (stageResults as Record<string, unknown>)._budgetLedgerState;
    }
    stageResults.failureEnvelope = envelope;
    stageResults.recoveryDecision = {
      recoveryAction: built.recoveryAction,
      failureClass: built.failureClass,
      attempt: built.attempt,
      maxAttempts: built.maxAttempts,
      nextStep: built.nextStep,
      traceId: built.traceId,
      policyRuleId: policyHit?.id ?? null,
      budgetSnapshot: snapshotBudget(recoveryBudget),
      attemptExhausted,
      budgetForceCheckpoint,
    };
    stageResults.recoveryBudgetSnapshot = budgetSnapshotForTrace(recoveryBudget);

    // 状态机推进：必须走合法路径
    // running → retryable_failure → checkpoint（不得 running 直跳 checkpoint）
    // running → interrupted → checkpoint
    // running → blocked
    const wantsCheckpoint =
      built.recoveryAction === "checkpoint" ||
      budgetForceCheckpoint ||
      attemptExhausted;
    const wantsInterrupted = built.failureClass === "interrupted";
    const wantsRetryable =
      !wantsCheckpoint &&
      !wantsInterrupted &&
      built.failureClass === "recoverable" &&
      built.recoverable;

    if (wantsInterrupted) {
      if (recoveryMachine.state === "running") {
        recoveryMachine.transition("interrupted", built.reason);
      }
      if (recoveryMachine.state === "interrupted") {
        recoveryMachine.transition("checkpoint", "persist_after_interrupt");
      }
    } else if (wantsCheckpoint) {
      if (recoveryMachine.state === "running") {
        recoveryMachine.transition("retryable_failure", built.reason);
      }
      if (
        recoveryMachine.state === "retryable_failure" ||
        recoveryMachine.state === "retrying"
      ) {
        recoveryMachine.transition(
          "checkpoint",
          budgetForceCheckpoint
            ? "budget_exhausted"
            : attemptExhausted
              ? "attempt_exhausted"
              : "policy_checkpoint",
        );
      }
    } else if (wantsRetryable) {
      if (recoveryMachine.state === "running") {
        recoveryMachine.transition("retryable_failure", built.reason);
      }
    } else {
      // blocked / fatal / preflight
      if (recoveryMachine.state === "running") {
        recoveryMachine.transition("blocked", built.reason);
      } else if (
        recoveryMachine.state === "retryable_failure" ||
        recoveryMachine.state === "retrying"
      ) {
        recoveryMachine.transition("blocked", built.reason);
      }
    }
    stageResults.recoveryLifecycle = {
      state: recoveryMachine.state,
      history: recoveryMachine.transitionHistory,
    };

    // RECOVERY-P5：checkpoint / interrupted / 预算耗尽 → 落盘 recovery checkpoint
    // 不执行 chapter.save / state.commit；resume 必须显式触发。
    if (
      built.recoveryAction === "checkpoint" ||
      built.failureClass === "interrupted" ||
      budgetForceCheckpoint
    ) {
      try {
        const workspacePath = join(
          input.projectRoot,
          "workspaces",
          input.workspaceId,
        );
        const cp = saveRecoveryCheckpoint({
          workspacePath,
          workspaceId: input.workspaceId,
          chapterId: input.chapterId,
          taskId: input.controlPlane?.packet.taskId ?? `chapter:${input.chapterId}`,
          stage,
          candidateId: blockedEvidenceInput?.candidateId ?? undefined,
          recoveryBudget,
          interruptReason: budgetForceCheckpoint
            ? "budget_exhausted"
            : built.failureClass === "interrupted"
              ? "user_abort"
              : undefined,
          completedWork: Array.isArray(stageResults.pipelineProgress)
            ? []
            : [
                String(
                  (stageResults.pipelineProgress as { lastCompletedStage?: string } | undefined)
                    ?.lastCompletedStage ?? "unknown",
                ),
              ],
          remainingWork: ["resume_required"],
          failureClass: built.failureClass,
          recoveryAction: built.recoveryAction,
          artifactHash: blockedEvidenceInput?.finalText
            ? undefined
            : undefined,
        });
        // RUN-LIFECYCLE-P3：checkpoint 落盘后追加审计事件（先事件后聚合由 AuditRunSession fold）
        // 禁止把 checkpoint 写成 committed；resume 必须显式触发。
        input.auditSink?.recordLifecycleEvent?.({
          eventType: "checkpoint_saved",
          decisionReason: budgetForceCheckpoint
            ? "budget_exhausted"
            : built.reason,
          candidateId: blockedEvidenceInput?.candidateId ?? undefined,
          payload: {
            checkpointId: cp.checkpointId,
            stage,
            failureClass: built.failureClass,
            recoveryAction: built.recoveryAction,
            recoveryBudget: { ...recoveryBudget },
            interruptReason: budgetForceCheckpoint
              ? "budget_exhausted"
              : built.failureClass === "interrupted"
                ? "user_abort"
                : null,
            autoResume: false,
          },
        });
        stageResults.recoveryCheckpoint = {
          saved: true,
          checkpointId: cp.checkpointId,
          status: cp.status,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stageResults.recoveryCheckpoint = {
          saved: false,
          error: msg,
        };
        warnings.push(`recovery checkpoint 落盘失败：${msg}`);
      }
    }
    // ── QUALITY-3：hardBlock 路径跳过结构证据扫描，但写清 skipped reason ──
    // 任务规格 §6："hardBlock/raw 生成失败路径可跳过，但要写清 skipped reason"。
    // 无 finalText 可扫描，只记录 skipped reason 供 trace 审计。
    if (!stageResults.chapterQualityEvidence) {
      stageResults.chapterQualityEvidence = skippedChapterQualityEvidence(
        "",
        `hardBlock at stage=${stage}：${reason}（无 finalText 可扫描）`
      );
    }
    // ── QUALITY-8：hardBlock 路径跳过信息释放扫描，但写清 skipped reason ──
    // 任务规格 §5："hardBlock 路径写 skipped reason"。
    // 无 finalText 可扫描，只记录 skipped reason 供 trace 审计。
    if (!stageResults.informationReleaseEvidence) {
      stageResults.informationReleaseEvidence = skippedInformationReleaseEvidence(
        "",
        `hardBlock at stage=${stage}：${reason}（无 finalText 可扫描）`
      );
    }
    // ── QUALITY-9：hardBlock 路径跳过章末收束扫描，但写清 skipped reason ──
    // 任务规格 §接入边界："hardBlock 路径写 skipped reason"。
    // 无 finalText 可扫描，只记录 skipped reason 供 trace 审计。
    if (!stageResults.endingCraftEvidence) {
      stageResults.endingCraftEvidence = skippedEndingCraftEvidence(
        "",
        `hardBlock at stage=${stage}：${reason}（无 finalText 可扫描）`
      );
    }
    // ── QUALITY-10：hardBlock 路径也写 craftEvidenceEnvelope（标记 skipped/missing）──
    // 任务规格 §接入边界："hardBlock 路径也要有 envelope，但标记 skipped/missing reports"。
    // 三个 source 都已写为 skipped，envelope 自动识别为 skipped envelope。
    // hardBlock 路径不保留 envelope 的 advisory warning（failureEnvelope 已记录阻断原因）。
    runCraftEvidenceEnvelope("", "", stageResults, []);
    // ── QUALITY-15：hardBlock 路径写 skipped report（不伪造成功报告）──
    // 任务规格 §接入边界："hardBlock 路径可写 skipped report，或保持 undefined，
    // 但不得伪造成功报告"。此处写 skipped report 供 trace 审计，明确无可用证据。
    if (!stageResults.qualityEvidenceRunReport) {
      stageResults.qualityEvidenceRunReport = skippedQualityEvidenceRunReport(
        `hardBlock at stage=${stage}：${reason}（无 finalText，无可用证据）`
      );
    }

    // ── QUALITY-16：hardBlock 路径导出 skipped report（不伪造成功报告）──
    // 任务规格 §接入边界："hardBlock 路径若已有 skipped report，可以导出 skipped report；
    // 不得伪造成功报告"。skipped report 的 selectedSource="blocked"，明确无可用证据。
    // evalMode 下不写文件（与 chapterFilePath 一致），path=null + reason，行为可审计。
    if (!stage.startsWith("control_plane")) {
      exportQualityEvidenceReport(this, input, stageResults, warnings);
    } else {
      stageResults.qualityEvidenceReportPath = null;
      stageResults.qualityEvidenceReportExport = {
        exported: false,
        filePath: "",
        reason: `control plane blocked before artifact export: ${stage}`,
      };
    }

    // ── BLOCKED-CANDIDATE-EVIDENCE-1：hard-block raw 证据留存 ──
    // 派工计划 P0-A：blocked raw 保留完整 redacted 文本、SHA-256、长度、finishReason、诊断 span，
    // 写入 traces/{chapterId}-blocked-candidate-evidence.json。不保存章节、不提交状态。
    // 写入失败不得放行正文（hardBlock 已返回 blocked，此处仅 warning + 标记 blocked_evidence_unavailable）。
    this.saveBlockedCandidateEvidenceArtifact(
      input, stageResults, warnings, stage, reason, envelope, blockedEvidenceInput
    );

    // MA：若主链路已挂载协作状态，阻断出口也写入 agentCollaboration 摘要
    const collab = (stageResults as Record<string, unknown>)._agentCollabState as
      | CollaborationTraceState
      | undefined;
    if (collab) {
      recordSystemDecision(collab, {
        fromStage: stage,
        toStage: null,
        transition: "block",
        allowed: false,
        reason,
        priority: "permission_security",
        candidateId: blockedEvidenceInput?.candidateId ?? undefined,
      });
      attachCollaborationToStageResults(stageResults, collab);
      stageResults.agentLineageIndex = buildAgentLineageIndex({
        stageResults,
        orchestratorRunId: collab.orchestratorRunId,
        workspaceId: collab.workspaceId,
        chapterId: collab.chapterId,
      });
      delete (stageResults as Record<string, unknown>)._agentCollabState;
    }

    // WP-03..07：blocked 出口也挂载分层预算 / 失败策略 / 观测 / 质量-成本报告
    // （hardBlock 不经 finishWithCollab，必须在此显式 attach）
    const govStateBlocked =
      getGovernanceState(stageResults) ??
      createRoutingGovernanceState({
        runRouting: input.runRouting,
        recoveryBudget,
      });
    const blockedReports = buildGovernanceReports(govStateBlocked, {
      modelCalls: (stageResults.modelCalls as ModelCallEntry[] | undefined) ?? [],
      delivered: false,
      factGuardPassed: false,
      storyPreservationPassed: false,
      recoveryAssisted: govStateBlocked.layeredBudget.recovery.usedModelCalls > 0,
      lastFailureDecision: failureRecord.decision,
      lastFailureType: failureRecord.failureType,
    });
    attachGovernanceReports(stageResults, blockedReports);
    stageResults.recoveryBudget = govStateBlocked.layeredBudget.legacyRecovery;
    stageResults.recoveryBudgetSnapshot = budgetSnapshotForTrace(
      govStateBlocked.layeredBudget.legacyRecovery,
    );
    delete (stageResults as Record<string, unknown>)._routingGovernanceState;
    delete (stageResults as Record<string, unknown>)._lastFailureStrategyDecision;
    delete (stageResults as Record<string, unknown>)._lastFailureType;

    return {
      status: "blocked",
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      chapterNumber: input.chapterNumber,
      text: "",
      // P0-1 修复（Phase 1 整改）：blocked 路径不伪造 selectedSource。
      // 原先固定返回 "raw"，把未优化 Agentic 初稿伪装成可交付，与 rawRole="not_deliverable"
      // 冲突。修复后 blocked 时为 null（无交付来源）；仅 status="ok" 才标记 raw/editorial。
      selectedSource: null,
      selectedCandidateId: "",
      candidates: [],
      judgeResult: null,
      allArbitrationResults: [],
      hypotheses: [],
      warnings,
      failureEnvelope: envelope,
      stageResults,
      stateCommit: null,
      chapterFilePath: null,
      // INTENT-COMPLETENESS-1：hardBlock 路径也透传 under-specified 标记。
      // under_specified 阻断时 isUnderSpecified=true；其他阻断时按 intent 实际状态。
      isUnderSpecified: Boolean(
        input.intent?.underSpecifiedFields && input.intent.underSpecifiedFields.length > 0,
      ),
    };
  }

  /**
   * BLOCKED-CANDIDATE-EVIDENCE-1：构建并保存 hard-block raw 证据 artifact。
   *
   * - 无 rawText（raw_generation 空/异常）→ 不保存正文证据，记录 skipped reason。
   * - evalMode → 不写文件（与 chapterFilePath / qualityEvidenceReport 一致）。
   * - 写入失败 → warning + stageResults.blockedCandidateEvidence.reason="blocked_evidence_unavailable"，
   *   不抛异常，不绕过 hard block。
   * - artifact 明确 blocked/non-deliverable；不写 chapterFilePath / stateCommit。
   */
  private saveBlockedCandidateEvidenceArtifact(
    input: UnifiedOrchestratorInput,
    stageResults: Record<string, unknown>,
    warnings: string[],
    stage: string,
    reason: string,
    envelope: UnifiedFailureEnvelope,
    blockedEvidenceInput?: {
      rawText: string;
      rawFinishReason: string | null;
      rawMaxTokens: number | null;
      rawModel: string;
      modelVersion: string | null;
      factGuardErrors?: string[];
      completenessFindings?: Array<{
        reason: string;
        kind: string;
        anchor?: string;
        span?: { start: number; end: number };
      }>;
      // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR: final candidate hard-block 上下文
      candidateId?: string | null;
      selectedSource?: "raw" | "editorial" | null;
      finalText?: string | null;
    }
  ): void {
    if (!blockedEvidenceInput || !blockedEvidenceInput.rawText || blockedEvidenceInput.rawText.length === 0) {
      stageResults.blockedCandidateEvidence = {
        saved: false,
        artifactPath: null,
        reason: `no rawText at stage=${stage}（raw 未生成或为空，无正文证据可留存）`,
      };
      return;
    }
    if (input.evalMode) {
      stageResults.blockedCandidateEvidence = {
        saved: false,
        artifactPath: null,
        reason: `evalMode=${input.evalMode}（与 chapterFilePath 一致，不写文件）`,
      };
      return;
    }
    // FULL-PIPELINE-PREVIEW-1：预览模式不写 blocked-candidate-evidence 文件（与 chapterFilePath 一致，不写文件）。
    if (input.fullPipelinePreview) {
      stageResults.blockedCandidateEvidence = {
        saved: false,
        artifactPath: null,
        reason: "fullPipelinePreview=true（预览模式不写文件）",
      };
      return;
    }
    const tracesDir = join(input.projectRoot, "workspaces", input.workspaceId, "traces");
    const evidence = buildBlockedCandidateEvidence({
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      chapterNumber: input.chapterNumber,
      tracesDir,
      blockedStage: stage,
      blockedReason: reason,
      severity: stage === "raw_generation" ? "fatal" : "hard",
      rawText: blockedEvidenceInput.rawText,
      rawFinishReason: blockedEvidenceInput.rawFinishReason,
      rawMaxTokens: blockedEvidenceInput.rawMaxTokens,
      rawModel: blockedEvidenceInput.rawModel,
      modelVersion: blockedEvidenceInput.modelVersion,
      factGuardErrors: blockedEvidenceInput.factGuardErrors ?? [],
      completenessFindings: blockedEvidenceInput.completenessFindings,
      failureEnvelope: {
        stage: envelope.stage,
        severity: envelope.severity,
        reason: envelope.reason,
        recoverable: envelope.recoverable,
        degradedTo: envelope.degradedTo ?? "hard_block",
      },
      // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR: final candidate hard-block 上下文
      candidateId: blockedEvidenceInput.candidateId,
      selectedSource: blockedEvidenceInput.selectedSource,
      finalText: blockedEvidenceInput.finalText,
    });
    const saveRes = saveBlockedCandidateEvidence(evidence);
    if (saveRes.saved) {
      stageResults.blockedCandidateEvidence = {
        saved: true,
        artifactPath: saveRes.artifactPath,
        schemaId: evidence.schemaId,
        rawSha256: evidence.rawSha256,
        rawLength: evidence.rawLength,
        diagnosticSpanCount: evidence.diagnosticSpans.length,
        redactionLog: evidence.redactionLog,
        candidateId: evidence.candidateId,
        selectedSource: evidence.selectedSource,
        finalTextSha256: evidence.finalTextSha256,
        finalTextLength: evidence.finalTextLength,
      };
      return;
    }
    if (saveRes.reason === "frozen_evidence_protected") {
      // BLOCKED-CANDIDATE-EVIDENCE-FROZEN-PROTECTION-1：
      // 现存 evidence 被 HOLD 清单冻结，拒绝覆盖。改走 recovery 路径写入新 evidence，
      // 原始冻结文件保持不变（供 QuoteExemption 等 RED fixture 继续读取）。
      const recoveryRes = saveBlockedCandidateEvidenceToRecoveryPath(evidence);
      if (recoveryRes.saved) {
        warnings.push(
          `blocked candidate evidence 冻结保护触发（HOLD=${saveRes.holdManifestPath}，frozenSha256=${saveRes.frozenSha256.slice(0, 12)}...）；新 evidence 已写入 recovery 路径：${recoveryRes.artifactPath}`,
        );
        stageResults.blockedCandidateEvidence = {
          saved: true,
          artifactPath: recoveryRes.artifactPath,
          frozenProtection: {
            holdManifestPath: saveRes.holdManifestPath,
            frozenSha256: saveRes.frozenSha256,
            originalArtifactPath: evidence.artifactPath,
            recoveryArtifactPath: recoveryRes.artifactPath,
          },
          schemaId: evidence.schemaId,
          rawSha256: evidence.rawSha256,
          rawLength: evidence.rawLength,
          diagnosticSpanCount: evidence.diagnosticSpans.length,
          redactionLog: evidence.redactionLog,
          candidateId: evidence.candidateId,
          selectedSource: evidence.selectedSource,
          finalTextSha256: evidence.finalTextSha256,
          finalTextLength: evidence.finalTextLength,
        };
      } else {
        warnings.push(
          `blocked candidate evidence 冻结保护后 recovery 写入失败（不阻断，已保持 hard block）：${recoveryRes.error}`,
        );
        stageResults.blockedCandidateEvidence = {
          saved: false,
          artifactPath: evidence.artifactPath,
          reason: "frozen_evidence_protected_recovery_failed",
          error: recoveryRes.error,
          frozenProtection: {
            holdManifestPath: saveRes.holdManifestPath,
            frozenSha256: saveRes.frozenSha256,
            recoveryArtifactPath: saveRes.recoveryArtifactPath,
          },
        };
      }
      return;
    }
    warnings.push(
      `blocked candidate evidence 保存失败（不阻断，已保持 hard block）：${saveRes.error}`
    );
    stageResults.blockedCandidateEvidence = {
      saved: false,
      artifactPath: evidence.artifactPath,
      reason: saveRes.reason,
      error: saveRes.error,
    };
  }

  /**
   * WP-03..07：在成功出口挂载分层预算 / 观测 / 质量-成本报告。
   * hardBlock 与 finishWithCollab 各自调用对应路径；本 helper 供 deliverRaw / 主路径复用。
   */
  private attachRoutingGovernanceOnExit(
    input: UnifiedOrchestratorInput,
    stageResults: Record<string, unknown>,
    flags: {
      delivered: boolean;
      factGuardPassed?: boolean;
      storyPreservationPassed?: boolean;
    },
  ): void {
    if (stageResults.routingGovernance) return; // 已挂载则幂等
    const govState =
      getGovernanceState(stageResults) ??
      createRoutingGovernanceState({
        runRouting: input.runRouting,
        recoveryBudget: stageResults.recoveryBudget as RecoveryBudget | undefined,
      });
    const reports = buildGovernanceReports(govState, {
      modelCalls: (stageResults.modelCalls as ModelCallEntry[] | undefined) ?? [],
      delivered: flags.delivered,
      factGuardPassed: flags.factGuardPassed,
      storyPreservationPassed: flags.storyPreservationPassed,
      recoveryAssisted: govState.layeredBudget.recovery.usedModelCalls > 0,
      lastFailureDecision: stageResults._lastFailureStrategyDecision as
        | ReturnType<typeof recordFailureStrategy>["decision"]
        | undefined,
      lastFailureType: stageResults._lastFailureType as
        | import("./failure-strategy-matrix.js").FailureType
        | undefined,
    });
    attachGovernanceReports(stageResults, reports);
    stageResults.recoveryBudget = govState.layeredBudget.legacyRecovery;
    stageResults.recoveryBudgetSnapshot = budgetSnapshotForTrace(
      govState.layeredBudget.legacyRecovery,
    );
    // BG-01：交付/主路径出口落盘统一预算账本（wrapModelFn reserve/settle 的最终状态）
    const ledgerState = (stageResults as Record<string, unknown>)._budgetLedgerState as
      | BudgetLedger
      | undefined;
    if (ledgerState) {
      stageResults.budgetLedger = getBudgetLedger(ledgerState);
      delete (stageResults as Record<string, unknown>)._budgetLedgerState;
    }
    delete (stageResults as Record<string, unknown>)._routingGovernanceState;
    delete (stageResults as Record<string, unknown>)._lastFailureStrategyDecision;
    delete (stageResults as Record<string, unknown>)._lastFailureType;
  }

  authorizeCapability(
    controlPlane: TrustedControlPlane,
    trace: ControlPlaneTrace,
    capability: CapabilityName,
    reason: string,
  ): { allowed: boolean; consumed: boolean } {
    // AUTONOMY-P1：state.commit / chapter.save 的第二道模型身份守护。
    // 执行侧默认 actor=orchestrator；CapabilityPolicy 对 actor=model 永久 deny。
    if (capability === "state.commit" || capability === "chapter.save") {
      assertOrchestratorCommitActor({
        actor: "orchestrator",
        action: capability,
        taskId: controlPlane.packet.taskId,
        workspaceId: controlPlane.packet.taskId,
      });
    }
    const result = controlPlane.policy.authorize(capability, reason, {
      actor: "orchestrator",
      requestedLevel: capability === "state.commit" || capability === "chapter.save"
        ? "commit"
        : undefined,
      action: capability,
    });
    if (!result.allowed) {
      trace.denials.push(result.trace);
    }
    // 将控制决策挂到 controlTrace（P6 可观测）
    const decisions = (trace as ControlPlaneTrace & {
      controlDecisions?: unknown[];
    });
    if (!Array.isArray(decisions.controlDecisions)) {
      decisions.controlDecisions = [];
    }
    decisions.controlDecisions.push(result.trace);
    return { allowed: result.allowed, consumed: result.consumed };
  }

  private modelLockEvidence(expected: ModelLock, actual: ModelLock): Record<string, unknown> {
    const errors = validateModelLock(expected, actual);
    return {
      expectedRoute: expected.route,
      expectedProvider: expected.provider,
      expectedModel: expected.model,
      executionRoute: actual.route,
      executionProvider: actual.provider,
      executionModel: actual.model,
      matched: errors.length === 0,
      errors,
    };
  }

  // ==========================================================================
  // 候选构造
  // ==========================================================================

  private makeCandidate(
    id: string,
    text: string,
    kind: CandidateKind,
    route: string,
    input: UnifiedOrchestratorInput,
    generationMetadata?: { finishReason?: string; maxTokens?: number },
  ): Candidate {
    return {
      id,
      text,
      kind,
      model: "unified",
      route,
      contextHash: `hash-${input.chapterId}-${id}`,
      generatedAt: new Date().toISOString(),
      durationMs: 0,
      ...(generationMetadata?.finishReason !== undefined
        ? { finishReason: generationMetadata.finishReason }
        : {}),
      ...(generationMetadata?.maxTokens !== undefined
        ? { maxTokens: generationMetadata.maxTokens }
        : {}),
      promptProfile: {
        type: "editorial",
        tokensIn: 0,
        containsDialogueRatio: false,
        containsParagraphLengthConstraint: false,
        containsControlChecklist: false,
        containsMechanicalMetric: false,
        contractIds: [],
      },
    };
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createUnifiedOrchestrator(): UnifiedOrchestrator {
  return new UnifiedOrchestrator();
}

// ============================================================================
// P1 修复（NOVELOS-CONSTRAINT-RELAXATION-1）：作者风格优化人工审阅包
// ============================================================================

/**
 * 人工审阅包：永久保留 Agentic 初稿、风格优化稿及来源关系，供后续用户样本比对。
 *
 * 设计原则（任务规格 §六 P1）：
 * - trace 永久保留 Agentic 初稿、风格优化稿及来源关系
 * - 展示初稿/优化稿差异、事实复检结果和用户最终修改量
 * - 在获得用户样本前，不宣称整章风格优化稳定优于 Agentic 初稿
 *
 * P1 修复（审阅包回填）：
 * - 生成时 userModificationDelta=null 占位，由编排器写入 sidecar
 *   chapters/chapter-{N}/review-package.json
 * - 用户提交反馈（handleStrategyFeedback 提供 userFinalText+deliveredText+chapterId）
 *   时，由 backfillAuthorStyleReviewPackage 原子更新 sidecar 的 userModificationDelta
 * - positiveBenefitClaim 在累积足够用户样本前恒为 false（任务规格 §六 P1）
 */
export interface AuthorStyleHumanReviewPackage {
  /** 第 N 章 */
  chapterNumber: number;
  /** Agentic 初稿候选 ID */
  agenticCandidateId: string;
  /** 风格优化稿候选 ID（与 agentic 相同表示降级回退） */
  styledCandidateId: string;
  /** Agentic 初稿文本（永久保留，供用户样本比对） */
  agenticText: string;
  /** 风格优化稿文本（永久保留，供用户样本比对） */
  styledText: string;
  /** 来源关系：styledCandidateId 的源候选 */
  sourceRelation: "author_style_full_chapter" | "degraded_to_raw";
  /** 文本长度差异（正数=优化稿更长，负数=优化稿更短） */
  lengthDelta: number;
  /**
   * 用户最终修改量（生成时为 null，用户保存修改后由
   * backfillAuthorStyleReviewPackage 回填为 UserModificationDelta）。
   * 比对基准为最终交付文本（styledText 或 agenticText）。
   */
  userModificationDelta: import("../../v2/learning/user-modification-delta.js").UserModificationDelta | null;
  /**
   * 事实复检结果（来自 stage5_finalFactRecheck，生成时为 null，复检完成后回填）。
   */
  factRecheckResult: {
    ok: boolean;
    errors: string[];
  } | null;
  /**
   * 是否可宣称"整章风格优化稳定优于 Agentic 初稿"。
   * 在获得用户样本前恒为 false（任务规格 §六 P1 明确要求）。
   */
  positiveBenefitClaim: false;
  /** 备注：解释为何不能宣称正收益 */
  positiveBenefitClaimReason: string;
  /**
   * P1 修复：sidecar 持久化时间戳（ISO），用于审计回填时序。
   * 生成时由 persistAuthorStyleReviewPackage 写入；回填时更新。
   */
  persistedAt?: string;
  /**
   * P1 修复：用户反馈回填时间戳（ISO），null 表示尚未收到用户反馈。
   */
  backfilledAt?: string | null;
}

/**
 * 构造人工审阅包。在用户样本回流前，positiveBenefitClaim 恒为 false。
 */
function buildAuthorStyleHumanReviewPackage(
  agenticCandidate: { id: string; text: string },
  styledCandidate: { id: string; text: string },
  chapterNumber: number,
): AuthorStyleHumanReviewPackage {
  const isDegraded = agenticCandidate.id === styledCandidate.id;
  return {
    chapterNumber,
    agenticCandidateId: agenticCandidate.id,
    styledCandidateId: styledCandidate.id,
    agenticText: agenticCandidate.text,
    styledText: styledCandidate.text,
    sourceRelation: isDegraded ? "degraded_to_raw" : "author_style_full_chapter",
    lengthDelta: styledCandidate.text.length - agenticCandidate.text.length,
    userModificationDelta: null,
    factRecheckResult: null,
    positiveBenefitClaim: false,
    positiveBenefitClaimReason:
      "在获得用户实际修改样本前，不宣称整章风格优化稳定优于 NovelOS Agentic 初稿（NOVELOS-CONSTRAINT-RELAXATION-1 §六 P1）",
    backfilledAt: null,
  };
}

// ============================================================================
// P1 修复（审阅包回填）：sidecar 持久化与回填
// ============================================================================

/**
 * sidecar 文件路径：workspaces/{workspaceId}/chapters/{chapterId}.review-package.json
 *
 * 与章节正文 {chapterId}.md 同目录，无需创建子目录（atomicSave 自动 mkdir）。
 * 独立于 quality-trace.json：trace 是不可变审计证据，sidecar 承载可回填的审阅包。
 */
function reviewPackageFilePath(
  projectRoot: string,
  workspaceId: string,
  chapterId: string,
): string {
  // 与 chapterFilePath 同构（orchestrator-commit-save.ts:485），保持路径一致性
  return join(
    projectRoot,
    "workspaces",
    workspaceId,
    "chapters",
    `${chapterId}.review-package.json`,
  );
}

/**
 * 持久化人工审阅包到 sidecar（原子写入 tmp→rename）。
 *
 * 由编排器在 buildAuthorStyleHumanReviewPackage 后调用：
 * - 写入完整 package（含 userModificationDelta=null 占位 + factRecheckResult）
 * - 戳记 persistedAt（ISO），便于后续回填时审计时序
 * - 写入失败不阻断生成（与 trace 持久化一致的容错策略）
 *
 * 预览/eval 模式不调用此函数（与 chapterFilePath=null 一致，不写副作用）。
 */
export function persistAuthorStyleReviewPackage(
  projectRoot: string,
  workspaceId: string,
  chapterId: string,
  pkg: AuthorStyleHumanReviewPackage,
): string | null {
  const filePath = reviewPackageFilePath(projectRoot, workspaceId, chapterId);
  try {
    const stamped: AuthorStyleHumanReviewPackage = {
      ...pkg,
      persistedAt: new Date().toISOString(),
    };
    atomicSave(filePath, JSON.stringify(stamped, null, 2));
    return filePath;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[Unified] 审阅包 sidecar 持久化失败（不阻断生成）：${msg}\n`,
    );
    return null;
  }
}

/**
 * 回填用户修改差分到已持久化的审阅包 sidecar。
 *
 * 由 handleStrategyFeedback 调用（用户提供 userFinalText + deliveredText + chapterId 时）：
 * - 读取 sidecar（不存在则返回 not_found）
 * - 更新 userModificationDelta 字段为计算后的 delta
 * - 戳记 backfilledAt（ISO），保留原 persistedAt 不变
 * - positiveBenefitClaim 保持 false（累积足够样本前不宣称正收益）
 * - 原子写入（tmp→rename），失败返回 error
 *
 * @returns backfill 结果：ok/not_found/error + 更新后的 package（ok 时）
 */
export function backfillAuthorStyleReviewPackage(input: {
  projectRoot: string;
  workspaceId: string;
  chapterId: string;
  delta: import("../../v2/learning/user-modification-delta.js").UserModificationDelta;
}): {
  status: "ok" | "not_found" | "error";
  reason: string;
  reviewPackage?: AuthorStyleHumanReviewPackage;
  filePath?: string;
} {
  const filePath = reviewPackageFilePath(
    input.projectRoot,
    input.workspaceId,
    input.chapterId,
  );
  if (!existsSync(filePath)) {
    return {
      status: "not_found",
      reason: `审阅包 sidecar 不存在：${filePath}（章节可能未走统一主链路生成，或预览模式未持久化）`,
    };
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const existing = JSON.parse(raw) as AuthorStyleHumanReviewPackage;
    const updated: AuthorStyleHumanReviewPackage = {
      ...existing,
      userModificationDelta: input.delta,
      backfilledAt: new Date().toISOString(),
      // positiveBenefitClaim 保持 false（任务规格 §六 P1：累积样本前不宣称正收益）
    };
    atomicSave(filePath, JSON.stringify(updated, null, 2));
    return {
      status: "ok",
      reason: `审阅包 userModificationDelta 已回填（editDistance=${input.delta.editDistance.toFixed(3)}, modified=${input.delta.modified}）`,
      reviewPackage: updated,
      filePath,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "error",
      reason: `审阅包回填失败：${msg}`,
    };
  }
}

// ============================================================================
// P0-4 修复（NOVELOS-CONSTRAINT-RELAXATION-1）：阻断恢复建议归类
// ============================================================================

/**
 * agentic 候选验证阻断时未解决 finding 的最小结构（与
 * AgenticRawSourceResult.unresolvedFindings 同构，本模块只消费这几个字段）。
 */
interface UnresolvedAgenticFinding {
  id: string;
  failureType: string;
  sourceRef: string;
  description: string;
  conflictFact: string;
  certainty?: "deterministic" | "corroborated" | "heuristic";
  coverageStatus?: "covered" | "uncertain" | "missing";
}

/**
 * 把 NovelOS Agentic 验证阻断的未解决 finding 归类到三类恢复路径：
 *
 * - `system_verifier_uncertain`：heuristic finding 误入 hard 或 coverageStatus=
 *   uncertain。verifier 不确定或疑似误报，恢复责任归系统，不提示用户简化章纲。
 * - `author_input_conflict`：ChapterSeed/章纲本身存在自相矛盾或不可执行要求
 *   （如 inviolableFacts 内部互相排斥、ChapterSeed 要求与已确立 canon 直接冲突）。
 *   **当前 verifier 未产出此类 finding**（所有 fact_contradiction/canon_violation
 *   都是模型正文与 canon 冲突，属模型错误而非作者输入错误）。此分支保留为未来
 *   新增作者侧矛盾检测的扩展点。
 * - `confirmed_content_omission`：deterministic/corroborated 的真实内容遗漏或冲突
 *   （verbatim 缺失、必需事实遗漏、事件锚点整体缺失、fact_contradiction、
 *   canon_violation、inviolable_fact_conflict）。系统应重新生成或 patch，
 *   不要求用户改章纲。
 *
 * P1-3 修复（NOVELOS-CONSTRAINT-RELAXATION-1 验收修复）：
 * 之前把 fact_contradiction / canon_violation / inviolable_fact_conflict 归为
 * author_input_conflict，要求用户修订 ChapterSeed。这是错误的：这些 finding 表示
 * **模型生成的正文与 canon 事实冲突**（如 canon 说面罩是蓝色，模型写成红色），
 * 是模型正文错误，应归为 confirmed_content_omission，由系统重写或 patch，
 * 不要求用户改 ChapterSeed。
 *
 * 归类优先级：author_input_conflict > system_verifier_uncertain >
 * confirmed_content_omission。
 */
export function classifyAgenticVerificationBlock(
  unresolvedFindings: UnresolvedAgenticFinding[],
  chapterNumber: number,
): Pick<
  UnifiedFailureEnvelope,
  | "recoverable"
  | "candidateDisposition"
  | "userActionRequired"
  | "prohibitedActions"
  | "retryPlan"
  | "blockCategory"
> {
  // 禁止动作与候选处置对所有归类一致：阻断候选不可交付、不可保存、不可跳章
  const prohibitedActions: UnifiedFailureEnvelope["prohibitedActions"] = [
    "accept_or_deliver_blocked_candidate",
    "save_blocked_candidate_as_chapter",
    "skip_to_next_chapter",
  ];
  const candidateDisposition = "blocked_evidence_only" as const;
  const retryPlan = {
    strategy: "revise_inputs_and_retry_same_chapter" as const,
    maxAttempts: 1,
  };

  // 共享诊断提示：始终告知调用方查看 trace 与未解决 finding
  const diagnosticHint =
    `查看 stageResults.novelos.unresolvedFindings 与 trajectoryPath，确认第 ${chapterNumber} 章仍未满足的约束`;

  // 1. 检测 author_input_conflict：作者输入自相矛盾（ChapterSeed/章纲本身不可执行）
  //    inc-4 修复：verifier 现在产出 failureType="author_input_conflict" finding，
  //    检测 inviolableFacts 内部互斥（如"X在场"与"X不在场"同时出现）。
  //    sourceRef 指向 chapter-seed:inviolableFacts[...]，证明是作者输入侧矛盾。
  //    这类矛盾无法通过模型重写解决，必须用户修订 ChapterSeed。
  const authorConflictFindings = unresolvedFindings.filter((finding) => {
    if (finding.failureType === "author_input_conflict") return true;
    // 兼容：sourceRef 指向 chapter-seed:inviolableFacts 的也归入此类别
    if (finding.sourceRef?.includes("chapter-seed:inviolableFacts")) return true;
    return false;
  });
  if (authorConflictFindings.length > 0) {
    return {
      recoverable: true,
      candidateDisposition,
      blockCategory: "author_input_conflict",
      userActionRequired: [
        diagnosticHint,
        `第 ${chapterNumber} 章的 ChapterSeed 或作者章纲存在真实矛盾或不可执行要求：${authorConflictFindings.map((f) => f.conflictFact).join("；")}`,
        `修订第 ${chapterNumber} 章输入，解决冲突后通过 novel_generate_chapter 重试；verifier 清零前不得生成第 ${chapterNumber + 1} 章`,
      ],
      prohibitedActions,
      retryPlan,
    };
  }

  // 2. 检测 system_verifier_uncertain：heuristic 误入 hard 或 coverageStatus=uncertain
  //    这类 finding 不应触发整章阻断，恢复责任归系统，不要求用户改章纲
  const uncertainFindings = unresolvedFindings.filter((finding) => {
    if (finding.certainty === "heuristic") return true;
    if (finding.coverageStatus === "uncertain") return true;
    return false;
  });
  if (uncertainFindings.length > 0) {
    return {
      recoverable: true,
      candidateDisposition,
      blockCategory: "system_verifier_uncertain",
      userActionRequired: [
        diagnosticHint,
        `第 ${chapterNumber} 章 verifier 存在不确定或疑似误报的 finding（heuristic / uncertain）；恢复责任归系统，无需用户修订章纲`,
        `系统可通过 novel_generate_chapter 重试当前第 ${chapterNumber} 章；若反复阻断，请把 trajectoryPath 上报用于 verifier 调优；verifier 清零前不得生成第 ${chapterNumber + 1} 章`,
      ],
      prohibitedActions,
      retryPlan,
    };
  }

  // 3. 其余归到 confirmed_content_omission：deterministic/corroborated 的真实遗漏或冲突
  //    P1-3 修复：fact_contradiction / canon_violation / inviolable_fact_conflict
  //    现在归入此类别（模型正文错误，系统应重写或 patch，不要求用户改 ChapterSeed）
  return {
    recoverable: true,
    candidateDisposition,
    blockCategory: "confirmed_content_omission",
    userActionRequired: [
      diagnosticHint,
      `第 ${chapterNumber} 章候选正文存在确定性遗漏或冲突（deterministic / corroborated，含 fact_contradiction / canon_violation）；系统应重新生成或局部 patch，无需用户修订章纲`,
      `通过 novel_generate_chapter 重试当前第 ${chapterNumber} 章；verifier 清零前不得生成第 ${chapterNumber + 1} 章`,
    ],
    prohibitedActions,
    retryPlan,
  };
}

// ============================================================================
// P1-3 修复：超时识别辅助
// ============================================================================

/**
 * P1-3 修复（NOVELOS-CONSTRAINT-RELAXATION-1 验收修复）：
 * 用于在 source 未设置 failureKind 时，从 failureReason / stopReason 字符串
 * 回退识别超时/连接异常。
 *
 * 与 agentic-raw-candidate-source.ts 中的 TIMEOUT_PATTERNS 保持同步，
 * 确保编排器 catch 分支（generate 抛异常）和 candidate=null 分支
 * （source 内部捕获）使用一致的超时识别口径。
 *
 * 同一函数也供 catch 分支（line ~768）使用，避免两处分别维护模式列表。
 */
const TIMEOUT_REASON_PATTERNS = [
  "timeout",
  "timed out",
  "超时",
  "aborted",
  "etimedout",
  "econnreset",
];

/**
 * P1-3 修复：从 reason 字符串识别是否为模型超时/连接异常。
 *
 * @returns "model_timeout" 若命中任一超时模式；否则 "unknown"。
 */
function classifyTimeoutFromReason(reason: string): "model_timeout" | "unknown" {
  const lower = reason.toLowerCase();
  for (const pattern of TIMEOUT_REASON_PATTERNS) {
    if (lower.includes(pattern)) {
      return "model_timeout";
    }
  }
  return "unknown";
}
