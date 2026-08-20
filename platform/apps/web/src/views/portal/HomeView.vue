<script setup lang="ts">
/**
 * P5-1 项目列表页：搜索 / 分页 / 卡片网格；
 * 点击进入工作台，归档（软删除）需确认。
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  listProjects,
  removeProject,
  type Project,
} from '../../api/projects';

const router = useRouter();
const loading = ref(false);
const items = ref<Project[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(12);
const keyword = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await listProjects({
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

function onArchive(project: Project): void {
  void ElMessageBox.confirm(
    `归档后「${project.title}」不再出现在列表中，相关数据保留。`,
    '归档项目',
    { type: 'warning', confirmButtonText: '归档', cancelButtonText: '取消' },
  )
    .then(async () => {
      await removeProject(project.id);
      ElMessage.success('已归档');
      void load();
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
  <div class="projects-page">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索项目标题"
        clearable
        class="search"
        @keyup.enter="onSearch"
        @clear="onSearch"
      >
        <template #append>
          <el-button @click="onSearch">搜索</el-button>
        </template>
      </el-input>
      <span class="spacer" />
      <el-button type="primary" @click="router.push({ name: 'project-create' })">
        新建项目
      </el-button>
    </div>

    <el-empty v-if="!loading && items.length === 0" description="还没有项目，点右上角新建" />

    <div v-loading="loading" class="grid">
      <el-card
        v-for="project in items"
        :key="project.id"
        class="card"
        shadow="hover"
      >
        <template #header>
          <div class="card-header">
            <span class="title" :title="project.title">{{ project.title }}</span>
            <el-tag v-if="project.genre" size="small">{{ project.genre }}</el-tag>
          </div>
        </template>
        <p class="desc">{{ project.description || '暂无简介' }}</p>
        <div class="meta">
          <span>状态：{{ project.status }}</span>
          <span>更新：{{ new Date(project.updatedAt).toLocaleDateString() }}</span>
        </div>
        <div class="actions">
          <el-button type="primary" size="small" @click="router.push({ name: 'workspace', params: { id: project.id } })">
            进入工作台
          </el-button>
          <el-button size="small" @click="onArchive(project)">归档</el-button>
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
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
}
.search {
  max-width: 320px;
}
.spacer {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  min-height: 120px;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.desc {
  min-height: 40px;
  margin: 0 0 8px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.meta {
  display: flex;
  justify-content: space-between;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin-bottom: 12px;
}
.actions {
  display: flex;
  gap: 8px;
}
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
