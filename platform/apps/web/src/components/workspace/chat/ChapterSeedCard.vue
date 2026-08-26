<script setup lang="ts">
/**
 * ChapterSeedCard：章节种子产物卡片。
 * 展示本次触达的章节并提供跳转；种子内容以 SeedEditor 为准，
 * 聊天不承载正文。
 */
defineProps<{ chaptersTouched: number[] }>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <section class="seed-card" aria-label="章节种子已更新">
    <div class="seed-row">
      <span>第 {{ chaptersTouched.join('、') }} 章种子已更新</span>
      <button type="button" @click="emit('open')">查看种子</button>
    </div>
  </section>
</template>

<style scoped>
.seed-card { margin-top: 9px; padding: 9px 10px; border: 1px solid var(--el-border-color); border-radius: 6px; background: var(--el-fill-color-extra-light); font-size: 12px; }
.seed-row { display: flex; justify-content: space-between; gap: 8px; }
.seed-row button { padding: 0; border: 0; background: transparent; color: var(--el-color-primary); cursor: pointer; font-size: 12px; }
</style>
