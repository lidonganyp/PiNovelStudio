/**
 * RUN-AGGREGATE-REDUCER — 事件 → RunAggregate（P1/P2）
 *
 * 规则：
 * - 纯函数：输入 (aggregate, event) → 新 aggregate 或错误
 * - sequence 必须严格 +1（首条 run_started 的 sequence=1）
 * - 非法转换 / hash 不匹配 / stale revision 返回错误，不修改状态
 * - commandId 幂等：重复 command 返回首次状态 + duplicate 标记
 */

import type { AuditEvent } from "../audit/audit-event-types.js";
import type { RecoveryBudget } from "../recovery-types.js";
import {
  RUN_ERROR_CODES,
  RunAggregateError,
  type RunErrorCode,
} from "./run-aggregate-errors.js";
import {
  assertWorkflowTransition,
  canWorkflowTransition,
  createEmptyRunAggregate,
  updateRunAggregate,
  type RunAggregate,
  type WorkflowState,
  type ApprovalState,
  type CommitIntent,
} from "./run-aggregate-types.js";

export interface ReduceResult {
  ok: boolean;
  aggregate: RunAggregate;
  error?: RunAggregateError;
  /** 幂等命中（重复 commandId / 重复 commitIntent 已完成） */
  idempotentReplay?: boolean;
}

export interface ReduceOptions {
  /** 默认 true：严格 sequence */
  strictSequence?: boolean;
  /** 已见 eventId 集合（跨调用去重）；不传则仅用 sequence */
  seenEventIds?: Set<string>;
}

