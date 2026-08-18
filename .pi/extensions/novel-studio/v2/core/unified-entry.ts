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
  LongTermStateSnapshot,
  ProjectGain,
  V2Input,
  V2Output,
} from "./types.js";
import { createContextCompiler } from "./context-compiler.js";
import { buildNarrativeEvidenceSnapshot } from "./narrative-evidence-snapshot.js";
import { createChapterIntentBuilder } from "./chapter-intent-builder.js";
import type { ChapterIntent, ChapterIntentInput } from "./chapter-intent-builder.js";
import { UnifiedOrchestrator, type UnifiedOrchestratorOutput, type ModelCallEntry } from "./unified-orchestrator.js";
import type { ArbitratorResult } from "./judge-arbitrator.js";
import { loadCreativeConstitution } from "./creative-constitution.js";
import { loadStateStore, type StagedStateUpdate, type NarrativeStateEntry } from "./final-state-commit.js";
import { selectAcceptedChapterReferences } from "./historical-state-backfill.js";
import type { ChapterSeed } from "../../craft/chapter-seed-types.js";
// Phase 2A：完整 Preflight 接入 runUnifiedPipeline。
// 在 release gate 之后、ContextCompiler 之前调用 preflightWorkspace，把"前置条件缺失"
// 从"模型随机失败"中分离出来。预检失败返回 severity=preflight 阻断，不进入模型调用。
// evalMode / qualityExperiment / fullPipelinePreview 跳过（不交付正式正文）。
import {
  preflightWorkspace,
  formatPreflightWorkspaceReport,
  type PreflightWorkspaceReport,
} from "../../craft/workspace-preflight-checker.js";
import {
  createLegacyModelGenerateFn,
  createStubModelGenerateFn,
  createEvalReplayModelGenerateFnFromEnv,
  type ModelGenerateFn,
  type ModelGenerateInput,
} from "../adapters/legacy-model-route-adapter.js";
// AUDIT-1：统一事件契约 + Phase 3 最小主链路会话（run_started/终止/failure_recorded）。
import {
  AuditEventStore,
  createAuditEvent,
  createAuditRunSession,
  validateAuditEvent,
  diagnoseTraceCompleteness,
  computeContentHash,
  createEventId,
  createRunId,
  createTraceId,
} from "./audit/index.js";
import { productionFailureToAuditEvent } from "./failure-envelope.js";
import {
  collectRequiredActivationFailures,
  createChapterConsumptionLedger,
  recordOptionalCapabilityUnavailable,
  resolveChapterCapabilityPackageSet,
  planProductionCapabilityActivations,
  requiredPackageFailure,
  resolveRouteCapabilityKey,
} from "./capability-package-production.js";
import { createBudgetLedger } from "./budget-ledger.js";
import { getModelRequestTimeoutMs } from "../../api/request-timeout.js";
import { defaultCapabilityRegistry } from "../../novelos/protocol/capability-registry.js";
import { NARRATIVE_TOOL_NAMES } from "../../novelos/tools/narrative-tools.js";
import { ACTIVATE_CAPABILITY_PACKAGE_TOOL } from "../../novelos/agent/capability-package-runtime.js";
import type { AuditEventRecorder } from "./audit/audit-event-recorder.js";
// RUN-LIFECYCLE-P1：统一 RunAggregate 契约进入生产闭包（经 unified-entry 编译入口）
import {
  createEmptyRunAggregate,
  reduceRunAggregate,
  replayRunAggregate,
  assertWorkflowTransition,
  canWorkflowTransition,
  assertArtifactBinding,
  RUN_AGGREGATE_SCHEMA_VERSION,
  RUN_ERROR_CODES,
  toRecoveryLifecycleState,
  fromRecoveryLifecycleState,
  createRunAggregateRepository,
  rebuildRunAggregateFromEvents,
  loadMaterializedRunAggregate,
  saveMaterializedRunAggregate,
  assertAggregateMatchesReplay,
  projectCurrentRunState,
  projectCheckpointIndex,
  projectApprovalPending,
  projectTransitionHistory,
  writeRunProjections,
  rebuildProjectionsFromAggregate,
  revokeEvidence,
  revokeEvidenceWithLearningRecompute,
  listActiveEvidenceIds,
  isEvidenceActive,
  startCompensationRun,
  assertParentRunNotRetreated,
} from "./run/index.js";
export {
  AuditEventStore,
  createAuditEvent,
  createAuditRunSession,
  validateAuditEvent,
  diagnoseTraceCompleteness,
  computeContentHash,
  createEventId,
  createRunId,
  createTraceId,
  productionFailureToAuditEvent,
  createEmptyRunAggregate,
  reduceRunAggregate,
  replayRunAggregate,
  assertWorkflowTransition,
  canWorkflowTransition,
  assertArtifactBinding,
  RUN_AGGREGATE_SCHEMA_VERSION,
  RUN_ERROR_CODES,
  toRecoveryLifecycleState,
  fromRecoveryLifecycleState,
  createRunAggregateRepository,
  rebuildRunAggregateFromEvents,
  loadMaterializedRunAggregate,
  saveMaterializedRunAggregate,
  assertAggregateMatchesReplay,
  projectCurrentRunState,
  projectCheckpointIndex,
  projectApprovalPending,
  projectTransitionHistory,
  writeRunProjections,
  rebuildProjectionsFromAggregate,
  revokeEvidence,
  revokeEvidenceWithLearningRecompute,
  listActiveEvidenceIds,
  isEvidenceActive,
  startCompensationRun,
  assertParentRunNotRetreated,
};
export type { AuditEvent } from "./audit/index.js";
export type {
  RunAggregate,
  WorkflowState,
  ApprovalState,
  CommitIntent,
  ArtifactBinding,
  RunAggregateRepository,
  CurrentRunStateProjection,
  CheckpointIndexProjection,
  ApprovalPendingProjection,
  TransitionHistoryEntry,
} from "./run/index.js";
import {
  createLegacyTraceAdapter,
  deriveContextHashFromCompiled,
  type V2TraceRecord,
  type V2TraceAdapter,
  type V2TraceStage,
  type JudgeEvidenceTrace,
  type JudgeRoundTrace,
} from "../adapters/legacy-trace-adapter.js";
import { atomicSave } from "./orchestrator-commit-save.js";
import { computeProductionBundleHash } from "./production-bundle-hash.js";
import type { FailureEnvelope } from "../../craft/failure-envelope.js";
import {
  loadStrategyPolicyStore,
  saveStrategyPolicyStore,
} from "../learning/strategy-policy-store.js";
import { createContextualStrategySelector } from "../learning/contextual-strategy-selector.js";
import { createStrategyOutcomeRecorder } from "../learning/strategy-outcome-recorder.js";
// Step 5：NovelOS agentic_raw 候选源（shadow 模式，PINOVEL_NOVELOS_SHADOW=1 时启用）
import { createAgenticRawCandidateSource } from "../../novelos/agent/agentic-raw-candidate-source.js";
import { resolveToolModeFromCanaryAuthorization } from "../governance/resolve-tool-mode-from-canary-authorization.js";
import { createBlockedRawRecovery } from "./blocked-raw-recovery.js";
import {
  buildTrustedControlPlane,
  type CapabilityName,
  type TrustedControlPlane,
} from "./control-plane.js";
import {
  resolveRunRouting,
  fingerprintRunRouting,
  type RunRoutingContext,
} from "./run-routing-context.js";
// WP-01..07：治理模块纳入生产闭包（供 trace/测试/审计脚本复用，无行为旁路）
export {
  resolveRunRouting,
  assertModelCallMatchesLock,
  assertModelCallMatchesLockOrThrow,
  fingerprintRunRouting,
  toGenerationModelLock,
  toJudgeModelLock,
} from "./run-routing-context.js";
export type { RunRoutingContext, WriterModelChoice } from "./run-routing-context.js";
export {
  classifyRoute,
  listRouteCatalog,
  validateRouteCatalog,
  assertCallerAllowed,
  assertProductionCallerIsolation,
  modelVersionIsolationKey,
  isSameModelVersionBucket,
} from "./route-catalog.js";
export type { RouteClass, RouteMetadata } from "./route-catalog.js";
export {
  createLayeredBudget,
  reserveLayeredBudget,
  settleLayeredBudget,
  snapshotLayeredBudget,
  canAffordModelCall,
  computeChapterCostBreakdown,
  DEFAULT_LAYERED_BUDGET,
} from "./layered-budget.js";
export type { LayeredBudget, BudgetStage, BudgetType } from "./layered-budget.js";
export {
  FAILURE_STRATEGY_MATRIX,
  getFailureStrategyRule,
  classifyFailureType,
  decideFailureStrategy,
  assertNoCrossModelDisguise,
  appendAttemptHistory,
} from "./failure-strategy-matrix.js";
export type { FailureType, FailureStrategyDecision } from "./failure-strategy-matrix.js";
export {
  computeLatencyStats,
  estimateCallCost,
  buildCostReport,
  buildRoutingStabilityReport,
  buildLongTailReport,
  projectModelCallEntry,
  assertAllCallsHaveTraceCost,
} from "./model-call-observability.js";
export type { ObservableModelCall, LatencyStats, CostReport } from "./model-call-observability.js";
export {
  computeJointQualityCostScore,
  aggregateQualityCostObservations,
  evaluateCostReductionGuard,
  assertSingleModelVersionBucket,
} from "./quality-cost-metrics.js";
export type { QualityCostObservation, QualityCostAggregate } from "./quality-cost-metrics.js";
export {
  createRoutingGovernanceState,
  reserveForModelCall,
  settleModelCall,
  recordFailureStrategy,
  buildGovernanceReports,
  attachGovernanceReports,
} from "./routing-governance-runtime.js";
export type {
  RoutingGovernanceState,
  GovernanceReports,
} from "./routing-governance-runtime.js";
import { compileContextSafety, createConstraintManifest } from "./context-safety.js";
import { compileProductionContextPackage } from "./context-package-production.js";
import type { ContextPackage } from "./trust/context-package.js";
// EVOLUTION-RELEASE-GOVERNANCE-G6：生产入口发行治理门禁
// 真相源：docs/evolution-release-governance-development-plan.md §Phase G6
// 在 ContextCompiler 之前执行；未审批 release / fingerprint 不匹配 / 无 active pointer 时 hard block。
// PINOVEL_DEV_MODE=1 时 bypass（非生产开发模式）；evalMode 在上方已 bypass（不进入此处）。
import { evaluateProductionReleaseGate } from "../governance/production-release-gate.js";
import {
  resolveWriterPromptProfile,
  type WriterPromptProfile,
} from "./model-prompt-adapter.js";
import { loadPromptPatternLibrary } from "./prompt-pattern-library.js";
// P2 H1 修复（2026-07-23）：buildStagedStateUpdate 已抽到 staged-state-builder.ts，
// 供 unified-entry.ts 与 chapter-proxy-approval-finalization-entry.ts 共用
// （unified-entry.ts 不在 dist-test 编译范围，直接 import 会破坏测试构建）。
// 原内联 compileOntologyContract 依赖随 buildStagedStateUpdate 迁出，此处不再需要。
import { buildStagedStateUpdate } from "./staged-state-builder.js";

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

/**
 * Phase 2B：加载 workspace config.targetWordCount.perChapter（字数软目标）。
 *
 * 从 workspaces/{id}/config.json 的 targetWordCount.perChapter.{min,max} 读取，
 * 用于注入 Agentic GenerationPacket 作为字数软目标（非硬性约束，模型可自由调整）。
 *
 * 读取失败或字段缺失时返回 undefined（由 agentic-raw-candidate-source 使用默认预算）。
 */
