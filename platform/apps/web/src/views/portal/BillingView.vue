<script setup lang="ts">
/**
 * P5-5 计费总览 + 消费明细页：
 * 上半 summary 卡片（余额/预占/可用/近30天消耗），
 * 下半明细分页表（模型/阶段/项目/tokens/金额），支持按项目过滤。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import {
  fenToYuan,
  getBillingSummary,
  listBillingRecords,
  type BillingRecordsResult,
  type BillingSummary,
} from '../../api/billing';
import { listProjects, type Project } from '../../api/projects';

const summary = ref<BillingSummary | null>(null);
const records = ref<BillingRecordsResult | null>(null);
const projects = ref<Project[]>([]);
const filterProjectId = ref<number | undefined>(undefined);
const page = ref(1);
const pageSize = 20;
const loading = ref(false);
const chartEl = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

function renderChart(): void {
  if (!chartEl.value || !summary.value) return;
  if (!chart) chart = echarts.init(chartEl.value);
  const days = summary.value.spentByDay ?? [];
  chart.setOption({
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: days.map((row) => row.day) },
    yAxis: { type: 'value', name: '元' },
    series: [
      {
        type: 'bar',
        data: days.map((row) => Number(fenToYuan(row.charge))),
      },
    ],
  });
}

async function loadSummary(): Promise<void> {
  summary.value = await getBillingSummary();
}

async function loadRecords(): Promise<void> {
  loading.value = true;
  try {
    records.value = await listBillingRecords({
      page: page.value,
      pageSize,
      projectId: filterProjectId.value,
    });
  } finally {
    loading.value = false;
  }
}

function onFilterChange(): void {
  page.value = 1;
  void loadRecords();
}

watch(summary, () => {
  void nextTick(() => renderChart());
});

onMounted(async () => {
  await Promise.all([
    loadSummary(),
    loadRecords(),
    listProjects({ page: 1, pageSize: 100 }).then((r) => {
      projects.value = r.items;
    }),
  ]);
  window.addEventListener('resize', renderChart);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', renderChart);
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div class="billing-page">
    <el-row v-if="summary" :gutter="16" class="cards">
      <el-col :span="6">
        <el-card shadow="never">
          <p class="label">总余额</p>
          <p class="value">¥{{ fenToYuan(summary.totalBalance) }}</p>
          <p class="sub">
            充值 ¥{{ fenToYuan(summary.balance) }} · 赠送 ¥{{ fenToYuan(summary.bonusBalance) }}
          </p>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <p class="label">在途预占</p>
          <p class="value warn">¥{{ fenToYuan(summary.reserved) }}</p>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <p class="label">可用余额</p>
          <p class="value">¥{{ fenToYuan(summary.available) }}</p>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <p class="label">近 30 天消耗</p>
          <p class="value">¥{{ fenToYuan(summary.spentLast30Days) }}</p>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="trend">
      <template #header>近 30 日消耗</template>
      <div ref="chartEl" class="chart" />
    </el-card>

    <el-card shadow="never" class="records">
      <template #header>
        <div class="records-head">
          <span>消费明细（逐模型调用）</span>
          <el-select
            v-model="filterProjectId"
            placeholder="全部项目"
            clearable
            class="project-filter"
            @change="onFilterChange"
          >
            <el-option
              v-for="project in projects"
              :key="project.id"
              :value="project.id"
              :label="project.title"
            />
          </el-select>
        </div>
      </template>
      <el-table v-loading="loading" :data="records?.items ?? []" size="small">
        <el-table-column prop="createdAt" label="时间" width="170">
          <template #default="{ row }">
            {{ new Date(row.createdAt).toLocaleString() }}
          </template>
        </el-table-column>
        <el-table-column prop="projectTitle" label="项目" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.projectTitle ?? '-' }}</template>
        </el-table-column>
        <el-table-column prop="model" label="模型" min-width="140" show-overflow-tooltip />
        <el-table-column prop="internalStage" label="阶段" min-width="110" show-overflow-tooltip />
        <el-table-column label="tokens 入/出" width="150">
          <template #default="{ row }">{{ row.tokensIn }} / {{ row.tokensOut }}</template>
        </el-table-column>
        <el-table-column label="金额" width="100" align="right">
          <template #default="{ row }">¥{{ fenToYuan(row.actualCharge) }}</template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-if="(records?.total ?? 0) > pageSize"
        v-model:current-page="page"
        :page-size="pageSize"
        :total="records?.total ?? 0"
        layout="prev, pager, next, total"
        class="pager"
        @current-change="loadRecords"
      />
    </el-card>
  </div>
</template>

<style scoped>
.cards {
  margin-bottom: 16px;
}
.trend {
  margin-bottom: 16px;
}
.chart {
  height: 240px;
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
.value.warn {
  color: var(--el-color-warning);
}
.sub {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.records-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.project-filter {
  width: 220px;
}
.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>
