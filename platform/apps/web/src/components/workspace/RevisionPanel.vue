<script setup lang="ts">
/** Durable rewrite progress remains visible after a browser or API restart. */
import { computed, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { getChapter, type Chapter } from '../../api/chapters';
import { listRevisions, proposeRevision, revisionAction, type Revision } from '../../api/revisions';

const props = defineProps<{ projectId: number; chapters: Chapter[] }>();
const emit = defineEmits<{ progress: [] }>();
const revision = ref<Revision | null>(null);
const start = ref(1);
const end = ref(1);
const busy = ref(false);
const error = ref('');
const manual = ref<Chapter | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let epoch = 0;
const active = computed(() => ['queued', 'running'].includes(revision.value?.status ?? ''));
const labels: Record<string, string> = { awaiting_confirmation: '等待确认', queued: '等待执行', running: '顺序重写中', paused: '已暂停', succeeded: '重写完成', stopped: '已停止后续重写' };
watch(() => props.chapters.map((c) => c.chapterNumber).join(','), () => {
  if (props.chapters.length) { start.value = props.chapters[0].chapterNumber; end.value = props.chapters.at(-1)!.chapterNumber; }
}, { immediate: true });

async function refresh(currentEpoch: number): Promise<void> {
  try {
    const rows = await listRevisions(props.projectId);
    if (disposed || currentEpoch !== epoch) return;
    const next = rows.find((r) => ['queued', 'running'].includes(r.status)) ?? rows[0] ?? null;
    if (next?.id === revision.value?.id && next?.completedChapters !== revision.value?.completedChapters) emit('progress');
    revision.value = next;
    error.value = '';
  } catch { if (currentEpoch === epoch) error.value = '重写进度暂时无法读取，正在重新连接'; }
  finally { if (!disposed && currentEpoch === epoch) timer = setTimeout(() => { void refresh(currentEpoch); }, 2500); }
}
watch(() => props.projectId, () => { clearTimeout(timer); revision.value = null; void refresh(++epoch); }, { immediate: true });
onUnmounted(() => { disposed = true; clearTimeout(timer); });

async function run(fn: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try { await fn(); } catch { /* Shared HTTP interceptor presents API failure details. */ }
  finally { busy.value = false; }
}
async function propose(): Promise<void> {
  await run(async () => { revision.value = await proposeRevision(props.projectId, { startChapter: start.value, endChapter: end.value }); });
}
async function act(action: 'confirm' | 'resume' | 'stop'): Promise<void> {
  const current = revision.value;
  if (!current) return;
  await run(async () => {
    revision.value = await revisionAction(props.projectId, current.id, action, action === 'confirm' ? { version: current.version } : undefined);
    ElMessage.success(action === 'stop' ? '已请求停止后续章节；已接受的本章任务仍可能完成' : '重写任务已提交');
  });
}
async function inspectManual(): Promise<void> {
  const item = revision.value?.chapters.find((c) => !c.completed);
  if (item) await run(async () => { manual.value = await getChapter(props.projectId, item.chapterId); });
}
async function approveManual(): Promise<void> {
  if (!revision.value || !manual.value) return;
  const current = revision.value; const chapterVersion = manual.value.version;
  await run(async () => {
    revision.value = await revisionAction(props.projectId, current.id, 'approve-manual', { chapterVersion });
    manual.value = null;
  });
}
</script>

<template>
  <section class="revision-panel" aria-label="顺序重写">
    <strong>修改资料后顺序重写</strong>
    <div class="range">
      <span>第</span><el-input-number v-model="start" :min="1" :controls="false" size="small" aria-label="起始章节" />
      <span>至</span><el-input-number v-model="end" :min="start" :controls="false" size="small" aria-label="结束章节" /><span>章</span>
      <el-button size="small" :disabled="active || !chapters.length" :loading="busy" @click="propose">查看重写计划</el-button>
    </div>
    <template v-if="revision">
      <p>{{ labels[revision.status] ?? revision.status }} · 第 {{ revision.startChapter }}–{{ revision.endChapter }} 章 · 已完成 {{ revision.completedChapters }}/{{ revision.totalChapters }}</p>
      <template v-if="revision.status === 'awaiting_confirmation'">
        <p v-for="reason in revision.reasons" :key="reason">{{ reason }}</p>
        <p>预算：每章最高 ¥{{ (revision.perChapterFen / 100).toFixed(2) }}，本次总额最高 ¥{{ (revision.totalFen / 100).toFixed(2) }}。每章最长 45 分钟，成功后立即替换；手工稿暂停确认。</p>
        <el-button type="primary" size="small" :loading="busy" @click="act('confirm')">确认范围并顺序重写</el-button>
      </template>
      <el-alert v-if="revision.pauseReason" :title="revision.pauseReason" type="warning" :closable="false" />
      <el-button v-if="revision.status === 'paused' && revision.pauseCode === 'generation_failed'" size="small" :loading="busy" @click="act('resume')">从失败章节继续</el-button>
      <el-button v-if="revision.status === 'paused' && revision.pauseCode === 'manual_chapter'" size="small" :loading="busy" @click="inspectManual">查看并确认手工稿</el-button>
      <el-button v-if="['queued', 'running', 'paused'].includes(revision.status)" size="small" :loading="busy" @click="act('stop')">停止后续重写</el-button>
    </template>
    <p v-if="error" role="status">{{ error }}</p>
    <el-dialog :model-value="!!manual" title="确认覆盖本章手工稿" width="75%" @close="manual = null">
      <template v-if="manual"><p>第 {{ manual.chapterNumber }} 章，版本 {{ manual.version }}。确认后将按最新资料重写并替换这份正文。</p><pre>{{ manual.content }}</pre></template>
      <template #footer><el-button @click="manual = null">保留并暂停</el-button><el-button type="primary" :loading="busy" @click="approveManual">确认重写此版本并继续</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.revision-panel { padding: 12px; border-bottom: 1px solid var(--el-border-color); font-size: 13px; }
.range { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin: 10px 0; }
.range :deep(.el-input-number) { width: 58px; }
pre { white-space: pre-wrap; max-height: 50vh; overflow: auto; }
</style>
