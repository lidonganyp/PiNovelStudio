/**
 * ORCHESTRATOR-DECISION — 编排器裁决记录与固定优先级（MA-4.1 / MA-4.2）
 *
 * 代理返回只能是 evidence 或 proposal；改变阶段状态必须经 OrchestratorDecision。
 * blocked 结果不得被降级为 warning 继续生产。
 */

import { randomBytes } from "node:crypto";
import type { AgentRole } from "./agent-roles.js";
import type { AgentResultStatus, UnifiedAgentResult } from "./agent-result-contracts.js";
import { summarizeAgentResult } from "./agent-result-contracts.js";

export const ORCHESTRATOR_DECISION_SCHEMA = "pinovel.orchestrator-decision" as const;
export const ORCHESTRATOR_DECISION_VERSION = "1.0.0" as const;

/** 裁决优先级：数值越小越优先（硬规则在前） */
export type DecisionPriorityKind =
  | "hard_fact"
  | "permission_security"
  | "state_transaction"
  | "author_contract"
  | "story_preservation"
  | "style_advice"
  | "mechanical_metric";

export const DECISION_PRIORITY_RANK: Readonly<
  Record<DecisionPriorityKind, number>
> = {
  hard_fact: 0,
  permission_security: 1,
  state_transaction: 2,
  author_contract: 3,
  story_preservation: 4,
  style_advice: 5,
  mechanical_metric: 6,
};

export type DecisionKind = "evidence" | "proposal" | "decision";

export type StageTransition =
  | "continue"
  | "retry_gate"
  | "retry_stage"
  | "block"
  | "commit"
  | "skip_forbidden";

export interface OrchestratorDecision {
  schema: typeof ORCHESTRATOR_DECISION_SCHEMA;
  version: typeof ORCHESTRATOR_DECISION_VERSION;
  decisionId: string;
  timestamp: string;
  orchestratorRunId: string;
  workspaceId: string;
  chapterId: string;
  fromStage: string;
  toStage: string | null;
  /** 决策类型：代理不得直接写 decision */
  kind: DecisionKind;
  actor: "orchestrator" | "system";
  sourceAgentRole?: AgentRole;
  sourceResultStatus?: AgentResultStatus;
  priority: DecisionPriorityKind;
  transition: StageTransition;
  allowed: boolean;
  reason: string;
  /** 关联候选 */
  candidateId?: string;
  sourceCandidateId?: string;
  /** 关联工作包 / 结果摘要（无正文） */
  workPackageId?: string;
  resultSummary?: Record<string, unknown>;
  /** 冲突时被否决的较低优先级项 */
  overruled?: Array<{
    priority: DecisionPriorityKind;
    reason: string;
  }>;
}

export interface CreateOrchestratorDecisionInput {
  orchestratorRunId: string;
  workspaceId: string;
  chapterId: string;
  fromStage: string;
  toStage: string | null;
  kind?: DecisionKind;
  actor?: "orchestrator" | "system";
  sourceAgentRole?: AgentRole;
  sourceResultStatus?: AgentResultStatus;
  priority: DecisionPriorityKind;
  transition: StageTransition;
  allowed: boolean;
  reason: string;
  candidateId?: string;
  sourceCandidateId?: string;
  workPackageId?: string;
  resultSummary?: Record<string, unknown>;
  overruled?: OrchestratorDecision["overruled"];
  decisionId?: string;
  timestamp?: string;
}

