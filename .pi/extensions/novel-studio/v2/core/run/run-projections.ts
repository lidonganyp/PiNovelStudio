/**
 * RUN-PROJECTIONS — 可重建投影（P2 骨架 / P7 完善）
 *
 * 投影不是事实源。删除后必须能从事件流 + 聚合重建。
 *
 * 当前交付：
 * - current-run-state（与物化聚合同形摘要）
 * - checkpoint-index
 * - approval-pending
 * - transitionHistory（替代进程内数组）
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
import type { RunAggregate } from "./run-aggregate-types.js";

export interface TransitionHistoryEntry {
  from: string;
  to: string;
  at: string;
  reason: string;
  eventId: string;
  sequence: number;
  eventType: string;
}

export interface CurrentRunStateProjection {
  kind: "current-run-state";
  workspaceId: string;
  chapterId: string;
  runId: string;
  traceId: string;
  workflowState: string;
  approvalState: string;
  terminalStatus: string;
  lastSequence: number;
  lastEventId: string | null;
  artifactRevision: string | null;
  artifactHash: string | null;
  approvalId: string | null;
  checkpointId: string | null;
  commitIntentId: string | null;
  rebuiltFromEvents: true;
}

export interface CheckpointIndexProjection {
  kind: "checkpoint-index";
  chapterId: string;
  runId: string;
  checkpointId: string | null;
  open: boolean;
  artifactRevision: string | null;
  artifactHash: string | null;
  lastSequence: number;
}

export interface ApprovalPendingProjection {
  kind: "approval-pending";
  chapterId: string;
  runId: string;
  pending: boolean;
  approvalId: string | null;
  approvalState: string;
  artifactRevision: string | null;
  artifactHash: string | null;
  lastSequence: number;
}

function atomicWriteJson(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  renameSync(tmp, path);
}

export function projectCurrentRunState(
  aggregate: RunAggregate,
): CurrentRunStateProjection {
  return {
    kind: "current-run-state",
    workspaceId: aggregate.workspaceId,
    chapterId: aggregate.chapterId,
    runId: aggregate.runId,
    traceId: aggregate.traceId,
    workflowState: aggregate.workflowState,
    approvalState: aggregate.approvalState,
    terminalStatus: aggregate.terminalStatus,
    lastSequence: aggregate.lastSequence,
    lastEventId: aggregate.lastEventId,
    artifactRevision: aggregate.artifactRevision,
    artifactHash: aggregate.artifactHash,
    approvalId: aggregate.approvalId,
    checkpointId: aggregate.checkpointId,
    commitIntentId: aggregate.commitIntent?.commitIntentId ?? null,
    rebuiltFromEvents: true,
  };
}

export function projectCheckpointIndex(
  aggregate: RunAggregate,
): CheckpointIndexProjection {
  return {
    kind: "checkpoint-index",
    chapterId: aggregate.chapterId,
    runId: aggregate.runId,
    checkpointId: aggregate.checkpointId,
    open: aggregate.workflowState === "checkpoint",
    artifactRevision: aggregate.artifactRevision,
    artifactHash: aggregate.artifactHash,
    lastSequence: aggregate.lastSequence,
  };
}

export function projectApprovalPending(
  aggregate: RunAggregate,
): ApprovalPendingProjection {
  return {
    kind: "approval-pending",
    chapterId: aggregate.chapterId,
    runId: aggregate.runId,
    pending: aggregate.approvalState === "pending",
    approvalId: aggregate.approvalId,
    approvalState: aggregate.approvalState,
    artifactRevision: aggregate.artifactRevision,
    artifactHash: aggregate.artifactHash,
    lastSequence: aggregate.lastSequence,
  };
}

/**
 * 从事件流投影 transitionHistory（替代 RecoveryStateMachine 内存数组）。
 */
export function projectTransitionHistory(
  events: readonly AuditEvent[],
): TransitionHistoryEntry[] {
  const history: TransitionHistoryEntry[] = [];
  let workflow = "running";
  for (const event of events) {
    const next = inferWorkflowHint(event, workflow);
    if (next !== workflow) {
      history.push({
        from: workflow,
        to: next,
        at: new Date(event.timestamp).toISOString(),
        reason: event.decisionReason ?? event.eventType,
        eventId: event.eventId,
        sequence: event.sequence,
        eventType: event.eventType,
      });
      workflow = next;
    }
  }
  return history;
}

function inferWorkflowHint(event: AuditEvent, current: string): string {
  switch (event.eventType) {
    case "checkpoint_saved":
      return "checkpoint";
    case "checkpoint_resumed":
    case "run_recovered":
      return "running";
    case "approval_requested":
      return "awaiting_approval";
    case "commit_started":
      return "commit_pending";
    case "final_submission": {
      const p = event.payload ?? {};
      if (p.chapterSaveOk === true && (p.stateCommitOk === true || p.stateCommitOutcome === "skipped")) {
        return "committed";
      }
      return current;
    }
    case "run_interrupted":
      return "interrupted";
    case "run_failed":
    case "commit_failed":
      return "blocked";
    case "failure_recorded":
      if (event.failureClass === "blocked" || event.failureClass === "fatal") {
        return "blocked";
      }
      if (event.failureClass === "interrupted") return "interrupted";
      if (event.failureClass === "recoverable") return "retryable_failure";
      return current;
    case "retry_reserved":
    case "retry_scheduled":
      return "retrying";
    case "compensation_started":
      return "compensation_run";
    default:
      return current;
  }
}

export interface WriteProjectionsInput {
  projectRoot: string;
  aggregate: RunAggregate;
  events: readonly AuditEvent[];
}

/**
 * 写入标准投影文件到 traces/{runId}/projections/。
 * 任一失败抛错（不静默）。
 */
export function writeRunProjections(input: WriteProjectionsInput): {
  currentRunStatePath: string;
  checkpointIndexPath: string;
  approvalPendingPath: string;
  transitionHistoryPath: string;
} {
  const base = join(
    input.projectRoot,
    "workspaces",
    input.aggregate.workspaceId,
    "traces",
    input.aggregate.runId,
    "projections",
  );
  if (!existsSync(base)) mkdirSync(base, { recursive: true });

  const currentRunStatePath = join(base, "current-run-state.json");
  const checkpointIndexPath = join(base, "checkpoint-index.json");
  const approvalPendingPath = join(base, "approval-pending.json");
  const transitionHistoryPath = join(base, "transition-history.json");

  atomicWriteJson(currentRunStatePath, projectCurrentRunState(input.aggregate));
  atomicWriteJson(checkpointIndexPath, projectCheckpointIndex(input.aggregate));
  atomicWriteJson(approvalPendingPath, projectApprovalPending(input.aggregate));
  atomicWriteJson(
    transitionHistoryPath,
    projectTransitionHistory(input.events),
  );

  return {
    currentRunStatePath,
    checkpointIndexPath,
    approvalPendingPath,
    transitionHistoryPath,
  };
}

/**
 * 删除投影后可用此函数从聚合+事件重建。
 */
export function rebuildProjectionsFromAggregate(
  projectRoot: string,
  aggregate: RunAggregate,
  events: readonly AuditEvent[],
): ReturnType<typeof writeRunProjections> {
  return writeRunProjections({ projectRoot, aggregate, events });
}

export function readProjectionJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}
