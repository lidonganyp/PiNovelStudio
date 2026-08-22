import { describe, expect, it } from 'vitest';
import { ContextCompileError, FAILURE_CODES, makeFailure } from '../context/failure-envelope';
import { jobFailureFromUnknown, readStoredFailure, runtimeInvokeFailure } from './job-failure';

describe('job failure envelope', () => {
  it('keeps compile hash mismatch structured', () => {
    const error = new ContextCompileError(makeFailure({
      stage: 'runtime.preflight',
      gate: 'narrative_state',
      code: FAILURE_CODES.stateStoreHashMismatch,
      severity: 'preflight',
      reason: '前章叙事状态与正文哈希不一致',
      recoverable: false,
    }));
    const envelope = jobFailureFromUnknown(error);
    expect(envelope.code).toBe('state_store_hash_mismatch');
    expect(envelope.stage).toBe('runtime.preflight');
    expect(envelope.recoverable).toBe(false);
  });

  it('maps runtime preflight blocked results', () => {
    const error = runtimeInvokeFailure(
      { status: 'blocked', reason: 'preflight', failureEnvelope: { stage: 'preflight', gate: 'previous_state_store_invalid', reason: 'state-store-hash-mismatch: x' } },
      0,
    );
    expect(error.envelope.code).toBe('state_store_hash_mismatch');
    expect(error.envelope.stage).toBe('preflight');
  });

  it('maps a 422 seed_readiness envelope to runtime_preflight_failed, not generation_failed', () => {
    const error = runtimeInvokeFailure(
      {
        code: 'CHAPTER_NOT_DELIVERABLE',
        message: '【生成前预检】✗ 阻断',
        status: 'blocked',
        failureEnvelope: {
          stage: 'preflight',
          gate: 'seed_readiness',
          reason: '[seed_readiness] ChapterSeed 种子可生长性不足（score=70/100, status=blocked）',
          evidence: { check: 'seed_readiness' },
        },
      },
      0,
    );
    expect(error.envelope.code).toBe('runtime_preflight_failed');
    expect(error.envelope.gate).toBe('seed_readiness');
    expect(error.envelope.stage).toBe('preflight');
    expect(error.envelope.reason).toContain('seed_readiness');
  });

  it('maps invalid runtime state persist errors to commit failure', () => {
    const envelope = jobFailureFromUnknown(new Error('runtime state is invalid: expected a JSON object'));
    expect(envelope.code).toBe('narrative_state_commit_failed');
    expect(envelope.stage).toBe('runtime.commit');
  });

  it('rehydrates a stored envelope for getJob', () => {
    const stored = readStoredFailure({
      stage: 'runtime.preflight',
      gate: 'narrative_state',
      code: 'state_store_hash_mismatch',
      severity: 'preflight',
      reason: '前章叙事状态与正文哈希不一致',
      recoverable: false,
    }, 'ignored');
    expect(stored?.code).toBe('state_store_hash_mismatch');
    expect(stored?.retryPlan).toBeUndefined();
  });
});
