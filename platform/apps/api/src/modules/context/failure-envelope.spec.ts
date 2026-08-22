import { describe, expect, it } from 'vitest';
import {
  envelopeFromUnknown,
  FAILURE_CODES,
  makeFailure,
  sanitizeUserFacingText,
} from './failure-envelope';

describe('FailureEnvelope', () => {
  it('maps stable stage/code/recoverable fields', () => {
    const envelope = makeFailure({
      stage: 'runtime.preflight',
      gate: 'narrative_state',
      code: FAILURE_CODES.stateStoreHashMismatch,
      severity: 'preflight',
      reason: '前章叙事状态与正文哈希不一致',
      recoverable: false,
      fixInstructions: ['重算第一章 hash'],
    });
    expect(envelope.stage).toBe('runtime.preflight');
    expect(envelope.code).toBe('state_store_hash_mismatch');
    expect(envelope.recoverable).toBe(false);
    expect(envelope.fixInstructions?.[0]).toContain('hash');
  });

  it('strips stack, provider and secrets from user-facing text', () => {
    expect(sanitizeUserFacingText('Error: boom\n    at JobsService (jobs.service.ts:12)')).toBe(
      '操作失败，请稍后重试或按提示补全资料',
    );
    expect(sanitizeUserFacingText('aimagichub 401 api_key expired')).toBe(
      '操作失败，请稍后重试或按提示补全资料',
    );
    expect(sanitizeUserFacingText('请补全书大纲后再生成')).toBe('请补全书大纲后再生成');
  });

  it('maps unknown SSE errors without leaking raw internals', () => {
    const envelope = envelopeFromUnknown(new Error('ECONNREFUSED 127.0.0.1:5432 postgres'), {
      stage: 'assistant.sse',
      gate: 'stream',
      code: FAILURE_CODES.sseInterrupted,
    });
    expect(envelope.code).toBe(FAILURE_CODES.sseInterrupted);
    expect(envelope.reason).not.toMatch(/ECONNREFUSED|postgres/i);
  });
});
