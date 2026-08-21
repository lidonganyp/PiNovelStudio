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
export interface AssistantArtifacts {
  outlineSaved?: boolean;
  charactersSaved?: number;
  chaptersTouched?: number[];
  generationJobId?: string;
  focusTab?: 'outline' | 'characters' | 'chapter' | 'seed';
}

export type AssistantStreamEvent =
  | { delta: string }
  | { error: string }
  | {
      done: true;
      message: AssistantMessage;
      generationJobId?: string;
      artifacts?: AssistantArtifacts;
    };

export function listMessages(projectId: number): Promise<AssistantMessage[]> {
  return http
    .get(`/projects/${projectId}/assistant/messages`)
    .then((r) => r.data);
}

/** 新建对话：软删除当前项目全部消息（规划上下文从零开始）。 */
export function clearMessages(
  projectId: number,
): Promise<{ cleared: number }> {
  return http
    .delete(`/projects/${projectId}/assistant/messages`)
    .then((r) => r.data);
}

export function deleteMessage(
  projectId: number,
  messageId: number,
): Promise<{ ok: true }> {
  return http
    .delete(`/projects/${projectId}/assistant/messages/${messageId}`)
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
  let completed = false;
  let streamError: string | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf('\n\n');
    while (separator >= 0) {
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf('\n\n');
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6)) as AssistantStreamEvent;
          if ('error' in event) streamError = event.error;
          if ('done' in event) completed = true;
          onEvent(event);
        } catch {
          /* 跳过无法解析的行 */
        }
      }
    }
  }
  if (streamError) throw new Error(streamError);
  if (!completed) throw new Error('规划模型连接中断，请重试');
}
