<script setup lang="ts">
/**
 * 章节/项目反馈：写入 novel_feedback，不直接改正文。
 */
import { onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  createFeedback,
  listFeedback,
  type FeedbackItem,
} from '../../api/feedback';

const props = defineProps<{
  projectId: number;
  chapterId: number | null;
}>();

const items = ref<FeedbackItem[]>([]);
const type = ref('quality');
const content = ref('');
const loading = ref(false);

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
  <div class="feedback">
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
      <el-table-column prop="type" label="类型" width="90" />
      <el-table-column prop="content" label="内容" />
    </el-table>
  </div>
</template>

<style scoped>
.list {
  margin-top: 16px;
}
</style>
