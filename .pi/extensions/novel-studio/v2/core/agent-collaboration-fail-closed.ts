/**
 * AGENT-COLLABORATION-FAIL-CLOSED — 契约失败统一 hard block 辅助（核验 P1）
 *
 * 编排器代理结果适配失败时不得仅记 warning 继续生产。
 */

import type { HardBlockGuidance } from "./orchestrator-types.js";
import { AgentWorkPackageError } from "./agent-work-package.js";

export interface CollaborationContractFailure {
  stage: string;
  role: string;
  reason: string;
  code: string;
  retryable: boolean;
}

export function classifyCollaborationContractError(
  stage: string,
  role: string,
  err: unknown,
): CollaborationContractFailure {
  if (err instanceof AgentWorkPackageError) {
    const retryable =
      err.code === "validation_failed" ||
      err.code === "missing_field" ||
      err.code === "unknown_role";
    return {
      stage,
      role,
      reason: err.message,
      code: err.code,
      retryable,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    stage,
    role,
    reason: message,
    code: "collaboration_contract_error",
    retryable: /校验|validation|schema|契约/i.test(message),
  };
}

export function collaborationFailureGuidance(
  failure: CollaborationContractFailure,
): HardBlockGuidance {
  if (failure.retryable) {
    return {
      gate: "agent_result_schema",
      severityOverride: "recoverable",
      recoverable: true,
      retryPlan: { strategy: "retry_gate", maxAttempts: 1 },
      candidateDisposition: "blocked_evidence_only",
      prohibitedActions: [
        "accept_or_deliver_blocked_candidate",
        "save_blocked_candidate_as_chapter",
      ],
    };
  }
  return {
    gate: "agent_work_package",
    severityOverride: "hard",
    recoverable: false,
    candidateDisposition: "blocked_evidence_only",
    prohibitedActions: [
      "accept_or_deliver_blocked_candidate",
      "save_blocked_candidate_as_chapter",
    ],
  };
}

export function formatCollaborationFailureReason(
  failure: CollaborationContractFailure,
): string {
  return `多代理契约 fail-closed（${failure.role}/${failure.code}）：${failure.reason}`;
}
