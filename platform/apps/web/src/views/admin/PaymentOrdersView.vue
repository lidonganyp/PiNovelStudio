<script setup lang="ts">
/**
 * 管理台充值订单列表。
 */
import { onMounted, ref } from 'vue';
import { fenToYuan } from '../../api/billing';
import { listAdminPaymentOrders } from '../../api/payment';
import type { PaymentOrderList } from '../../api/payment';

const loading = ref(false);
const data = ref<PaymentOrderList>({ items: [], total: 0, page: 1, pageSize: 20 });

async function load(page = 1): Promise<void> {
  loading.value = true;
  try {
    data.value = await listAdminPaymentOrders({ page, pageSize: 20 });
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
    <template #header>充值订单</template>
    <el-table v-loading="loading" :data="data.items" stripe>
      <el-table-column prop="orderNo" label="订单号" min-width="180" />
      <el-table-column prop="userEmail" label="用户" min-width="180" />
      <el-table-column prop="channel" label="渠道" width="90" />
      <el-table-column label="金额" width="100">
        <template #default="{ row }">¥{{ fenToYuan(row.amount) }}</template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="90" />
      <el-table-column prop="createdAt" label="创建时间" min-width="180" />
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
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