function loadTargetWordCount(workspaceId: string, projectRoot: string): { min: number; max: number } | undefined {
  try {
    const configPath = join(projectRoot, "workspaces", workspaceId, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      targetWordCount?: { perChapter?: { min?: unknown; max?: unknown } };
    };
    const perChapter = config.targetWordCount?.perChapter;
    if (!perChapter) return undefined;
    const min = typeof perChapter.min === "number" && Number.isFinite(perChapter.min) ? perChapter.min : undefined;
    const max = typeof perChapter.max === "number" && Number.isFinite(perChapter.max) ? perChapter.max : undefined;
    if (min === undefined || max === undefined) return undefined;
    if (min <= 0 || max <= 0 || min > max) return undefined;
    return { min, max };
  } catch {
    return undefined;
  }
}

/**
 * P0-2 修复（Phase 1 整改）：加载 workspace config.worldKeyTerms 全部实体数组。
 *
 * 用于 Story Preservation 门禁的完整实体表（full_entities）。汇总 factions（组织）、
 * places（地点）、currencies（物品/货币）、professions（职业）、specialAbilities（能力）、
 * levels（境界/等级）。levels 字段通常是长描述串（如"炼体（锻骨/淬腑/...）"），
 * 取括号内子项切分；其他字段已是短实体名，直接使用。
 *
 * 读取失败或字段缺失时返回空数组（不阻断；由 characterNames 兜底）。
 */
function loadWorldKeyEntities(workspaceId: string, projectRoot: string): string[] {
  try {
    const configPath = join(projectRoot, "workspaces", workspaceId, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      worldKeyTerms?: Record<string, unknown>;
    };
    const terms = config.worldKeyTerms;
    if (!terms || typeof terms !== "object") return [];
    const entities: string[] = [];
    for (const key of Object.keys(terms)) {
      const value = terms[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (typeof item !== "string") continue;
        const trimmed = item.trim();
        if (trimmed.length < 2) continue;
        // levels 字段形如 "炼体（锻骨/淬腑/易筋/洗髓/金身/法相/归一）"，
        // 取主名 + 括号内子项分别作为实体。
        entities.push(trimmed);
        const parenMatch = trimmed.match(/[（(]([^）)]+)[）)]/);
        if (parenMatch) {
          const inner = parenMatch[1].split(/[\/、，,]/);
          for (const sub of inner) {
            const s = sub.trim();
            if (s.length >= 2) entities.push(s);
          }
        }
      }
    }
    return entities;
  } catch {
    return [];
  }
}

/**
 * P0-2 修复（Phase 1 整改）：汇聚完整实体表供 Story Preservation 门禁使用。
 *
 * 合并角色名+别名 与 worldKeyTerms 全部实体数组，去重，保留 ≥2 字符项。
 * 返回 null 表示无 worldKeyTerms 实体（orchestrator 回退 characterNames + characters_only）。
 */
function buildKnownEntities(characterNames: string[], worldKeyEntities: string[]): string[] | null {
  if (worldKeyEntities.length === 0) return null;
  const merged = [...characterNames, ...worldKeyEntities]
    .filter((e) => e && e.trim().length >= 2)
    .map((e) => e.trim());
  return [...new Set(merged)];
}

/**
 * P0 第五轮 P1 修复：从 seed.characters 构建别名→规范名映射。
 *
 * 每个角色的 `name` 作为规范名，其 `aliases` 全部映射到该规范名；
 * 规范名自身也映射到自身（幂等，便于无条件查表）。仅保留 ≥2 字符的非空项。
 *
 * 用途：传入 Story Preservation Gate 的 extractEvents，使 raw 文本用 "叶尘" 与
 * editorial 文本用 "小尘"（别名）时，抽取出的 subject 都规范化为 "叶尘"，比对命中。
 *
 * @param characters seed 角色列表（含 name 与可选 aliases）
 * @returns alias→canonical 映射；无角色时返回空 Map（不做规范化）
 */
function buildAliasToCanonical(
  characters: ReadonlyArray<{ name: string; aliases?: string[] }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of characters) {
    const canonical = c.name?.trim();
    if (!canonical || canonical.length < 2) continue;
    map.set(canonical, canonical);
    for (const alias of c.aliases ?? []) {
      const a = alias?.trim();
      if (a && a.length >= 2) map.set(a, canonical);
    }
  }
  return map;
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
  /**
   * eval-only：覆盖 Agentic loop 的"强制跨源检索"prompt 决策规则。
   * 生产路径不传（undefined），loop 用默认强制检索 prompt（行为不变）。
   * eval 路径传入不确定性驱动决策规则，用于 A/B 对照实验。
   */
  retrievalPromptOverride?: string;
  /** Eval intent（跳过 ChapterIntentBuilder）；B0/B1 用空 intent，B2/B3/B4 用完整 intent */
  evalIntent?: ChapterIntent;
  /** Eval context（跳过 ContextCompiler）；B0 用空 context，B1/B2/B3/B4 用含 worldRules 的 context */
  evalContext?: CompiledContext;
  /** Eval modelGenerate（跳过 legacy modelGenerate 构造）；eval 必须传入以控制路由 */
  evalModelGenerate?: ModelGenerateFn;
  /** Eval 异构仲裁 modelGenerate（B4 judge 用）；不传则复用 evalModelGenerate */
  evalArbitratorModelGenerate?: ModelGenerateFn;
  /** Eval 生成模型对应的提示词表达层；用于模型适配消融。 */
  evalPromptProfile?: WriterPromptProfile;
  /**
   * Eval 已知角色名（DEMO-3-R2.4 新增）。
   * 传入 StoryPreservationGate 的 knownEntities，使 R2.2 门禁能在真实管线内执行。
   * 不传时为空数组（门禁返回 unverifiable）。
   */
  evalCharacterNames?: string[];
}

function validateQualityExperiment(
  experiment: import("./types.js").QualityExperimentControl | undefined,
  fullPipelinePreview: boolean,
  sceneSolution: import("./scene-solution-search.js").SceneSolutionCard | null | undefined,
): void {
  if (!experiment) return;
  if (!fullPipelinePreview) {
    throw new Error("qualityExperiment requires fullPipelinePreview=true");
  }
  if (!["raw", "scene", "oracle_scene"].includes(experiment.arm)) {
    throw new Error(`unsupported quality experiment arm: ${String(experiment.arm)}`);
  }
  if (!Number.isInteger(experiment.sampleIndex) || experiment.sampleIndex < 1 || experiment.sampleIndex > 3) {
    throw new Error("quality experiment sampleIndex must be an integer between 1 and 3");
  }
  if (experiment.arm === "raw" && sceneSolution) {
    throw new Error("raw quality experiment must not include sceneSolution");
  }
  if (experiment.arm !== "raw" && !sceneSolution) {
    throw new Error(`${experiment.arm} quality experiment requires sceneSolution`);
  }
}

// ============================================================================
// REAL-QUALITY-1-PREFLIGHT：单次路由锁定（modelTestRoute → nb4_*_glm）
// ============================================================================

/**
 * modelTestRoute → GLM 路由锁映射（REAL-QUALITY-1-PREFLIGHT，eval/测试用）。
 *
 * 让 novel_generate_chapter 在显式传入 modelTestRoute 时锁定到指定模型路由，
 * 用于评测/对比测试。生产默认（modelTestRoute=undefined）走统一主链路：
 * NovelOS Agentic → 作者风格整章优化 → 事实复检 → 原子保存，不调用机器文学裁判。
 *
 * Phase 1 整改（2026-07-28）：生产路径已移除 raw → opportunity judge → editorial
 * candidate → pairwise judge → select 旧链路。该旧链路仅在 evalMode=B4 等
 * 隔离评测路径中保留。modelTestRoute 锁定的 judgeRoute 仅供 eval/测试调用，
 * 生产路径不触发。
 *
 * 冻结约束：
 * - modelTestRoute="glm" 时，生成调用走 nb4_generate_glm，判断调用走 nb4_judge_glm。
 *   两条路由在 config/model-routing.json 中 fallback=[]，禁止任何
 *   GPT/Claude/Doubao/ERNIE fallback（项目约束：临时/批量测试仅允许 GLM/Doubao）。
 * - 候选语义 route 仍保持 v2_rawstage2 / v2_amplified（由 wrapModelGenerateLockedToRoute
 *   保持 output.route 不变，仅覆盖底层调用 route），不破坏选择、trace 和报告契约。
 * - 不改 prompt/winner/finalText/候选数量/文学判断规则。
 *
 * @returns 锁定映射（generateRoute/judgeRoute）；非 "glm"/"doubao"/"gpt56" 返回 null（不锁定，走默认路由）
 */
export function resolveModelTestRouteLock(
  modelTestRoute: string | undefined,
): { generateRoute: string; judgeRoute: string; provider: string; model: string } | null {
  if (modelTestRoute === "glm") {
    return {
      generateRoute: "nb4_generate_glm",
      judgeRoute: "nb4_judge_glm",
      provider: "glm",
      model: "glm-5.2",
    };
  }
  if (modelTestRoute === "doubao") {
    return {
      generateRoute: "nb4_generate_doubao",
      judgeRoute: "v2_opportunity_judge",
      provider: "doubao",
      model: "doubao-seed-2-1-pro-260628",
    };
  }
  if (modelTestRoute === "gpt56") {
    return {
      generateRoute: "nb4_generate_gpt56",
      judgeRoute: "v2_opportunity_judge",
      provider: "gpt",
      model: "gpt-5.6-sol",
    };
  }
  if (modelTestRoute === "claude48") {
    return {
      generateRoute: "nb4_generate_claude48",
      judgeRoute: "v2_opportunity_judge",
      provider: "claude",
      model: "claude-opus-4-8",
    };
  }
  if (modelTestRoute === "fable5") {
    return {
      generateRoute: "nb4_generate_fable5",
      judgeRoute: "v2_opportunity_judge",
      provider: "claude",
      model: "claude-fable-5",
    };
  }
  if (modelTestRoute === "grok45") {
    return {
      generateRoute: "nb4_generate_grok45",
      judgeRoute: "v2_opportunity_judge",
      provider: "grok45",
      model: "grok-4.5",
    };
  }
  if (modelTestRoute === "gemini31") {
    return {
      generateRoute: "nb4_generate_gemini31",
      judgeRoute: "v2_opportunity_judge",
      provider: "gemini31",
      model: "gemini-3.1-pro",
    };
  }
  return null;
}

export interface WriterModelRouteLock {
  rawRoute: string;
  amplifiedRoute: string;
  judgeRoute: string;
  provider: string;
  model: string;
  promptProfile: WriterPromptProfile;
}

/** Resolve the production writer without changing the heterogeneous GPT judge. */
export function resolveWriterModelRouteLock(
  writerModel: "claude" | "gemini31" | undefined,
): WriterModelRouteLock | null {
  if (writerModel === "claude") {
    return {
      rawRoute: "v2_rawstage2",
      amplifiedRoute: "v2_amplified",
      judgeRoute: "v2_opportunity_judge",
      provider: "claude",
      model: "claude-opus-4-6",
      promptProfile: "claude_writer_v1",
    };
  }
  if (writerModel === "gemini31" || writerModel === undefined) {
    return {
      rawRoute: "v2_rawstage2_gemini31",
      amplifiedRoute: "v2_amplified_gemini31",
      judgeRoute: "v2_opportunity_judge",
      provider: "gemini31",
      model: "gemini-3.1-pro",
      promptProfile: "gemini_writer_v2",
    };
  }
  return null;
}