export function createOrchestratorDecision(
  input: CreateOrchestratorDecisionInput,
): OrchestratorDecision {
  return {
    schema: ORCHESTRATOR_DECISION_SCHEMA,
    version: ORCHESTRATOR_DECISION_VERSION,
    decisionId:
      input.decisionId ??
      `od-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    timestamp: input.timestamp ?? new Date().toISOString(),
    orchestratorRunId: input.orchestratorRunId,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    fromStage: input.fromStage,
    toStage: input.toStage,
    kind: input.kind ?? "decision",
    actor: input.actor ?? "orchestrator",
    sourceAgentRole: input.sourceAgentRole,
    sourceResultStatus: input.sourceResultStatus,
    priority: input.priority,
    transition: input.transition,
    allowed: input.allowed,
    reason: input.reason,
    candidateId: input.candidateId,
    sourceCandidateId: input.sourceCandidateId,
    workPackageId: input.workPackageId,
    resultSummary: input.resultSummary,
    overruled: input.overruled,
  };
}

/**
 * 从代理结果生成编排器裁决（代理 status 不得直接改阶段；由此函数映射）。
 * blocked → 强制 block，禁止伪装 continue。
 */
export function decideFromAgentResult(input: {
  orchestratorRunId: string;
  workspaceId: string;
  chapterId: string;
  fromStage: string;
  nextStageIfOk: string;
  result: UnifiedAgentResult;
  workPackageId?: string;
  priority?: DecisionPriorityKind;
}): OrchestratorDecision {
  const { result } = input;
  const priority =
    input.priority ?? inferPriority(result.agentRole, result.status);

  if (result.status === "blocked") {
    return createOrchestratorDecision({
      orchestratorRunId: input.orchestratorRunId,
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      fromStage: input.fromStage,
      toStage: null,
      kind: "decision",
      sourceAgentRole: result.agentRole,
      sourceResultStatus: result.status,
      priority,
      transition: "block",
      allowed: false,
      reason: `代理 ${result.agentRole} 返回 blocked：${result.stopReason}`,
      candidateId: result.candidateId,
      workPackageId: input.workPackageId,
      resultSummary: summarizeAgentResult(result),
    });
  }

  if (result.status === "recoverable") {
    return createOrchestratorDecision({
      orchestratorRunId: input.orchestratorRunId,
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      fromStage: input.fromStage,
      toStage: input.fromStage,
      kind: "decision",
      sourceAgentRole: result.agentRole,
      sourceResultStatus: result.status,
      priority,
      transition: "retry_gate",
      allowed: false,
      reason: `代理 ${result.agentRole} 可恢复失败：${result.stopReason}`,
      candidateId: result.candidateId,
      workPackageId: input.workPackageId,
      resultSummary: summarizeAgentResult(result),
    });
  }

  return createOrchestratorDecision({
    orchestratorRunId: input.orchestratorRunId,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    fromStage: input.fromStage,
    toStage: input.nextStageIfOk,
    kind: "decision",
    sourceAgentRole: result.agentRole,
    sourceResultStatus: result.status,
    priority,
    transition: "continue",
    allowed: true,
    reason: `代理 ${result.agentRole} 通过，进入 ${input.nextStageIfOk}`,
    candidateId: result.candidateId,
    workPackageId: input.workPackageId,
    resultSummary: summarizeAgentResult(result),
  });
}

function inferPriority(
  role: AgentRole,
  status: AgentResultStatus,
): DecisionPriorityKind {
  if (role === "fact_guard" || role === "final_fact_recheck") return "hard_fact";
  if (role === "final_state_commit") return "state_transaction";
  if (role === "story_preservation") return "story_preservation";
  if (role === "author_style") {
    return status === "ok" ? "style_advice" : "author_contract";
  }
  if (role === "novelos_agentic") return "author_contract";
  return "permission_security";
}

/**
 * 多裁决冲突：取最高优先级（rank 最小）且 allowed=false 的阻断优先。
 * 任一 blocked 不得被低优先级 continue 覆盖。
 */
export function resolveDecisionConflict(
  decisions: readonly OrchestratorDecision[],
): OrchestratorDecision | null {
  if (!decisions.length) return null;
  const blocks = decisions.filter(
    (d) => !d.allowed || d.transition === "block",
  );
  const pool = blocks.length > 0 ? blocks : [...decisions];
  return pool
    .slice()
    .sort(
      (a, b) =>
        DECISION_PRIORITY_RANK[a.priority] - DECISION_PRIORITY_RANK[b.priority],
    )[0] ?? null;
}

/**
 * 阶段转移守卫：Agentic 初稿不得跳过风格优化 / StoryPreservation / FinalFactRecheck。
 */
export const REQUIRED_STAGES_BEFORE_COMMIT: readonly string[] = [
  "novelos_agentic",
  "author_style",
  "story_preservation",
  "final_fact_recheck",
] as const;

export function assertStagesCompleteBeforeCommit(
  completedStages: readonly string[],
): { ok: boolean; missing: string[] } {
  const set = new Set(completedStages);
  const missing = REQUIRED_STAGES_BEFORE_COMMIT.filter((s) => !set.has(s));
  return { ok: missing.length === 0, missing };
}

/** 禁止 Agentic 初稿直接交付 */
export function isAgenticDirectDeliveryAttempt(input: {
  selectedSource: "raw" | "editorial" | null;
  completedStages: readonly string[];
  agenticOnly?: boolean;
}): boolean {
  if (input.selectedSource === null) return false;
  const hasStyle = input.completedStages.includes("author_style");
  if (input.selectedSource === "raw" && input.agenticOnly && !hasStyle) {
    return true;
  }
  // raw 交付但未完成风格优化阶段
  if (input.selectedSource === "raw" && !hasStyle) {
    return true;
  }
  return false;
}
