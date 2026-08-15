/**
 * FAILURE-ENVELOPE — 统一生产 FailureEnvelope（P0）
 *
 * 扩展字段：failureClass / recoveryAction / attempt / maxAttempts /
 * chapterBudgetUsed / nextStep / traceId / completedWork
 *
 * 兼容：
 * - craft/failure-envelope.ts 历史 soft/hard_block 只读映射
 * - UnifiedFailureEnvelope.severity 仍写入兼容值供工具层重试
 */

import { createHash, randomBytes } from "node:crypto";
import {
  failureClassToCompatSeverity,
  mapLegacyFailureClass,
  type FailureClass,
} from "./failure-types.js";
import {
  decideRecovery,
  recoveryActionToRetryStrategy,
  classifyFailureFromGate,
} from "./recovery-decision-engine.js";
import { createRecoveryBudget, snapshotBudget } from "./recovery-budget.js";
import type {
  RecoveryAction,
  RecoveryBudget,
  RecoveryDecision,
} from "./recovery-types.js";
import type { AuditEvent, AuditStage } from "./audit/audit-event-types.js";
import { AUDIT_EVENT_SCHEMA_VERSION } from "./audit/audit-event-types.js";
import { createEventId } from "./audit/audit-event-ids.js";

// ============================================================================
// Unified production envelope
// ============================================================================

export interface UnifiedProductionFailureEnvelope {
  /** 统一失败分类（生产唯一真相） */
  failureClass: FailureClass;
  stage: string;
  gate?: string;
  reason: string;
  evidence?: unknown;
  completedWork?: string[];
  recoveryAction: RecoveryAction;
  recoverable: boolean;
  attempt: number;
  maxAttempts: number;
  chapterBudgetUsed?: Partial<RecoveryBudget>;
  userActionRequired?: string[];
  nextStep?: string;
  traceId: string;
  /**
   * AUDIT-1：事件因果链字段（Phase 1）。
   * 与 AuditEvent 对齐；未接线 store 时仍生成 id，供后续 append failure_recorded。
   */
  eventId?: string;
  parentEventId?: string | null;
  causedByEventId?: string | null;
  /** 兼容工具层：severity 由 failureClass 派生 */
  severity: "preflight" | "recoverable" | "hard" | "fatal";
  /** 兼容旧字段 */
  degradedTo: "hard_block";
  retryPlan?: {
    strategy:
      | "revise_inputs_and_retry_same_chapter"
      | "retry_gate"
      | "chapter_level_retry"
      | "terminal_block_no_retry";
    maxAttempts: number;
  };
  candidateDisposition?: "blocked_evidence_only";
  prohibitedActions?: Array<
    | "accept_or_deliver_blocked_candidate"
    | "save_blocked_candidate_as_chapter"
    | "skip_to_next_chapter"
  >;
  blockCategory?:
    | "system_verifier_uncertain"
    | "author_input_conflict"
    | "confirmed_content_omission";
}

export interface BuildFailureEnvelopeInput {
  stage: string;
  reason: string;
  gate?: string;
  failureClass?: FailureClass;
  /** 兼容旧 severity 输入 */
  severity?: string;
  evidence?: unknown;
  completedWork?: string[];
  attempt?: number;
  maxAttempts?: number;
  budget?: RecoveryBudget;
  recoverable?: boolean;
  userActionRequired?: string[];
  candidateDisposition?: "blocked_evidence_only";
  prohibitedActions?: UnifiedProductionFailureEnvelope["prohibitedActions"];
  blockCategory?: UnifiedProductionFailureEnvelope["blockCategory"];
  /** 审计轨迹 id（可选；默认自动生成） */
  traceId?: string;
  /** 因果链（可选） */
  eventId?: string;
  parentEventId?: string | null;
  causedByEventId?: string | null;
  /** 覆盖决策引擎 */
  recoveryHints?: {
    schemaOrParseError?: boolean;
    coverageInsufficient?: boolean;
    confirmedFactConflict?: boolean;
    storyPreservationUncertain?: boolean;
    chapterSaveFailed?: boolean;
    stateCommitFailed?: boolean;
    staleRevision?: boolean;
    interruptSignal?: import("./recovery-types.js").InterruptSource | null;
  };
  /** 强制 recoveryAction（跳过引擎） */
  forceRecoveryAction?: RecoveryAction;
}

