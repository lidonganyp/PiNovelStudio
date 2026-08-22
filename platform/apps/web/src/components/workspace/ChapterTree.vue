<script setup lang="ts">
/**
 * P5-2 左栏章节目录树：章节号 + 标题 + 状态徽标（章节/种子状态）；
 * 支持新建章节（自动取下一个序号）与删除。
 */
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  createChapter,
  removeChapter,
  type Chapter,
} from '../../api/chapters';

const props = defineProps<{
  chapters: Chapter[];
  activeId: number | null;
  projectId: number;
}>();

const emit = defineEmits<{
  select: [id: number];
  changed: [];
}>();

const creating = ref(false);

/** 章节状态徽标。 */
function chapterTag(chapter: Chapter): { text: string; type: 'info' | 'success' | 'warning' } {
  if (chapter.status === 'generated') return { text: '已生成', type: 'success' };
  if (chapter.content) return { text: '有草稿', type: 'warning' };
  return { text: '空', type: 'info' };
}

/** 种子状态徽标。 */
function seedTag(chapter: Chapter): { text: string; type: 'info' | 'success' | 'warning' } {
  if (!chapter.seed) return { text: '无种子', type: 'info' };
  if (chapter.seed.status === 'consumed') return { text: '已消费', type: 'success' };
  const ready =
    chapter.seed.intent.trim() !== '' && chapter.seed.endingGoal.trim() !== '';
  return ready
    ? { text: '就绪', type: 'warning' }
    : { text: '未完成', type: 'info' };
}

const nextNumber = computed(() =>
  props.chapters.reduce((max, c) => Math.max(max, c.chapterNumber), 0) + 1,
);

async function addChapter(): Promise<void> {
  creating.value = true;
  try {
    const created = await createChapter(props.projectId, {
      chapterNumber: nextNumber.value,
    });
    emit('changed');
    emit('select', created.id);
    ElMessage.success(`第 ${created.chapterNumber} 章已创建`);
  } finally {
    creating.value = false;
  }
}

function onDelete(chapter: Chapter): void {
  void ElMessageBox.confirm(
    `删除「第${chapter.chapterNumber}章 ${chapter.title || ''}」？该操作为软删除。`,
    '删除章节',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  )
    .then(async () => {
      await removeChapter(props.projectId, chapter.id);
      ElMessage.success('已删除');
      emit('changed');
    })
    .catch(() => {
      /* 用户取消 */
    });
}
</script>

<template>
  <div class="chapter-tree">
    <div class="tree-head">
      <span>章节目录</span>
      <el-button size="small" type="primary" plain :loading="creating" @click="addChapter">
        + 新章
      </el-button>
    </div>
    <el-empty
      v-if="chapters.length === 0"
      description="尚无章节"
      :image-size="60"
    />
    <div
      v-for="chapter in chapters"
      :key="chapter.id"
      class="chapter-item"
      :class="{ active: chapter.id === activeId }"
      @click="emit('select', chapter.id)"
    >
      <div class="row-main">
        <span class="num">{{ chapter.chapterNumber }}</span>
        <span class="name" :title="chapter.title || '未命名'">
          {{ chapter.title || '未命名' }}
        </span>
      </div>
      <div class="row-tags">
        <el-tag size="small" :type="chapterTag(chapter).type" effect="plain">
          {{ chapterTag(chapter).text }}
        </el-tag>
        <el-tag size="small" :type="seedTag(chapter).type" effect="plain">
          {{ seedTag(chapter).text }}
        </el-tag>
        <span class="words">{{ chapter.wordCount }} 字</span>
        <el-button
          class="del"
          link
          size="small"
          type="danger"
          @click.stop="onDelete(chapter)"
        >
          删
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tree-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  padding: 4px 4px 10px;
}
.chapter-item {
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background-color 150ms ease-out, border-color 150ms ease-out;
}
.chapter-item:hover {
  background: var(--el-fill-color-light);
}
.chapter-item.active {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-7);
  box-shadow: inset 3px 0 0 var(--el-color-primary);
}
.row-main {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.num {
  color: var(--el-color-primary);
  font-weight: 600;
  min-width: 20px;
  font-variant-numeric: tabular-nums;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.words {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}
/* 删除按钮默认收起，hover 行时浮现，保持目录整洁 */
.del {
  margin-left: auto;
  opacity: 0;
  transition: opacity 150ms ease-out;
}
.chapter-item:hover .del,
.chapter-item.active .del {
  opacity: 1;
}
@media (hover: none) {
  .del {
    opacity: 1;
  }
}
</style>
