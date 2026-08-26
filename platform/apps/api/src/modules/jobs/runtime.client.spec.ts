import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobFailureError } from './job-failure';
import { RuntimeClient } from './runtime.client';

describe('RuntimeClient request boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aborts a runtime request that exceeds the configured timeout', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new RuntimeClient();
    (client as never as { requestTimeoutMs: number }).requestTimeoutMs = 10;

    await expect(client.invoke('task-token', 'novel_generate_chapter', {}))
      .rejects.toThrow('runtime invoke timed out');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('maps an unreachable runtime to a Chinese operator-facing error', async () => {
    const fetchFailed = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3100'), {
        code: 'ECONNREFUSED',
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(fetchFailed),
    );
    const client = new RuntimeClient();
    await expect(client.invoke('task-token', 'novel_generate_chapter', {})).rejects.toThrow(
      /无法连接章节生成运行时/,
    );
  });

  it('retries a transient connection failure before reporting the runtime as unreachable', async () => {
    const fetchFailed = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3100'), {
        code: 'ECONNREFUSED',
      }),
    });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(fetchFailed)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'ok',
          result: { status: 'ok', text: 'generated' },
          metering: { modelCallCount: 1 },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const client = new RuntimeClient();
    (client as never as { retryDelayMs: number }).retryDelayMs = 0;

    await expect(client.invoke('task-token', 'novel_generate_chapter', {})).resolves.toMatchObject({
      status: 'ok',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a 422 failureEnvelope instead of collapsing seed_readiness into generation_failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({
          code: 'CHAPTER_NOT_DELIVERABLE',
          message: '【生成前预检】✗ 阻断（耗时 15ms）',
          status: 'blocked',
          failureEnvelope: {
            stage: 'preflight',
            gate: 'seed_readiness',
            reason: '【生成前预检】✗ 阻断 [seed_readiness] ChapterSeed 种子可生长性不足（score=70/100, status=blocked）',
            evidence: { check: 'seed_readiness' },
            recoverable: false,
            fixInstructions: ['补充前章承接'],
          },
        }),
      }),
    );
    const client = new RuntimeClient();
    await expect(client.invoke('task-token', 'novel_generate_chapter', {})).rejects.toBeInstanceOf(
      JobFailureError,
    );
    try {
      await client.invoke('task-token', 'novel_generate_chapter', {});
      throw new Error('expected JobFailureError');
    } catch (error) {
      expect(error).toBeInstanceOf(JobFailureError);
      const envelope = (error as JobFailureError).envelope;
      expect(envelope.code).toBe('runtime_preflight_failed');
      expect(envelope.gate).toBe('seed_readiness');
      expect(envelope.stage).toBe('preflight');
      expect(envelope.reason).toContain('seed_readiness');
      expect(envelope.fixInstructions).toEqual(['补充前章承接']);
    }
  });
});
