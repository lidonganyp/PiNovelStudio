<script setup lang="ts">
import { computed, ref } from 'vue';
import { isChapterRequest, type ChatMessage } from '../../../composables/useAssistantChat';
import { renderMarkdown } from './markdown';
import MessageActions from './MessageActions.vue';
import FailureCard from './FailureCard.vue';
import StewardProposalCard from './StewardProposalCard.vue';
import OutlineArtifactCard from './OutlineArtifactCard.vue';
import ChapterSeedCard from './ChapterSeedCard.vue';
import GenerationRequestCard from './GenerationRequestCard.vue';

const props = defineProps<{ message: ChatMessage; pendingSteward?: boolean; sending?: boolean }>();
const emit = defineEmits<{
  copy: [];
  retry: [];
  continueGeneration: [];
  remove: [];
  resend: [];
  refresh: [];
  steward: [action: 'apply_and_generate' | 'save_draft' | 'cancel'];
  revise: [];
  openTab: [tab: 'outline' | 'characters' | 'chapter', chapterNumber?: number];
  openSeed: [chapterNumber?: number];
}>();
const expanded = ref(false);
const collapsedLimit = 5000;
const isLong = computed(() => props.message.content.length > collapsedLimit);
const rendered = computed(() => renderMarkdown(expanded.value || !isLong.value ? props.message.content : `${props.message.content.slice(0, collapsedLimit)}\n\n…`));
const statusHint = computed(() => {
  if (props.message.status === 'failed') return '发送失败';
  if (props.message.status === 'cancelled') return '已停止';
  return '';
});
const canContinue = computed(() => Boolean(
  props.message.failure?.recoverable
  && props.message.request
  && isChapterRequest(props.message.request.content),
));

/** markdown.ts 输出的 .code-copy 按钮通过事件委托统一处理复制。 */
async function onContentClick(event: MouseEvent): Promise<void> {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.code-copy');
  if (!button) return;
  const text = button.closest('.code-block')?.querySelector('code')?.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = '已复制';
  } catch {
    button.textContent = '复制失败';
  }
  setTimeout(() => { button.textContent = '复制'; }, 1500);
}
</script>

<template>
  <article class="message-item" :class="[message.role, message.status]">
    <div class="message-meta">
      <span>{{ message.role === 'user' ? '你' : '小说助手' }}</span>
      <span v-if="statusHint" class="status-hint">{{ statusHint }}</span>
      <time v-if="message.createdAt">{{ new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</time>
    </div>
    <div class="bubble">
      <div v-if="message.streaming && !message.content" class="thinking">正在思考…</div>
      <div class="message-content" v-html="rendered" @click="onContentClick" />
      <span v-if="message.streaming" class="cursor" aria-label="正在输出">▍</span>
      <div v-if="isLong" class="expand-row"><button type="button" @click="expanded = !expanded">{{ expanded ? '收起长消息' : '展开长消息' }}</button></div>
      <StewardProposalCard
        v-if="message.steward"
        :steward="message.steward"
        :pending="pendingSteward"
        @steward="(action) => emit('steward', action)"
        @revise="emit('revise')"
      />
      <OutlineArtifactCard v-if="message.artifacts" :artifacts="message.artifacts" @open="(tab) => emit('openTab', tab)" />
      <ChapterSeedCard
        v-if="message.artifacts?.chaptersTouched?.length"
        :chapters-touched="message.artifacts.chaptersTouched"
        @open="emit('openSeed', message.artifacts?.chaptersTouched?.[0])"
      />
      <!-- steward 消息由 StewardProposalCard 展示任务编号（该路径落库 artifacts 不含 generationJobId），
           此处只恢复主链路直生成消息的历史任务卡片，避免同一 jobId 双卡片且刷新前后行为不一致。 -->
      <GenerationRequestCard
        v-if="message.artifacts?.generationJobId && !message.steward"
        :job-id="message.artifacts.generationJobId"
        :chapter-number="message.artifacts.chaptersTouched?.[0]"
        @open="emit('openTab', 'chapter', message.artifacts?.chaptersTouched?.[0])"
      />
      <FailureCard
        v-if="message.failure"
        :failure="message.failure"
        :can-continue="canContinue"
        :disabled="sending"
        @retry="emit('retry')"
        @continue-generation="emit('continueGeneration')"
        @refresh="emit('refresh')"
      />
      <MessageActions
        v-if="!message.streaming && message.content"
        :can-delete="typeof message.id === 'number'"
        :can-retry="(message.status === 'failed' || message.status === 'cancelled') && !canContinue"
        :can-resend="message.role === 'user'"
        @copy="emit('copy')"
        @retry="emit('retry')"
        @remove="emit('remove')"
        @resend="emit('resend')"
      />
    </div>
  </article>
</template>

<style scoped>
.message-item { display: flex; flex-direction: column; max-width: 92%; margin: 0 0 14px; }
.message-item.user { align-self: flex-end; align-items: flex-end; }
.message-item.failed .bubble, .message-item.cancelled .bubble { border: 1px dashed var(--el-color-danger-light-5); }
.message-meta { display: flex; gap: 7px; margin: 0 4px 4px; color: var(--el-text-color-secondary); font-size: 10px; }
.status-hint { color: var(--el-color-danger); }
.bubble { padding: 9px 11px; border-radius: 8px; background: var(--el-fill-color-light); color: var(--el-text-color-primary); font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }
.user .bubble { background: var(--el-color-primary); color: white; }
.message-content :deep(p) { margin: 0 0 8px; }
.message-content :deep(p:last-child) { margin-bottom: 0; }
.message-content :deep(a) { color: inherit; text-decoration: underline; }
.message-content :deep(code) { padding: 1px 3px; border-radius: 3px; background: rgba(127,127,127,.15); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .92em; }
.message-content :deep(.code-block) { margin: 8px 0; border: 1px solid rgba(127,127,127,.25); border-radius: 6px; overflow: hidden; }
.user .message-content :deep(.code-block) { border-color: rgba(255,255,255,.35); }
.message-content :deep(.code-head) { display: flex; justify-content: space-between; align-items: center; padding: 4px 9px; background: rgba(127,127,127,.18); color: var(--el-text-color-secondary); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.user .message-content :deep(.code-head) { background: rgba(0,0,0,.15); color: rgba(255,255,255,.85); }
.message-content :deep(.code-copy) { padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 11px; }
.message-content :deep(.code-copy:hover) { text-decoration: underline; }
.message-content :deep(.code-block pre) { max-width: 100%; overflow: auto; margin: 0; padding: 8px; border-radius: 0; background: #1f2937; color: #f9fafb; }
.message-content :deep(.code-block pre code) { padding: 0; background: transparent; }
.thinking { color: var(--el-text-color-secondary); }
.cursor { animation: blink 1s step-end infinite; }
.expand-row button { border: 0; background: transparent; color: var(--el-color-primary); cursor: pointer; font-size: 11px; }
@keyframes blink { 50% { opacity: 0; } }
</style>
