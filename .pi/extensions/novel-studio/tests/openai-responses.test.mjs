/** Responses transport contract tests with local HTTP-shaped fixtures. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callOpenAIResponses } from '../dist/api/openai-responses.js';
import { createRoutedChatAPI } from '../dist/api/routed-chat.js';
import { createOpenAIChatCompletionsFn } from '../dist/v2/governance/chapter-proxy-approval-caller.js';
import { getProviderDefaultConfig } from '../dist/utils/config.js';

const completed = {
  id: 'resp-test', model: 'gpt-6-astra', status: 'completed',
  output: [
    { type: 'reasoning', summary: [{ text: 'private reasoning' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '连接正常。' }] },
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 4 } },
};

test('Responses preserves context, JSON format, text and usage without exposing reasoning', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://example.com/v1/responses');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-6-astra');
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 200);
    assert.deepEqual(body.text, { format: { type: 'json_object' } });
    assert.equal(body.input[0].role, 'system');
    assert.equal(body.messages, undefined);
    assert.equal(body.temperature, undefined);
    return Response.json(completed);
  });
  const response = await callOpenAIResponses('https://example.com/v1/', 'test', 'gpt-6-astra', [{ role: 'system', content: 'Return JSON' }], { max_tokens: 200, jsonMode: true });
  assert.equal(response.choices[0].message.content, '连接正常。');
  assert.equal(response.usage.prompt_tokens, 10);
  assert.equal(response.usage.prompt_tokens_details.cached_tokens, 4);
});

for (const payload of [
  { ...completed, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
  { ...completed, status: 'failed', error: { message: 'server failed' } },
  { ...completed, output: [{ type: 'reasoning' }] },
  { ...completed, output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'refused' }] }] },
]) {
  test(`Responses rejects non-deliverable output: ${JSON.stringify(payload.output)} ${payload.status}`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    await assert.rejects(callOpenAIResponses('https://example.com/v1', 'test', 'gpt-6-astra', []));
  });
}

test('Responses timeout includes stalled body consumption', async (context) => {
  let signal;
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  });
  await assert.rejects(callOpenAIResponses('https://example.com/v1', 'test', 'gpt-6-astra', [], { timeoutMs: 20 }), /timed out/);
  assert.equal(signal.aborted, true);
});

test('JSON mode survives Chinese prompt localization', async (context) => {
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.match(JSON.stringify(JSON.parse(init.body).input), /JSON/);
    return Response.json(completed);
  });
  await callOpenAIResponses('https://example.com/v1', 'test', 'gpt-6-astra', [{ role: 'user', content: '返回对象。' }], { jsonMode: true });
});

test('structured GPT routes use Responses through the configured production client', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(String(url), /\/responses$/);
    assert.equal(JSON.parse(init.body).model, 'gpt-5.5');
    return Response.json({ ...completed, model: 'gpt-5.5' });
  });
  const previousKey = process.env.GPT_API_KEY;
  const previousModel = process.env.GPT_MODEL;
  process.env.GPT_MODEL = 'gpt-5.5';
  process.env.GPT_API_KEY = 'test';
  try {
    const api = await createRoutedChatAPI('architect');
    assert.equal(await api.complete('检查接口。', '回复状态。'), '连接正常。');
  } finally {
    if (previousModel === undefined) delete process.env.GPT_MODEL;
    else process.env.GPT_MODEL = previousModel;
    if (previousKey === undefined) delete process.env.GPT_API_KEY;
    else process.env.GPT_API_KEY = previousKey;
  }
});

test('approval client uses configured transport while preserving reviewer identity', async (context) => {
  const config = getProviderDefaultConfig('gpt');
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(String(url), /\/responses$/);
    assert.equal(JSON.parse(init.body).model, 'gpt-5.6-sol');
    return Response.json({ ...completed, model: 'gpt-5.6-sol' });
  });
  const caller = createOpenAIChatCompletionsFn({ apiKey: 'test', apiBaseUrl: config.base_url, modelId: 'gpt-5.6-sol' });
  const result = await caller([{ role: 'user', content: '返回状态对象。' }], { responseFormat: 'json_object' });
  assert.equal(result.model, 'gpt-5.6-sol');
});
