<script setup lang="ts">
/**
 * OutlineArtifactCard：大纲/角色等全书资料产物卡片。
 * 只展示已落库结果并提供跳转；草案内容与确认流程在 StewardProposalCard。
 */
import type { AssistantArtifacts } from '../../../api/assistant';

defineProps<{ artifacts: AssistantArtifacts }>();
const emit = defineEmits<{ open: [tab: 'outline' | 'characters'] }>();
</script>

<template>
  <section v-if="artifacts.outlineSaved || artifacts.charactersSaved" class="outline-card" aria-label="资料已保存">
    <div class="outline-title">资料已保存</div>
    <div v-if="artifacts.outlineSaved" class="artifact-row"><span>全书大纲</span><button type="button" @click="emit('open', 'outline')">查看大纲</button></div>
    <div v-if="artifacts.charactersSaved" class="artifact-row"><span>角色档案（{{ artifacts.charactersSaved }}）</span><button type="button" @click="emit('open', 'characters')">查看角色</button></div>
  </section>
</template>

<style scoped>
.outline-card { margin-top: 9px; padding: 9px 10px; border: 1px solid var(--el-border-color); border-radius: 6px; background: var(--el-fill-color-extra-light); font-size: 12px; }
.outline-title { margin-bottom: 5px; font-weight: 600; }
.artifact-row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; }
.artifact-row button { padding: 0; border: 0; background: transparent; color: var(--el-color-primary); cursor: pointer; font-size: 12px; }
</style>
