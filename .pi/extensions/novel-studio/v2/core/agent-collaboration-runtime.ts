/**
 * AGENT-COLLABORATION-RUNTIME — 编排器侧工作包/结果/裁决挂载（MA-1.4 / MA-4 联调）
 *
 * 不改变文学判断；只在 stageResults 写入可审计协议字段。
 * 敏感信息：不写正文全文、不写思维链。
 */

import {
  createAgentWorkPackage,
  summarizeAgentWorkPackage,
  AgentWorkPackageError,
  type AgentWorkPackage,
} from "./agent-work-package.js";
import {
  getDefaultAllowedResources,
  getDefaultForbiddenResources,
  getInputFieldWhitelist,
} from "./agent-input-whitelist.js";
import type { AgentRole } from "./agent-roles.js";
import {
  summarizeAgentResult,
  type UnifiedAgentResult,
} from "./agent-result-contracts.js";
import {
  assertStagesCompleteBeforeCommit,
  createOrchestratorDecision,
  decideFromAgentResult,
  isAgenticDirectDeliveryAttempt,
  type OrchestratorDecision,
} from "./orchestrator-decision.js";
import type { ModelLock } from "./control-plane.js";
import { evaluateInputAgainstWorkPackage } from "./agent-work-package-tool-gate.js";

export interface CollaborationTraceState {
  orchestratorRunId: string;
  workspaceId: string;
  chapterId: string;
  taskId: string;
  contextHash: string;
  promptBundleHash?: string;
  constraintManifestHash?: string;
  modelLock?: ModelLock;
  workPackages: Record<string, ReturnType<typeof summarizeAgentWorkPackage>>;
  agentResults: Record<string, ReturnType<typeof summarizeAgentResult>>;
  decisions: OrchestratorDecision[];
  completedStages: string[];
}

export function createCollaborationTraceState(input: {
  orchestratorRunId: string;
  workspaceId: string;
  chapterId: string;
  taskId?: string;
  contextHash?: string;
  promptBundleHash?: string;
  constraintManifestHash?: string;
  modelLock?: ModelLock;
}): CollaborationTraceState {
  return {
    orchestratorRunId: input.orchestratorRunId,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    taskId: input.taskId ?? input.orchestratorRunId,
    contextHash: input.contextHash ?? "context-unset",
    promptBundleHash: input.promptBundleHash,
    constraintManifestHash: input.constraintManifestHash,
    modelLock: input.modelLock,
    workPackages: {},
    agentResults: {},
    decisions: [],
    completedStages: [],
  };
}

export function buildRoleWorkPackage(
  state: CollaborationTraceState,
  role: AgentRole,
  opts: {
    stage: string;
    sessionId: string;
    objective: string;
    parentCandidateId?: string;
    sourceCandidateId?: string;
    strategyId?: string;
    strategyBundleId?: string;
  },
): AgentWorkPackage {
  return createAgentWorkPackage({
    taskId: state.taskId,
    orchestratorRunId: state.orchestratorRunId,
    workspaceId: state.workspaceId,
    chapterId: state.chapterId,
    agentRole: role,
    sessionId: opts.sessionId,
    objective: opts.objective,
    stage: opts.stage,
    inputFieldWhitelist: getInputFieldWhitelist(role),
    allowedResources: getDefaultAllowedResources(role, opts.sessionId),
    forbiddenResources: getDefaultForbiddenResources(role),
    contextHash: state.contextHash,
    promptBundleHash: state.promptBundleHash,
    constraintManifestHash: state.constraintManifestHash,
    modelLock: state.modelLock,
    parentCandidateId: opts.parentCandidateId,
    sourceCandidateId: opts.sourceCandidateId,
    strategyId: opts.strategyId,
    strategyBundleId: opts.strategyBundleId,
  });
}

export function recordWorkPackage(
  state: CollaborationTraceState,
  pkg: AgentWorkPackage,
): void {
  state.workPackages[pkg.agentRole] = summarizeAgentWorkPackage(pkg);
}

/**
 * MA-3.2：代理调用前强制输入白名单。
 * 只允许白名单字段；越权字段 fail-closed。
 */
export function requireWorkPackageInput(
  pkg: AgentWorkPackage,
  payload: Record<string, unknown>,
): void {
  const gate = evaluateInputAgainstWorkPackage({ workPackage: pkg, payload });
  if (!gate.allowed) {
    throw new AgentWorkPackageError(
      gate.reason ?? "输入字段越权",
      (gate.code as AgentWorkPackageError["code"]) ?? "input_field_not_allowed",
    );
  }
}

export function recordAgentResult(
  state: CollaborationTraceState,
  result: UnifiedAgentResult,
  nextStageIfOk: string,
  workPackageId?: string,
): OrchestratorDecision {
  state.agentResults[result.agentRole] = summarizeAgentResult(result);
  if (result.status === "ok") {
    if (!state.completedStages.includes(result.agentRole)) {
      state.completedStages.push(result.agentRole);
    }
  }
  const decision = decideFromAgentResult({
    orchestratorRunId: state.orchestratorRunId,
    workspaceId: state.workspaceId,
    chapterId: state.chapterId,
    fromStage: result.agentRole,
    nextStageIfOk,
    result,
    workPackageId,
  });
  state.decisions.push(decision);
  return decision;
}

export function recordSystemDecision(
  state: CollaborationTraceState,
  input: {
    fromStage: string;
    toStage: string | null;
    transition: OrchestratorDecision["transition"];
    allowed: boolean;
    reason: string;
    priority?: OrchestratorDecision["priority"];
    candidateId?: string;
  },
): OrchestratorDecision {
  const decision = createOrchestratorDecision({
    orchestratorRunId: state.orchestratorRunId,
    workspaceId: state.workspaceId,
    chapterId: state.chapterId,
    fromStage: input.fromStage,
    toStage: input.toStage,
    priority: input.priority ?? "permission_security",
    transition: input.transition,
    allowed: input.allowed,
    reason: input.reason,
    candidateId: input.candidateId,
  });
  state.decisions.push(decision);
  return decision;
}

export function attachCollaborationToStageResults(
  stageResults: Record<string, unknown>,
  state: CollaborationTraceState,
): void {
  stageResults.agentCollaboration = {
    schema: "pinovel.agent-collaboration-trace",
    version: "1.0.0",
    orchestratorRunId: state.orchestratorRunId,
    workPackages: state.workPackages,
    agentResults: state.agentResults,
    decisions: state.decisions,
    completedStages: [...state.completedStages],
    preCommitGuard: assertStagesCompleteBeforeCommit(state.completedStages),
    agenticDirectDeliveryBlocked: isAgenticDirectDeliveryAttempt({
      selectedSource:
        typeof stageResults.selectedSource === "string"
          ? (stageResults.selectedSource as "raw" | "editorial")
          : null,
      completedStages: state.completedStages,
    }),
  };
}

export function guardCommitStages(state: CollaborationTraceState): {
  ok: boolean;
  missing: string[];
} {
  return assertStagesCompleteBeforeCommit(state.completedStages);
}
