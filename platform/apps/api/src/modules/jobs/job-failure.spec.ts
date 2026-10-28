import { describe, expect, it } from 'vitest';
import { ContextCompileError, FAILURE_CODES, makeFailure } from '../context/failure-envelope';
import { jobFailureFromUnknown, readStoredFailure, runtimeInvokeFailure } from './job-failure';

describe('job failure envelope', () => {
  it.each([502, 503, 504])('explains exhausted model HTTP %s failures without losing the cause during redaction', (status) => {
    const failure = runtimeInvokeFailure({
      status: 'blocked',
      traceArchivePath: '/archive/isolated-test',
      failureEnvelope: {
        stage: 'novelos_agentic_generation',
        gate: 'agentic_generation',
        reason: `NovelOS Agentic 未产出初稿候选: All providers failed for gemini31. API call failed (${status}): Service temporarily unavailable`,
      },
    }, 5).envelope;
    expect(failure.code).toBe('generation_model_unavailable');
    expect(failure.stage).toBe('novelos_agentic_generation');
    expect(failure.gate).toBe('agentic_generation');
    expect(failure.reason).toContain('模型服务暂时不可用');
    expect(failure.reason).not.toMatch(/provider|gemini|补全资料/i);
    expect(failure.severity).toBe('recoverable');
    expect(failure.retryPlan).toBe('retry_later');
    expect(failure.traceArchivePath).toBe('/archive/isolated-test');
  });

  it('keeps style transport failures distinct from story-preservation failures', () => {
    const transport = runtimeInvokeFailure({
      status: 'blocked',
      failureEnvelope: { stage: 'style_optimization_no_candidate', gate: 'style_optimization', reason: '模型优化失败: API call failed (503): gemini unavailable' },
    }, 2).envelope;
    expect(transport.code).toBe('generation_model_unavailable');
    expect(transport.stage).toBe('style_optimization_no_candidate');
    const story = runtimeInvokeFailure({
      status: 'blocked',
      failureEnvelope: { stage: 'story_preservation_drift_retry_failed', gate: 'story_preservation', reason: '关键事件改变。正文包含 API call failed (503) 字样。' },
    }, 2).envelope;
    expect(story.code).toBe('generation_failed');
  });

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

  it('preserves the explicit environment fingerprint failure code from runtime', () => {
    const error = runtimeInvokeFailure(
      {
        status: 'blocked',
        failureEnvelope: {
          code: 'environment_fingerprint_mismatch',
          stage: 'g6_release_gate',
          gate: 'runtime',
          reason: 'environment fingerprint mismatch: recorded=old, current=new',
        },
      },
      0,
    );
    expect(error.envelope.code).toBe('environment_fingerprint_mismatch');
    expect(error.envelope.stage).toBe('g6_release_gate');
    expect(error.envelope.gate).toBe('runtime');
    expect(error.envelope.recoverable).toBe(false);
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

  it('reports model timeout before redacting model names and preserves a terminal budget denial', () => {
    const timeout = runtimeInvokeFailure({status:'blocked',failureEnvelope:{stage:'novelos_agentic_generation',gate:'agentic_generation',reason:'OpenAI-compatible:gemini-4-argon timed out after 300000ms',recoverable:true}},2);
    expect(timeout.envelope).toMatchObject({code:'generation_model_timeout',recoverable:true});
    expect(timeout.envelope.reason).toContain('模型服务');
    expect(timeout.envelope.reason).not.toContain('操作失败');
    const budget = runtimeInvokeFailure({status:'blocked',failureEnvelope:{code:'generation_budget_exhausted',stage:'runtime.budget',gate:'budget_exhausted',reason:'budget denied',recoverable:false}},0);
    expect(budget.envelope).toMatchObject({code:'generation_budget_exhausted',recoverable:false});
  });
});
