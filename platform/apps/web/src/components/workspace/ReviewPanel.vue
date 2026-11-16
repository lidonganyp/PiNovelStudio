<script setup lang="ts">
/**
 * 章节内容评审建议卡片（advisory 模式）。
 * 评审结论仅供作者参考：章节生成成功即落盘展示，评审不阻断交付；
 * 作者三选一：保留 / 直接重新生成 / 修改大纲后重新生成。
 * 评审失败或不可用时展示降级态，支持手动重新评审。
 */
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Loading } from '@element-plus/icons-vue';
import {
  getChapterReview,
  requestChapterReview,
  submitChapterDecision,
  type ChapterReviewAdvice,
  type Chapter,
} from '../../api/chapters';

const props = defineProps<{
  projectId: number;
  chapter: Chapter | null;
}>();

const emit = defineEmits<{
  /** 决策触发了重新生成任务，父级据此接入生成进度轮询。 */
  'track-job': [jobId: string];
  /** 章节数据需要刷新（保留定稿 / 新版本落盘后）。 */
  'chapter-changed': [];
}>();

const review = ref<ChapterReviewAdvice | null>(null);
const loading = ref(false);
const reviewing = ref(false);
const deciding = ref(false);
const reviseDialogVisible = ref(false);
const revisedIntent = ref('');

const verdictMeta = computed(
  (): { text: string; type: 'success' | 'warning' | 'danger' | 'info' } => {
    switch (review.value?.verdict) {
      case 'approve':
        return { text: '建议通过', type: 'success' };
      case 'hold':
        return { text: '建议持有', type: 'warning' };
      case 'reject':
        return { text: '建议不通过', type: 'danger' };
      default:
        return { text: '暂无结论', type: 'info' };
    }
  },
);

const isPending = computed(() => review.value?.status === 'pending');
const isUnavailable = computed(
  () => review.value?.status === 'failed' || review.value?.status === 'disabled',
);
/** 评审完成且与当前章节版本一致时才展示决策按钮（过期评审不引导决策）。 */
const canDecide = computed(
  () =>
    review.value?.status === 'completed' &&
    props.chapter !== null &&
    review.value.chapterVersion === props.chapter.version,
);

async function loadReview(): Promise<void> {
  if (!props.chapter) {
    review.value = null;
    return;
  }
  loading.value = true;
  try {
    review.value = await getChapterReview(props.projectId, props.chapter.id);
  } catch {
    review.value = null;
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.chapter?.id, props.chapter?.version],
  () => {
    void loadReview();
  },
  { immediate: true },
);

/** 手动重新评审（评审失败/不可用后的重试入口）。 */
async function retryReview(): Promise<void> {
  if (!props.chapter || reviewing.value) return;
  reviewing.value = true;
  try {
    review.value = await requestChapterReview(props.projectId, props.chapter.id);
    if (review.value.status === 'failed') {
      ElMessage.warning('评审仍不可用，可稍后再次尝试');
    } else {
      ElMessage.success('评审已完成');
    }
  } catch {
    ElMessage.error('重新评审请求失败');
  } finally {
    reviewing.value = false;
  }
}

async function decide(
  decision: 'keep' | 'regenerate' | 'revise_outline',
  intent?: string,
): Promise<void> {
  if (!props.chapter || deciding.value) return;
  deciding.value = true;
  try {
    const result = await submitChapterDecision(props.projectId, props.chapter.id, {
      decision,
      expectedVersion: props.chapter.version,
      revisedIntent: intent,
    });
    if (decision === 'keep') {
      ElMessage.success('已保留当前章节为定稿');
      emit('chapter-changed');
    } else {
      const jobId = result.job?.jobId;
      if (jobId) {
        ElMessage.success('重新生成任务已提交');
        emit('track-job', jobId);
      } else {
        ElMessage.warning('决策已记录，但生成任务未返回');
      }
      reviseDialogVisible.value = false;
    }
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 409) {
      ElMessage.error('章节版本已变化，请刷新后重试');
      emit('chapter-changed');
    } else {
      ElMessage.error('决策提交失败');
    }
  } finally {
    deciding.value = false;
  }
}

