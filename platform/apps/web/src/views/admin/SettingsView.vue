<script setup lang="ts">
/**
 * 系统设置：注册开关等 JSON 配置，提交后写审计。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { listSettings, putSettings, type SettingRow } from '../../api/admin';

const loading = ref(false);
const rows = ref<SettingRow[]>([]);
const registrationEnabled = ref(true);
const wordCountBudget = ref(0);
const safetyFactor = ref(1.3);

const otherRows = computed(() =>
  rows.value.filter(
    (row) =>
      row.key !== 'registration_enabled' &&
      row.key !== 'word_count_budget' &&
      row.key !== 'safety_factor',
  ),
);

function isEnabled(value: unknown): boolean {
  if (value === false) return false;
  if (value && typeof value === 'object' && 'enabled' in value) {
    return (value as { enabled?: unknown }).enabled !== false;
  }
  return true;
}

function readNumber(value: unknown, key: string): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && key in value) {
    const raw = (value as Record<string, unknown>)[key];
    return typeof raw === 'number' ? raw : 0;
  }
  return 0;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await listSettings();
    const gate = rows.value.find((row) => row.key === 'registration_enabled');
    registrationEnabled.value = gate ? isEnabled(gate.value) : true;
    const budget = rows.value.find((row) => row.key === 'word_count_budget');
    wordCountBudget.value = readNumber(budget?.value, 'chars') || 0;
    const factor = rows.value.find((row) => row.key === 'safety_factor');
    safetyFactor.value = readNumber(factor?.value, 'value') || 1.3;
  } finally {
    loading.value = false;
  }
}

async function saveRegistration(): Promise<void> {
  await putSettings([
    { key: 'registration_enabled', value: { enabled: registrationEnabled.value } },
  ]);
  ElMessage.success('注册开关已保存');
  await load();
}

async function saveBudgets(): Promise<void> {
  await putSettings([
    { key: 'word_count_budget', value: { chars: wordCountBudget.value } },
    { key: 'safety_factor', value: { value: safetyFactor.value } },
  ]);
  ElMessage.success('生成预占参数已保存');
  await load();
}

onMounted(() => {
  void load();
});
</script>

<template>
  <el-card v-loading="loading">
    <template #header>系统设置</template>
    <el-form label-width="140px">
      <el-form-item label="开放注册">
        <el-switch v-model="registrationEnabled" @change="saveRegistration" />
      </el-form-item>
      <el-form-item label="字数预算（汉字）">
        <el-input-number v-model="wordCountBudget" :min="0" :step="500" />
        <span class="hint">0 表示沿用默认预占包络</span>
      </el-form-item>
      <el-form-item label="预占安全系数">
        <el-input-number v-model="safetyFactor" :min="1" :max="5" :step="0.1" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="saveBudgets">保存预占参数</el-button>
      </el-form-item>
    </el-form>
    <el-table :data="otherRows" stripe>
      <el-table-column prop="key" label="键" width="220" />
      <el-table-column label="值">
        <template #default="{ row }">
          <code>{{ JSON.stringify(row.value) }}</code>
        </template>
      </el-table-column>
      <el-table-column prop="updatedAt" label="更新时间" width="200" />
    </el-table>
  </el-card>
</template>

<style scoped>
.hint {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
