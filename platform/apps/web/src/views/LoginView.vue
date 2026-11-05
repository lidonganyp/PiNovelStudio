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
  <div class="lp">
    <!-- 动态背景层 -->
    <canvas ref="canvasRef" class="lp-canvas" />
    <div class="lp-grid" />
    <div class="lp-orb lp-orb-a" />
    <div class="lp-orb lp-orb-b" />
    <div class="lp-orb lp-orb-c" />

    <!-- 顶部导航 -->
    <header class="lp-nav">
      <div class="lp-brand">
        <div class="lp-logo">π</div>
        <span class="lp-brand-name">PINOVEL&nbsp;STUDIO</span>
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
      </aside>
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
.lp {
  position: relative;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  color: #e2e8f0;
  background: radial-gradient(1200px 700px at 75% -10%, #16224d 0%, transparent 60%),
    radial-gradient(900px 600px at -10% 110%, #0d2b45 0%, transparent 55%),
    linear-gradient(160deg, #050914 0%, #081226 55%, #0a1a33 100%);
  overflow: hidden;
}

/* 背景层 */
.lp-canvas {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}
.lp-grid {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image: linear-gradient(rgba(96, 165, 250, 0.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(96, 165, 250, 0.06) 1px, transparent 1px);
  background-size: 56px 56px;
  mask-image: radial-gradient(ellipse 80% 70% at 50% 40%, #000 30%, transparent 75%);
  -webkit-mask-image: radial-gradient(ellipse 80% 70% at 50% 40%, #000 30%, transparent 75%);
}
.lp-orb {
  position: fixed;
  border-radius: 50%;
  filter: blur(90px);
  pointer-events: none;
  z-index: 0;
  opacity: 0.5;
  animation: lp-float 14s ease-in-out infinite;
}
.lp-orb-a {
  width: 480px;
  height: 480px;
  top: -160px;
  right: -120px;
  background: radial-gradient(circle, rgba(59, 130, 246, 0.55), transparent 65%);
}
.lp-orb-b {
  width: 420px;
  height: 420px;
  bottom: -140px;
  left: -120px;
  background: radial-gradient(circle, rgba(34, 211, 238, 0.4), transparent 65%);
  animation-delay: -5s;
}
.lp-orb-c {
  width: 300px;
  height: 300px;
  top: 40%;
  left: 55%;
  background: radial-gradient(circle, rgba(139, 92, 246, 0.35), transparent 65%);
  animation-delay: -9s;
}
@keyframes lp-float {
  0%,
  100% {
    transform: translate(0, 0) scale(1);
  }
  50% {
    transform: translate(-30px, 24px) scale(1.08);
  }
}

/* 导航 */
.lp-nav {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 22px 48px;
}
.lp-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.lp-logo {
  width: 40px;
  height: 40px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #3b82f6, #22d3ee);
  box-shadow: 0 0 24px rgba(59, 130, 246, 0.55);
  animation: lp-logo-pulse 3.2s ease-in-out infinite;
}
@keyframes lp-logo-pulse {
  0%,
  100% {
    box-shadow: 0 0 18px rgba(59, 130, 246, 0.45);
  }
  50% {
    box-shadow: 0 0 34px rgba(34, 211, 238, 0.75);
  }
}
.lp-brand-name {
  font-size: 14px;
  letter-spacing: 0.22em;
  font-weight: 600;
  color: #cbd5e1;
}
.lp-github {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 13px;
  color: #e2e8f0;
  text-decoration: none;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(8px);
  transition: border-color 0.25s, box-shadow 0.25s, transform 0.25s;
}
.lp-github:hover {
  border-color: rgba(96, 165, 250, 0.9);
  box-shadow: 0 0 18px rgba(59, 130, 246, 0.4);
  transform: translateY(-1px);
}

/* 主体布局 */
.lp-main {
  position: relative;
  z-index: 2;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 64px;
  max-width: 1280px;
  width: 100%;
  margin: 0 auto;
  padding: 24px 48px 56px;
}
.lp-hero {
  flex: 1.25;
  min-width: 0;
  animation: lp-rise 0.9s ease both;
}
.lp-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 16px;
  font-size: 12.5px;
  color: #93c5fd;
  border: 1px solid rgba(96, 165, 250, 0.4);
  border-radius: 999px;
  background: rgba(30, 58, 138, 0.28);
  backdrop-filter: blur(6px);
}
.lp-badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22d3ee;
  box-shadow: 0 0 10px #22d3ee;
  animation: lp-blink 1.8s ease-in-out infinite;
}
@keyframes lp-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
.lp-title {
  margin: 26px 0 16px;
  font-size: 52px;
  line-height: 1.22;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: #f1f5f9;
  text-wrap: balance;
}
.lp-title-glow {
  background: linear-gradient(92deg, #60a5fa 0%, #22d3ee 45%, #a78bfa 90%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: lp-shimmer 4.5s linear infinite;
  text-shadow: none;
}
@keyframes lp-shimmer {
  0% {
    background-position: 0% 0;
  }
  100% {
    background-position: 200% 0;
  }
}
.lp-subtitle {
  margin: 0;
  max-width: 560px;
  font-size: 15px;
  line-height: 1.9;
  color: #94a3b8;
  text-wrap: pretty;
}

/* 特性矩阵 */
.lp-features {
  margin-top: 40px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  max-width: 640px;
}
.lp-feature-card {
  position: relative;
  padding: 18px 20px;
  border-radius: 14px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: linear-gradient(150deg, rgba(15, 23, 42, 0.72), rgba(15, 23, 42, 0.4));
  backdrop-filter: blur(10px);
  transition: transform 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease;
  overflow: hidden;
}
.lp-feature-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(120deg, transparent 30%, rgba(96, 165, 250, 0.12) 50%, transparent 70%);
  background-size: 250% 100%;
  background-position: 120% 0;
  transition: background-position 0.8s ease;
  pointer-events: none;
}
.lp-feature-card:hover {
  transform: translateY(-4px);
  border-color: rgba(96, 165, 250, 0.55);
  box-shadow: 0 14px 34px rgba(37, 99, 235, 0.22);
}
.lp-feature-card:hover::before {
  background-position: -120% 0;
}
.lp-feature-icon {
  font-size: 22px;
}
.lp-feature-title {
  margin-top: 10px;
  font-size: 15px;
  font-weight: 600;
  color: #e2e8f0;
}
.lp-feature-desc {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.75;
  color: #8ea0b8;
}

/* 数据条 */
.lp-stats {
  margin-top: 36px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px 40px;
  max-width: 640px;
  padding-top: 22px;
  border-top: 1px solid rgba(148, 163, 184, 0.16);
}
.lp-stat-value {
  font-size: 24px;
  font-weight: 700;
  background: linear-gradient(90deg, #93c5fd, #22d3ee);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.lp-stat-label {
  margin-top: 4px;
  font-size: 12px;
  color: #7d8ea6;
}

/* 登录卡片 */
.lp-auth {
  flex-shrink: 0;
  animation: lp-rise 0.9s 0.15s ease both;
}
@keyframes lp-rise {
  from {
    opacity: 0;
    transform: translateY(22px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.lp-card {
  width: 380px;
  max-width: 100%;
  padding: 34px 34px 26px;
  border-radius: 18px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: rgba(13, 20, 38, 0.66);
  backdrop-filter: blur(16px);
  box-shadow: 0 24px 64px rgba(2, 8, 23, 0.55), 0 0 0 1px rgba(96, 165, 250, 0.06),
    0 0 42px rgba(59, 130, 246, 0.12);
}
.lp-card-title {
  margin: 0;
  font-size: 22px;
  font-weight: 650;
  color: #f1f5f9;
}
.lp-card-sub {
  margin: 6px 0 22px;
  font-size: 13px;
  color: #8ea0b8;
}
.lp-submit {
  width: 100%;
  margin-top: 4px;
  font-weight: 600;
  letter-spacing: 0.06em;
  background: linear-gradient(90deg, #2563eb, #0891b2);
  border: none;
  box-shadow: 0 8px 22px rgba(37, 99, 235, 0.4);
  transition: box-shadow 0.25s, transform 0.25s;
}
.lp-submit:hover {
  box-shadow: 0 10px 30px rgba(8, 145, 178, 0.55);
  transform: translateY(-1px);
}
.lp-card-footer {
  margin-top: 6px;
  text-align: center;
  font-size: 13px;
  color: #8ea0b8;
}

/* 深色表单适配 */
.lp-card :deep(.el-form-item__label) {
  color: #aebdd3;
}
.lp-card :deep(.el-input__wrapper) {
  background: rgba(2, 8, 23, 0.55);
  box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.28) inset;
}
.lp-card :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px #3b82f6 inset, 0 0 14px rgba(59, 130, 246, 0.35);
}
.lp-card :deep(.el-input__inner) {
  color: #e2e8f0;
}
.lp-card :deep(.el-input__inner::placeholder) {
  color: #55677f;
}

/* 页脚 */
.lp-footer {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 18px 24px 26px;
  font-size: 12.5px;
  color: #64748b;
}
.lp-footer-link {
  color: #60a5fa;
  text-decoration: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  transition: color 0.2s, text-shadow 0.2s;
}
.lp-footer-link:hover {
  color: #22d3ee;
  text-shadow: 0 0 12px rgba(34, 211, 238, 0.6);
}

/* 响应式 */
@media (max-width: 1080px) {
  .lp-main {
    gap: 40px;
    padding: 16px 32px 48px;
  }
  .lp-title {
    font-size: 40px;
  }
}
@media (max-width: 920px) {
  .lp-main {
    flex-direction: column;
    align-items: stretch;
    gap: 44px;
  }
  .lp-auth {
    display: flex;
    justify-content: center;
  }
  .lp-features {
    grid-template-columns: 1fr;
    max-width: none;
  }
  .lp-nav {
    padding: 18px 24px;
  }
  .lp-main {
    padding: 8px 24px 44px;
  }
  .lp-title {
    font-size: 34px;
  }
}
</style>
