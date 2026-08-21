<script setup lang="ts">
/**
 * 用户门户布局：顶导航（品牌 / 余额 / 退出），内容区承载子路由。
 */
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { fenToYuan } from '../api/billing';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();

/** 门户导航项。 */
const navItems: Array<{ name: string; label: string }> = [
  { name: 'portal-home', label: '我的项目' },
  { name: 'billing', label: '计费明细' },
  { name: 'recharge', label: '充值' },
];

function onLogout(): void {
  auth.logout();
  void router.push({ name: 'login' });
}

onMounted(() => {
  void auth.fetchMe();
});
</script>

<template>
  <el-container class="portal">
    <el-header class="portal-header">
      <span class="brand">PiNovel 平台</span>
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
      <span v-if="auth.user" class="balance">
        {{ auth.user.nickname }} · 余额 ¥{{ fenToYuan(auth.user.totalBalance) }}
      </span>
      <el-button
        v-if="auth.role === 'admin'"
        text
        @click="router.push({ name: 'admin-home' })"
      >
        管理后台
      </el-button>
      <el-button v-if="auth.user" text @click="onLogout">退出</el-button>
    </el-header>
    <el-main>
      <router-view />
    </el-main>
  </el-container>
</template>

<style scoped>
.portal {
  min-height: 100vh;
}
.portal-header {
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--el-border-color);
}
.brand {
  font-weight: 600;
  font-size: 16px;
}
.nav {
  display: flex;
  gap: 4px;
  margin-left: 16px;
}
.nav-link {
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 14px;
  color: var(--el-text-color-regular);
  text-decoration: none;
}
.nav-link:hover {
  background: var(--el-fill-color-light);
}
.nav-link.router-link-active {
  color: var(--el-color-primary);
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.balance {
  color: var(--el-text-color-secondary);
  font-size: 14px;
}
</style>
