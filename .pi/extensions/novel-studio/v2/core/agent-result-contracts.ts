/**
 * AGENT-RESULT-CONTRACTS — 统一代理结构化结果契约（MA-1.2）
 *
 * 所有生产代理输出适配到本契约；校验失败只允许 retry_gate，不得触发正文重写。
 * 保留现有业务字段于 `details` / 适配层，不做无理由重命名。
 */

import type { AgentRole } from "./agent-roles.js";

export const AGENT_RESULT_SCHEMA = "pinovel.agent-result" as const;
export const AGENT_RESULT_VERSION = "1.0.0" as const;

export type AgentResultStatus = "ok" | "recoverable" | "blocked";

export interface AgentActionSummary {
  action: string;
  resource?: string;
  outcome: "ok" | "denied" | "error" | "skipped";
  detail?: string;
}

export interface AgentFinding {
  code: string;
  severity: "hard" | "advisory" | "info";
  message: string;
  evidenceRef?: string;
}

export interface AgentLineage {
  orchestratorRunId: string;
  candidateId?: string;
  sourceCandidateId?: string;
  parentCandidateId?: string;
  agentRole: AgentRole;
  agentSessionId: string;
  strategyId?: string;
  strategyBundleId?: string;
  modelVersion?: string;
  promptBundleHash?: string;
  contextHash?: string;
  usedEvidenceRefs: string[];
  workPackageId?: string;
  workPackageHash?: string;
}

export interface AgentResultBase {
  schema: typeof AGENT_RESULT_SCHEMA;
  version: typeof AGENT_RESULT_VERSION;
  status: AgentResultStatus;
  agentRole: AgentRole;
  candidateId?: string;
  sessionId: string;
  lineage: AgentLineage;
  stopReason: string;
  actionsTaken: AgentActionSummary[];
  /** 原始业务细节（可序列化）；不承载思维链 */
  details?: Record<string, unknown>;
}

export interface DraftAgentResult extends AgentResultBase {
  agentRole: "novelos_agentic";
  text: string;
  unresolvedFindings: AgentFinding[];
  usedEvidenceRefs: string[];
  fallback?: boolean;
  repairRounds?: number;
}

export interface FactGuardResult extends AgentResultBase {
  agentRole: "fact_guard" | "final_fact_recheck";
  passed: boolean;
  hardFindings: AgentFinding[];
  advisoryFindings: AgentFinding[];
  checkedFacts: string[];
  sourceRefs: string[];
}

export interface TextSpanContract {
  start: number;
  end: number;
  text?: string;
}

export interface EditorialResult extends AgentResultBase {
  agentRole: "author_style";
  sourceCandidateId: string;
  text?: string;
  changedSpans?: TextSpanContract[];
  preservationRisk: "low" | "medium" | "high";
  failureKind?:
    | "no_guidance"
    | "prompt_rejected"
    | "empty_result"
    | "model_timeout"
    | "model_error"
    | string;
  strategyBundleId?: string;
}

export interface StoryPreservationResult extends AgentResultBase {
  agentRole: "story_preservation";
  preserved: boolean;
  unverifiable: boolean;
  rejectionType:
    | "missing_event"
    | "replaced_event"
    | "order_violation"
    | "unverifiable"
    | null;
  sourceCandidateId: string;
  optimizedCandidateId?: string;
  reason: string;
}

export interface CommitResult extends AgentResultBase {
  agentRole: "final_state_commit";
  committed: boolean;
  chapterFilePath: string | null;
  stateCommitted: number;
  stateRejected: number;
  artifactHash?: string;
  revision?: string;
  authorizationTraceId?: string;
}

export type UnifiedAgentResult =
  | DraftAgentResult
  | FactGuardResult
  | EditorialResult
  | StoryPreservationResult
  | CommitResult
  | AgentResultBase;

export interface ContractValidation {
  ok: boolean;
  errors: string[];
}

function requireString(
  errors: string[],
  label: string,
  value: unknown,
  allowEmpty = false,
): void {
  if (typeof value !== "string") {
    errors.push(`${label} 必须是字符串`);
    return;
  }
  if (!allowEmpty && !value.trim()) {
    errors.push(`${label} 不能为空`);
  }
}

function requireLineage(
  errors: string[],
  lineage: AgentLineage | undefined,
  role: AgentRole,
): void {
  if (!lineage || typeof lineage !== "object") {
    errors.push("lineage 缺失");
    return;
  }
  requireString(errors, "lineage.orchestratorRunId", lineage.orchestratorRunId);
  requireString(errors, "lineage.agentSessionId", lineage.agentSessionId);
  if (lineage.agentRole !== role) {
    errors.push(
      `lineage.agentRole(${String(lineage.agentRole)}) 与结果角色(${role}) 不一致`,
    );
  }
  if (!Array.isArray(lineage.usedEvidenceRefs)) {
    errors.push("lineage.usedEvidenceRefs 必须是数组");
  }
}

