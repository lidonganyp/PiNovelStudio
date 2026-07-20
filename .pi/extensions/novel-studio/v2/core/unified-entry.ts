/**
 * UnifiedEntry — 统一主链路入口（Phase 5，计划 §Phase 5）
 *
 * 这是 novel_generate_chapter 的默认入口。桥接 workspace 加载与统一编排器：
 *   加载 workspace（ContextCompiler，含 constitution + longTermState 快照）
 *   → 构建 ChapterIntent（ChapterIntentBuilder）
 *   → 设置 ModelGenerateFn（legacy fallback-manager 或 stub）
 *   → 调用 UnifiedOrchestrator.orchestrate
 *   → 映射为 legacy 兼容的 V2Output 形状返回
 *
 * 设计原则（计划 §Phase 5）：
 * - 无 whitelist：所有 workspace/chapter 走此入口
 * - 无 generationMode：不再有 legacy/v2 双模式切换
 * - 无 v2NotImplemented → legacy 回退：失败由编排器内部降级（raw → hard block）
 * - 返回形状对齐 V2Output，使 legacy handleGenerateChapter 可统一处理
 *
 * Phase 7 起 PINOVEL_UNIFIED_PIPELINE 环境变量已从生产路径移除，
 *   novel_generate_chapter 始终调用本入口，无回滚分支。
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import type {
  Candidate,
  CandidateComparison,
  CompiledContext,
  Diagnostic,
  FinalSelectionReport,
  FinalSelectedSource,
  ProjectGain,
  V2Input,
  V2Output,
} from "./types.js";
import { createContextCompiler } from "./context-compiler.js";
import { createChapterIntentBuilder } from "./chapter-intent-builder.js";
import type { ChapterIntent, ChapterIntentInput } from "./chapter-intent-builder.js";
import { UnifiedOrchestrator, type UnifiedOrchestratorOutput, type ModelCallEntry } from "./unified-orchestrator.js";
import type { ArbitratorResult } from "./judge-arbitrator.js";
import { loadCreativeConstitution } from "./creative-constitution.js";
import { loadStateStore, type StagedStateUpdate, type NarrativeStateEntry } from "./final-state-commit.js";
import type { ChapterSeed } from "../../craft/chapter-seed-types.js";
import {
  createLegacyModelGenerateFn,
  createStubModelGenerateFn,
  type ModelGenerateFn,
  type ModelGenerateInput,
} from "../adapters/legacy-model-route-adapter.js";
import {
  createLegacyTraceAdapter,
  deriveContextHashFromCompiled,
  type V2TraceRecord,
  type JudgeEvidenceTrace,
  type JudgeRoundTrace,
} from "../adapters/legacy-trace-adapter.js";
import {
  loadStrategyPolicyStore,
  saveStrategyPolicyStore,
} from "../learning/strategy-policy-store.js";
import { createContextualStrategySelector } from "../learning/contextual-strategy-selector.js";
import { createStrategyOutcomeRecorder } from "../learning/strategy-outcome-recorder.js";
// Step 5：NovelOS agentic_raw 候选源（shadow 模式，PINOVEL_NOVELOS_SHADOW=1 时启用）
import { createAgenticRawCandidateSource } from "../../novelos/agent/agentic-raw-candidate-source.js";
import {
  buildTrustedControlPlane,
  type CapabilityName,
  type TrustedControlPlane,
} from "./control-plane.js";
import { compileContextSafety, createConstraintManifest } from "./context-safety.js";
// EVOLUTION-RELEASE-GOVERNANCE-G6：生产入口发行治理门禁
// 真相源：docs/evolution-release-governance-development-plan.md §Phase G6
// 在 ContextCompiler 之前执行；未审批 release / fingerprint 不匹配 / 无 active pointer 时 hard block。
// PINOVEL_DEV_MODE=1 时 bypass（非生产开发模式）；evalMode 在上方已 bypass（不进入此处）。
import { evaluateProductionReleaseGate } from "../governance/production-release-gate.js";

function loadOntologyLevels(workspaceId: string, projectRoot: string): string[] {
  try {
    const configPath = join(projectRoot, "workspaces", workspaceId, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      worldKeyTerms?: { levels?: unknown };
    };
    return Array.isArray(config.worldKeyTerms?.levels)
      ? config.worldKeyTerms.levels.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

// ============================================================================
// Lab-only Eval 输入（NB-4 Generation Matrix 用，冻结计划 §8.1）
// ============================================================================

/**
 * NB-4 Generation Matrix 的 lab-only eval 参数。
 *
 * 当 evalMode 非 undefined 时，runUnifiedPipeline 跳过 ContextCompiler /
 * ChapterIntentBuilder / legacy modelGenerate 构造，改用调用方传入的
 * evalIntent / evalContext / evalModelGenerate，并按 evalMode 构造
 * agenticCandidateSource（B2/B3/B4 启用 agentic，按层控制检索/验证能力）。
 *
 * 冻结计划 §8.1 层级定义：
 * - B0 PureModel：用户最小任务 + 基础作品资料，一次模型调用
 * - B1 CompiledContext：B0 + ContextCompiler 静态上下文
 * - B2 AgenticRetrieval：B1 + EvidencePlan + 按需 NarrativeTools
 * - B3 VerifiedAgenticRaw：B2 + NarrativeVerifierSuite + bounded local revision
 * - B4 EditorialSelection：B3 + opportunity-driven editorial candidates + pairwise selection
 *
 * 这些参数仅供 lab-only eval 使用，生产路径不设置（undefined）。
 * 类型引用生产模块（ChapterIntent / CompiledContext / ModelGenerateFn），无 lab-only 依赖。
 */
export interface UnifiedPipelineEvalInput {
  /** Eval mode（NB-4 Generation Matrix 用）；undefined = 正常生产模式 */
  evalMode?: "B0" | "B1" | "B2" | "B3" | "B4";
  /** Eval prefix（前文，续写评估用）：作为 raw prompt 的"【前文】"段 */
  evalPrefix?: string;
  /** Eval intent（跳过 ChapterIntentBuilder）；B0/B1 用空 intent，B2/B3/B4 用完整 intent */
  evalIntent?: ChapterIntent;
  /** Eval context（跳过 ContextCompiler）；B0 用空 context，B1/B2/B3/B4 用含 worldRules 的 context */
  evalContext?: CompiledContext;
  /** Eval modelGenerate（跳过 legacy modelGenerate 构造）；eval 必须传入以控制路由 */
  evalModelGenerate?: ModelGenerateFn;
  /** Eval 异构仲裁 modelGenerate（B4 judge 用）；不传则复用 evalModelGenerate */
  evalArbitratorModelGenerate?: ModelGenerateFn;
  /**
   * Eval 已知角色名（DEMO-3-R2.4 新增）。
   * 传入 StoryPreservationGate 的 knownEntities，使 R2.2 门禁能在真实管线内执行。
   * 不传时为空数组（门禁返回 unverifiable）。
   */
  evalCharacterNames?: string[];
}

