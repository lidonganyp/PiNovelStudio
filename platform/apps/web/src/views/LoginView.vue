<script setup lang="ts">
/**
 * 登录页：品牌区 + 邮箱密码表单，成功后跳转 redirect 参数指定的页面或门户首页。
 * 布局样式与注册页共享（styles/global.css 的 .auth-*）。
 */
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const form = reactive({
  email: '',
  password: '',
});
const loading = ref(false);

async function onSubmit(): Promise<void> {
  loading.value = true;
  try {
    await auth.login(form.email, form.password);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.push(redirect);
  } catch {
    // 错误提示由 http 拦截器统一弹出
  } finally {
    loading.value = false;
  }
}

async function goRegister(): Promise<void> {
  await router.push({ name: 'register' });
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
        <h2 class="auth-title">欢迎回来</h2>
        <p class="auth-sub">登录 PiNovel 平台，继续你的创作</p>
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
              autocomplete="current-password"
            />
          </el-form-item>
          <el-form-item>
            <el-button
              class="auth-submit"
              type="primary"
              native-type="submit"
              :loading="loading"
            >
              登录
            </el-button>
          </el-form-item>
        </el-form>
        <div class="auth-footer">
          还没有账号？
          <el-button text type="primary" @click="goRegister">立即注册</el-button>
        </div>
      </el-card>
    </main>
  </div>
</template>
