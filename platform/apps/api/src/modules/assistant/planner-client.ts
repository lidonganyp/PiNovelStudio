/**
 * 助手规划模型 HTTP 适配器：OpenAI 兼容 chat/completions 直连，不经 novel-runtime。
 */
export interface PlannerChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PlannerChatInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: PlannerChatMessage[];
  timeoutMs: number;
  onDelta?: (delta: string) => void;
}

export interface PlannerChatResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

/** OpenAI 兼容网关：补齐 /v1/chat/completions。 */
export function plannerChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

export function plannerUserFacingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted|timeout|TimeoutError/i.test(message)) {
    return '规划模型响应超时，请稍后重试；生成大纲可以先写一章结构再展开';
  }
  if (/planner 401|planner 403/.test(message)) {
    return '规划模型凭证无效，请在管理后台检查 Provider 密钥';
  }
  if (/planner 429/.test(message)) {
    return '规划模型繁忙，请稍后再试';
  }
  if (/empty content/.test(message)) {
    return '规划模型返回空内容，请换一种问法再试';
  }
  return '规划模型调用失败，请稍后重试';
}

async function postPlanner(
  url: string,
  input: PlannerChatInput,
  fetcher: typeof fetch,
  stream: boolean,
): Promise<Response> {
  return fetcher(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      stream,
    }),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
}

function isAbortTimeout(error: unknown): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /aborted due to timeout|The operation was aborted/i.test(message);
}

export async function completePlannerChat(
  input: PlannerChatInput,
  fetcher: typeof fetch = fetch,
): Promise<PlannerChatResult> {
  if (input.messages.length === 0) {
    throw new Error('planner messages cannot be empty');
  }
  const url = plannerChatCompletionsUrl(input.baseUrl);
  let response: Response;
  try {
    response = await postPlanner(url, input, fetcher, true);
    if (!response.ok && (response.status === 400 || response.status === 415 || response.status === 422)) {
      response = await postPlanner(url, input, fetcher, false);
    }
  } catch (error: unknown) {
    if (isAbortTimeout(error)) {
      throw new Error('planner timeout');
    }
    throw error;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `planner ${response.status}: ${detail.slice(0, 300) || response.statusText}`,
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
    return readPlannerJson(response, input);
  }
  return readPlannerStream(response, input);
}

async function readPlannerJson(
  response: Response,
  input: PlannerChatInput,
): Promise<PlannerChatResult> {
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('planner returned empty content');
  }
  input.onDelta?.(text);
  return {
    text,
    tokensIn: readTokenCount(body.usage?.prompt_tokens, input.messages),
    tokensOut: readTokenCount(body.usage?.completion_tokens, text.length),
  };
}

export async function readPlannerStream(
  response: Response,
  input: Pick<PlannerChatInput, 'messages' | 'onDelta'>,
): Promise<PlannerChatResult> {
  if (!response.body) {
    throw new Error('planner stream has no body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = parseSseDataLine(line);
      if (!parsed) continue;
      if (typeof parsed.delta === 'string' && parsed.delta) {
        text += parsed.delta;
        input.onDelta?.(parsed.delta);
      }
      if (parsed.tokensIn !== undefined) tokensIn = parsed.tokensIn;
      if (parsed.tokensOut !== undefined) tokensOut = parsed.tokensOut;
    }
  }
  if (!text.trim()) {
    throw new Error('planner returned empty content');
  }
  return {
    text,
    tokensIn: tokensIn > 0 ? tokensIn : readTokenCount(undefined, input.messages),
    tokensOut: tokensOut > 0 ? tokensOut : Math.max(1, text.length),
  };
}

export function parseSseDataLine(line: string): {
  delta?: string;
  tokensIn?: number;
  tokensOut?: number;
} | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    const json = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const delta = json.choices?.[0]?.delta?.content;
    const full = json.choices?.[0]?.message?.content;
    return {
      delta: typeof delta === 'string'
        ? delta
        : typeof full === 'string'
          ? full
          : undefined,
      tokensIn: typeof json.usage?.prompt_tokens === 'number' ? json.usage.prompt_tokens : undefined,
      tokensOut: typeof json.usage?.completion_tokens === 'number' ? json.usage.completion_tokens : undefined,
    };
  } catch {
    return null;
  }
}

function readTokenCount(value: unknown, fallback: PlannerChatMessage[] | number): number {
  if (typeof value === 'number' && value >= 0) return value;
  if (typeof fallback === 'number') return Math.max(1, fallback);
  const chars = fallback.map((item) => item.content).join('').length;
  return Math.max(1, chars);
}
