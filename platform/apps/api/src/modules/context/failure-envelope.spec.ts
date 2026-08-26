import { describe, expect, it } from 'vitest';
import {
  envelopeFromUnknown,
  FAILURE_CODES,
  makeFailure,
  sanitizeEvidence,
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

  it('strips model names, provider and token value forms from user-facing text', () => {
    expect(sanitizeUserFacingText('Gemini provider timeout')).toBe(
      '操作失败，请稍后重试或按提示补全资料',
    );
    expect(sanitizeUserFacingText('claude 上游连接失败')).toBe(
      '操作失败，请稍后重试或按提示补全资料',
    );
    expect(sanitizeUserFacingText('GLM 请求被拒')).toBe('操作失败，请稍后重试或按提示补全资料');
    expect(sanitizeUserFacingText('solov endpoint unavailable')).toBe(
      '操作失败，请稍后重试或按提示补全资料',
    );
    expect(sanitizeUserFacingText('deepseek qwen doubao ernie 均不可用')).toBe(
      '操作失败，请稍后重试或按提示补全资料',
    );
    expect(sanitizeUserFacingText('token=abc123')).toBe('操作失败，请稍后重试或按提示补全资料');
    expect(sanitizeUserFacingText('Authorization: Bearer sk-abc123def')).toBe(
      '操作失败，请稍后重试或按提示补全资料',
    );
    expect(sanitizeUserFacingText('provider secret missing')).toBe(
      '操作失败，请稍后重试或按提示补全资料',
    );
  });

  it('keeps normal business text, including the word token without a value form', () => {
    expect(sanitizeUserFacingText('token 预算超限，请缩减上下文')).toBe(
      'token 预算超限，请缩减上下文',
    );
    expect(sanitizeUserFacingText('字'.repeat(500))).toHaveLength(400);
    expect(sanitizeUserFacingText('   ')).toBe('操作失败，请稍后重试');
  });

  it('sanitizes evidence containing sensitive internals and passes through normal evidence', () => {
    expect(sanitizeEvidence({ upstream: 'gemini timeout' })).toEqual({ omitted: 'sensitive' });
    expect(sanitizeEvidence({ detail: 'Authorization Bearer x' })).toEqual({
      omitted: 'sensitive',
    });
    expect(sanitizeEvidence({ provider: 'glm' })).toEqual({ omitted: 'sensitive' });
    expect(sanitizeEvidence({ chaptersTouched: [3] })).toEqual({ chaptersTouched: [3] });
    expect(sanitizeEvidence(undefined)).toBeUndefined();
  });

  it('makeFailure sanitizes reason and evidence end to end', () => {
    const envelope = makeFailure({
      stage: 'assistant.planner',
      gate: 'planner_schema',
      code: FAILURE_CODES.plannerFailed,
      severity: 'recoverable',
      reason: 'glm provider timeout, token=sk-xyz',
      evidence: { raw: 'stack at /srv/app.ts' },
      recoverable: true,
    });
    expect(envelope.reason).toBe('操作失败，请稍后重试或按提示补全资料');
    expect(envelope.evidence).toEqual({ omitted: 'sensitive' });
  });
});
