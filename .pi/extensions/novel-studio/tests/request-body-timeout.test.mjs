/** Transport deadlines include the response body and propagate parent cancellation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout } from '../dist/api/request-timeout.js';

test('headers arriving promptly cannot bypass a stalled response-body deadline', { timeout: 1000 }, async () => {
  const original = globalThis.fetch;
  let signal;
  globalThis.fetch = async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"usage":'));
      init.signal.addEventListener('abort', () => controller.error(new Error('body aborted')), { once: true });
    } }));
  };
  try {
    const started = Date.now();
    await assert.rejects(async () => { const response = await fetchWithTimeout('https://fixture.invalid', {}, { label: 'body', timeoutMs: 30 }); await response.json(); }, /timed out|body aborted/);
    assert.ok(Date.now() - started < 500);
    assert.equal(signal.aborted, true);
  } finally { globalThis.fetch = original; }
});

test('parent abort reaches the provider instead of merely stopping the outer waiter', { timeout: 1000 }, async () => {
  const original = globalThis.fetch;
  const parent = new AbortController();
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(new Error('parent cancelled'));
    else init.signal.addEventListener('abort', () => reject(new Error('parent cancelled')), { once: true });
  });
  try {
    const pending = fetchWithTimeout('https://fixture.invalid', { signal: parent.signal }, { label: 'parent', timeoutMs: 100 });
    parent.abort();
    await assert.rejects(pending, /parent cancelled/);
  } finally { globalThis.fetch = original; }
});