// ============================================================================
// REAL-QUALITY-1-PREFLIGHT：单次路由锁定（modelTestRoute → nb4_*_glm）
// ============================================================================

/**
 * modelTestRoute → GLM 路由锁映射（REAL-QUALITY-1-PREFLIGHT）。
 *
 * 让正常 novel_generate_chapter 完整主链路可按单次参数锁定 GLM5.2：
 * raw → opportunity judge → editorial candidate → pairwise judge → select。
 * 不通过关闭 editorial/judge 或使用 evalMode 规避完整链路。
 *
 * 冻结约束：
 * - modelTestRoute="glm" 时，生成调用走 nb4_generate_glm，判断调用走 nb4_judge_glm。
 *   两条路由在 config/model-routing.json 中 fallback=[]，禁止任何
 *   GPT/Claude/Doubao/ERNIE fallback（项目约束：临时/批量测试仅允许 GLM/Doubao）。
 * - 候选语义 route 仍保持 v2_rawstage2 / v2_amplified（由 wrapModelGenerateLockedToRoute
 *   保持 output.route 不变，仅覆盖底层调用 route），不破坏选择、trace 和报告契约。
 * - 不改 prompt/winner/finalText/候选数量/文学判断规则。
 *
 * @returns 锁定映射（generateRoute/judgeRoute）；非 "glm" 返回 null（不锁定，走默认路由）
 */
export function resolveModelTestRouteLock(
  modelTestRoute: string | undefined,
): { generateRoute: string; judgeRoute: string } | null {
  if (modelTestRoute === "glm") {
    return {
      generateRoute: "nb4_generate_glm",
      judgeRoute: "nb4_judge_glm",
    };
  }
  return null;
}

/**
 * 把 modelGenerate 锁定到 forcedRoute（REAL-QUALITY-1-PREFLIGHT）。
 *
 * 关键设计（保持候选语义 route 契约 + 失败时仍记录锁定目标）：
 * - 底层调用时 input.route 被覆盖为 forcedRoute（如 nb4_generate_glm），
 *   使 createLegacyModelGenerateFn → callWithFallback(forcedRoute) 走 GLM provider，
 *   fallback=[] 保证不回退 GPT/Claude/Doubao/ERNIE。
 * - input.requestedRoute 也设为 forcedRoute，使 orchestrate 的 wrapModelFn 在
 *   **调用失败时**（catch 路径拿不到 output）仍能读到"锁定目标路由"，
 *   配合 deriveProviderFromRoute 推导出 provider=glm（总控要求"失败 modelCalls
 *   也记录 requestedRoute/provider，至少记录锁定目标 provider=glm"）。
 * - 返回的 output.route 被改回原始 input.route（如 v2_rawstage2/v2_amplified），
 *   使 candidate.route（= output.route，由 editorial-candidate-generator 填入）
 *   与 final-selector 的语义映射保持不变，不破坏选择/trace/报告契约。
 * - output.requestedRoute 设为 forcedRoute，由 orchestrate 的 wrapModelFn 透传到
 *   modelCallLog.requestedRoute（成功路径），提供"实际请求路由"证据（计划 §trace requestedRoute）。
 * - output.provider/model 由底层 fn 透传（stub 推导 / legacy 从 usedProvider/usedModel 读取）。
 *
 * 与 eval-pipeline-adapter.wrapModelGenerateWithRoute 的区别：
 * 后者不保留 output.route 语义（eval benchmark 不关心 candidate.route 契约）；
 * 本函数为生产路径设计，必须保留语义 route 以不破坏 final-selector。
 */
