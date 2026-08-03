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
}

export type AgentLoopStopReason =
  | "model_declares_sufficient"
  | "budget_exhausted"
  | "stagnant"
  | "verifier_cleared"
  | "model_error"
  | "tool_error";

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
  /** 最大修复轮数（默认 2，可通过 PINOVEL_NOVELOS_MAX_REPAIR_ROUNDS 环境变量覆盖） */
  maxRepairRounds?: number;
}

export interface AgentTurnsResult {
  draftText: string;
  sourceRefs: string[];
  evidenceFacts: string[];
  toolCalls: number;
  stopReason: AgentLoopStopReason;
}

export interface VerifyPatchResult {
  text: string;
  verifierReport: NarrativeVerifierReport;
  patchProposals: PatchProposal[];
  repairRounds: number;
  verifierCleared: boolean;
  hardFindingCount: number;
  stopReason?: AgentLoopStopReason;
}

// 重新导出 VerificationFinding 类型供辅助模块使用
export type { VerificationFinding } from "../verification/narrative-verifier-suite.js";
