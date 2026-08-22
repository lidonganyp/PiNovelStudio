<script setup lang="ts">
/**
 * 注册页：邮箱 + 密码 + 确认密码 + 昵称，注册成功即登录并跳转门户首页。
 * 布局样式与登录页共享（styles/global.css 的 .auth-*）。
 */
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();

const form = reactive({
  email: '',
  password: '',
  confirmPassword: '',
  nickname: '',
});
const loading = ref(false);

async function onSubmit(): Promise<void> {
  if (form.password !== form.confirmPassword) {
    ElMessage.warning('两次输入的密码不一致');
    return;
  }
  loading.value = true;
  try {
    await auth.register(form.email, form.password, form.nickname);
    await router.push({ name: 'portal-home' });
  } catch {
    // 错误提示由 http 拦截器统一弹出
  } finally {
    loading.value = false;
  }
}

async function goLogin(): Promise<void> {
  await router.push({ name: 'login' });
}
</script>

<template>
  <div class="auth-page">
    <aside class="auth-brand">
      <div class="auth-brand-inner">
        <div class="auth-brand-logo">π</div>
        <div class="auth-brand-name">PINOVEL STUDIO</div>
        <h1 class="auth-slogan">把灵感，写成百万字长篇</h1>
        <p class="auth-slogan-sub">
          种子驱动 · 统一主链路生成 · 全书状态长期跟踪的 AI 小说创作工作台
        </p>
        <ul class="auth-features">
          <li>
            <div class="f-title">统一主链路生成</div>
            <div class="f-desc">Agentic 初稿经作者风格整章优化与事实复检后落库</div>
          </li>
          <li>
            <div class="f-title">种子驱动章节</div>
            <div class="f-desc">六要素章纲决定每章走向，写前契约清晰</div>
          </li>
          <li>
            <div class="f-title">全书记忆</div>
            <div class="f-desc">大纲、角色与伏笔跨章长期跟踪，拒绝设定漂移</div>
          </li>
        </ul>
      </div>
    </aside>
    <main class="auth-main">
      <el-card class="auth-card" shadow="never">
        <h2 class="auth-title">创建账号</h2>
        <p class="auth-sub">注册后直接进入创作工作台</p>
        <el-form :model="form" label-position="top" size="large" @submit.prevent="onSubmit">
          <el-form-item label="邮箱">
            <el-input
              v-model="form.email"
              placeholder="you@example.com"
              autocomplete="email"
            />
          </el-form-item>
          <el-form-item label="密码">
            <el-input
              v-model="form.password"
              type="password"
              show-password
              placeholder="至少 8 位"
              autocomplete="new-password"
            />
          </el-form-item>
          <el-form-item label="确认密码">
            <el-input
              v-model="form.confirmPassword"
              type="password"
              show-password
              placeholder="再次输入密码"
              autocomplete="new-password"
            />
          </el-form-item>
          <el-form-item label="昵称">
            <el-input v-model="form.nickname" placeholder="1-32 字符" />
          </el-form-item>
          <el-form-item>
            <el-button
              class="auth-submit"
              type="primary"
              native-type="submit"
              :loading="loading"
            >
              注册
            </el-button>
          </el-form-item>
        </el-form>
        <div class="auth-footer">
          已有账号？
          <el-button text type="primary" @click="goLogin">返回登录</el-button>
        </div>
      </el-card>
    </main>
  </div>
</template>
