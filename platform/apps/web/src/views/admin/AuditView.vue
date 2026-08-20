<script setup lang="ts">
/**
 * 审计日志：只读列表，可按 action 筛选。
 */
import { onMounted, ref } from 'vue';
import { listAuditLogs, type AuditLogList } from '../../api/admin';

const loading = ref(false);
const action = ref('');
const data = ref<AuditLogList>({ items: [], total: 0, page: 1, pageSize: 20 });

async function load(page = 1): Promise<void> {
  loading.value = true;
  try {
    data.value = await listAuditLogs({
      page,
      pageSize: 20,
      action: action.value.trim() || undefined,
    });
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <el-card>
    <template #header>
      <div class="head">
        <span>审计日志</span>
        <el-input
          v-model="action"
          placeholder="action，如 user.adjust"
          clearable
          class="filter"
          @keyup.enter="load(1)"
          @clear="load(1)"
        />
        <el-button type="primary" @click="load(1)">筛选</el-button>
      </div>
    </template>
    <el-table v-loading="loading" :data="data.items" stripe>
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column prop="createdAt" label="时间" min-width="180" />
      <el-table-column prop="actorType" label="主体" width="90" />
      <el-table-column prop="actorId" label="主体 ID" width="90" />
      <el-table-column prop="action" label="动作" min-width="140" />
      <el-table-column prop="targetType" label="对象" width="120" />
      <el-table-column prop="targetId" label="对象 ID" width="100" />
      <el-table-column label="详情" min-width="220">
        <template #default="{ row }">
          <code class="detail">{{ JSON.stringify(row.detail) }}</code>
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
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.filter {
  width: 240px;
  margin-left: auto;
}
.detail {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
