<script setup lang="ts">
/**
 * P5-2 助手对话面板：历史消息 + SSE 流式回复。
 * 发送后本地先渲染用户消息，assistant 增量拼接，
 * done 事件以服务端持久化消息替换临时文本。
 * 上下文只携带最近 10 条消息；「新建对话」清空历史从零开始。
 */
import { inject, nextTick, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  clearMessages,
  deleteMessage,
  listMessages,
  sendMessageStream,
  type AssistantArtifacts,
  type AssistantMessage,
} from '../../api/assistant';

const props = defineProps<{ projectId: number }>();

interface ChatMessage {
  id: number | string;
  role: string;
  content: string;
  streaming?: boolean;
}

const messages = ref<ChatMessage[]>([]);
const input = ref('');
const sending = ref(false);
const listEl = ref<HTMLElement | null>(null);
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
  const history = await listMessages(props.projectId);
  messages.value = history.map((m: AssistantMessage) => ({
    id: m.id,
    role: m.role,
    content: m.content,
  }));
  scrollBottom();
}

async function send(): Promise<void> {
  const content = input.value.trim();
  if (!content || sending.value) return;
  sending.value = true;
  input.value = '';
  messages.value.push({
    id: `local-${Date.now()}`,
    role: 'user',
    content,
  });
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
    await sendMessageStream(props.projectId, content, (event) => {
      const target = messages.value.find((m) => m.id === assistantId);
      if (!target) return;
      if ('delta' in event) {
        target.content += event.delta;
        scrollBottom();
      } else if ('error' in event) {
        target.streaming = false;
        target.content = target.content
          ? `${target.content}\n\n（${event.error}）`
          : `（发送失败：${event.error}）`;
        scrollBottom();
      } else if ('done' in event) {
        target.content = event.message.content;
        target.streaming = false;
        target.id = event.message.id;
        if (event.generationJobId) trackJob?.(event.generationJobId);
        void applyArtifacts(event.artifacts, event.generationJobId);
        scrollBottom();
      }
    });
  } catch (err: unknown) {
    const target = messages.value.find((m) => m.id === assistantId);
    if (target && target.streaming !== false) {
      target.streaming = false;
      const detail = err instanceof Error ? err.message : '网络错误';
      if (!target.content) {
        target.content = `（发送失败：${detail}）`;
      } else if (!target.content.includes(detail)) {
        target.content = `${target.content}\n\n（${detail}）`;
      }
    }
  } finally {
    sending.value = false;
  }
}

async function applyArtifacts(
  artifacts?: AssistantArtifacts,
  generationJobId?: string,
): Promise<void> {
  if (!artifacts && !generationJobId) return;
  const chapterNumber = artifacts?.chaptersTouched?.[0];
  await reloadMaterials?.({
    tab: artifacts?.focusTab,
    chapterNumber,
  });
}

/** 新建对话：清空当前项目消息历史，上下文从零开始。 */
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
      <span class="hint" title="发给规划模型的历史上下文只携带最近 10 条消息">上下文：最近 10 条</span>
      <el-button size="small" @click="newConversation">新建对话</el-button>
    </div>
    <div ref="listEl" class="messages">
      <el-empty
        v-if="messages.length === 0"
        description="和小说助手对话：生成大纲、完善角色、发起章节生成"
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
      <el-input
        v-model="input"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 4 }"
        placeholder="例如：帮我写一份都市重生大纲，并生成第一章"
        :disabled="sending"
        @keydown.enter.exact.prevent="send"
      />
      <el-button type="primary" :loading="sending" @click="send">发送</el-button>
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
.panel-header .hint {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.messages {
  flex: 1;
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
  gap: 8px;
  align-items: flex-end;
  padding: 10px 12px;
  border-top: 1px solid var(--el-border-color);
}
.composer .el-button {
  flex-shrink: 0;
}
</style>
