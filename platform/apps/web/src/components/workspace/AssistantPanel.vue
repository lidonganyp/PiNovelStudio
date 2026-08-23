<script setup lang="ts">
/**
 * 助手对话面板：自然语言直聊，动作（查询/大纲/种子/生成）由
 * 助手智能体在后端自动判断并落库；失败以独立状态展示，不伪装成助手回答。
 */
import { inject, nextTick, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { InfoFilled } from '@element-plus/icons-vue';
import {
  clearMessages,
  buildStewardRequest,
  deleteMessage,
  listMessages,
  materialProposalLabel,
  sendMessageStream,
  userFacingFailure,
  type AssistantArtifacts,
  type AssistantMessage,
  type AssistantRequest,
  type FailureEnvelope,
  type StewardView,
} from '../../api/assistant';

const props = defineProps<{ projectId: number }>();

interface ChatMessage {
  id: number | string;
  role: string;
  content: string;
  streaming?: boolean;
  steward?: StewardView;
}

const messages = ref<ChatMessage[]>([]);
const input = ref('');
const sending = ref(false);
const listEl = ref<HTMLElement | null>(null);
const historyError = ref('');
const panelError = ref<FailureEnvelope | null>(null);
const jobSubmitted = ref<{ jobId: string; chapterNumber?: number } | null>(null);
const lastPayload = ref<AssistantRequest | null>(null);
const editingProposal = ref<{ messageId: number | string; steward: StewardView; values: Record<string, string> } | null>(null);
const trackJob = inject<(jobId: string) => void>('trackJob');
const reloadMaterials = inject<
  (opts?: { tab?: string; chapterNumber?: number }) => Promise<void>
>('reloadMaterials');

function scrollBottom(): void {
  void nextTick(() => {
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
  });
}

async function load(): Promise<void> {
  historyError.value = '';
  try {
    const history = await listMessages(props.projectId);
    messages.value = history.map((m: AssistantMessage) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      steward: m.metadata?.steward,
    }));
    scrollBottom();
  } catch {
    historyError.value = '对话历史加载失败，请刷新后重试';
  }
}

async function send(retry: boolean | Event = false, requestOverride?: AssistantRequest): Promise<void> {
  // 模板 @click/@keydown 直接绑定 send 时，首个参数是事件对象；只有显式传 true 才是重试。
  const isRetry = retry === true;
  const request = requestOverride ?? (isRetry ? lastPayload.value : undefined);
  const content = request?.content.trim() ?? input.value.trim();
  if (!content || sending.value) return;
  sending.value = true;
  panelError.value = null;
  jobSubmitted.value = null;
  if (!isRetry) {
    lastPayload.value = { content };
    input.value = '';
    messages.value.push({
      id: `local-${Date.now()}`,
      role: 'user',
      content,
    });
  }
  scrollBottom();

  const assistantId = `stream-${Date.now()}`;
  messages.value.push({
    id: assistantId,
    role: 'assistant',
    content: '',
    streaming: true,
  });
  scrollBottom();

  try {
    await sendMessageStream(
      props.projectId,
      request ?? { content },
      (event) => {
        const target = messages.value.find((m) => m.id === assistantId);
        if (event.type === 'delta' && target) {
          target.content += event.delta;
          scrollBottom();
        } else if (event.type === 'steward' && target) {
          target.steward = event.steward;
        } else if (event.type === 'failure') {
          if (target) target.streaming = false;
          if (event.failure.gate === 'author_contract') {
            if (target) target.content = event.failure.reason;
          } else {
            panelError.value = event.failure;
          }
        } else if (event.type === 'job_submitted') {
          jobSubmitted.value = { jobId: event.jobId, chapterNumber: event.chapterNumber };
          trackJob?.(event.jobId);
        } else if (event.type === 'done' && target) {
          target.content = event.message.content;
          target.streaming = false;
          target.id = event.message.id;
          if (event.steward) target.steward = event.steward;
          if (event.generationJobId) trackJob?.(event.generationJobId);
          void applyArtifacts(event.artifacts, event.generationJobId);
          scrollBottom();
        }
      },
    );
  } catch (err: unknown) {
    const target = messages.value.find((m) => m.id === assistantId);
    if (target) target.streaming = false;
    const detail = err instanceof Error ? err.message : '网络错误';
    if (!panelError.value) {
      panelError.value = {
        stage: 'assistant.sse',
        gate: 'stream',
        code: 'sse_interrupted',
        severity: 'recoverable',
        reason: userFacingFailure(detail),
        recoverable: true,
        retryPlan: 'retry_same_stage',
      };
    }
  } finally {
    sending.value = false;
  }
}

