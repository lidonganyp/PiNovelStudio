<script setup lang="ts">
/**
 * GenerationRequestCard：生成任务卡片。
 * 展示目标章节、任务编号与当前状态；正文不在聊天中展示，
 * 跳转动作交给工作台（章节页签/任务面板）。
 */
defineProps<{ jobId: string; chapterNumber?: number; status?: string }>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <section class="generation-card" aria-label="生成任务">
    <div class="generation-info">
      <strong>生成任务{{ chapterNumber ? ` · 第 ${chapterNumber} 章` : '' }}</strong>
      <span class="job-id">任务编号：{{ jobId }}</span>
      <span class="status">{{ status ?? '已提交' }}</span>
    </div>
    <button type="button" @click="emit('open')">查看任务</button>
    <div class="note">正文由统一编排生成，完成后出现在章节页签，不会出现在聊天里。</div>
  </section>
</template>

<style scoped>
.generation-card { display: grid; gap: 5px; margin-top: 9px; padding: 9px 10px; border: 1px solid var(--el-color-primary-light-5); border-radius: 6px; background: var(--el-color-primary-light-9); color: var(--el-text-color-primary); font-size: 12px; }
.generation-info { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.job-id, .status { color: var(--el-text-color-secondary); }
.generation-card > button { justify-self: start; padding: 3px 10px; border: 1px solid var(--el-color-primary); border-radius: 5px; background: transparent; color: var(--el-color-primary); cursor: pointer; font-size: 12px; }
.note { color: var(--el-text-color-secondary); font-size: 11px; }
</style>
