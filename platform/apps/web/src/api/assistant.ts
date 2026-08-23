/**
 * 助手对话 API：历史消息 + SSE 流式发送。
 * EventSource 不支持 POST/Authorization 头，故用 fetch 流式解析。
 */
import { http, tokenStorage } from './http';

export type AssistantAction =
  | 'plan_story_outline'
  | 'plan_chapter'
  | 'query_project'
  | 'generate_chapter';

/** 助手消息视图。 */
export interface AssistantMessage {
  id: number;
  role: 'user' | 'assistant' | string;
  content: string;
  createdAt: string;
  metadata?: { steward?: StewardView };
}

export interface AssistantArtifacts {
  outlineSaved?: boolean;
  charactersSaved?: number;
  chaptersTouched?: number[];
  generationJobId?: string;
  focusTab?: 'outline' | 'characters' | 'chapter' | 'seed';
  publicEntry?: 'novel_generate_chapter';
}

export interface FailureEnvelope {
  stage: string;
  gate: string;
  code: string;
  severity: string;
  reason: string;
  recoverable: boolean;
  retryPlan?: string;
  userActionRequired?: string[];
  fixInstructions?: string[];
}

export interface MaterialProposal {
  field: string;
  value: string;
  source: string[];
  requiresConfirmation: boolean;
}

export function materialProposalLabel(field: string): string {
  const labels: Record<string, string> = {
    genre: '作品类型',
    worldbuilding: '世界观',
    creative_constitution: '创作约束',
    style_profile: '写作风格',
    chapter_seed: '本章写作目标',
    character_states: '角色当前状态',
    canon_state: '已确认事实',
    promise_ledger: '未结伏笔与承诺',
  };
  return labels[field] ?? '补充内容';
}

export interface StewardView {
  status: 'ready' | 'auto_fill' | 'confirmation_required' | 'hard_blocked';
  reply: string;
  chapterNumber: number;
  proposalId?: string;
  sourceVersion: string;
  proposals: MaterialProposal[];
  missing: string[];
  generationJobId?: string;
  publicEntry?: 'novel_generate_chapter';
  proposalStatus?: 'pending' | 'applied' | 'cancelled' | 'draft_saved';
  confirmedAt?: string;
  confirmedFields?: string[];
}

export interface AssistantRequest {
  content: string;
  /** 缺省 = auto 模式：动作由助手智能体根据消息内容判断。 */
  action?: AssistantAction;
  chapterNumber?: number;
  confirmGeneration?: boolean;
  stewardAction?: 'apply_and_generate' | 'save_draft' | 'cancel' | 'revise';
  proposalId?: string;
  sourceVersion?: string;
  confirmedFields?: string[];
  proposalEdits?: Array<{ field: string; value: string }>;
}

export function buildStewardRequest(
  steward: StewardView,
  action: 'apply_and_generate' | 'save_draft' | 'cancel',
): AssistantRequest {
  const labels = {
    apply_and_generate: '采用并继续生成',
    save_draft: '仅保存草案',
    cancel: '取消',
  } as const;
  return {
    content: labels[action],
    stewardAction: action,
    proposalId: steward.proposalId,
    sourceVersion: steward.sourceVersion,
    confirmedFields: steward.proposals
      .filter((row) => row.value.trim())
      .map((row) => row.field),
  };
}

export type AssistantStreamEvent =
  | { type: 'delta'; delta: string }
  | { type: 'artifact'; artifacts?: AssistantArtifacts }
  | {
      type: 'job_submitted';
      jobId: string;
      chapterNumber?: number;
      publicEntry: 'novel_generate_chapter';
    }
  | { type: 'steward'; steward: StewardView }
  | { type: 'failure'; failure: FailureEnvelope }
  | {
      type: 'done';
      done: true;
      message: AssistantMessage;
      action?: AssistantAction;
      generationJobId?: string;
      artifacts?: AssistantArtifacts;
      steward?: StewardView;
      contextManifest?: {
        totalTokenBudget: number;
        totalTokensUsed: number;
        blocks: Array<{ name: string; included: boolean; tokensUsed: number; omittedReason?: string }>;
      };
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

export function userFacingFailure(failure: FailureEnvelope | string): string {
  const text = typeof failure === 'string' ? failure : failure.reason;
  if (/stack|api[_-]?key|postgres|aimagichub|openai|anthropic|bearer\s+/i.test(text)) {
    return '操作失败，请稍后重试或按提示补全资料';
  }
  return text;
}

/**
 * 发送消息并流式消费 SSE 响应。
 * 每个事件回调一次；连接失败抛错由调用方处理。
 */
export async function sendMessageStream(
  projectId: number,
  request: AssistantRequest,
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
      body: JSON.stringify(request),
    },
  );
  if (!response.ok || !response.body) {
    let failure: FailureEnvelope | undefined;
    let message = '请求失败';
    try {
      const data = (await response.json()) as {
        message?: string;
        failure?: FailureEnvelope;
      };
      if (data.failure) failure = data.failure;
      if (typeof data.message === 'string') message = data.message;
    } catch {
      /* 保留默认文案 */
    }
    if (failure) {
      onEvent({ type: 'failure', failure });
      throw new Error(userFacingFailure(failure));
    }
    throw new Error(userFacingFailure(message));
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
          const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
          if (event.type === 'delta' && typeof event.delta === 'string') {
            onEvent({ type: 'delta', delta: event.delta });
            continue;
          }
          if (!event.type && typeof event.delta === 'string') {
            onEvent({ type: 'delta', delta: event.delta });
            continue;
          }
          if (event.type === 'failure' || typeof event.error === 'string') {
            const failure = (event.failure as FailureEnvelope | undefined) ?? {
              stage: 'assistant.sse',
              gate: 'stream',
              code: 'sse_interrupted',
              severity: 'recoverable',
              reason: typeof event.error === 'string' ? event.error : '规划连接中断',
              recoverable: true,
            };
            streamError = userFacingFailure(failure);
            onEvent({ type: 'failure', failure });
            continue;
          }
          if (event.type === 'artifact') {
            onEvent({ type: 'artifact', artifacts: event.artifacts as AssistantArtifacts });
            continue;
          }
          if (event.type === 'steward' && event.steward && typeof event.steward === 'object') {
            onEvent({ type: 'steward', steward: event.steward as StewardView });
            continue;
          }
          if (event.type === 'job_submitted' && typeof event.jobId === 'string') {
            onEvent({
              type: 'job_submitted',
              jobId: event.jobId,
              chapterNumber: typeof event.chapterNumber === 'number' ? event.chapterNumber : undefined,
              publicEntry: 'novel_generate_chapter',
            });
            continue;
          }
          if (event.type === 'done' || event.done === true) {
            completed = true;
            onEvent(event as unknown as AssistantStreamEvent);
          }
        } catch {
          /* 跳过无法解析的行 */
        }
      }
    }
  }
  if (streamError) throw new Error(streamError);
  if (!completed) throw new Error('规划模型连接中断，请重试');
}
