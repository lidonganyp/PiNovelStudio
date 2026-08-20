/**
 * 助手规划模型 HTTP 适配器：OpenAI 兼容 chat/completions 直连，不经 novel-runtime。
 */
export interface PlannerChatInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  userContent: string;
  timeoutMs: number;
}

export interface PlannerChatResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export async function completePlannerChat(
  input: PlannerChatInput,
  fetcher: typeof fetch = fetch,
): Promise<PlannerChatResult> {
  const base = input.baseUrl.replace(/\/$/, '');
  const url = `${base}/chat/completions`;
  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        {
          role: 'system',
          content:
            '你是中文长篇小说的规划助手。只给剧情方向、章功能、人物动机与边界，不直接撰写章节正文。',
        },
        { role: 'user', content: input.userContent },
      ],
    }),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `planner ${response.status}: ${detail.slice(0, 300) || response.statusText}`,
    );
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('planner returned empty content');
  }
  const tokensIn =
    typeof body.usage?.prompt_tokens === 'number' && body.usage.prompt_tokens >= 0
      ? body.usage.prompt_tokens
      : Math.max(1, input.userContent.length);
  const tokensOut =
    typeof body.usage?.completion_tokens === 'number' &&
    body.usage.completion_tokens >= 0
      ? body.usage.completion_tokens
      : Math.max(1, text.length);
  return { text, tokensIn, tokensOut };
}
