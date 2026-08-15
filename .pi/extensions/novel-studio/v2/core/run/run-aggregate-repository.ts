/**
 * RUN-AGGREGATE-REPOSITORY — 聚合物化 + 事件重放加载（P2）
 *
 * 写入顺序（硬规则）：
 *   1. 先追加 AuditEvent 到事件流
 *   2. 再 reduce 更新内存聚合
 *   3. 可选：物化 current-run-state 投影到磁盘
 *
 * 物化文件可删：删除后必须能从 events.jsonl 完整重建。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AuditEvent } from "../audit/audit-event-types.js";
import type { AuditEventStore } from "../audit/audit-event-store.js";
import {
  RUN_ERROR_CODES,
  RunAggregateError,
} from "./run-aggregate-errors.js";
import {
  createEmptyRunAggregate,
  updateRunAggregate,
  type RunAggregate,
} from "./run-aggregate-types.js";
import {
  reduceRunAggregate,
  replayRunAggregate,
  type ReduceOptions,
  type ReduceResult,
} from "./run-aggregate-reducer.js";

export interface RunAggregateRepositoryOptions {
  projectRoot: string;
  workspaceId: string;
  chapterId: string;
  runId: string;
  traceId: string;
  /** 默认 true；测试可关盘 */
  persist?: boolean;
}

export interface AppendAndFoldInput {
  /** 已由 store.append 返回的事件 */
  event: AuditEvent;
}

function materializePath(
  projectRoot: string,
  workspaceId: string,
  runId: string,
): string {
  return join(
    projectRoot,
    "workspaces",
    workspaceId,
    "traces",
    runId,
    "run-aggregate.json",
  );
}

function atomicWriteJson(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  renameSync(tmp, path);
}

/**
 * 从事件列表重建聚合（不读物化文件）。
 */
export function rebuildRunAggregateFromEvents(
  seed: {
    workspaceId: string;
    chapterId: string;
    runId: string;
    traceId: string;
  },
  events: readonly AuditEvent[],
): ReduceResult {
  return replayRunAggregate(seed, events);
}

/**
 * 读取物化聚合；损坏或不存在返回 null（调用方应重放事件流）。
 */