type RetrievedExpectation = NonNullable<LongTermStateSnapshot["expectation"]>[number];

const ACTIVE_EXPECTATION_STATUS_RANK: Readonly<Record<string, number>> = {
  escalated: 4,
  delayed: 3,
  advanced: 2,
  open: 1,
};

/**
 * Select only chapter-relevant, non-terminal expectations from the already
 * future-filtered ContextCompiler snapshot. This is intent evidence only: it
 * neither writes ExpectationLedger state nor grants literary authority.
 */
function selectExpectationsForIntent(
  expectations: readonly RetrievedExpectation[],
  currentPressure: readonly string[],
  targetEmotions: readonly string[],
): RetrievedExpectation[] {
  const pressureSignals = currentPressure.map((value) => value.trim()).filter(Boolean);
  const emotionSignals = targetEmotions.map((value) => value.trim()).filter(Boolean);

  return expectations
    .map((expectation, index) => ({
      expectation,
      index,
      statusRank: ACTIVE_EXPECTATION_STATUS_RANK[expectation.status] ?? 0,
      relevance: expectationRelevance(expectation, pressureSignals, emotionSignals),
    }))
    .filter((item) => item.statusRank > 0)
    .sort((left, right) =>
      right.statusRank - left.statusRank
      || right.relevance - left.relevance
      || left.index - right.index
    )
    .slice(0, 3)
    .map((item) => item.expectation);
}

function expectationRelevance(
  expectation: RetrievedExpectation,
  pressureSignals: readonly string[],
  emotionSignals: readonly string[],
): number {
  const description = expectation.description.trim();
  const readerExperience = expectation.targetReaderExperience?.trim() ?? "";
  let score = 0;

  for (const pressure of pressureSignals) {
    if (description.includes(pressure) || pressure.includes(description)) score += 2;
  }
  for (const emotion of emotionSignals) {
    if (description.includes(emotion) || readerExperience.includes(emotion)) score += 1;
  }
  return score;
}

function expectationEvidenceKey(expectation: {
  expectationId: string;
  sourceChapter: string;
  sourceRef?: string;
}): string {
  return `${expectation.expectationId}\u0000${expectation.sourceChapter}\u0000${expectation.sourceRef ?? ""}`;
}

/** Select bounded, chapter-relevant pressure instead of forwarding every open ledger item. */
export function selectChapterPressureSignals(seed: ChapterSeed): string[] {
  const contract = seed.authorChapterContract;
  const authorText = [
    contract.chapterFunction,
    ...contract.eventSummaries,
    ...contract.mustInclude,
    ...contract.stateChanges,
    ...contract.foreshadowing,
    ...contract.causalRelations,
    contract.endingTarget,
    ...contract.relevantCharacters,
  ].filter((value): value is string => Boolean(value?.trim())).join("\n");
  const bridgeText = [
    seed.previousChapterContinuation.lastEventSummary,
    ...seed.previousChapterContinuation.openHooks,
    ...seed.previousChapterContinuation.unresolvedTensions,
  ].filter((value): value is string => Boolean(value?.trim())).join("\n");
  const relevanceText = `${authorText}\n${bridgeText}`;
  const selected: string[] = [];
  const add = (value: string | undefined): void => {
    const normalized = value?.trim();
    if (normalized && !selected.includes(normalized) && selected.length < 8) selected.push(normalized);
  };

  seed.previousChapterContinuation.openHooks.slice(0, 2).forEach(add);
  seed.previousChapterContinuation.unresolvedTensions.slice(0, 2).forEach(add);
  seed.currentPressure.pendingCosts.slice(0, 2).forEach((entry) =>
    add(`${entry.action}的代价：${entry.cost}`));

  for (const entry of seed.currentPressure.pendingForeshadowing) {
    const directlySelected = contract.foreshadowing.some((value) =>
      value.includes(entry.id) || value.includes(entry.description) || entry.description.includes(value));
    const chapterMatched = relevanceText.includes(entry.id) || relevanceText.includes(entry.description);
    if (directlySelected || chapterMatched) add(entry.description);
  }
  for (const arc of seed.currentPressure.openArcs) {
    if (relevanceText.includes(arc.arcId) || relevanceText.includes(arc.name)
      || (arc.coreQuestion && relevanceText.includes(arc.coreQuestion))) {
      add(arc.coreQuestion ? `${arc.name}：${arc.coreQuestion}` : arc.name);
    }
  }
  return selected;
}

