/**
 * 助手对话 API：历史消息 + SSE 流式发送。
 * EventSource 不支持 POST/Authorization 头，故用 fetch 流式解析。
 */
import { http, tokenStorage } from './http';

/** 助手消息视图。 */
export interface AssistantMessage {
  id: number;
  role: 'user' | 'assistant' | string;
  content: string;
  createdAt: string;
}

/** SSE 事件：增量文本或完成信号。 */
export type AssistantStreamEvent =
  | { delta: string }
  | { done: true; message: AssistantMessage };

export function listMessages(projectId: number): Promise<AssistantMessage[]> {
  return http
    .get(`/projects/${projectId}/assistant/messages`)
    .then((r) => r.data);
}

/**
 * 发送消息并流式消费 SSE 响应。
 * 每个事件回调一次；连接失败抛错由调用方处理。
 */
export async function sendMessageStream(
  projectId: number,
  content: string,
  onEvent: (event: AssistantStreamEvent) => void,
): Promise<void> {
  const token = tokenStorage.get();
  const response = await fetch(
    `/api/projects/${projectId}/assistant/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ content }),
    },
  );
  if (!response.ok || !response.body) {
    let message = '请求失败';
    try {
      const data = (await response.json()) as { message?: string };
      if (typeof data.message === 'string') message = data.message;
    } catch {
      /* 保留默认文案 */
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 事件以空行分隔；逐块解析已完整的事件
    let separator = buffer.indexOf('\n\n');
    while (separator >= 0) {
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf('\n\n');
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          onEvent(JSON.parse(line.slice(6)) as AssistantStreamEvent);
        } catch {
          /* 跳过无法解析的行 */
        }
      }
    }
  }
}
