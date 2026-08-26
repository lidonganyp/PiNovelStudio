<script setup lang="ts">
defineProps<{ canDelete?: boolean; canRetry?: boolean; canResend?: boolean }>();
const emit = defineEmits<{ copy: []; retry: []; remove: []; resend: [] }>();
</script>

<template>
  <div class="message-actions">
    <button type="button" title="复制消息" aria-label="复制消息" @click="emit('copy')">复制</button>
    <button v-if="canRetry" type="button" title="重试" aria-label="重试" @click="emit('retry')">重试</button>
    <button v-if="canResend" type="button" title="重新发送" aria-label="重新发送" @click="emit('resend')">重新发送</button>
    <button v-if="canDelete" type="button" title="删除消息" aria-label="删除消息" @click="emit('remove')">删除</button>
  </div>
</template>

<style scoped>
.message-actions { display: flex; gap: 6px; margin-top: 6px; opacity: .75; }
.message-actions button { padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 11px; }
.message-actions button:hover { color: var(--el-color-primary); }
.user .message-actions button:hover { color: inherit; text-decoration: underline; }
</style>
