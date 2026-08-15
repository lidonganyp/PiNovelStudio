/**
 * LEGACY-TRACE-COMPAT — 旧结构 → AuditEvent 只读映射（Phase 0/1）
 *
 * 生产只写新结构；本模块仅用于读取历史 Trajectory / craft FailureEnvelope /
 * UnifiedFailureEnvelope / quality-trace 片段。
 */

import type {
  AuditEvent,
  AuditEventType,
  AuditFailureClass,
  AuditStage,
  EvidenceLevel,
} from "./audit-event-types.js";
import { AUDIT_EVENT_SCHEMA_VERSION } from "./audit-event-types.js";
import { createEventId } from "./audit-event-ids.js";
import { mapLegacyFailureClass } from "../failure-types.js";

// ============================================================================
// Trajectory entry → AuditEvent 映射
// ============================================================================

export interface LegacyTrajectoryEntry {
  type: string;
  timestamp: number;
  data: unknown;
}

const TRAJECTORY_TYPE_MAP: Record<
  string,
  { eventType: AuditEventType; stage: AuditStage; status: AuditEvent["status"] }
> = {
  session_start: { eventType: "run_started", stage: "run", status: "started" },
  session_end: { eventType: "run_finished", stage: "run", status: "completed" },
  message: { eventType: "custom", stage: "agentic", status: "completed" },
  tool_event: { eventType: "tool_result_received", stage: "tool", status: "completed" },
  checkpoint: { eventType: "checkpoint_saved", stage: "recovery", status: "completed" },
  output: { eventType: "candidate_created", stage: "candidate", status: "completed" },
  failure: { eventType: "failure_recorded", stage: "unknown", status: "failed" },
  budget: { eventType: "custom", stage: "run", status: "completed" },
  evidence_plan: { eventType: "custom", stage: "agentic", status: "completed" },
  verifier_report: { eventType: "gate_evaluated", stage: "gate", status: "completed" },
  patch_proposal: { eventType: "repair_started", stage: "repair", status: "started" },
  repair_round: { eventType: "repair_completed", stage: "repair", status: "completed" },
  ranked_evidence: { eventType: "custom", stage: "agentic", status: "completed" },
  tool_visibility: { eventType: "custom", stage: "tool", status: "completed" },
  tool_call_metrics: {
    eventType: "tool_result_received",
    stage: "tool",
    status: "completed",
  },
};

export interface MapTrajectoryOptions {
  traceId: string;
  runId: string;
  /** sequence 起点（默认 1） */
  sequenceStart?: number;
  parentEventId?: string | null;
}

/**
 * 将 TrajectoryStore 条目映射为只读 AuditEvent 列表。
 * 不保证因果父引用完整；evidenceLevel=derived。
 */
export function mapTrajectoryEntriesToAuditEvents(
  entries: LegacyTrajectoryEntry[],
  options: MapTrajectoryOptions,
): AuditEvent[] {
  const start = options.sequenceStart ?? 1;
  let parent: string | null = options.parentEventId ?? null;
  const out: AuditEvent[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const mapped = TRAJECTORY_TYPE_MAP[entry.type] ?? {
      eventType: "custom" as AuditEventType,
      stage: "unknown" as AuditStage,
      status: "unknown" as AuditEvent["status"],
    };
    const eventId = createEventId(entry.timestamp);
    const data = entry.data as Record<string, unknown> | null;
    const failureBits = extractFailureBits(entry.type, data);

    const event: AuditEvent = {
      schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
      traceId: options.traceId,
      runId: options.runId,
      eventId,
      parentEventId: mapped.eventType === "run_started" ? null : parent,
      sequence: start + i,
      timestamp: entry.timestamp,
      actor: "system",
      stage: failureBits.stage ?? mapped.stage,
      eventType: mapped.eventType,
      status: mapped.status,
      evidenceLevel: "derived",
      failureClass: failureBits.failureClass,
      gate: failureBits.gate,
      recoveryAction: failureBits.recoveryAction,
      attempt: failureBits.attempt,
      maxAttempts: failureBits.maxAttempts,
      userActionRequired: failureBits.userActionRequired,
      decisionReason: failureBits.reason,
      payload: {
        legacyTrajectoryType: entry.type,
        legacyData: sanitizeLegacyData(data),
      },
    };
    out.push(event);
    parent = eventId;
  }
  return out;
}

// ============================================================================
// FailureEnvelope 兼容读取
// ============================================================================

export interface LegacyFailureLike {
  stage?: string;
  severity?: string;
  failureClass?: string;
  gate?: string;
  reason?: string;
  evidence?: unknown;
  recoverable?: boolean;
  retryPlan?: unknown;
  recoveryAction?: string;
  attempt?: number;
  maxAttempts?: number;
  userActionRequired?: string[] | boolean | string;
  traceId?: string;
  nextStep?: string;
  completedWork?: string[];
}

export interface NormalizedFailureRead {
  failureClass: AuditFailureClass;
  stage: string;
  gate?: string;
  reason: string;
  recoverable: boolean;
  recoveryAction?: string;
  attempt?: number;
  maxAttempts?: number;
  userActionRequired?: string[];
  evidence?: unknown;
  legacySeverity?: string;
  traceId?: string;
  nextStep?: string;
  completedWork?: string[];
  evidenceLevel: EvidenceLevel;
}

