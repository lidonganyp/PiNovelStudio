/** Resume identity follows author/model materials, never ephemeral job locations or JSON key ordering. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildVerifiedDraftBinding } from '../dist/v2/core/verified-draft-checkpoint.js';

test('a new job path reuses the same materials while changed facts/style/model invalidate it', () => {
  const make = (root) => ({ context: { facts: [{ text: 'author-fact' }], sourceMap: [{ sourceId: 'style', sourceType: 'style', path: join(root, 'workspaces/p1/styles/profile.md') }], styleReferences: [{ text:'author-style' }] }, writer: { model:'fixture', baseUrl:'https://fixture.invalid' } });
  const first = make(join(process.cwd(), 'job-a')); const second = make(join(process.cwd(), 'job-b'));
  const binding = buildVerifiedDraftBinding(first, join(process.cwd(), 'job-a'));
  assert.equal(buildVerifiedDraftBinding(second, join(process.cwd(), 'job-b')), binding);
  assert.notEqual(buildVerifiedDraftBinding({ ...second, writer:{model:'changed',baseUrl:'https://fixture.invalid'} }, join(process.cwd(),'job-b')), binding);
  assert.notEqual(buildVerifiedDraftBinding({ ...second, context:{...second.context, facts:[{text:'changed-fact'}]} }, join(process.cwd(),'job-b')), binding);
  assert.notEqual(buildVerifiedDraftBinding({ ...second, context:{...second.context, styleReferences:[{text:'changed-style'}]} }, join(process.cwd(),'job-b')), binding);
});
