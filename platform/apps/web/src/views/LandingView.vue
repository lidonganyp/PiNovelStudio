<template>
  <div class='landing'>
    <canvas ref='skyRef' class='star-canvas'></canvas>
    <div class='glow glow-a'></div>
    <div class='glow glow-b'></div>
    <header class='nav'>
      <div class='brand'>
        <span class='brand-mark'>π</span>
        <span class='brand-name'>PiNovel <b>Studio</b></span>
      </div>
      <nav class='nav-links'>
        <a class='nav-link' :href='repoUrl' target='_blank' rel='noopener noreferrer'>GitHub 开源</a>
        <a class='nav-link' href='#features'>功能亮点</a>
        <a class='nav-link' href='#steps'>使用流程</a>
        <button class='btn btn-ghost' @click='goLogin'>登录</button>
        <button class='btn btn-primary' @click='goExperience'>立即体验 →</button>
      </nav>
    </header>
    <main class='hero'>
      <div class='hero-badge'>✦ AI 驱动的交互式长篇小说创作工作台</div>
      <h1 class='hero-title'>一句话灵感，<br /><span class='grad'>长成百万字宇宙</span></h1>
      <p class='hero-sub'>输入一个种子设定，AI 自动规划主线、逐章生成、长期跟踪全书状态。<br />你负责天马行空，把一部能一直写下去、还能互动的长篇交给它。</p>
      <div class='hero-actions'>
        <button class='btn btn-primary btn-lg' @click='goExperience'>立即免费体验 →</button>
        <a class='btn btn-outline btn-lg' :href='repoUrl' target='_blank' rel='noopener noreferrer'>★ 查看开源仓库</a>
      </div>
      <p class='hero-opensource'>完全开源 · 免费开始 · <a :href='repoUrl' target='_blank' rel='noopener noreferrer'>{{ repoUrl }}</a></p>
      <section id='features' class='features'>
        <div class='card' v-for='(f, i) in features' :key='i'>
          <div class='card-icon'>{{ f.icon }}</div>
          <h3 class='card-title'>{{ f.title }}</h3>
          <p class='card-desc'>{{ f.desc }}</p>
        </div>
      </section>
      <section id='steps' class='steps'>
        <h2 class='section-title'>三步，从灵感到成书</h2>
        <p class='section-sub'>不用背写作模板，也不用手动维护设定表</p>
        <div class='step-list'>
          <div class='step' v-for='(s, i) in steps' :key='s.title'>
            <div class='step-num'>{{ '0' + (i + 1) }}</div>
            <h3 class='step-title'>{{ s.title }}</h3>
            <p class='step-desc'>{{ s.desc }}</p>
          </div>
        </div>
      </section>
      <section class='cta'>
        <h2 class='cta-title'>现在，就把那个念头写下去</h2>
        <p class='cta-sub'>注册即可开始，作品随时导出，开源仓库欢迎 Star</p>
        <div class='cta-actions'>
          <button class='btn btn-primary btn-lg' @click='goExperience'>开始创作 →</button>
          <a class='btn btn-outline btn-lg' :href='repoUrl' target='_blank' rel='noopener noreferrer'>★ GitHub Star</a>
        </div>
      </section>
    </main>
    <footer class='foot'>
      <span>PiNovel Studio · 让每个灵感都有一部自己的长篇</span>
      <a :href='repoUrl' target='_blank' rel='noopener noreferrer'>{{ repoUrl }}</a>
    </footer>
  </div>
</template>

<script setup lang='ts'>
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const repoUrl = 'https://github.com/lidonganyp/PiNovelStudio';
const features = [
  { icon: '🌱', title: '种子设定', desc: '一段世界观与人设，就是整部小说的起点，随时开坑。' },
  { icon: '🧭', title: '主线生成', desc: '统一主链路自动规划大纲、分卷分章，故事一路向前。' },
  { icon: '🧠', title: '状态跟踪', desc: '人物、伏笔、时间线长期记忆，百万字前后不矛盾、不烂尾。' },
  { icon: '🚀', title: '一键成书', desc: '全书随时导出，接着写、开分支，创作永不中断。' },
];
const steps = [
  { title: '写下种子', desc: '一句设定就能开坑，世界观、人物与冲突由你定义。' },
  { title: 'AI 接住主线', desc: '自动拆解卷章结构，六要素章纲写前定契约，逐章稳定生成。' },
  { title: '一路写到完本', desc: '全书状态跨章跟踪，随时导出成书，也能从任意章节继续。' },
];

function goExperience() { void router.push('/projects'); }
function goLogin() { void router.push('/login'); }

const skyRef = ref<HTMLCanvasElement | null>(null);
let raf = 0;
let ctx: CanvasRenderingContext2D | null = null;
let w = 0;
let h = 0;
let dpr = 1;
type Star = { x: number; y: number; r: number; a: number; s: number };
type Meteor = { x: number; y: number; len: number; v: number };
let stars: Star[] = [];
let meteors: Meteor[] = [];

