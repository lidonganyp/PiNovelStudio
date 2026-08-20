<script setup lang="ts">
/**
 * 管理概览：今日消耗 / 充值 / 活跃用户卡片。
 */
import { onMounted, ref } from 'vue';
import { fenToYuan } from '../../api/billing';
import { getAdminOverview, type AdminOverview } from '../../api/admin';

const loading = ref(false);
const overview = ref<AdminOverview | null>(null);

onMounted(async () => {
  loading.value = true;
  try {
    overview.value = await getAdminOverview();
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <el-row v-loading="loading" :gutter="16">
    <el-col :span="6">
      <el-card shadow="never">
        <p class="label">用户总数</p>
        <p class="value">{{ overview?.userCount ?? '-' }}</p>
      </el-card>
    </el-col>
    <el-col :span="6">
      <el-card shadow="never">
        <p class="label">活跃用户</p>
        <p class="value">{{ overview?.activeUsers ?? '-' }}</p>
      </el-card>
    </el-col>
    <el-col :span="6">
      <el-card shadow="never">
        <p class="label">今日充值</p>
        <p class="value">¥{{ overview ? fenToYuan(overview.rechargeToday) : '-' }}</p>
      </el-card>
    </el-col>
    <el-col :span="6">
      <el-card shadow="never">
        <p class="label">今日消耗</p>
        <p class="value">¥{{ overview ? fenToYuan(overview.consumeToday) : '-' }}</p>
      </el-card>
    </el-col>
  </el-row>
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
</style>