function pendingSteward(message: ChatMessage): boolean {
  const steward = message.steward;
  if (!steward?.proposalId || steward.generationJobId) return false;
  if (steward.proposalStatus === 'cancelled' || steward.proposalStatus === 'applied') return false;
  return steward.status === 'confirmation_required'
    || steward.status === 'auto_fill'
    || steward.proposalStatus === 'pending'
    || steward.proposalStatus === 'draft_saved';
}

async function sendSteward(
  message: ChatMessage,
  action: 'apply_and_generate' | 'save_draft' | 'cancel',
): Promise<void> {
  const steward = message.steward;
  if (!steward?.proposalId || sending.value) return;
  const request = buildStewardRequest(steward, action);
  lastPayload.value = request;
  await send(true, request);
}

function startRevise(message: ChatMessage): void {
  if (!message.steward) return;
  editingProposal.value = {
    messageId: message.id,
    steward: message.steward,
    values: Object.fromEntries(message.steward.proposals
      .filter((row) => row.requiresConfirmation)
      .map((row) => [row.field, row.value])),
  };
}

function cancelRevise(): void {
  editingProposal.value = null;
}

async function submitRevision(): Promise<void> {
  const editing = editingProposal.value;
  if (!editing || sending.value) return;
  const request: AssistantRequest = {
    content: 'revise proposal',
    stewardAction: 'revise',
    proposalId: editing.steward.proposalId,
    sourceVersion: editing.steward.sourceVersion,
    proposalEdits: Object.entries(editing.values).map(([field, value]) => ({ field, value })),
  };
  lastPayload.value = request;
  editingProposal.value = null;
  await send(true, request);
}

async function applyArtifacts(
  artifacts?: AssistantArtifacts,
  generationJobId?: string,
): Promise<void> {
  if (!artifacts && !generationJobId) return;
  const chapterNum = artifacts?.chaptersTouched?.[0];
  await reloadMaterials?.({
    tab: artifacts?.focusTab,
    chapterNumber: chapterNum,
  });
}

