/**
 * RUN-AGGREGATE-ERRORS — 标准错误码与错误对象（P1）
 */

export const RUN_ERROR_CODES = {
  STALE_REVISION: "STALE_REVISION",
  ARTIFACT_HASH_MISMATCH: "ARTIFACT_HASH_MISMATCH",
  DUPLICATE_EVENT_ID: "DUPLICATE_EVENT_ID",
  DUPLICATE_COMMAND_ID: "DUPLICATE_COMMAND_ID",
  DUPLICATE_COMMIT_INTENT: "DUPLICATE_COMMIT_INTENT",
  SEQUENCE_GAP: "SEQUENCE_GAP",
  ILLEGAL_TRANSITION: "ILLEGAL_TRANSITION",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  ORPHAN_PARENT_EVENT: "ORPHAN_PARENT_EVENT",
  JSONL_TAIL_CORRUPT: "JSONL_TAIL_CORRUPT",
  AGGREGATE_REPLAY_DIVERGENCE: "AGGREGATE_REPLAY_DIVERGENCE",
  MISSING_BINDING: "MISSING_BINDING",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
} as const;

export type RunErrorCode =
  (typeof RUN_ERROR_CODES)[keyof typeof RUN_ERROR_CODES];

export class RunAggregateError extends Error {
  readonly code: RunErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: RunErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RunAggregateError";
    this.code = code;
    this.details = details;
  }
}

export function isRunAggregateError(err: unknown): err is RunAggregateError {
  return err instanceof RunAggregateError;
}
