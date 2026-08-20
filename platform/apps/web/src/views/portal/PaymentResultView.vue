<script setup lang="ts">
/**
 * 支付宝同步跳转页：读取 out_trade_no 后轮询订单直至 paid。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { fenToYuan, getBillingSummary } from '../../api/billing';
import { getPaymentOrder, type PaymentOrder } from '../../api/payment';
import { useAuthStore } from '../../stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const order = ref<PaymentOrder | null>(null);
const error = ref('');
let timer: ReturnType<typeof setInterval> | null = null;

function orderNoFromQuery(): string {
  const raw = route.query.out_trade_no ?? route.query.orderNo;
  return typeof raw === 'string' ? raw : '';
}

async function poll(): Promise<void> {
  const orderNo = orderNoFromQuery();
  if (!orderNo) {
    error.value = '缺少订单号';
    return;
  }
  try {
    order.value = await getPaymentOrder(orderNo);
    if (order.value.status === 'paid') {
      if (timer) clearInterval(timer);
      timer = null;
      await auth.fetchMe();
      await getBillingSummary();
    }
  } catch {
    error.value = '无法读取该订单，请登录后从充值页查看';
  }
}

onMounted(() => {
  void poll();
  timer = setInterval(() => {
    void poll();
  }, 2000);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <el-card class="result">
    <template #header>支付结果</template>
    <el-alert v-if="error" :title="error" type="warning" :closable="false" />
    <template v-else-if="order">
      <p>订单 {{ order.orderNo }}</p>
      <p>金额 ¥{{ fenToYuan(order.amount) }}</p>
      <el-tag v-if="order.status === 'paid'" type="success">已支付</el-tag>
      <el-tag v-else type="warning">等待支付宝确认…</el-tag>
    </template>
    <el-empty v-else description="正在查询支付结果" />
    <el-button class="back" type="primary" @click="router.push({ name: 'recharge' })">
      返回充值
    </el-button>
  </el-card>
</template>

<style scoped>
.result {
  max-width: 480px;
  margin: 40px auto;
}
.back {
  margin-top: 16px;
}
</style>