/** Route only prose generation calls; calibration and judge routes retain their own providers. */
export function wrapModelGenerateForWriterLock(
  modelGenerate: ModelGenerateFn,
  lock: WriterModelRouteLock | null,
): ModelGenerateFn {
  if (!lock) return modelGenerate;
  return async (input: ModelGenerateInput) => {
    const forcedRoute = input.route === "v2_rawstage2"
      ? lock.rawRoute
      : input.route === "v2_amplified"
        ? lock.amplifiedRoute
        : input.route;
    if (forcedRoute === input.route) return modelGenerate(input);
    input.requestedRoute = forcedRoute;
    const output = await modelGenerate({ ...input, route: forcedRoute });
    return { ...output, route: input.route, requestedRoute: forcedRoute };
  };
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
 *   与 SelectionPolicy / JudgeArbitrator 的语义映射保持不变，不破坏选择/trace/报告契约。
 * - output.requestedRoute 设为 forcedRoute，由 orchestrate 的 wrapModelFn 透传到
 *   modelCallLog.requestedRoute（成功路径），提供"实际请求路由"证据（计划 §trace requestedRoute）。
 * - output.provider/model 由底层 fn 透传（stub 推导 / legacy 从 usedProvider/usedModel 读取）。
 *
 * 与 eval-pipeline-adapter.wrapModelGenerateWithRoute 的区别：
 * 后者不保留 output.route 语义（eval benchmark 不关心 candidate.route 契约）；
 * 本函数为生产路径设计，必须保留语义 route 以不破坏 SelectionPolicy 契约。
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
// P2 H1 修复（2026-07-23）：buildStagedStateUpdate + mapIntentPrimaryToExpectationType
// 已抽到 ./staged-state-builder.ts，供 unified-entry.ts（dist/）与
// chapter-proxy-approval-finalization-entry.ts（dist/ + dist-test/）共用。
// 详见上方 import { buildStagedStateUpdate } from "./staged-state-builder.js"。
//
// 保留 re-export 维持向后兼容：现有测试（tests/staged-state-realm-transition.test.mjs /
// tests/audit-fixes-negative.test.mjs）从 dist/v2/core/unified-entry.js 导入
// buildStagedStateUpdate，本 re-export 确保其继续可用，无需同步修改测试。
export { buildStagedStateUpdate } from "./staged-state-builder.js";

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
/**
 * 测试/审计用：导出与生产相同的 trace record 构建逻辑，
 * 供治理字段 quality-trace 持久化验收（不改变生产调用路径）。
 */
export function buildTraceRecordsFromOrchResultForTest(
  orchResult: UnifiedOrchestratorOutput,
  contextHash: string,
  releaseGovernance?: V2TraceRecord["releaseGovernance"],
  bundleInfo?: { bundleId: string; hashDimensions: string[] },
): V2TraceRecord[] {
  return buildTraceRecordsFromOrchResult(
    orchResult,
    contextHash,
    releaseGovernance,
    bundleInfo,
  );
}

function buildTraceRecordsFromOrchResult(
  orchResult: UnifiedOrchestratorOutput,
  contextHash: string,
  releaseGovernance?: V2TraceRecord["releaseGovernance"],
  bundleInfo?: { bundleId: string; hashDimensions: string[] },
): V2TraceRecord[] {
  const records: V2TraceRecord[] = [];
  const now = new Date().toISOString();
  const candidates = orchResult.candidates ?? [];
  const rawCandidate =
    candidates.find((c) => c.kind === "context_enhanced") ?? candidates[0];
  const rawCandidateId = rawCandidate?.id ?? `candidate:raw:${orchResult.chapterId}`;

  const productionFlow = orchResult.stageResults.productionFlow as { mode?: string } | undefined;
  // 1. rawstage2_generated — 仅旧评测/兼容路径记录 one-shot raw
  if (rawCandidate && productionFlow?.mode !== "agentic_style_full_pipeline") {
    records.push({
      stage: "rawstage2_generated",
      timestamp: now,
      rawStage2CandidateId: rawCandidate.id,
      rawStage2TextLength: rawCandidate.text.length,
      contextHash,
    });
  }

  if (productionFlow?.mode === "agentic_style_full_pipeline") {
    const agentic = candidates.find((candidate) => candidate.kind === "agentic_raw");
    if (agentic) {
      records.push({
        stage: "novelos_agentic",
        timestamp: now,
        novelos: {
          ...(orchResult.stageResults.novelos as Record<string, unknown> ?? {}),
          shadowEnabled: false,
          required: true,
          candidateId: agentic.id,
          candidateLength: agentic.text.length,
        },
        contextHash,
      });
    }
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
  if (orchResult.judgeResult && productionFlow?.mode !== "agentic_style_full_pipeline") {
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
  // P2 修复（Phase 1 整改）：blocked 运行不写 final_selected。
  // 原先即使 status="blocked" 也写 final_selected，且 selectedSource 被强制为
  // "v2_amplified"/"rawStage2"，把未交付的阻断伪装成有交付来源。审计 P2 指出这会让
  // trace 读者误以为阻断运行已交付正文。修复后：blocked 路径只写 error 记录（见 #5），
  // 不伪造 final_selected；仅 status="ok" 才记录最终选择。
  if (orchResult.status !== "blocked") {
    const selectedSource: FinalSelectedSource = productionFlow?.mode === "agentic_style_full_pipeline"
      ? "v2_amplified"
      : orchResult.selectedSource === "editorial" ? "v2_amplified" : "rawStage2";
    const projectGain: ProjectGain =
      orchResult.selectedSource === "editorial" ? "positive" : "neutral";
    const finalSelection: FinalSelectionReport = {
      selectedCandidateId: orchResult.selectedCandidateId || rawCandidateId,
      selectedSource,
      projectGain,
      whySelected: [
        productionFlow?.mode === "agentic_style_full_pipeline"
          ? "NovelOS Agentic 初稿经作者风格整章优化后交付，文学评价权归用户"
          : orchResult.judgeResult?.auditSummary ?? "无编辑机会或编辑未胜出，交付 raw 基线",
      ],
      whyRejected: orchResult.warnings,
      acceptedRepairs: [],
      rejectedRepairs: [],
    };
    const authorStyleStrategySelection = orchResult.stageResults.authorStyleStrategySelection as
      | {
          modelVersion?: unknown;
          selectedStrategyIds?: unknown;
          strategyBundleId?: unknown;
          orchestratorRunId?: unknown;
          exposureId?: unknown;
          promptBundleId?: unknown;
          candidateId?: unknown;
          deliveredSource?: unknown;
          sourceChapter?: unknown;
          opportunityType?: unknown;
          exposureSnapshot?: unknown;
        }
      | undefined;
    const strategyModelVersion = typeof authorStyleStrategySelection?.modelVersion === "string"
      ? authorStyleStrategySelection.modelVersion
      : typeof orchResult.stageResults.modelVersion === "string"
        ? orchResult.stageResults.modelVersion
        : null;
    const selectedStrategyIds = Array.isArray(authorStyleStrategySelection?.selectedStrategyIds)
      ? authorStyleStrategySelection.selectedStrategyIds.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [];
    const asString = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
    const sourceChapter =
      asString(authorStyleStrategySelection?.sourceChapter) ??
      (/^ch/i.test(orchResult.chapterId) ? orchResult.chapterId : `ch${orchResult.chapterId}`);
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
      // MODEL-ROUTING-GOVERNANCE：成功路径持久化完整治理报告（quality-trace 可验收）
      routingGovernance: orchResult.stageResults.routingGovernance,
      layeredBudget: orchResult.stageResults.layeredBudget,
      modelCallObservability: orchResult.stageResults.modelCallObservability,
      qualityCostAnalysis: orchResult.stageResults.qualityCostAnalysis,
      failureStrategyDecision: orchResult.stageResults.failureStrategyDecision,
      failureStrategyTrace: orchResult.stageResults.failureStrategyTrace,
      ...(strategyModelVersion
        ? {
            strategyContext: {
              modelVersion: strategyModelVersion,
              selectedStrategyIds,
              sourceChapter,
              opportunityType:
                asString(authorStyleStrategySelection?.opportunityType) ?? "author_style",
              // USER-FEEDBACK-EVIDENCE-PIPELINE-1：完整 StrategyExposure 字段落盘
              strategyBundleId: asString(authorStyleStrategySelection?.strategyBundleId),
              orchestratorRunId: asString(authorStyleStrategySelection?.orchestratorRunId),
              exposureId: asString(authorStyleStrategySelection?.exposureId),
              promptBundleId: asString(authorStyleStrategySelection?.promptBundleId),
              candidateId: asString(authorStyleStrategySelection?.candidateId),
              deliveredSource:
                authorStyleStrategySelection?.deliveredSource === "raw" ||
                authorStyleStrategySelection?.deliveredSource === "fallback" ||
                authorStyleStrategySelection?.deliveredSource === "editorial"
                  ? authorStyleStrategySelection.deliveredSource
                  : "editorial",
              exposureSnapshot: authorStyleStrategySelection?.exposureSnapshot,
            },
          }
        : {}),
      // Phase 4 C9：release governance 绑定，供 canary 证据跨 release 校验
      releaseGovernance,
    });
  }

  // 5. error — 结构化阻断时记录 failureEnvelope
  // blocked 路径的核心证据：failureEnvelope 含 stage/severity/gate/reason/recoverable。
  // 即使无 final_selected，trace 读者也能从 error 记录还原阻断原因与恢复策略。
  // P1 修复（第三轮）：使用 failureEnvelope.stage 作为 trace record 的 stage（如 "story_preservation"），
  // 并透传完整 failureEnvelope（含 gate/severity/retryPlan/userActionRequired），
  // 避免 legacy-trace-adapter 把所有 blocked 路径改写为 stage/gate=v2_error。
  if (orchResult.status === "blocked" && orchResult.failureEnvelope) {
    const fe = orchResult.failureEnvelope;
    // P1 修复（第三轮）：映射 UnifiedFailureEnvelope → FailureEnvelope，保留 gate/severity/retryPlan/userActionRequired。
    // UnifiedFailureEnvelope.severity 用 "hard"|"fatal"，FailureEnvelope 用 "hard_block"；
    // 映射时 "hard"/"fatal" → "hard_block"，"preflight"/"recoverable" 保持不变。
    // RECOVERY-P0：生产真相源优先 failureClass；severity/hard_block 仅边界兼容
    const failureClass =
      (fe as { failureClass?: string }).failureClass ??
      (fe.severity === "preflight"
        ? "preflight"
        : fe.severity === "recoverable"
          ? "recoverable"
          : fe.severity === "fatal"
            ? "fatal"
            : "blocked");
    const mappedSeverity: FailureEnvelope["severity"] =
      failureClass === "preflight"
        ? "preflight"
        : failureClass === "recoverable"
          ? "recoverable"
          : "hard_block";
    const mappedEnvelope: FailureEnvelope = {
      stage: fe.stage,
      gate: fe.gate ?? fe.stage,
      severity: mappedSeverity,
      reason: fe.reason,
      // P1 修复：evidence 不再固定 null。UnifiedFailureEnvelope 无 evidence 字段，
      // 用 reason + blockCategory + candidateDisposition 作为结构化证据。
      evidence: {
        reason: fe.reason,
        failureClass,
        recoveryAction: (fe as { recoveryAction?: string }).recoveryAction ?? null,
        blockCategory: fe.blockCategory ?? null,
        candidateDisposition: fe.candidateDisposition ?? null,
        stageResults: orchResult.stageResults,
        recoveryDecision: orchResult.stageResults?.recoveryDecision ?? null,
        recoveryCheckpoint: orchResult.stageResults?.recoveryCheckpoint ?? null,
      },
      recoverable: fe.recoverable,
      retryPlan: fe.retryPlan as FailureEnvelope["retryPlan"],
      userActionRequired: fe.userActionRequired,
    };
    records.push({
      stage: (fe.stage || "error") as V2TraceStage,
      timestamp: now,
      error: {
        message: fe.reason,
        code: fe.stage,
        recoverable: fe.recoverable,
      },
      // P1 修复：透传完整 FailureEnvelope，保留 gate/severity/retryPlan/userActionRequired
      failureEnvelope: mappedEnvelope,
      // P2 修复：blocked 路径也保留模型调用遥测与 budget，供审计阻断前的资源消耗。
      contextHash,
      modelCalls: orchResult.stageResults.modelCalls as ModelCallEntry[] | undefined,
      stageTiming: orchResult.stageResults.stageTiming as Record<string, number> | undefined,
      modelBudget: orchResult.stageResults.modelBudget as
        | { soft: number; hard: number; used: number; capped: boolean }
        | undefined,
      // MODEL-ROUTING-GOVERNANCE：blocked 路径除 evidence.stageResults 外，顶层也落盘治理报告
      routingGovernance: orchResult.stageResults.routingGovernance,
      layeredBudget: orchResult.stageResults.layeredBudget,
      modelCallObservability: orchResult.stageResults.modelCallObservability,
      qualityCostAnalysis: orchResult.stageResults.qualityCostAnalysis,
      failureStrategyDecision: orchResult.stageResults.failureStrategyDecision,
      failureStrategyTrace: orchResult.stageResults.failureStrategyTrace,
      releaseGovernance,
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
  if (novelosData && productionFlow?.mode !== "agentic_style_full_pipeline") {
    records.push({
      stage: "novelos_agentic",
      timestamp: now,
      novelos: novelosData,
      contextHash,
    });
  }

  // MODEL-PROMPT-EVOLUTION-1：为每条 trace record 注入 bundleId
  if (bundleInfo) {
    for (const r of records) {
      r.bundleId = bundleInfo.bundleId;
      r.bundleHashDimensions = bundleInfo.hashDimensions;
    }
  }

  return records;
}

export interface UnifiedTracePersistenceResult {
  status: "primary" | "fallback" | "failed";
  path?: string;
  primaryAttempts: number;
  errors: string[];
}

interface PersistUnifiedTraceInput {
  projectRoot: string;
  workspaceId: string;
  chapterId: string;
  traceRecords: V2TraceRecord[];
  adapterFactory?: (options: {
    workspacePath: string;
    workspaceId: string;
    chapterId: string;
    auditSink?: AuditEventRecorder;
  }) => V2TraceAdapter;
  /** P7 Stage A 双写：透传给 adapter 的审计事件追加口。 */
  auditSink?: AuditEventRecorder;
}

/**
 * 持久化统一主链路 trace：主路径最多 flush 两次，仍失败则原子写入 reports/traces 备用归档。
 * 章节/长期状态已在此前提交，因此这里不把 trace I/O 失败伪装成未交付章节；若备用归档也失败，
 * 返回 status=failed 让调用方在 stageResults 中显式暴露留存违约。
 */
export function persistUnifiedTraceWithFallback(
  input: PersistUnifiedTraceInput,
): UnifiedTracePersistenceResult {
  const errors: string[] = [];
  let primaryAttempts = 0;
  try {
    const adapterFactory = input.adapterFactory ?? createLegacyTraceAdapter;
    const adapter = adapterFactory({
      workspacePath: join(input.projectRoot, "workspaces"),
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      auditSink: input.auditSink,
    });
    for (const record of input.traceRecords) adapter.record(record);
    for (let attempt = 1; attempt <= 2; attempt++) {
      primaryAttempts = attempt;
      try {
        const path = adapter.flush();
        if (path) {
          return { status: "primary", path, primaryAttempts, errors };
        }
        errors.push(`primary flush attempt ${attempt} returned no path`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`primary flush attempt ${attempt} failed: ${message}`);
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`trace adapter setup failed: ${message}`);
  }

  try {
    const safeWorkspaceId = input.workspaceId.replace(/[^A-Za-z0-9_-]/g, "_");
    const safeChapterId = input.chapterId.replace(/[^A-Za-z0-9_-]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fallbackPath = join(
      input.projectRoot,
      "reports",
      "traces",
      `${safeWorkspaceId}-${safeChapterId}-quality-trace-fallback-${timestamp}.json`,
    );
    atomicSave(fallbackPath, JSON.stringify({
      schemaId: "pinovel-unified-trace-fallback-v1",
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      savedAt: new Date().toISOString(),
      primaryAttempts,
      primaryErrors: errors,
      traceRecords: input.traceRecords,
    }, null, 2));
    return { status: "fallback", path: fallbackPath, primaryAttempts, errors };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`fallback trace archive failed: ${message}`);
    return { status: "failed", primaryAttempts, errors };
  }
}

/**
 * P2 修复（Phase 1 整改）：为早期阻断/异常写最小 trace。
 *
 * 审计 P2 指出：release gate 阻断、control plane 能力拒绝、Preflight/ContextCompiler
 * 抛异常等早期退出路径不写质量 trace，导致这些运行的证据无法回放。此 helper 在
 * 这些路径上写一条 `error` trace 记录（含 failureEnvelope 摘要），使早期阻断也可审计。
 *
 * 写入失败不阻断返回（与正常路径 trace 写入一致的容错策略）。
 * fullPipelinePreview 模式不写 trace 文件（保持预览无副作用）。
 */
function persistEarlyBlockedTrace(
  projectRoot: string,
  workspaceId: string,
  chapterId: string,
  failureEnvelope: Partial<FailureEnvelope> & { stage: string; reason: string; recoverable: boolean },
  releaseGovernance?: V2TraceRecord["releaseGovernance"],
  fullPipelinePreview?: boolean,
  auditSink?: AuditEventRecorder,
): string | null {
  if (fullPipelinePreview) return null;
  try {
    const traceAdapter = createLegacyTraceAdapter({
      workspacePath: join(projectRoot, "workspaces"),
      workspaceId,
      chapterId,
      auditSink,
    });
    const now = new Date().toISOString();
    // P1 修复（第三轮）：使用 failureEnvelope.stage（如 "story_preservation"）作为 trace record 的 stage，
    // 并透传完整 failureEnvelope（含 gate/severity/retryPlan/userActionRequired），
    // 避免 legacy-trace-adapter 把所有早期阻断路径改写为 stage/gate=v2_error。
    // failureEnvelope.stage 来自 orchestrator 的 hardBlock 调用，携带具体阻断阶段信息。
    // 对于部分字段缺失的早期阻断（如 release gate / preflight / control plane），
    // 用合理默认值补齐：gate 默认为 stage，severity 默认为 hard_block。
    const fullEnvelope: FailureEnvelope = {
      stage: failureEnvelope.stage,
      gate: failureEnvelope.gate ?? failureEnvelope.stage,
      severity: failureEnvelope.severity ?? "hard_block",
      reason: failureEnvelope.reason,
      evidence: failureEnvelope.evidence ?? null,
      recoverable: failureEnvelope.recoverable,
      retryPlan: failureEnvelope.retryPlan,
      userActionRequired: failureEnvelope.userActionRequired,
    };
    const traceStage = (fullEnvelope.stage || "error") as V2TraceStage;
    traceAdapter.record({
      stage: traceStage,
      timestamp: now,
      error: {
        message: fullEnvelope.reason,
        code: fullEnvelope.stage,
        recoverable: fullEnvelope.recoverable,
      },
      // P1 修复：透传完整 FailureEnvelope
      failureEnvelope: fullEnvelope,
      contextHash: "early-blocked",
      releaseGovernance,
    });
    return traceAdapter.flush() ?? null;
  } catch (traceErr) {
    const msg = traceErr instanceof Error ? traceErr.message : String(traceErr);
    process.stderr.write(`[Unified] 早期阻断 trace 持久化失败（不阻断返回）：${msg}\n`);
    return null;
  }
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
    gate: "capability_denied",
    severity: "preflight" as const,
    reason: `capability denied: ${capability} (${reason})`,
    evidence: denial ? { decision: denial } : null,
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
    writerModel,
    modelTestRoute,
    previewOnly,
    fullPipelinePreview,
    qualityExperiment,
    boundedBestOf3,
    candidateTimeoutMs,
    previewTotalTimeoutMs,
    evalMode,
    evalPrefix,
    evalIntent,
    evalContext,
    evalModelGenerate,
    evalArbitratorModelGenerate,
    evalPromptProfile,
    evalCharacterNames,
    retrievalPromptOverride,
    sceneSolution,
    craftGenes,
    promptPatternIds,
    onUpdate,
  } = input;

  // 顶层进度推送 helper：在 orchestrate 调用前的顶层阶段（release gate / preflight /
  // context compile / intent build）推送进度，让前端尽早感知工具已启动。
  // orchestrate 内部的耗时阶段（stage1-stage6）由 timeAsync/timeSync 自动推送。
  const emitTopProgress = (
    stage: string,
    status: "start" | "done",
    message: string,
  ) => {
    if (!onUpdate) return;
    try {
      onUpdate({ stage, status, message, timestamp: new Date().toISOString() });
    } catch {
      // 进度推送失败不影响生成
    }
  };

  const promptPatternResolution = loadPromptPatternLibrary(projectRoot, {
    mode: evalMode === undefined ? "production" : "evaluation",
    ...(evalMode !== undefined && promptPatternIds
      ? { explicitPatternIds: promptPatternIds }
      : {}),
  });

  // ── FULL-PIPELINE-PREVIEW-1：归一化 previewOnly（已弃用）为 fullPipelinePreview ──
  // 旧 previewOnly 字段曾是"FactGuard 后直接返回 raw"的短路径；
  // 现归一化为完整链路只读预览（行为升级：执行完整 editorial/judge/select，但跳过所有副作用）。
  // 二者都为 true 时以 fullPipelinePreview 显式为准；都不为 true 时按正常生产链路。
  const effectiveFullPipelinePreview = Boolean(fullPipelinePreview || previewOnly);
  validateQualityExperiment(qualityExperiment, effectiveFullPipelinePreview, sceneSolution);
  if (writerModel && modelTestRoute) {
    throw new Error("writerModel 与 modelTestRoute 不能同时设置；生产写作模型与实验路由必须显式分离");
  }

  if (input.recoverBlockedRaw && !writerModel) {
    throw new Error("recoverBlockedRaw 要求显式 writerModel，以确保冻结 raw 与当前正文模型一致");
  }

  // ── bounded 超时预算：未显式传入时消费 PINOVEL_MODEL_REQUEST_TIMEOUT_MS ──
  const resolvedTimeoutMs = candidateTimeoutMs ?? getModelRequestTimeoutMs();
  if (!process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS) {
    process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS = String(resolvedTimeoutMs);
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
    const evalWriterLock = resolveWriterModelRouteLock(writerModel);
    const lockedEvalGenerate = wrapModelGenerateForWriterLock(
      evalModelGenerate,
      evalWriterLock,
    );
    const evalOrchestrator = new UnifiedOrchestrator();
    const evalControlPlane = buildTrustedControlPlane({
      taskId: `NOVEL-EVAL:${workspaceId}:${chapterId}`,
      objective: `执行 ${evalMode} 本地评估路径`,
      scope: ["eval unified pipeline", "stub/local model", "no persistence"],
      allowedResources: ["eval:model", "eval:context"],
      forbiddenResources: ["network:model", "workspace:commit", "chapter:save", "artifact:export"],
      generationLock: evalWriterLock
        ? {
            route: evalWriterLock.rawRoute,
            provider: evalWriterLock.provider,
            model: evalWriterLock.model,
          }
        : { route: "eval", provider: "local", model: "eval" },
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
      sceneSolution,
      craftGenes,
      promptPatternResolution,
      rawPromptProfile: evalPromptProfile,
      constitution: evalContext.constitution ?? null,
      characterNames: evalCharacterNames ?? [],
      modelGenerate: lockedEvalGenerate,
      arbitratorModelGenerate: evalArbitratorModelGenerate,
      timeoutMs: resolvedTimeoutMs,
      evalMode,
      evalPrefix,
      retrievalPromptOverride,
      agenticCandidateSource: evalAgenticSource,
      controlPlane: evalControlPlane,
      _priorBudgetLedger: input._priorBudgetLedger,
      onUpdate,
    });
    // Eval 模式不写 trace / 不保存策略信誉库 / 不提交状态（编排器 evalMode 已跳过 commitAndSave）
    // Eval 也不写 AuditEventStore（评估隔离；生产事实链从下方非 eval 路径开始）。
    return mapOrchResultToV2Output(
      evalOrchResult, workspaceId, chapterId, chapterNumber, [], []
    );
  }

  // ── AUDIT-1 Phase 3 最小切片：run 生命周期 + failure_recorded ──────────
  // fullPipelinePreview 仅内存（不落盘），正式生产 persist=true → events.jsonl。
  // 所有生产返回经 seal() 保证 run_started + 终止事件；未捕获异常写 run_interrupted。
  const auditSession = createAuditRunSession({
    projectRoot,
    workspaceId,
    chapterId,
    chapterNumber,
    persist: !effectiveFullPipelinePreview,
  });
  const seal = <T extends V2Output>(output: T): T => auditSession.attachToOutput(output);

  try {
  auditSession.start({
    fullPipelinePreview: effectiveFullPipelinePreview,
    modelTestRoute: modelTestRoute ?? null,
    writerModel: writerModel ?? null,
  });

  // TrustAudit 并发隔离：整条生产主路径绑定本 run 的 ALS 上下文，
  // 防止单进程并发生成时 trust 事件串写到其它 run 的 events.jsonl。
  return await auditSession.runInTrustContextAsync(async () => {

  // ── G6: 生产入口发行治理门禁（计划 §Phase G6） ──────────────────────
  // 在 ContextCompiler 之前执行：未审批 release / fingerprint 不匹配 / 无 active pointer
  // 时 hard block，避免未审批策略、prompt 和 dirty build 静默进入生产。
  // - PINOVEL_DEV_MODE=1 时 bypass（非生产开发模式）
  // - evalMode 已在上方 bypass（eval 模式不修改 active pointer，由调用方决定）
  // 门禁失败时返回结构化 FailureEnvelope（stage=g6_release_gate），与统一主链路
  // 其他 failureEnvelope 形状一致；stageResults.releaseGovernance 记录门禁决策。
  const evalCandidateReleaseId =
    process.env.PINOVEL_EVAL_ONLY === "1" &&
    process.env.PINOVEL_DEV_MODE !== "1"
      ? process.env.PINOVEL_EVAL_RELEASE_ID?.trim() || ""
      : "";
  const releaseGateResult = evaluateProductionReleaseGate({
    projectRoot,
    workspacesRoot: join(projectRoot, "workspaces"),
    ...(process.env.PINOVEL_FINGERPRINT_ROOT
      ? { fingerprintRoot: process.env.PINOVEL_FINGERPRINT_ROOT }
      : {}),
    ...(evalCandidateReleaseId
      ? {
          targetReleaseId: evalCandidateReleaseId,
          requireActiveApproval: process.env.PINOVEL_EVAL_REQUIRE_ACTIVE_APPROVAL === "1",
        }
      : {}),
  });
  const releaseGovernanceTrace = {
    devMode: releaseGateResult.devMode,
    releaseId: releaseGateResult.ok ? releaseGateResult.releaseId : null,
    environmentFingerprint: releaseGateResult.ok ? releaseGateResult.environmentFingerprint : null,
    approvalRef: releaseGateResult.ok ? releaseGateResult.approvalRef : null,
    canaryEvidenceRunId: releaseGateResult.ok ? releaseGateResult.canaryEvidenceRunId : null,
    // DG-3：release 行为身份（bundleId / modelVersion / 组件 hash）写入生产 trace，
    // 满足计划 §5 DG-3 验收「生产 trace 100% 含 releaseId/bundleId/modelVersion 及关键组件 hash」。
    behaviorIdentity: releaseGateResult.ok ? releaseGateResult.behaviorIdentity : null,
  };
  if (!releaseGateResult.ok) {
    // P2 修复（Phase 1 整改）：release gate 阻断也写 trace，使早期阻断可审计。
    persistEarlyBlockedTrace(
      projectRoot,
      workspaceId,
      chapterId,
      // P1 修复：透传完整 release gate failureEnvelope（含 gate/severity/retryPlan/userActionRequired）
      releaseGateResult.failureEnvelope,
      releaseGovernanceTrace,
      effectiveFullPipelinePreview,
      auditSession,
    );
    return seal({
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
    });
  }

  // ── Phase 2A：完整 Preflight 接入（计划 §2A） ──────────────────────────
  // 在 release gate 通过后、ContextCompiler 之前执行 workspace 预检。
  // 把"前置条件缺失"（config 缺字段 / 角色档案缺失 / 前章连续性失效 / ChapterSeed 不可生长 /
  // 显式章纲解析失败 / 模型 timeout 无效 / 字数预算倒挂）从"模型随机失败"中分离出来，
  // 避免浪费模型预算。预检失败返回 severity=preflight 阻断，不进入模型调用。
  //
  // 跳过条件（与 orchestrator 内 Phase 1 兜底检查一致）：
  // - evalMode 已在上方 return，不会到达此处
  // - qualityExperiment（隔离质量天花板采样，不交付正式正文）
  // - fullPipelinePreview（只读链路预览，不交付正式正文）
  //
  // 预检通过但 warnings 非空 → 写入 stageResults.preflightWarnings，不阻断。
  // 预检失败 → 写早期 trace + 返回 blocked + failureEnvelope(stage=preflight, severity=preflight)。
  const preflightReport: PreflightWorkspaceReport | null =
    !qualityExperiment && !effectiveFullPipelinePreview
      ? preflightWorkspace({
          workspacePath: join(projectRoot, "workspaces", workspaceId),
          workspaceId,
          chapterId,
          chapterNumber,
          projectRoot,
        })
      : null;
  if (preflightReport && !preflightReport.passed) {
    const preflightReason = formatPreflightWorkspaceReport(preflightReport);
    persistEarlyBlockedTrace(
      projectRoot,
      workspaceId,
      chapterId,
      {
        stage: "preflight",
        gate: "preflight",
        severity: "preflight",
        reason: preflightReason,
        evidence: preflightReport.blockingItems,
        recoverable: false,
      },
      releaseGovernanceTrace,
      effectiveFullPipelinePreview,
      auditSession,
    );
    return seal({
      status: "blocked",
      workspaceId,
      chapterId,
      chapterNumber,
      text: "",
      candidates: [],
      diagnostics: [],
      failureEnvelope: {
        stage: "preflight",
        gate: "preflight",
        severity: "preflight",
        reason: preflightReason,
        evidence: preflightReport.blockingItems,
        recoverable: false,
        degradedTo: "hard_block",
        userActionRequired: preflightReport.fixInstructions,
        prohibitedActions: [
          "accept_or_deliver_blocked_candidate",
          "save_blocked_candidate_as_chapter",
        ],
      },
      stageResults: {
        unifiedPipeline: true,
        preflight: {
          passed: false,
          blockingItems: preflightReport.blockingItems,
          warnings: preflightReport.warnings,
          fixInstructions: preflightReport.fixInstructions,
        },
        releaseGovernance: releaseGovernanceTrace,
      },
      isPreviewRun: effectiveFullPipelinePreview,
      selectedSource: null,
      selectedCandidateId: "",
      isUnderSpecified: false,
    });
  }

  const useStub =
    process.env.V2_FORCE_STUB === "1" || process.env.PINOVEL_ADMISSION_STUB === "1";
  // F4-4：eval 回放传输解析（recorded > synthetic > stub > legacy）。
  // PINOVEL_EVAL_REPLAY_TRANSPORT 是模式声明（由 buildReplayIsolationEnv 携带）：
  // 声明了 recorded/synthetic 却缺少对应传输 env 时 fail-closed 抛错，
  // 防止传输 env 在子进程交接中丢失后静默回退网络或 stub（污染回放证据）。
  const declaredEvalTransport = process.env.PINOVEL_EVAL_REPLAY_TRANSPORT?.trim() || null;
  let evalReplayTransport: ModelGenerateFn | null = null;
  if (declaredEvalTransport === "recorded" || declaredEvalTransport === "synthetic") {
    evalReplayTransport = createEvalReplayModelGenerateFnFromEnv();
    if (evalReplayTransport === null) {
      throw new Error(
        `[eval-replay-fail-closed] PINOVEL_EVAL_REPLAY_TRANSPORT=${declaredEvalTransport} 但未提供对应传输 env（PINOVEL_EVAL_RECORDED_RESULTS_PATH / PINOVEL_EVAL_SYNTHETIC_FAULTS[_PATH]），拒绝静默回退网络或 stub`,
      );
    }
  } else if (declaredEvalTransport === "stub") {
    if (!useStub) {
      throw new Error(
        "[eval-replay-fail-closed] PINOVEL_EVAL_REPLAY_TRANSPORT=stub 但 V2_FORCE_STUB!=1，拒绝回退真实模型",
      );
    }
  } else if (declaredEvalTransport !== null) {
    throw new Error(
      `[eval-replay-fail-closed] 未知 PINOVEL_EVAL_REPLAY_TRANSPORT=${declaredEvalTransport}（合法值：stub/recorded/synthetic）`,
    );
  }
  const testRouteLock = resolveModelTestRouteLock(modelTestRoute);
  const writerRouteLock = testRouteLock ? null : resolveWriterModelRouteLock(writerModel);
  // WP-01：任务级路由一次解析并冻结（与 writer/test lock 对齐，不另建第二套路由）。
  const runRouting: RunRoutingContext = resolveRunRouting({
    writerModel: writerModel === "claude" || writerModel === "gemini31" ? writerModel : undefined,
    modelTestRoute: modelTestRoute ? String(modelTestRoute) : undefined,
    budgetProfile: testRouteLock ? "eval_lab" : effectiveFullPipelinePreview ? "preview" : "production_default",
    caller: "novel_generate_chapter",
  });
  void fingerprintRunRouting(runRouting);
  const generationModelLock = testRouteLock
    ? { route: testRouteLock.generateRoute, provider: testRouteLock.provider, model: testRouteLock.model }
    : writerRouteLock
      ? { route: writerRouteLock.rawRoute, provider: writerRouteLock.provider, model: writerRouteLock.model }
    : { ...runRouting.generationLock };
  const judgeModelLock = testRouteLock
    ? { route: testRouteLock.judgeRoute, provider: "gpt", model: "gpt-5.6-sol" }
    : writerRouteLock
      ? { route: writerRouteLock.judgeRoute, provider: "gpt", model: "gpt-5.6-sol" }
    : { ...runRouting.judgeLock };
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
    modelTransport: evalReplayTransport || useStub ? "stub" : "network",
    enforceModelLocks: true,
  });
  const stateReadDecision = controlPlane.policy.authorize(
    "state.read",
    `load workspace context: ${workspaceId}`,
  );
  if (!stateReadDecision.allowed) {
    // P2 修复（Phase 1 整改）：control plane 能力拒绝也写 trace。
    persistEarlyBlockedTrace(
      projectRoot, workspaceId, chapterId,
      { stage: "control_plane_state_read", gate: "capability_denied", severity: "hard_block", reason: "capability denied: state.read (workspace context read denied)", evidence: { capability: "state.read", denial: stateReadDecision }, recoverable: false },
      releaseGovernanceTrace, effectiveFullPipelinePreview, auditSession,
    );
    return seal(buildEntryControlPlaneBlockedOutput(
      input,
      controlPlane,
      "state.read",
      "workspace context read denied",
    ));
  }

  // ── 1. ContextCompiler：加载 workspace + 编译 context ──────────────────
  // ContextCompiler.compile 内部调用 loadCreativeConstitution / loadStateStore，
  // 把 constitution 与 longTermState 只读快照塞进 CompiledContext。
  // 此处只读复用 sourceSeed 派生 ChapterIntentInput，不重复加载。
  //
  // P2 修复（Phase 1 整改）：ContextCompiler 加载 workspace 文件可能抛异常。
  // 审计 P2 指出"早期 Preflight/Context 异常没有质量 trace"——原先异常直接冒泡，
  // 不写 trace，证据无法回放。现在 catch 后写早期 trace + 返回结构化 blocked。
  let compiled: ReturnType<ReturnType<typeof createContextCompiler>["compile"]>;
  let compileDiagnostics: Diagnostic[] = [];
  let evidenceSnapshot: ReturnType<typeof buildNarrativeEvidenceSnapshot> | undefined;
  try {
    const compiler = createContextCompiler();
    evidenceSnapshot = buildNarrativeEvidenceSnapshot({
      workspaceId,
      projectRoot,
      chapterNumber,
      releaseId: releaseGovernanceTrace?.releaseId ?? null,
    });
    compiled = compiler.compile({
      workspaceId,
      chapterId,
      chapterNumber,
      projectRoot,
      evidenceSnapshot,
    });
    compileDiagnostics = compiled.diagnostics ?? [];
  } catch (earlyErr) {
    const msg = earlyErr instanceof Error ? earlyErr.message : String(earlyErr);
    persistEarlyBlockedTrace(
      projectRoot, workspaceId, chapterId,
      { stage: "context_compiler", gate: "context_load", severity: "hard_block", reason: `ContextCompiler 异常：${msg}`, evidence: { error: msg }, recoverable: false },
      releaseGovernanceTrace, effectiveFullPipelinePreview, auditSession,
    );
    return seal({
      status: "blocked",
      workspaceId, chapterId, chapterNumber,
      text: "",
      candidates: [],
      diagnostics: [],
      failureEnvelope: {
        stage: "context_compiler",
        gate: "context_load",
        severity: "hard_block",
        reason: `ContextCompiler 异常：${msg}`,
        evidence: { error: msg },
        recoverable: false,
        degradedTo: "hard_block",
      },
      stageResults: { unifiedPipeline: true, earlyException: true },
      isPreviewRun: effectiveFullPipelinePreview,
      selectedSource: null,
      selectedCandidateId: "",
      isUnderSpecified: false,
    });
  }
  const context = compiled.context;
  const seed = compiled.sourceSeed;

  // ── 2. ChapterIntentBuilder：从 ChapterSeed + constitution + state 派生意图 ──
  // ChapterIntent 是创作方向（不是章纲/句式清单）。inviolableFacts 合并
  // worldConstraint.immutableFacts + highLevelDirection.immutableFacts，再由
  // builder 合并 constitution.forbiddenDrift。
  const constitution = loadCreativeConstitution(workspaceId, projectRoot);
  const stateStore = loadStateStore(workspaceId, projectRoot);
  const currentPressureSummary = selectChapterPressureSignals(seed);
  const selectedExpectations = selectExpectationsForIntent(
    context.longTermState?.expectation ?? [],
    currentPressureSummary,
    seed.intent?.targetEmotions ?? [],
  );
  const selectedExpectationKeys = new Set(selectedExpectations.map(expectationEvidenceKey));
  const intentStateStore = {
    ...stateStore,
    expectation: (stateStore.expectation ?? []).filter((expectation) =>
      ACTIVE_EXPECTATION_STATUS_RANK[expectation.status] !== undefined
      && selectedExpectationKeys.has(expectationEvidenceKey(expectation))
    ),
  };

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
    openExpectations: selectedExpectations.map((expectation) => ({
      expectationId: expectation.expectationId,
      description: expectation.description,
      targetReaderExperience: expectation.targetReaderExperience,
    })),
    openArcs: (seed.currentPressure?.openArcs ?? []).map((a) => ({
      arcId: a.arcId,
      name: a.name,
      coreQuestion: a.coreQuestion,
    })),
    // REAL-QUALITY-4：补入前章悬置状态，让 intent.currentPressure 携带前章未解张力/开放钩子，
    // 避免跨章因果断裂（此前只含 foreshadowing+openArcs，漏掉 previousChapterContinuation）。
    currentPressureSummary,
    prevContinuationAvailable: seed.previousChapterContinuation?.available ?? false,
    // INTENT-1：接线 pendingCosts（seed.currentPressure.pendingCosts），
    // 供 ChapterIntentBuilder 派生 choicesAndCosts / expectedIrreversibleChange。
    pendingCosts: seed.currentPressure?.pendingCosts ?? [],
    choicesAndCosts: seed.intent?.choicesAndCosts ?? [],
    expectedIrreversibleChange: seed.intent?.expectedIrreversibleChange ?? [],
    causalEndPressure: seed.intent?.causalEndPressure ?? [],
    authorChapterContract: seed.authorChapterContract,
    overallPlotDirection: seed.highLevelDirection?.backgroundNotes ?? [],
    previousState: [
      seed.previousChapterContinuation?.lastEventSummary,
      ...(seed.previousChapterContinuation?.openHooks ?? []),
      ...(seed.previousChapterContinuation?.unresolvedTensions ?? []),
    ].filter((value): value is string => Boolean(value?.trim())),
    // P4 M3：把 LongTermStateSnapshot.overdueAlerts 接入 ChapterIntentInput，
    // 由 ChapterIntentBuilder pass-through 到 intent.overduePressure。
    overdueAlerts: context.longTermState?.overdueAlerts ?? [],
  };

  const intentBuilder = createChapterIntentBuilder();
  const { intent, warnings: intentWarnings } = intentBuilder.build(
    intentInput,
    constitution,
    intentStateStore
  );

  const frozenPackages = resolveChapterCapabilityPackageSet(projectRoot, { allowMissingInDev: true });
  if (frozenPackages.errors.length > 0) {
    const envelope = requiredPackageFailure(
      `capability package set invalid: ${frozenPackages.errors.join(";")}`,
      { errors: frozenPackages.errors, source: frozenPackages.source },
    );
    persistEarlyBlockedTrace(
      projectRoot,
      workspaceId,
      chapterId,
      envelope,
      releaseGovernanceTrace,
      effectiveFullPipelinePreview,
      auditSession,
    );
    return seal({
      status: "blocked",
      workspaceId,
      chapterId,
      chapterNumber,
      text: "",
      candidates: [],
      diagnostics: [],
      failureEnvelope: envelope,
      stageResults: {
        unifiedPipeline: true,
        releaseGovernance: {
          ...releaseGovernanceTrace,
          blocked: true,
          reason: envelope.reason,
        },
      },
    });
  }
  const capabilityBudgetLedger = input._priorBudgetLedger ?? createBudgetLedger();
  const capabilityConsumptionLedger = createChapterConsumptionLedger();
  const capabilityPlan = planProductionCapabilityActivations({
    runId: runRouting.orchestratorRunId,
    workspaceId,
    chapterId,
    releaseId: releaseGateResult.releaseId ?? "dev",
    bundleId: releaseGateResult.behaviorIdentity.bundleId ?? "dev",
    capabilityPackageSetHash: frozenPackages.hash,
    routeCapabilityKey: resolveRouteCapabilityKey(runRouting),
    packageSet: frozenPackages.set,
    facts: {
      chapterNumber,
      stage: "agentic_investigation",
      intent: { chapterFunction: intent.chapterFunction ?? "" },
      contextMeta: {},
      stateSummary: {},
    },
    stageAllowedTools: [...NARRATIVE_TOOL_NAMES, ACTIVATE_CAPABILITY_PACKAGE_TOOL],
    releaseAllowedTools: [...NARRATIVE_TOOL_NAMES, ACTIVATE_CAPABILITY_PACKAGE_TOOL],
    ledger: capabilityBudgetLedger,
    capabilityRegistry: defaultCapabilityRegistry,
    consumptionLedger: capabilityConsumptionLedger,
    mode: evalMode === undefined ? "production" : "eval",
  });
  recordOptionalCapabilityUnavailable(
    capabilityConsumptionLedger,
    frozenPackages.set,
    capabilityPlan.manifest,
  );
  const requiredActivationFailures = collectRequiredActivationFailures(
    frozenPackages.set,
    capabilityPlan.manifest,
  );
  if (requiredActivationFailures.length > 0) {
    const envelope = requiredPackageFailure(
      `required capability package unavailable: ${requiredActivationFailures.map((item) => `${item.packageId}:${item.decision}:${item.reasons.join(",")}`).join(";")}`,
      { failures: requiredActivationFailures },
    );
    persistEarlyBlockedTrace(
      projectRoot,
      workspaceId,
      chapterId,
      envelope,
      releaseGovernanceTrace,
      effectiveFullPipelinePreview,
      auditSession,
    );
    return seal({
      status: "blocked",
      workspaceId,
      chapterId,
      chapterNumber,
      text: "",
      candidates: [],
      diagnostics: [],
      failureEnvelope: envelope,
      stageResults: {
        unifiedPipeline: true,
        releaseGovernance: {
          ...releaseGovernanceTrace,
          blocked: true,
          reason: envelope.reason,
        },
        capabilityPackages: {
          requiredFailures: requiredActivationFailures,
        },
      },
    });
  }

  // ── 3. ModelGenerateFn：真实链路或 stub ────────────────────────────────
  // REAL-QUALITY-1-PREFLIGHT：useStub 只看 V2_FORCE_STUB（去掉 modelTestRoute===undefined 条件），
  // 使 modelTestRoute=glm 时也能用 stub 测试（不调用真实模型）。
  // 真实生成走 createLegacyModelGenerateFn（动态 import fallback-manager）。
  // F4-4：解析链 recorded -> synthetic -> stub (V2_FORCE_STUB) -> legacy 真实模型；
  // recorded/synthetic 的传输 env 完整性已在管线入口 fail-closed 校验（见 useStub 附近）。
  const baseModelGenerate: ModelGenerateFn = evalReplayTransport
    ? evalReplayTransport
    : useStub
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
  const generationModelGenerate: ModelGenerateFn = testRouteLock
    ? wrapModelGenerateLockedToRoute(baseModelGenerate, testRouteLock.generateRoute)
    : wrapModelGenerateForWriterLock(baseModelGenerate, writerRouteLock);
  const judgeModelGenerate: ModelGenerateFn = testRouteLock
    ? wrapModelGenerateLockedToRoute(baseModelGenerate, testRouteLock.judgeRoute)
    : baseModelGenerate;
  const blockedRawRecovery = input.recoverBlockedRaw
    ? createBlockedRawRecovery({
        projectRoot,
        workspaceId,
        chapterId,
        chapterNumber,
        writerModel,
        generationModelGenerate,
      })
    : null;
  const effectiveGenerationModelGenerate = blockedRawRecovery?.generationModelGenerate
    ?? generationModelGenerate;

  // ── 4. characterNames：从 seed 角色列表派生（CANON-IDENTITY-1: 含 aliases） ──
  const characterNames = (seed.characters ?? []).flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  // P0-2 修复（Phase 1 整改）：Story Preservation 完整实体表。
  // 合并 characterNames + config.worldKeyTerms（factions/places/currencies/professions/
  // specialAbilities/levels），供 editorial-story-preservation-gate 做 full_entities 检查。
  // 无 worldKeyTerms 时为 null，orchestrator 回退 characterNames + characters_only。
  const worldKeyEntities = loadWorldKeyEntities(workspaceId, projectRoot);
  const knownEntities = buildKnownEntities(characterNames, worldKeyEntities);
  // P0 第五轮 P1 修复：构建别名→规范名映射，供 Story Preservation Gate 规范化 subject。
  // 每个角色的 name 为规范名，其 aliases 映射到 name；name 自身也映射到 name（幂等）。
  // 使 raw 用 "叶尘" 与 editorial 用 "小尘"（别名）时 subject 比对仍命中，避免同义改写误阻断。
  const aliasToCanonical = buildAliasToCanonical(seed.characters ?? []);
  // Phase 2B：加载字数软目标，转发给 Agentic GenerationPacket。
  const targetWordCount = loadTargetWordCount(workspaceId, projectRoot);
  const acceptedChapterReferences = selectAcceptedChapterReferences({
    workspaceId,
    projectRoot,
    beforeChapterNumber: chapterNumber,
    relevantCharacters: intent.relevantCharacters ?? [],
    keywords: [
      intent.chapterFunction,
      ...(intent.authorEventSummaries ?? []),
      ...(intent.authorMustInclude ?? []),
      ...(intent.currentPressure ?? []),
      ...(intent.selectedPromisesToAdvance ?? []).map((entry) => entry.description),
    ].filter((value): value is string => Boolean(value?.trim())),
    targetEmotion: intent.readerExperience?.[0],
    maxExamples: 2,
  });

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
  let contextPackage: ContextPackage | undefined;
  if (contextSafety.ok) {
    const packaged = compileProductionContextPackage({
      safety: contextSafety,
      snapshotId: evidenceSnapshot?.snapshotId,
      characterNames,
      targetWordCount,
      fewshotSelection: acceptedChapterReferences,
    });
    if (!packaged.ok || !packaged.package) {
      persistEarlyBlockedTrace(
        projectRoot, workspaceId, chapterId,
        {
          stage: "context_compile",
          gate: "context_package_validation",
          severity: "hard_block",
          reason: `ContextPackage 校验失败：${packaged.errors.join("; ")}`,
          evidence: { errors: packaged.errors, snapshotId: evidenceSnapshot?.snapshotId ?? null },
          recoverable: false,
          userActionRequired: ["检查槽位污染、hash 或过期硬约束后重试"],
        },
        releaseGovernanceTrace, effectiveFullPipelinePreview, auditSession,
      );
      return seal({
        status: "blocked",
        workspaceId,
        chapterId,
        chapterNumber,
        text: "",
        candidates: [],
        diagnostics: [],
        failureEnvelope: {
          stage: "context_compile",
          gate: "context_package_validation",
          failureClass: "blocked",
          severity: "hard_block",
          reason: `ContextPackage 校验失败：${packaged.errors.join("; ")}`,
          evidence: { errors: packaged.errors, snapshotId: evidenceSnapshot?.snapshotId ?? null },
          recoverable: false,
          degradedTo: "hard_block",
        },
        stageResults: { unifiedPipeline: true, contextPackageValidation: false },
        isPreviewRun: effectiveFullPipelinePreview,
        selectedSource: null,
        selectedCandidateId: "",
        isUnderSpecified: false,
      });
    }
    contextPackage = packaged.package;
  }
  if (!stateStageDecision.allowed) {
    // P2 修复（Phase 1 整改）：control plane 能力拒绝也写 trace。
    persistEarlyBlockedTrace(
      projectRoot, workspaceId, chapterId,
      { stage: "control_plane_state_stage", gate: "capability_denied", severity: "hard_block", reason: "capability denied: state.stage (narrative state staging denied)", evidence: { capability: "state.stage", denial: stateStageDecision }, recoverable: false },
      releaseGovernanceTrace, effectiveFullPipelinePreview, auditSession,
    );
    return seal(buildEntryControlPlaneBlockedOutput(
      input,
      controlPlane,
      "state.stage",
      "narrative state staging denied",
    ));
  }
  const ontologyLevels = loadOntologyLevels(workspaceId, projectRoot);
  const stagedStateUpdate = buildStagedStateUpdate(seed, chapterNumber, ontologyLevels);
  const policyStore = loadStrategyPolicyStore(workspaceId, projectRoot);
  const strategySelector = createContextualStrategySelector();
  const outcomeRecorder = createStrategyOutcomeRecorder();
  // 正式生产固定启用 NovelOS Agentic；不再使用 shadow 开关或 one-shot raw 回退。
  const agenticCandidateSource = createAgenticRawCandidateSource();
  const productionFlow = process.env.NOVEL_TEST_TOOLS === "1"
    && process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW === "1"
    || qualityExperiment
    ? undefined
    : "agentic_style" as const;
  // Phase 5 受控接入：从 workspace canary 授权解析叙事工具暴露模式。
  // 只对显式 opt-in 的 canary workspace（canary-authorization.json 声明 toolMode="facade"
  // 且未过期）返回 "facade"；其余返回 undefined（= 默认 9 专用工具 standard 行为，非全量切换）。
  // evalMode / qualityExperiment / fullPipelinePreview 仅作只读预览，不启用 facade 受控接入。
  const toolMode = evalMode === undefined && qualityExperiment === undefined
    ? resolveToolModeFromCanaryAuthorization(projectRoot, workspaceId)
    : undefined;
  // 推送 pipeline_start：前端尽早感知工具已启动，进入编排器后 timeAsync/timeSync 接管阶段进度
  emitTopProgress("pipeline", "start", "统一主链路编排开始（Preflight → Agentic → 风格优化 → 复检 → 保存）");
  if (
    process.env.PINOVEL_ADMISSION_FAIL_ONCE === "timeout"
    && !(typeof input._modelTimeoutRetryAttempt === "number" && input._modelTimeoutRetryAttempt > 0)
  ) {
    const failOnceEnvelope = {
      stage: "novelos_agentic_generation",
      gate: "model_timeout",
      severity: "recoverable" as const,
      reason: "PINOVEL_ADMISSION_FAIL_ONCE=timeout（首次章节尝试强制超时，供成功恢复验收）",
      evidence: { admissionFailOnce: "timeout" },
      recoverable: true,
      retryPlan: { strategy: "chapter_level_retry" as const, maxAttempts: 1 },
      userActionRequired: [],
    };
    persistEarlyBlockedTrace(
      projectRoot,
      workspaceId,
      chapterId,
      failOnceEnvelope,
      releaseGovernanceTrace,
      effectiveFullPipelinePreview,
      auditSession,
    );
    return seal({
      status: "blocked",
      workspaceId,
      chapterId,
      chapterNumber,
      text: "",
      candidates: [],
      diagnostics: [],
      failureEnvelope: failOnceEnvelope,
      stageResults: {
        unifiedPipeline: true,
        releaseGovernance: releaseGovernanceTrace,
      },
      isPreviewRun: effectiveFullPipelinePreview,
      selectedSource: null,
      selectedCandidateId: "",
      isUnderSpecified: false,
    });
  }
  const orchestrator = new UnifiedOrchestrator();
  const orchResult = await orchestrator.orchestrate({
    workspaceId,
    chapterId,
    chapterNumber,
    projectRoot,
    productionFlow,
    toolMode,
    // AUDIT-1 Phase 3 续：模型回合 + 工具细事件写入同一 AuditEventStore
    auditSink: auditSession,
    intent: contextSafety.workingIntent,
    context: contextSafety.workingContext,
    constitution: context.constitution ?? null,
    characterNames,
    knownEntities: knownEntities ?? undefined,
    // P0 第五轮 P1 修复：别名→规范名映射，供 Story Preservation Gate 规范化 subject。
    aliasToCanonical,
    fewshotSelection: acceptedChapterReferences,
    ontologyLevels,
    targetWordCount,
    modelGenerate,
    // REAL-QUALITY-1-PREFLIGHT：双轨路由锁定（modelTestRoute=glm 时）
    // - generationModelGenerate：raw + editorial candidate → nb4_generate_glm
    // - judgeModelGenerate：opportunity judge + pairwise 首轮 + 反向复判 + 冲突仲裁 → nb4_judge_glm
    // MODEL-ROUTING-CLAUDE46-1A: 默认生产路径也显式传两条 track（baseModelGenerate），
    // 路由由 input.route 决定（v2_rawstage2/v2_amplified→Claude，v2_opportunity_judge/
    // v2_literary_judge→GPT）。未锁定时不 wrap，但 track 分离仍让 trace 可证明异源。
    // 不传 arbitratorModelGenerate：编排器 fallback 到 judgeModelGenerate（仲裁也走 nb4_judge_glm）。
    generationModelGenerate: effectiveGenerationModelGenerate,
    judgeModelGenerate,
    timeoutMs: resolvedTimeoutMs,
    _modelTimeoutRetryAttempt: input._modelTimeoutRetryAttempt,
    stagedStateUpdate,
    policyStore,
    strategySelector,
    outcomeRecorder,
    agenticCandidateSource,
    evidenceSnapshot,
    controlPlane,
    runRouting,
    contextSafety,
    contextPackage,
    sceneSolution,
    craftGenes,
    promptPatternResolution: evalMode === undefined ? undefined : promptPatternResolution,
    capabilityActivation: capabilityPlan.manifest,
    capabilityCatalog: capabilityPlan.catalog,
    capabilityPackageSet: frozenPackages.set,
    capabilityConsumptionLedger,
    _priorBudgetLedger: capabilityPlan.ledger,
    positiveGainProductionEnabled: false,
    positiveGainCandidateLimit: boundedBestOf3 ? 2 : 1,
    // QUALITY-WINNER-SELECTION-1: raw is the baseline and unresolved-comparison
    // fallback; a valid, decisive chapter comparison must deliver its winner.
    allowAutomaticLiterarySelection: true,
    rawPromptProfile: testRouteLock
      ? resolveWriterPromptProfile({
          route: testRouteLock.generateRoute,
          provider: testRouteLock.provider,
          model: testRouteLock.model,
        })
      : writerRouteLock?.promptProfile ?? "gemini_writer_v2",
    // REAL-QUALITY-1-PREFLIGHT：透传 seed 让 Thompson Sampling / judge 匿名 A/B
    // 可复现。未传时 orchestrator 内部 rng 回退到 Math.random（非确定性），
    // 仅已准入 active 策略参与 Thompson Sampling；candidate 不受随机阈值过滤。
    // 不影响模型调用本身（路由锁定由 modelTestRoute 控制）。
    seed: input.seed,
    previewOnly,
    fullPipelinePreview: effectiveFullPipelinePreview,
    qualityExperiment,
    previewTotalTimeoutMs,
    onUpdate,
  });
  if (blockedRawRecovery) {
    orchResult.stageResults.blockedRawRecovery = blockedRawRecovery.provenance;
  }

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
  // 主路径写入失败时重试一次，再写 reports/traces 备用归档。
  // 章节/状态已提交，故不能把 trace I/O 失败伪装成未交付章节；备用归档也失败时，
  // 必须在 stageResults.tracePersistence 显式暴露留存违约，禁止只写 stderr 后返回无解释的 ok。
  //
  // FULL-PIPELINE-PREVIEW-1：预览模式不写 trace 文件——预览必须保持工作区无副作用。
  let tracePath: string | undefined;
  if (!effectiveFullPipelinePreview) {
    const contextHash = deriveContextHashFromCompiled(context);
    // MODEL-PROMPT-EVOLUTION-1：计算生产 Bundle hash 写入 trace
    const modelVersion = (orchResult.stageResults.modelVersion as string | undefined) ?? "unknown";
    const SOFT = Number(process.env.PINOVEL_MODEL_CALL_SOFT ?? 6);
    const HARD = Number(process.env.PINOVEL_MODEL_CALL_HARD ?? 10);
    const bundleHash = computeProductionBundleHash({
      modelVersion,
      route: generationModelLock.route,
      provider: generationModelLock.provider,
      temperature: null,
      maxTokens: null,
      budgetMaxTurns: 10,
      budgetMaxToolCalls: 20,
      orchestratorSoft: SOFT,
      orchestratorHard: HARD,
    });
    const traceRecords = buildTraceRecordsFromOrchResult(
      orchResult, contextHash, releaseGovernanceTrace,
      { bundleId: bundleHash.bundleId, hashDimensions: bundleHash.hashDimensions },
    );
    const tracePersistence = persistUnifiedTraceWithFallback({
      projectRoot,
      workspaceId,
      chapterId,
      traceRecords,
      auditSink: auditSession,
    });
    tracePath = tracePersistence.path;
    orchResult.stageResults.tracePersistence = tracePersistence;
    // P7 Stage A 双写：quality-trace.json 落盘后向审计流追加 trace_persisted。
    // causedByEventId 回溯到最近 final_submission（缺失则 chapter_saved → run_started）。
    {
      const auditEntries = auditSession.getEntries();
      const causedByEventId =
        [...auditEntries].reverse().find((e) => e.eventType === "final_submission")?.eventId ??
        [...auditEntries].reverse().find((e) => e.eventType === "chapter_saved")?.eventId ??
        auditEntries.find((e) => e.eventType === "run_started")?.eventId;
      auditSession.recordEvent({
        eventType: "custom",
        eventId: `tracePersisted:${auditSession.runId}:${chapterId}`,
        stage: "final_submission",
        status: tracePersistence.status === "failed" ? "failed" : "completed",
        decisionReason: `trace persisted (status=${tracePersistence.status})`,
        causedByEventId,
        payload: {
          eventTypeHint: "trace_persisted",
          status: tracePersistence.status,
          path: tracePersistence.path ?? null,
          primaryAttempts: tracePersistence.primaryAttempts,
        },
      });
    }
    if (tracePersistence.status === "fallback") {
      orchResult.warnings.push(`主 trace 写入失败，已保存备用归档：${tracePersistence.path}`);
    } else if (tracePersistence.status === "failed") {
      const message = `trace 主路径与备用归档均失败：${tracePersistence.errors.join("；")}`;
      orchResult.warnings.push(message);
      process.stderr.write(`[Unified] ${message}\n`);
    }
  }

  // ── 6. 映射到 V2Output 兼容形状 ────────────────────────────────────────
  // 统一主链路永远不返回 v2NotImplemented（无 legacy 回退）。
  // 编译期 diagnostics 与意图构建 warnings 一并写入 stageResults 供 trace 审计。
  // Phase 2A：预检 warnings（非阻断）合并到 stageResults.preflight 与 orchResult.warnings。
  const preflightWarnings = preflightReport?.warnings ?? [];
  const mergedWarnings = [...orchResult.warnings, ...preflightWarnings];
  const baseStageResults: Record<string, unknown> = {
    ...orchResult.stageResults,
    unifiedPipeline: true,
    selectedSource: orchResult.selectedSource,
    selectedCandidateId: orchResult.selectedCandidateId,
    warnings: mergedWarnings,
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
    // Phase 2A：预检结果摘要（passed=true 时 blockingItems 为空；skipped 时为 null）
    preflight: preflightReport
      ? {
          passed: preflightReport.passed,
          warnings: preflightReport.warnings,
          checks: preflightReport.checks,
          durationMs: preflightReport.durationMs,
        }
      : { skipped: true, reason: "qualityExperiment or fullPipelinePreview bypass" },
    judgeArbitration: orchResult.stageResults.judgeArbitration
      ?? (orchResult.judgeResult
        ? {
          reverseReviewed: orchResult.judgeResult.reverseReviewed,
          arbitrationTriggered: orchResult.judgeResult.arbitrationTriggered,
          conflicted: orchResult.judgeResult.conflicted,
          finalSelectedCandidateId: orchResult.judgeResult.finalSelectedCandidateId,
        }
        : null),
  };

  if (orchResult.status === "blocked") {
    return seal({
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
    });
  }

  return seal({
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
  });
  }); // runInTrustContextAsync — TrustAudit 并发隔离
  } catch (pipelineErr) {
    // 未捕获异常：写 run_interrupted + failure_recorded，再结构化返回（不静默）
    const msg = pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr);
    try {
      auditSession.finalizeInterrupted(`pipeline exception: ${msg}`, pipelineErr);
    } catch {
      // audit 写入失败不掩盖原始异常
    }
    const summary = auditSession.toStageResultsSummary();
    return {
      status: "blocked",
      workspaceId,
      chapterId,
      chapterNumber,
      text: "",
      candidates: [],
      diagnostics: [],
      failureEnvelope: {
        stage: "run",
        gate: "pipeline_exception",
        severity: "fatal",
        reason: msg,
        evidence: {
          error: pipelineErr instanceof Error
            ? { message: pipelineErr.message, name: pipelineErr.name }
            : String(pipelineErr),
        },
        recoverable: false,
        degradedTo: "hard_block",
        failureClass: "fatal",
      },
      stageResults: {
        unifiedPipeline: true,
        pipelineException: true,
        auditRun: summary,
      },
      isPreviewRun: effectiveFullPipelinePreview,
      selectedSource: null,
      selectedCandidateId: "",
      isUnderSpecified: false,
    };
  }
}
