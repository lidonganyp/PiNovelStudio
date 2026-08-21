<script setup lang="ts">
/**
 * P5-2 文档面板：五类项目文档（创作宪法/世界观/大纲/风格档案/叙事状态）的
 * 列表 + 新建/编辑。style_profile 与 narrative_state 以原文保存（JSON/MD 均可）。
 */
import { inject, onMounted, reactive, ref, watch, type Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  DOCUMENT_TYPES,
  createDocument,
  listDocuments,
  removeDocument,
  updateDocument,
  type NovelDocument,
} from '../../api/workspace';

const props = defineProps<{ projectId: number }>();

const items = ref<NovelDocument[]>([]);
const loading = ref(false);
const drawerVisible = ref(false);
const saving = ref(false);
const editingId = ref<number | null>(null);

const form = reactive({
  documentType: 'worldbuilding',
  title: '',
  content: '',
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    items.value = await listDocuments(props.projectId);
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  editingId.value = null;
  form.documentType = 'worldbuilding';
  form.title = '';
  form.content = '';
  drawerVisible.value = true;
}

function openEdit(doc: NovelDocument): void {
  editingId.value = doc.id;
  form.documentType = doc.documentType;
  form.title = doc.title;
  form.content = doc.content;
  drawerVisible.value = true;
}

async function save(): Promise<void> {
  if (!form.title.trim()) {
    ElMessage.warning('标题必填');
    return;
  }
  saving.value = true;
  try {
    if (editingId.value === null) {
      await createDocument(props.projectId, {
        documentType: form.documentType,
        title: form.title.trim(),
        content: form.content,
      });
      ElMessage.success('文档已创建');
    } else {
      await updateDocument(props.projectId, editingId.value, {
        title: form.title.trim(),
        content: form.content,
      });
      ElMessage.success('文档已更新');
    }
    drawerVisible.value = false;
    void load();
  } finally {
    saving.value = false;
  }
}

function onDelete(doc: NovelDocument): void {
  void ElMessageBox.confirm(`删除文档「${doc.title}」？`, '删除文档', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消',
  })
    .then(async () => {
      await removeDocument(props.projectId, doc.id);
      ElMessage.success('已删除');
      void load();
    })
    .catch(() => {
      /* 用户取消 */
    });
}

function typeLabel(value: string): string {
  return DOCUMENT_TYPES.find((t) => t.value === value)?.label ?? value;
}

const epoch = inject<Ref<number>>('materialEpoch');

onMounted(() => {
  void load();
});
watch(() => epoch?.value, () => {
  void load();
});
</script>

<template>
  <div class="document-panel" v-loading="loading">
    <div class="toolbar">
      <el-alert
        type="info"
        :closable="false"
        title="五类文档会在生成时注入 runtime workspace；「风格档案」与「叙事状态」请保持原文格式（JSON 或 Markdown）。"
      />
      <el-button type="primary" @click="openCreate">+ 新建文档</el-button>
    </div>
    <el-empty v-if="!loading && items.length === 0" description="尚无文档" :image-size="60" />
    <el-table v-else :data="items" size="small">
      <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
      <el-table-column label="类型" width="120">
        <template #default="{ row }">
          <el-tag size="small">{{ typeLabel(row.documentType) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="currentVersion" label="版本" width="70" />
      <el-table-column label="内容摘要" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">
          {{ row.content.slice(0, 80) || '（空）' }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="130">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="onDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-drawer v-model="drawerVisible" :title="editingId === null ? '新建文档' : '编辑文档'" size="520px">
      <el-form label-position="top">
        <el-form-item label="类型">
          <el-select v-model="form.documentType" :disabled="editingId !== null">
            <el-option
              v-for="t in DOCUMENT_TYPES"
              :key="t.value"
              :value="t.value"
              :label="t.label"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" required>
          <el-input v-model="form.title" maxlength="200" />
        </el-form-item>
        <el-form-item label="内容">
          <el-input v-model="form.content" type="textarea" :autosize="{ minRows: 12 }" />
        </el-form-item>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </el-form>
    </el-drawer>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}
.toolbar .el-alert {
  flex: 1;
}
</style>
