/**
 * NovelOS Narrative Agent Loop Types（OPT-9.5 拆分自 narrative-agent-loop.ts）
 *
 * 集中 agent loop 相关的类型定义，供主 loop 与辅助模块复用。
 * 拆分目的：满足 simplicity-gate 800 行限制，同时保持公共 API 稳定。
 *
 * 注意：所有依赖均为 type-only import，不产生运行时循环依赖。
 */

import type { NovelOSRuntime } from "../runtime/runtime.js";
import type { BudgetPolicy, BudgetSnapshot } from "../runtime/budget-policy.js";
import type { TrajectoryStore } from "../trajectory/trajectory-store.js";
import type { NarrativeToolRegistry } from "./narrative-tool-registry.js";
import type { NarrativeSearchService } from "./narrative-search-service.js";
import type { CandidateWorkspace } from "./candidate-workspace.js";
import type { PermissionPolicy } from "../security/permission-policy.js";
import type { CompiledContext } from "../../v2/core/types.js";
import type {
  NarrativeVerifierSuite,
  NarrativeVerifierReport,
  VerificationFinding,
} from "../verification/narrative-verifier-suite.js";
import type { CandidatePatchService, PatchProposal } from "./candidate-patch-service.js";
import type {
  EvidencePlan,
} from "./evidence-plan.js";
import type {
  CoverageGate,
  CoverageGateResult,
} from "./must-verify-coverage-gate.js";

// ============================================================================
// 类型
// ============================================================================

export interface AgentLoopInput {
  /** 本章意图摘要 */
  chapterIntent: string;
  /** 种子上下文（CompiledContext 摘要或 ChapterSeed 文本） */
  seedContext: string;
  /** 编译后的上下文（供 verifier 使用，Task B.2） */
  context: CompiledContext;
  /** 已知角色名（含 aliases，用于实体幻觉检测） */
  knownCharacterNames?: string[];
  /** M1.1：本章不可违反的必需事实（来自 ChapterIntent.inviolableFacts） */
  inviolableFacts?: string[];
  /**
   * R6 修复：前文（eval 模式续写用）。
   * eval 模式下由编排器传入 evalPrefix（reference chapter 的前文），
   * 注入 agent userPrompt 的【前文】段，确保 agentic 生成续写同一故事，
   * 而非从 scratch 生成不同故事。生产模式（非 eval）不传，行为不变。
   */
  evalPrefix?: string;
  /**
   * Phase 2C：调用方预创建的 EvidencePlan。
   *
   * 若提供，loop 不再内部 createEvidencePlan，而是直接消费此 plan：
   * - mustVerify 注入 runAgentTurns 的 prompt（"本章必须验证的事实点" block）
   * - stopConditions.maxStagnantRounds 驱动 verifyAndPatch 的停滞退出
   * - allowedTools 已由调用方在创建 runtime 前用于过滤工具集
   *
   * 若未提供，loop 内部 createEvidencePlan（向后兼容）。
   */
  evidencePlan?: EvidencePlan;
  /**
   * eval-only：覆盖默认的检索决策规则 prompt。
   *
   * Phase 2D（2026-08-06）三缺口修复后：
   * 生产路径不传此字段，runAgentTurns 默认使用不确定性驱动的检索决策规则
   * （DEFAULT_UNCERTAINTY_DRIVEN_PROMPT：上下文足够则直接生成，缺关键信息才检索）。
   *
   * eval A/B 对照实验中：
   * - A 组（baseline）传入 FORCED_RETRIEVAL_PROMPT，保持旧"请先使用跨源..."
   *   强制检索行为，作为对照基线。
   * - B 组（treatment）传入 UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT，与生产默认一致。
   *
   * 不暴露思维链，只改变检索决策规则。
   */
  retrievalPromptOverride?: string;
}

export type AgentLoopStopReason =
  | "model_declares_sufficient"
  | "budget_exhausted"
  | "stagnant"
  | "verifier_cleared"
  | "model_error"
  | "tool_error"
  | "must_verify_coverage_failed";

/**
 * 按阶段统计的模型调用次数（AGENTIC-EVIDENCE-MERGE-1 可观测性）。
 * 不区分 provider/具体模型，只按阶段聚合，供 trace 解释 Agentic 实际动作。
 * - draft：Agentic 首轮 ReAct 阶段的模型调用数（每条 assistant 消息计 1）
 * - patch：整章/局部补丁生成的模型调用数
 * - verify：verifier 校验的调用数（可能为本地确定性，非模型）
 */
export interface ModelCallsByKind {
  draft: number;
  patch: number;
  verify: number;
}

