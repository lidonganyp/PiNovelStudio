<script setup lang="ts">
/**
 * 管理概览：今日卡片 + 近 7 日趋势 + 用户/模型排行。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import { fenToYuan } from '../../api/billing';
import { getAdminOverview, type AdminOverview } from '../../api/admin';

const loading = ref(false);
const overview = ref<AdminOverview | null>(null);
const chartEl = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

function renderChart(): void {
  if (!chartEl.value || !overview.value?.trend7d) return;
  if (!chart) chart = echarts.init(chartEl.value);
  const days = [...overview.value.trend7d].reverse();
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['充值', '消耗'] },
    xAxis: { type: 'category', data: days.map((row) => row.day) },
    yAxis: { type: 'value', name: '元' },
    series: [
      { name: '充值', type: 'bar', data: days.map((row) => Number(fenToYuan(row.recharge))) },
      { name: '消耗', type: 'line', data: days.map((row) => Number(fenToYuan(row.consume))) },
    ],
  });
}

onMounted(async () => {
  loading.value = true;
  try {
    overview.value = await getAdminOverview();
  } finally {
    loading.value = false;
  }
  window.addEventListener('resize', renderChart);
});

watch(overview, () => {
  void nextTick(() => renderChart());
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', renderChart);
  chart?.dispose();
});
</script>

<template>
  <div v-loading="loading">
    <el-row :gutter="16">
      <el-col :span="4">
        <el-card shadow="never">
          <p class="label">用户总数</p>
          <p class="value">{{ overview?.userCount ?? '-' }}</p>
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="never">
          <p class="label">活跃用户</p>
          <p class="value">{{ overview?.activeUsers ?? '-' }}</p>
        </el-card>
      </el-col>
      <el-col :span="5">
        <el-card shadow="never">
          <p class="label">今日充值</p>
          <p class="value">¥{{ overview ? fenToYuan(overview.rechargeToday) : '-' }}</p>
        </el-card>
      </el-col>
      <el-col :span="5">
        <el-card shadow="never">
          <p class="label">今日消耗</p>
          <p class="value">¥{{ overview ? fenToYuan(overview.consumeToday) : '-' }}</p>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <p class="label">待消耗额度</p>
          <p class="value">¥{{ overview?.remainingQuota ? fenToYuan(overview.remainingQuota) : '-' }}</p>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="chart-card">
      <template #header>近 7 日充值 / 消耗</template>
      <div ref="chartEl" class="chart" />
    </el-card>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card>
          <template #header>近 7 日消耗用户排行</template>
          <el-table :data="overview?.topUsers ?? []" stripe>
            <el-table-column prop="email" label="用户" min-width="160" />
            <el-table-column prop="calls" label="调用" width="80" />
            <el-table-column label="消耗" width="110">
              <template #default="{ row }">¥{{ fenToYuan(row.consume) }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header>近 7 日模型排行</template>
          <el-table :data="overview?.topModels ?? []" stripe>
            <el-table-column prop="model" label="模型" min-width="160" />
            <el-table-column prop="calls" label="调用" width="80" />
            <el-table-column label="消耗" width="110">
              <template #default="{ row }">¥{{ fenToYuan(row.consume) }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
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
.chart-card {
  margin: 16px 0;
}
.chart {
  height: 260px;
}
</style>
