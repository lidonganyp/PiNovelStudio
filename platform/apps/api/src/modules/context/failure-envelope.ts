/**
 * 平台失败契约：聊天、任务、Runtime 共用，响应体不得泄漏内部细节。
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { FailureEnvelope, FailureSeverity } from './types';

const SENSITIVE_RE =
  /stack|api[_-]?key|authorization|postgres|mongodb|ECONNREFUSED|aimagichub|openai|anthropic|solov|gemini|claude|\bglm\b|deepseek|qwen|doubao|ernie|provider|secret|token\s*[=:]|bearer\s+[a-z0-9.-]+|sk-[a-z0-9]+/i;

export const FAILURE_CODES = {
  generationHistoryUnavailable: 'generation_history_unavailable',
  generationMaterialsChanged: 'generation_materials_changed',
  historyLoadFailed: 'history_load_failed',
  messageSaveFailed: 'message_save_failed',
  plannerFailed: 'planner_failed',
  artifactSaveFailed: 'artifact_save_failed',
  illegalAction: 'illegal_action',
  artifactActionMismatch: 'artifact_action_mismatch',
  generationUnconfirmed: 'generation_unconfirmed',
  missingChapterNumber: 'missing_chapter_number',
  jobSubmitFailed: 'job_submit_failed',
  generationBillingUnavailable: 'generation_billing_unavailable',
  runtimePreflightFailed: 'runtime_preflight_failed',
  stateStoreHashMismatch: 'state_store_hash_mismatch',
  environmentFingerprintMismatch: 'environment_fingerprint_mismatch',
  generationFailed: 'generation_failed',
  generationModelUnavailable: 'generation_model_unavailable',
  narrativeStateCommitFailed: 'narrative_state_commit_failed',
  sseInterrupted: 'sse_interrupted',
  contextBudgetExceeded: 'context_budget_exceeded',
  plannerSchemaInvalid: 'planner_schema_invalid',
} as const;

export class ContextCompileError extends Error {
  constructor(public readonly envelope: FailureEnvelope) {
    super(envelope.reason);
    this.name = 'ContextCompileError';
  }
}

export function makeFailure(input: {
  stage: string;
  gate: string;
  code: string;
  severity: FailureSeverity;
  reason: string;
  evidence?: unknown;
  recoverable: boolean;
  retryPlan?: string;
  userActionRequired?: string[];
  fixInstructions?: string[];
  traceArchivePath?: string;
}): FailureEnvelope {
  return {
    stage: input.stage,
    gate: input.gate,
    code: input.code,
    severity: input.severity,
    reason: sanitizeUserFacingText(input.reason),
    evidence: sanitizeEvidence(input.evidence),
    recoverable: input.recoverable,
    retryPlan: input.retryPlan,
    userActionRequired: input.userActionRequired,
    fixInstructions: input.fixInstructions,
    traceArchivePath: input.traceArchivePath,
  };
}

export function sanitizeUserFacingText(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '操作失败，请稍后重试';
  if (SENSITIVE_RE.test(trimmed) || /at\s+\S+\s+\(/.test(trimmed)) {
    return '操作失败，请稍后重试或按提示补全资料';
  }
  return trimmed.slice(0, 400);
}

export function sanitizeEvidence(evidence: unknown): unknown {
  if (evidence === undefined) return undefined;
  try {
    const raw = JSON.stringify(evidence);
    if (SENSITIVE_RE.test(raw)) {
      return { omitted: 'sensitive' };
    }
    return evidence;
  } catch {
    return undefined;
  }
}

export function httpStatusForFailure(envelope: FailureEnvelope): number {
  if (envelope.code === FAILURE_CODES.generationBillingUnavailable) return HttpStatus.SERVICE_UNAVAILABLE;
  if (envelope.code === FAILURE_CODES.illegalAction) return HttpStatus.BAD_REQUEST;
  if (envelope.code === FAILURE_CODES.missingChapterNumber) return HttpStatus.BAD_REQUEST;
  if (envelope.code === FAILURE_CODES.generationUnconfirmed) return HttpStatus.BAD_REQUEST;
  if (envelope.code === FAILURE_CODES.artifactActionMismatch) return HttpStatus.BAD_REQUEST;
  if (envelope.severity === 'preflight') return HttpStatus.UNPROCESSABLE_ENTITY;
  if (envelope.severity === 'recoverable') return HttpStatus.SERVICE_UNAVAILABLE;
  if (envelope.severity === 'fatal') return HttpStatus.INTERNAL_SERVER_ERROR;
  return HttpStatus.BAD_REQUEST;
}

export class FailureHttpException extends HttpException {
  constructor(public readonly envelope: FailureEnvelope) {
    super(
      {
        statusCode: httpStatusForFailure(envelope),
        message: envelope.reason,
        failure: envelope,
      },
      httpStatusForFailure(envelope),
    );
  }
}

export function envelopeFromUnknown(
  error: unknown,
  fallback: { stage: string; gate: string; code: string },
): FailureEnvelope {
  if (error instanceof ContextCompileError) return error.envelope;
  if (error instanceof FailureHttpException) return error.envelope;
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (body && typeof body === 'object' && 'failure' in body) {
      return (body as { failure: FailureEnvelope }).failure;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return makeFailure({
    stage: fallback.stage,
    gate: fallback.gate,
    code: fallback.code,
    severity: 'recoverable',
    reason: sanitizeUserFacingText(message),
    recoverable: true,
    retryPlan: 'retry_same_stage',
  });
}
