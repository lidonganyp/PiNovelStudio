<script setup lang="ts">
/**
 * P5-4 章节版本面板：版本列表（source 徽标 + 字数 + 时间）+
 * 与当前正文对比（行级 diff，新增/删除高亮）+ 一键恢复。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  listVersions,
  restoreVersion,
  type Chapter,
  type ChapterVersion,
} from '../../api/chapters';

const props = defineProps<{
  projectId: number;
  chapter: Chapter;
}>();

const emit = defineEmits<{ restored: [chapter: Chapter] }>();

const versions = ref<ChapterVersion[]>([]);
const loading = ref(false);
const compareId = ref<number | null>(null);
const restoring = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    versions.value = await listVersions(props.projectId, props.chapter.id);
  } finally {
    loading.value = false;
  }
}

const compareVersion = computed(
  () => versions.value.find((v) => v.id === compareId.value) ?? null,
);

interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** 朴素行级 diff：以旧版为基准，展示「删除行/新增行/保留行」。 */
const diffLines = computed<DiffLine[]>(() => {
  const oldText = compareVersion.value?.content ?? '';
  const newText = props.chapter.content ?? '';
  if (compareVersion.value === null) return [];
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  // LCS 太重；采用简单对齐策略（逐行对比 + 剩余整块标记）
  const result: DiffLine[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  let i = 0;
  for (; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) {
      if (oldLine !== undefined) result.push({ type: 'same', text: oldLine });
    } else {
      if (oldLine !== undefined) result.push({ type: 'del', text: oldLine });
      if (newLine !== undefined) result.push({ type: 'add', text: newLine });
    }
  }
  return result;
});

const diffStat = computed(() => ({
  add: diffLines.value.filter((l) => l.type === 'add').length,
  del: diffLines.value.filter((l) => l.type === 'del').length,
}));

function sourceLabel(source: string): string {
  if (source === 'ai_generated') return 'AI 生成';
  if (source === 'manual_save') return '手动保存';
  if (source === 'restored') return '恢复';
  return source;
}

function sourceType(source: string): 'success' | 'primary' | 'info' {
  if (source === 'ai_generated') return 'success';
  if (source === 'manual_save') return 'primary';
  return 'info';
}

function onRestore(version: ChapterVersion): void {
  void ElMessageBox.confirm(
    `用版本 v${version.versionNumber} 的正文覆盖当前章节？恢复会生成一个新版本，历史不丢失。`,
    '恢复版本',
    { type: 'warning', confirmButtonText: '恢复', cancelButtonText: '取消' },
  )
    .then(async () => {
      restoring.value = true;
      try {
        const restored = await restoreVersion(
          props.projectId,
          props.chapter.id,
          version.versionNumber,
        );
        emit('restored', restored);
        ElMessage.success(`已恢复到 v${version.versionNumber}`);
        compareId.value = null;
        void load();
      } finally {
        restoring.value = false;
      }
    })
    .catch(() => {
      /* 用户取消 */
    });
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="version-panel" v-loading="loading">
    <div class="layout">
      <div class="list-side">
        <el-empty v-if="!loading && versions.length === 0" description="暂无历史版本" :image-size="60" />
        <div
          v-for="version in versions"
          :key="version.id"
          class="version-item"
          :class="{ active: version.id === compareId }"
        >
          <div class="version-head">
            <span class="version-no">v{{ version.versionNumber }}</span>
            <el-tag size="small" :type="sourceType(version.source)" effect="plain">
              {{ sourceLabel(version.source) }}
            </el-tag>
            <span class="version-time">
              {{ new Date(version.createdAt).toLocaleString() }}
            </span>
          </div>
          <div class="version-meta">{{ version.title || '未命名' }} · {{ version.wordCount }} 字</div>
          <div class="version-actions">
            <el-button
              size="small"
              :type="version.id === compareId ? 'primary' : 'default'"
              plain
              @click="compareId = version.id === compareId ? null : version.id"
            >
              {{ version.id === compareId ? '取消对比' : '与当前对比' }}
            </el-button>
            <el-button size="small" type="warning" plain :loading="restoring" @click="onRestore(version)">
              恢复
            </el-button>
          </div>
        </div>
      </div>

      <div v-if="compareVersion" class="diff-side">
        <div class="diff-head">
          <span>v{{ compareVersion.versionNumber }} → 当前（v{{ chapter.version }}）</span>
          <span class="diff-stat">
            +{{ diffStat.add }} 行 / −{{ diffStat.del }} 行
          </span>
        </div>
        <div class="diff-body">
          <div
            v-for="(line, index) in diffLines"
            :key="index"
            class="diff-line"
            :class="line.type"
          >
            <span class="line-marker">
              {{ line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ' }}
            </span>
            <span class="line-text">{{ line.text || ' ' }}</span>
          </div>
        </div>
      </div>
      <el-empty v-else class="diff-side" description="选择一个版本与当前正文对比" :image-size="80" />
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  gap: 16px;
  height: 100%;
  min-height: 320px;
}
.list-side {
  width: 340px;
  flex-shrink: 0;
  overflow-y: auto;
}
.version-item {
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.version-item.active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.version-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.version-no {
  font-weight: 600;
}
.version-time {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.version-meta {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin: 6px 0;
}
.version-actions {
  display: flex;
  gap: 8px;
}
.diff-side {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  overflow: hidden;
}
.diff-head {
  display: flex;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--el-border-color);
  font-size: 13px;
}
.diff-stat {
  color: var(--el-text-color-secondary);
}
.diff-body {
  flex: 1;
  overflow: auto;
  font-family: monospace;
  font-size: 12px;
  line-height: 1.6;
}
.diff-line {
  display: flex;
  white-space: pre-wrap;
  word-break: break-all;
}
.diff-line.add {
  background: var(--el-color-success-light-9);
}
.diff-line.del {
  background: var(--el-color-danger-light-9);
}
.line-marker {
  width: 24px;
  flex-shrink: 0;
  text-align: center;
  color: var(--el-text-color-secondary);
}
.diff-line.add .line-marker {
  color: var(--el-color-success);
}
.diff-line.del .line-marker {
  color: var(--el-color-danger);
}
.line-text {
  flex: 1;
}
</style>
