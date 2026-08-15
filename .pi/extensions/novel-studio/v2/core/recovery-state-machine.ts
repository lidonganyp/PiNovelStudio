/**
 * RECOVERY-STATE-MACHINE — 恢复生命周期状态机（P0）
 *
 * 硬规则：
 * - checkpoint / blocked / interrupted 不得自动变为 committed
 * - resume 必须显式触发（checkpoint → running）
 * - 非法转换全部拒绝
 */

import {
  canTransition,
  type RecoveryLifecycleState,
  RECOVERY_TRANSITIONS,
} from "./recovery-types.js";

export interface TransitionResult {
  ok: boolean;
  from: RecoveryLifecycleState;
  to: RecoveryLifecycleState;
  reason: string;
  state: RecoveryLifecycleState;
}

export class RecoveryStateMachine {
  private _state: RecoveryLifecycleState;
  private readonly history: Array<{
    from: RecoveryLifecycleState;
    to: RecoveryLifecycleState;
    at: string;
    reason: string;
  }> = [];

  constructor(initial: RecoveryLifecycleState = "running") {
    this._state = initial;
  }

  get state(): RecoveryLifecycleState {
    return this._state;
  }

  get transitionHistory(): ReadonlyArray<{
    from: RecoveryLifecycleState;
    to: RecoveryLifecycleState;
    at: string;
    reason: string;
  }> {
    return this.history;
  }

  /**
   * 尝试状态转换。非法转换返回 ok=false 且不修改状态。
   */
  transition(to: RecoveryLifecycleState, reason = ""): TransitionResult {
    const from = this._state;
    // 硬规则：不得自动从 checkpoint/blocked/interrupted → committed
    if (
      to === "committed" &&
      (from === "checkpoint" || from === "blocked" || from === "interrupted")
    ) {
      return {
        ok: false,
        from,
        to,
        reason: `非法转换：${from} 不得直接变为 committed（${reason || "no auto-commit"}）`,
        state: this._state,
      };
    }
    if (!canTransition(from, to)) {
      return {
        ok: false,
        from,
        to,
        reason: `非法状态转换：${from} -> ${to}；允许：${(RECOVERY_TRANSITIONS[from] ?? []).join(",") || "(terminal)"}`,
        state: this._state,
      };
    }
    this._state = to;
    this.history.push({
      from,
      to,
      at: new Date().toISOString(),
      reason: reason || `${from}->${to}`,
    });
    return { ok: true, from, to, reason: reason || "ok", state: this._state };
  }

  /** 显式 resume：仅 checkpoint → running */
  resume(reason = "explicit_resume"): TransitionResult {
    if (this._state !== "checkpoint") {
      return {
        ok: false,
        from: this._state,
        to: "running",
        reason: `resume 仅允许从 checkpoint；当前=${this._state}`,
        state: this._state,
      };
    }
    return this.transition("running", reason);
  }

  /** 重置为 running（新章节/新任务） */
  reset(): void {
    this._state = "running";
    this.history.length = 0;
  }
}

export function createRecoveryStateMachine(
  initial?: RecoveryLifecycleState,
): RecoveryStateMachine {
  return new RecoveryStateMachine(initial);
}

export function assertTransition(
  from: RecoveryLifecycleState,
  to: RecoveryLifecycleState,
): void {
  const sm = new RecoveryStateMachine(from);
  const result = sm.transition(to);
  if (!result.ok) {
    throw new Error(result.reason);
  }
}
