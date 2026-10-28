<script setup lang="ts">
/**
 * P5-2 三栏工作台主容器：
 * 左=章节目录树；中=内容区（章节/种子/角色/文档/版本 tabs）；右=助手对话 + 生成任务面板。
 * 生成流程：SeedEditor 保存种子 → 提交生成 → GenerationPanel 轮询 → 成功后刷新章节。
 */
import { computed, onMounted, onUnmounted, provide, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowLeft } from '@element-plus/icons-vue';
import { useAuthStore } from '../../stores/auth';
import {
  getProject,
  type Project,
} from '../../api/projects';
import {
  listChapters,
  submitGeneration,
  type Chapter,
} from '../../api/chapters';
import ChapterTree from '../../components/workspace/ChapterTree.vue';
import ChapterEditor from '../../components/workspace/ChapterEditor.vue';
import SeedEditor from '../../components/workspace/SeedEditor.vue';
import CharacterPanel from '../../components/workspace/CharacterPanel.vue';
import OutlinePanel from '../../components/workspace/OutlinePanel.vue';
import DocumentPanel from '../../components/workspace/DocumentPanel.vue';
import VersionPanel from '../../components/workspace/VersionPanel.vue';
import AssistantWorkspace from '../../components/workspace/chat/AssistantWorkspace.vue';
import GenerationPanel from '../../components/workspace/GenerationPanel.vue';
import RevisionPanel from '../../components/workspace/RevisionPanel.vue';
import FeedbackPanel from '../../components/workspace/FeedbackPanel.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const projectId = computed(() => Number(route.params.id));

const project = ref<Project | null>(null);
const chapters = ref<Chapter[]>([]);
const chaptersLoading = ref(false);
const activeChapterId = ref<number | null>(null);
const activeTab = ref('chapter');

/** GenerationPanel 通过 provide/inject 拿到 track 入口。 */
const trackJob = ref<((jobId: string) => void) | null>(null);
const materialEpoch = ref(0);
provide('trackJob', (jobId: string) => trackJob.value?.(jobId));
provide('materialEpoch', materialEpoch);
provide('activeChapterNumber', computed(() => activeChapter.value?.chapterNumber ?? null));
provide(
  'reloadMaterials',
  async (opts?: { tab?: string; chapterNumber?: number }): Promise<void> => {
    materialEpoch.value += 1;
    await loadChapters();
    try {
      project.value = await getProject(projectId.value);
    } catch {
      /* 项目刷新失败不阻断板块刷新 */
    }
    if (opts?.chapterNumber != null) {
      const found = chapters.value.find((item) => item.chapterNumber === opts.chapterNumber);
      if (found) activeChapterId.value = found.id;
    }
    if (opts?.tab) activeTab.value = opts.tab;
  },
);

const activeChapter = computed(
  () => chapters.value.find((c) => c.id === activeChapterId.value) ?? null,
);

async function loadChapters(): Promise<void> {
  chaptersLoading.value = true;
  try {
    const rows = await listChapters(projectId.value);
    chapters.value = rows;
    if (
      rows.length > 0 &&
      !rows.some((c) => c.id === activeChapterId.value)
    ) {
      activeChapterId.value = rows[0].id;
    }
    if (rows.length === 0) {
      activeChapterId.value = null;
    }
  } finally {
    chaptersLoading.value = false;
  }
}

function selectChapter(id: number): void {
  activeChapterId.value = id;
  activeTab.value = 'chapter';
}

/** 单章刷新（生成成功后替换本地行）。 */
function patchChapter(next: Chapter): void {
  const index = chapters.value.findIndex((c) => c.id === next.id);
  if (index >= 0) {
    chapters.value[index] = next;
    chapters.value = [...chapters.value].sort((a, b) => a.chapterNumber - b.chapterNumber);
  }
}

/** 提交生成：种子完整后调用，jobId 交给任务面板跟踪。 */
async function startGeneration(): Promise<void> {
  if (!activeChapter.value) return;
  const job = await submitGeneration(
    projectId.value,
    activeChapter.value.id,
  );
  trackJob.value?.(job.jobId);
  activeTab.value = 'chapter';
  ElMessage.success('生成任务已提交');
}

onMounted(async () => {
  void auth.fetchMe();
  project.value = await getProject(projectId.value);
  await loadChapters();
});

/** 阶段五：右栏拖拽调宽（移动端由 CSS 隐藏拖拽把手，抽屉模式不受影响）。 */
const RIGHT_PANE_WIDTH_KEY = 'pi-novel.right-pane-width';
const DEFAULT_RIGHT_WIDTH = 360;
const rightWidth = ref(DEFAULT_RIGHT_WIDTH);
const resizing = ref(false);
try {
  const saved = Number(window.localStorage.getItem(RIGHT_PANE_WIDTH_KEY));
  if (Number.isFinite(saved) && saved >= 320 && saved <= 960) rightWidth.value = saved;
} catch { /* localStorage 不可用时使用默认宽度 */ }

function startResize(event: MouseEvent): void {
  resizing.value = true;
  event.preventDefault();
}

function onResizeMove(event: MouseEvent): void {
  if (!resizing.value) return;
  const max = Math.max(320, Math.min(960, window.innerWidth - 620));
  rightWidth.value = Math.max(320, Math.min(max, window.innerWidth - event.clientX));
}

function stopResize(): void {
  if (!resizing.value) return;
  resizing.value = false;
  try { window.localStorage.setItem(RIGHT_PANE_WIDTH_KEY, String(rightWidth.value)); } catch { /* 忽略持久化失败 */ }
}

