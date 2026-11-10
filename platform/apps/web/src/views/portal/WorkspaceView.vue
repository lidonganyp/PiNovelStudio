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
import ChapterContractPanel from '../../components/workspace/ChapterContractPanel.vue';
import DocumentPanel from '../../components/workspace/DocumentPanel.vue';
import VersionPanel from '../../components/workspace/VersionPanel.vue';
import AssistantWorkspace from '../../components/workspace/chat/AssistantWorkspace.vue';
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

/** 聊天流任务跟踪入口：AssistantWorkspace 注册（生成状态卡片进聊天流，随内容滚动）。 */
const trackJob = ref<((jobId: string, chapterNumber?: number) => void) | null>(null);
const materialEpoch = ref(0);
provide('registerTrackJob', (fn: (jobId: string, chapterNumber?: number) => void) => { trackJob.value = fn; });
/** 次要资料页：收进『更多』下拉，一级界面只留章节与大纲。 */
const SECONDARY_TABS = [
  { value: 'seed', label: '种子（本章）' },
  { value: 'contract', label: '章纲契约（本章）' },
  { value: 'characters', label: '角色（全书）' },
  { value: 'documents', label: '文档（全书）' },
  { value: 'versions', label: '版本' },
  { value: 'revision', label: '整书重写' },
  { value: 'feedback', label: '反馈' },
] as const;
const secondaryLabel = computed(() => SECONDARY_TABS.find((tab) => tab.value === activeTab.value)?.label ?? '');
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
  trackJob.value?.(job.jobId, activeChapter.value.chapterNumber);
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
const DEFAULT_RIGHT_WIDTH = 460;
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
  const max = Math.max(320, Math.min(960, window.innerWidth - 520));
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
        <div class="pane-toolbar">
          <div class="pane-tabs">
            <button type="button" class="pane-tab" :class="{ active: activeTab === 'chapter' }" @click="activeTab = 'chapter'">章节</button>
            <button type="button" class="pane-tab" :class="{ active: activeTab === 'outline' }" @click="activeTab = 'outline'">大纲</button>
            <button
              v-if="secondaryLabel"
              type="button"
              class="pane-tab active"
              title="点击返回章节"
              @click="activeTab = 'chapter'"
            >{{ secondaryLabel }} ✕</button>
          </div>
          <el-dropdown trigger="click" @command="(tab: string | number | object) => (activeTab = String(tab))">
            <el-button size="small" class="more-btn">更多资料</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="tab in SECONDARY_TABS" :key="tab.value" :command="tab.value">{{ tab.label }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <div class="pane-content">
          <template v-if="activeTab === 'chapter'">
            <ChapterEditor
              v-if="activeChapter"
              :key="activeChapter.id + '-' + activeChapter.version"
              :project-id="projectId"
              :chapter="activeChapter"
              @updated="patchChapter"
            />
            <el-empty v-else description="左侧新建或选择一个章节" />
          </template>
          <OutlinePanel v-if="activeTab === 'outline'" :project-id="projectId" />
          <template v-if="activeTab === 'seed'">
            <SeedEditor
              v-if="activeChapter"
              :key="'seed-' + activeChapter.id + '-' + (activeChapter.seed?.version ?? 0)"
              :project-id="projectId"
              :chapter="activeChapter"
              @updated="patchChapter"
              @generate="startGeneration"
            />
            <el-empty v-else description="先选择一个章节" />
          </template>
          <template v-if="activeTab === 'contract'">
            <ChapterContractPanel
              v-if="activeChapter"
              :key="'contract-' + activeChapter.id"
              :project-id="projectId"
              :chapter-number="activeChapter.chapterNumber"
            />
            <el-empty v-else description="先选择一个章节" />
          </template>
          <CharacterPanel v-if="activeTab === 'characters'" :project-id="projectId" />
          <DocumentPanel v-if="activeTab === 'documents'" :project-id="projectId" />
          <template v-if="activeTab === 'versions'">
            <VersionPanel
              v-if="activeChapter"
              :project-id="projectId"
              :chapter="activeChapter"
              @restored="patchChapter"
            />
            <el-empty v-else description="先选择一个章节" />
          </template>
          <RevisionPanel v-if="activeTab === 'revision'" :project-id="projectId" :chapters="chapters" @progress="loadChapters" />
          <FeedbackPanel v-if="activeTab === 'feedback'" :project-id="projectId" :chapter-id="activeChapterId" />
        </div>
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
.pane-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
}
.pane-tabs { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.pane-tab { padding: 5px 14px; border: 0; background: transparent; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--el-text-color-regular); }
.pane-tab:hover { background: var(--el-fill-color-light); }
.pane-tab.active { background: var(--el-color-primary); color: #fff; }
.pane-content { flex: 1; min-height: 0; overflow-y: auto; }
</style>
