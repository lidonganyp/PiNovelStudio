<script setup lang="ts">
/**
 * 用户门户布局：顶导航（品牌 / 导航项 / 余额 / 用户菜单），内容区承载子路由。
 * 工作台路由下主区去 padding 并转为 flex 列容器，让三栏撑满高度。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import { authApi } from '../api/auth';
import { fenToYuan } from '../api/billing';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

/** 门户导航项。 */
const navItems: Array<{ name: string; label: string }> = [
  { name: 'portal-home', label: '我的项目' },
  { name: 'billing', label: '计费明细' },
  { name: 'recharge', label: '充值' },
];

/** 工作台页需要无 padding 的满高布局。 */
const isWorkspace = computed(() => route.name === 'workspace');

const passwordDialog = ref(false);
const passwordSaving = ref(false);
const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
});

function resetPasswordForm(): void {
  passwordForm.currentPassword = '';
  passwordForm.newPassword = '';
  passwordForm.confirmPassword = '';
}

function onUserCommand(command: string): void {
  if (command === 'admin') {
    void router.push({ name: 'admin-home' });
    return;
  }
  if (command === 'password') {
    resetPasswordForm();
    passwordDialog.value = true;
    return;
  }
  if (command === 'logout') {
    auth.logout();
    void router.push({ name: 'login' });
  }
}

async function onChangePassword(): Promise<void> {
  if (passwordForm.newPassword.length < 8) {
    ElMessage.warning('新密码至少 8 位');
    return;
  }
  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    ElMessage.warning('两次输入的新密码不一致');
    return;
  }
  if (passwordForm.currentPassword === passwordForm.newPassword) {
    ElMessage.warning('新密码不能与当前密码相同');
    return;
  }
  passwordSaving.value = true;
  try {
    await authApi.changePassword({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword,
    });
    ElMessage.success('密码已更新');
    passwordDialog.value = false;
    resetPasswordForm();
  } catch {
    // 错误提示由 http 拦截器统一弹出
  } finally {
    passwordSaving.value = false;
  }
}

onMounted(() => {
  void auth.fetchMe();
});
</script>

<template>
  <el-container class="portal">
    <el-header class="portal-header">
      <router-link class="brand" :to="{ name: 'portal-home' }">
        <span class="brand-logo">π</span>
        <span class="brand-name">PiNovel 平台</span>
      </router-link>
      <nav class="nav">
        <router-link
          v-for="item in navItems"
          :key="item.name"
          :to="{ name: item.name }"
          class="nav-link"
        >
          {{ item.label }}
        </router-link>
      </nav>
      <span class="spacer" />
      <router-link
        v-if="auth.user"
        class="balance-chip"
        :to="{ name: 'recharge' }"
        title="点击查看充值"
      >
        <span class="balance-label">余额</span>
        <span class="balance-value tnum">¥{{ fenToYuan(auth.user.totalBalance) }}</span>
      </router-link>
      <el-dropdown v-if="auth.user" trigger="click" @command="onUserCommand">
        <button type="button" class="user-chip">
          <span class="avatar">{{ auth.user.nickname.slice(0, 1) }}</span>
          <span class="nickname">{{ auth.user.nickname }}</span>
          <el-icon class="caret"><ArrowDown /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-if="auth.role === 'admin'" command="admin">
              管理后台
            </el-dropdown-item>
            <el-dropdown-item command="password">
              修改密码
            </el-dropdown-item>
            <el-dropdown-item command="logout" divided>
              退出登录
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </el-header>
    <el-main class="portal-main" :class="{ 'workspace-main': isWorkspace }">
      <router-view />
    </el-main>
    <el-dialog
      v-model="passwordDialog"
      title="修改密码"
      width="420px"
      destroy-on-close
      @closed="resetPasswordForm"
    >
      <el-form label-position="top" @submit.prevent="onChangePassword">
        <el-form-item label="当前密码" required>
          <el-input
            v-model="passwordForm.currentPassword"
            type="password"
            show-password
            autocomplete="current-password"
          />
        </el-form-item>
        <el-form-item label="新密码" required>
          <el-input
            v-model="passwordForm.newPassword"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="至少 8 位"
          />
        </el-form-item>
        <el-form-item label="确认新密码" required>
          <el-input
            v-model="passwordForm.confirmPassword"
            type="password"
            show-password
            autocomplete="new-password"
            @keyup.enter="onChangePassword"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="passwordDialog = false">取消</el-button>
        <el-button type="primary" :loading="passwordSaving" @click="onChangePassword">
          保存
        </el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<style scoped>
/* 固定为视口高度：页面不随内容撑高，滚动交给 el-main 或工作台各栏内部承担 */
.portal {
  height: 100vh;
}
.portal-header {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: nowrap;
  background: #fff;
  border-bottom: 1px solid var(--el-border-color-lighter);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  position: relative;
  z-index: 10;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  text-decoration: none;
}
.brand-logo {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #3b6fe0, #7c5cff);
  box-shadow: 0 2px 6px rgba(59, 111, 224, 0.35);
}
.brand-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
}
.nav {
  display: flex;
  gap: 2px;
  margin-left: 8px;
  flex-shrink: 0;
}
.nav-link {
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 14px;
  color: var(--el-text-color-regular);
  text-decoration: none;
  white-space: nowrap;
  transition: color 150ms ease-out, background-color 150ms ease-out;
}
.nav-link:hover {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
}
.nav-link.router-link-active {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.balance-chip {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--el-color-primary-light-9);
  text-decoration: none;
  flex-shrink: 0;
  white-space: nowrap;
  transition: background-color 150ms ease-out;
}
.balance-chip:hover {
  background: var(--el-color-primary-light-8);
}
.balance-label {
  font-size: 12px;
  color: var(--el-color-primary);
  opacity: 0.8;
}
.balance-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-color-primary);
}
.user-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
  white-space: nowrap;
  outline: none;
  transition: background-color 150ms ease-out;
}
.user-chip:hover {
  background: var(--el-fill-color-light);
}
.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  background: var(--el-color-primary-light-7);
  color: var(--el-color-primary-dark-2);
}
.nickname {
  font-size: 14px;
  color: var(--el-text-color-primary);
}
.caret {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.portal-main {
  background: #f5f6f8;
}
.portal-main.workspace-main {
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