function payloadOf(event: AuditEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function applyWorkflow(
  current: RunAggregate,
  to: WorkflowState,
): { ok: true; next: WorkflowState } | { ok: false; error: RunAggregateError } {
  const check = assertWorkflowTransition(current.workflowState, to);
  if (!check.ok) {
    return {
      ok: false,
      error: new RunAggregateError(check.code as RunErrorCode, check.reason, {
        from: current.workflowState,
        to,
      }),
    };
  }
  return { ok: true, next: to };
}

function mergeBudget(
  current: RecoveryBudget,
  patch: unknown,
): RecoveryBudget {
  if (!patch || typeof patch !== "object") return { ...current };
  const p = patch as Partial<RecoveryBudget>;
  return {
    ...current,
    ...p,
  };
}

function rememberCommand(
  aggregate: RunAggregate,
  event: AuditEvent,
): RunAggregate {
  const commandId = str(payloadOf(event).commandId);
  if (!commandId) return aggregate;
  if (aggregate.seenCommandIds[commandId]) return aggregate;
  return updateRunAggregate(aggregate, {
    seenCommandIds: {
      ...aggregate.seenCommandIds,
      [commandId]: event.eventId,
    },
  });
}

function checkCommandIdempotency(
  aggregate: RunAggregate,
  event: AuditEvent,
): ReduceResult | null {
  const commandId = str(payloadOf(event).commandId);
  if (!commandId) return null;
  const prior = aggregate.seenCommandIds[commandId];
  if (prior && prior !== event.eventId) {
    return {
      ok: true,
      aggregate,
      idempotentReplay: true,
      error: new RunAggregateError(
        RUN_ERROR_CODES.DUPLICATE_COMMAND_ID,
        `commandId 已处理: ${commandId}`,
        { commandId, firstEventId: prior, eventId: event.eventId },
      ),
    };
  }
  return null;
}

/**
 * 将单条审计事件应用到聚合。
 */
export function reduceRunAggregate(
  current: RunAggregate,
  event: AuditEvent,
  options: ReduceOptions = {},
): ReduceResult {
  const strictSequence = options.strictSequence ?? true;
  const payload = payloadOf(event);

  if (options.seenEventIds?.has(event.eventId)) {
    return {
      ok: false,
      aggregate: current,
      error: new RunAggregateError(
        RUN_ERROR_CODES.DUPLICATE_EVENT_ID,
        `duplicate eventId: ${event.eventId}`,
        { eventId: event.eventId },
      ),
    };
  }

  if (event.runId !== current.runId) {
    return {
      ok: false,
      aggregate: current,
      error: new RunAggregateError(
        RUN_ERROR_CODES.INVALID_PAYLOAD,
        `runId mismatch: aggregate=${current.runId} event=${event.runId}`,
      ),
    };
  }

  if (strictSequence && event.sequence !== current.lastSequence + 1) {
    return {
      ok: false,
      aggregate: current,
      error: new RunAggregateError(
        RUN_ERROR_CODES.SEQUENCE_GAP,
        `sequence gap: expected ${current.lastSequence + 1}, got ${event.sequence}`,
        { expected: current.lastSequence + 1, got: event.sequence },
      ),
    };
  }

  const idem = checkCommandIdempotency(current, event);
  if (idem) return idem;

  let next = updateRunAggregate(current, {
    lastSequence: event.sequence,
    lastEventId: event.eventId,
    lastStage: event.stage ?? current.lastStage,
  });
  next = rememberCommand(next, event);

  const type = event.eventType;

  try {
    switch (type) {
      case "run_started": {
        // 首事件：允许保持 running
        next = updateRunAggregate(next, {
          workflowState: "running",
          terminalStatus: "none",
        });
        break;
      }

      case "stage_started": {
        // 仅记录 lastStage（已写）；不强制改 workflow
        break;
      }

      case "retry_reserved":
      case "retry_scheduled": {
        if (payload.recoveryBudget) {
          next = updateRunAggregate(next, {
            recoveryBudget: mergeBudget(next.recoveryBudget, payload.recoveryBudget),
          });
        }
        const wf = applyWorkflow(next, "retrying");
        if (!wf.ok) return { ok: false, aggregate: current, error: wf.error };
        // retry_scheduled 可能从 running 直接来：先到 retryable_failure 再 retrying 过严
        // 允许 running → retryable_failure 路径由调用方保证；此处若失败则保持并记预算
        if (wf.ok) {
          next = updateRunAggregate(next, { workflowState: wf.next });
        }
        break;
      }

      case "checkpoint_saved": {
        const wf = applyWorkflow(next, "checkpoint");
        if (!wf.ok) return { ok: false, aggregate: current, error: wf.error };
        next = updateRunAggregate(next, {
          workflowState: "checkpoint",
          checkpointId:
            str(payload.checkpointId) ?? event.eventId,
          artifactRevision: str(event.revision) ?? next.artifactRevision,
          artifactHash: str(event.outputHash) ?? next.artifactHash,
          activeCandidate: str(event.candidateId) ?? next.activeCandidate,
        });
        break;
      }

      case "checkpoint_resumed":
      case "run_recovered": {
        if (next.workflowState !== "checkpoint" && type === "checkpoint_resumed") {
          return {
            ok: false,
            aggregate: current,
            error: new RunAggregateError(
              RUN_ERROR_CODES.ILLEGAL_TRANSITION,
              `resume 仅允许从 checkpoint；当前=${next.workflowState}`,
            ),
          };
        }
        const wf = applyWorkflow(next, "running");
        if (!wf.ok) return { ok: false, aggregate: current, error: wf.error };
        next = updateRunAggregate(next, { workflowState: "running" });
        break;
      }

      case "approval_requested": {
        const wf = applyWorkflow(next, "awaiting_approval");
        // 若当前 running 合法；否则尝试从 commit_pending 等失败
        if (!wf.ok) {
          // 兼容：旧路径可能已在 commit_pending
          if (next.workflowState !== "awaiting_approval") {
            return { ok: false, aggregate: current, error: wf.error };
          }
        } else {
          next = updateRunAggregate(next, { workflowState: "awaiting_approval" });
        }
        next = updateRunAggregate(next, {
          approvalState: "pending",
          approvalId: str(event.approvalId) ?? str(payload.approvalId),
          artifactRevision:
            str(event.revision) ?? str(payload.artifactRevision) ?? next.artifactRevision,
          artifactHash:
            str(event.outputHash) ??
            str(payload.artifactHash) ??
            next.artifactHash,
          activeCandidate:
            str(event.candidateId) ?? str(payload.candidateId) ?? next.activeCandidate,
        });
        break;
      }

      case "user_accepted": {
        next = updateRunAggregate(next, {
          approvalState: "accepted",
          approvalId:
            str(event.approvalId) ?? str(payload.approvalId) ?? next.approvalId,
        });
        break;
      }

      case "user_modified": {
        const newRev =
          str(event.revision) ?? str(payload.artifactRevision);
        const newHash =
          str(event.outputHash) ?? str(payload.artifactHash);
        // 用户修改必须升版；若带旧 revision 且与聚合相同但 hash 变了 → 仍升版由调用方给新 revision
        if (
          newRev &&
          next.artifactRevision &&
          newRev === next.artifactRevision &&
          newHash &&
          next.artifactHash &&
          newHash !== next.artifactHash
        ) {
          return {
            ok: false,
            aggregate: current,
            error: new RunAggregateError(
              RUN_ERROR_CODES.STALE_REVISION,
              "user_modified 不得复用旧 revision 覆盖不同 hash",
              {
                revision: newRev,
                previousHash: next.artifactHash,
                newHash,
              },
            ),
          };
        }
        next = updateRunAggregate(next, {
          approvalState: "modified",
          artifactRevision: newRev ?? next.artifactRevision,
          artifactHash: newHash ?? next.artifactHash,
          approvalId:
            str(event.approvalId) ?? str(payload.approvalId) ?? next.approvalId,
        });
        break;
      }

      case "user_rejected": {
        next = updateRunAggregate(next, {
          approvalState: "rejected",
        });
        const wf = applyWorkflow(next, "running");
        if (wf.ok) {
          next = updateRunAggregate(next, { workflowState: "running" });
        }
        break;
      }

      case "candidate_created":
      case "candidate_derived": {
        next = updateRunAggregate(next, {
          activeCandidate:
            str(event.candidateId) ?? next.activeCandidate,
          artifactRevision: str(event.revision) ?? next.artifactRevision,
          artifactHash: str(event.outputHash) ?? next.artifactHash,
        });
        break;
      }

      case "commit_started":
      case "chapter_save_attempted": {
        if (type === "commit_started" || payload.commitIntentId) {
          const commitIntentId =
            str(payload.commitIntentId) ?? str(payload.finalizationId);
          if (!commitIntentId) {
            if (type === "commit_started") {
              return {
                ok: false,
                aggregate: current,
                error: new RunAggregateError(
                  RUN_ERROR_CODES.MISSING_BINDING,
                  "commit_started 需要 commitIntentId",
                ),
              };
            }
          } else {
            if (
              next.commitIntent?.commitIntentId === commitIntentId &&
              next.commitIntent.status === "completed"
            ) {
              return {
                ok: true,
                aggregate: current,
                idempotentReplay: true,
                error: new RunAggregateError(
                  RUN_ERROR_CODES.DUPLICATE_COMMIT_INTENT,
                  `commitIntent 已完成: ${commitIntentId}`,
                ),
              };
            }
            const rev =
              str(event.revision) ??
              str(payload.artifactRevision) ??
              next.artifactRevision;
            const hash =
              str(event.outputHash) ??
              str(payload.artifactHash) ??
              next.artifactHash;
            if (!rev || !hash) {
              return {
                ok: false,
                aggregate: current,
                error: new RunAggregateError(
                  RUN_ERROR_CODES.MISSING_BINDING,
                  "commit 需要 artifactRevision + artifactHash",
                ),
              };
            }
            // stale / hash 守卫
            if (
              next.artifactRevision &&
              rev !== next.artifactRevision &&
              payload.allowRevisionBump !== true
            ) {
              // 允许 commit 携带当前绑定 revision；若 event 带不同 revision 且非 bump → stale
              // 若聚合尚无 revision，接受 event 的
            }
            if (next.artifactHash && hash !== next.artifactHash) {
              return {
                ok: false,
                aggregate: current,
                error: new RunAggregateError(
                  RUN_ERROR_CODES.ARTIFACT_HASH_MISMATCH,
                  `artifactHash 不匹配：aggregate=${next.artifactHash} event=${hash}`,
                ),
              };
            }
            if (
              next.artifactRevision &&
              rev !== next.artifactRevision
            ) {
              return {
                ok: false,
                aggregate: current,
                error: new RunAggregateError(
                  RUN_ERROR_CODES.STALE_REVISION,
                  `stale revision：aggregate=${next.artifactRevision} event=${rev}`,
                ),
              };
            }
            // 审批未确认时拒绝提交（若曾进入审批流）
            if (
              next.approvalState === "pending" ||
              next.approvalState === "rejected" ||
              next.approvalState === "stale"
            ) {
              return {
                ok: false,
                aggregate: current,
                error: new RunAggregateError(
                  RUN_ERROR_CODES.APPROVAL_REQUIRED,
                  `approvalState=${next.approvalState} 时不可 commit`,
                ),
              };
            }
            const intent: CommitIntent = {
              commitIntentId,
              finalizationId: str(payload.finalizationId) ?? undefined,
              commandId: str(payload.commandId) ?? undefined,
              artifactRevision: rev,
              artifactHash: hash,
              approvalId: str(event.approvalId) ?? next.approvalId ?? undefined,
              status: "attempted",
              startedAt: new Date(event.timestamp).toISOString(),
            };
            const wf = applyWorkflow(next, "commit_pending");
            if (!wf.ok && next.workflowState !== "commit_pending") {
              return { ok: false, aggregate: current, error: wf.error };
            }
            next = updateRunAggregate(next, {
              workflowState: "commit_pending",
              commitIntent: intent,
              artifactRevision: rev,
              artifactHash: hash,
            });
          }
        }
        break;
      }

      case "chapter_saved": {
        next = updateRunAggregate(next, {
          artifactHash: str(event.outputHash) ?? next.artifactHash,
          artifactRevision: str(event.revision) ?? next.artifactRevision,
        });
        break;
      }

      case "state_committed": {
        next = updateRunAggregate(next, {
          narrativeStateRevision:
            str(payload.narrativeStateRevision) ??
            str(event.revision) ??
            next.narrativeStateRevision,
          narrativeBaseRevision:
            str(payload.narrativeBaseRevision) ?? next.narrativeBaseRevision,
        });
        break;
      }

      case "final_submission": {
        const chapterOk = payload.chapterSaveOk === true;
        const stateOk =
          payload.stateCommitOk === true ||
          payload.stateCommitOutcome === "skipped";
        if (chapterOk && stateOk) {
          // 允许从 commit_pending / running / awaiting_approval(已 accept) 进入 committed
          let wf = applyWorkflow(next, "committed");
          if (!wf.ok && next.workflowState !== "committed") {
            // 若当前不在 commit_pending，尝试经 commit_pending 再 committed
            if (canWorkflowTransition(next.workflowState, "commit_pending")) {
              next = updateRunAggregate(next, {
                workflowState: "commit_pending",
              });
              wf = applyWorkflow(next, "committed");
            }
            if (!wf.ok) {
              return { ok: false, aggregate: current, error: wf.error };
            }
          }
          const intentFromPayload = str(payload.commitIntentId);
          const intent = next.commitIntent
            ? {
                ...next.commitIntent,
                status: "completed" as const,
                completedAt: new Date(event.timestamp).toISOString(),
              }
            : intentFromPayload
              ? {
                  commitIntentId: intentFromPayload,
                  artifactRevision:
                    str(event.revision) ??
                    str(payload.artifactRevision) ??
                    next.artifactRevision ??
                    "unknown",
                  artifactHash:
                    str(event.outputHash) ??
                    str(payload.artifactHash) ??
                    next.artifactHash ??
                    "unknown",
                  status: "completed" as const,
                  completedAt: new Date(event.timestamp).toISOString(),
                }
              : null;
          next = updateRunAggregate(next, {
            workflowState: "committed",
            terminalStatus: "committed",
            commitIntent: intent,
            approvalState:
              next.approvalState === "pending" ||
              next.approvalState === "accepted" ||
              next.approvalState === "modified"
                ? "cleared"
                : next.approvalState,
          });
        }
        break;
      }

      case "commit_failed":
      case "chapter_save_failed":
      case "state_commit_failed": {
        if (next.commitIntent) {
          next = updateRunAggregate(next, {
            commitIntent: {
              ...next.commitIntent,
              status: "failed",
            },
            lastErrorCode: RUN_ERROR_CODES.ILLEGAL_TRANSITION,
          });
        }
        // 不自动 committed；可保持 commit_pending 或 blocked
        if (type === "commit_failed") {
          const wf = applyWorkflow(next, "blocked");
          if (wf.ok) {
            next = updateRunAggregate(next, {
              workflowState: "blocked",
              terminalStatus: "blocked",
            });
          }
        }
        break;
      }

      case "failure_recorded": {
        const fc = event.failureClass;
        if (fc === "blocked" || fc === "fatal" || fc === "preflight") {
          const wf = applyWorkflow(next, "blocked");
          if (wf.ok) {
            next = updateRunAggregate(next, {
              workflowState: "blocked",
              terminalStatus: "blocked",
            });
          }
        } else if (fc === "interrupted") {
          const wf = applyWorkflow(next, "interrupted");
          if (wf.ok) {
            next = updateRunAggregate(next, {
              workflowState: "interrupted",
              terminalStatus: "interrupted",
            });
          }
        } else if (fc === "recoverable") {
          const wf = applyWorkflow(next, "retryable_failure");
          if (wf.ok) {
            next = updateRunAggregate(next, {
              workflowState: "retryable_failure",
            });
          }
        }
        break;
      }

      case "run_finished": {
        next = updateRunAggregate(next, {
          terminalStatus:
            next.workflowState === "committed" ? "committed" : "finished",
        });
        break;
      }

      case "run_failed": {
        next = updateRunAggregate(next, {
          terminalStatus: "failed",
          workflowState:
            next.workflowState === "committed"
              ? next.workflowState
              : "blocked",
        });
        break;
      }

      case "run_interrupted": {
        const wf = applyWorkflow(next, "interrupted");
        if (wf.ok) {
          next = updateRunAggregate(next, {
            workflowState: "interrupted",
            terminalStatus: "interrupted",
          });
        }
        break;
      }

      case "evidence_revoked": {
        const evidenceId = str(payload.evidenceId);
        if (!evidenceId) {
          return {
            ok: false,
            aggregate: current,
            error: new RunAggregateError(
              RUN_ERROR_CODES.INVALID_PAYLOAD,
              "evidence_revoked 需要 payload.evidenceId",
            ),
          };
        }
        next = updateRunAggregate(next, {
          activeEvidenceIds: next.activeEvidenceIds.filter(
            (id) => id !== evidenceId,
          ),
          revokedEvidenceIds: next.revokedEvidenceIds.includes(evidenceId)
            ? next.revokedEvidenceIds
            : [...next.revokedEvidenceIds, evidenceId],
        });
        break;
      }

      case "state_recomputed": {
        next = updateRunAggregate(next, {
          narrativeStateRevision:
            str(payload.narrativeStateRevision) ??
            str(event.revision) ??
            next.narrativeStateRevision,
          narrativeBaseRevision:
            str(payload.narrativeBaseRevision) ?? next.narrativeBaseRevision,
        });
        break;
      }

      case "compensation_started": {
        // 补偿运行应是新 run；若同 run 收到则标记 workflow
        next = updateRunAggregate(next, {
          workflowState: "compensation_run",
          parentRunId:
            str(payload.parentRunId) ?? next.parentRunId ?? next.runId,
          terminalStatus: "none",
        });
        break;
      }

      case "user_rollback": {
        // 同 run 内 rollback 事件：不倒退 committed 到 running；标记需补偿
        if (next.workflowState === "committed") {
          // 保持 committed；记录错误码提示应新开 compensation_run
          next = updateRunAggregate(next, {
            lastErrorCode: RUN_ERROR_CODES.ILLEGAL_TRANSITION,
          });
        }
        break;
      }

      default:
        // 未知/其他事件：只推进 sequence 游标
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      aggregate: current,
      error:
        err instanceof RunAggregateError
          ? err
          : new RunAggregateError(RUN_ERROR_CODES.INVALID_PAYLOAD, message),
    };
  }

  if (options.seenEventIds) {
    options.seenEventIds.add(event.eventId);
  }

  return { ok: true, aggregate: next };
}

/**
 * 从事件列表完整重放。
 */
export function replayRunAggregate(
  seed: {
    workspaceId: string;
    chapterId: string;
    runId: string;
    traceId: string;
  },
  events: readonly AuditEvent[],
  options: ReduceOptions = {},
): ReduceResult {
  let aggregate = createEmptyRunAggregate(seed);
  const seen = options.seenEventIds ?? new Set<string>();
  const opts: ReduceOptions = { ...options, seenEventIds: seen };

  if (events.length === 0) {
    return { ok: true, aggregate };
  }

  for (const event of events) {
    const result = reduceRunAggregate(aggregate, event, opts);
    if (!result.ok && !result.idempotentReplay) {
      return result;
    }
    if (result.ok) {
      aggregate = result.aggregate;
    }
  }
  return { ok: true, aggregate };
}

/** 校验 artifact 绑定是否与聚合一致 */
export function assertArtifactBinding(
  aggregate: RunAggregate,
  binding: {
    artifactRevision?: string | null;
    artifactHash?: string | null;
  },
): { ok: true } | { ok: false; error: RunAggregateError } {
  if (
    binding.artifactRevision &&
    aggregate.artifactRevision &&
    binding.artifactRevision !== aggregate.artifactRevision
  ) {
    return {
      ok: false,
      error: new RunAggregateError(
        RUN_ERROR_CODES.STALE_REVISION,
        `stale revision：aggregate=${aggregate.artifactRevision} binding=${binding.artifactRevision}`,
      ),
    };
  }
  if (
    binding.artifactHash &&
    aggregate.artifactHash &&
    binding.artifactHash !== aggregate.artifactHash
  ) {
    return {
      ok: false,
      error: new RunAggregateError(
        RUN_ERROR_CODES.ARTIFACT_HASH_MISMATCH,
        `hash mismatch：aggregate=${aggregate.artifactHash} binding=${binding.artifactHash}`,
      ),
    };
  }
  return { ok: true };
}

export type { ApprovalState };
