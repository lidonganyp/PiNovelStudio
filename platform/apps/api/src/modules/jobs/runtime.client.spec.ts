/** Regression coverage for long-running runtime HTTP budgets and safe retries. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'undici';
import { JobFailureError } from './job-failure';
import { RuntimeClient } from './runtime.client';

vi.mock('undici', () => ({ request: vi.fn() }));

describe('RuntimeClient request boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('aborts a runtime request that exceeds the configured timeout', async () => {
    const fetchMock = vi.fn((_url: string, init: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );
    vi.mocked(request).mockImplementation(fetchMock as never);
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
    vi.mocked(request).mockRejectedValue(fetchFailed);
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
        statusCode: 200,
        body: {
          json: async () => ({
            status: 'ok',
            result: { status: 'ok', text: 'generated' },
            metering: { modelCallCount: 1 },
          }),
        },
      });
    vi.mocked(request).mockImplementation(fetchMock as never);
    const client = new RuntimeClient();
    (client as never as { retryDelayMs: number }).retryDelayMs = 0;

    await expect(client.invoke('task-token', 'novel_generate_chapter', {})).resolves.toMatchObject({
      status: 'ok',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a 422 failureEnvelope instead of collapsing seed_readiness into generation_failed', async () => {
    vi.mocked(request).mockResolvedValue({
      statusCode: 422,
      body: {
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
      },
    } as never);
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

  it('keeps long generation requests open for the configured header and body budget', async () => {
    vi.mocked(request).mockResolvedValue({
      statusCode: 200,
      body: { json: async () => ({ status: 'ok', result: {} }) },
    } as never);
    const client = new RuntimeClient();
    (client as never as { requestTimeoutMs: number }).requestTimeoutMs = 900_000;
    await client.invoke('task-token', 'novel_generate_chapter', { chapterId: '1' });
    expect(request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headersTimeout: 900_000,
      bodyTimeout: 900_000,
      headers: expect.objectContaining({ 'x-novel-task-token': 'task-token' }),
    }));
  });

  it('retries a direct connection refusal from the HTTP request client', async () => {
    vi.mocked(request)
      .mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce({
        statusCode: 200, body: { json: async () => ({ status: 'ok', result: {} }) },
      } as never);
    const client = new RuntimeClient();
    (client as never as { retryDelayMs: number }).retryDelayMs = 0;
    await expect(client.invoke('task-token', 'novel_generate_chapter', {})).resolves.toMatchObject({ status: 'ok' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not resubmit when a connection drops after dispatch', async () => {
    vi.mocked(request).mockRejectedValue(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }));
    await expect(new RuntimeClient().invoke('task-token', 'novel_generate_chapter', {})).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
});
