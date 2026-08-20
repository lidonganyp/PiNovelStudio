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
});
