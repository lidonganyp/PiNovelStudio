<script setup lang="ts">
/**
 * P5-3 生成任务面板：阶段步骤条 + 消耗实时（预占/已结算）+
 * 逐调用明细 + 失败呈现与重试。轮询由 useJobPolling 驱动。
 */
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Loading } from '@element-plus/icons-vue';
import { JOB_STAGES, isTerminalStatus } from '../../api/jobs';
import { fenToYuan } from '../../api/billing';
import { retryGeneration } from '../../api/jobs';
import type { Chapter } from '../../api/chapters';
import { useJobPolling } from '../../composables/useJobPolling';

const props = defineProps<{
  projectId: number;
  chapter: Chapter | null;
}>();

const emit = defineEmits<{
  'register-track': [fn: (jobId: string) => void];
  succeeded: [];
}>();

const { job, calls, loading, error, track, reset } = useJobPolling();
const recovering = ref(false);

// 把 track 交给父容器（WorkspaceView provide('trackJob') 转发）
emit('register-track', (jobId: string) => track(jobId));

const visible = computed(() => job.value !== null);
const recoveryLabel = computed(() => '重试原任务');

const statusMeta = computed((): { text: string; type: 'primary' | 'success' | 'danger' | 'warning' | 'info' } => {
  switch (String(job.value?.status)) {
    case 'succeeded':
      return { text: '生成成功', type: 'success' };
    case 'failed':
      return { text: '生成失败', type: 'danger' };
    case 'insufficient_balance':
      return { text: '余额不足', type: 'warning' };
    case 'running':
      return { text: '生成中', type: 'primary' };
    default:
      return { text: '排队中', type: 'info' };
  }
});

/** 当前 stage 在已知序列中的序号（-1 = 未知阶段）。 */
const stageIndex = computed(() => {
  const stage = job.value?.progressStage;
  if (!stage) return -1;
  return JOB_STAGES.findIndex((s) => s.value === stage);
});

const totalChargeYuan = computed(() =>
  fenToYuan(
    calls.value.reduce(
      (sum: number, call: { actualCharge: string }) =>
        sum + Number(call.actualCharge),
      0,
    ),
  ),
);

const tokensTotal = computed(() =>
  calls.value.reduce(
    (sum: number, call: { tokensIn: number; tokensOut: number }) =>
      sum + call.tokensIn + call.tokensOut,
    0,
  ),
);

/** 对同一章节重新提交生成（失败重试）。 */
async function retry(): Promise<void> {
  if (!job.value || recovering.value) return;
  recovering.value = true;
  try {
    const next = await retryGeneration(job.value.jobId);
    track(next.jobId);
    ElMessage.success(`${recoveryLabel.value}任务已提交`);
  } catch {
    // 保留原失败详情，让用户可以修复网络/资料后再次继续。
  } finally {
    recovering.value = false;
  }
}

function onClose(): void {
  reset();
}

/** 轮询把状态刷成 succeeded 时通知父级刷新章节（只触发一次）。 */
watch(
  () => job.value?.status,
  (status, prev) => {
    if (status === 'succeeded' && prev !== 'succeeded') {
      emit('succeeded');
    }
  },
);
</script>

