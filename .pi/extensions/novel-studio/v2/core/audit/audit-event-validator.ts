/**
 * AUDIT-EVENT-VALIDATOR — run 级完整性诊断（Phase 2/5）
 *
 * 检查：
 * - 重复 eventId
 * - sequence 跳号
 * - 孤儿 parentEventId
 * - 缺 run_started / 终止事件
 * - 工具授权覆盖（requested → authorized/denied）
 * - 已授权工具结果覆盖
 */

import type { AuditEvent, AuditEventType } from "./audit-event-types.js";
import { validateAuditEvent } from "./audit-event-schema.js";

export interface CompletenessIssue {
  code:
    | "invalid_event"
    | "duplicate_event_id"
    | "sequence_gap"
    | "orphan_parent"
    | "missing_run_started"
    | "missing_terminal"
    | "tool_request_without_auth"
    | "authorized_tool_without_result"
    | "retry_without_cause";
  message: string;
  eventId?: string;
  sequence?: number;
}

export interface TraceCompletenessReport {
  ok: boolean;
  eventCount: number;
  issues: CompletenessIssue[];
  runStarted: boolean;
  runTerminal: boolean;
  openToolCallIds: string[];
}

const TERMINAL: ReadonlySet<AuditEventType> = new Set([
  "run_finished",
  "run_failed",
  "run_interrupted",
]);

const TOOL_AUTH_RESOLVED: ReadonlySet<AuditEventType> = new Set([
  "tool_call_authorized",
  "tool_call_denied",
]);

const TOOL_RESULT_RESOLVED: ReadonlySet<AuditEventType> = new Set([
  "tool_result_received",
  "tool_call_timeout",
  "tool_call_interrupted",
]);

export function diagnoseTraceCompleteness(events: AuditEvent[]): TraceCompletenessReport {
  const issues: CompletenessIssue[] = [];
  const seenIds = new Set<string>();
  let expectedSeq = 1;
  let runStarted = false;
  let runTerminal = false;

  const toolRequested = new Map<string, string>(); // toolCallId -> eventId
  const toolAuthResolved = new Set<string>();
  const toolAuthorized = new Set<string>();
  const toolResultResolved = new Set<string>();

  for (const event of events) {
    const v = validateAuditEvent(event);
    if (!v.ok) {
      issues.push({
        code: "invalid_event",
        message: v.issues.map((i) => i.message).join("; "),
        eventId: event.eventId,
        sequence: event.sequence,
      });
    }

    if (seenIds.has(event.eventId)) {
      issues.push({
        code: "duplicate_event_id",
        message: `duplicate eventId ${event.eventId}`,
        eventId: event.eventId,
        sequence: event.sequence,
      });
    }
    seenIds.add(event.eventId);

    if (event.sequence !== expectedSeq) {
      issues.push({
        code: "sequence_gap",
        message: `expected sequence ${expectedSeq}, got ${event.sequence}`,
        eventId: event.eventId,
        sequence: event.sequence,
      });
    }
    expectedSeq = event.sequence + 1;

    if (event.eventType === "run_started") runStarted = true;
    if (TERMINAL.has(event.eventType)) runTerminal = true;

    const toolCallId = extractToolCallId(event);
    if (event.eventType === "tool_call_requested" && toolCallId) {
      toolRequested.set(toolCallId, event.eventId);
    }
    if (TOOL_AUTH_RESOLVED.has(event.eventType) && toolCallId) {
      toolAuthResolved.add(toolCallId);
      if (event.eventType === "tool_call_authorized") {
        toolAuthorized.add(toolCallId);
      }
    }
    if (TOOL_RESULT_RESOLVED.has(event.eventType) && toolCallId) {
      toolResultResolved.add(toolCallId);
    }

    if (
      event.eventType === "retry_scheduled" &&
      !event.causedByEventId
    ) {
      issues.push({
        code: "retry_without_cause",
        message: "retry_scheduled missing causedByEventId",
        eventId: event.eventId,
        sequence: event.sequence,
      });
    }
  }

  // 孤儿 parent：第二遍
  const idSet = new Set(events.map((e) => e.eventId));
  for (const event of events) {
    if (event.eventType === "run_started") continue;
    if (event.parentEventId && !idSet.has(event.parentEventId)) {
      issues.push({
        code: "orphan_parent",
        message: `parentEventId not in run: ${event.parentEventId}`,
        eventId: event.eventId,
        sequence: event.sequence,
      });
    }
  }

  if (events.length > 0 && !runStarted) {
    issues.push({
      code: "missing_run_started",
      message: "run missing run_started",
    });
  }
  if (runStarted && !runTerminal) {
    issues.push({
      code: "missing_terminal",
      message: "run missing terminal event (finished/failed/interrupted)",
    });
  }

  for (const [toolCallId, reqId] of toolRequested) {
    if (!toolAuthResolved.has(toolCallId)) {
      issues.push({
        code: "tool_request_without_auth",
        message: `toolCallId ${toolCallId} requested without authorize/deny`,
        eventId: reqId,
      });
    }
  }
  for (const toolCallId of toolAuthorized) {
    if (!toolResultResolved.has(toolCallId)) {
      issues.push({
        code: "authorized_tool_without_result",
        message: `toolCallId ${toolCallId} authorized without result/timeout/interrupt`,
      });
    }
  }

  const openToolCallIds = [...toolAuthorized].filter((id) => !toolResultResolved.has(id));

  return {
    ok: issues.length === 0,
    eventCount: events.length,
    issues,
    runStarted,
    runTerminal,
    openToolCallIds,
  };
}

function extractToolCallId(event: AuditEvent): string | null {
  const fromPayload = event.payload?.toolCallId;
  if (typeof fromPayload === "string" && fromPayload.length > 0) return fromPayload;
  if (event.eventType.startsWith("tool_") && event.eventId) {
    // 退化：无 toolCallId 时用 eventId 无法跨事件关联
    return null;
  }
  return null;
}
