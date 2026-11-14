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
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/projects';
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
  <div class="auth-page login-page">
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
      <router-link class="login-back" to="/">← 返回首页</router-link>
    </main>
  </div>
</template>

<style scoped>
/* 登录页专属星空视觉：仅在登录页生效，注册页仍使用 global.css 的共享样式 */
.login-page {
  position: relative;
  background:
    radial-gradient(900px 600px at 12% 0%, rgba(70, 110, 255, 0.28), transparent 62%),
    radial-gradient(800px 560px at 88% 8%, rgba(150, 80, 255, 0.22), transparent 62%),
    radial-gradient(900px 700px at 50% 110%, rgba(30, 90, 180, 0.22), transparent 62%),
    linear-gradient(180deg, #05070f 0%, #080b1a 50%, #05070f 100%);
}
.login-page::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0.55;
  background-image:
    radial-gradient(1.6px 1.6px at 24px 36px, rgba(255, 255, 255, 0.9), transparent),
    radial-gradient(1.2px 1.2px at 132px 96px, rgba(190, 215, 255, 0.75), transparent),
    radial-gradient(1.4px 1.4px at 76px 164px, rgba(255, 255, 255, 0.6), transparent);
  background-size: 200px 200px, 240px 240px, 320px 320px;
}
/* 左侧品牌区：半透明玻璃质感，保留原有 slogan 与特性列表 */
.login-page .auth-brand {
  z-index: 1;
  background: linear-gradient(
    160deg,
    rgba(10, 16, 34, 0.92) 0%,
    rgba(16, 26, 58, 0.86) 55%,
    rgba(22, 36, 78, 0.8) 100%
  );
  border-right: 1px solid rgba(140, 175, 255, 0.16);
  backdrop-filter: blur(10px);
}
.login-page .auth-brand-logo {
  background: linear-gradient(135deg, #4a7bff, #8a4bff);
  border: 1px solid rgba(160, 190, 255, 0.4);
  box-shadow: 0 8px 26px rgba(90, 110, 255, 0.45);
}
.login-page .auth-brand-name {
  color: #a9b8dd;
  opacity: 1;
}
.login-page .auth-slogan {
  color: #f2f6ff;
  letter-spacing: 0.5px;
}
.login-page .auth-slogan-sub {
  color: #b3bfdd;
  opacity: 1;
}
.login-page .auth-features li {
  border-top: 1px solid rgba(140, 175, 255, 0.16);
}
.login-page .auth-features .f-title {
  color: #e6ecff;
}
.login-page .auth-features .f-desc {
  color: #9dabcc;
  opacity: 1;
}
/* 右侧表单区 */
.login-page .auth-main {
  position: relative;
  z-index: 1;
}
.login-page .auth-card {
  width: 404px;
  color: #eaf0ff;
  border-radius: 18px;
  border: 1px solid rgba(140, 175, 255, 0.22);
  background: rgba(15, 22, 44, 0.72);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(18px);
}
.login-page .auth-card :deep(.el-card__body) {
  padding: 38px 36px 30px;
}
.login-page .auth-card .auth-title {
  color: #f2f6ff;
  font-size: 23px;
  letter-spacing: 0.5px;
}
.login-page .auth-card .auth-sub {
  color: #9aa8cc;
}
.login-page .auth-card :deep(.el-form-item__label) {
  color: #b9c4e2;
  font-weight: 500;
}
.login-page .auth-card :deep(.el-input__wrapper) {
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
  box-shadow: 0 0 0 1px rgba(140, 175, 255, 0.28) inset;
}
.login-page .auth-card :deep(.el-input__wrapper:hover) {
  box-shadow: 0 0 0 1px rgba(160, 195, 255, 0.5) inset;
}
.login-page .auth-card :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px #6f9bff inset;
}
.login-page .auth-card :deep(.el-input__inner) {
  color: #eaf0ff;
}
.login-page .auth-card :deep(.el-input__inner::placeholder) {
  color: #7c89ab;
}
.login-page .auth-card :deep(.el-input__suffix-inner) {
  color: #93a2c6;
}
.login-page .auth-submit {
  border: none;
  font-weight: 600;
  letter-spacing: 1px;
  background: linear-gradient(135deg, #4a7bff, #8a4bff);
  box-shadow: 0 10px 28px rgba(90, 100, 255, 0.4);
}
.login-page .auth-submit:hover {
  box-shadow: 0 12px 34px rgba(120, 110, 255, 0.6);
}
.login-page .auth-card .auth-footer {
  color: #93a2c6;
}
.login-page .auth-card .auth-footer :deep(.el-button) {
  color: #9db8ff;
}
.login-back {
  display: block;
  margin-top: 16px;
  text-align: center;
  font-size: 13px;
  color: #7f8cb0;
  text-decoration: none;
  transition: color 0.2s;
}
.login-back:hover {
  color: #c3cfea;
}
@media (max-width: 860px) {
  .login-page .auth-main {
    padding: 40px 20px;
  }
  .login-page .auth-card {
    width: 100%;
    max-width: 420px;
  }
}
</style>
