<script setup lang="ts">
/**
 * 收入：支付宝真实充值 / 调账虚拟充值 / 真实与虚拟消耗 / 待消耗额度。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { fenToYuan } from '../../api/billing';
import {
  getRevenueSummary,
  listAdminUsers,
  type AdminUserRow,
  type RevenueSummary,
} from '../../api/admin';

type Preset = 'today' | '7d' | '30d' | 'all' | 'custom';

const preset = ref<Preset>('30d');
const customRange = ref<[string, string] | null>(null);
const userId = ref<number | undefined>(undefined);
const users = ref<AdminUserRow[]>([]);
const loading = ref(false);
const data = ref<RevenueSummary | null>(null);

function utcDay(offset = 0): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

const range = computed<{ from?: string; to?: string }>(() => {
  if (preset.value === 'all') return {};
  if (preset.value === 'today') return { from: utcDay(0), to: utcDay(0) };
  if (preset.value === '7d') return { from: utcDay(-6), to: utcDay(0) };
  if (preset.value === 'custom' && customRange.value) {
    return { from: customRange.value[0], to: customRange.value[1] };
  }
  return { from: utcDay(-29), to: utcDay(0) };
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await getRevenueSummary({
      ...range.value,
      userId: userId.value,
    });
  } finally {
    loading.value = false;
  }
}

watch([preset, userId], () => {
  if (preset.value !== 'custom') void load();
});

onMounted(async () => {
  users.value = (await listAdminUsers({ page: 1, pageSize: 100 })).items;
  await load();
});
</script>

<template>
  <div v-loading="loading">
    <div class="toolbar">
      <el-radio-group v-model="preset">
        <el-radio-button label="today">今天</el-radio-button>
        <el-radio-button label="7d">近 7 天</el-radio-button>
        <el-radio-button label="30d">近 30 天</el-radio-button>
        <el-radio-button label="all">全部</el-radio-button>
        <el-radio-button label="custom">自定义</el-radio-button>
      </el-radio-group>
      <el-date-picker
        v-if="preset === 'custom'"
        v-model="customRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        start-placeholder="开始"
        end-placeholder="结束"
        @change="load"
      />
      <el-select
        v-model="userId"
        clearable
        filterable
        placeholder="按用户筛选"
        style="width: 240px"
      >
        <el-option
          v-for="item in users"
          :key="item.id"
          :label="`${item.email} (#${item.id})`"
          :value="item.id"
        />
      </el-select>
    </div>

    <el-row :gutter="12" class="cards">
      <el-col :span="8">
        <el-card shadow="never">
          <p class="label">支付宝真实充值</p>
          <p class="value">¥{{ data ? fenToYuan(data.realRecharge) : '-' }}</p>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <p class="label">后台调账（虚拟充值）</p>
          <p class="value">¥{{ data ? fenToYuan(data.virtualRecharge) : '-' }}</p>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <p class="label">期间充值合计</p>
          <p class="value">¥{{ data ? fenToYuan(data.rechargeTotal) : '-' }}</p>
        </el-card>
      </el-col>
    </el-row>
    <el-row :gutter="12" class="cards">
      <el-col :span="8">
        <el-card shadow="never">
          <p class="label">真实消耗（扣充值余额）</p>
          <p class="value">¥{{ data ? fenToYuan(data.realConsume) : '-' }}</p>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <p class="label">虚拟消耗（扣赠送余额）</p>
          <p class="value">¥{{ data ? fenToYuan(data.virtualConsume) : '-' }}</p>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <p class="label">平台待消耗额度</p>
          <p class="value">¥{{ data ? fenToYuan(data.remainingQuota) : '-' }}</p>
          <p class="sub">
            累计充值（真+虚）− 累计消耗（真+虚）
            <span v-if="data">
              · 真 ¥{{ fenToYuan(data.remainingReal) }} / 虚 ¥{{ fenToYuan(data.remainingVirtual) }}
            </span>
          </p>
        </el-card>
      </el-col>
    </el-row>

    <el-card>
      <template #header>按日拆分（真实/虚拟）</template>
      <el-table :data="data?.byDay ?? []" stripe>
        <el-table-column prop="day" label="日期" width="120" />
        <el-table-column label="支付宝充值">
          <template #default="{ row }">¥{{ fenToYuan(row.realRecharge) }}</template>
        </el-table-column>
        <el-table-column label="调账">
          <template #default="{ row }">¥{{ fenToYuan(row.virtualRecharge) }}</template>
        </el-table-column>
        <el-table-column label="真实消耗">
          <template #default="{ row }">¥{{ fenToYuan(row.realConsume) }}</template>
        </el-table-column>
        <el-table-column label="虚拟消耗">
          <template #default="{ row }">¥{{ fenToYuan(row.virtualConsume) }}</template>
        </el-table-column>
      </el-table>
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
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