/**
 * 通用结果校验：schema/version/status/session/lineage。
 * 缺少 candidate/session/来源引用时 fail closed（由具体角色规则补充）。
 */
export function validateAgentResultBase(
  result: AgentResultBase | null | undefined,
): ContractValidation {
  const errors: string[] = [];
  if (!result || typeof result !== "object") {
    return { ok: false, errors: ["结果为空"] };
  }
  if (result.schema !== AGENT_RESULT_SCHEMA) {
    errors.push(`schema 不匹配：${String(result.schema)}`);
  }
  if (result.version !== AGENT_RESULT_VERSION) {
    errors.push(`version 不匹配：${String(result.version)}`);
  }
  if (!["ok", "recoverable", "blocked"].includes(result.status)) {
    errors.push(`非法 status：${String(result.status)}`);
  }
  requireString(errors, "sessionId", result.sessionId);
  requireString(errors, "stopReason", result.stopReason, true);
  requireString(errors, "agentRole", result.agentRole);
  if (!Array.isArray(result.actionsTaken)) {
    errors.push("actionsTaken 必须是数组");
  }
  if (result.agentRole) {
    requireLineage(errors, result.lineage, result.agentRole);
  }
  return { ok: errors.length === 0, errors };
}

export function validateDraftAgentResult(
  result: DraftAgentResult | null | undefined,
): ContractValidation {
  const base = validateAgentResultBase(result);
  const errors = [...base.errors];
  if (!result) return { ok: false, errors };
  if (result.agentRole !== "novelos_agentic") {
    errors.push("DraftAgentResult.agentRole 必须是 novelos_agentic");
  }
  if (typeof result.text !== "string") {
    errors.push("text 必须是字符串");
  }
  if (result.status === "ok") {
    if (!result.candidateId?.trim()) {
      errors.push("status=ok 时 candidateId 必填");
    }
    if (!result.text.trim()) {
      errors.push("status=ok 时 text 不能为空");
    }
  }
  if (!Array.isArray(result.unresolvedFindings)) {
    errors.push("unresolvedFindings 必须是数组");
  }
  if (!Array.isArray(result.usedEvidenceRefs)) {
    errors.push("usedEvidenceRefs 必须是数组");
  }
  return { ok: errors.length === 0, errors };
}

export function validateFactGuardResult(
  result: FactGuardResult | null | undefined,
): ContractValidation {
  const base = validateAgentResultBase(result);
  const errors = [...base.errors];
  if (!result) return { ok: false, errors };
  if (result.agentRole !== "fact_guard" && result.agentRole !== "final_fact_recheck") {
    errors.push("FactGuardResult.agentRole 非法");
  }
  if (typeof result.passed !== "boolean") {
    errors.push("passed 必须是 boolean");
  }
  if (!result.candidateId?.trim()) {
    errors.push("candidateId 必填");
  }
  if (!Array.isArray(result.hardFindings)) errors.push("hardFindings 必须是数组");
  if (!Array.isArray(result.advisoryFindings)) {
    errors.push("advisoryFindings 必须是数组");
  }
  if (!Array.isArray(result.checkedFacts)) errors.push("checkedFacts 必须是数组");
  if (!Array.isArray(result.sourceRefs)) errors.push("sourceRefs 必须是数组");
  if (result.passed === false && result.status === "ok") {
    errors.push("passed=false 时 status 不得为 ok");
  }
  return { ok: errors.length === 0, errors };
}

