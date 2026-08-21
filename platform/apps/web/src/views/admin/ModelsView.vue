<script setup lang="ts">
/**
 * 模型与费率：Provider 密钥脱敏展示；费率 = 公开原价 × 倍率，支持改倍率与删除。
 */
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { fenToYuan, yuanToFen } from '../../api/billing';
import {
  createModelProvider,
  createModelRate,
  deleteModelProvider,
  deleteModelRate,
  listModelProviders,
  listModelRates,
  lookupModelRate,
  patchModelProvider,
  patchModelRate,
  type ModelPriceLookup,
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
  inputYuanPerMillion: 0,
  outputYuanPerMillion: 0,
  multiplier: 1,
});
const lookupLoading = ref(false);
const lookup = ref<ModelPriceLookup | null>(null);
const manualPrice = ref(false);

/** 倍率显示：150 → "1.50×"。 */
function formatMultiplier(percent: number | undefined): string {
  return `${((percent ?? 100) / 100).toFixed(2)}×`;
}

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

function openRateDialog(): void {
  rateForm.modelKey = '';
  rateForm.displayName = '';
  rateForm.providerId = providers.value[0]?.id ?? 0;
  rateForm.inputYuanPerMillion = 0;
  rateForm.outputYuanPerMillion = 0;
  rateForm.multiplier = 1;
  lookup.value = null;
  manualPrice.value = false;
  rateDialog.value = true;
}

async function onLookupPrice(): Promise<void> {
  const q = rateForm.modelKey.trim();
  if (!q) {
    ElMessage.warning('请先填写模型 key');
    return;
  }
  lookupLoading.value = true;
  try {
    const result = await lookupModelRate(q);
    lookup.value = result;
    if (result.found) {
      rateForm.inputYuanPerMillion = result.inputYuanPerMillion ?? 0;
      rateForm.outputYuanPerMillion = result.outputYuanPerMillion ?? 0;
      if (!rateForm.displayName.trim() && result.displayName) {
        rateForm.displayName = result.displayName;
      }
      manualPrice.value = false;
      ElMessage.success(
        `已从${result.source === 'siliconflow' ? '硅基流动' : 'OpenRouter'}写入公开价`,
      );
    } else {
      manualPrice.value = true;
      ElMessage.warning(result.message ?? '未找到公开价，请手动填写');
    }
  } finally {
    lookupLoading.value = false;
  }
}

