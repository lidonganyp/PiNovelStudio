<script setup lang="ts">
/**
 * 用户反馈管理：分页列表、筛选、详情抽屉、回复（纯文本，禁止 v-html）。
 */
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  getAdminFeedback,
  listAdminFeedback,
  replyAdminFeedback,
  type AdminFeedbackItem,
  type AdminFeedbackList,
  type AdminFeedbackStatus,
  type AdminFeedbackType,
} from '../../api/admin';

const TYPE_LABELS: Record<string, string> = {
  quality: '文学质量',
  factual: '事实问题',
  other: '其他',
};

const STATUS_LABELS: Record<AdminFeedbackStatus, string> = {
  pending: '待处理',
  replied: '已回复',
};

const loading = ref(false);
const replyLoading = ref(false);
const keyword = ref('');
const typeFilter = ref<AdminFeedbackType | undefined>(undefined);
const statusFilter = ref<AdminFeedbackStatus | undefined>(undefined);
const data = ref<AdminFeedbackList>({ items: [], total: 0, page: 1, pageSize: 20 });
const drawer = ref(false);
const detail = ref<AdminFeedbackItem | null>(null);
const replyDraft = ref('');

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

function statusLabel(status: string): string {
  return status === 'replied' ? STATUS_LABELS.replied : STATUS_LABELS.pending;
}

function summarize(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

async function load(page = 1): Promise<void> {
  loading.value = true;
  try {
    data.value = await listAdminFeedback({
      page,
      pageSize: 20,
      q: keyword.value.trim() || undefined,
      type: typeFilter.value,
      status: statusFilter.value,
    });
  } finally {
    loading.value = false;
  }
}

async function openFeedback(id: number): Promise<void> {
  const row = await getAdminFeedback(id);
  detail.value = row;
  replyDraft.value = row.replyContent ?? '';
  drawer.value = true;
}

function onRowClick(row: AdminFeedbackItem): void {
  void openFeedback(row.id);
}

async function onReply(): Promise<void> {
  if (!detail.value) return;
  const content = replyDraft.value.trim();
  if (!content) {
    ElMessage.warning('请填写回复内容');
    return;
  }
  if (content.length > 5000) {
    ElMessage.warning('回复内容不能超过 5000 字');
    return;
  }
  replyLoading.value = true;
  try {
    detail.value = await replyAdminFeedback(detail.value.id, content);
    replyDraft.value = detail.value.replyContent ?? content;
    ElMessage.success('回复已保存');
    await load(data.value.page);
  } catch {
    /* 错误提示由 http 拦截器弹出；保留编辑内容 */
  } finally {
    replyLoading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <el-card data-testid="admin-feedback-page">
    <template #header>
      <div class="toolbar">
        <span>用户反馈</span>
        <el-input
          v-model="keyword"
          placeholder="邮箱、昵称、项目或内容关键词"
          clearable
          class="search"
          data-testid="admin-feedback-keyword"
          @keyup.enter="load(1)"
          @clear="load(1)"
        />
        <el-select
          v-model="typeFilter"
          placeholder="反馈类型"
          clearable
          class="filter"
          data-testid="admin-feedback-type"
          @change="load(1)"
        >
          <el-option label="文学质量" value="quality" />
          <el-option label="事实问题" value="factual" />
          <el-option label="其他" value="other" />
        </el-select>
        <el-select
          v-model="statusFilter"
          placeholder="处理状态"
          clearable
          class="filter"
          data-testid="admin-feedback-status"
          @change="load(1)"
        >
          <el-option label="待处理" value="pending" />
          <el-option label="已回复" value="replied" />
        </el-select>
        <el-button type="primary" @click="load(1)">筛选</el-button>
      </div>
    </template>
    <el-table
      v-loading="loading"
      :data="data.items"
      stripe
      data-testid="admin-feedback-table"
      @row-click="onRowClick"
    >
      <el-table-column prop="createdAt" label="反馈时间" min-width="180" />
      <el-table-column label="用户" min-width="200">
        <template #default="{ row }">
          {{ row.userEmail }} / {{ row.userNickname }}
        </template>
      </el-table-column>
      <el-table-column prop="projectTitle" label="项目名称" min-width="140" />
      <el-table-column label="章节号" width="80">
        <template #default="{ row }">
          {{ row.chapterNumber ?? '—' }}
        </template>
      </el-table-column>
      <el-table-column label="反馈类型" width="100">
        <template #default="{ row }">{{ typeLabel(row.type) }}</template>
      </el-table-column>
      <el-table-column label="反馈内容摘要" min-width="200">
        <template #default="{ row }">{{ summarize(row.content) }}</template>
      </el-table-column>
      <el-table-column label="当前状态" width="90">
        <template #default="{ row }">{{ statusLabel(row.status) }}</template>
      </el-table-column>
      <el-table-column label="回复时间" min-width="180">
        <template #default="{ row }">{{ row.repliedAt ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" link @click.stop="openFeedback(row.id)">
            {{ row.status === 'replied' ? '查看' : '回复' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination
      class="pager"
      background
      layout="total, prev, pager, next"
      :total="data.total"
      :page-size="data.pageSize"
      :current-page="data.page"
      @current-change="load"
    />
  </el-card>

  <el-drawer
    v-model="drawer"
    size="520px"
    :title="detail ? `反馈 #${detail.id}` : '反馈详情'"
    data-testid="admin-feedback-drawer"
  >
    <template v-if="detail">
      <h4>完整反馈内容</h4>
      <p class="plain">{{ detail.content }}</p>
      <h4>项目与章节</h4>
      <p class="plain">
        {{ detail.projectTitle }} · 第 {{ detail.chapterNumber ?? '—' }} 章
        {{ detail.chapterTitle ? `「${detail.chapterTitle}」` : '' }}
      </p>
      <h4>用户信息</h4>
      <p class="plain">{{ detail.userEmail }} / {{ detail.userNickname }}</p>
      <h4>当前状态</h4>
      <p class="plain">{{ statusLabel(detail.status) }}</p>
      <h4>管理员回复</h4>
      <p v-if="detail.replyContent" class="plain">{{ detail.replyContent }}</p>
      <p v-else class="muted">尚未回复</p>
      <p v-if="detail.repliedAt" class="muted">
        回复时间 {{ detail.repliedAt }}
        <span v-if="detail.adminNickname"> · {{ detail.adminNickname }}</span>
      </p>
      <el-form label-position="top" class="reply-form">
        <el-form-item :label="detail.status === 'replied' ? '编辑回复' : '填写回复'">
          <div data-testid="admin-feedback-reply">
            <el-input
              v-model="replyDraft"
              type="textarea"
              :rows="6"
              maxlength="5000"
              show-word-limit
            />
          </div>
        </el-form-item>
        <el-button
          type="primary"
          :loading="replyLoading"
          data-testid="admin-feedback-submit"
          @click="onReply"
        >
          提交回复
        </el-button>
      </el-form>
    </template>
  </el-drawer>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.search {
  width: 260px;
  margin-left: auto;
}
.filter {
  width: 140px;
}
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
.plain {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0 0 12px;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin: 0 0 12px;
}
.reply-form {
  margin-top: 16px;
}
h4 {
  margin: 12px 0 6px;
  font-size: 14px;
}
</style>
