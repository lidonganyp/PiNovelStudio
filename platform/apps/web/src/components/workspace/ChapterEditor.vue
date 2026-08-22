<script setup lang="ts">
/**
 * P5-2 章节编辑器：标题 + 正文 + 字数统计；
 * 保存走乐观锁（expectedVersion），409 冲突时提示刷新覆盖。
 */
import { ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { updateChapter, type Chapter } from '../../api/chapters';

const props = defineProps<{
  projectId: number;
  chapter: Chapter;
}>();

const emit = defineEmits<{ updated: [chapter: Chapter] }>();

const title = ref(props.chapter.title);
const content = ref(props.chapter.content);
const saving = ref(false);

watch(
  () => props.chapter,
  (next) => {
    title.value = next.title;
    content.value = next.content;
  },
);

async function save(): Promise<void> {
  saving.value = true;
  try {
    const updated = await updateChapter(props.projectId, props.chapter.id, {
      title: title.value,
      content: content.value,
      expectedVersion: props.chapter.version,
    });
    emit('updated', updated);
    ElMessage.success('已保存（新版本已记录）');
  } catch (err: unknown) {
    // 409 版本冲突：让用户选择是否用本地内容覆盖远端
    const isConflict =
      (err as { response?: { status?: number } }).response?.status === 409;
    if (isConflict) {
      try {
        await ElMessageBox.confirm(
          '章节已被其他操作修改（例如生成任务刚写入新正文）。点击「覆盖」将以当前编辑内容保存为新版本。',
          '版本冲突',
          { type: 'warning', confirmButtonText: '覆盖', cancelButtonText: '取消' },
        );
        const response = (err as {
          response?: { data?: { currentVersion?: number } };
        }).response;
        const currentVersion = response?.data?.currentVersion;
        if (typeof currentVersion !== 'number') {
          ElMessage.error('无法获取最新版本号，请刷新页面');
          return;
        }
        const updated = await updateChapter(
          props.projectId,
          props.chapter.id,
          {
            title: title.value,
            content: content.value,
            expectedVersion: currentVersion,
          },
        );
        emit('updated', updated);
        ElMessage.success('已覆盖保存');
      } catch {
        /* 用户取消覆盖 */
      }
    }
    // 其他错误 http 拦截器已统一提示
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="chapter-editor">
    <div class="head">
      <span class="chapter-no">第 {{ chapter.chapterNumber }} 章</span>
      <el-input v-model="title" maxlength="200" placeholder="章节标题" class="title-input" />
      <span class="word-count">{{ content.length }} 字符 / 官方字数 {{ chapter.wordCount }}</span>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </div>
    <el-input
      v-model="content"
      type="textarea"
      class="content-area"
      placeholder="章节正文（可手写，或填写种子后由系统生成）"
    />
  </div>
</template>

<style scoped>
.chapter-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.chapter-no {
  font-weight: 600;
  white-space: nowrap;
}
.title-input {
  flex: 1;
  min-width: 200px;
  max-width: 420px;
}
.word-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.content-area {
  flex: 1;
  min-height: 0;
}
/* 正文阅读感：更大字号与行高，适合长篇中文文本；
   高度固定为容器高（约等于视口高），长文在 textarea 内部滚动 */
.content-area :deep(textarea) {
  height: 100%;
  resize: none;
  overflow-y: auto;
  font-size: 15px;
  line-height: 1.9;
  padding: 14px 16px;
}
</style>
