<script setup lang="ts">
/**
 * 管理后台布局：左侧菜单 + 顶栏退出。P7-6 覆盖 §10.2 全部页面。
 */
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();

function onLogout(): void {
  auth.logout();
  void router.push({ name: 'login' });
}
</script>

<template>
  <el-container class="admin">
    <el-aside width="200px" class="admin-aside">
      <div class="admin-brand">管理后台</div>
      <el-menu router :default-active="$route.path">
        <el-menu-item index="/admin">概览</el-menu-item>
        <el-menu-item index="/admin/users">用户</el-menu-item>
        <el-menu-item index="/admin/models">模型与费率</el-menu-item>
        <el-menu-item index="/admin/usage">用量</el-menu-item>
        <el-menu-item index="/admin/revenue">收入</el-menu-item>
        <el-menu-item index="/admin/orders">充值订单</el-menu-item>
        <el-menu-item index="/admin/audit">审计日志</el-menu-item>
        <el-menu-item index="/admin/settings">系统设置</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="admin-header">
        <span class="spacer" />
        <span class="who">{{ auth.user?.nickname }}</span>
        <el-button text @click="router.push({ name: 'portal-home' })">用户门户</el-button>
        <el-button text @click="onLogout">退出</el-button>
      </el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.admin {
  min-height: 100vh;
}
.admin-aside {
  border-right: 1px solid var(--el-border-color);
}
.admin-brand {
  height: 56px;
  display: flex;
  align-items: center;
  padding: 0 20px;
  font-weight: 600;
  font-size: 16px;
}
.admin-header {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--el-border-color);
}
.spacer {
  flex: 1;
}
.who {
  font-size: 14px;
  color: var(--el-text-color-secondary);
}
</style>
