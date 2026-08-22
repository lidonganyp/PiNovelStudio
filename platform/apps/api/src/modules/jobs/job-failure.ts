/**
 * 将 Runtime / persist / preflight 失败归一成任务 FailureEnvelope。
 */
import { ContextCompileError, FailureHttpException, FAILURE_CODES, makeFailure } from '../context/failure-envelope';
import type { FailureEnvelope } from '../context/types';
import { RuntimeWorkspacePayloadError } from './runtime-workspace-payload';

export class JobFailureError extends Error {
  constructor(public readonly envelope: FailureEnvelope) {
    super(envelope.reason);
    this.name = 'JobFailureError';
  }
}

export function jobFailureFromUnknown(error: unknown): FailureEnvelope {
  if (error instanceof JobFailureError) return error.envelope;
  if (error instanceof ContextCompileError) return error.envelope;
  if (error instanceof FailureHttpException) return error.envelope;
  if (error instanceof RuntimeWorkspacePayloadError) {
    return makeFailure({
      stage: 'runtime.preflight',
      gate: 'workspace_payload',
      code: FAILURE_CODES.runtimePreflightFailed,
      severity: 'preflight',
      reason: '生成资料超过运行时上限，请精简大纲或状态后再试',
      recoverable: false,
      userActionRequired: ['精简全书大纲或叙事状态'],
    });
  }
  const raw = error instanceof Error ? error.message : String(error);
  return classifyMessage(raw);
}

export function runtimeInvokeFailure(
  result: unknown,
  modelCallCount: number | undefined,
): JobFailureError {
  if (result && typeof result === 'object') {
    const value = result as {
      failureEnvelope?: Record<string, unknown>;
      reason?: unknown;
      status?: unknown;
    };
    const raw = value.failureEnvelope;
    if (raw && typeof raw === 'object') {
      const reason = typeof raw.reason === 'string' && raw.reason.trim()
        ? raw.reason.trim()
        : '运行时预检或生成失败';
      const code = codeFromRuntimeReason(reason, value.status);
      return new JobFailureError(makeFailure({
        stage: typeof raw.stage === 'string' ? raw.stage : stageForCode(code),
        gate: typeof raw.gate === 'string' ? raw.gate : 'runtime',
        code,
        severity: severityForCode(code),
        reason,
        recoverable: code !== FAILURE_CODES.stateStoreHashMismatch,
        retryPlan: code === FAILURE_CODES.stateStoreHashMismatch ? undefined : 'retry_same_stage',
        evidence: raw.evidence,
        userActionRequired: Array.isArray(raw.userActionRequired)
          ? raw.userActionRequired.filter((item): item is string => typeof item === 'string')
          : undefined,
        fixInstructions: Array.isArray(raw.fixInstructions)
          ? raw.fixInstructions.filter((item): item is string => typeof item === 'string')
          : undefined,
      }));
    }
    if (typeof value.reason === 'string' && value.reason.trim()) {
      const reason = value.reason.trim();
      const code = codeFromRuntimeReason(reason, value.status);
      return new JobFailureError(makeFailure({
        stage: stageForCode(code),
        gate: typeof value.status === 'string' ? value.status : 'runtime',
        code,
        severity: severityForCode(code),
        reason,
        recoverable: code !== FAILURE_CODES.stateStoreHashMismatch,
        retryPlan: code === FAILURE_CODES.stateStoreHashMismatch ? undefined : 'retry_same_stage',
      }));
    }
  }
  if (modelCallCount === 0) {
    return new JobFailureError(makeFailure({
      stage: 'runtime.generate',
      gate: 'metering',
      code: FAILURE_CODES.generationFailed,
      severity: 'hard',
      reason: '章节生成未调用模型，未产出可交付正文',
      recoverable: true,
      retryPlan: 'retry_same_stage',
    }));
  }
  return new JobFailureError(makeFailure({
    stage: 'runtime.generate',
    gate: 'runtime',
    code: FAILURE_CODES.generationFailed,
    severity: 'hard',
    reason: '章节生成未产出可交付正文',
    recoverable: true,
    retryPlan: 'retry_same_stage',
  }));
}