export interface AgentLoopLineage {
  evidencePlan: EvidencePlan;
  toolCalls: number;
  sourceRefs: string[];
  stopReason: AgentLoopStopReason;
  budgetSnapshot: BudgetSnapshot;
  /** 收集的证据事实文本 */
  evidenceFacts: string[];
  /** verifier 是否清零（无硬失败或 patch 后清零） */
  verifierCleared: boolean;
  /** 硬失败数量（最终） */
  hardFindingCount: number;
  /**
   * AGENTIC-EVIDENCE-MERGE-1 修复：底层错误消息（catch 块捕获的原始异常 message）。
   *
   * 之前 loop 在 catch 中统一调用 makeFallback(stopReason="model_error")，但
   * 底层错误消息（可能含 "timed out" 等超时模式）只写入 trajectory.recordFailure，
   * 不进入 lineage。agentic-raw-candidate-source.ts 只读 lineage.stopReason 构造
   * fallbackReason="agent loop fallback: model_error"，导致 classifyFailureKind
   * 无法识别超时 → failureKind 永远是 "model_error" → 编排器 candidate=null 分支
   * 无法触发 gate=model_timeout / severity=recoverable → 工具层 chapter_level_retry
   * 重试条件不可达。
   *
   * 现在通过此字段把底层错误消息传递到 source，让 classifyFailureKind 能识别超时。
   */
  failureReason?: string;
  /**
   * AGENTIC-EVIDENCE-MERGE-1 可观测性：Agentic 首回合实际采取的动作。
   * - "tool_call"：首条 assistant 消息含工具调用指令（先检索）
   * - "draft"：首条 assistant 消息直接输出正文
   */
  firstAction: "draft" | "tool_call";
  /** AGENTIC-EVIDENCE-MERGE-1 可观测性：实际执行的检索类工具调用数 */
  actualRetrievalCalls: number;
  /** AGENTIC-EVIDENCE-MERGE-1 可观测性：按阶段聚合的模型调用数 */
  modelCallsByKind: ModelCallsByKind;
  /** mustVerify 覆盖门最近一次结果（若启用） */
  coverageGate?: CoverageGateResult;
  /** 覆盖门触发的有限重试次数 */
  coverageGateRetries?: number;
}

export interface AgentLoopResult {
  /** agentic_raw 正文（fallback 时为空字符串） */
  text: string;
  /** lineage（写入 candidate-workspace/lineage.json） */
  lineage: AgentLoopLineage;
  /** 是否需要回退 one_shot_raw */
  fallback: boolean;
  /** verifier 验证报告（Task B.2） */
  verifierReport?: NarrativeVerifierReport;
  /** patch proposals（Task B.2） */
  patchProposals?: PatchProposal[];
  /** 实际执行 repair 轮数 */
  repairRounds: number;
}

export interface NarrativeAgentLoopOptions {
  runtime: NovelOSRuntime;
  registry: NarrativeToolRegistry;
  searchService: NarrativeSearchService;
  candidateWorkspace: CandidateWorkspace;
  permissionPolicy: PermissionPolicy;
  budget: BudgetPolicy;
  trajectory: TrajectoryStore;
  verifier?: NarrativeVerifierSuite;
  patchService?: CandidatePatchService;
  /** 可选事实覆盖门；只决定检索重试，不决定最终正文交付。 */
  coverageGate?: CoverageGate;
  /** 覆盖门失败后的最大 Agentic 重试次数，默认 1。 */
  maxCoverageRetries?: number;
  /** 最大修复轮数（默认 2，可通过 PINOVEL_NOVELOS_MAX_REPAIR_ROUNDS 环境变量覆盖） */
  maxRepairRounds?: number;
}

export interface AgentTurnsResult {
  draftText: string;
  sourceRefs: string[];
  evidenceFacts: string[];
  toolCalls: number;
  stopReason: AgentLoopStopReason;
  /** AGENTIC-EVIDENCE-MERGE-1：首回合实际动作 */
  firstAction: "draft" | "tool_call";
  /** AGENTIC-EVIDENCE-MERGE-1：实际检索类工具调用数 */
  actualRetrievalCalls: number;
  /** AGENTIC-EVIDENCE-MERGE-1：ReAct 首轮阶段模型调用数 */
  draftModelCalls: number;
  /**
   * AGENTIC-EVIDENCE-MERGE-1 修复：模型调用错误消息（如超时）。
   *
   * streamFn 把 modelGenerate 异常转为 stream error 事件，pi-agent-core
   * 把 error.errorMessage 存入 assistant 消息。runAgentTurns 从消息中提取
   * 此字段，供 makeFallback 传入 lineage.failureReason，让
   * classifyFailureKind 能识别 "timed out" 等超时模式。
   */
  modelErrorMessage?: string;
}

export interface VerifyPatchResult {
  text: string;
  verifierReport: NarrativeVerifierReport;
  patchProposals: PatchProposal[];
  repairRounds: number;
  verifierCleared: boolean;
  hardFindingCount: number;
  stopReason?: AgentLoopStopReason;
  /** AGENTIC-EVIDENCE-MERGE-1：patch 阶段模型调用数 */
  patchModelCalls: number;
  /** AGENTIC-EVIDENCE-MERGE-1：verify 阶段调用数 */
  verifyModelCalls: number;
}

// 重新导出 VerificationFinding 类型供辅助模块使用
export type { VerificationFinding } from "../verification/narrative-verifier-suite.js";
