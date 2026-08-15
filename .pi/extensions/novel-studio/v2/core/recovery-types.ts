/**
 * RECOVERY-TYPES — 恢复动作、状态机状态与预算类型（P0/P1/P2）
 */

import type { FailureClass } from "./failure-types.js";

// ============================================================================
// Recovery actions
// ============================================================================

export type RecoveryAction =
  | "user_fix"
  | "retry_gate"
  | "retry_stage"
  | "resume_checkpoint"
  | "regenerate_candidate"
  | "checkpoint"
  | "rollback"
  | "stop";

/** 中断来源 */
export type InterruptSource =
  | "user_abort"
  | "budget_exhausted"
  | "model_aborted"
  | "process_shutdown"
  | "external_cancel";

// ============================================================================
// Recovery lifecycle state
// ============================================================================

export type RecoveryLifecycleState =
  | "running"
  | "retryable_failure"
  | "retrying"
  | "checkpoint"
  | "interrupted"
  | "blocked"
  | "commit_pending"
  | "committed";

/** 合法状态转换表 */
export const RECOVERY_TRANSITIONS: Readonly<
  Record<RecoveryLifecycleState, ReadonlyArray<RecoveryLifecycleState>>
> = {
  running: ["retryable_failure", "interrupted", "commit_pending", "blocked"],
  retryable_failure: ["retrying", "checkpoint", "blocked"],
  retrying: ["running", "checkpoint", "blocked", "retryable_failure"],
  interrupted: ["checkpoint", "blocked"],
  checkpoint: ["running", "blocked"], // running 仅显式 resume
  commit_pending: ["committed", "blocked"],
  blocked: [], // 终端（需用户介入后新任务）
  committed: [], // 终端
};

export function canTransition(
  from: RecoveryLifecycleState,
  to: RecoveryLifecycleState,
): boolean {
  const allowed = RECOVERY_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

// ============================================================================
// Recovery budget (chapter-level)
// ============================================================================

export interface RecoveryBudget {
  maxStageAttempts: number;
  maxTotalAttempts: number;
  maxModelCalls: number;
  maxRecoveryModelCalls: number;
  maxLatencyMs: number;
  usedStageAttempts: number;
  usedTotalAttempts: number;
  usedModelCalls: number;
  usedRecoveryModelCalls: number;
  usedLatencyMs: number;
}

export interface RecoveryBudgetSnapshot {
  remainingStageAttempts: number;
  remainingTotalAttempts: number;
  remainingModelCalls: number;
  remainingRecoveryModelCalls: number;
  remainingLatencyMs: number;
  exhausted: boolean;
  exhaustedReasons: string[];
}

export const DEFAULT_RECOVERY_BUDGET: RecoveryBudget = {
  maxStageAttempts: 2,
  maxTotalAttempts: 4,
  maxModelCalls: 12,
  maxRecoveryModelCalls: 4,
  maxLatencyMs: 30 * 60 * 1000,
  usedStageAttempts: 0,
  usedTotalAttempts: 0,
  usedModelCalls: 0,
  usedRecoveryModelCalls: 0,
  usedLatencyMs: 0,
};

// ============================================================================
// Decision I/O
// ============================================================================

export interface RecoveryDecisionInput {
  failureClass: FailureClass;
  stage: string;
  gate?: string;
  reason: string;
  attempt: number;
  maxAttempts?: number;
  budget: RecoveryBudget;
  interruptSignal?: InterruptSource | null;
  /** 是否事实冲突（确认） */
  confirmedFactConflict?: boolean;
  /** Coverage 不足 */
  coverageInsufficient?: boolean;
  /** schema/parser 错误 */
  schemaOrParseError?: boolean;
  /** 风格优化不确定（Story Preservation） */
  storyPreservationUncertain?: boolean;
  /** 正文保存失败 */
  chapterSaveFailed?: boolean;
  /** 状态提交失败 */
  stateCommitFailed?: boolean;
  /** approval/revision 过期 */
  staleRevision?: boolean;
  /** 生产路径禁止 one_shot_raw fallback */
  forbidOneShotRawFallback?: boolean;
}

export interface RecoveryDecision {
  recoveryAction: RecoveryAction;
  allowed: boolean;
  reason: string;
  failureClass: FailureClass;
  nextLifecycleState: RecoveryLifecycleState;
  maxAttempts: number;
  attempt: number;
  userActionRequired?: string[];
  nextCondition?: string;
  /** 是否改变重试条件（retry 必须 true） */
  changesCondition: boolean;
}

// ============================================================================
// Checkpoint
// ============================================================================

export interface RecoveryCheckpoint {
  checkpointId: string;
  workspaceId: string;
  chapterId: string;
  taskId: string;
  stage: string;
  candidateId?: string;
  revision?: string;
  artifactHash?: string;
  completedWork: string[];
  remainingWork: string[];
  failureClass?: FailureClass;
  recoveryAction?: RecoveryAction;
  recoveryBudget: RecoveryBudget;
  interruptReason?: InterruptSource | string;
  createdAt: string;
  status: "open" | "resumed" | "abandoned";
}