<template>
  <section v-if="visible && job" class="generation-panel">
    <div class="panel-head">
      <span class="panel-title">
        <el-icon v-if="!isTerminalStatus(String(job.status))" class="spin">
          <Loading />
        </el-icon>
        生成任务
      </span>
      <el-tag :type="statusMeta.type" size="small">{{ statusMeta.text }}</el-tag>
      <el-button v-if="isTerminalStatus(String(job.status))" link size="small" @click="onClose">
        关闭
      </el-button>
    </div>

    <!-- 阶段进度 -->
    <el-steps
      :active="stageIndex + 1"
      align-center
      finish-status="success"
      class="stages"
    >
      <el-step
        v-for="stage in JOB_STAGES"
        :key="stage.value"
        :title="stage.label"
      />
    </el-steps>
    <p v-if="stageIndex < 0 && job.progressStage" class="unknown-stage">
      当前阶段：{{ job.progressStage }}
    </p>

    <!-- 消耗实时 -->
    <div class="charge-row">
      <span>预占上限 ¥{{ fenToYuan(job.maxCharge) }}</span>
      <span>已结算 ¥{{ fenToYuan(job.settledAmount) }}</span>
      <span v-if="calls.length">模型调用成本 ¥{{ totalChargeYuan }}（{{ tokensTotal }} tokens / {{ calls.length }} 次调用）</span>
      <span v-if="job.status === 'failed'">本章未交付，失败免单</span>
    </div>

    <!-- 失败呈现 -->
    <el-alert
      v-if="job.status === 'failed'"
      type="error"
      :closable="false"
      :title="job.failure?.reason ?? job.failureMessage ?? '生成失败'"
      class="failure"
    >
      <div v-if="job.failure" class="failure-meta">
        {{ job.failure.code }} · {{ job.failure.stage }}
        <span v-if="job.failure.gate"> / {{ job.failure.gate }}</span>
      </div>
      <div v-if="job.failure?.userActionRequired?.length">
        {{ job.failure.userActionRequired.join('；') }}
      </div>
      <div v-if="job.failure?.fixInstructions?.length" class="fix">
        {{ job.failure.fixInstructions.join('；') }}
      </div>
      <el-button
        v-if="job.failure?.recoverable !== false"
        size="small"
        type="danger"
        plain
        :loading="recovering"
        @click="retry"
      >
        {{ recoveryLabel }}
      </el-button>
    </el-alert>
    <el-alert
      v-else-if="job.status === 'insufficient_balance'"
      type="warning"
      :closable="false"
      title="余额不足：请先充值后再提交生成"
      class="failure"
    />
    <el-alert v-else-if="error" type="error" :closable="false" :title="`轮询失败：${error}`" class="failure" />

    <!-- 逐调用明细 -->
    <el-collapse v-if="calls.length > 0" class="calls">
      <el-collapse-item :title="`调用明细（${calls.length}）`">
        <el-table :data="calls" size="small" max-height="220">
          <el-table-column prop="internalStage" label="阶段" min-width="110" show-overflow-tooltip />
          <el-table-column prop="model" label="模型" min-width="130" show-overflow-tooltip />
          <el-table-column label="tokens 入/出" width="130">
            <template #default="{ row }">
              {{ row.tokensIn }} / {{ row.tokensOut }}
            </template>
          </el-table-column>
          <el-table-column label="金额" width="90">
            <template #default="{ row }">¥{{ fenToYuan(row.actualCharge) }}</template>
          </el-table-column>
        </el-table>
      </el-collapse-item>
    </el-collapse>

    <p v-if="loading" class="polling-hint">轮询中…</p>
  </section>
</template>

<style scoped>
.generation-panel {
  border-bottom: 1px solid var(--el-border-color);
  padding: 12px;
  flex-shrink: 0;
  max-height: 55%;
  overflow-y: auto;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.panel-title {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 4px;
}
.spin {
  animation: rotate 1.2s linear infinite;
}
@keyframes rotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.stages {
  margin: 4px 0;
}
.stages :deep(.el-step__title) {
  font-size: 12px;
}
.unknown-stage {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-align: center;
  margin: 4px 0;
}
.charge-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 8px 0;
  font-variant-numeric: tabular-nums;
}
.failure {
  margin: 8px 0;
}
.failure-meta,
.fix {
  font-size: 12px;
  opacity: 0.86;
  margin: 4px 0;
}
.failure :deep(.el-alert__content) {
  display: flex;
  align-items: center;
  gap: 12px;
}
.polling-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-align: center;
  margin: 6px 0 0;
}
</style>
