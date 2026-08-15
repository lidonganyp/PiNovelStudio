/**
 * AUDIT-EVENT-STORE — 追加式 JSONL 事件存储（Phase 2）
 *
 * 路径：
 *   workspaces/{workspaceId}/traces/{runId}/events.jsonl
 *
 * 保证：
 * - 唯一 eventId
 * - 严格递增 sequence
 * - 父事件引用有效（同 run 内）
 * - 写入失败可报告（不静默）
 * - 生产持久化 / 测试内存 双模式
 * - 启动时可恢复损坏尾行
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AuditEvent } from "./audit-event-types.js";
import { createEventId, createRunId, createTraceId, isWellFormedId } from "./audit-event-ids.js";
import {
  createAuditEvent,
  type CreateAuditEventInput,
  validateAuditEvent,
} from "./audit-event-schema.js";
import {
  recoverEventsJsonl,
  type RecoveryReport,
} from "./audit-event-recovery.js";

export interface AuditEventStoreOptions {
  projectRoot: string;
  workspaceId: string;
  /** 可选；未提供则自动生成 */
  runId?: string;
  /** 可选；未提供则自动生成；恢复场景应复用既有 traceId */
  traceId?: string;
  /** 默认 true；测试可 false 仅内存 */
  persist?: boolean;
  /** 启动时是否自动恢复损坏尾行（默认 true） */
  autoRecover?: boolean;
}

export interface AppendEventInput
  extends Omit<CreateAuditEventInput, "traceId" | "runId" | "sequence" | "parentEventId"> {
  /** 覆盖默认 parent（默认上一事件） */
  parentEventId?: string | null;
  /** 强制 sequence（仅测试/恢复）；正常路径由 store 分配 */
  sequence?: number;
  traceId?: string;
  runId?: string;
}

export interface AppendResult {
  event: AuditEvent;
  /** 是否已持久化到磁盘 */
  persisted: boolean;
}

export interface AuditEventStoreSnapshot {
  traceId: string;
  runId: string;
  sequence: number;
  eventCount: number;
  lastEventId: string | null;
  lastCompletedStage: string | null;
  openToolCalls: string[];
  runTerminal: boolean;
  outputPath: string | null;
  recovery?: RecoveryReport | null;
}

export class AuditEventStore {
  readonly traceId: string;
  readonly runId: string;
  readonly outputPath: string | null;
  private readonly persist: boolean;
  private readonly events: AuditEvent[] = [];
  private readonly eventIds = new Set<string>();
  private sequence = 0;
  private lastEventId: string | null = null;
  private lastCompletedStage: string | null = null;
  private readonly openToolCalls = new Set<string>();
  private runTerminal = false;
  private recoveryReport: RecoveryReport | null = null;
  private writeError: Error | null = null;

  constructor(options: AuditEventStoreOptions) {
    this.persist = options.persist ?? true;
    this.runId = options.runId ?? createRunId();
    this.traceId = options.traceId ?? createTraceId();
    this.outputPath = this.persist
      ? join(
          options.projectRoot,
          "workspaces",
          options.workspaceId,
          "traces",
          this.runId,
          "events.jsonl",
        )
      : null;

    if (this.persist && this.outputPath && (options.autoRecover ?? true)) {
      this.bootstrapFromDisk();
    }
  }

  getSequence(): number {
    return this.sequence;
  }

  getEntries(): AuditEvent[] {
    return [...this.events];
  }

  getLastWriteError(): Error | null {
    return this.writeError;
  }

  getSnapshot(): AuditEventStoreSnapshot {
    return {
      traceId: this.traceId,
      runId: this.runId,
      sequence: this.sequence,
      eventCount: this.events.length,
      lastEventId: this.lastEventId,
      lastCompletedStage: this.lastCompletedStage,
      openToolCalls: [...this.openToolCalls],
      runTerminal: this.runTerminal,
      outputPath: this.outputPath,
      recovery: this.recoveryReport,
    };
  }

  /**
   * 追加事件。sequence 由 store 分配（除非显式传入且通过校验）。
   * parentEventId 默认指向上一事件；run_started 强制 null。
   */
  append(input: AppendEventInput): AppendResult {
    if (this.writeError) {
      throw new Error(
        `AuditEventStore is in write-error state: ${this.writeError.message}`,
      );
    }

    const nextSequence = input.sequence ?? this.sequence + 1;
    if (nextSequence !== this.sequence + 1) {
      throw new Error(
        `sequence gap/jump: expected ${this.sequence + 1}, got ${nextSequence}`,
      );
    }

    const isRunStart = input.eventType === "run_started";
    const parentEventId = isRunStart
      ? null
      : input.parentEventId !== undefined
        ? input.parentEventId
        : this.lastEventId;

    // 空 store 的首条事件必须是 run_started（恢复加载走 bootstrap，不经 append）
    if (!isRunStart && this.events.length === 0 && this.sequence === 0) {
      throw new Error("first event must be run_started");
    }
    if (!isRunStart && parentEventId) {
      if (!this.eventIds.has(parentEventId)) {
        throw new Error(`orphan parentEventId: ${parentEventId}`);
      }
    }

    const event = createAuditEvent({
      ...input,
      schemaVersion: input.schemaVersion,
      eventId: input.eventId ?? createEventId(input.timestamp),
      timestamp: input.timestamp,
      sequence: nextSequence,
      traceId: input.traceId ?? this.traceId,
      runId: input.runId ?? this.runId,
      parentEventId,
    });

    if (this.eventIds.has(event.eventId)) {
      throw new Error(`duplicate eventId: ${event.eventId}`);
    }
    if (event.traceId !== this.traceId) {
      throw new Error(
        `traceId mismatch: store=${this.traceId}, event=${event.traceId}`,
      );
    }
    if (event.runId !== this.runId) {
      throw new Error(`runId mismatch: store=${this.runId}, event=${event.runId}`);
    }

    this.events.push(event);
    this.eventIds.add(event.eventId);
    this.sequence = event.sequence;
    this.lastEventId = event.eventId;
    this.trackLifecycle(event);

    let persisted = false;
    if (this.persist && this.outputPath) {
      try {
        this.appendLine(event);
        persisted = true;
      } catch (err) {
        this.writeError =
          err instanceof Error ? err : new Error(String(err));
        // 内存中已有事件，但磁盘失败必须暴露
        throw this.writeError;
      }
    }

    return { event, persisted };
  }

