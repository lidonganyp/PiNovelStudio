# PiNovelStudio

<div align="center">

**把灵感，写成百万字长篇**

AI 驱动的中文长篇小说创作工作台 —— 种子驱动 · 统一主链路生成 · 全书状态长期跟踪

[GitHub 仓库](https://github.com/lidonganyp/PiNovelStudio) · [快速开始](#快速开始) · [核心优势](#为什么选择-pinovelstudio)

</div>

---

## 为什么选择 PiNovelStudio

市面上大多数 AI 写作工具只能写出「看起来不错」的几千字短篇——一旦进入长篇连载，设定漂移、伏笔丢失、人物性格前后矛盾就会接踵而来。**PiNovelStudio 从架构第一天起就为「百万字级长篇连载」而设计**。

| 核心优势 | 说明 |
|----------|------|
| 🧠 **全书记忆，拒绝吃书** | 大纲、角色、伏笔、文风四大长期叙事状态（CanonState / CharacterState / PromiseLedger / PatternMemory）跨章持续跟踪，只在最终正文确认后提交。写到第 200 章，主角的名字、性格、埋在第 30 章的伏笔依然分毫不差。 |
| ⚡ **统一主链路，质量稳定** | 每一章都走同一条工业流水线：Agentic 初稿 → 作者风格整章优化 → 事实复检 → 完整性校验 → 原子落库。不存在「这次好、下次差」的抽奖体验，更没有静默降级。 |
| 🌱 **种子驱动，写前契约清晰** | 六要素章纲（Chapter Seed）决定每章走向。AI 不自由发挥、不跑题——你永远是导演，AI 是执行力拉满的写手。 |
| 🛡️ **事实硬门，文学软诊断** | 空文、截断、人名/实体/时间线/世界观硬冲突直接阻断交付；风格、AI 腔、对白比例只作诊断证据。坏章节进不了你的书。 |
| 🛠️ **全程可介入的创作工作台** | 章节树、版本回溯、修订恢复、AI 助手对话式改稿——生成不是黑盒，每一步都可看、可改、可回退。 |
| 📦 **开源可自部署** | MIT 协议，生成内核 + 商用平台全量开源。数据留在自己手里，模型路由自由配置。 |

## 它适合谁

- **网文作者**：把 AI 当成不知疲倦的 co-writer，专注创意与裁决，日更万字不再靠肝。
- **长篇创作者**：需要跨数百章保持一致世界观与角色弧光的严肃写作。
- **AI 应用开发者**：研究 Agentic 长文生成、叙事状态管理、质量门禁架构的完整生产级参考实现。

## 系统架构

每一章的生成都经过同一条统一主链路（`novel_generate_chapter` 是唯一公开入口）：

    Preflight            生成前预检（配置 / 角色 / 种子 / 预算）
      ↓
    ContextCompiler      长程记忆召回：评分工作集 + 伏笔强制通道 + 连续性快照
      ↓
    NovelOS Agentic      初稿（ReAct + 叙事检索工具）
      ↓
    FactGuard            事实硬门校验
      ↓
    作者风格整章优化      读取风格档案定性指导，初稿不得直接交付
      ↓
    FinalFactRecheck     终检 + 完整性校验
      ↓
    FinalStateCommit     长期状态提交 + 原子保存 + 全链路 Trace

任何阶段失败都会产出结构化阻断（FailureEnvelope），**绝不静默交付半成品**。

项目由两部分组成：

1. **生成内核**（`.pi/extensions/novel-studio/`）：以 PI (AI Coding Agent) 为编排大脑的 PI 扩展，提供 6 个公开工具（章节生成、工作空间管理、预检、大纲规划、策略视图、反馈回灌）。
2. **商用平台**（`platform/`）：Vue 3 用户门户 + NestJS 计费引擎 + novel-runtime 编排服务，docker compose 一键组网。

## 快速开始

### 1. 安装与构建

    npm install
    npm run build          # 三目标：dist/ + dist-eval/ + dist-test/

### 2. 配置模型

    cp .env.example .env   # 填入 GEMINI_* / GPT_* / CLAUDE_* 密钥

必需项为 `GEMINI_MODEL` / `GOOGLE_GEMINI_BASE_URL` / `GEMINI_API_KEY`；可选 `PINOVEL_MODEL_REQUEST_TIMEOUT_MS=300000`。缺少任一必需项启动即报错，不静默回退旧模型。

### 3. 初始化你的第一本小说

    > novel_workspace_manager --action init --name "心魔界" --genre "都市异能"

### 4. 生成章节

    > novel_preflight_workspace --workspaceId xinmo --chapterNumber 12
    > novel_generate_chapter --workspaceId xinmo --chapterId 12 --chapterNumber 12

### 5. 商用平台（可选）

    cd platform
    pnpm install
    pnpm dev:db        # 开发用 postgres
    pnpm dev:api
    pnpm dev:web

## 模型路由

模型与端点由仓库根 `.env` 唯一决定（真相源 `config/model-routing.json`），运行中修改不影响当前任务：

| 路由 | 职责 |
|------|------|
| `v2_rawstage2_gemini31` / `v2_amplified_gemini31` | 默认生产写模型，单渠道有界重试，耗尽即阻断，无跨模型 fallback |
| `v2_rawstage2` / `v2_amplified` | 仅显式 `writerModel=claude`（Claude Opus 4.6）时启用 |
| `gpt-5.6-sol` | 文学裁判，仅隔离评测/回放，生产调用数为 0 |
| `gpt-5.5` | 结构化节点（类型路由 / 依赖检查 / Anti-AI 检测） |
| `style_shaper` / `character_agent` 等 | Claude Opus 4.6 |

## 验证与测试

    npm run build          # 编译 prod + eval + test 三目标
    npm test               # 单元测试
    npm run test:eval      # 评测测试
    npm run test:all       # 两者串行

其它校验入口：

    npm run verify:prompt-registry   # prompt registry 漂移检查
    npm run replay:generation-matrix # 生产回放矩阵（确定性 harness）
    npm run simplicity-gate          # 复杂度门

## 质量保障：发布治理

PiNovelStudio 不是「写完就发」的玩具项目——每次生成内核变更都要过五关：

- **发布状态机**：`draft → candidate → frozen → evaluated → approved_dev → active_dev → candidate_prod → active_prod`，未通过门禁不得推进。
- **四臂评测矩阵**：R1 级变更强制 `baseline / candidate / raw_direct / recovery` 四臂对比，candidate 需样本 ≥3 且 pass³ = 1。
- **eval-gate 证据门禁**：确定性 grader 覆盖 13 项检查（manifest schema、trace 留存、fixture hash、状态不变量、原子保存、模型调用证据等）。
- **三 tsconfig 构建隔离**：`dist/`（生产）+ `dist-eval/`（评测）+ `dist-test/`（测试），生产入口零 legacy 分支。

## 设计原则与边界

- **AI 不直接撰写章节正文**：所有正文必须经统一编排产出，10 个专家 Agent（导演、情节架构、世界观、角色、连续性、伏笔、风格等）只提供契约交接，不碰正文。
- **文学裁决权归用户**：机器 judge 不进生产；你的修改稿与反馈才是后续学习信号。
- **外部语料 RAG 已停止推进**：长程记忆召回与 RAG 无关，生产永不注入外部小说原文。

## 文档

- [统一主链路开发计划](./docs/top-tier-chinese-novel-system-development-plan.md) — 架构真相源
- [项目记忆](./docs/project-memory.md) — 当前代码基线与保护边界
- [生产发布治理运行手册](./docs/production-release-governance-runbook-20261102.md)
- [生产架构](./docs/production-architecture.md) / [生产运行手册](./docs/production-runbook.md)
- [AGENTS.md](./AGENTS.md) — PI 项目指令文件（架构决策、硬约束、审计入口）

## License

MIT — 欢迎 Star ⭐ / Fork / 提 Issue，一起把 AI 长篇写作推向生产级。

<div align="center">

**开源地址：[https://github.com/lidonganyp/PiNovelStudio](https://github.com/lidonganyp/PiNovelStudio)**

</div>
