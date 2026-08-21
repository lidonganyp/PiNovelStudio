/**
 * 规划模型 HTTP 适配器：解析 chat/completions 正文与 token 用量。
 */
import { describe, expect, it } from 'vitest';
import {
  completePlannerChat,
  parseSseDataLine,
  plannerChatCompletionsUrl,
  plannerUserFacingError,
} from './planner-client';

describe('plannerChatCompletionsUrl', () => {
  it('appends /v1/chat/completions when the provider omits the version path', () => {
    expect(plannerChatCompletionsUrl('https://shunfen6.win')).toBe(
      'https://shunfen6.win/v1/chat/completions',
    );
  });

  it('does not duplicate /v1 when the provider already includes it', () => {
    expect(plannerChatCompletionsUrl('https://aimagichub.xyz/v1/')).toBe(
      'https://aimagichub.xyz/v1/chat/completions',
    );
  });
});

describe('completePlannerChat', () => {
  it('reads message content and usage tokens', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '下一章先兑现旧伏笔。' } }],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const result = await completePlannerChat(
      {
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        model: 'gpt-5.6',
        messages: [{ role: 'user', content: '帮我规划' }],
        timeoutMs: 1000,
      },
      fetcher,
    );
    expect(result.text).toContain('伏笔');
    expect(result.tokensIn).toBe(12);
    expect(result.tokensOut).toBe(8);
  });

  it('rejects empty planner content', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
        status: 200,
      });
    await expect(
      completePlannerChat(
        {
          baseUrl: 'https://api.example.test/v1',
          apiKey: 'sk-test',
          model: 'gpt-5.6',
          messages: [{ role: 'user', content: '帮我规划' }],
          timeoutMs: 1000,
        },
        fetcher,
      ),
    ).rejects.toThrow(/empty content/);
  });

  it('concatenates streamed deltas and reports usage from the final chunk', async () => {
    const deltas: string[] = [];
    const fetcher: typeof fetch = async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"下一章"}}]}',
          'data: {"choices":[{"delta":{"content":"先兑现旧伏笔。"}}]}',
          'data: {"usage":{"prompt_tokens":12,"completion_tokens":8}}',
          'data: [DONE]',
          '',
        ].join('\n'),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    const result = await completePlannerChat(
      {
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        model: 'gpt-5.6',
        messages: [{ role: 'user', content: '帮我规划' }],
        timeoutMs: 1000,
        onDelta: (delta) => deltas.push(delta),
      },
      fetcher,
    );
    expect(result.text).toBe('下一章先兑现旧伏笔。');
    expect(deltas.join('')).toBe(result.text);
    expect(result.tokensIn).toBe(12);
    expect(result.tokensOut).toBe(8);
  });
});

describe('parseSseDataLine', () => {
  it('ignores done markers and invalid json', () => {
    expect(parseSseDataLine('data: [DONE]')).toBeNull();
    expect(parseSseDataLine('data: {bad')).toBeNull();
  });
});

describe('plannerUserFacingError', () => {
  it('maps abort timeout to a retryable Chinese message', () => {
    expect(plannerUserFacingError(new Error('planner timeout'))).toContain('超时');
  });
});