export function wrapModelGenerateLockedToRoute(
  modelGenerate: ModelGenerateFn,
  forcedRoute: string,
): ModelGenerateFn {
  return async (input: ModelGenerateInput) => {
    // REAL-QUALITY-1-PREFLIGHT：mutate 外部 input 的 requestedRoute，让 wrapModelFn
    // 的 catch 路径在底层调用抛错时也能读到"锁定目标路由"（forcedRoute）。
    //
    // 关键设计：orchestrator 的 wrapModelFn 拿到的 genInput 就是这个 input 引用，
    // 失败时 catch 块读 `genInput.requestedRoute ?? genInput.route` 推导 provider。
    // 若只在内层 spread 设 requestedRoute（不 mutate 外部 input），catch 拿不到
    // output 时只能读 genInput.route（语义 route，如 v2_rawstage2），推导出 provider="stub"
    // 而非 "glm"，违反"失败 modelCalls 也记录锁定目标 provider=glm"约束。
    //
    // mutate 是 bounded 副作用：本函数返回的 fn 由 orchestrator wrapModelFn 单独持有，
    // 调用生命周期内 genInput 不会被其他路径读取；语义上 requestedRoute 本就是
    // "实际请求路由"的真相，与 forcedRoute 一致是正确状态。
    input.requestedRoute = forcedRoute;
    const output = await modelGenerate({
      ...input,
      route: forcedRoute,
    });
    return {
      ...output,
      // 保持候选语义 route 不变（v2_rawstage2/v2_amplified），仅实际调用走 forcedRoute
      route: input.route,
      // 记录实际请求路由，供 modelCallLog.requestedRoute 证据使用
      requestedRoute: forcedRoute,
    };
  };
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 从 ChapterSeed 派生暂存状态更新（P0-5 stagedStateUpdate 接线）。
 *
 * 设计原则（计划 §4.2 FinalStateCommit + §3）：
 * - 状态只在最终正文选定后 commit，候选生成期间只 stage（缓冲）
 * - 本章意图中标记为 pending 的 foreshadowing 被记录为 "advancing" 状态
 *   （本章正在参与该 promise，但未确认 fulfilled/broken —— 实际状态需文本分析确认）
 * - sourceChapter 记录来源章节，sourceRef 指向 seed 的 promise id，可追溯
 * - finalCandidateId 留空：由编排器在最终正文选定后用 selectedCandidateId 校验
 *
 * B2：覆盖四类长期叙事状态（CanonState / CharacterState / PromiseLedger / PatternMemory）：
 * - promise：从 seed.currentPressure.pendingForeshadowing 派生（intended advancement）
 * - canon：从 seed.worldConstraint.immutableFacts + highLevelDirection.immutableFacts 派生
 * - character：从 seed.characters 派生（participation 记录）
 * - pattern：由编排器从最终正文 LanguageRiskLibrary 扫描结果追加（见 commitAndSave）
 *
 * 所有 seed 派生 entry 的 sourceRef 初始为 seed:*，由 reanchorStagedStateToFinalText
 * 在最终正文选定后重锚定为 finalText span/hash，确保状态可追溯到真实正文。
 */
export function buildStagedStateUpdate(
  seed: ChapterSeed,
  chapterNumber: number
): StagedStateUpdate {
  const sourceChapter = `ch${chapterNumber}`;
  const now = new Date().toISOString();
  const additions: NarrativeStateEntry[] = [];

  // 1. PromiseLedger：从 seed.currentPressure.pendingForeshadowing 派生 promise 状态更新
  const pendingForeshadowing = seed.currentPressure?.pendingForeshadowing ?? [];
  for (const f of pendingForeshadowing) {
    if (!f.id || !f.description) continue;
    additions.push({
      kind: "promise",
      id: f.id,
      sourceChapter,
      sourceRef: `seed:${f.id}`,
      confidence: 0.6, // intended engagement，非 confirmed resolution
      lastUpdated: now,
      promiseId: f.id,
      description: f.description,
      currentHeat: 1, // 本章正在参与
      status: "advancing",
    });
  }

  // 2. CanonState：从 seed.worldConstraint + highLevelDirection 派生不可破坏事实
  const immutableFacts = [
    ...(seed.worldConstraint?.immutableFacts ?? []),
    ...(seed.highLevelDirection?.immutableFacts ?? []),
  ];
  for (let i = 0; i < immutableFacts.length; i++) {
    const fact = immutableFacts[i];
    if (!fact || fact.trim().length < 2) continue;
    additions.push({
      kind: "canon",
      id: `canon:fact:${i}:ch${chapterNumber}`,
      sourceChapter,
      sourceRef: `seed:canon:${i}`,
      confidence: 0.6,
      lastUpdated: now,
      fact,
      category: "entity", // 默认分类，seed 不携带 category 信息
    });
  }

  // 3. CharacterState：从 seed.characters 派生角色参与记录
  const characters = seed.characters ?? [];
  for (const c of characters) {
    if (!c.name) continue;
    additions.push({
      kind: "character",
      id: `character:${c.name}:ch${chapterNumber}`,
      sourceChapter,
      sourceRef: `seed:character:${c.name}`,
      confidence: 0.6,
      lastUpdated: now,
      characterId: c.name, // 用角色名作为 characterId，便于 reanchor 时在正文中定位
      field: "participation",
      // participation 只记录本章是否实际出现；config.role 是静态元数据，
      // 不能仅因角色名命中就提交为本章关系/身份事实。
      value: "present",
    });
  }

  // 4. PatternMemory：由编排器在最终正文生成后从 LanguageRiskLibrary 扫描追加，
  //    此处不生成（pattern 需要正文文本分析，seed 不携带 pattern 信息）。

  return {
    additions,
    invalidations: [],
    sourceChapter,
    // finalCandidateId 留空：编排器用 selectedCandidateId 校验
  };
}

// ============================================================================
// Trace 记录构建（P1-8：持久化 trace 接入统一编排器）
// ============================================================================

/**
 * 从 judge 仲裁结果推导置信度（0-1）。
 *
 * 语义对齐 buildV2Summary 的 comparatorConfidence 字段：
 * - clear 首轮胜出（无反向复判）：0.9
 * - 两轮一致确认胜出（无冲突）：0.75
 * - 仲裁确认胜出（触发异构仲裁）：0.6
 * - tie/降级/冲突保留 raw：0.4
 */
function deriveJudgeConfidence(jr: ArbitratorResult): number {
  if (!jr.reverseReviewed) return 0.9;
  if (!jr.conflicted) return 0.75;
  if (jr.arbitrationTriggered) return 0.6;
  return 0.4;
}

/**
 * 把 ArbitratorResult 完整转换为 JudgeEvidenceTrace（A6，计划 §12）。
 *
 * 持久化全部轮次的匿名映射、verdict 与 evidence spans，供回放/审计复现裁判过程。
 * 不再只压缩成 auditSummary——trace 读者可还原：
 * - 每轮的 A/B 标签 ↔ 物理候选 id 映射（顺序随机化可复现）
 * - 每轮 verdict 的 decisiveReasons 与 evidenceA/evidenceB spans
 * - 每轮证据校验结果（缺失 span / 不一致 winner）
 * - 最终选择决策与触发路径（是否反向复判 / 是否仲裁 / 是否冲突）
 *
 * 导出供单元测试验证 trace 证据结构完整性（A6 验收）。
 */
export function buildJudgeEvidence(jr: ArbitratorResult): JudgeEvidenceTrace {
  const rounds: JudgeRoundTrace[] = jr.rounds.map((r) => {
    const result = r.result;
    return {
      round: r.round,
      winnerCandidateId: r.winnerCandidateId,
      degraded: result.degraded,
      degradeReason: result.degradeReason,
      mapping: {
        leftCandidateId: result.mapping.leftCandidateId,
        rightCandidateId: result.mapping.rightCandidateId,
        leftLabel: result.mapping.leftLabel,
        rightLabel: result.mapping.rightLabel,
        orderRandomized: result.mapping.orderRandomized,
        seed: result.mapping.seed,
      },
      verdict: result.verdict
        ? {
            winner: result.verdict.winner,
            confidence: result.verdict.confidence,
            decisiveReasons: result.verdict.decisiveReasons.map((dr) => ({
              dimension: dr.dimension,
              betterCandidate: dr.betterCandidate,
              evidenceA: dr.evidenceA.map((s) => ({
                start: s.start,
                end: s.end,
                excerpt: s.excerpt,
              })),
              evidenceB: dr.evidenceB.map((s) => ({
                start: s.start,
                end: s.end,
                excerpt: s.excerpt,
              })),
              explanation: dr.explanation,
            })),
            factualRisks: result.verdict.factualRisks,
            regressionRisks: result.verdict.regressionRisks,
            constitutionAlignment: result.verdict.constitutionAlignment,
          }
        : null,
      evidenceValidation: {
        ok: result.evidenceValidation.ok,
        errors: result.evidenceValidation.errors,
      },
    };
  });

  return {
    selection: {
      selectedCandidateId: jr.selection.selectedCandidateId,
      reason: jr.selection.reason,
      needsReverseReview: jr.selection.needsReverseReview,
    },
    reverseReviewed: jr.reverseReviewed,
    arbitrationTriggered: jr.arbitrationTriggered,
    conflicted: jr.conflicted,
    finalSelectedCandidateId: jr.finalSelectedCandidateId,
    auditSummary: jr.auditSummary,
    rounds,
  };
}

/**
 * 从编排器输出构建 V2TraceRecord 列表（P1-8）。
 *
 * 把统一主链路每章的关键证据落盘到 legacy QualityTraceDocument：
 *   rawstage2_generated → candidate_generated → candidate_compared → final_selected
 *   (+ error，当 status=blocked)
 *
 * 映射说明：
 * - 新主链路用 LLM pairwise judge（ArbitratorResult），不再产出机械 comparator 的
 *   CandidateComparison/FinalSelectionReport。此处把仲裁结果映射回 trace schema，
 *   使 legacy trace 解析器与 replay benchmark 仍可读取候选/裁判/选择证据。
 * - comparison.winnerId = 裁判胜出候选（null 时为 raw）；confidence 由胜因强度推导。
 * - finalSelection.selectedSource 映射：raw→rawStage2，editorial→v2_amplified。
 * - projectGain：editorial 胜出=positive（amplified 超越 baseline）；raw=neutral（基线交付）。
 *   统一主链路不交付劣于 raw 的正文，故无 negative。
 */
function buildTraceRecordsFromOrchResult(
  orchResult: UnifiedOrchestratorOutput,
  contextHash: string,
  releaseGovernance?: V2TraceRecord["releaseGovernance"],
): V2TraceRecord[] {
  const records: V2TraceRecord[] = [];
  const now = new Date().toISOString();
  const candidates = orchResult.candidates ?? [];
  const rawCandidate =
    candidates.find((c) => c.kind === "context_enhanced") ?? candidates[0];
  const rawCandidateId = rawCandidate?.id ?? `candidate:raw:${orchResult.chapterId}`;

  // 1. rawstage2_generated — raw 基线候选
  if (rawCandidate) {
    records.push({
      stage: "rawstage2_generated",
      timestamp: now,
      rawStage2CandidateId: rawCandidate.id,
      rawStage2TextLength: rawCandidate.text.length,
      contextHash,
    });
  }

  // 2. candidate_generated — 全部候选（raw + editorial）
  if (candidates.length > 0) {
    records.push({
      stage: "candidate_generated",
      timestamp: now,
      candidates,
      contextHash,
      amplifiedVariantIds: candidates
        .filter((c) => c.kind === "editorial_amplified")
        .map((c) => c.id),
    });
  }

  // 3. candidate_compared — 裁判仲裁结果映射为 comparison + 完整 judge 证据（仅当 judge 跑过）
  // A6（计划 §12）：除向后兼容的 comparison 外，持久化完整 judgeEvidence：
  //   每轮匿名映射 / verdict / evidence spans / 证据校验，供回放/审计复现裁判过程。
  // B4：当存在多个 editorial 候选裁判时，持久化全部候选的完整 judge 证据
  //   （allJudgeEvidence），不只最终选中的那一个。
  if (orchResult.judgeResult) {
    const jr = orchResult.judgeResult;
    const winnerId = jr.finalSelectedCandidateId ?? rawCandidateId;
    const loserIds = candidates.filter((c) => c.id !== winnerId).map((c) => c.id);
    const comparison: CandidateComparison = {
      winnerId,
      loserIds,
      confidence: deriveJudgeConfidence(jr),
      dimensionScores: {},
      acceptedRepairs: [],
      rejectedRepairs: [],
      reasons: [jr.auditSummary],
    };
    // B4：构建全部候选的完整 judge 证据（多于 1 个裁判结果时才需要）
    const allArbitrations = orchResult.allArbitrationResults ?? [];
    const allJudgeEvidence =
      allArbitrations.length > 1
        ? allArbitrations.map((a) => buildJudgeEvidence(a.result))
        : undefined;
    records.push({
      stage: "candidate_compared",
      timestamp: now,
      comparison,
      judgeEvidence: buildJudgeEvidence(jr),
      allJudgeEvidence,
      contextHash,
    });
  }

  // 4. final_selected — 最终选择（含状态提交结果，供回放审计）
  const selectedSource: FinalSelectedSource =
    orchResult.selectedSource === "editorial" ? "v2_amplified" : "rawStage2";
  const projectGain: ProjectGain =
    orchResult.selectedSource === "editorial" ? "positive" : "neutral";
  const finalSelection: FinalSelectionReport = {
    selectedCandidateId: orchResult.selectedCandidateId || rawCandidateId,
    selectedSource,
    projectGain,
    whySelected: [
      orchResult.judgeResult?.auditSummary ??
        "无编辑机会或编辑未胜出，交付 raw 基线",
    ],
    whyRejected: orchResult.warnings,
    acceptedRepairs: [],
    rejectedRepairs: [],
  };
  records.push({
    stage: "final_selected",
    timestamp: now,
    finalSelection,
    contextHash,
    // Step 1c/1d：模型调用遥测、阶段耗时、调用预算随 trace 落盘
    modelCalls: orchResult.stageResults.modelCalls as ModelCallEntry[] | undefined,
    stageTiming: orchResult.stageResults.stageTiming as Record<string, number> | undefined,
    modelBudget: orchResult.stageResults.modelBudget as
      | { soft: number; hard: number; used: number; capped: boolean }
      | undefined,
    // Phase 4 C9：release governance 绑定，供 canary 证据跨 release 校验
    releaseGovernance,
  });

  // 5. error — 结构化阻断时记录 failureEnvelope
  if (orchResult.status === "blocked" && orchResult.failureEnvelope) {
    records.push({
      stage: "error",
      timestamp: now,
      error: {
        message: orchResult.failureEnvelope.reason,
        code: orchResult.failureEnvelope.stage,
        recoverable: orchResult.failureEnvelope.recoverable,
      },
      contextHash,
    });
  }

  // 6. novelos_agentic — NovelOS shadow agentic_raw 候选摘要（Step 5）
  // 持久化 trajectory 路径 + agentic_raw 摘要 + budget snapshot，供回放/审计复现。
  const novelosData = orchResult.stageResults.novelos as
    | {
        shadowEnabled: boolean;
        sessionId?: string;
        trajectoryPath?: string;
        candidateId?: string | null;
        candidateLength?: number;
        stopReason?: string;
        failureReason?: string | null;
        budgetSnapshot?: unknown;
        sourceRefs?: string[];
        toolCalls?: number;
        error?: string;
      }
    | undefined;
  if (novelosData) {
    records.push({
      stage: "novelos_agentic",
      timestamp: now,
      novelos: novelosData,
      contextHash,
    });
  }

  return records;
}

/**
 * 把编排器输出映射为 V2Output（eval 模式用，不写 trace / 不含 compileDiagnostics）。
 *
 * Eval 模式不需要 trace 落盘和 compileDiagnostics（eval 不走 ContextCompiler），
 * 只需把编排器的 UnifiedOrchestratorOutput 映射为 V2Output 兼容形状，
 * 供 eval-pipeline-adapter 提取 text/candidates/stageResults。
 */
function mapOrchResultToV2Output(
  orchResult: UnifiedOrchestratorOutput,
  workspaceId: string,
  chapterId: string,
  chapterNumber: number,
  _compileDiagnostics: Diagnostic[],
  _intentWarnings: string[]
): V2Output {
  const baseStageResults: Record<string, unknown> = {
    ...orchResult.stageResults,
    unifiedPipeline: true,
    evalMode: true,
    selectedSource: orchResult.selectedSource,
    selectedCandidateId: orchResult.selectedCandidateId,
    warnings: orchResult.warnings,
    stateCommit: orchResult.stateCommit,
    chapterFilePath: orchResult.chapterFilePath,
    tracePath: null,
    // DEMO-3-R1 修复：保留 stageResults 中完整的 judgeArbitration（含 rounds/allArbitrations/error），
    // 不再从 orchResult.judgeResult 重构简化版本。
    // 旧逻辑 bug：deliverRaw 路径（FactGuard 阻断/no_op/budget_fallback）传 judgeResult=null，
    // 导致 judgeArbitration 被覆盖为 null，即使 stageResults.judgeArbitration 已正确设置。
    // 同时旧逻辑丢失 rounds 字段，使 generation-matrix-runner 无法检测 judge 降级（rounds[0].degraded）。
    judgeArbitration: (orchResult.stageResults.judgeArbitration as unknown) ?? null,
  };

  if (orchResult.status === "blocked") {
    return {
      status: "blocked",
      workspaceId,
      chapterId,
      chapterNumber,
      text: orchResult.text,
      candidates: orchResult.candidates as Candidate[],
      diagnostics: [],
      failureEnvelope: orchResult.failureEnvelope,
      stageResults: baseStageResults,
    };
  }

  return {
    status: "ok",
    workspaceId,
    chapterId,
    chapterNumber,
    text: orchResult.text,
    candidates: orchResult.candidates as Candidate[],
    diagnostics: [],
    stageResults: baseStageResults,
  };
}

function buildEntryControlPlaneBlockedOutput(
  input: V2Input,
  controlPlane: TrustedControlPlane,
  capability: CapabilityName,
  reason: string,
): V2Output {
  const denial = controlPlane.policy.decisions.at(-1);
  const failureEnvelope = {
    stage: `control_plane_${capability.replaceAll(".", "_")}`,
    severity: "preflight" as const,
    reason: `capability denied: ${capability} (${reason})`,
    recoverable: false,
    degradedTo: "hard_block" as const,
  };
  return {
    status: "blocked",
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    text: "",
    candidates: [],
    diagnostics: [],
    failureEnvelope,
    stageResults: {
      controlPlane: {
        packet: {
          packetId: controlPlane.packet.packetId,
          packetHash: controlPlane.packet.packetHash,
          taskId: controlPlane.packet.taskId,
          objective: controlPlane.packet.objective,
          source: controlPlane.packet.source,
          valid: true,
          errors: [],
        },
        policy: controlPlane.policy.summary(),
        decisions: controlPlane.policy.decisions,
        denials: denial ? [denial] : [],
        modelLocks: {
          generation: controlPlane.packet.modelLocks.generation,
          judge: controlPlane.packet.modelLocks.judge,
        },
      },
      failureEnvelope,
      qualityEvidenceReportPath: null,
      qualityEvidenceReportExport: {
        exported: false,
        filePath: "",
        reason: "control plane blocked before artifact export",
      },
    },
  };
}

export async function runUnifiedPipeline(
  input: V2Input & UnifiedPipelineEvalInput
): Promise<V2Output> {
  const {
    workspaceId,
    chapterId,
    chapterNumber,
    projectRoot,
    modelTestRoute,
    previewOnly,
    fullPipelinePreview,
    candidateTimeoutMs,
    evalMode,
    evalPrefix,
    evalIntent,
    evalContext,
    evalModelGenerate,
    evalArbitratorModelGenerate,
    evalCharacterNames,
  } = input;

  // ── FULL-PIPELINE-PREVIEW-1：归一化 previewOnly（已弃用）为 fullPipelinePreview ──
  // 旧 previewOnly 字段曾是"FactGuard 后直接返回 raw"的短路径；
  // 现归一化为完整链路只读预览（行为升级：执行完整 editorial/judge/select，但跳过所有副作用）。
  // 二者都为 true 时以 fullPipelinePreview 显式为准；都不为 true 时按正常生产链路。
  const effectiveFullPipelinePreview = Boolean(fullPipelinePreview || previewOnly);

  // ── bounded 超时预算（与 v2-orchestrator 一致，仅当用户未显式设置时提升） ──
  const BOUNDED_TIMEOUT_DEFAULT_MS = 600000;
  if (!process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS) {
    process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS = String(
      candidateTimeoutMs ?? BOUNDED_TIMEOUT_DEFAULT_MS
    );
  }

  // ── Eval 模式：跳过 ContextCompiler/IntentBuilder，使用调用方传入值 ──
  // NB-4 Generation Matrix：B0-B4 各层由调用方构造 intent/context/modelGenerate，
  // runUnifiedPipeline 只负责把它们传给编排器，不走 workspace 加载/意图构建/legacy 路由。
  // 这保证 benchmark 通过 novel_generate_chapter → runUnifiedPipeline → orchestrate 公开入口，
  // 而非直接实例化 UnifiedOrchestrator。
  if (evalMode !== undefined) {
    if (!evalIntent || !evalContext || !evalModelGenerate) {
      throw new Error(
        `evalMode=${evalMode} 需要 evalIntent / evalContext / evalModelGenerate 全部非空`
      );
    }
    // 按 evalMode 构造 agenticCandidateSource（冻结计划 §8.1）：
    // - B0/B1：无 agentic（PureModel / CompiledContext，只有 one_shot_raw）
    // - B2：agentic(retrieval=true, verify=false) — AgenticRetrieval
    // - B3：agentic(retrieval=true, verify=true) — VerifiedAgenticRaw
    // - B4：agentic(retrieval=true, verify=true) — EditorialSelection（B3 + editorial + judge）
    let evalAgenticSource: ReturnType<typeof createAgenticRawCandidateSource> | undefined;
    if (evalMode === "B2" || evalMode === "B3" || evalMode === "B4") {
      const enableVerification = evalMode === "B3" || evalMode === "B4";
      evalAgenticSource = createAgenticRawCandidateSource({
        enableRetrieval: true,
        enableVerification,
      });
    }
    const evalOrchestrator = new UnifiedOrchestrator();
    const evalControlPlane = buildTrustedControlPlane({
      taskId: `NOVEL-EVAL:${workspaceId}:${chapterId}`,
      objective: `执行 ${evalMode} 本地评估路径`,
      scope: ["eval unified pipeline", "stub/local model", "no persistence"],
      allowedResources: ["eval:model", "eval:context"],
      forbiddenResources: ["network:model", "workspace:commit", "chapter:save", "artifact:export"],
      generationLock: { route: "eval", provider: "local", model: "eval" },
      judgeLock: { route: "eval", provider: "local", model: "eval" },
      modelTransport: "local",
      enforceModelLocks: false,
      capabilityOverrides: {
        "state.commit": "deny",
        "chapter.save": "deny",
        "artifact.export": "deny",
      },
    });
    const evalOrchResult = await evalOrchestrator.orchestrate({
      workspaceId,
      chapterId,
      chapterNumber,
      projectRoot,
      intent: evalIntent,
      context: evalContext,
      constitution: evalContext.constitution ?? null,
      characterNames: evalCharacterNames ?? [],
      modelGenerate: evalModelGenerate,
      arbitratorModelGenerate: evalArbitratorModelGenerate,
      timeoutMs: candidateTimeoutMs,
      evalMode,
      evalPrefix,
      agenticCandidateSource: evalAgenticSource,
      controlPlane: evalControlPlane,
    });
    // Eval 模式不写 trace / 不保存策略信誉库 / 不提交状态（编排器 evalMode 已跳过 commitAndSave）
    return mapOrchResultToV2Output(
      evalOrchResult, workspaceId, chapterId, chapterNumber, [], []
    );
  }

  // ── G6: 生产入口发行治理门禁（计划 §Phase G6） ──────────────────────
  // 在 ContextCompiler 之前执行：未审批 release / fingerprint 不匹配 / 无 active pointer
  // 时 hard block，避免未审批策略、prompt 和 dirty build 静默进入生产。
  // - PINOVEL_DEV_MODE=1 时 bypass（非生产开发模式）
  // - evalMode 已在上方 bypass（eval 模式不修改 active pointer，由调用方决定）
  // 门禁失败时返回结构化 FailureEnvelope（stage=g6_release_gate），与统一主链路
  // 其他 failureEnvelope 形状一致；stageResults.releaseGovernance 记录门禁决策。
  const releaseGateResult = evaluateProductionReleaseGate({
    projectRoot,
    workspacesRoot: join(projectRoot, "workspaces"),
  });
  const releaseGovernanceTrace = {
    devMode: releaseGateResult.devMode,
    releaseId: releaseGateResult.ok ? releaseGateResult.releaseId : null,
    environmentFingerprint: releaseGateResult.ok ? releaseGateResult.environmentFingerprint : null,
    approvalRef: releaseGateResult.ok ? releaseGateResult.approvalRef : null,
    canaryEvidenceRunId: releaseGateResult.ok ? releaseGateResult.canaryEvidenceRunId : null,
  };
  if (!releaseGateResult.ok) {
    return {
      status: "blocked",
      workspaceId,
      chapterId,
      chapterNumber,
      text: "",
      candidates: [],
      diagnostics: [],
      failureEnvelope: releaseGateResult.failureEnvelope,
      stageResults: {
        unifiedPipeline: true,
        releaseGovernance: {
          ...releaseGovernanceTrace,
          blocked: true,
          reason: releaseGateResult.failureEnvelope.reason,
        },
      },
    };
  }

  const useStub = process.env.V2_FORCE_STUB === "1";
  const routeLock = resolveModelTestRouteLock(modelTestRoute);
  const generationModelLock = routeLock
    ? { route: routeLock.generateRoute, provider: "glm", model: "glm-5.2" }
    : { route: "runtime", provider: "runtime", model: "runtime" };
  const judgeModelLock = routeLock
    ? { route: routeLock.judgeRoute, provider: "glm", model: "glm-5.2" }
    : { route: "runtime", provider: "runtime", model: "runtime" };
  const controlPlane = buildTrustedControlPlane({
    taskId: `NOVEL-GENERATE:${workspaceId}:${chapterId}`,
    objective: `通过统一主链路生成 ${chapterId}`,
    scope: ["context read", "chapter generation", "literary judge", "final persistence"],
    allowedResources: [
      `workspace:${workspaceId}:read`,
      `workspace:${workspaceId}:state`,
      `workspace:${workspaceId}:chapter`,
      `workspace:${workspaceId}:artifact`,
    ],
    forbiddenResources: ["legacy:stage0-8", "public:capability-escalation"],
    generationLock: generationModelLock,
    judgeLock: judgeModelLock,
    modelTransport: useStub ? "stub" : "network",
    enforceModelLocks: routeLock !== null,
  });
  const stateReadDecision = controlPlane.policy.authorize(
    "state.read",
    `load workspace context: ${workspaceId}`,
  );
  if (!stateReadDecision.allowed) {
    return buildEntryControlPlaneBlockedOutput(
      input,
      controlPlane,
      "state.read",
      "workspace context read denied",
    );
  }

  // ── 1. ContextCompiler：加载 workspace + 编译 context ──────────────────
  // ContextCompiler.compile 内部调用 loadCreativeConstitution / loadStateStore，
  // 把 constitution 与 longTermState 只读快照塞进 CompiledContext。
  // 此处只读复用 sourceSeed 派生 ChapterIntentInput，不重复加载。
  const compiler = createContextCompiler();
  const compiled = compiler.compile({
    workspaceId,
    chapterId,
    chapterNumber,
    projectRoot,
  });
  const context = compiled.context;
  const seed = compiled.sourceSeed;
  const compileDiagnostics: Diagnostic[] = compiled.diagnostics ?? [];

  // ── 2. ChapterIntentBuilder：从 ChapterSeed + constitution + state 派生意图 ──
  // ChapterIntent 是创作方向（不是章纲/句式清单）。inviolableFacts 合并
  // worldConstraint.immutableFacts + highLevelDirection.immutableFacts，再由
  // builder 合并 constitution.forbiddenDrift。
  const constitution = loadCreativeConstitution(workspaceId, projectRoot);
  const stateStore = loadStateStore(workspaceId, projectRoot);

  const intentInput: ChapterIntentInput = {
    chapterNumber,
    intentPrimary: seed.intent?.primary,
    chapterTheme: seed.intent?.chapterTheme,
    targetEmotions: seed.intent?.targetEmotions ?? [],
    characters: (seed.characters ?? []).map((c) => ({
      name: c.name,
      role: c.role,
      mentality: c.mentality,
      recentAction: c.recentAction,
      pendingTension: c.pendingTension,
    })),
    immutableFacts: [
      ...(seed.worldConstraint?.immutableFacts ?? []),
      ...(seed.highLevelDirection?.immutableFacts ?? []),
    ],
    openPromises: (seed.currentPressure?.pendingForeshadowing ?? []).map((f) => ({
      id: f.id,
      description: f.description,
    })),
    openArcs: (seed.currentPressure?.openArcs ?? []).map((a) => ({
      arcId: a.arcId,
      name: a.name,
      coreQuestion: a.coreQuestion,
    })),
    currentPressureSummary: [
      ...(seed.currentPressure?.pendingForeshadowing ?? []).map((f) => f.description),
      ...(seed.currentPressure?.openArcs ?? []).map((a) => a.name),
      // REAL-QUALITY-4：补入前章悬置状态，让 intent.currentPressure 携带前章未解张力/开放钩子，
      // 避免跨章因果断裂（此前只含 foreshadowing+openArcs，漏掉 previousChapterContinuation）。
      ...(seed.previousChapterContinuation?.unresolvedTensions ?? []),
      ...(seed.previousChapterContinuation?.openHooks ?? []),
    ],
    prevContinuationAvailable: seed.previousChapterContinuation?.available ?? false,
    // INTENT-1：接线 pendingCosts（seed.currentPressure.pendingCosts），
    // 供 ChapterIntentBuilder 派生 choicesAndCosts / expectedIrreversibleChange。
    pendingCosts: seed.currentPressure?.pendingCosts ?? [],
  };

  const intentBuilder = createChapterIntentBuilder();
  const { intent, warnings: intentWarnings } = intentBuilder.build(
    intentInput,
    constitution,
    stateStore
  );

  // ── 3. ModelGenerateFn：真实链路或 stub ────────────────────────────────
  // REAL-QUALITY-1-PREFLIGHT：useStub 只看 V2_FORCE_STUB（去掉 modelTestRoute===undefined 条件），
  // 使 modelTestRoute=glm 时也能用 stub 测试（不调用真实模型）。
  // 真实生成走 createLegacyModelGenerateFn（动态 import fallback-manager）。
  const baseModelGenerate: ModelGenerateFn = useStub
    ? createStubModelGenerateFn()
    : createLegacyModelGenerateFn();

  // REAL-QUALITY-1-PREFLIGHT：单次路由锁定（modelTestRoute=glm）— 双轨分锁
  // 把生成调用（raw + editorial candidate）锁定到 nb4_generate_glm，
  // 把判断调用（opportunity judge + pairwise 首轮 + 反向复判 + 冲突仲裁）锁定到 nb4_judge_glm。
  // 不得只把 judge wrapper 用于第三轮仲裁——opportunity/pairwise 首轮/反向复判也必须走 nb4_judge_glm。
  //
  // nb4_*_glm 路由在 config/model-routing.json 中 fallback=[]，禁止任何 GPT/Claude/Doubao/ERNIE 回退。
  // wrap 保持 output.route 语义（v2_rawstage2/v2_amplified），仅覆盖底层调用 route；
  // output.requestedRoute 透传到 modelCallLog，提供"实际请求路由"证据。
  // input.requestedRoute 设为 forcedRoute，失败时 wrapModelFn catch 据此推导 provider=glm。
  //
  // MODEL-ROUTING-CLAUDE46-1A: 派工卡 §3 Required Change #6 — 默认生产路径必须显式传入独立的
  // generationModelGenerate 与 judgeModelGenerate，不能再让两者仅靠同一个默认函数隐式分流。
  // 即使未锁定（modelTestRoute !== "glm"），也显式传 baseModelGenerate 给两条 track，
  // 让 orchestrator 的 wrapModelFn 分别 wrap，便于 trace 区分 generation/judge 调用证据。
  // 路由仍由 input.route 决定（v2_rawstage2/v2_amplified 走 Claude，v2_opportunity_judge/
  // v2_literary_judge 走 GPT），baseModelGenerate 仅按 input.route 调用 callWithFallback。
  const modelGenerate: ModelGenerateFn = baseModelGenerate;
  const generationModelGenerate: ModelGenerateFn = routeLock
    ? wrapModelGenerateLockedToRoute(baseModelGenerate, routeLock.generateRoute)
    : baseModelGenerate;
  const judgeModelGenerate: ModelGenerateFn = routeLock
    ? wrapModelGenerateLockedToRoute(baseModelGenerate, routeLock.judgeRoute)
    : baseModelGenerate;

  // ── 4. characterNames：从 seed 角色列表派生（CANON-IDENTITY-1: 含 aliases） ──
  const characterNames = (seed.characters ?? []).flatMap((c) => [c.name, ...(c.aliases ?? [])]);

  // ── 5. UnifiedOrchestrator：raw → editorial → judge → select → commit ──
  // P0-5: 从 seed 派生 stagedStateUpdate，接线状态提交链路。
  // 编排器在最终正文选定后 commit（正文保存成功后才落盘状态）。
  // P1-7: 加载 Phase 6 在线学习组件（策略信誉库 + Thompson Sampling 选择器 +
  //   结果记录器），传入编排器。编排器用 Thompson Sampling 调整策略调用概率，
  //   并在裁判后记录胜负。未准入 candidate 跳过在线采样并走静态 registry，
  //   生成后保存策略信誉库（学习失败不阻断生成）。
  const stateStageDecision = controlPlane.policy.authorize(
    "state.stage",
    `stage narrative state update: ${chapterId}`,
  );
  const constraintManifest = createConstraintManifest({ intent, context });
  const contextSafety = compileContextSafety({
    manifest: constraintManifest,
    intent,
    context,
    modelWindowTokens: Number(process.env.PINOVEL_CONTEXT_WINDOW_TOKENS ?? 128000),
    outputReserveTokens: Number(process.env.PINOVEL_CONTEXT_OUTPUT_RESERVE_TOKENS ?? 8192),
    safetyMarginTokens: Number(process.env.PINOVEL_CONTEXT_SAFETY_MARGIN_TOKENS ?? 4096),
  });
  if (!stateStageDecision.allowed) {
    return buildEntryControlPlaneBlockedOutput(
      input,
      controlPlane,
      "state.stage",
      "narrative state staging denied",
    );
  }
  const stagedStateUpdate = buildStagedStateUpdate(seed, chapterNumber);
  const policyStore = loadStrategyPolicyStore(workspaceId, projectRoot);
  const strategySelector = createContextualStrategySelector();
  const outcomeRecorder = createStrategyOutcomeRecorder();
  // Step 5：NovelOS agentic_raw 候选源（shadow 模式，PINOVEL_NOVELOS_SHADOW=1 时启用）
  // shadow OFF 时不构造，编排器走原有 raw → editorial → judge → select 主链路，零行为变化。
  const agenticCandidateSource =
    process.env.PINOVEL_NOVELOS_SHADOW === "1"
      ? createAgenticRawCandidateSource()
      : undefined;
  const orchestrator = new UnifiedOrchestrator();
  const orchResult = await orchestrator.orchestrate({
    workspaceId,
    chapterId,
    chapterNumber,
    projectRoot,
    intent: contextSafety.workingIntent,
    context: contextSafety.workingContext,
    constitution: context.constitution ?? null,
    characterNames,
    ontologyLevels: loadOntologyLevels(workspaceId, projectRoot),
    modelGenerate,
    // REAL-QUALITY-1-PREFLIGHT：双轨路由锁定（modelTestRoute=glm 时）
    // - generationModelGenerate：raw + editorial candidate → nb4_generate_glm
    // - judgeModelGenerate：opportunity judge + pairwise 首轮 + 反向复判 + 冲突仲裁 → nb4_judge_glm
    // MODEL-ROUTING-CLAUDE46-1A: 默认生产路径也显式传两条 track（baseModelGenerate），
    // 路由由 input.route 决定（v2_rawstage2/v2_amplified→Claude，v2_opportunity_judge/
    // v2_literary_judge→GPT）。未锁定时不 wrap，但 track 分离仍让 trace 可证明异源。
    // 不传 arbitratorModelGenerate：编排器 fallback 到 judgeModelGenerate（仲裁也走 nb4_judge_glm）。
    generationModelGenerate,
    judgeModelGenerate,
    timeoutMs: candidateTimeoutMs,
    stagedStateUpdate,
    policyStore,
    strategySelector,
    outcomeRecorder,
    agenticCandidateSource,
    controlPlane,
    contextSafety,
    // REAL-QUALITY-1-PREFLIGHT：透传 seed 让 Thompson Sampling / judge 匿名 A/B
    // 可复现。未传时 orchestrator 内部 rng 回退到 Math.random（非确定性），
    // 仅已准入 active 策略参与 Thompson Sampling；candidate 不受随机阈值过滤。
    // 不影响模型调用本身（路由锁定由 modelTestRoute 控制）。
    seed: input.seed,
    previewOnly,
    fullPipelinePreview: effectiveFullPipelinePreview,
  });

  // ── 5.1 保存策略信誉库（P1-7：在线学习持久化 / A5：仅成功交付才落盘）──
  // 编排器在 Stage 7.1（最终事实复检 + 正文保存成功之后）才通过 outcomeRecorder
  // 把 win/loss/tie evidence 写入 store 内存对象。
  // A5 修复：只在 orchResult.status === "ok" 时落盘 strategy-policy.json。
  //   blocked 路径下编排器未记录任何 outcome（Stage 7.1 未触达），但此处仍可能
  //   持久化一个被 Stage 3.5 Thompson Sampling 读取过的 store；为杜绝"学习一次
  //   未交付结果"的污染风险，blocked 一律不写盘。成功路径下保存失败不阻断生成
  //   （学习是增强，正文已交付）。
  //
  // FULL-PIPELINE-PREVIEW-1：完整链路预览不落盘策略库——预览运行只读不动长期状态。
  if (orchResult.status === "ok" && !effectiveFullPipelinePreview) {
    try {
      saveStrategyPolicyStore(policyStore, workspaceId, projectRoot);
    } catch (learnErr) {
      const msg = learnErr instanceof Error ? learnErr.message : String(learnErr);
      process.stderr.write(`[Unified] 策略信誉库保存失败（不阻断生成）：${msg}\n`);
    }
  }

  // ── 5.5 持久化 trace（P1-8：统一编排器接入 trace 落盘） ───────────────
  // 把每章候选、judge 仲裁 span、最终选择、状态提交落盘到
  // {projectRoot}/workspaces/{workspaceId}/traces/{chapterId}-quality-trace.json
  // 使 replay benchmark 与 legacy QualityTraceDocument 解析器可回放。
  // 写入失败不阻断生成（trace 缺失可补，正文污染不可逆）。
  //
  // FULL-PIPELINE-PREVIEW-1：预览模式不写 trace 文件——预览必须保持工作区无副作用。
  let tracePath: string | undefined;
  if (!effectiveFullPipelinePreview) {
    try {
      const traceAdapter = createLegacyTraceAdapter({
        workspacePath: join(projectRoot, "workspaces"),
        workspaceId,
        chapterId,
      });
      const contextHash = deriveContextHashFromCompiled(context);
      const traceRecords = buildTraceRecordsFromOrchResult(orchResult, contextHash, releaseGovernanceTrace);
      for (const rec of traceRecords) {
        traceAdapter.record(rec);
      }
      tracePath = traceAdapter.flush();
    } catch (traceErr) {
      const msg = traceErr instanceof Error ? traceErr.message : String(traceErr);
      process.stderr.write(`[Unified] trace 持久化失败（不阻断生成）：${msg}\n`);
    }
  }

  // ── 6. 映射到 V2Output 兼容形状 ────────────────────────────────────────
  // 统一主链路永远不返回 v2NotImplemented（无 legacy 回退）。
  // 编译期 diagnostics 与意图构建 warnings 一并写入 stageResults 供 trace 审计。
  const baseStageResults: Record<string, unknown> = {
    ...orchResult.stageResults,
    unifiedPipeline: true,
    selectedSource: orchResult.selectedSource,
    selectedCandidateId: orchResult.selectedCandidateId,
    warnings: orchResult.warnings,
    intentWarnings,
    compileDiagnostics: compileDiagnostics.map((d) => ({
      id: d.id,
      severity: d.severity,
      evidence: d.evidence,
    })),
    stateCommit: orchResult.stateCommit,
    chapterFilePath: orchResult.chapterFilePath,
    tracePath: tracePath ?? null,
    // G6：发行治理门禁决策摘要（releaseId/environmentFingerprint/approvalRef/devMode）
    releaseGovernance: releaseGovernanceTrace,
    judgeArbitration: orchResult.judgeResult
      ? {
          reverseReviewed: orchResult.judgeResult.reverseReviewed,
          arbitrationTriggered: orchResult.judgeResult.arbitrationTriggered,
          conflicted: orchResult.judgeResult.conflicted,
          finalSelectedCandidateId: orchResult.judgeResult.finalSelectedCandidateId,
        }
      : null,
  };

  if (orchResult.status === "blocked") {
    return {
      status: "blocked",
      workspaceId,
      chapterId,
      chapterNumber,
      text: orchResult.text,
      candidates: orchResult.candidates as Candidate[],
      diagnostics: compileDiagnostics,
      failureEnvelope: orchResult.failureEnvelope,
      stageResults: baseStageResults,
      isPreviewRun: effectiveFullPipelinePreview,
      selectedSource: orchResult.selectedSource,
      selectedCandidateId: orchResult.selectedCandidateId,
      // INTENT-COMPLETENESS-1：透传 under-specified 标记。
      isUnderSpecified: orchResult.isUnderSpecified,
    };
  }

  return {
    status: "ok",
    workspaceId,
    chapterId,
    chapterNumber,
    text: orchResult.text,
    candidates: orchResult.candidates as Candidate[],
    diagnostics: compileDiagnostics,
    stageResults: baseStageResults,
    isPreviewRun: effectiveFullPipelinePreview,
    selectedSource: orchResult.selectedSource,
    selectedCandidateId: orchResult.selectedCandidateId,
    // INTENT-COMPLETENESS-1：透传 under-specified 标记。
    isUnderSpecified: orchResult.isUnderSpecified,
  };
}
