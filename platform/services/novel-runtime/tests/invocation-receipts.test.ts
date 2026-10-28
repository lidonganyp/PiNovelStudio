/** Durable receipts distinguish in-flight, completed and interrupted model work. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvocationReceipts } from '../src/invocation-receipts.js';

test('receipts reuse the result across restart and reject a reused job with different materials', () => {
  const root = mkdtempSync(join(tmpdir(), 'invocation-receipts-'));
  try {
    const store = new InvocationReceipts(root);
    assert.equal(store.begin('job-1', 'hash-1').state, 'new');
    assert.equal(store.begin('job-1', 'hash-1').state, 'running');
    store.complete('job-1', 'hash-1', 200, { result: 'transport-placeholder' });
    assert.deepEqual(new InvocationReceipts(root).begin('job-1', 'hash-1'), {
      state: 'completed', status: 200, body: { result: 'transport-placeholder' },
    });
    assert.throws(() => store.begin('job-1', 'other-hash'), /different invocation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unfinished receipt from a prior process does not authorize another model invocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'invocation-interrupted-'));
  try {
    new InvocationReceipts(root).begin('job-2', 'hash-2');
    assert.equal(new InvocationReceipts(root).begin('job-2', 'hash-2').state, 'interrupted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
