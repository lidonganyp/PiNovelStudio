/**
 * Assistant chat state machine. The composable owns UI state only; all
 * persistence and generation authorization remain in the existing API.
 */
import { computed, nextTick, ref, type Ref } from 'vue';
import {
  buildStewardRequest,
  clearMessages,
  deleteMessage,
  listMessages,
  prepareAssistantRequest,
  sendMessageStream,
  userFacingFailure,
  type AssistantArtifacts,
  type AssistantMessage,
  type AssistantRequest,
  type AssistantStreamEvent,
  type FailureEnvelope,
  type StewardView,
} from '../api/assistant';

export interface ContextManifest {
  profile?: string;
  totalTokenBudget: number;
  totalTokensUsed: number;
  estimatedInputTokens?: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  truncatedBlocks?: string[];
  retrievalCoverage?: Record<string, unknown>;
  blocks: Array<{ name: string; included: boolean; tokensUsed: number; omittedReason?: string }>;
}

export interface ChatMessage {
  id: number | string;
  role: 'user' | 'assistant' | string;
  content: string;
  createdAt?: string;
  streaming?: boolean;
  status?: 'streaming' | 'success' | 'failed' | 'cancelled';
  /** 本轮实际发送的请求负载：逐条重试时使用，避免误发其他轮次的内容。 */
  request?: AssistantRequest;
  steward?: StewardView;
  artifacts?: AssistantArtifacts;
  failure?: FailureEnvelope;
  contextManifest?: ContextManifest;
}

export interface AssistantChatOptions {
  projectId: Ref<number> | number;
  trackJob?: (jobId: string) => void;
  reloadMaterials?: (opts?: { tab?: string; chapterNumber?: number }) => Promise<void>;
}