export function validateEditorialResult(
  result: EditorialResult | null | undefined,
): ContractValidation {
  const base = validateAgentResultBase(result);
  const errors = [...base.errors];
  if (!result) return { ok: false, errors };
  if (result.agentRole !== "author_style") {
    errors.push("EditorialResult.agentRole 必须是 author_style");
  }
  requireString(errors, "sourceCandidateId", result.sourceCandidateId);
  if (!["low", "medium", "high"].includes(result.preservationRisk)) {
    errors.push(`非法 preservationRisk：${String(result.preservationRisk)}`);
  }
  if (result.status === "ok") {
    if (!result.candidateId?.trim()) {
      errors.push("status=ok 时 candidateId 必填");
    }
    if (typeof result.text !== "string" || !result.text.trim()) {
      errors.push("status=ok 时 text 必填");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateStoryPreservationResult(
  result: StoryPreservationResult | null | undefined,
): ContractValidation {
  const base = validateAgentResultBase(result);
  const errors = [...base.errors];
  if (!result) return { ok: false, errors };
  if (result.agentRole !== "story_preservation") {
    errors.push("StoryPreservationResult.agentRole 必须是 story_preservation");
  }
  if (typeof result.preserved !== "boolean") errors.push("preserved 必须是 boolean");
  if (typeof result.unverifiable !== "boolean") {
    errors.push("unverifiable 必须是 boolean");
  }
  requireString(errors, "sourceCandidateId", result.sourceCandidateId);
  requireString(errors, "reason", result.reason, true);
  if (result.preserved && result.status !== "ok") {
    errors.push("preserved=true 时 status 应为 ok");
  }
  if (!result.preserved && result.status === "ok") {
    errors.push("preserved=false 时 status 不得为 ok");
  }
  return { ok: errors.length === 0, errors };
}

export function validateCommitResult(
  result: CommitResult | null | undefined,
): ContractValidation {
  const base = validateAgentResultBase(result);
  const errors = [...base.errors];
  if (!result) return { ok: false, errors };
  if (result.agentRole !== "final_state_commit") {
    errors.push("CommitResult.agentRole 必须是 final_state_commit");
  }
  if (typeof result.committed !== "boolean") errors.push("committed 必须是 boolean");
  if (typeof result.stateCommitted !== "number") {
    errors.push("stateCommitted 必须是 number");
  }
  if (typeof result.stateRejected !== "number") {
    errors.push("stateRejected 必须是 number");
  }
  if (result.committed && result.status !== "ok") {
    errors.push("committed=true 时 status 应为 ok");
  }
  if (result.committed && !result.chapterFilePath) {
    errors.push("committed=true 时 chapterFilePath 必填");
  }
  return { ok: errors.length === 0, errors };
}

/** 按角色分发校验 */
export function validateUnifiedAgentResult(
  result: UnifiedAgentResult | null | undefined,
): ContractValidation {
  if (!result) return { ok: false, errors: ["结果为空"] };
  switch (result.agentRole) {
    case "novelos_agentic":
      return validateDraftAgentResult(result as DraftAgentResult);
    case "fact_guard":
    case "final_fact_recheck":
      return validateFactGuardResult(result as FactGuardResult);
    case "author_style":
      return validateEditorialResult(result as EditorialResult);
    case "story_preservation":
      return validateStoryPreservationResult(result as StoryPreservationResult);
    case "final_state_commit":
      return validateCommitResult(result as CommitResult);
    default:
      return validateAgentResultBase(result);
  }
}

/** trace 安全摘要：不写正文全文与思维链 */
export function summarizeAgentResult(
  result: UnifiedAgentResult,
): Record<string, unknown> {
  return {
    schema: result.schema,
    version: result.version,
    status: result.status,
    agentRole: result.agentRole,
    candidateId: result.candidateId ?? null,
    sessionId: result.sessionId,
    stopReason: result.stopReason,
    actionsTaken: result.actionsTaken,
    lineage: {
      orchestratorRunId: result.lineage.orchestratorRunId,
      candidateId: result.lineage.candidateId ?? null,
      sourceCandidateId: result.lineage.sourceCandidateId ?? null,
      parentCandidateId: result.lineage.parentCandidateId ?? null,
      agentRole: result.lineage.agentRole,
      agentSessionId: result.lineage.agentSessionId,
      strategyId: result.lineage.strategyId ?? null,
      strategyBundleId: result.lineage.strategyBundleId ?? null,
      modelVersion: result.lineage.modelVersion ?? null,
      promptBundleHash: result.lineage.promptBundleHash ?? null,
      contextHash: result.lineage.contextHash ?? null,
      usedEvidenceRefs: result.lineage.usedEvidenceRefs,
      workPackageId: result.lineage.workPackageId ?? null,
      workPackageHash: result.lineage.workPackageHash ?? null,
    },
    // 角色特有摘要
    ...("passed" in result
      ? {
          passed: (result as FactGuardResult).passed,
          hardFindingCount: (result as FactGuardResult).hardFindings.length,
        }
      : {}),
    ...("preservationRisk" in result
      ? {
          preservationRisk: (result as EditorialResult).preservationRisk,
          failureKind: (result as EditorialResult).failureKind ?? null,
          sourceCandidateId: (result as EditorialResult).sourceCandidateId,
        }
      : {}),
    ...("preserved" in result
      ? {
          preserved: (result as StoryPreservationResult).preserved,
          unverifiable: (result as StoryPreservationResult).unverifiable,
          rejectionType: (result as StoryPreservationResult).rejectionType,
        }
      : {}),
    ...("committed" in result
      ? {
          committed: (result as CommitResult).committed,
          stateCommitted: (result as CommitResult).stateCommitted,
          stateRejected: (result as CommitResult).stateRejected,
          chapterFilePath: (result as CommitResult).chapterFilePath,
        }
      : {}),
    ...("text" in result && typeof (result as DraftAgentResult).text === "string"
      ? { textChars: (result as DraftAgentResult).text.length }
      : {}),
  };
}
