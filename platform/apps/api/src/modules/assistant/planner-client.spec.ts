/**
 * 规划模型 HTTP 适配器：解析 chat/completions 正文与 token 用量。
 */
import { describe, expect, it } from 'vitest';
import { completePlannerChat } from './planner-client';

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
        userContent: '帮我规划',
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
          userContent: '帮我规划',
          timeoutMs: 1000,
        },
        fetcher,
      ),
    ).rejects.toThrow(/empty content/);
  });
});
