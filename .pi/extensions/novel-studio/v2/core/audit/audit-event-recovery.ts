/**
 * AUDIT-EVENT-RECOVERY — JSONL 崩溃恢复（Phase 2）
 *
 * 规则：
 * - 识别最后一条不完整 JSON
 * - 仅截断损坏尾行，不覆盖已确认事件
 * - 可报告 sequence 异常与重复 eventId
 * - 调用方负责追加 run_recovered / run_interrupted
 */

import {
  existsSync,
  openSync,
  closeSync,
  ftruncateSync,
  fsyncSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import type { AuditEvent } from "./audit-event-types.js";
import { validateAuditEvent } from "./audit-event-schema.js";

export interface SequenceAnomaly {
  expected: number;
  actual: number;
  eventId: string;
}

export interface RecoveryReport {
  path: string;
  events: AuditEvent[];
  /** 是否截断了损坏尾行 */
  truncatedTrailingGarbage: boolean;
  /** 截断前文件字节数 */
  originalSizeBytes: number;
  /** 截断后文件字节数 */
  recoveredSizeBytes: number;
  /** 解析失败的行（不含已截断的尾行） */
  droppedInvalidLines: number;
  duplicateEventIds: string[];
  sequenceAnomalies: SequenceAnomaly[];
  lastCompleteSequence: number;
  lastCompleteEventId: string | null;
  hadIncompleteTrailingLine: boolean;
  openRun: boolean;
}

/**
 * 读取并修复 events.jsonl。
 * 若最后一行不是合法完整 JSON，截断到最后一个换行之后。
 */
export function recoverEventsJsonl(path: string): RecoveryReport {
  const empty: RecoveryReport = {
    path,
    events: [],
    truncatedTrailingGarbage: false,
    originalSizeBytes: 0,
    recoveredSizeBytes: 0,
    droppedInvalidLines: 0,
    duplicateEventIds: [],
    sequenceAnomalies: [],
    lastCompleteSequence: 0,
    lastCompleteEventId: null,
    hadIncompleteTrailingLine: false,
    openRun: false,
  };

  if (!existsSync(path)) return empty;

  const originalSizeBytes = statSync(path).size;
  let raw = readFileSync(path, "utf-8");
  let truncatedTrailingGarbage = false;
  let hadIncompleteTrailingLine = false;

  // 空文件
  if (raw.length === 0) {
    return { ...empty, originalSizeBytes, recoveredSizeBytes: 0 };
  }

  // 若文件不以 \n 结束，最后一行可能是崩溃半写
  if (!raw.endsWith("\n")) {
    hadIncompleteTrailingLine = true;
    const lastNl = raw.lastIndexOf("\n");
    const incomplete = lastNl >= 0 ? raw.slice(lastNl + 1) : raw;
    // 尝试 parse 尾行；失败则截断
    let tailOk = false;
    if (incomplete.trim().length > 0) {
      try {
        JSON.parse(incomplete);
        // 合法但缺换行：补换行
        raw = raw + "\n";
        tailOk = true;
        // 写回补换行
        atomicTruncateOrRewrite(path, raw);
        truncatedTrailingGarbage = false;
      } catch {
        tailOk = false;
      }
    }
    if (!tailOk) {
      const kept = lastNl >= 0 ? raw.slice(0, lastNl + 1) : "";
      atomicTruncateOrRewrite(path, kept);
      raw = kept;
      truncatedTrailingGarbage = true;
    }
  }

  const lines = raw.split("\n").filter((l) => l.length > 0);
  const events: AuditEvent[] = [];
  const seenIds = new Set<string>();
  const duplicateEventIds: string[] = [];
  const sequenceAnomalies: SequenceAnomaly[] = [];
  let droppedInvalidLines = 0;
  let expectedSeq = 1;
  let lastCompleteSequence = 0;
  let lastCompleteEventId: string | null = null;
  let sawRunStart = false;
  let sawTerminal = false;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      droppedInvalidLines += 1;
      continue;
    }
    const validation = validateAuditEvent(parsed);
    if (!validation.ok) {
      droppedInvalidLines += 1;
      continue;
    }
    const event = parsed as AuditEvent;
    if (seenIds.has(event.eventId)) {
      duplicateEventIds.push(event.eventId);
      continue;
    }
    seenIds.add(event.eventId);
    if (event.sequence !== expectedSeq) {
      sequenceAnomalies.push({
        expected: expectedSeq,
        actual: event.sequence,
        eventId: event.eventId,
      });
    }
    expectedSeq = event.sequence + 1;
    events.push(event);
    lastCompleteSequence = event.sequence;
    lastCompleteEventId = event.eventId;
    if (event.eventType === "run_started") sawRunStart = true;
    if (
      event.eventType === "run_finished" ||
      event.eventType === "run_failed" ||
      event.eventType === "run_interrupted"
    ) {
      sawTerminal = true;
    }
  }

  const recoveredSizeBytes = existsSync(path) ? statSync(path).size : 0;

  return {
    path,
    events,
    truncatedTrailingGarbage,
    originalSizeBytes,
    recoveredSizeBytes,
    droppedInvalidLines,
    duplicateEventIds,
    sequenceAnomalies,
    lastCompleteSequence,
    lastCompleteEventId,
    hadIncompleteTrailingLine,
    openRun: sawRunStart && !sawTerminal,
  };
}

/**
 * 截断或重写文件内容（保持已确认前缀）。
 * 优先 truncate 到目标长度；内容变化时 rewrite。
 */
function atomicTruncateOrRewrite(path: string, content: string): void {
  const buf = Buffer.from(content, "utf8");
  const fd = openSync(path, "r+");
  try {
    // 同进程恢复场景：truncate 后写回已确认前缀
    ftruncateSync(fd, 0);
    if (buf.length > 0) {
      writeSync(fd, buf, 0, buf.length, 0);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * 根据恢复报告构造 run_recovered / 未完成工具标记的建议。
 * 不直接写盘；由 AuditEventStore 或接线层调用 append。
 */
export function buildRecoveryFollowUpHint(report: RecoveryReport): {
  shouldEmitRunRecovered: boolean;
  shouldEmitRunInterrupted: boolean;
  reason: string;
} {
  if (!report.openRun) {
    return {
      shouldEmitRunRecovered: false,
      shouldEmitRunInterrupted: false,
      reason: "run already terminal or empty",
    };
  }
  if (report.truncatedTrailingGarbage || report.hadIncompleteTrailingLine) {
    return {
      shouldEmitRunRecovered: true,
      shouldEmitRunInterrupted: true,
      reason: "open run after crash; trailing line repaired",
    };
  }
  return {
    shouldEmitRunRecovered: true,
    shouldEmitRunInterrupted: false,
    reason: "open run found on startup",
  };
}
