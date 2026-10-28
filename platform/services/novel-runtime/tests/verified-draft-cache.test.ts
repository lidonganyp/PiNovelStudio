/** Checkpoints survive a new job and runtime instance without crossing tenant/chapter boundaries. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerifiedDraftCache } from '../src/verified-draft-cache.js';

test('latest verified draft crosses job boundaries but never tenants or chapters', () => {
  const root = mkdtempSync(join(tmpdir(), 'draft-cache-'));
  const result = { verifierCleared: true, candidate: { text: 'transport-fixture' } };
  const payload = JSON.stringify({ schema: 1, binding: 'materials-and-model', result, resultHash: createHash('sha256').update(JSON.stringify(result)).digest('hex') });
  const path = (job: string, chapter = '1'): string => join(root, job, 'workspaces', 'p1', 'traces', `${chapter}-verified-agentic-draft.json`);
  try {
    mkdirSync(join(root, 'job-a', 'workspaces', 'p1', 'traces'), { recursive: true });
    writeFileSync(path('job-a'), payload);
    new VerifiedDraftCache(join(root, 'cache')).bind({ userId: '1', projectId: '1' }, '1', join(root, 'job-a'), 'p1').persist();
    const next = new VerifiedDraftCache(join(root, 'cache'));
    next.bind({ userId: '1', projectId: '1' }, '1', join(root, 'job-b'), 'p1').restore();
    assert.deepEqual(JSON.parse(readFileSync(path('job-b'), 'utf8')).result, result);
    next.bind({ userId: '1', projectId: '1' }, '1', join(root, 'changed-materials'), 'p1', { changed:'author-outline' }).restore();
    assert.equal(existsSync(path('changed-materials')), false);
    next.bind({ userId: '2', projectId: '1' }, '1', join(root, 'other-tenant'), 'p1').restore();
    next.bind({ userId: '1', projectId: '1' }, '2', join(root, 'other-chapter'), 'p1').restore();
    assert.equal(existsSync(path('other-tenant')), false);
    assert.equal(existsSync(path('other-chapter', '2')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
