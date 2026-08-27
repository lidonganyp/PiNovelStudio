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
  metadata?: { steward?: StewardView; artifacts?: AssistantArtifacts };
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

export interface TargetWordRange {
  min: number;
  max: number;
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
  continuationMode?: 'replace' | 'append';
  targetWordCount?: TargetWordRange;
}

export interface AssistantRequest {
  content: string;
  /** 缺省 = auto 模式：动作由助手智能体根据消息内容判断。 */
  action?: AssistantAction;
  chapterNumber?: number;
  confirmGeneration?: boolean;
  continuationMode?: 'replace' | 'append';
  /** 本次章节正文的软目标；运行时可在保证内容完整的前提下合理浮动。 */
  targetWordCount?: TargetWordRange;
  stewardAction?: 'apply_and_generate' | 'save_draft' | 'cancel' | 'revise';
  proposalId?: string;
  sourceVersion?: string;
  confirmedFields?: string[];
  proposalEdits?: Array<{ field: string; value: string }>;
}

const CHAPTER_NUMBER_SOURCE = '[0-9一二两三四五六七八九十百千零〇]+';
const CHAPTER_WRITE_ACTION_SOURCE = '生成|续写|继续写|接着写|完善|补写|补满|扩写|重写|改写|重新写|推倒重写|写完|完成';
const CHAPTER_COMMAND_RE = new RegExp(
  `(?:${CHAPTER_WRITE_ACTION_SOURCE})[^\\n]{0,24}第\\s*(${CHAPTER_NUMBER_SOURCE})\\s*章|第\\s*(${CHAPTER_NUMBER_SOURCE})\\s*章[^\\n]{0,24}(?:${CHAPTER_WRITE_ACTION_SOURCE})`,
  'u',
);
const FAILURE_QUERY_RE = /(?:失败|报错|错误|为什么|原因|怎么回事|状态|进度|是否成功)/u;
const APPEND_INTENT_RE = /(?:接着|续写|继续写|接着写|补写|补满|补到|完善|扩写|保留已有|不要重写|不要覆盖)/u;
const REPLACE_INTENT_RE = /(?:推倒重写|重新生成|重新写|从头写|覆盖重写|全部重写|重写|改写)/u;

/**
 * Convert an unambiguous natural-language chapter command into the explicit
 * assistant protocol. Ambiguous project questions remain untouched.
 */
export function prepareAssistantRequest(input: AssistantRequest): AssistantRequest {
  if (input.stewardAction || input.action) return input;
  const content = input.content.trim();
  const match = content.match(CHAPTER_COMMAND_RE);
  if (!match || FAILURE_QUERY_RE.test(content)) return input;
  const chapterNumber = parseChapterNumber(match[1] ?? match[2] ?? '');
  if (!chapterNumber) return input;
  const target = parseTargetWordCount(content);
  const inferredContinuation = APPEND_INTENT_RE.test(content)
    ? 'append'
    : REPLACE_INTENT_RE.test(content)
      ? 'replace'
      : undefined;
  return {
    ...input,
    action: 'generate_chapter',
    chapterNumber,
    confirmGeneration: true,
    ...(input.continuationMode || inferredContinuation
      ? { continuationMode: input.continuationMode ?? inferredContinuation }
      : {}),
    ...(input.targetWordCount || target
      ? { targetWordCount: input.targetWordCount ?? target }
      : {}),
  };
}

function parseTargetWordCount(content: string): { min: number; max: number } | undefined {
  const match = content.match(/([1-9][0-9]{2,5})\s*(?:个)?字/u);
  if (!match) return undefined;
  const min = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(min)) return undefined;
  return { min, max: Math.ceil((min * 11) / 10) };
}

