/**
 * RUN-AGGREGATE-TYPES — 统一运行聚合领域契约（P1）
 *
 * 真相源：docs/run-lifecycle-p0-inventory.md
 *
 * 原则：
 * - 事件是不可变事实；本聚合是事件重放的物化视图
 * - 五类状态分离：Workflow / Artifact / Approval / Narrative / Learning
 * - 业务模块不得私自扩展事件字段；扩展须改本契约 + audit 字典
 */

import type { RecoveryBudget } from "../recovery-types.js";
import type { RecoveryLifecycleState } from "../recovery-types.js";
import { DEFAULT_RECOVERY_BUDGET } from "../recovery-types.js";

// ============================================================================
// Workflow / Approval / Terminal
// ============================================================================

/**
 * 统一工作流状态。
 * 包含 RecoveryLifecycleState 全部取值，并扩展 awaiting_approval / compensation_run。
 */
export type WorkflowState =
  | RecoveryLifecycleState
  | "awaiting_approval"
  | "compensation_run";

export type ApprovalState =
  | "none"
  | "pending"
  | "accepted"
  | "modified"
  | "rejected"
  | "stale"
  | "cleared";

export type RunTerminalStatus =
  | "none"
  | "finished"
  | "failed"
  | "interrupted"
  | "blocked"
  | "committed";

// ============================================================================
// 绑定与意图
// ============================================================================

/** checkpoint / 审批稿 / 正文 / NarrativeState 共享绑定 */
export interface ArtifactBinding {
  artifactRevision: string | null;
  artifactHash: string | null;
  candidateId: string | null;
  approvalId: string | null;
}

export interface CommitIntent {
  commitIntentId: string;
  finalizationId?: string;
  commandId?: string;
  artifactRevision: string;
  artifactHash: string;
  approvalId?: string;
  /** attempted | completed | failed */
  status: "attempted" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
}

// ============================================================================
// RunAggregate
// ============================================================================

export interface RunAggregate {
  workspaceId: string;
  chapterId: string;
  runId: string;
  traceId: string;
  workflowState: WorkflowState;
  approvalState: ApprovalState;
  artifactRevision: string | null;
  artifactHash: string | null;
  activeCandidate: string | null;
  approvalId: string | null;
  narrativeStateRevision: string | null;
  narrativeBaseRevision: string | null;
  recoveryBudget: RecoveryBudget;
  lastSequence: number;
  lastEventId: string | null;
  lastStage: string | null;
  checkpointId: string | null;
  commitIntent: CommitIntent | null;
  /** 已见 commandId → 首次 eventId（幂等） */
  seenCommandIds: Readonly<Record<string, string>>;
  /** 有效学习证据 id 集 */
  activeEvidenceIds: readonly string[];
  /** 已撤销证据 */
  revokedEvidenceIds: readonly string[];
  terminalStatus: RunTerminalStatus;
  /** 补偿运行指向的父 run（若有） */
  parentRunId: string | null;
  /** 最近失败码（标准错误码） */
  lastErrorCode: string | null;
  schemaVersion: typeof RUN_AGGREGATE_SCHEMA_VERSION;
}

export const RUN_AGGREGATE_SCHEMA_VERSION = "1.0.0" as const;

// ============================================================================
// 合法工作流转换
// ============================================================================

export const WORKFLOW_TRANSITIONS: Readonly<
  Record<WorkflowState, ReadonlyArray<WorkflowState>>
> = {
  running: [
    "retryable_failure",
    "retrying",
    "interrupted",
    "awaiting_approval",
    "commit_pending",
    "blocked",
    "checkpoint",
    "compensation_run",
  ],
  retryable_failure: ["retrying", "checkpoint", "blocked"],
  retrying: ["running", "checkpoint", "blocked", "retryable_failure"],
  interrupted: ["checkpoint", "blocked"],
  checkpoint: ["running", "blocked"],
  awaiting_approval: ["commit_pending", "blocked", "running"],
  commit_pending: ["committed", "blocked"],
  compensation_run: ["committed", "blocked", "running", "commit_pending"],
  blocked: [],
  committed: [],
};

export function canWorkflowTransition(
  from: WorkflowState,
  to: WorkflowState,
): boolean {
  if (from === to) return true;
  const allowed = WORKFLOW_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

/**
 * 硬规则：不得从 checkpoint/blocked/interrupted 直接 committed；
 * committed 不得倒退（回滚须新 compensation_run）。
 */
export function assertWorkflowTransition(
  from: WorkflowState,
  to: WorkflowState,
): { ok: true } | { ok: false; code: string; reason: string } {
  if (
    to === "committed" &&
    (from === "checkpoint" || from === "blocked" || from === "interrupted")
  ) {
    return {
      ok: false,
      code: "ILLEGAL_TRANSITION",
      reason: `${from} 不得直接变为 committed`,
    };
  }
  if (from === "committed" && to !== "committed") {
    return {
      ok: false,
      code: "ILLEGAL_TRANSITION",
      reason: "committed 为终态；回滚须启动 compensation_run（新 run）",
    };
  }
  if (!canWorkflowTransition(from, to)) {
    return {
      ok: false,
      code: "ILLEGAL_TRANSITION",
      reason: `非法工作流转换：${from} -> ${to}`,
    };
  }
  return { ok: true };
}

// ============================================================================
// 工厂
// ============================================================================

export interface CreateRunAggregateInput {
  workspaceId: string;
  chapterId: string;
  runId: string;
  traceId: string;
  recoveryBudget?: RecoveryBudget;
  parentRunId?: string | null;
}

export function createEmptyRunAggregate(
  input: CreateRunAggregateInput,
): RunAggregate {
  return {
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    runId: input.runId,
    traceId: input.traceId,
    workflowState: "running",
    approvalState: "none",
    artifactRevision: null,
    artifactHash: null,
    activeCandidate: null,
    approvalId: null,
    narrativeStateRevision: null,
    narrativeBaseRevision: null,
    recoveryBudget: input.recoveryBudget
      ? { ...input.recoveryBudget }
      : { ...DEFAULT_RECOVERY_BUDGET },
    lastSequence: 0,
    lastEventId: null,
    lastStage: null,
    checkpointId: null,
    commitIntent: null,
    seenCommandIds: {},
    activeEvidenceIds: [],
    revokedEvidenceIds: [],
    terminalStatus: "none",
    parentRunId: input.parentRunId ?? null,
    lastErrorCode: null,
    schemaVersion: RUN_AGGREGATE_SCHEMA_VERSION,
  };
}

/** 不可变浅更新 */
export function updateRunAggregate(
  current: Readonly<RunAggregate>,
  patch: Partial<RunAggregate>,
): RunAggregate {
  return {
    ...current,
    ...patch,
    recoveryBudget: patch.recoveryBudget
      ? { ...patch.recoveryBudget }
      : { ...current.recoveryBudget },
    seenCommandIds: patch.seenCommandIds
      ? { ...patch.seenCommandIds }
      : { ...current.seenCommandIds },
    activeEvidenceIds: patch.activeEvidenceIds
      ? [...patch.activeEvidenceIds]
      : [...current.activeEvidenceIds],
    revokedEvidenceIds: patch.revokedEvidenceIds
      ? [...patch.revokedEvidenceIds]
      : [...current.revokedEvidenceIds],
    commitIntent:
      patch.commitIntent === undefined
        ? current.commitIntent
          ? { ...current.commitIntent }
          : null
        : patch.commitIntent
          ? { ...patch.commitIntent }
          : null,
  };
}