export function useAssistantChat(options: AssistantChatOptions) {
  let localMessageSequence = 0;
  const projectId = computed(() => typeof options.projectId === 'number' ? options.projectId : options.projectId.value);
  const messages = ref<ChatMessage[]>([]);
  const input = ref('');
  const loadingHistory = ref(false);
  const historyError = ref('');
  const sending = ref(false);
  const panelError = ref<FailureEnvelope | null>(null);
  const jobSubmitted = ref<{ jobId: string; chapterNumber?: number } | null>(null);
  const lastPayload = ref<AssistantRequest | null>(null);
  const hasMoreAbove = ref(false);
  const atBottom = ref(true);
  const abortController = ref<AbortController | null>(null);

  function nextLocalMessageId(kind: 'local' | 'stream'): string {
    localMessageSequence += 1;
    return `${kind}-${Date.now()}-${localMessageSequence}`;
  }

  async function load(): Promise<void> {
    loadingHistory.value = true;
    historyError.value = '';
    try {
      const history = await listMessages(projectId.value);
      messages.value = history.map((message: AssistantMessage) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        status: 'success',
        steward: message.metadata?.steward,
        // 后端将落库结果持久化在 metadata.artifacts：刷新页面后大纲/种子/任务卡片据此恢复
        artifacts: message.metadata?.artifacts,
      }));
      const latestProposals = new Map<string, StewardView>();
      for (const message of messages.value) {
        if (message.steward?.proposalId) latestProposals.set(message.steward.proposalId, message.steward);
      }
      for (const steward of latestProposals.values()) syncSteward(steward);
    } catch {
      historyError.value = '聊天历史加载失败，请刷新后重试。';
    } finally {
      loadingHistory.value = false;
    }
  }

  function updateBottomState(element: HTMLElement): void {
    atBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  }

  function scrollBottom(element: HTMLElement | null): void {
    void nextTick(() => {
      if (element) element.scrollTop = element.scrollHeight;
      atBottom.value = true;
    });
  }

  /** A proposal has one current state even when several chat messages reference it. */
  function syncSteward(steward: StewardView): void {
    if (!steward.proposalId) return;
    for (const message of messages.value) {
      if (message.steward?.proposalId === steward.proposalId) message.steward = steward;
    }
  }

  function handleEvent(assistantId: string, event: AssistantStreamEvent, listElement: HTMLElement | null): void {
    const target = messages.value.find((message) => message.id === assistantId);
    if (event.type === 'delta' && target) {
      target.content += event.delta;
      if (atBottom.value) scrollBottom(listElement);
    } else if (event.type === 'steward' && target) {
      target.steward = event.steward;
    } else if (event.type === 'artifact' && target) {
      target.artifacts = event.artifacts;
    } else if (event.type === 'failure') {
      const failure: FailureEnvelope = { ...event.failure, reason: userFacingFailure(event.failure) };
      if (target) {
        target.streaming = false;
        target.status = 'failed';
        target.failure = failure;
        if (failure.gate === 'author_contract') target.content = failure.reason;
      }
      panelError.value = failure;
    } else if (event.type === 'job_submitted') {
      jobSubmitted.value = { jobId: event.jobId, chapterNumber: event.chapterNumber };
      options.trackJob?.(event.jobId);
    } else if (event.type === 'done' && target) {
      target.content = event.message.content;
      target.streaming = false;
      target.status = 'success';
      target.id = event.message.id;
      target.createdAt = event.message.createdAt;
      target.steward = event.steward;
      target.artifacts = event.artifacts;
      if (event.steward) syncSteward(event.steward);
      target.contextManifest = event.contextManifest;
      if (event.generationJobId) options.trackJob?.(event.generationJobId);
      // 仅在资料真正落库（artifacts 非空）或提交生成任务时刷新工作台；
      // 普通查询类回复不打断用户当前的工作台状态。
      const materialChanged =
        Boolean(event.generationJobId) || Boolean(event.artifacts && Object.keys(event.artifacts).length > 0);
      if (materialChanged) {
        void options.reloadMaterials?.({ tab: event.artifacts?.focusTab, chapterNumber: event.artifacts?.chaptersTouched?.[0] });
      }
      scrollBottom(listElement);
    }
  }

  async function send(retry = false, requestOverride?: AssistantRequest, listElement: HTMLElement | null = null): Promise<void> {
    const requestInput = requestOverride ?? (retry ? lastPayload.value : undefined);
    const content = requestInput?.content.trim() ?? input.value.trim();
    if (!content || sending.value) return;
    const request = prepareAssistantRequest(requestInput ?? { content });
    sending.value = true;
    panelError.value = null;
    jobSubmitted.value = null;
    if (!retry) {
      lastPayload.value = request;
      input.value = '';
      messages.value.push({ id: nextLocalMessageId('local'), role: 'user', content, status: 'success' });
    }
    const assistantId = nextLocalMessageId('stream');
    messages.value.push({
      id: assistantId,
      role: 'assistant',
      content: '',
      streaming: true,
      status: 'streaming',
      // 记录本轮请求：失败后逐条重试按此负载重发，与全局 lastPayload 解耦
      request,
    });
    scrollBottom(listElement);
    const controller = new AbortController();
    abortController.value = controller;
    try {
      await sendMessageStream(projectId.value, request, (event) => handleEvent(assistantId, event, listElement), controller.signal);
    } catch (error: unknown) {
      const target = messages.value.find((message) => message.id === assistantId);
      const cancelled = controller.signal.aborted;
      if (!panelError.value && !cancelled) {
        panelError.value = { stage: 'assistant.sse', gate: 'stream', code: 'sse_interrupted', severity: 'recoverable', reason: userFacingFailure(error instanceof Error ? error.message : '网络连接中断'), recoverable: true, retryPlan: 'retry_same_stage' };
      }
      if (target) {
        target.streaming = false;
        target.status = cancelled ? 'cancelled' : 'failed';
        if (!cancelled) target.failure = target.failure ?? panelError.value ?? undefined;
      }
    } finally {
      sending.value = false;
      abortController.value = null;
    }
  }

  /**
   * Recover a chapter request after a streamed/model failure. The API owns the
   * authoritative draft, so the recovery explicitly asks for append mode and
   * never treats a partial assistant status bubble as chapter prose.
   */
  async function continueFromFailure(
    message: ChatMessage | undefined,
    listElement: HTMLElement | null = null,
  ): Promise<void> {
    const original = message?.request;
    if (!original || !isChapterRequest(original.content) || sending.value) return;
    const request: AssistantRequest = {
      ...original,
      content: original.content,
      continuationMode: 'append',
    };
    lastPayload.value = request;
    await send(true, request, listElement);
  }

  function stop(): void {
    abortController.value?.abort();
  }

  function pendingSteward(message: ChatMessage): boolean {
    const steward = message.steward;
    return Boolean(steward?.proposalId && !steward.generationJobId && steward.proposalStatus !== 'cancelled' && steward.proposalStatus !== 'applied' && (steward.status === 'confirmation_required' || steward.status === 'auto_fill' || steward.proposalStatus === 'pending' || steward.proposalStatus === 'draft_saved'));
  }

  async function sendSteward(message: ChatMessage, action: 'apply_and_generate' | 'save_draft' | 'cancel', listElement: HTMLElement | null = null): Promise<void> {
    if (!pendingSteward(message) || !message.steward?.proposalId || sending.value) return;
    const request = buildStewardRequest(message.steward, action);
    lastPayload.value = request;
    await send(true, request, listElement);
  }

  async function clear(): Promise<void> {
    if (sending.value) return;
    await clearMessages(projectId.value);
    messages.value = [];
    panelError.value = null;
    jobSubmitted.value = null;
  }

  async function remove(message: ChatMessage): Promise<void> {
    if (typeof message.id !== 'number') return;
    await deleteMessage(projectId.value, message.id);
    messages.value = messages.value.filter((item) => item.id !== message.id);
  }

  return { messages, input, loadingHistory, historyError, sending, panelError, jobSubmitted, lastPayload, hasMoreAbove, atBottom, load, send, continueFromFailure, stop, clear, remove, sendSteward, pendingSteward, updateBottomState };
}

export function isChapterRequest(content: string): boolean {
  return /(?:生成|续写|接着写|继续写|完善|补写|补满|扩写)[^\n]{0,80}(?:第\s*[0-9一二三四五六七八九十百千]+\s*章|章节)/u.test(content)
    || /第\s*[0-9一二三四五六七八九十百千]+\s*章[^\n]{0,80}(?:生成|续写|完善|补写|补满|扩写)/u.test(content);
}
