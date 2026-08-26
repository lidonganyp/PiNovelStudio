<script setup lang="ts">
/**
 * 大纲板块：展示助手/用户写入的 story_outline 文档。
 */
import { inject, onMounted, ref, watch, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Check, Close, Edit } from '@element-plus/icons-vue';
import {
  listDocuments,
  updateDocument,
  type NovelDocument,
} from '../../api/workspace';

const props = defineProps<{ projectId: number }>();
const epoch = inject<Ref<number>>('materialEpoch');
const loading = ref(false);
const saving = ref(false);
const editing = ref(false);
const draftContent = ref('');
const doc = ref<NovelDocument | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const rows = await listDocuments(props.projectId);
    doc.value = rows.find((item) => item.documentType === 'story_outline') ?? null;
  } finally {
    loading.value = false;
  }
}

function startEdit(): void {
  if (!doc.value) return;
  draftContent.value = doc.value.content;
  editing.value = true;
}

function cancelEdit(): void {
  draftContent.value = doc.value?.content ?? '';
  editing.value = false;
}

async function save(): Promise<void> {
  if (!doc.value || saving.value) return;
  saving.value = true;
  try {
    doc.value = await updateDocument(props.projectId, doc.value.id, {
      content: draftContent.value,
    });
    editing.value = false;
    ElMessage.success('大纲已保存');
  } catch {
    // 请求错误由 http 拦截器提示；保留当前草稿供用户重试。
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void load();
});
watch(() => epoch?.value, () => {
  void load();
});
</script>

<template>
  <div class="outline-panel" v-loading="loading">
    <el-empty
      v-if="!loading && !doc"
      description="尚无大纲。在右侧与助手对话，例如「帮我写一份故事大纲」。"
    />
    <template v-else-if="doc">
      <div class="outline-head">
        <strong>{{ doc.title }}</strong>
        <el-tag size="small">v{{ doc.currentVersion }}</el-tag>
        <div class="outline-actions">
          <el-button
            v-if="!editing"
            :icon="Edit"
            circle
            aria-label="编辑"
            title="编辑"
            @click="startEdit"
          />
          <template v-else>
            <el-button
              :icon="Close"
              circle
              aria-label="取消"
              title="取消"
              :disabled="saving"
              @click="cancelEdit"
            />
            <el-button
              type="primary"
              :icon="Check"
              circle
              aria-label="保存"
              title="保存"
              :loading="saving"
              @click="save"
            />
          </template>
        </div>
      </div>
      <el-input
        v-if="editing"
        v-model="draftContent"
        class="outline-editor"
        type="textarea"
        resize="none"
        aria-label="大纲正文"
      />
      <pre v-else class="outline-body">{{ doc.content }}</pre>
    </template>
  </div>
</template>

<style scoped>
.outline-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 8px 4px;
}
.outline-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.outline-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
.outline-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
  font-family: inherit;
}
.outline-editor {
  flex: 1;
  min-height: 0;
}
.outline-editor :deep(textarea) {
  height: 100%;
  min-height: 240px;
  overflow-y: auto;
  padding: 14px 16px;
  font-size: 14px;
  line-height: 1.8;
  font-family: inherit;
}
</style>
