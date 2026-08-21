import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