export function loadMaterializedRunAggregate(
  projectRoot: string,
  workspaceId: string,
  runId: string,
): RunAggregate | null {
  const path = materializePath(projectRoot, workspaceId, runId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as RunAggregate;
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.runId !== "string" || raw.runId !== runId) return null;
    if (typeof raw.lastSequence !== "number") return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveMaterializedRunAggregate(
  projectRoot: string,
  aggregate: RunAggregate,
): string {
  const path = materializePath(
    projectRoot,
    aggregate.workspaceId,
    aggregate.runId,
  );
  atomicWriteJson(path, aggregate);
  return path;
}

/**
 * 校验物化状态与事件重放是否一致（关键字段）。
 */
export function assertAggregateMatchesReplay(
  materialized: RunAggregate,
  replayed: RunAggregate,
): { ok: true } | { ok: false; error: RunAggregateError } {
  const fields: Array<keyof RunAggregate> = [
    "workflowState",
    "approvalState",
    "artifactRevision",
    "artifactHash",
    "lastSequence",
    "terminalStatus",
    "approvalId",
    "activeCandidate",
    "commitIntent",
  ];
  for (const key of fields) {
    const a = JSON.stringify(materialized[key] ?? null);
    const b = JSON.stringify(replayed[key] ?? null);
    if (a !== b) {
      return {
        ok: false,
        error: new RunAggregateError(
          RUN_ERROR_CODES.AGGREGATE_REPLAY_DIVERGENCE,
          `aggregate divergence on ${String(key)}: materialized=${a} replayed=${b}`,
          { field: key, materialized: materialized[key], replayed: replayed[key] },
        ),
      };
    }
  }
  return { ok: true };
}

/**
 * 持有内存聚合，配合 AuditEventStore 使用。
 * 调用方必须：store.append → repository.applyAppendedEvent
 */
export class RunAggregateRepository {
  private aggregate: RunAggregate;
  private readonly persist: boolean;
  private readonly projectRoot: string;
  private readonly seenEventIds = new Set<string>();
  private materializeError: Error | null = null;

  constructor(options: RunAggregateRepositoryOptions) {
    this.projectRoot = options.projectRoot;
    this.persist = options.persist ?? true;
    this.aggregate = createEmptyRunAggregate({
      workspaceId: options.workspaceId,
      chapterId: options.chapterId,
      runId: options.runId,
      traceId: options.traceId,
    });
  }

  getAggregate(): RunAggregate {
    return updateRunAggregate(this.aggregate, {});
  }

  getMaterializeError(): Error | null {
    return this.materializeError;
  }

  /**
   * 从已有事件流恢复（进程重启）。
   * 优先重放事件；物化文件仅作加速缓存并在最后做一致性校验。
   */
  recoverFromEvents(events: readonly AuditEvent[]): ReduceResult {
    const seed = {
      workspaceId: this.aggregate.workspaceId,
      chapterId: this.aggregate.chapterId,
      runId: this.aggregate.runId,
      traceId: this.aggregate.traceId,
    };
    const result = rebuildRunAggregateFromEvents(seed, events);
    if (!result.ok) return result;

    const materialized = loadMaterializedRunAggregate(
      this.projectRoot,
      this.aggregate.workspaceId,
      this.aggregate.runId,
    );
    if (materialized) {
      const check = assertAggregateMatchesReplay(materialized, result.aggregate);
      if (!check.ok) {
        // 物化漂移：以事件重放为准，覆盖物化
        this.aggregate = result.aggregate;
        this.syncSeenFromEvents(events);
        if (this.persist) {
          try {
            saveMaterializedRunAggregate(this.projectRoot, this.aggregate);
          } catch (err) {
            this.materializeError =
              err instanceof Error ? err : new Error(String(err));
          }
        }
        return {
          ok: true,
          aggregate: this.getAggregate(),
          error: check.error,
        };
      }
    }

    this.aggregate = result.aggregate;
    this.syncSeenFromEvents(events);
    return { ok: true, aggregate: this.getAggregate() };
  }

  private syncSeenFromEvents(events: readonly AuditEvent[]): void {
    this.seenEventIds.clear();
    for (const e of events) this.seenEventIds.add(e.eventId);
  }

  /**
   * 事件已成功 append 后调用。失败不回滚事件（事件优先）。
   */
  applyAppendedEvent(
    event: AuditEvent,
    options: ReduceOptions = {},
  ): ReduceResult {
    const result = reduceRunAggregate(this.aggregate, event, {
      ...options,
      seenEventIds: options.seenEventIds ?? this.seenEventIds,
    });
    if (result.ok && !result.idempotentReplay) {
      this.aggregate = result.aggregate;
      if (this.persist) {
        try {
          saveMaterializedRunAggregate(this.projectRoot, this.aggregate);
          this.materializeError = null;
        } catch (err) {
          this.materializeError =
            err instanceof Error ? err : new Error(String(err));
          // 物化失败不吞：挂 error，但内存聚合已更新（事件已是事实）
        }
      }
    }
    return {
      ...result,
      aggregate: this.getAggregate(),
    };
  }

  /**
   * 便捷：store.append + fold + 物化。
   * 保证先事件后聚合。
   */
  appendEvent(
    store: AuditEventStore,
    input: Parameters<AuditEventStore["append"]>[0],
  ): {
    append: ReturnType<AuditEventStore["append"]>;
    fold: ReduceResult;
  } {
    const append = store.append(input);
    const fold = this.applyAppendedEvent(append.event);
    return { append, fold };
  }
}

export function createRunAggregateRepository(
  options: RunAggregateRepositoryOptions,
): RunAggregateRepository {
  return new RunAggregateRepository(options);
}