function resetRightWidth(): void {
  rightWidth.value = DEFAULT_RIGHT_WIDTH;
  try { window.localStorage.setItem(RIGHT_PANE_WIDTH_KEY, String(DEFAULT_RIGHT_WIDTH)); } catch { /* 忽略持久化失败 */ }
}

onMounted(() => {
  window.addEventListener('mousemove', onResizeMove);
  window.addEventListener('mouseup', stopResize);
});
onUnmounted(() => {
  window.removeEventListener('mousemove', onResizeMove);
  window.removeEventListener('mouseup', stopResize);
});

defineExpose({ loadChapters, patchChapter });
</script>

<template>
  <div v-if="project" class="workspace">
    <div class="workspace-header">
      <el-button
        :icon="ArrowLeft"
        circle
        class="back-btn"
        title="返回项目列表"
        @click="router.push({ name: 'portal-home' })"
      />
      <span class="project-title" :title="project.title">{{ project.title }}</span>
      <el-tag v-if="project.genre" size="small">{{ project.genre }}</el-tag>
      <span v-for="sub in project.subGenres" :key="sub" class="sub-genre">{{ sub }}</span>
      <span class="spacer" />
      <span class="workflow">流程：{{ project.workflowState }}</span>
    </div>

    <div class="workspace-body">
      <aside class="left-pane" v-loading="chaptersLoading">
        <ChapterTree
          :chapters="chapters"
          :active-id="activeChapterId"
          :project-id="projectId"
          @select="selectChapter"
          @changed="loadChapters"
        />
      </aside>

      <main class="center-pane">
        <el-tabs v-model="activeTab" class="content-tabs">
          <el-tab-pane label="章节" name="chapter">
            <ChapterEditor
              v-if="activeChapter"
              :key="activeChapter.id + '-' + activeChapter.version"
              :project-id="projectId"
              :chapter="activeChapter"
              @updated="patchChapter"
            />
            <el-empty v-else description="左侧新建或选择一个章节" />
          </el-tab-pane>
          <!-- 项目级：全书大纲，不随章节切换 -->
          <el-tab-pane label="大纲（全书）" name="outline">
            <OutlinePanel :project-id="projectId" />
          </el-tab-pane>
          <!-- 章节级：当前选中章节的种子 -->
          <el-tab-pane label="种子（本章）" name="seed">
            <SeedEditor
              v-if="activeChapter"
              :key="'seed-' + activeChapter.id + '-' + (activeChapter.seed?.version ?? 0)"
              :project-id="projectId"
              :chapter="activeChapter"
              @updated="patchChapter"
              @generate="startGeneration"
            />
            <el-empty v-else description="先选择一个章节" />
          </el-tab-pane>
          <!-- 项目级：全书角色档案，不随章节切换 -->
          <el-tab-pane label="角色（全书）" name="characters" lazy>
            <CharacterPanel :project-id="projectId" />
          </el-tab-pane>
          <!-- 项目级：全书设定文档 -->
          <el-tab-pane label="文档（全书）" name="documents" lazy>
            <DocumentPanel :project-id="projectId" />
          </el-tab-pane>
          <el-tab-pane label="版本" name="versions" lazy>
            <VersionPanel
              v-if="activeChapter"
              :project-id="projectId"
              :chapter="activeChapter"
              @restored="patchChapter"
            />
            <el-empty v-else description="先选择一个章节" />
          </el-tab-pane>
          <el-tab-pane label="反馈" name="feedback" lazy>
            <FeedbackPanel :project-id="projectId" :chapter-id="activeChapterId" />
          </el-tab-pane>
        </el-tabs>
      </main>

      <div
        class="right-resizer"
        :class="{ active: resizing }"
        title="拖拽调整助手栏宽度，双击恢复默认"
        aria-label="拖拽调整助手栏宽度"
        @mousedown="startResize"
        @dblclick="resetRightWidth"
      />
      <aside class="right-pane" :style="{ width: rightWidth + 'px' }">
        <RevisionPanel :project-id="projectId" :chapters="chapters" @progress="loadChapters" />
        <GenerationPanel
          :project-id="projectId"
          :chapter="activeChapter"
          @register-track="(fn) => (trackJob = fn)"
          @succeeded="loadChapters"
        />
        <AssistantWorkspace :project-id="projectId" :project-title="project.title" />
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* 高度由 PortalLayout 的 workspace-main（flex 列容器）提供，不再使用负 margin。 */
.workspace {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
}
.workspace-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: #fff;
}
.back-btn {
  flex-shrink: 0;
}
.project-title {
  font-size: 16px;
  font-weight: 600;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub-genre {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  padding: 0 6px;
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.workflow {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.workspace-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.left-pane {
  width: 264px;
  flex-shrink: 0;
  border-right: 1px solid var(--el-border-color-lighter);
  overflow: hidden;
  min-height: 0;
  padding: 10px 8px;
}
.center-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 0 16px;
}
.right-resizer {
  width: 5px;
  flex-shrink: 0;
  cursor: col-resize;
  background: transparent;
  transition: background 0.2s;
}
.right-resizer:hover,
.right-resizer.active {
  background: var(--el-color-primary-light-7);
}
.right-pane {
  flex-shrink: 0;
  border-left: 1px solid var(--el-border-color-lighter);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
@media (max-width: 720px) {
  .right-resizer { display: none; }
  .right-pane { width: auto !important; }
}
.content-tabs {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.content-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
/* 面板定高：章节编辑器才能按 100% 撑满并让 textarea 内部滚动 */
.content-tabs :deep(.el-tab-pane) {
  height: 100%;
}
</style>