function parseChapterNumber(raw: string): number | undefined {
  if (/^[0-9]+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let current = 0;
  for (const char of raw) {
    if (char in digits) {
      current = digits[char];
      continue;
    }
    const unit = units[char];
    if (!unit) return undefined;
    total += (current || 1) * unit;
    current = 0;
  }
  const value = total + current;
  return value > 0 ? value : undefined;
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
    continuationMode: steward.continuationMode,
    targetWordCount: steward.targetWordCount,
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
        profile?: string;
        totalTokenBudget: number;
        totalTokensUsed: number;
        estimatedInputTokens?: number;
        actualInputTokens?: number;
        actualOutputTokens?: number;
        truncatedBlocks?: string[];
        retrievalCoverage?: Record<string, unknown>;
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

/** 内部信息泄漏特征：provider/模型名/密钥/堆栈形态一律替换为通用文案。 */
const SENSITIVE_RE =
  /stack|api[_-]?key|authorization|postgres|mongodb|econnrefused|aimagichub|openai|anthropic|solov|gemini|claude|\bglm\b|deepseek|qwen|doubao|ernie|provider|secret|token\s*[=:]|bearer\s+[a-z0-9.-]+|sk-[a-z0-9]+|at\s+\S+\s+\(/i;

export function userFacingFailure(failure: FailureEnvelope | string): string {
  const text = typeof failure === 'string' ? failure : failure.reason;
  if (SENSITIVE_RE.test(text)) {
    return '操作失败，请稍后重试或按提示补全资料';
  }
  return text;
}

/** Best-effort browser-only diagnostics. Server failure events are already
 * persisted by the API and must not be submitted a second time here. */
export async function reportClientError(
  jobId: string | undefined,
  input: {
    code: string;
    stage: string;
    message: string;
    stack?: string;
    lastEventType?: string;
    requestId?: string;
    traceId?: string;
    diagnostic?: Record<string, unknown>;
  },
  projectId?: number,
): Promise<void> {
  if (!jobId && projectId === undefined) return;
  const token = tokenStorage.get();
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const endpoint = jobId
      ? `/api/jobs/${encodeURIComponent(jobId)}/client-errors`
      : `/api/projects/${projectId}/client-errors`;
    await fetch(endpoint, {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ...input, clientEventId: randomId }),
    });
  } catch {
    // Error reporting must never block retry or alter the user workflow.
  }
}

/**
 * 发送消息并流式消费 SSE 响应。
 * 每个事件回调一次；连接失败抛错由调用方处理。
 */
export async function sendMessageStream(
  projectId: number,
  request: AssistantRequest,
  onEvent: (event: AssistantStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = tokenStorage.get();
  let response: Response;
  try {
    response = await fetch(
      `/api/projects/${projectId}/assistant/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(request),
        signal,
      },
    );
  } catch (error: unknown) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      await reportClientError(undefined, {
        code: 'assistant_request_failed',
        stage: 'assistant.http',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }, projectId);
    }
    throw error;
  }
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
    await reportClientError(undefined, {
      code: 'assistant_http_error',
      stage: 'assistant.http',
      message,
    }, projectId);
    throw new Error(userFacingFailure(message));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  let streamError: string | null = null;
  let lastJobId: string | undefined;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error: unknown) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        await reportClientError(lastJobId, {
          code: 'sse_interrupted',
          stage: 'assistant.sse',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          lastEventType: completed ? 'done' : 'stream',
        }, projectId);
      }
      throw error;
    }
    const { done, value } = chunk;
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
            lastJobId = event.jobId;
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
        } catch (error: unknown) {
          await reportClientError(lastJobId, {
            code: 'sse_event_parse_failed',
            stage: 'assistant.sse',
            message: error instanceof Error ? error.message : 'SSE event parse failed',
            stack: error instanceof Error ? error.stack : undefined,
            lastEventType: 'event_parse',
          }, projectId);
          /* 跳过无法解析的行 */
        }
      }
    }
  }
  if (streamError) throw new Error(streamError);
  if (!completed) {
    const error = new Error('规划模型连接中断，请重试');
    await reportClientError(lastJobId, {
      code: 'sse_incomplete',
      stage: 'assistant.sse',
      message: error.message,
      stack: error.stack,
      lastEventType: 'stream_end',
    }, projectId);
    throw error;
  }
}
