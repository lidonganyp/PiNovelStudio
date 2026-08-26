<script setup lang="ts">
import { ref } from 'vue';
import type { ChatMessage } from '../../../composables/useAssistantChat';
import MessageItem from './MessageItem.vue';

defineProps<{ messages: ChatMessage[]; pendingSteward: (message: ChatMessage) => boolean; historyError?: string; sending?: boolean }>();
const emit = defineEmits<{
  copy: [message: ChatMessage];
  retry: [message: ChatMessage];
  continueGeneration: [message: ChatMessage];
  remove: [message: ChatMessage];
  resend: [message: ChatMessage];
  refresh: [];
  steward: [message: ChatMessage, action: 'apply_and_generate' | 'save_draft' | 'cancel'];
  revise: [message: ChatMessage];
  openTab: [tab: 'outline' | 'characters' | 'chapter', chapterNumber?: number];
  openSeed: [chapterNumber?: number];
  scroll: [element: HTMLElement];
}>();

const listElement = ref<HTMLElement | null>(null);
const showBackToBottom = ref(false);

/** 上报滚动位置给 composable 的 updateBottomState（决定流式时是否跟随滚动）。 */
function onScroll(event: Event): void {
  const element = event.target as HTMLElement;
  emit('scroll', element);
  showBackToBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight >= 120;
}

function scrollToBottom(): void {
  const element = listElement.value;
  if (element) element.scrollTop = element.scrollHeight;
  showBackToBottom.value = false;
}

defineExpose({ scrollToBottom, listElement });
</script>

<template>
  <div class="message-scroll">
    <div ref="listElement" class="message-list" @scroll="onScroll">
      <div v-if="historyError" class="history-error">{{ historyError }}</div>
      <el-empty v-if="messages.length === 0 && !historyError" description="发送消息开始创作或查询项目资料" :image-size="70" />
      <MessageItem
        v-for="message in messages"
        :key="message.id"
        :message="message"
        :pending-steward="pendingSteward(message)"
        :sending="sending"
        @copy="emit('copy', message)"
        @retry="emit('retry', message)"
        @continue-generation="emit('continueGeneration', message)"
        @remove="emit('remove', message)"
        @resend="emit('resend', message)"
        @refresh="emit('refresh')"
        @steward="(action) => emit('steward', message, action)"
        @revise="emit('revise', message)"
        @open-tab="(tab, chapterNumber) => emit('openTab', tab, chapterNumber)"
        @open-seed="(chapterNumber) => emit('openSeed', chapterNumber)"
      />
    </div>
    <transition name="fade">
      <button v-if="showBackToBottom" type="button" class="back-to-bottom" aria-label="回到底部" @click="scrollToBottom">↓ 回到底部</button>
    </transition>
  </div>
</template>

<style scoped>
.message-scroll { position: relative; display: flex; flex: 1; min-height: 0; flex-direction: column; }
.message-list { display: flex; flex: 1; min-height: 0; flex-direction: column; overflow-y: auto; padding: 14px 12px; }
.history-error { margin-bottom: 10px; padding: 8px; border-radius: 5px; background: var(--el-color-danger-light-9); color: var(--el-color-danger); font-size: 12px; }
.back-to-bottom { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%); padding: 4px 12px; border: 1px solid var(--el-border-color); border-radius: 999px; background: var(--el-bg-color); box-shadow: 0 2px 8px rgba(0, 0, 0, .15); color: var(--el-text-color-regular); cursor: pointer; font-size: 12px; }
.back-to-bottom:hover { color: var(--el-color-primary); border-color: var(--el-color-primary); }
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
