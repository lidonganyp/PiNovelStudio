/**
 * UnifiedOrchestrator — 统一主链路编排器（Phase 5，计划 §3 + §Phase 5）
 *
 * 单一生成主链路：raw → editorial → judge → select → commit
 *
 * 设计原则（计划 §Phase 5）：
 * - 无 whitelist：所有 workspace/chapter 走统一入口
 * - 无 generationMode：不再有 legacy/v2 双模式切换
 * - 无 v2NotImplemented → legacy 回退：V2 内部失败按 raw → hard block 降级
 * - raw 有效但编辑/裁判失败时交付 raw 并记录 warning
 * - raw 失败结构化阻断（hard block），不静默回退 legacy
 * - 最终正文选定后统一执行状态提交和原子保存
 *
 * 降级链（计划 §Phase 5）：
 *   editorial_success → raw（编辑胜出则交付 editorial）
 *   editorial_fail/judge_fail → raw + warning（raw 有效则交付 raw）
 *   raw_fail → hard_block（raw 无效则结构化阻断）
 *
 * 替换关系（计划 §Phase 4 + §Phase 5）：
 * - 旧 CandidateComparator（机械总分 winner）→ 不再使用
 * - 旧 FinalSelector（机械总分选择）→ 由 JudgeArbitrator + SelectionPolicy 取代
 * - 旧 v2-orchestrator 降级链（→ legacy）→ 改为 raw → hard block
 *
 * context/intent/constitution 由调用方构建传入；编排器只额外读取紧凑、只读的
 * MethodologyDiagnosticState，且该状态只能进入 raw 后诊断，不能进入 raw prompt。
 */

