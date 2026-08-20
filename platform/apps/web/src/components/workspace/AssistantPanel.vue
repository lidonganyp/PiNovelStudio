<script setup lang="ts">
/**
 * P5-2 助手对话面板：历史消息 + SSE 流式回复。
 * 发送后本地先渲染用户消息，assistant 增量拼接，
 * done 事件以服务端持久化消息替换临时文本。
 */
import { nextTick, onMounted, ref } from 'vue';
import {
  listMessages,
  sendMessageStream,
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
      if ('delta' in event && target) {
        target.content += event.delta;
        scrollBottom();
      } else if ('done' in event && target) {
        target.content = event.message.content;
        target.streaming = false;
        target.id = event.message.id;
        scrollBottom();
      }
    });
  } catch (err: unknown) {
    const target = messages.value.find((m) => m.id === assistantId);
    if (target) {
      target.streaming = false;
      if (!target.content) {
        target.content = `（发送失败：${err instanceof Error ? err.message : '网络错误'}）`;
      }
    }
  } finally {
    sending.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="assistant-panel">
    <div ref="listEl" class="messages">
      <el-empty
        v-if="messages.length === 0"
        description="向写作助手提问：大纲思路、设定推演、剧情卡点…"
        :image-size="70"
      />
      <div
        v-for="message in messages"
        :key="message.id"
        class="message"
        :class="message.role"
      >
        <div class="bubble">
          <span class="content">{{ message.content }}</span><span v-if="message.streaming" class="cursor">▋</span>
        </div>
      </div>
    </div>
    <div class="composer">
      <el-input
        v-model="input"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 4 }"
        placeholder="输入问题，Enter 发送，Shift+Enter 换行"
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
