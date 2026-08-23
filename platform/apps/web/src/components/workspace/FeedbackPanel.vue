<script setup lang="ts">
/**
 * 章节/项目反馈：写入 novel_feedback，不直接改正文；展示管理员回复（纯文本）。
 */
import { onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  createFeedback,
  listFeedback,
  type FeedbackItem,
} from '../../api/feedback';

const TYPE_LABELS: Record<string, string> = {
  quality: '文学质量',
  factual: '事实问题',
  other: '其他',
};

const props = defineProps<{
  projectId: number;
  chapterId: number | null;
}>();

const items = ref<FeedbackItem[]>([]);
const type = ref('quality');
const content = ref('');
const loading = ref(false);

function typeLabel(value: string): string {
  return TYPE_LABELS[value] ?? value;
}

function statusLabel(row: FeedbackItem): string {
  return row.status === 'replied' ? '已回复' : '待处理';
}

async function load(): Promise<void> {
  items.value = await listFeedback(props.projectId);
}

async function submit(): Promise<void> {
  if (!content.value.trim()) {
    ElMessage.warning('请填写反馈内容');
    return;
  }
  loading.value = true;
  try {
    await createFeedback(props.projectId, {
      type: type.value,
      content: content.value.trim(),
      chapterId: props.chapterId ?? undefined,
    });
    content.value = '';
    ElMessage.success('反馈已提交');
    await load();
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.projectId,
  () => {
    void load();
  },
);

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="feedback" data-testid="feedback-panel">
    <el-form label-position="top">
      <el-form-item label="类型">
        <el-select v-model="type" style="width: 160px">
          <el-option label="文学质量" value="quality" />
          <el-option label="事实问题" value="factual" />
          <el-option label="其他" value="other" />
        </el-select>
      </el-form-item>
      <el-form-item label="内容">
        <el-input v-model="content" type="textarea" :rows="4" />
      </el-form-item>
      <el-button type="primary" :loading="loading" @click="submit">提交反馈</el-button>
    </el-form>
    <el-table :data="items" size="small" class="list">
      <el-table-column prop="createdAt" label="时间" width="180" />
      <el-table-column label="类型" width="90">
        <template #default="{ row }">{{ typeLabel(row.type) }}</template>
      </el-table-column>
      <el-table-column label="内容" min-width="180">
        <template #default="{ row }">
          <div class="plain">{{ row.content }}</div>
        </template>
      </el-table-column>
      <el-table-column label="处理状态" width="90">
        <template #default="{ row }">
          <span :data-testid="`feedback-status-${row.id}`">{{ statusLabel(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="管理员回复" min-width="220">
        <template #default="{ row }">
          <div v-if="row.status === 'replied' && row.replyContent" data-testid="feedback-reply-block">
            <div class="plain">{{ row.replyContent }}</div>
            <div class="meta">
              {{ row.adminNickname || '管理员' }}
              <span v-if="row.repliedAt"> · {{ row.repliedAt }}</span>
            </div>
          </div>
          <span v-else>待处理</span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.list {
  margin-top: 16px;
}
.plain {
  white-space: pre-wrap;
  word-break: break-word;
}
.meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