import { writeFileSync, mkdirSync, renameSync, existsSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "node:crypto";
import type {
  Candidate,
  CandidateKind,
  CompiledContext,
  ConstitutionSnapshot,
} from "./types.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { ModelGenerateFn, ModelGenerateInput } from "../adapters/legacy-model-route-adapter.js";
import { createEditorialOpportunityJudge } from "./editorial-opportunity-judge.js";
import { createLanguageRiskLibrary } from "./language-risk-library.js";
import type { EditorialHypothesis } from "./editorial-hypothesis.js";
import {
  createEditorialCandidateGenerator,
} from "./editorial-candidate-generator.js";
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
import type { AgenticRawCandidateSource } from "../../novelos/agent/agentic-raw-candidate-source.js";
// Step 1d 修复：导入 AGENTIC_RAW_KIND 共享常量，SOFT 预算过滤器用此 kind
// 排除 agentic 调用（与路由名 AGENTIC_RAW_ROUTE="novelos_agentic" 区分，二者不可混用）。
import { AGENTIC_RAW_KIND } from "../../novelos/agent/agentic-raw-candidate-source.js";
import type { ContextSafetyResult } from "./context-safety.js";
import { createMethodologyDiagnosticStateLoader } from "./methodology-diagnostic-state.js";
import {
  buildTrustedControlPlane,
  validateModelLock,
  validateNovelTaskPacket,
  type CapabilityName,
  type ModelLock,
  type TrustedControlPlane,
} from "./control-plane.js";

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
} from "./orchestrator-types.js";
// 公共类型 re-export：保留 unified-orchestrator.js 原有导出面（unified-entry / legacy-trace-adapter 等消费）
export type {
  ModelCallEntry,
  UnifiedOrchestratorInput,
  UnifiedOrchestratorOutput,
  UnifiedFailureEnvelope,
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
    };
    stageResults.controlPlane = controlTrace;
    if (input.contextSafety) {
      stageResults.contextBudgetReport = input.contextSafety.report;
      if (!input.contextSafety.ok) {
        return this.hardBlock(input, "context_safety", `上下文安全阻断：${input.contextSafety.blockReason}`, stageResults);
      }
    }
    if (input.context.longTermState?.retrievalReport) {
      stageResults.contextRetrievalReport = input.context.longTermState.retrievalReport;
      stageResults.contextRetrievalPromptItems = input.context.longTermState.promptItems ?? [];
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
        // Step 1d 修复：硬上限每次调用前检查。所有 LLM 调用都经 wrapModelFn，
        // 此处是唯一能拦截 arbitrate 内部多轮（首轮+反向+仲裁）穿透 HARD 的位置。
        if (modelCallLog.length >= HARD) {
          modelBudget.capped = true;
          throw new Error(`模型调用达硬上限（${modelCallLog.length}/${HARD}），拒绝本次调用`);
        }
        try {
          const output = await fn(genInput);
          modelCallLog.push({
            route: output.route ?? genInput.route,
            kind: genInput.kind ?? fnKind,
            model: output.model ?? "unknown",
            durationMs: output.durationMs ?? Date.now() - start,
            ts: start,
            ...(output.finishReason !== undefined ? { finishReason: output.finishReason } : {}),
            ...(output.maxTokens !== undefined ? { maxTokens: output.maxTokens } : {}),
            tokenUsage: "unknown",
            // REAL-QUALITY-1-PREFLIGHT：透传 provider/requestedRoute 证据（计划 §trace）。
            // 未锁定时 output.provider/requestedRoute 可省略，modelCallLog 字段为 undefined（向后兼容）。
            provider: output.provider,
            requestedRoute: output.requestedRoute,
            expectedProvider: expectedLock.provider,
            expectedModel: expectedLock.model,
            actualProvider: output.provider,
            actualModel: output.model,
            ...(genInput.promptProfile ? { promptProfile: genInput.promptProfile as ModelCallEntry["promptProfile"] } : {}),
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
          modelCallLog.push({
            route: genInput.route ?? "unknown",
            kind: genInput.kind ?? fnKind,
            durationMs: Date.now() - start,
            ts: start,
            tokenUsage: "unknown",
            failed: true,
            requestedRoute: failRequestedRoute,
            expectedProvider: expectedLock.provider,
            expectedModel: expectedLock.model,
            failurePhase: capability,
            errorClass: e instanceof Error ? e.constructor.name : typeof e,
            ...(genInput.promptProfile ? { promptProfile: genInput.promptProfile as ModelCallEntry["promptProfile"] } : {}),
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
    const timeAsync = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const start = Date.now();
      try { return await fn(); }
      finally { stageTiming[name] = Date.now() - start; }
    };
    const timeSync = <T>(name: string, fn: () => T): T => {
      const start = Date.now();
      try { return fn(); }
      finally { stageTiming[name] = Date.now() - start; }
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
          })
        );
        agenticCandidate = agenticResult.candidate;
        stageResults.evalAgentic = {
          sessionId: agenticResult.sessionId,
          trajectoryPath: agenticResult.trajectoryPath,
          candidateId: agenticCandidate?.id ?? null,
          candidateLength: agenticCandidate?.text.length ?? 0,
          stopReason: agenticResult.stopReason,
          failureReason: agenticResult.failureReason ?? null,
          toolCalls: agenticResult.toolCalls,
          verifierCleared: agenticResult.verifierCleared,
          repairRounds: agenticResult.repairRounds,
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
      commitOutcome = timeSync("stage7_commitAndSave", () =>
        commitAndSave(
          input, selectedCandidateId, finalText, stageResults
        )
      );
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
      chapterFilePath: (input.evalMode || input.fullPipelinePreview || proxyApprovalOutcome.shouldSkipCommit)
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
      commitOutcome = commitAndSave(
        input, rawCandidate.id, rawCandidate.text, stageResults
      );
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
      chapterFilePath: (input.evalMode || input.fullPipelinePreview) ? null : chapterFilePath(input),
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
    }
  ): UnifiedOrchestratorOutput {
    // hardBlock 不接收调用方 warnings（阻断路径独立维护局部 warnings，
    // 仅供 QUALITY-16 导出失败等局部 warning 使用，不与主链路 warnings 合并）。
    const warnings: string[] = [];
    const envelope: UnifiedFailureEnvelope = {
      stage,
      severity: stage === "raw_generation" ? "fatal" : "hard",
      reason,
      recoverable: false,
      degradedTo: "hard_block",
    };
    stageResults.failureEnvelope = envelope;
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

    return {
      status: "blocked",
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      chapterNumber: input.chapterNumber,
      text: "",
      selectedSource: "raw",
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

  authorizeCapability(
    controlPlane: TrustedControlPlane,
    trace: ControlPlaneTrace,
    capability: CapabilityName,
    reason: string,
  ): { allowed: boolean; consumed: boolean } {
    const result = controlPlane.policy.authorize(capability, reason);
    if (!result.allowed) {
      trace.denials.push(result.trace);
    }
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
