<script setup lang="ts">
/**
 * 大纲板块：展示助手/用户写入的 story_outline 文档。
 */
import { inject, onMounted, ref, watch, type Ref } from 'vue';
import { listDocuments, type NovelDocument } from '../../api/workspace';

const props = defineProps<{ projectId: number }>();
const epoch = inject<Ref<number>>('materialEpoch');
const loading = ref(false);
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
      </div>
      <pre class="outline-body">{{ doc.content }}</pre>
    </template>
  </div>
</template>

<style scoped>
.outline-panel {
  height: 100%;
  overflow: auto;
  padding: 8px 4px;
}
.outline-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.outline-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
  font-family: inherit;
}
</style>
