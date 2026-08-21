<script setup lang="ts">
/**
 * 充值页：选择金额与渠道，下单后轮询状态；stub 模式可模拟渠道通知。
 */
import { onBeforeUnmount, ref, watch } from 'vue';
import QRCode from 'qrcode';
import { ElMessage } from 'element-plus';
import { getBillingSummary, fenToYuan, yuanToFen } from '../../api/billing';
import type { BillingSummary } from '../../api/billing';
import {
  createPaymentOrder,
  getPaymentConfig,
  getPaymentOrder,
  simulatePayment,
} from '../../api/payment';
import type { PaymentChannel, PaymentConfig, PaymentOrder } from '../../api/payment';
import { useAuthStore } from '../../stores/auth';

const AMOUNTS = [10, 30, 50, 100, 300];

const auth = useAuthStore();
const summary = ref<BillingSummary | null>(null);
const selectedAmount = ref<number>(30);
const channel = ref<PaymentChannel>('alipay');
const order = ref<PaymentOrder | null>(null);
const submitting = ref(false);
const simulating = ref(false);
const qrImage = ref('');
const config = ref<PaymentConfig | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

watch(
  () => order.value?.qrContent,
  async (content) => {
    if (!content) {
      qrImage.value = '';
      return;
    }
    qrImage.value = await QRCode.toDataURL(content, { width: 220, margin: 1 });
  },
);

async function loadSummary(): Promise<void> {
  const [nextSummary, nextConfig] = await Promise.all([
    getBillingSummary(),
    getPaymentConfig(),
  ]);
  summary.value = nextSummary;
  config.value = nextConfig;
  if (nextConfig.channels.length && !nextConfig.channels.includes(channel.value)) {
    channel.value = nextConfig.channels[0];
  }
  await auth.fetchMe();
}

function stopPolling(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

async function poll(): Promise<void> {
  if (!order.value) return;
  const latest = await getPaymentOrder(order.value.orderNo);
  order.value = latest;
  if (latest.status === 'paid') {
    stopPolling();
    ElMessage.success('充值成功');
    await loadSummary();
  } else if (latest.status === 'expired' || latest.status === 'failed') {
    stopPolling();
  }
}

async function startOrder(): Promise<void> {
  submitting.value = true;
  stopPolling();
  try {
    order.value = await createPaymentOrder({
      channel: channel.value,
      amount: yuanToFen(selectedAmount.value),
    });
    timer = setInterval(() => {
      void poll();
    }, 2000);
  } finally {
    submitting.value = false;
  }
}

function openPayUrl(): void {
  const url = order.value?.payUrl;
  if (url) window.open(url, '_blank', 'noopener');
}

async function onSimulate(): Promise<void> {
  if (!order.value) return;
  simulating.value = true;
  try {
    await simulatePayment(order.value.orderNo);
    await poll();
  } finally {
    simulating.value = false;
  }
}

onBeforeUnmount(stopPolling);
void loadSummary();
</script>

<template>
  <div class="recharge-page">
    <el-card shadow="never" class="main-card">
      <template #header>账户充值</template>
      <p v-if="summary" class="current">
        当前余额：<strong>¥{{ fenToYuan(summary.totalBalance) }}</strong>
        <span class="available">（可用 ¥{{ fenToYuan(summary.available) }}）</span>
      </p>
      <el-radio-group v-model="channel" class="channel">
        <el-radio-button
          v-if="!config || config.channels.includes('alipay')"
          value="alipay"
        >
          支付宝
        </el-radio-button>
        <el-radio-button
          v-if="!config || config.channels.includes('wechat')"
          value="wechat"
        >
          微信支付
        </el-radio-button>
      </el-radio-group>
      <div class="amounts">
        <div
          v-for="amount in AMOUNTS"
          :key="amount"
          class="amount-card"
          :class="{ selected: amount === selectedAmount }"
          @click="selectedAmount = amount"
        >
          <span class="num">¥{{ amount }}</span>
        </div>
      </div>
      <el-button type="primary" size="large" :loading="submitting" @click="startOrder">
        立即充值
      </el-button>
    </el-card>

    <el-card v-if="order" shadow="never" class="order-card">
      <template #header>订单 {{ order.orderNo }}</template>
      <el-steps :active="order.status === 'paid' ? 3 : 2" align-center>
        <el-step title="已创建" />
        <el-step title="待支付" />
        <el-step title="已支付" />
      </el-steps>
      <p class="order-amount">金额 ¥{{ fenToYuan(order.amount) }}</p>
      <div class="qr-box">
        <img v-if="qrImage" :src="qrImage" alt="支付二维码" width="220" height="220" />
        <p v-if="order.qrContent" class="qr-text">请使用支付宝扫码</p>
        <el-button
          v-if="order.payUrl"
          type="primary"
          @click="openPayUrl"
        >
          打开支付宝收银台
        </el-button>
      </div>
      <p class="order-status">
        状态：
        <el-tag v-if="order.status === 'paid'" type="success">已支付</el-tag>
        <el-tag v-else-if="order.status === 'expired'" type="info">已过期</el-tag>
        <el-tag v-else type="warning">待支付 · 轮询中</el-tag>
      </p>
      <el-button
        v-if="order.status === 'created' && config?.simulate"
        type="success"
        :loading="simulating"
        @click="onSimulate"
      >
        模拟支付成功
      </el-button>
    </el-card>
  </div>
</template>

<style scoped>
.recharge-page {
  max-width: 720px;
  margin: 0 auto;
}
.main-card {
  margin-bottom: 16px;
}
.current {
  margin: 0 0 12px;
}
.available {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.channel {
  margin-bottom: 16px;
}
.amounts {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.amount-card {
  width: 100px;
  height: 64px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.amount-card.selected {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 600;
}
.num {
  font-size: 18px;
}
.order-amount {
  text-align: center;
  font-size: 16px;
  margin: 12px 0 4px;
}
.qr-box {
  text-align: center;
  color: var(--el-text-color-secondary);
}
.qr-text {
  font-family: ui-monospace, monospace;
  font-size: 13px;
  word-break: break-all;
}
.order-status {
  text-align: center;
  margin: 0 0 12px;
}
</style>