async function onCreateRate(): Promise<void> {
  if (!rateForm.modelKey.trim() || !rateForm.providerId) {
    ElMessage.warning('请填写模型 key 并选择供应商');
    return;
  }
  if (!lookup.value?.found && !manualPrice.value) {
    await onLookupPrice();
    if (!lookup.value?.found && !manualPrice.value) return;
  }
  if (rateForm.inputYuanPerMillion < 0 || rateForm.outputYuanPerMillion < 0) {
    ElMessage.warning('输入/输出价不能为负');
    return;
  }
  await createModelRate({
    modelKey: rateForm.modelKey.trim(),
    displayName: rateForm.displayName.trim() || rateForm.modelKey.trim(),
    providerId: rateForm.providerId,
    inputPricePerMillion: yuanToFen(rateForm.inputYuanPerMillion),
    outputPricePerMillion: yuanToFen(rateForm.outputYuanPerMillion),
    multiplierPercent: Math.round(rateForm.multiplier * 100),
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

/** 行内改倍率：弹窗输入新倍率（如 1.5），结算按 公开原价 × 倍率。 */
async function editMultiplier(row: ModelRateRow): Promise<void> {
  const current = (row.multiplierPercent ?? 100) / 100;
  let value: string | null;
  try {
    ({ value } = await ElMessageBox.prompt(
      `模型 ${row.modelKey} 的当前倍率为 ${current}。输入新倍率（例如 1.5、2），结算金额 = 公开原价 × 倍率。`,
      '修改倍率',
      {
        confirmButtonText: '保存',
        cancelButtonText: '取消',
        inputValue: String(current),
        inputPattern: /^\d+(\.\d{1,4})?$/,
        inputErrorMessage: '倍率必须为非负数字（最多 4 位小数）',
      },
    ));
  } catch {
    return; // 用户取消
  }
  const multiplier = Number(value);
  if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 100) {
    ElMessage.warning('倍率需在 0 ~ 100 之间');
    return;
  }
  await patchModelRate(row.id, {
    multiplierPercent: Math.round(multiplier * 100),
  });
  ElMessage.success(`倍率已更新为 ${multiplier}×`);
  await load();
}

async function onDeleteRate(row: ModelRateRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除费率「${row.displayName || row.modelKey}」？历史账单按落库快照结算，不受影响。`,
      '删除费率',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  await deleteModelRate(row.id);
  ElMessage.success('费率已删除');
  await load();
}

async function onDeleteProvider(row: ModelProviderRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除供应商「${row.name}」？仍有关联费率时会被拒绝。`,
      '删除供应商',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  await deleteModelProvider(row.id);
  ElMessage.success('供应商已删除');
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
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button type="danger" link size="small" @click="onDeleteProvider(row)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="rates">
      <template #header>
        <div class="head">
          <span>费率（公开原价 × 倍率 = 最终结算价）</span>
          <el-button type="primary" @click="openRateDialog">新增费率</el-button>
        </div>
      </template>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="rate-hint"
        title="新增费率时按模型名查询硅基流动 / OpenRouter 公开价；查不到再手动填写。结算金额 = 公开原价 × 倍率。"
      />
      <el-table :data="rates" stripe>
        <el-table-column prop="modelKey" label="模型" min-width="180" />
        <el-table-column prop="displayName" label="展示名" width="140" />
        <el-table-column prop="providerKey" label="供应商" width="120" />
        <el-table-column label="输入价 / 百万 token" width="150">
          <template #default="{ row }">¥{{ fenToYuan(row.inputPricePerMillion) }}</template>
        </el-table-column>
        <el-table-column label="输出价 / 百万 token" width="150">
          <template #default="{ row }">¥{{ fenToYuan(row.outputPricePerMillion) }}</template>
        </el-table-column>
        <el-table-column label="倍率" width="100">
          <template #default="{ row }">{{ formatMultiplier(row.multiplierPercent) }}</template>
        </el-table-column>
        <el-table-column prop="effectiveFrom" label="生效时间" min-width="180" />
        <el-table-column label="启用" width="80">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" @change="toggleRate(row)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="editMultiplier(row)">
              改倍率
            </el-button>
            <el-button type="danger" link size="small" @click="onDeleteRate(row)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="providerDialog" title="新增供应商" width="480px">
      <el-form label-position="top">
        <el-form-item label="providerKey">
          <el-input v-model="providerForm.providerKey" placeholder="gemini 或 gemini-3.7-flash" />
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

    <el-dialog v-model="rateDialog" title="新增费率" width="520px">
      <el-form label-position="top">
        <el-form-item label="模型 key">
          <el-input
            v-model="rateForm.modelKey"
            placeholder="gemini-3.7-flash 或 Qwen/Qwen2.5-7B-Instruct"
            @keyup.enter="onLookupPrice"
          >
            <template #append>
              <el-button :loading="lookupLoading" @click="onLookupPrice">查询公开价</el-button>
            </template>
          </el-input>
        </el-form-item>
        <el-alert
          v-if="lookup?.found"
          type="success"
          :closable="false"
          show-icon
          class="rate-hint"
          :title="`已匹配 ${lookup.matchedId}（${lookup.source === 'siliconflow' ? '硅基流动 CNY' : 'OpenRouter USD→CNY'}）`"
        />
        <el-alert
          v-else-if="lookup && !lookup.found"
          type="warning"
          :closable="false"
          show-icon
          class="rate-hint"
          :title="lookup.message"
        />
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
        <el-form-item label="输入价（元 / 百万 token）">
          <el-input-number
            v-model="rateForm.inputYuanPerMillion"
            :min="0"
            :step="0.01"
            :precision="4"
            :disabled="Boolean(lookup?.found) && !manualPrice"
          />
        </el-form-item>
        <el-form-item label="输出价（元 / 百万 token）">
          <el-input-number
            v-model="rateForm.outputYuanPerMillion"
            :min="0"
            :step="0.01"
            :precision="4"
            :disabled="Boolean(lookup?.found) && !manualPrice"
          />
        </el-form-item>
        <el-button
          v-if="lookup?.found && !manualPrice"
          type="primary"
          link
          @click="manualPrice = true"
        >
          公开价不准？手动改价
        </el-button>
        <el-form-item label="倍率（1 = 按公开原价；1.5 = 1.5 倍计费）">
          <el-input-number v-model="rateForm.multiplier" :min="0" :step="0.1" :precision="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="rateDialog = false">取消</el-button>
        <el-button type="primary" :loading="lookupLoading" @click="onCreateRate">创建新价</el-button>
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
.rate-hint {
  margin-bottom: 12px;
}
</style>
