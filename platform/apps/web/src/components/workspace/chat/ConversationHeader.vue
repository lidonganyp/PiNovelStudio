<script setup lang="ts">
defineProps<{ projectTitle?: string; chapterNumber?: number | null; expanded?: boolean }>();
const emit = defineEmits<{ newConversation: []; toggleExpand: [] }>();
</script>

<template>
  <header class="conversation-header">
    <div>
      <strong>小说助手</strong>
      <span v-if="chapterNumber" class="chapter">第 {{ chapterNumber }} 章</span>
      <span v-if="projectTitle" class="project">{{ projectTitle }}</span>
    </div>
    <div class="header-actions">
      <button type="button" title="新建对话" aria-label="新建对话" @click="emit('newConversation')">＋</button>
      <button type="button" :title="expanded ? '收起聊天' : '展开聊天'" :aria-label="expanded ? '收起聊天' : '展开聊天'" @click="emit('toggleExpand')">{{ expanded ? '↙' : '↗' }}</button>
    </div>
  </header>
</template>

<style scoped>
.conversation-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
.conversation-header > div:first-child { min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.project { overflow: hidden; color: var(--el-text-color-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.chapter { flex-shrink: 0; padding: 0 5px; border: 1px solid var(--el-color-primary-light-5); border-radius: 3px; color: var(--el-color-primary); font-size: 10px; white-space: nowrap; }
.header-actions { display: flex; gap: 4px; }
.header-actions button { width: 28px; height: 28px; padding: 0; border: 1px solid var(--el-border-color); border-radius: 5px; background: transparent; color: var(--el-text-color-secondary); cursor: pointer; }
.header-actions button:hover { color: var(--el-color-primary); border-color: var(--el-color-primary); }
</style>
