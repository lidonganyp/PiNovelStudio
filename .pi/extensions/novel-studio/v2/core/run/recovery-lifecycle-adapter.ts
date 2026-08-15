/**
 * RECOVERY-LIFECYCLE-ADAPTER — RecoveryLifecycleState ↔ WorkflowState（P1 迁移适配）
 *
 * 适配层仅用于过渡：旧 RecoveryStateMachine 消费者可读映射。
 * 切换完成后应删除本模块，不得长期保留双基线。
 */

import type { RecoveryLifecycleState } from "../recovery-types.js";
import type { WorkflowState } from "./run-aggregate-types.js";

const LEGACY_STATES = new Set<RecoveryLifecycleState>([
  "running",
  "retryable_failure",
  "retrying",
  "checkpoint",
  "interrupted",
  "blocked",
  "commit_pending",
  "committed",
]);

/** WorkflowState → 旧 RecoveryLifecycleState（扩展态映射到最近兼容态） */
export function toRecoveryLifecycleState(
  workflow: WorkflowState,
): RecoveryLifecycleState {
  if (workflow === "awaiting_approval") return "commit_pending";
  if (workflow === "compensation_run") return "running";
  return workflow;
}

/** 旧态 → WorkflowState（1:1） */
export function fromRecoveryLifecycleState(
  legacy: RecoveryLifecycleState,
): WorkflowState {
  return legacy;
}

export function isLegacyRecoveryLifecycleState(
  value: string,
): value is RecoveryLifecycleState {
  return LEGACY_STATES.has(value as RecoveryLifecycleState);
}

/**
 * 将扩展 WorkflowState 投影为旧机可理解的状态。
 * awaiting_approval 在旧机中最接近 commit_pending（等待外部确认后提交）。
 */
export function projectWorkflowForLegacyMachine(
  workflow: WorkflowState,
): RecoveryLifecycleState {
  return toRecoveryLifecycleState(workflow);
}
