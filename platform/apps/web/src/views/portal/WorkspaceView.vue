<script setup lang="ts">
/**
 * P5-2 三栏工作台主容器：
 * 左=章节目录树；中=内容区（章节/种子/角色/文档/版本 tabs）；右=助手对话 + 生成任务面板。
 * 生成流程：SeedEditor 保存种子 → 提交生成 → GenerationPanel 轮询 → 成功后刷新章节。
 */
import { computed, onMounted, provide, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
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
import DocumentPanel from '../../components/workspace/DocumentPanel.vue';
import VersionPanel from '../../components/workspace/VersionPanel.vue';
import AssistantPanel from '../../components/workspace/AssistantPanel.vue';
import GenerationPanel from '../../components/workspace/GenerationPanel.vue';
import FeedbackPanel from '../../components/workspace/FeedbackPanel.vue';

const route = useRoute();
const projectId = computed(() => Number(route.params.id));

const project = ref<Project | null>(null);
const chapters = ref<Chapter[]>([]);
const chaptersLoading = ref(false);
const activeChapterId = ref<number | null>(null);
const activeTab = ref('chapter');

/** GenerationPanel 通过 provide/inject 拿到 track 入口。 */
const trackJob = ref<((jobId: string) => void) | null>(null);
provide('trackJob', (jobId: string) => trackJob.value?.(jobId));

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
  if (index >= 0) chapters.value[index] = next;
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
  project.value = await getProject(projectId.value);
  await loadChapters();
});

defineExpose({ loadChapters, patchChapter });
</script>

<template>
  <div v-if="project" class="workspace">
    <div class="workspace-header">
      <span class="project-title" :title="project.title">{{ project.title }}</span>
      <el-tag v-if="project.genre" size="small">{{ project.genre }}</el-tag>
      <span v-for="sub in project.subGenres" :key="sub" class="sub-genre">{{ sub }}</span>
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
          <el-tab-pane label="种子" name="seed">
            <SeedEditor
              v-if="activeChapter"
              :project-id="projectId"
              :chapter="activeChapter"
              @updated="patchChapter"
              @generate="startGeneration"
            />
            <el-empty v-else description="先选择一个章节" />
          </el-tab-pane>
          <el-tab-pane label="角色" name="characters" lazy>
            <CharacterPanel :project-id="projectId" />
          </el-tab-pane>
          <el-tab-pane label="文档" name="documents" lazy>
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

      <aside class="right-pane">
        <GenerationPanel
          :project-id="projectId"
          :chapter="activeChapter"
          @register-track="(fn) => (trackJob = fn)"
          @succeeded="loadChapters"
        />
        <AssistantPanel :project-id="projectId" />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 60px);
  margin: -20px;
}
.workspace-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--el-border-color);
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
}
.workflow {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.workspace-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.left-pane {
  width: 260px;
  flex-shrink: 0;
  border-right: 1px solid var(--el-border-color);
  overflow-y: auto;
  padding: 8px;
}
.center-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 0 12px;
}
.right-pane {
  width: 360px;
  flex-shrink: 0;
  border-left: 1px solid var(--el-border-color);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.content-tabs {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.content-tabs :deep(.el-tabs__content) {
  flex: 1;
  overflow-y: auto;
}
</style>