/** 任意旧失败结构 → 归一化只读视图 */
export function mapLegacyFailureToNormalized(
  input: LegacyFailureLike | null | undefined,
): NormalizedFailureRead | null {
  if (!input || typeof input !== "object") return null;
  const failureClass = mapLegacyFailureClass(
    input.failureClass ?? input.severity,
  ) as AuditFailureClass;
  const userActionRequired = normalizeUserActions(input.userActionRequired);
  return {
    failureClass,
    stage: String(input.stage ?? "unknown"),
    gate: input.gate,
    reason: String(input.reason ?? ""),
    recoverable: Boolean(input.recoverable),
    recoveryAction: input.recoveryAction,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    userActionRequired,
    evidence: input.evidence,
    legacySeverity: input.severity,
    traceId: input.traceId,
    nextStep: input.nextStep,
    completedWork: input.completedWork,
    evidenceLevel: "derived",
  };
}

/** 归一化失败 → failure_recorded AuditEvent 草稿字段 */
export function failureToAuditEventFields(
  failure: NormalizedFailureRead,
  ids: { traceId: string; runId: string; parentEventId: string | null; sequence: number },
): AuditEvent {
  return {
    schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
    traceId: ids.traceId,
    runId: ids.runId,
    eventId: createEventId(),
    parentEventId: ids.parentEventId,
    sequence: ids.sequence,
    timestamp: Date.now(),
    actor: "orchestrator",
    stage: (failure.stage as AuditStage) || "unknown",
    eventType: "failure_recorded",
    status: "failed",
    evidenceLevel: failure.evidenceLevel,
    failureClass: failure.failureClass,
    gate: failure.gate,
    recoveryAction: failure.recoveryAction,
    attempt: failure.attempt,
    maxAttempts: failure.maxAttempts,
    userActionRequired: failure.userActionRequired,
    decisionReason: failure.reason,
    payload: {
      legacySeverity: failure.legacySeverity,
      nextStep: failure.nextStep,
      completedWork: failure.completedWork,
      // evidence 可能很大；调用方应再拆 artifact
      evidence: failure.evidence,
    },
  };
}

// ============================================================================
// 旧字段兼容映射表（文档性导出，供测试/文档引用）
// ============================================================================

/**
 * 旧字段 → 新字段映射表。
 * 仅读取；生产写入必须用右侧新字段。
 */
export const LEGACY_FIELD_COMPAT_MAP = {
  // craft FailureEnvelope
  "craft.severity=soft": "failureClass=recoverable",
  "craft.severity=hard_block": "failureClass=blocked",
  "craft.severity=preflight": "failureClass=preflight",
  "craft.severity=recoverable": "failureClass=recoverable",
  "craft.gate": "gate",
  "craft.retryPlan": "recoveryAction + retryPlan (compat)",
  "craft.userActionRequired": "userActionRequired",
  // TrajectoryFailureEnvelope
  "trajectory.severity": "failureClass (via mapLegacyFailureClass)",
  "trajectory.retryPlan(string)": "recoveryAction / decisionReason",
  "trajectory.userActionRequired(boolean)": "userActionRequired (array preferred)",
  // UnifiedFailureEnvelope
  "unified.severity": "compat only; production truth = failureClass",
  "unified.failureClass": "failureClass",
  "unified.recoveryAction": "recoveryAction",
  "unified.traceId": "traceId (run/event ids preferred for chain)",
  "unified.attempt/maxAttempts": "attempt/maxAttempts",
  // TrajectoryStore entry
  "trajectory.type": "eventType (via TRAJECTORY_TYPE_MAP)",
  "trajectory.timestamp": "timestamp",
  "trajectory.data": "payload.legacyData (read-only)",
  // quality-trace
  "quality-trace.gates[]": "gate_evaluated projection",
  "quality-trace.failureEnvelopes[]": "failure_recorded projection",
  "quality-trace final selection": "final_submission projection",
} as const;

// ============================================================================
// helpers
// ============================================================================

function extractFailureBits(
  type: string,
  data: Record<string, unknown> | null,
): {
  failureClass?: AuditFailureClass;
  stage?: AuditStage;
  gate?: string;
  recoveryAction?: string;
  attempt?: number;
  maxAttempts?: number;
  userActionRequired?: string[] | boolean;
  reason?: string;
} {
  if (type !== "failure" || !data) return {};
  const normalized = mapLegacyFailureToNormalized(data as LegacyFailureLike);
  if (!normalized) return {};
  return {
    failureClass: normalized.failureClass,
    stage: (normalized.stage as AuditStage) || "unknown",
    gate: normalized.gate,
    recoveryAction: normalized.recoveryAction,
    attempt: normalized.attempt,
    maxAttempts: normalized.maxAttempts,
    userActionRequired: normalized.userActionRequired,
    reason: normalized.reason,
  };
}

function normalizeUserActions(
  value: string[] | boolean | string | undefined,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "boolean") return value ? ["user_action_required"] : undefined;
  if (typeof value === "string" && value.length > 0) return [value];
  return undefined;
}

function sanitizeLegacyData(data: unknown): unknown {
  if (data === null || data === undefined) return null;
  if (typeof data !== "object") return data;
  // 浅拷贝，截断超大字符串，避免映射时把完整正文抬进事件
  const obj = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > 2000) {
      out[k] = `${v.slice(0, 2000)}…[truncated ${v.length} chars]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
