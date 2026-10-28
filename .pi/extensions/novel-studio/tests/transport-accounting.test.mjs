/** Physical HTTP attempts require admission and authoritative JSON/SSE usage. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchWithTimeout, runWithModelTransportHooks } from '../dist/api/request-timeout.js';
import { runWithTransportRoute, runWithTransportRecovery } from '../dist/api/transport-scope.js';

const request = () => fetchWithTimeout('https://fixture.invalid/v1/chat/completions', {
  method: 'POST', body: JSON.stringify({ model: 'fixture', max_tokens: 50 }),
}, { label: 'transport', timeoutMs: 100 });
const run = (hooks, fn = request) => runWithModelTransportHooks(hooks, () => runWithTransportRoute('v2_amplified_gemini31', fn));

test('budget denial occurs before any provider request', async () => {
  const original = globalThis.fetch;
  let requests = 0; let settlements = 0;
  globalThis.fetch = async () => { requests++; return new Response('{}'); };
  try {
    await assert.rejects(run({ reserve: async () => { throw new Error('budget exhausted'); }, settle: async () => { settlements++; } }), /budget/);
    assert.equal(requests, 0); assert.equal(settlements, 0);
  } finally { globalThis.fetch = original; }
});

test('every physical attempt gets its own reservation and exact JSON/SSE usage', async () => {
  const original = globalThis.fetch;
  const reserved = []; const settled = [];
  const replies = [JSON.stringify({ usage: { prompt_tokens: 20, completion_tokens: 3 } }),
    'data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":21,"completion_tokens":4}}\n\ndata: [DONE]\n'];
  globalThis.fetch = async () => new Response(replies.shift());
  try {
    await run({ reserve: async (v) => { reserved.push(v); }, settle: async (v) => { settled.push(v); } }, async () => { await request(); await request(); });
    assert.equal(new Set(reserved.map((v) => v.callId)).size, 2);
    assert.deepEqual(settled.map(({tokensIn, tokensOut, status}) => ({tokensIn, tokensOut, status})), [
      {tokensIn:20,tokensOut:3,status:200}, {tokensIn:21,tokensOut:4,status:200}]);
    assert.ok(reserved.every((v) => v.outputTokenLimit === 50 && v.route === 'v2_amplified_gemini31'));
  } finally { globalThis.fetch = original; }
});

test('a success without usage is blocked and recorded as unknown once', async () => {
  const original = globalThis.fetch; const settlements = [];
  globalThis.fetch = async () => new Response('{"choices":[]}');
  try {
    await assert.rejects(run({ reserve: async () => {}, settle: async (v) => { settlements.push(v); } }), /no authoritative/);
    assert.equal(settlements.length, 1); assert.equal(settlements[0].tokensIn, undefined);
  } finally { globalThis.fetch = original; }
});

test('semantic recovery is carried to every HTTP admission even after a successful response', async () => {
  const original = globalThis.fetch; const reserved = [];
  globalThis.fetch = async () => new Response('{"usage":{"prompt_tokens":1,"completion_tokens":1}}');
  try {
    const hooks = { reserve: async (value) => reserved.push(value), settle: async () => {} };
    await runWithTransportRecovery(true, () => run(hooks));
    await run(hooks);
    assert.deepEqual(reserved.map(value => value.recovery), [true, undefined]);
  } finally { globalThis.fetch = original; }
});
