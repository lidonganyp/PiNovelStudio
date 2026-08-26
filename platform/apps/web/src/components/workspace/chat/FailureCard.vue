<script setup lang="ts">
/**
 * FailureCard：用户可理解的失败卡片。
 * 展示脱敏原因、是否可重试、需要用户补充/执行的项，并提供重试与刷新入口。
 */
import type { FailureEnvelope } from '../../../api/assistant';

defineProps<{ failure: FailureEnvelope; canContinue?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ retry: []; continueGeneration: []; refresh: [] }>();
</script>

<template>
  <section class="failure-card" aria-label="操作失败">
    <header class="failure-head">
      <strong>{{ failure.reason || '这条回复未完成' }}</strong>
      <span v-if="failure.recoverable" class="retryable">可重试</span>
      <span v-else class="blocked">需要处理</span>
    </header>
    <div v-if="failure.userActionRequired?.length" class="block">
      <div class="block-title">需要你确认或补充：</div>
      <ul><li v-for="item in failure.userActionRequired" :key="item">{{ item }}</li></ul>
    </div>
    <div v-if="failure.fixInstructions?.length" class="block">
      <div class="block-title">建议操作：</div>
      <ul><li v-for="item in failure.fixInstructions" :key="item">{{ item }}</li></ul>
    </div>
    <div class="failure-actions">
      <button v-if="canContinue" type="button" class="primary" :disabled="disabled" @click="emit('continueGeneration')">继续生成</button>
      <button v-else-if="failure.recoverable" type="button" class="primary" :disabled="disabled" @click="emit('retry')">重试</button>
      <button v-if="failure.userActionRequired?.length || failure.fixInstructions?.length" type="button" :disabled="disabled" @click="emit('refresh')">刷新资料</button>
    </div>
  </section>
</template>

<style scoped>
.failure-card { display: grid; gap: 6px; margin-top: 9px; padding: 9px 10px; border: 1px solid var(--el-color-danger-light-5); border-radius: 6px; background: var(--el-color-danger-light-9); color: var(--el-color-danger); font-size: 12px; }
.failure-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.retryable, .blocked { flex-shrink: 0; padding: 0 5px; border: 1px solid currentColor; border-radius: 3px; font-size: 10px; }
.block { color: var(--el-text-color-regular); }
.block-title { font-weight: 600; }
.failure-card ul { margin: 3px 0 0; padding-left: 16px; }
.failure-actions { display: flex; gap: 8px; }
.failure-actions button { padding: 3px 10px; border: 1px solid var(--el-border-color); border-radius: 5px; background: var(--el-bg-color); color: var(--el-text-color-primary); cursor: pointer; font-size: 12px; }
.failure-actions button:disabled { cursor: not-allowed; opacity: .55; }
.failure-actions .primary { border-color: var(--el-color-primary); background: var(--el-color-primary); color: white; }
</style>