async function onRegenerate(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将沿用当前大纲与上下文重新生成本章，旧版本保留在历史版本中。',
      '直接重新生成',
      { confirmButtonText: '重新生成', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  await decide('regenerate');
}

function openReviseDialog(): void {
  revisedIntent.value = props.chapter?.seed?.intent ?? '';
  reviseDialogVisible.value = true;
}

async function confirmRevise(): Promise<void> {
  if (!revisedIntent.value.trim()) {
    ElMessage.warning('请填写修改后的本章要求');
    return;
  }
  await decide('revise_outline', revisedIntent.value.trim());
}
</script>

<template>
  <section v-if="chapter" class="review-panel" v-loading="loading">
    <header class="review-head">
      <span class="review-title">内容评审建议</span>
      <el-tag v-if="review" size="small" :type="verdictMeta.type">
        {{ verdictMeta.text }}
      </el-tag>
      <el-tag v-else size="small" type="info">暂无评审</el-tag>
    </header>

    <!-- 评审进行中 -->
    <div v-if="isPending" class="review-body">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span class="muted">评审进行中，完成后自动展示建议…</span>
    </div>

    <!-- 评审失败 / 不可用：降级展示，不影响章节交付 -->
    <div v-else-if="isUnavailable" class="review-body">
      <p class="muted">评审暂不可用{{ review?.error ? `：${review.error}` : '' }}</p>
      <el-button size="small" :loading="reviewing" @click="retryReview">
        重新评审
      </el-button>
    </div>

    <!-- 评审完成 -->
    <template v-else-if="review?.status === 'completed'">
      <div class="review-body">
        <p v-if="review.rationale" class="rationale">{{ review.rationale }}</p>
        <template v-if="review.risks.length">
          <div class="block-title">风险提示</div>
          <ul class="risk-list">
            <li v-for="(risk, i) in review.risks" :key="i">{{ risk }}</li>
          </ul>
        </template>
        <template v-if="review.evidenceSpans.length">
          <div class="block-title">证据片段（正文原文）</div>
          <blockquote
            v-for="(span, i) in review.evidenceSpans"
            :key="i"
            class="evidence"
          >
            {{ span }}
          </blockquote>
        </template>
        <p v-if="review.error" class="muted small">{{ review.error }}</p>
        <p v-if="review.chapterVersion !== chapter.version" class="muted small">
          该评审基于历史版本（v{{ review.chapterVersion }}），当前为 v{{ chapter.version }}，仅供参考。
        </p>
        <p class="muted small">
          模型 {{ review.model || '未知' }}
          <template v-if="review.durationMs !== null">
            · 耗时 {{ Math.round(review.durationMs / 100) / 10 }}s
          </template>
          · {{ new Date(review.reviewedAt).toLocaleString() }}
        </p>
      </div>
      <footer v-if="canDecide" class="review-actions">
        <el-button size="small" type="success" :loading="deciding" @click="decide('keep')">
          保留
        </el-button>
        <el-button size="small" type="warning" :loading="deciding" @click="onRegenerate">
          直接重新生成
        </el-button>
        <el-button size="small" type="primary" :loading="deciding" @click="openReviseDialog">
          修改大纲后重新生成
        </el-button>
      </footer>
    </template>

    <div v-else class="review-body">
      <p class="muted">章节生成后将自动进行内容评审，结论仅供参考，不影响章节保存。</p>
    </div>

    <!-- 修改大纲后重新生成 -->
    <el-dialog
      v-model="reviseDialogVisible"
      title="修改大纲后重新生成"
      width="560px"
      :close-on-click-modal="false"
    >
      <p class="muted small">修改本章的创作要求（章纲意图），将基于修改后的要求重新生成本章。</p>
      <el-input
        v-model="revisedIntent"
        type="textarea"
        :rows="6"
        maxlength="5000"
        show-word-limit
        placeholder="请输入修改后的本章要求"
      />
      <template #footer>
        <el-button @click="reviseDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="deciding" @click="confirmRevise">
          提交并重新生成
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.review-panel {
  border-top: 1px solid var(--el-border-color-lighter);
  padding: 12px 16px;
}
.review-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.review-title {
  font-weight: 600;
  font-size: 13px;
}
.review-body {
  font-size: 13px;
  line-height: 1.6;
}
.rationale {
  margin: 4px 0 8px;
}
.block-title {
  font-weight: 600;
  font-size: 12px;
  margin: 8px 0 4px;
  color: var(--el-text-color-regular);
}
.risk-list {
  margin: 0;
  padding-left: 18px;
  color: var(--el-color-warning-dark-2);
}
.evidence {
  margin: 4px 0;
  padding: 4px 10px;
  border-left: 3px solid var(--el-border-color);
  color: var(--el-text-color-secondary);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
.muted {
  color: var(--el-text-color-secondary);
}
.small {
  font-size: 12px;
  margin: 4px 0;
}
.review-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
</style>