async function newConversation(): Promise<void> {
  if (sending.value) return;
  try {
    await ElMessageBox.confirm(
      '将清空当前对话历史（软删除，规划上下文从零开始）。确认新建对话？',
      '新建对话',
      { type: 'warning', confirmButtonText: '新建', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  const result = await clearMessages(props.projectId);
  messages.value = [];
  panelError.value = null;
  jobSubmitted.value = null;
  ElMessage.success(`已新建对话（清空 ${result.cleared} 条历史消息）`);
}

async function copyMessage(message: ChatMessage): Promise<void> {
  if (!message.content) return;
  try {
    await navigator.clipboard.writeText(message.content);
    ElMessage.success('已复制');
  } catch {
    ElMessage.warning('复制失败，请手动选择文本');
  }
}

async function removeMessage(message: ChatMessage): Promise<void> {
  if (typeof message.id !== 'number') return;
  try {
    await ElMessageBox.confirm('删除这条消息？删除后不再进入规划上下文。', '删除消息', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  await deleteMessage(props.projectId, message.id);
  messages.value = messages.value.filter((item) => item.id !== message.id);
  ElMessage.success('已删除');
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="assistant-panel">
    <div class="panel-header">
      <span class="title">小说助手</span>
      <el-tooltip
        content="直接聊天即可：助手自动判断是查询、规划大纲、写章纲还是生成正文，并把结果存入项目"
        placement="bottom"
      >
        <el-icon class="hint-icon"><InfoFilled /></el-icon>
      </el-tooltip>
      <span class="spacer" />
      <el-button size="small" @click="newConversation">新建对话</el-button>
    </div>
    <div v-if="historyError" class="banner error">
      {{ historyError }}
      <el-button size="small" link @click="load">重试加载</el-button>
    </div>
    <div v-if="panelError" class="banner error">
      <strong>{{ panelError.reason }}</strong>
      <div class="meta">{{ panelError.code }} · {{ panelError.stage }}</div>
      <div v-if="panelError.userActionRequired?.length">
        {{ panelError.userActionRequired.join('；') }}
      </div>
      <el-button
        v-if="panelError.recoverable"
        size="small"
        type="primary"
        link
        @click="send(true)"
      >
        重试
      </el-button>
    </div>
    <div v-if="jobSubmitted" class="banner info">
      已提交第{{ jobSubmitted.chapterNumber ?? '?' }}章正式生成任务。
      正文不会出现在聊天里，请在上方任务面板查看进度。
    </div>
    <div ref="listEl" class="messages">
      <el-empty
        v-if="messages.length === 0 && !historyError"
        description="直接发送消息：助手自动判断查询、规划或生成"
        :image-size="70"
      />
      <div
        v-for="message in messages"
        :key="message.id"
        class="message"
        :class="message.role"
      >
        <div class="bubble">
          <span v-if="message.streaming && !message.content" class="thinking">正在思考…</span>
          <span class="content">{{ message.content }}</span><span v-if="message.streaming" class="cursor">▋</span>
          <div
            v-if="!message.streaming && pendingSteward(message)"
            class="steward-actions"
          >
            <el-button size="small" type="primary" @click="sendSteward(message, 'apply_and_generate')">
              采用并继续生成
            </el-button>
            <el-button size="small" @click="startRevise(message)">修改方案</el-button>
            <el-button size="small" @click="sendSteward(message, 'save_draft')">仅保存草案</el-button>
            <el-button size="small" @click="sendSteward(message, 'cancel')">取消</el-button>
          </div>
          <div v-if="editingProposal?.messageId === message.id" class="proposal-editor">
            <div v-for="proposal in editingProposal.steward.proposals.filter((row) => row.requiresConfirmation)" :key="proposal.field" class="proposal-field">
              <label>{{ materialProposalLabel(proposal.field) }}</label>
              <el-input v-model="editingProposal.values[proposal.field]" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" />
            </div>
            <div class="steward-actions">
              <el-button size="small" type="primary" @click="submitRevision">保存修改</el-button>
              <el-button size="small" @click="cancelRevise">取消修改</el-button>
            </div>
          </div>
          <div v-if="!message.streaming && message.content" class="ops">
            <el-button size="small" link @click="copyMessage(message)">复制</el-button>
            <el-button
              v-if="typeof message.id === 'number'"
              size="small"
              link
              type="danger"
              @click="removeMessage(message)"
            >
              删除
            </el-button>
          </div>
        </div>
      </div>
    </div>
    <div class="composer">
      <div class="input-row">
        <el-input
          v-model="input"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 4 }"
          placeholder="例如：帮我写一份都市重生全书大纲 / 规划第3章 / 生成第3章正文"
          :disabled="sending"
          @keydown.enter.exact.prevent="send"
        />
        <el-button type="primary" :loading="sending" @click="send">发送</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.assistant-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--el-border-color);
}
.panel-header .title {
  font-weight: 600;
  font-size: 13px;
}
.hint-icon {
  color: var(--el-text-color-secondary);
  cursor: help;
  font-size: 14px;
}
.spacer {
  flex: 1;
}
.banner {
  margin: 8px 12px 0;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
}
.banner.error {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}
.banner.info {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
.banner .meta {
  opacity: 0.8;
  margin-top: 2px;
}
.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}
.message {
  display: flex;
  margin-bottom: 10px;
}
.message.user {
  justify-content: flex-end;
}
.bubble {
  max-width: 86%;
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.message.assistant .bubble {
  background: var(--el-fill-color-light);
}
.message.user .bubble {
  background: var(--el-color-primary);
  color: #fff;
}
.ops {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  justify-content: flex-end;
}
.steward-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.proposal-editor {
  display: grid;
  gap: 8px;
  margin-top: 10px;
  padding: 10px;
  border: 1px solid var(--el-border-color);
}
.proposal-field {
  display: grid;
  gap: 4px;
}
.proposal-field label {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.message.user .ops :deep(.el-button) {
  color: rgba(255, 255, 255, 0.86);
}
.thinking {
  color: var(--el-text-color-secondary);
  margin-right: 4px;
}
.cursor {
  animation: blink 1s step-end infinite;
}
@keyframes blink {
  50% { opacity: 0; }
}
.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--el-border-color);
}
.input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.input-row .el-button {
  flex-shrink: 0;
}
</style>