function newTraceId(): string {
  return `fail-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function newFailureEventId(): string {
  return `evt-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/**
 * 构建统一生产 FailureEnvelope。
 * 始终包含 failureClass + recoveryAction；severity 仅作兼容派生。
 */
export function buildProductionFailureEnvelope(
  input: BuildFailureEnvelopeInput,
): UnifiedProductionFailureEnvelope {
  const failureClass: FailureClass =
    input.failureClass ??
    (input.severity
      ? mapLegacyFailureClass(input.severity)
      : classifyFailureFromGate({
          gate: input.gate,
          stage: input.stage,
          severityOverride: input.severity,
          recoverable: input.recoverable,
        }));

  const attempt = input.attempt ?? 0;
  const maxAttempts = input.maxAttempts ?? 1;
  const budget = input.budget ?? createRecoveryBudget();

  let decision: RecoveryDecision;
  if (input.forceRecoveryAction) {
    decision = {
      recoveryAction: input.forceRecoveryAction,
      allowed: input.forceRecoveryAction !== "stop",
      reason: input.reason,
      failureClass,
      nextLifecycleState:
        input.forceRecoveryAction === "checkpoint"
          ? "checkpoint"
          : failureClass === "recoverable"
            ? "retrying"
            : "blocked",
      maxAttempts,
      attempt,
      userActionRequired: input.userActionRequired,
      changesCondition: input.forceRecoveryAction.startsWith("retry"),
    };
  } else {
    decision = decideRecovery({
      failureClass,
      stage: input.stage,
      gate: input.gate,
      reason: input.reason,
      attempt,
      maxAttempts,
      budget,
      forbidOneShotRawFallback: true,
      ...input.recoveryHints,
    });
  }

  const severity = failureClassToCompatSeverity(failureClass);
  const recoverable =
    input.recoverable ??
    (failureClass === "recoverable" && decision.recoveryAction !== "stop");

  const strategy = recoveryActionToRetryStrategy(decision.recoveryAction);
  const envelope: UnifiedProductionFailureEnvelope = {
    failureClass,
    stage: input.stage,
    gate: input.gate,
    reason: input.reason,
    evidence: input.evidence,
    completedWork: input.completedWork,
    recoveryAction: decision.recoveryAction,
    recoverable,
    attempt,
    maxAttempts: decision.maxAttempts,
    chapterBudgetUsed: {
      usedStageAttempts: budget.usedStageAttempts,
      usedTotalAttempts: budget.usedTotalAttempts,
      usedModelCalls: budget.usedModelCalls,
      usedRecoveryModelCalls: budget.usedRecoveryModelCalls,
      usedLatencyMs: budget.usedLatencyMs,
    },
    userActionRequired:
      input.userActionRequired ?? decision.userActionRequired,
    nextStep: decision.nextCondition ?? decision.reason,
    traceId: input.traceId ?? newTraceId(),
    eventId: input.eventId ?? newFailureEventId(),
    parentEventId: input.parentEventId ?? null,
    causedByEventId: input.causedByEventId ?? null,
    severity,
    degradedTo: "hard_block",
    retryPlan:
      recoverable &&
      (decision.recoveryAction === "retry_gate" ||
        decision.recoveryAction === "retry_stage" ||
        decision.recoveryAction === "regenerate_candidate")
        ? {
            strategy:
              strategy === "terminal_block_no_retry"
                ? "chapter_level_retry"
                : strategy,
            maxAttempts: decision.maxAttempts,
          }
        : decision.recoveryAction === "user_fix"
          ? {
              strategy: "revise_inputs_and_retry_same_chapter",
              maxAttempts: 0,
            }
          : undefined,
    candidateDisposition: input.candidateDisposition,
    prohibitedActions: input.prohibitedActions,
    blockCategory: input.blockCategory,
  };
  return envelope;
}

/**
 * 转为 UnifiedFailureEnvelope 形状（orchestrator-types 兼容）。
 */
export function toUnifiedFailureEnvelope(
  env: UnifiedProductionFailureEnvelope,
): {
  stage: string;
  severity: "preflight" | "recoverable" | "hard" | "fatal";
  gate?: string;
  reason: string;
  recoverable: boolean;
  degradedTo: "hard_block";
  candidateDisposition?: "blocked_evidence_only";
  userActionRequired?: string[];
  prohibitedActions?: UnifiedProductionFailureEnvelope["prohibitedActions"];
  retryPlan?: UnifiedProductionFailureEnvelope["retryPlan"];
  blockCategory?: UnifiedProductionFailureEnvelope["blockCategory"];
  failureClass: FailureClass;
  recoveryAction: RecoveryAction;
  attempt: number;
  maxAttempts: number;
  nextStep?: string;
  traceId: string;
  eventId?: string;
  parentEventId?: string | null;
  causedByEventId?: string | null;
  chapterBudgetUsed?: Partial<RecoveryBudget>;
  completedWork?: string[];
} {
  return {
    stage: env.stage,
    severity: env.severity,
    gate: env.gate,
    reason: env.reason,
    recoverable: env.recoverable,
    degradedTo: "hard_block",
    candidateDisposition: env.candidateDisposition,
    userActionRequired: env.userActionRequired,
    prohibitedActions: env.prohibitedActions,
    retryPlan: env.retryPlan,
    blockCategory: env.blockCategory,
    failureClass: env.failureClass,
    recoveryAction: env.recoveryAction,
    attempt: env.attempt,
    maxAttempts: env.maxAttempts,
    nextStep: env.nextStep,
    traceId: env.traceId,
    eventId: env.eventId,
    parentEventId: env.parentEventId,
    causedByEventId: env.causedByEventId,
    chapterBudgetUsed: env.chapterBudgetUsed,
    completedWork: env.completedWork,
  };
}

/** 旧 craft envelope → 统一 failureClass */
export function mapCraftEnvelopeToFailureClass(input: {
  severity?: string;
}): FailureClass {
  return mapLegacyFailureClass(input.severity);
}

/** 稳定 hash 供 checkpoint 绑定 */
export function hashFailureEnvelope(
  env: Pick<
    UnifiedProductionFailureEnvelope,
    "failureClass" | "stage" | "gate" | "reason" | "recoveryAction"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        failureClass: env.failureClass,
        stage: env.stage,
        gate: env.gate ?? null,
        reason: env.reason,
        recoveryAction: env.recoveryAction,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

export function budgetSnapshotForTrace(budget: RecoveryBudget): Record<string, unknown> {
  const snap = snapshotBudget(budget);
  return {
    ...budget,
    snapshot: snap,
  };
}

/**
 * 将统一生产失败信封转为 failure_recorded AuditEvent。
 * 供 AuditEventStore.append 或投影层使用；不落盘。
 */
export function productionFailureToAuditEvent(
  env: UnifiedProductionFailureEnvelope,
  ids: {
    traceId?: string;
    runId: string;
    parentEventId?: string | null;
    sequence: number;
    causedByEventId?: string | null;
  },
): AuditEvent {
  return {
    schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
    traceId: ids.traceId ?? env.traceId,
    runId: ids.runId,
    eventId: env.eventId ?? createEventId(),
    parentEventId:
      ids.parentEventId !== undefined ? ids.parentEventId : (env.parentEventId ?? null),
    causedByEventId:
      ids.causedByEventId !== undefined
        ? ids.causedByEventId
        : (env.causedByEventId ?? null),
    sequence: ids.sequence,
    timestamp: Date.now(),
    actor: "orchestrator",
    stage: (env.stage as AuditStage) || "unknown",
    eventType: "failure_recorded",
    status: "failed",
    evidenceLevel: "observed",
    failureClass: env.failureClass,
    gate: env.gate,
    recoveryAction: env.recoveryAction,
    attempt: env.attempt,
    maxAttempts: env.maxAttempts,
    userActionRequired: env.userActionRequired,
    decisionReason: env.reason,
    payload: {
      nextStep: env.nextStep,
      completedWork: env.completedWork,
      chapterBudgetUsed: env.chapterBudgetUsed,
      blockCategory: env.blockCategory,
      candidateDisposition: env.candidateDisposition,
      // evidence 可能较大；正式接线时应拆 artifact
      evidence: env.evidence,
    },
  };
}
