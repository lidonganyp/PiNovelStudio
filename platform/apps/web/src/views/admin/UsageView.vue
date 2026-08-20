<script setup lang="ts">
/**
 * 用量报表：按模型 / 用户 / 日聚合，并可下钻到逐调用明细。
 */
import { computed, onMounted, ref } from 'vue';
import { fenToYuan } from '../../api/billing';
import {
  getUsageSummary,
  listUsageRecords,
  type UsageRecordList,
  type UsageSummaryRow,
} from '../../api/admin';

const groupBy = ref<'model' | 'user' | 'day'>('model');
const summary = ref<UsageSummaryRow[]>([]);
const records = ref<UsageRecordList>({ items: [], total: 0, page: 1, pageSize: 20 });
const filterModel = ref<string | undefined>(undefined);
const filterUserId = ref<number | undefined>(undefined);
const loading = ref(false);

const summaryTotalFen = computed(() =>
  summary.value.reduce((acc, row) => acc + Number(row.charge), 0),
);

async function loadSummary(): Promise<void> {
  summary.value = await getUsageSummary(groupBy.value);
}

async function loadRecords(page = 1): Promise<void> {
  loading.value = true;
  try {
    records.value = await listUsageRecords({
      page,
      pageSize: 20,
      model: filterModel.value,
      userId: filterUserId.value,
    });
  } finally {
    loading.value = false;
  }
}

function onGroupChange(): void {
  void loadSummary();
}

function drill(row: UsageSummaryRow): void {
  filterModel.value = row.model;
  filterUserId.value = row.userId;
  void loadRecords(1);
}

onMounted(async () => {
  await Promise.all([loadSummary(), loadRecords()]);
});
</script>

<template>
  <el-card>
    <template #header>
      <div class="head">
        <span>用量汇总</span>
        <el-radio-group v-model="groupBy" @change="onGroupChange">
          <el-radio-button label="model">按模型</el-radio-button>
          <el-radio-button label="user">按用户</el-radio-button>
          <el-radio-button label="day">按日</el-radio-button>
        </el-radio-group>
      </div>
    </template>
    <p class="hint">汇总合计 ¥{{ (summaryTotalFen / 100).toFixed(2) }}（点击行可下钻明细）</p>
    <el-table :data="summary" stripe @row-click="drill">
      <el-table-column v-if="groupBy === 'model'" prop="model" label="模型" />
      <el-table-column v-if="groupBy === 'user'" prop="userId" label="用户 ID" />
      <el-table-column v-if="groupBy === 'day'" prop="day" label="日期" />
      <el-table-column prop="calls" label="调用次数" width="110" />
      <el-table-column label="金额" width="120">
        <template #default="{ row }">¥{{ fenToYuan(row.charge) }}</template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-card class="records">
    <template #header>用量明细</template>
    <el-table v-loading="loading" :data="records.items" stripe>
      <el-table-column prop="createdAt" label="时间" min-width="180" />
      <el-table-column prop="userId" label="用户" width="80" />
      <el-table-column prop="model" label="模型" min-width="160" />
      <el-table-column label="tokens" width="140">
        <template #default="{ row }">{{ row.tokensIn }} / {{ row.tokensOut }}</template>
      </el-table-column>
      <el-table-column label="金额" width="110">
        <template #default="{ row }">¥{{ fenToYuan(row.actualCharge) }}</template>
      </el-table-column>
    </el-table>
    <el-pagination
      class="pager"
      background
      layout="total, prev, pager, next"
      :total="records.total"
      :page-size="records.pageSize"
      :current-page="records.page"
      @current-change="loadRecords"
    />
  </el-card>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.hint {
  margin: 0 0 12px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.records {
  margin-top: 16px;
}
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
