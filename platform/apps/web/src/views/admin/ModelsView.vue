<script setup lang="ts">
/**
 * 模型与费率：Provider 密钥脱敏展示；费率只新增生效价，不改历史单价。
 */
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { fenToYuan } from '../../api/billing';
import {
  createModelProvider,
  createModelRate,
  listModelProviders,
  listModelRates,
  patchModelProvider,
  patchModelRate,
  type ModelProviderRow,
  type ModelRateRow,
} from '../../api/admin';

const loading = ref(false);
const providers = ref<ModelProviderRow[]>([]);
const rates = ref<ModelRateRow[]>([]);
const providerDialog = ref(false);
const rateDialog = ref(false);
const providerForm = reactive({
  providerKey: '',
  name: '',
  apiBaseUrl: '',
  apiKey: '',
});
const rateForm = reactive({
  modelKey: '',
  displayName: '',
  providerId: 0,
  inputPricePerMillion: 0,
  outputPricePerMillion: 0,
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [p, r] = await Promise.all([listModelProviders(), listModelRates()]);
    providers.value = p;
    rates.value = r;
  } finally {
    loading.value = false;
  }
}

async function onCreateProvider(): Promise<void> {
  await createModelProvider({ ...providerForm });
  ElMessage.success('Provider 已创建，密钥已加密存储');
  providerDialog.value = false;
  await load();
}

async function onCreateRate(): Promise<void> {
  await createModelRate({
    ...rateForm,
    effectiveFrom: new Date().toISOString(),
  });
  ElMessage.success('新费率已生效；历史账单仍按旧快照');
  rateDialog.value = false;
  await load();
}

async function toggleProvider(row: ModelProviderRow): Promise<void> {
  await patchModelProvider(row.id, { enabled: !row.enabled });
  await load();
}

async function toggleRate(row: ModelRateRow): Promise<void> {
  await patchModelRate(row.id, { enabled: !row.enabled });
  await load();
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div v-loading="loading" class="models">
    <el-card>
      <template #header>
        <div class="head">
          <span>模型供应商（密钥脱敏）</span>
          <el-button type="primary" @click="providerDialog = true">新增供应商</el-button>
        </div>
      </template>
      <el-table :data="providers" stripe>
        <el-table-column prop="providerKey" label="Key" width="140" />
        <el-table-column prop="name" label="名称" width="140" />
        <el-table-column prop="apiBaseUrl" label="API Base" min-width="180" />
        <el-table-column prop="apiKeyMasked" label="密钥" width="160" />
        <el-table-column label="启用" width="90">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" @change="toggleProvider(row)" />
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="rates">
      <template #header>
        <div class="head">
          <span>费率（只新增生效价，不修改历史单价）</span>
          <el-button type="primary" @click="rateDialog = true">新增费率</el-button>
        </div>
      </template>
      <el-table :data="rates" stripe>
        <el-table-column prop="modelKey" label="模型" min-width="180" />
        <el-table-column prop="displayName" label="展示名" width="140" />
        <el-table-column prop="providerKey" label="供应商" width="120" />
        <el-table-column label="输入价/百万 token" width="160">
          <template #default="{ row }">
            {{ row.inputPricePerMillion }} 分（¥{{ fenToYuan(row.inputPricePerMillion) }}）
          </template>
        </el-table-column>
        <el-table-column label="输出价/百万 token" width="160">
          <template #default="{ row }">
            {{ row.outputPricePerMillion }} 分（¥{{ fenToYuan(row.outputPricePerMillion) }}）
          </template>
        </el-table-column>
        <el-table-column prop="effectiveFrom" label="生效时间" min-width="180" />
        <el-table-column label="启用" width="90">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" @change="toggleRate(row)" />
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="providerDialog" title="新增供应商" width="480px">
      <el-form label-position="top">
        <el-form-item label="providerKey">
          <el-input v-model="providerForm.providerKey" />
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="providerForm.name" />
        </el-form-item>
        <el-form-item label="API Base URL">
          <el-input v-model="providerForm.apiBaseUrl" />
        </el-form-item>
        <el-form-item label="API Key（明文仅提交一次，落库加密）">
          <el-input v-model="providerForm.apiKey" type="password" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="providerDialog = false">取消</el-button>
        <el-button type="primary" @click="onCreateProvider">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="rateDialog" title="新增费率" width="480px">
      <el-form label-position="top">
        <el-form-item label="模型 key">
          <el-input v-model="rateForm.modelKey" />
        </el-form-item>
        <el-form-item label="展示名">
          <el-input v-model="rateForm.displayName" />
        </el-form-item>
        <el-form-item label="供应商">
          <el-select v-model="rateForm.providerId" style="width: 100%">
            <el-option
              v-for="item in providers"
              :key="item.id"
              :label="item.name"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="输入价（分 / 百万 token）">
          <el-input-number v-model="rateForm.inputPricePerMillion" :min="0" />
        </el-form-item>
        <el-form-item label="输出价（分 / 百万 token）">
          <el-input-number v-model="rateForm.outputPricePerMillion" :min="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="rateDialog = false">取消</el-button>
        <el-button type="primary" @click="onCreateRate">创建新价</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.rates {
  margin-top: 16px;
}
</style>
