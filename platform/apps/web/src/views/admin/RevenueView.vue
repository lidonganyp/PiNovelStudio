<script setup lang="ts">
/**
 * 收入明细：充值口径 + 消耗口径，按日对照。
 */
import { onMounted, ref } from 'vue';
import { fenToYuan } from '../../api/billing';
import { getRevenueSummary, type RevenueSummary } from '../../api/admin';

const loading = ref(false);
const data = ref<RevenueSummary | null>(null);

onMounted(async () => {
  loading.value = true;
  try {
    data.value = await getRevenueSummary();
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div v-loading="loading">
    <el-row :gutter="16" class="cards">
      <el-col :span="12">
        <el-card shadow="never">
          <p class="label">累计充值（已支付订单）</p>
          <p class="value">¥{{ data ? fenToYuan(data.rechargeTotal) : '-' }}</p>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="never">
          <p class="label">累计消耗（逐调用结算）</p>
          <p class="value">¥{{ data ? fenToYuan(data.consumeTotal) : '-' }}</p>
        </el-card>
      </el-col>
    </el-row>
    <el-card>
      <template #header>按日对照（充值 vs 消耗）</template>
      <el-table :data="data?.byDay ?? []" stripe>
        <el-table-column prop="day" label="日期" width="140" />
        <el-table-column label="充值">
          <template #default="{ row }">¥{{ fenToYuan(row.recharge) }}</template>
        </el-table-column>
        <el-table-column label="消耗">
          <template #default="{ row }">¥{{ fenToYuan(row.consume) }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
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
</style>