function resize() {
  const c = skyRef.value;
  if (!c) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  w = window.innerWidth;
  h = window.innerHeight;
  c.width = w * dpr;
  c.height = h * dpr;
  c.style.width = w + 'px';
  c.style.height = h + 'px';
  ctx = c.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const count = Math.min(220, Math.floor((w * h) / 7000));
  stars = Array.from({ length: count }, () => ({ x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.4 + 0.2, a: Math.random(), s: Math.random() * 0.02 + 0.005 }));
}

function frame() {
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  for (const st of stars) {
    st.a += st.s;
    const alpha = 0.3 + (Math.sin(st.a) + 1) * 0.35;
    ctx.beginPath();
    ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(200, 225, 255, ' + alpha.toFixed(2) + ')';
    ctx.fill();
  }
  if (Math.random() < 0.008 && meteors.length < 3) meteors.push({ x: Math.random() * w * 0.6 + w * 0.2, y: -20, len: Math.random() * 120 + 80, v: Math.random() * 4 + 6 });
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    // 尾迹严格沿运动反方向延伸：头部速度向量为 (0.7, 1)，归一化后取反
    const dirLen = Math.hypot(0.7, 1);
    const tailX = m.x - (m.len * 0.7) / dirLen;
    const tailY = m.y - m.len / dirLen;
    const g = ctx.createLinearGradient(m.x, m.y, tailX, tailY);
    g.addColorStop(0, 'rgba(215, 238, 255, 0.95)');
    g.addColorStop(0.45, 'rgba(190, 220, 255, 0.35)');
    g.addColorStop(1, 'rgba(180, 220, 255, 0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();
    const head = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, 8);
    head.addColorStop(0, 'rgba(240, 248, 255, 0.9)');
    head.addColorStop(1, 'rgba(180, 220, 255, 0)');
    ctx.fillStyle = head;
    ctx.beginPath();
    ctx.arc(m.x, m.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(m.x, m.y, 1.7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(245, 250, 255, 0.98)';
    ctx.fill();
    m.x += m.v * 0.7;
    m.y += m.v;
    if (m.y - m.len > h || m.x - m.len > w) meteors.splice(i, 1);
  }
  raf = requestAnimationFrame(frame);
}

function onResize() { resize(); }
onMounted(() => { resize(); raf = requestAnimationFrame(frame); window.addEventListener('resize', onResize); });
onUnmounted(() => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); });
</script>

