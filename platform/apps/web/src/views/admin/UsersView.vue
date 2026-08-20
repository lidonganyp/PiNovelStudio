<script setup lang="ts">
/**
 * 用户管理：列表（余额/累计消耗/状态）+ 详情抽屉（预占、订单、调账、封禁）。
 */
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { fenToYuan } from '../../api/billing';
import {
  adjustUserBalance,
  getAdminUser,
  listAdminUsers,
  setUserStatus,
  type AdminUserDetail,
  type AdminUserList,
  type AdminUserRow,
} from '../../api/admin';

const loading = ref(false);
const keyword = ref('');
const status = ref<string | undefined>(undefined);
const data = ref<AdminUserList>({ items: [], total: 0, page: 1, pageSize: 20 });
const drawer = ref(false);
const detail = ref<AdminUserDetail | null>(null);
const adjustForm = reactive({ amount: 0, reason: '' });

async function load(page = 1): Promise<void> {
  loading.value = true;
  try {
    data.value = await listAdminUsers({
      page,
      pageSize: 20,
      q: keyword.value.trim() || undefined,
      status: status.value,
    });
  } finally {
    loading.value = false;
  }
}

async function openUser(id: number): Promise<void> {
  detail.value = await getAdminUser(id);
  adjustForm.amount = 0;
  adjustForm.reason = '';
  drawer.value = true;
}

async function onAdjust(): Promise<void> {
  if (!detail.value) return;
  if (!Number.isInteger(adjustForm.amount) || adjustForm.amount === 0) {
    ElMessage.warning('调账金额必须是非零整数（分）');
    return;
  }
  if (!adjustForm.reason.trim()) {
    ElMessage.warning('请填写调账原因');
    return;
  }
  await adjustUserBalance(detail.value.id, {
    amount: adjustForm.amount,
    reason: adjustForm.reason.trim(),
  });
  ElMessage.success('调账已生效');
  await openUser(detail.value.id);
  void load(data.value.page);
}

function onRowClick(row: AdminUserRow): void {
  void openUser(row.id);
}

async function onToggleStatus(): Promise<void> {
  if (!detail.value || detail.value.role === 'admin') return;
  const next = detail.value.status === 'banned' ? 'active' : 'banned';
  const label = next === 'banned' ? '封禁' : '解封';
  try {
    await ElMessageBox.confirm(`确认${label}该用户？`, label, { type: 'warning' });
  } catch {
    return;
  }
  await setUserStatus(detail.value.id, next);
  ElMessage.success(`已${label}`);
  await openUser(detail.value.id);
  void load(data.value.page);
}

onMounted(() => {
  void load();
});
</script>

<template>
  <el-card>
    <template #header>
      <div class="toolbar">
        <span>用户管理</span>
        <el-input
          v-model="keyword"
          placeholder="邮箱或昵称"
          clearable
          class="search"
          @keyup.enter="load(1)"
          @clear="load(1)"
        />
        <el-select
          v-model="status"
          placeholder="状态"
          clearable
          class="status"
          @change="load(1)"
        >
          <el-option label="活跃" value="active" />
          <el-option label="封禁" value="banned" />
        </el-select>
        <el-button type="primary" @click="load(1)">搜索</el-button>
      </div>
    </template>
    <el-table v-loading="loading" :data="data.items" stripe @row-click="onRowClick">
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="email" label="邮箱" min-width="200" />
      <el-table-column prop="nickname" label="昵称" width="120" />
      <el-table-column prop="role" label="角色" width="80" />
      <el-table-column prop="status" label="状态" width="80" />
      <el-table-column label="余额" width="110">
        <template #default="{ row }">¥{{ fenToYuan(row.balance) }}</template>
      </el-table-column>
      <el-table-column label="累计消耗" width="110">
        <template #default="{ row }">¥{{ fenToYuan(row.spent) }}</template>
      </el-table-column>
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

  <el-drawer v-model="drawer" size="480px" :title="detail?.email ?? '用户详情'">
    <template v-if="detail">
      <p>余额 ¥{{ fenToYuan(detail.balance) }} · 累计消耗 ¥{{ fenToYuan(detail.spent) }}</p>
      <p>状态 {{ detail.status }} · 角色 {{ detail.role }}</p>
      <el-form label-position="top">
        <el-form-item label="调账金额（分，可负）">
          <el-input-number v-model="adjustForm.amount" :step="100" />
        </el-form-item>
        <el-form-item label="原因">
          <el-input v-model="adjustForm.reason" maxlength="500" />
        </el-form-item>
        <el-button type="primary" @click="onAdjust">提交调账</el-button>
        <el-button
          v-if="detail.role !== 'admin'"
          type="danger"
          plain
          @click="onToggleStatus"
        >
          {{ detail.status === 'banned' ? '解封' : '封禁' }}
        </el-button>
      </el-form>
      <h4>在途预占</h4>
      <el-table :data="detail.holds" size="small">
        <el-table-column prop="jobId" label="任务" />
        <el-table-column label="金额">
          <template #default="{ row }">¥{{ fenToYuan(row.amount) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="90" />
      </el-table>
      <h4>充值订单</h4>
      <el-table :data="detail.orders" size="small">
        <el-table-column prop="orderNo" label="订单号" />
        <el-table-column label="金额" width="100">
          <template #default="{ row }">¥{{ fenToYuan(row.amount) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="90" />
      </el-table>
      <h4>调账记录</h4>
      <el-table :data="detail.adjustments" size="small">
        <el-table-column label="金额" width="100">
          <template #default="{ row }">¥{{ fenToYuan(row.amount) }}</template>
        </el-table-column>
        <el-table-column prop="reason" label="原因" />
      </el-table>
    </template>
  </el-drawer>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.search {
  width: 220px;
  margin-left: auto;
}
.status {
  width: 120px;
}
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
