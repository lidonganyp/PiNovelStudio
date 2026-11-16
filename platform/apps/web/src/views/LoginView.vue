<script setup lang="ts">
/**
 * 首页（登录页）：科技感品牌首页 + 登录入口。
 * 全屏粒子网络动效 + 渐变光晕 + 特性矩阵，突出项目核心优势；
 * 页面底部标注开源地址：https://github.com/lidonganyp/PiNovelStudio
 */
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
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

/* ---------------- 粒子网络动效 ---------------- */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

const canvasRef = ref<HTMLCanvasElement | null>(null);
let rafId = 0;
let particles: Particle[] = [];
let mouseX = -9999;
let mouseY = -9999;

function initParticles(width: number, height: number): void {
  const density = Math.min(110, Math.floor((width * height) / 16000));
  particles = Array.from({ length: density }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    vx: (Math.random() - 0.5) * 0.45,
    vy: (Math.random() - 0.5) * 0.45,
    r: Math.random() * 1.6 + 0.6,
  }));
}

function tick(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  const linkDist = 130;
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.x < 0 || p.x > width) p.vx *= -1;
    if (p.y < 0 || p.y > height) p.vy *= -1;

    const dxm = mouseX - p.x;
    const dym = mouseY - p.y;
    const dm = Math.hypot(dxm, dym);
    if (dm < 160 && dm > 0.001) {
      p.x += (dxm / dm) * 0.25;
      p.y += (dym / dm) * 0.25;
    }
  }

  for (let i = 0; i < particles.length; i += 1) {
    const a = particles[i];
    for (let j = i + 1; j < particles.length; j += 1) {
      const b = particles[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < linkDist) {
        const alpha = (1 - d / linkDist) * 0.35;
        ctx.strokeStyle = `rgba(96, 165, 250, ${alpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  for (const p of particles) {
    ctx.fillStyle = 'rgba(147, 197, 253, 0.9)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }

  rafId = window.requestAnimationFrame(tick);
}

function resizeCanvas(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  initParticles(canvas.width, canvas.height);
}

function onMouseMove(e: MouseEvent): void {
  mouseX = e.clientX;
  mouseY = e.clientY;
}

onMounted(() => {
  resizeCanvas();
  tick();
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('mousemove', onMouseMove);
});

onBeforeUnmount(() => {
  window.cancelAnimationFrame(rafId);
  window.removeEventListener('resize', resizeCanvas);
  window.removeEventListener('mousemove', onMouseMove);
});

/* ---------------- 特性与数据 ---------------- */

const features = [
  {
    icon: '⚡',
    title: '统一主链路生成',
    desc: 'Agentic 初稿 → 作者风格整章优化 → 事实复检落库，一条流水线产出可连载章节',
  },
  {
    icon: '🌱',
    title: '种子驱动章节',
    desc: '六要素章纲决定每章走向，写前契约清晰，AI 不再自由发挥跑题',
  },
  {
    icon: '🧠',
    title: '全书长期记忆',
    desc: '大纲、角色、伏笔跨章跟踪，百万字长篇设定不漂移、不吃书',
  },
  {
    icon: '🛠️',
    title: '可介入工作台',
    desc: '章节树、版本回溯、修订恢复、AI 助手对话，创作全程可控可改',
  },
];

const stats = [
  { value: '100万+', label: '字长篇连贯生成' },
  { value: '6 要素', label: '章纲种子契约' },
  { value: '3 道关', label: '初稿/优化/复检' },
  { value: '100%', label: '开源可自部署' },
];

const githubUrl = 'https://github.com/lidonganyp/PiNovelStudio';
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
      <a class="lp-github" :href="githubUrl" target="_blank" rel="noopener">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
          />
        </svg>
        <span>GitHub</span>
      </a>
    </header>

    <!-- 主体 -->
    <main class="lp-main">
      <section class="lp-hero">
        <div class="lp-badge">
          <span class="lp-badge-dot" />
          AI 驱动的长篇小说创作工作台 · 开源
        </div>
        <h1 class="lp-title">
          把灵感，写成
          <span class="lp-title-glow">百万字长篇</span>
        </h1>
        <p class="lp-subtitle">
          种子驱动 · 统一主链路生成 · 全书状态长期跟踪。
          PiNovel Studio 让 AI 像职业作者一样，稳定地产出连贯、可控、可连载的长篇小说。
        </p>

        <div class="lp-features">
          <div v-for="f in features" :key="f.title" class="lp-feature-card">
            <div class="lp-feature-icon">{{ f.icon }}</div>
            <div class="lp-feature-title">{{ f.title }}</div>
            <div class="lp-feature-desc">{{ f.desc }}</div>
          </div>
        </div>

        <div class="lp-stats">
          <div v-for="s in stats" :key="s.label" class="lp-stat">
            <div class="lp-stat-value tnum">{{ s.value }}</div>
            <div class="lp-stat-label">{{ s.label }}</div>
          </div>
        </div>
      </section>

      <aside class="lp-auth">
        <div class="lp-card">
          <h2 class="lp-card-title">开启创作</h2>
          <p class="lp-card-sub">登录 PiNovel 平台，继续你的长篇小说</p>
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
                class="lp-submit"
                type="primary"
                native-type="submit"
                :loading="loading"
              >
                进入工作台
              </el-button>
            </el-form-item>
          </el-form>
          <div class="lp-card-footer">
            还没有账号？
            <el-button text type="primary" @click="goRegister">立即注册</el-button>
          </div>
        </div>
      </el-card>
      <router-link class="login-back" to="/">← 返回首页</router-link>
    </main>

    <!-- 底部开源信息 -->
    <footer class="lp-footer">
      <span class="lp-footer-text">开源项目 · Open Source</span>
      <a class="lp-footer-link" :href="githubUrl" target="_blank" rel="noopener">
        {{ githubUrl }}
      </a>
    </footer>
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
