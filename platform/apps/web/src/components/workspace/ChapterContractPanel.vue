<script setup lang="ts">
/**
 * 章纲契约面板（作者侧审批闭环，章节级）。
 *
 * 口径：作者在 web 端编辑/粘贴专家契约提案 → 校验（preview）→ 确认提交（commit）。
 * commit 由 platform-api 完成「签发审批凭证 → 交回 runtime handoff commit → 事务落库」，
 * 客户端只提交提案文本与章节号，不接触内部签名，也不能自报 approvedBy。
 *
 * 已批准契约写入 `chapter_contract:ch{N}` / `chapter_contract_provenance:ch{N}`，
 * 生成链路只有在 provenance 为 committed 且 hash 一致时才会消费（否则结构化阻断）。
 */
import { computed, inject, onMounted, ref, watch, type Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { listDocuments, type NovelDocument } from '../../api/workspace';
import {
  commitChapterContract,
  previewChapterContract,
  type ChapterContractPreviewResult,
  type ChapterContractValidation,
} from '../../api/chapterContract';

const props = defineProps<{ projectId: number; chapterNumber: number }>();
const epoch = inject<Ref<number>>('materialEpoch');

const loading = ref(false);
const validating = ref(false);
const committing = ref(false);
const proposalText = ref('');
const expertRole = ref('');
const previewResult = ref<ChapterContractPreviewResult | null>(null);
const validation = ref<ChapterContractValidation | null>(null);
const approvedDoc = ref<NovelDocument | null>(null);
const provenance = ref<Record<string, unknown> | null>(null);

const contractType = computed(() => `chapter_contract:ch${props.chapterNumber}`);
const provenanceType = computed(() => `chapter_contract_provenance:ch${props.chapterNumber}`);
const approvedBy = computed(() => {
  const approval = provenance.value?.approval;
  if (approval && typeof approval === 'object') {
    const value = (approval as { approvedBy?: unknown }).approvedBy;
    return typeof value === 'string' ? value : '';
  }
  return '';
});
const proposalHash = computed(() => {
  const value = provenance.value?.proposalHash;
  return typeof value === 'string' ? value : '';
});
const commitStatus = computed(() => {
  const value = provenance.value?.commitStatus;
  return typeof value === 'string' ? value : '';
});

const errors = computed(() => validation.value?.errors ?? []);
const warnings = computed(() => validation.value?.warnings ?? []);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const rows = await listDocuments(props.projectId);
    approvedDoc.value = rows.find((item) => item.documentType === contractType.value) ?? null;
    const provenanceDoc = rows.find((item) => item.documentType === provenanceType.value) ?? null;
    provenance.value = readJson(provenanceDoc?.content);
  } finally {
    loading.value = false;
  }
}

