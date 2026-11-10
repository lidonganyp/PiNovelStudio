<script setup lang="ts">
/**
 * 生成任务实时状态卡片：嵌入聊天消息流，随聊天内容滚动。
 * 阶段进度 + 状态 + 失败重试，替代原右侧固定 GenerationPanel（不再遮挡聊天）。
 */
import { computed } from 'vue';
import { Loading } from '@element-plus/icons-vue';
import { JOB_STAGES, isTerminalStatus } from '../../../api/jobs';
import type { JobStatus } from '../../../composables/useAssistantChat';

const props = defineProps<{ job: JobStatus; disabled?: boolean }>();
const emit = defineEmits<{ retry: []; open: [chapterNumber?: number] }>();
const statusMeta = computed(() => {
  switch (props.job.status) {
    case 'succeeded':
      return { text: '生成成功', type: 'success' as const };
    case 'failed':
      return { text: '生成失败', type: 'danger' as const };
    case 'insufficient_balance':
      return { text: '余额不足', type: 'warning' as const };
    case 'running':
      return { text: '生成中', type: 'primary' as const };
    default:
      return { text: '排队中', type: 'info' as const };
  }
});
const stageIndex = computed(() => {
  const stage = props.job.progressStage;
  if (!stage) return -1;
  return JOB_STAGES.findIndex((item) => item.value === stage);
});
const running = computed(() => !isTerminalStatus(props.job.status));
const canRetry = computed(
  () => props.job.status === 'failed' || props.job.status === 'insufficient_balance',
);
</script>
<template>
  <div class="job-card">
    <div class="job-head">
      <el-icon v-if="running" class="spin"><Loading /></el-icon>
      <span class="job-title">第{{ job.chapterNumber ?? '?' }}章 · 生成任务</span>
      <el-tag :type="statusMeta.type" size="small">{{ statusMeta.text }}</el-tag>
      <span class="spacer" />
      <el-button
        v-if="job.status === 'succeeded'"
        link
        size="small"
        @click="emit('open', job.chapterNumber)"
      >
        查看章节
      </el-button>
    </div>
    <el-steps :active="stageIndex + 1" finish-status="success" simple class="job-steps">
      <el-step v-for="stage in JOB_STAGES" :key="stage.value" :title="stage.label" />
    </el-steps>
    <div v-if="job.failureMessage" class="job-failure">{{ job.failureMessage }}</div>
    <div v-if="canRetry" class="job-actions">
      <el-button size="small" type="primary" :disabled="disabled" @click="emit('retry')">
        重试生成
      </el-button>
    </div>
  </div>
</template>
<style scoped>
.job-card { margin-top: 8px; padding: 10px 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; background: var(--el-bg-color-page); }
.job-head { display: flex; align-items: center; gap: 8px; }
.job-title { font-size: 13px; font-weight: 600; }
.spacer { flex: 1; }
.job-steps { margin-top: 8px; }
.job-failure { margin-top: 8px; font-size: 12px; color: var(--el-color-danger); word-break: break-all; }
.job-actions { margin-top: 8px; }
.spin { animation: job-spin 1.2s linear infinite; }
@keyframes job-spin { to { transform: rotate(360deg); } }
</style>
