<script setup lang="ts">
/**
 * 项目列表：页头（标题/计数/搜索/新建）+ 书架卡片网格（封面/元信息/操作）
 * + 回收站恢复 + 全书导出。
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete, Plus, Search } from '@element-plus/icons-vue';
import {
  exportProjectBook,
  listProjects,
  listTrashedProjects,
  removeProject,
  restoreProject,
  type Project,
} from '../../api/projects';

const router = useRouter();
const loading = ref(false);
const trashMode = ref(false);
const items = ref<Project[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(12);
const keyword = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = trashMode.value
      ? await listTrashedProjects({ page: page.value, pageSize: pageSize.value })
      : await listProjects({
          page: page.value,
          pageSize: pageSize.value,
          q: keyword.value.trim() || undefined,
        });
    items.value = result.items;
    total.value = result.total;
  } finally {
    loading.value = false;
  }
}

function onSearch(): void {
  page.value = 1;
  void load();
}

function toggleTrash(): void {
  trashMode.value = !trashMode.value;
  page.value = 1;
  void load();
}

function onArchive(project: Project): void {
  void ElMessageBox.confirm(
    `归档后「${project.title}」进入回收站，可随时恢复。`,
    '归档项目',
    { type: 'warning', confirmButtonText: '归档', cancelButtonText: '取消' },
  )
    .then(async () => {
      await removeProject(project.id);
      ElMessage.success('已移入回收站');
      void load();
    })
    .catch(() => {
      /* 用户取消 */
    });
}

async function onRestore(project: Project): Promise<void> {
  await restoreProject(project.id);
  ElMessage.success('已恢复');
  void load();
}

async function onExport(project: Project): Promise<void> {
  const result = await exportProjectBook(project.id);
  const blob = new Blob([result.content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = result.filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** 标题哈希 → 稳定色相，生成书架封面的确定性渐变。 */
function coverHue(title: string): number {
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return hash;
}

function coverStyle(project: Project): Record<string, string> {
  const hue = coverHue(project.title);
  return {
    background: `linear-gradient(135deg, hsl(${hue} 72% 88%), hsl(${(hue + 40) % 360} 66% 79%))`,
  };
}

function coverCharColor(project: Project): string {
  return `hsl(${coverHue(project.title)} 48% 38% / 0.5)`;
}

function coverChar(project: Project): string {
  return project.title.trim().slice(0, 1) || '书';
}

/** 字数展示：过万转为「万字」。 */
function formatWords(value?: number | null): string {
  const n = value ?? 0;
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n.toLocaleString()} 字`;
}

/** 相对时间：今天 HH:mm / 昨天 / N 天前 / YYYY/M/d。 */
function formatTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) return `今天 ${hh}:${mm}`;
  const days = Math.floor((now.getTime() - date.getTime()) / 86400000);
  if (days < 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="projects-page">
    <div class="page-head">
      <div class="head-text">
        <h1 class="page-title">{{ trashMode ? '回收站' : '我的项目' }}</h1>
        <p class="page-sub tnum">
          {{ trashMode ? '已归档的项目可以随时恢复' : `共 ${total} 个创作项目` }}
        </p>
      </div>
      <div class="head-actions">
        <el-input
          v-if="!trashMode"
          v-model="keyword"
          placeholder="搜索项目标题"
          clearable
          class="search"
          :prefix-icon="Search"
          @keyup.enter="onSearch"
          @clear="onSearch"
        />
        <el-button :icon="Delete" @click="toggleTrash">
          {{ trashMode ? '返回项目' : '回收站' }}
        </el-button>
        <el-button
          v-if="!trashMode"
          type="primary"
          :icon="Plus"
          @click="router.push({ name: 'project-create' })"
        >
          新建项目
        </el-button>
      </div>
    </div>

    <el-empty
      v-if="!loading && items.length === 0"
      :description="trashMode ? '回收站是空的' : '还没有项目，从第一个故事开始'"
      :image-size="120"
    >
      <el-button
        v-if="!trashMode"
        type="primary"
        :icon="Plus"
        @click="router.push({ name: 'project-create' })"
      >
        新建项目
      </el-button>
    </el-empty>

    <div v-loading="loading" class="grid">
      <el-card
        v-for="project in items"
        :key="project.id"
        class="card"
        shadow="never"
        :body-style="{ padding: '0' }"
      >
        <div class="card-cover" :style="coverStyle(project)">
          <span class="cover-char" :style="{ color: coverCharColor(project) }">
            {{ coverChar(project) }}
          </span>
          <el-tag v-if="project.genre" size="small" class="cover-tag">
            {{ project.genre }}
          </el-tag>
        </div>
        <div class="card-body">
          <div class="title" :title="project.title">{{ project.title }}</div>
          <p class="desc">{{ project.description || '暂无简介' }}</p>
          <div class="meta">
            <span class="tnum">{{ project.chapterCount ?? 0 }} 章 · {{ formatWords(project.wordCount) }}</span>
            <span class="tnum" :title="project.lastActiveAt || project.updatedAt">
              更新于 {{ formatTime(project.lastActiveAt || project.updatedAt) }}
            </span>
          </div>
          <div class="actions">
            <template v-if="trashMode">
              <el-button type="primary" size="small" @click="onRestore(project)">恢复</el-button>
            </template>
            <template v-else>
              <el-button
                type="primary"
                size="small"
                @click="router.push({ name: 'workspace', params: { id: project.id } })"
              >
                进入工作台
              </el-button>
              <span class="spacer" />
              <el-button text size="small" @click="onExport(project)">导出</el-button>
              <el-button text size="small" type="danger" @click="onArchive(project)">归档</el-button>
            </template>
          </div>
        </div>
      </el-card>
    </div>

    <el-pagination
      v-if="total > pageSize"
      v-model:current-page="page"
      :page-size="pageSize"
      :total="total"
      layout="prev, pager, next, total"
      class="pager"
      @current-change="load"
    />
  </div>
</template>

<style scoped>
.projects-page {
  max-width: 1200px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.page-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
}
.page-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.head-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}
.search {
  width: 260px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
  min-height: 120px;
}
.card {
  border-radius: 12px;
  border: 1px solid var(--el-border-color-lighter);
  overflow: hidden;
  transition: transform 180ms ease-out, box-shadow 180ms ease-out;
}
.card:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.1);
}
.card-cover {
  position: relative;
  height: 64px;
  display: flex;
  align-items: center;
  padding: 0 16px;
}
.cover-char {
  font-size: 36px;
  font-weight: 700;
  font-family: Georgia, 'Songti SC', serif;
  line-height: 1;
}
.cover-tag {
  margin-left: auto;
  background: rgba(255, 255, 255, 0.72);
  border-color: transparent;
  color: var(--el-text-color-primary);
}
.card-body {
  padding: 14px 16px 12px;
}
.title {
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.desc {
  min-height: 40px;
  margin: 6px 0 10px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-wrap: pretty;
}
.meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--el-border-color-extra-light);
  color: var(--el-text-color-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
}
.spacer {
  flex: 1;
}
.pager {
  margin-top: 20px;
  justify-content: center;
}
</style>