function readJson(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readValidationFromError(error: unknown): ChapterContractValidation | null {
  const data = (error as { response?: { data?: { validation?: unknown } } }).response?.data;
  const value = data?.validation;
  return value && typeof value === 'object' ? value as ChapterContractValidation : null;
}

async function validate(): Promise<void> {
  if (!proposalText.value.trim()) {
    ElMessage.warning('请先填写专家契约提案');
    return;
  }
  validating.value = true;
  try {
    previewResult.value = await previewChapterContract(props.projectId, {
      chapterNumber: props.chapterNumber,
      proposalText: proposalText.value,
      expertRole: expertRole.value.trim() || undefined,
    });
    validation.value = previewResult.value.validation ?? null;
    ElMessage.success('提案校验通过，可以提交作者审批');
  } catch (error: unknown) {
    previewResult.value = null;
    validation.value = readValidationFromError(error);
    // 具体错误消息由 http 拦截器统一提示；这里保留结构化校验明细供逐项修正。
  } finally {
    validating.value = false;
  }
}

async function commit(): Promise<void> {
  if (!proposalText.value.trim()) {
    ElMessage.warning('请先填写专家契约提案');
    return;
  }
  if (approvedDoc.value) {
    try {
      await ElMessageBox.confirm(
        `第${props.chapterNumber}章已有批准稿，提交将替换现有章纲契约。确认继续？`,
        '替换已批准章纲',
        { type: 'warning', confirmButtonText: '替换', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  committing.value = true;
  try {
    const result = await commitChapterContract(props.projectId, {
      chapterNumber: props.chapterNumber,
      proposalText: proposalText.value,
      expertRole: expertRole.value.trim() || undefined,
      overwrite: approvedDoc.value ? true : undefined,
    });
    previewResult.value = result;
    validation.value = result.validation ?? null;
    ElMessage.success(`第${props.chapterNumber}章章纲契约已批准并保存`);
    await load();
  } catch (error: unknown) {
    validation.value = readValidationFromError(error);
  } finally {
    committing.value = false;
  }
}

function fillTemplate(): void {
  proposalText.value = [
    '## 章节功能',
    '',
    `- **章号**：第 ${props.chapterNumber} 章`,
    '- **职能**：推进',
    '- **缺失后果**：（若缺这一章，读者会失去什么）',
    '',
    '## 意图',
    '',
    '- **主意图**：（本章要兑现的核心意图）',
    '- **次意图**：（可留空）',
    '- **关键词**：（可留空）',
    '',
    '## 不可违背事实',
    '',
    '| 类型 | ID | 内容 | 违反后果 |',
    '|---|---|---|---|',
    '| FACT | FACT-01 | （已登记的事实） | （违反后果） |',
    '',
    '## 章末目标',
    '',
    '- **读者状态**：（读完后的情绪/认知状态）',
    '- **主角位置**：（章末主角所处的位置/处境）',
    '- **新问题**：（留给下一章的问题）',
    '- **强制召回**：不适用',
    '',
    '## 事件',
    '',
    '### 事件 1：（事件标题）',
    '',
    '- **参与角色**：（角色名）',
    '- **内容摘要**：（发生了什么）',
    '- **必须包含**：（必须出现的关键动作/信息）',
    '- **伏笔埋设**：（可留空）',
    '- **事件结果**：（事件结束时的状态改变）',
    '- **章末目标**：（该事件的收束目标）',
    '',
    '## 缺口自检',
    '',
    'status: ready',
    '',
    '| 项目 | 是否齐备 | 补充 |',
    '|---|---|---|',
    '| 前文状态 | 是 | — |',
    '| 人物动机 | 是 | — |',
    '',
  ].join('\n');
}

onMounted(() => {
  void load();
});
watch(() => props.chapterNumber, () => {
  previewResult.value = null;
  validation.value = null;
  void load();
});
watch(() => epoch?.value, () => {
  void load();
});
</script>

<template>
  <div class="chapter-contract-panel" v-loading="loading">
    <el-alert
      v-if="approvedDoc"
      type="success"
      :closable="false"
      show-icon
      class="approved-alert"
      :title="`第${chapterNumber}章已批准章纲契约${approvedBy ? `（${approvedBy}）` : ''}`"
    >
      <div class="approved-meta">
        <span>状态：{{ commitStatus || 'unknown' }}</span>
        <span>hash：{{ proposalHash.slice(0, 12) || '—' }}</span>
      </div>
    </el-alert>

    <el-alert
      v-else
      type="info"
      :closable="false"
      show-icon
      title="本章尚无已批准章纲契约；提交后才会进入生成链路。未提交时按现有种子自动生成章纲。"
    />

    <el-form label-position="top" class="proposal-form">
      <el-form-item label="专家角色（可选，仅审计标签）">
        <el-input v-model="expertRole" maxlength="200" placeholder="例如 chapter-intent-builder" />
      </el-form-item>
      <el-form-item label="专家契约提案（Markdown）">
        <el-input
          v-model="proposalText"
          type="textarea"
          resize="vertical"
          :autosize="{ minRows: 14, maxRows: 28 }"
          placeholder="粘贴专家提案，或点击「填入模板」后逐项填写必需内容。"
        />
      </el-form-item>
      <div class="form-actions">
        <el-button :disabled="committing" @click="fillTemplate">填入模板</el-button>
        <el-button type="primary" plain :loading="validating" :disabled="committing" @click="validate">
          校验提案
        </el-button>
        <el-button type="primary" :loading="committing" :disabled="validating" @click="commit">
          确认并提交（作者批准）
        </el-button>
      </div>
    </el-form>

    <el-alert
      v-if="errors.length > 0"
      type="error"
      :closable="false"
      class="issues"
      title="必需项未通过，提交会被阻断"
    >
      <ul>
        <li v-for="(issue, index) in errors" :key="'e' + index">{{ issue.message }}</li>
      </ul>
    </el-alert>
    <el-alert
      v-if="warnings.length > 0"
      type="warning"
      :closable="false"
      class="issues"
      title="建议确认（不阻断）"
    >
      <ul>
        <li v-for="(issue, index) in warnings" :key="'w' + index">{{ issue.message }}</li>
      </ul>
    </el-alert>

    <div v-if="previewResult" class="preview">
      <div class="preview-head">
        <strong>规范化章纲预览</strong>
        <el-tag size="small">hash {{ previewResult.proposalHash.slice(0, 12) }}</el-tag>
      </div>
      <pre class="preview-body">{{ previewResult.outlineMarkdown }}</pre>
    </div>

    <div v-if="approvedDoc" class="approved">
      <strong>{{ approvedDoc.title }}</strong>
      <pre class="preview-body">{{ approvedDoc.content }}</pre>
    </div>
  </div>
</template>

<style scoped>
.chapter-contract-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
  padding: 8px 4px;
}
.approved-alert,
.issues {
  flex-shrink: 0;
}
.approved-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  margin-top: 4px;
}
.proposal-form {
  flex-shrink: 0;
}
.form-actions {
  display: flex;
  gap: 8px;
}
.preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.preview-body {
  margin: 0;
  padding: 12px 14px;
  background: #f7f8fa;
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
  font-family: inherit;
  max-height: 320px;
  overflow: auto;
}
.approved {
  flex-shrink: 0;
}
</style>
