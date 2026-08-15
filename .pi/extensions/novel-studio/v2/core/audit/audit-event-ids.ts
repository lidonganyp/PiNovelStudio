/**
 * AUDIT-EVENT-IDS — ID 生成规则（Phase 0）
 *
 * 格式：
 * - traceId:  trc-{time36}-{rand6}
 * - runId:    run-{time36}-{rand6}
 * - eventId:  evt-{time36}-{rand8}
 */

import { randomBytes } from "node:crypto";
import type { EventId, RunId, TraceId } from "./audit-event-types.js";

function randHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function time36(now = Date.now()): string {
  return now.toString(36);
}

export function createTraceId(now = Date.now()): TraceId {
  return `trc-${time36(now)}-${randHex(3)}`;
}

export function createRunId(now = Date.now()): RunId {
  return `run-${time36(now)}-${randHex(3)}`;
}

export function createEventId(now = Date.now()): EventId {
  return `evt-${time36(now)}-${randHex(4)}`;
}

/** 宽松校验：非空且不含空白 */
export function isWellFormedId(id: string | null | undefined): boolean {
  if (!id || typeof id !== "string") return false;
  return id.length >= 4 && !/\s/.test(id);
}
