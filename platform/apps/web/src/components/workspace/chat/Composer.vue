<script setup lang="ts">
defineProps<{ modelValue: string; sending: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; send: []; stop: [] }>();
</script>

<template>
  <form class="composer" @submit.prevent="emit('send')">
    <textarea :value="modelValue" :disabled="sending" rows="1" placeholder="询问项目、规划大纲或章节种子" @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" @keydown.enter.exact.prevent="emit('send')" />
    <span class="hint">Enter 发送 · Shift+Enter 换行</span>
    <button v-if="sending" type="button" class="stop" @click="emit('stop')">停止</button>
    <button v-else type="submit" class="send" :disabled="!modelValue.trim()">发送</button>
  </form>
</template>

<style scoped>
.composer { position: relative; display: grid; grid-template-columns: 1fr auto; gap: 5px 8px; padding: 10px 12px; border-top: 1px solid var(--el-border-color-lighter); background: var(--el-bg-color); }
textarea { min-height: 36px; max-height: 128px; resize: vertical; padding: 8px 9px; border: 1px solid var(--el-border-color); border-radius: 6px; font: inherit; font-size: 13px; line-height: 1.45; }
textarea:focus { outline: 2px solid var(--el-color-primary-light-8); border-color: var(--el-color-primary); }
.send, .stop { align-self: end; min-width: 52px; height: 36px; border: 0; border-radius: 6px; color: white; cursor: pointer; }
.send { background: var(--el-color-primary); }
.send:disabled { opacity: .45; cursor: not-allowed; }
.stop { background: var(--el-color-danger); }
.hint { grid-column: 1 / -1; color: var(--el-text-color-secondary); font-size: 10px; }
</style>
