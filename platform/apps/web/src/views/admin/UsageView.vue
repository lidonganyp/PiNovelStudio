<script setup lang="ts">
/**
 * 用量消耗：时间范围卡片 + 趋势 + 模型/用户分布 + 明细（简化版 sub2api 用量页）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import { fenToYuan } from '../../api/billing';
import {
  getUsageDashboard,
  listUsageRecords,
  type UsageDashboard,
  type UsageRecordList,
} from '../../api/admin';

type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'custom';

const preset = ref<Preset>('7d');
const customRange = ref<[string, string] | null>(null);
const dashboard = ref<UsageDashboard | null>(null);
const records = ref<UsageRecordList>({ items: [], total: 0, page: 1, pageSize: 20 });
const filterModel = ref<string | undefined>(undefined);
const filterUserId = ref<number | undefined>(undefined);
const loading = ref(false);
const chartEl = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

function utcDay(offset = 0): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

const range = computed<{ from: string; to: string }>(() => {
  if (preset.value === 'today') return { from: utcDay(0), to: utcDay(0) };
  if (preset.value === 'yesterday') return { from: utcDay(-1), to: utcDay(-1) };
  if (preset.value === '30d') return { from: utcDay(-29), to: utcDay(0) };
  if (preset.value === 'custom' && customRange.value) {
    return { from: customRange.value[0], to: customRange.value[1] };
  }
  return { from: utcDay(-6), to: utcDay(0) };
});

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

function renderChart(): void {
  if (!chartEl.value || !dashboard.value) return;
  if (!chart) chart = echarts.init(chartEl.value);
  const days = dashboard.value.trend;
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['请求', '金额(元)'] },
    xAxis: { type: 'category', data: days.map((row) => row.day) },
    yAxis: [
      { type: 'value', name: '请求' },
      { type: 'value', name: '元' },
    ],
    series: [
      { name: '请求', type: 'bar', data: days.map((row) => row.calls) },
      {
        name: '金额(元)',
        type: 'line',
        yAxisIndex: 1,
        data: days.map((row) => Number(fenToYuan(row.charge))),
      },
    ],
  });
}

async function loadDashboard(): Promise<void> {
  dashboard.value = await getUsageDashboard(range.value);
  await nextTick();
  renderChart();
}

async function loadRecords(page = 1): Promise<void> {
  loading.value = true;
  try {
    records.value = await listUsageRecords({
      page,
      pageSize: 20,
      model: filterModel.value,
      userId: filterUserId.value,
      from: range.value.from,
      to: range.value.to,
    });
  } finally {
    loading.value = false;
  }
}

async function reload(): Promise<void> {
  await Promise.all([loadDashboard(), loadRecords(1)]);
}

function drillModel(row: { model: string }): void {
  filterModel.value = row.model;
  filterUserId.value = undefined;
  void loadRecords(1);
}

function drillUser(row: { userId: number }): void {
  filterUserId.value = row.userId;
  filterModel.value = undefined;
  void loadRecords(1);
}

watch(preset, () => {
  if (preset.value !== 'custom') void reload();
});

onMounted(async () => {
  await reload();
  window.addEventListener('resize', renderChart);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', renderChart);
  chart?.dispose();
});
</script>

<template>
  <div class="usage">
    <div class="toolbar">
      <el-radio-group v-model="preset">
        <el-radio-button label="today">今天</el-radio-button>
        <el-radio-button label="yesterday">昨天</el-radio-button>
        <el-radio-button label="7d">近 7 天</el-radio-button>
        <el-radio-button label="30d">近 30 天</el-radio-button>
        <el-radio-button label="custom">自定义</el-radio-button>
      </el-radio-group>
      <el-date-picker
        v-if="preset === 'custom'"
        v-model="customRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        start-placeholder="开始"
        end-placeholder="结束"
        @change="reload"
      />
    </div>

    <el-row :gutter="12" class="cards">
      <el-col :span="6">
        <el-card shadow="never">
          <p class="label">请求次数</p>
          <p class="value">{{ dashboard?.cards.requests ?? '-' }}</p>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <p class="label">Token（入/出）</p>
          <p class="value">
            {{ dashboard ? formatTokens(dashboard.cards.tokensIn + dashboard.cards.tokensOut) : '-' }}
          </p>
          <p class="sub">
            {{ dashboard ? `${formatTokens(dashboard.cards.tokensIn)} / ${formatTokens(dashboard.cards.tokensOut)}` : '' }}
          </p>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <p class="label">消耗金额</p>
          <p class="value">¥{{ dashboard ? fenToYuan(dashboard.cards.charge) : '-' }}</p>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <p class="label">活跃用户</p>
          <p class="value">{{ dashboard?.cards.users ?? '-' }}</p>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="chart-card">
      <template #header>用量趋势</template>
      <div ref="chartEl" class="chart" />
    </el-card>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card>
          <template #header>模型分布（点击下钻）</template>
          <el-table :data="dashboard?.byModel ?? []" stripe max-height="320" @row-click="drillModel">
            <el-table-column prop="model" label="模型" min-width="140" />
            <el-table-column prop="calls" label="请求" width="80" />
            <el-table-column label="金额" width="100">
              <template #default="{ row }">¥{{ fenToYuan(row.charge) }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header>用户分布（点击下钻）</template>
          <el-table :data="dashboard?.byUser ?? []" stripe max-height="320" @row-click="drillUser">
            <el-table-column prop="email" label="用户" min-width="160" />
            <el-table-column prop="calls" label="请求" width="80" />
            <el-table-column label="金额" width="100">
              <template #default="{ row }">¥{{ fenToYuan(row.charge) }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="records">
      <template #header>
        <div class="head">
          <span>用量明细</span>
          <el-button
            v-if="filterModel || filterUserId"
            size="small"
            @click="filterModel = undefined; filterUserId = undefined; loadRecords(1)"
          >
            清除筛选
          </el-button>
        </div>
      </template>
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
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.cards {
  margin-bottom: 16px;
}
.label {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.value {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
}
.sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.chart-card {
  margin-bottom: 16px;
}
.chart {
  height: 260px;
}
.records {
  margin-top: 16px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
