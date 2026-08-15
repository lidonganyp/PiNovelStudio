/**
 * AUDIT-EVENT-SCHEMA — 事件校验与工厂（Phase 0）
 *
 * 校验：
 * - 必填字段完整
 * - sequence 正整数
 * - eventId 形态合法
 * - run_started 的 parentEventId 必须为 null
 * - evidenceLevel 合法
 * - failureClass 禁止 soft/hard 生产值
 */

import {
  AUDIT_EVENT_SCHEMA_VERSION,
  type AuditActor,
  type AuditCapability,
  type AuditEvent,
  type AuditEventStatus,
  type AuditEventType,
  type AuditFailureClass,
  type AuditStage,
  type EvidenceLevel,
} from "./audit-event-types.js";
import { createEventId, isWellFormedId } from "./audit-event-ids.js";

const ACTORS = new Set<AuditActor>([
  "system",
  "orchestrator",
  "tool_runtime",
  "model",
  "user",
  "recovery",
  "governance",
]);

const STATUSES = new Set<AuditEventStatus>([
  "started",
  "completed",
  "failed",
  "denied",
  "timeout",
  "interrupted",
  "recovered",
  "blocked",
  "skipped",
  "unknown",
]);

const EVIDENCE_LEVELS = new Set<EvidenceLevel>([
  "observed",
  "confirmed",
  "derived",
  "unavailable",
]);

const FAILURE_CLASSES = new Set<AuditFailureClass>([
  "preflight",
  "recoverable",
  "interrupted",
  "blocked",
  "fatal",
]);

const LEGACY_FAILURE_BANNED = new Set(["soft", "hard", "hard_block"]);

export interface AuditEventValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface AuditEventValidationResult {
  ok: boolean;
  issues: AuditEventValidationIssue[];
}

export type CreateAuditEventInput = Omit<
  AuditEvent,
  "schemaVersion" | "eventId" | "timestamp" | "sequence"
> & {
  schemaVersion?: string;
  eventId?: string;
  timestamp?: number;
  sequence: number;
};

/** 构造一条合法事件（不落盘） */
export function createAuditEvent(input: CreateAuditEventInput): AuditEvent {
  const event: AuditEvent = {
    schemaVersion: input.schemaVersion ?? AUDIT_EVENT_SCHEMA_VERSION,
    traceId: input.traceId,
    runId: input.runId,
    eventId: input.eventId ?? createEventId(input.timestamp),
    parentEventId: input.parentEventId,
    causedByEventId: input.causedByEventId,
    sequence: input.sequence,
    timestamp: input.timestamp ?? Date.now(),
    actor: input.actor,
    stage: input.stage,
    eventType: input.eventType,
    status: input.status,
    capability: input.capability,
    requestedRoute: input.requestedRoute,
    actualProvider: input.actualProvider,
    actualModel: input.actualModel,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    sourceRefs: input.sourceRefs,
    artifactRefs: input.artifactRefs,
    decisionReason: input.decisionReason,
    redaction: input.redaction,
    candidateId: input.candidateId,
    parentCandidateId: input.parentCandidateId,
    revision: input.revision,
    approvalId: input.approvalId,
    evidenceLevel: input.evidenceLevel,
    durationMs: input.durationMs,
    failureClass: input.failureClass,
    gate: input.gate,
    recoveryAction: input.recoveryAction,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    userActionRequired: input.userActionRequired,
    payload: input.payload,
  };

  const result = validateAuditEvent(event);
  if (!result.ok) {
    const msg = result.issues
      .filter((i) => i.severity === "error")
      .map((i) => `${i.path}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid AuditEvent: ${msg}`);
  }
  return event;
}