  /** 便捷：记录 run_started */
  startRun(payload?: Record<string, unknown>): AppendResult {
    return this.append({
      actor: "orchestrator",
      stage: "run",
      eventType: "run_started",
      status: "started",
      evidenceLevel: "observed",
      parentEventId: null,
      payload,
    });
  }

  /** 便捷：记录终止事件 */
  finishRun(
    eventType: "run_finished" | "run_failed" | "run_interrupted",
    extra?: Partial<AppendEventInput>,
  ): AppendResult {
    return this.append({
      actor: "orchestrator",
      stage: "run",
      eventType,
      status:
        eventType === "run_finished"
          ? "completed"
          : eventType === "run_interrupted"
            ? "interrupted"
            : "failed",
      evidenceLevel: "observed",
      ...extra,
    });
  }

  private bootstrapFromDisk(): void {
    if (!this.outputPath || !existsSync(this.outputPath)) return;
    const report = recoverEventsJsonl(this.outputPath);
    this.recoveryReport = report;
    for (const event of report.events) {
      const validation = validateAuditEvent(event);
      if (!validation.ok) continue;
      if (this.eventIds.has(event.eventId)) {
        // 重复 id：跳过后续损坏段
        continue;
      }
      if (event.sequence !== this.sequence + 1 && this.events.length > 0) {
        // sequence 跳号：仍加载，但标记在 recovery report
        report.sequenceAnomalies.push({
          expected: this.sequence + 1,
          actual: event.sequence,
          eventId: event.eventId,
        });
      }
      this.events.push(event);
      this.eventIds.add(event.eventId);
      this.sequence = Math.max(this.sequence, event.sequence);
      this.lastEventId = event.eventId;
      this.trackLifecycle(event);
    }
  }

  private trackLifecycle(event: AuditEvent): void {
    if (
      event.eventType === "run_finished" ||
      event.eventType === "run_failed" ||
      event.eventType === "run_interrupted"
    ) {
      this.runTerminal = true;
    }
    if (event.status === "completed" || event.status === "failed") {
      this.lastCompletedStage = event.stage;
    }
    if (
      event.eventType === "tool_call_started" ||
      event.eventType === "tool_call_authorized"
    ) {
      const toolKey = String(event.payload?.toolCallId ?? event.eventId);
      this.openToolCalls.add(toolKey);
    }
    if (
      event.eventType === "tool_result_received" ||
      event.eventType === "tool_call_timeout" ||
      event.eventType === "tool_call_interrupted" ||
      event.eventType === "tool_call_denied"
    ) {
      const toolKey = String(event.payload?.toolCallId ?? event.causedByEventId ?? "");
      if (toolKey) this.openToolCalls.delete(toolKey);
      // 也尝试用 parent
      if (event.parentEventId) this.openToolCalls.delete(event.parentEventId);
    }
  }

  private isKnownParent(parentEventId: string): boolean {
    return this.eventIds.has(parentEventId);
  }

  private appendLine(event: AuditEvent): void {
    if (!this.outputPath) return;
    const dir = dirname(this.outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(event) + "\n";
    // 追加写 + fsync，降低崩溃丢尾风险
    const fd = openSync(this.outputPath, "a");
    try {
      writeSync(fd, line, null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

export function resolveAuditEventsPath(
  projectRoot: string,
  workspaceId: string,
  runId: string,
): string {
  if (!isWellFormedId(workspaceId) || !isWellFormedId(runId)) {
    throw new Error("invalid workspaceId or runId for audit path");
  }
  return join(projectRoot, "workspaces", workspaceId, "traces", runId, "events.jsonl");
}

/** 测试辅助：原子覆写整个 jsonl（仅测试/修复工具） */
export function rewriteEventsJsonlForTest(path: string, events: AuditEvent[]): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
  const tmp = path + ".tmp";
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

export function readEventsJsonl(path: string): AuditEvent[] {
  if (!existsSync(path)) return [];
  const report = recoverEventsJsonl(path);
  return report.events;
}