export function readStoredFailure(
  failure: unknown,
  failureMessage: string | null,
): FailureEnvelope | null {
  if (failure && typeof failure === 'object' && !Array.isArray(failure)) {
    const row = failure as Record<string, unknown>;
    if (typeof row.code === 'string' && typeof row.reason === 'string') {
      return {
        stage: typeof row.stage === 'string' ? row.stage : 'runtime.generate',
        gate: typeof row.gate === 'string' ? row.gate : 'runtime',
        code: row.code,
        severity: row.severity === 'preflight' || row.severity === 'recoverable'
          || row.severity === 'hard' || row.severity === 'fatal'
          ? row.severity
          : 'hard',
        reason: row.reason,
        recoverable: row.recoverable === true,
        retryPlan: typeof row.retryPlan === 'string' ? row.retryPlan : undefined,
        userActionRequired: Array.isArray(row.userActionRequired)
          ? row.userActionRequired.filter((item): item is string => typeof item === 'string')
          : undefined,
        fixInstructions: Array.isArray(row.fixInstructions)
          ? row.fixInstructions.filter((item): item is string => typeof item === 'string')
          : undefined,
      };
    }
  }
  if (failureMessage?.trim()) {
    return classifyMessage(failureMessage);
  }
  return null;
}

function classifyMessage(message: string): FailureEnvelope {
  const tagged = message.match(/^\[([a-z0-9_]+)\]\s*(.*)$/i);
  if (tagged) {
    const code = tagged[1];
    return makeFailure({
      stage: stageForCode(code),
      gate: code,
      code,
      severity: severityForCode(code),
      reason: tagged[2] || message,
      recoverable: code !== FAILURE_CODES.stateStoreHashMismatch,
      retryPlan: code === FAILURE_CODES.stateStoreHashMismatch ? undefined : 'retry_same_stage',
    });
  }
  if (/state_store_hash_mismatch|哈希不一致/.test(message)) {
    return makeFailure({
      stage: 'runtime.preflight',
      gate: 'narrative_state',
      code: FAILURE_CODES.stateStoreHashMismatch,
      severity: 'preflight',
      reason: message,
      recoverable: false,
      userActionRequired: ['修复前章叙事状态哈希'],
    });
  }
  if (/runtime state is invalid|narrative state changed|narrative state/.test(message)) {
    return makeFailure({
      stage: 'runtime.commit',
      gate: 'narrative_state',
      code: FAILURE_CODES.narrativeStateCommitFailed,
      severity: 'hard',
      reason: '叙事状态提交失败，章节未作为成功交付',
      recoverable: true,
      retryPlan: 'retry_same_stage',
    });
  }
  if (/preflight|生成前预检|seed_readiness|workspace context is incomplete|chapter seed is missing/.test(message)) {
    return makeFailure({
      stage: 'runtime.preflight',
      gate: 'preflight',
      code: FAILURE_CODES.runtimePreflightFailed,
      severity: 'preflight',
      reason: message.slice(0, 400) || '运行时预检失败',
      recoverable: false,
      userActionRequired: ['补齐生成所需资料后重试'],
    });
  }
  return makeFailure({
    stage: 'runtime.generate',
    gate: 'runtime',
    code: FAILURE_CODES.generationFailed,
    severity: 'hard',
    reason: message.slice(0, 400) || '章节生成失败',
    recoverable: true,
    retryPlan: 'retry_same_stage',
  });
}

function codeFromRuntimeReason(reason: string, status: unknown): string {
  if (/state-store-hash-mismatch|state_store_hash_mismatch|哈希/.test(reason)) {
    return FAILURE_CODES.stateStoreHashMismatch;
  }
  if (/preflight|previous_state_store_invalid|seed_readiness|config_/.test(reason)) {
    return FAILURE_CODES.runtimePreflightFailed;
  }
  if (status === 'blocked') return FAILURE_CODES.generationFailed;
  return FAILURE_CODES.generationFailed;
}

function stageForCode(code: string): string {
  if (code === FAILURE_CODES.stateStoreHashMismatch) return 'runtime.preflight';
  if (code === FAILURE_CODES.runtimePreflightFailed) return 'runtime.preflight';
  if (code === FAILURE_CODES.narrativeStateCommitFailed) return 'runtime.commit';
  return 'runtime.generate';
}

function severityForCode(code: string): FailureEnvelope['severity'] {
  if (code === FAILURE_CODES.stateStoreHashMismatch) return 'preflight';
  if (code === FAILURE_CODES.runtimePreflightFailed) return 'preflight';
  return 'hard';
}