<style scoped>
.landing { position: fixed; inset: 0; z-index: 20; overflow-y: auto; color: #eaf0ff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; background: radial-gradient(1200px 700px at 20% -10%, rgba(60, 90, 200, 0.35), transparent 60%), radial-gradient(900px 600px at 90% 10%, rgba(120, 60, 200, 0.3), transparent 60%), radial-gradient(1000px 800px at 50% 100%, rgba(20, 80, 160, 0.25), transparent 60%), linear-gradient(180deg, #05070f 0%, #080b1a 45%, #05070f 100%); }
.star-canvas { position: fixed; inset: 0; z-index: 0; pointer-events: none; }
.glow { position: fixed; border-radius: 50%; filter: blur(90px); opacity: 0.5; pointer-events: none; z-index: 0; }
.glow-a { width: 380px; height: 380px; top: -80px; left: 10%; background: rgba(70, 110, 255, 0.35); }
.glow-b { width: 420px; height: 420px; top: 120px; right: 5%; background: rgba(150, 80, 255, 0.28); }
.nav { position: relative; z-index: 2; max-width: 1180px; margin: 0 auto; padding: 26px 28px; display: flex; align-items: center; justify-content: space-between; }
.brand { display: flex; align-items: center; gap: 12px; }
.brand-mark { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; font-size: 24px; font-weight: 700; color: #fff; background: linear-gradient(135deg, #4a7bff, #8a4bff); box-shadow: 0 6px 24px rgba(90, 110, 255, 0.5); }
.brand-name { font-size: 19px; font-weight: 600; letter-spacing: 0.3px; }
.brand-name b { background: linear-gradient(90deg, #7aa2ff, #c07aff); -webkit-background-clip: text; background-clip: text; color: transparent; }
.nav-links { display: flex; align-items: center; gap: 22px; }
.nav-link { color: #aeb9d8; text-decoration: none; font-size: 14px; transition: color 0.2s; }
.nav-link:hover { color: #fff; }
.btn { cursor: pointer; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; padding: 10px 18px; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; transition: transform 0.15s, box-shadow 0.2s, background 0.2s; font-family: inherit; }
.btn:active { transform: translateY(1px); }
.btn-ghost { background: transparent; color: #dbe4ff; }
.btn-ghost:hover { background: rgba(255, 255, 255, 0.08); }
.btn-primary { color: #fff; background: linear-gradient(135deg, #4a7bff, #8a4bff); box-shadow: 0 8px 26px rgba(90, 100, 255, 0.45); }
.btn-primary:hover { box-shadow: 0 10px 34px rgba(120, 110, 255, 0.7); transform: translateY(-1px); }
.btn-outline { color: #eaf0ff; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(160, 185, 255, 0.35); backdrop-filter: blur(8px); }
.btn-outline:hover { background: rgba(255, 255, 255, 0.12); }
.btn-lg { padding: 15px 30px; font-size: 16px; border-radius: 12px; }
.hero { position: relative; z-index: 2; max-width: 1180px; margin: 0 auto; padding: 70px 28px 40px; text-align: center; }
.hero-badge { display: inline-block; padding: 8px 18px; border-radius: 999px; font-size: 13.5px; color: #bcd0ff; background: rgba(90, 120, 255, 0.12); border: 1px solid rgba(130, 160, 255, 0.35); backdrop-filter: blur(8px); margin-bottom: 30px; }
.hero-title { font-size: clamp(38px, 6vw, 68px); line-height: 1.15; font-weight: 800; margin: 0 0 24px; letter-spacing: 1px; }
.grad { background: linear-gradient(90deg, #6fa0ff 0%, #a06bff 50%, #ff7ac6 100%); -webkit-background-clip: text; background-clip: text; color: transparent; }
.hero-sub { max-width: 720px; margin: 0 auto 38px; font-size: 17px; line-height: 1.9; color: #b9c4e2; }
.hero-actions { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
.hero-opensource { margin-top: 26px; font-size: 13.5px; color: #7f8cb0; }
.hero-opensource a { color: #8fb0ff; text-decoration: none; }
.hero-opensource a:hover { text-decoration: underline; }
.features { margin-top: 90px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; text-align: left; }
.card { padding: 26px 22px; border-radius: 18px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(150, 180, 255, 0.16); backdrop-filter: blur(14px); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25); transition: transform 0.2s, border-color 0.2s, background 0.2s; }
.card:hover { transform: translateY(-6px); border-color: rgba(160, 190, 255, 0.45); background: rgba(255, 255, 255, 0.08); }
.card-icon { font-size: 30px; margin-bottom: 16px; }
.card-title { font-size: 18px; margin: 0 0 10px; font-weight: 700; color: #eef3ff; }
.card-desc { font-size: 13.5px; line-height: 1.8; color: #a6b2d2; margin: 0; }
.steps { margin-top: 110px; text-align: center; }
.section-title { font-size: clamp(26px, 3.4vw, 36px); margin: 0 0 12px; font-weight: 800; letter-spacing: 0.5px; }
.section-sub { margin: 0 0 42px; color: #9aa7c8; font-size: 14.5px; }
.step-list { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; text-align: left; }
.step { padding: 30px 24px 26px; border-radius: 18px; background: linear-gradient(160deg, rgba(80, 110, 255, 0.14), rgba(140, 80, 255, 0.06)); border: 1px solid rgba(140, 170, 255, 0.2); backdrop-filter: blur(12px); transition: transform 0.2s, border-color 0.2s; }
.step:hover { transform: translateY(-4px); border-color: rgba(160, 190, 255, 0.45); }
.step-num { font-size: 30px; font-weight: 800; letter-spacing: 1px; background: linear-gradient(120deg, #6fa0ff, #c07aff); -webkit-background-clip: text; background-clip: text; color: transparent; margin-bottom: 12px; }
.step-title { font-size: 17px; margin: 0 0 10px; font-weight: 700; color: #eef3ff; }
.step-desc { font-size: 13.5px; line-height: 1.85; color: #a6b2d2; margin: 0; }
.cta { margin: 110px 0 20px; padding: 54px 28px; border-radius: 26px; text-align: center; background: radial-gradient(600px 200px at 50% 0%, rgba(110, 140, 255, 0.28), transparent 70%), linear-gradient(160deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.02)); border: 1px solid rgba(150, 180, 255, 0.22); backdrop-filter: blur(14px); }
.cta-title { font-size: clamp(24px, 3vw, 32px); margin: 0 0 12px; font-weight: 800; }
.cta-sub { margin: 0 0 30px; color: #a3b0d0; font-size: 14.5px; }
.cta-actions { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
.foot { position: relative; z-index: 2; max-width: 1180px; margin: 0 auto; padding: 60px 28px 40px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; color: #6f7ba0; font-size: 13px; }
.foot a { color: #8fb0ff; text-decoration: none; }
.foot a:hover { text-decoration: underline; }
@media (max-width: 900px) { .features { grid-template-columns: repeat(2, 1fr); } .step-list { grid-template-columns: 1fr; } .nav-links .nav-link { display: none; } }
@media (max-width: 560px) { .features { grid-template-columns: 1fr; } .hero { padding-top: 40px; } .cta { margin-top: 70px; padding: 38px 20px; } .foot { flex-direction: column; } }
</style>