export function validateAuditEvent(event: unknown): AuditEventValidationResult {
  const issues: AuditEventValidationIssue[] = [];
  if (!event || typeof event !== "object") {
    return {
      ok: false,
      issues: [{ path: "", message: "event must be an object", severity: "error" }],
    };
  }
  const e = event as Record<string, unknown>;

  requireString(e, "schemaVersion", issues);
  requireString(e, "traceId", issues);
  requireString(e, "runId", issues);
  requireString(e, "eventId", issues);
  requireString(e, "actor", issues);
  requireString(e, "stage", issues);
  requireString(e, "eventType", issues);
  requireString(e, "status", issues);
  requireString(e, "evidenceLevel", issues);

  if (!isWellFormedId(String(e.traceId ?? ""))) {
    issues.push({ path: "traceId", message: "malformed id", severity: "error" });
  }
  if (!isWellFormedId(String(e.runId ?? ""))) {
    issues.push({ path: "runId", message: "malformed id", severity: "error" });
  }
  if (!isWellFormedId(String(e.eventId ?? ""))) {
    issues.push({ path: "eventId", message: "malformed id", severity: "error" });
  }

  if (typeof e.sequence !== "number" || !Number.isInteger(e.sequence) || e.sequence < 1) {
    issues.push({
      path: "sequence",
      message: "must be integer >= 1",
      severity: "error",
    });
  }
  if (typeof e.timestamp !== "number" || !Number.isFinite(e.timestamp)) {
    issues.push({
      path: "timestamp",
      message: "must be finite number (unix ms)",
      severity: "error",
    });
  }

  if (e.parentEventId !== null && e.parentEventId !== undefined) {
    if (typeof e.parentEventId !== "string" || !isWellFormedId(e.parentEventId)) {
      issues.push({
        path: "parentEventId",
        message: "must be null or well-formed id",
        severity: "error",
      });
    }
  }

  if (e.eventType === "run_started" && e.parentEventId !== null) {
    issues.push({
      path: "parentEventId",
      message: "run_started must have parentEventId=null",
      severity: "error",
    });
  }

  if (typeof e.actor === "string" && !ACTORS.has(e.actor as AuditActor)) {
    issues.push({
      path: "actor",
      message: `unknown actor: ${e.actor}`,
      severity: "error",
    });
  }
  if (typeof e.status === "string" && !STATUSES.has(e.status as AuditEventStatus)) {
    issues.push({
      path: "status",
      message: `unknown status: ${e.status}`,
      severity: "error",
    });
  }
  if (
    typeof e.evidenceLevel === "string" &&
    !EVIDENCE_LEVELS.has(e.evidenceLevel as EvidenceLevel)
  ) {
    issues.push({
      path: "evidenceLevel",
      message: `unknown evidenceLevel: ${e.evidenceLevel}`,
      severity: "error",
    });
  }

  if (e.failureClass !== undefined && e.failureClass !== null) {
    const fc = String(e.failureClass).toLowerCase();
    if (LEGACY_FAILURE_BANNED.has(fc)) {
      issues.push({
        path: "failureClass",
        message: `legacy failureClass banned in production write: ${e.failureClass}`,
        severity: "error",
      });
    } else if (!FAILURE_CLASSES.has(fc as AuditFailureClass)) {
      issues.push({
        path: "failureClass",
        message: `unknown failureClass: ${e.failureClass}`,
        severity: "error",
      });
    }
  }

  if (e.capability !== undefined && e.capability !== null && typeof e.capability !== "string") {
    issues.push({
      path: "capability",
      message: "must be string when present",
      severity: "error",
    });
  }

  // stage / eventType 允许扩展；未知值仅 warning
  if (typeof e.stage === "string" && e.stage === "") {
    issues.push({ path: "stage", message: "empty stage", severity: "error" });
  }
  if (typeof e.eventType === "string" && e.eventType === "") {
    issues.push({ path: "eventType", message: "empty eventType", severity: "error" });
  }

  const hasError = issues.some((i) => i.severity === "error");
  return { ok: !hasError, issues };
}

function requireString(
  e: Record<string, unknown>,
  path: string,
  issues: AuditEventValidationIssue[],
): void {
  if (typeof e[path] !== "string" || (e[path] as string).length === 0) {
    issues.push({ path, message: "required non-empty string", severity: "error" });
  }
}

/** 事件类型 → 默认 status 映射（接线辅助） */
export function defaultStatusForEventType(eventType: AuditEventType): AuditEventStatus {
  switch (eventType) {
    case "run_started":
    case "context_compile_started":
    case "model_turn_started":
    case "tool_call_requested":
    case "tool_call_started":
    case "repair_started":
    case "stage_started":
    case "commit_started":
    case "chapter_save_attempted":
    case "state_commit_attempted":
    case "compensation_started":
    case "approval_requested":
    case "retry_reserved":
      return "started";
    case "tool_call_denied":
      return "denied";
    case "tool_call_timeout":
      return "timeout";
    case "run_interrupted":
    case "tool_call_interrupted":
      return "interrupted";
    case "run_recovered":
    case "checkpoint_resumed":
      return "recovered";
    case "candidate_blocked":
      return "blocked";
    case "run_failed":
    case "context_compile_failed":
    case "model_turn_failed":
    case "chapter_save_failed":
    case "state_commit_failed":
    case "commit_failed":
    case "failure_recorded":
      return "failed";
    default:
      return "completed";
  }
}

/** stage 默认映射 */
export function defaultStageForEventType(eventType: AuditEventType): AuditStage {
  if (
    eventType.startsWith("run_") ||
    eventType.startsWith("checkpoint_") ||
    eventType === "stage_started" ||
    eventType === "compensation_started"
  ) {
    return "run";
  }
  if (eventType.startsWith("context_")) return "context_compile";
  if (eventType.startsWith("model_turn_")) return "model_turn";
  if (eventType.startsWith("tool_")) return "tool";
  if (eventType.startsWith("candidate_") || eventType === "gate_evaluated") return "candidate";
  if (
    eventType.startsWith("repair_") ||
    eventType === "retry_scheduled" ||
    eventType === "retry_reserved"
  ) {
    return "repair";
  }
  if (eventType === "approval_requested") return "proxy_approval";
  if (eventType.startsWith("chapter_save_")) return "chapter_save";
  if (
    eventType.startsWith("state_commit_") ||
    eventType === "final_submission" ||
    eventType === "commit_started" ||
    eventType === "commit_failed" ||
    eventType === "state_recomputed"
  ) {
    return "state_commit";
  }
  if (eventType.startsWith("user_")) return "user_revision";
  if (eventType === "failure_recorded" || eventType === "evidence_revoked") return "recovery";
  return "unknown";
}

export type { AuditCapability };
