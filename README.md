# PiNovelStudio

> 顶尖网文级中文长篇小说章节生成系统 + 商用平台
>
> **版本**: v2.1 | **更新日期**: 2026-11-03

## 项目概述

PiNovelStudio 由两部分组成：

1. **生成内核**：以 PI (AI Coding Agent) 为编排大脑的 PI 扩展（`.pi/extensions/novel-studio/`），唯一生产路径是 `novel_generate_chapter` → 统一主链路。
2. **商用平台**：`platform/` 下的用户门户（Vue）+ 计费引擎（NestJS + Prisma/PostgreSQL）+ `novel-runtime` 编排服务，通过 docker compose 组网。

原始 `corpus/` 已从仓库删除，生产章节生成不依赖仓库内原始语料。

## 核心特性

- **单一生成主链路**：`novel_generate_chapter` 是章节生成唯一公开入口；不存在 `legacy | quality_amplifier_v2` 双模式，也没有章节白名单。
- **NovelOS Agentic 是正式初稿阶段**：生产章节不调用 one-shot raw，不启用 shadow 旁路。
- **作者风格整章优化是必经阶段**：读取 workspace 风格档案中的定性指导，不把历史统计转成机械配额；初稿不得直接交付。
- **用户文学裁决**：生产不调用 opportunity judge / pairwise judge / SelectionPolicy；机器 judge 仅保留隔离评测与回放。
- **四类长期叙事状态**：CanonState / CharacterState / PromiseLedger / PatternMemory，只在最终正文确认后提交。
- **事实硬门 + 文学软诊断**：空文、截断、事实/实体/时间线/世界观硬冲突可阻断；风格、AI 腔、对白比例、节拍只作诊断证据。
- **三 tsconfig 构建隔离**：`dist/`（生产闭包）+ `dist-eval/`（NovelBench 评测）+ `dist-test/`（测试专用），生产入口零 legacy 分支。
- **发布治理**：release 状态机 + 四臂评测矩阵 + eval-gate 证据门禁，未通过门禁不得进入 `active_prod`。
- **长程记忆召回**：`retrieveNarrativeContext` 评分工作集 + 必需伏笔强制通道 + 前章尾部摘要 + 连续性快照。

## 技术架构

### 统一主链路

```
novel_generate_chapter
└── v2/core/unified-entry.ts: runUnifiedPipeline
    └── v2/core/unified-orchestrator.ts
        Preflight → ContextCompiler → ChapterIntent
        → NovelOS Agentic（初稿，ReAct + 叙事检索工具）
        → Agentic FactGuard
        → 作者风格整章优化
        → StoryPreservation → FinalFactRecheck → Completeness
        → FinalStateCommit → AtomicSave + Trace
```

任何阶段失败都产出结构化阻断（`FailureEnvelope`），不静默交付未优化初稿；不得回退到 legacy Stage0-8（该编排已随 `LEGACY-RUNTIME-REMOVAL-1` 物理删除）。

### 6 个公开工具

| 工具 | 职责 |
|------|------|
| `novel_generate_chapter` | 章节生成唯一公开入口 |
| `novel_preflight_workspace` | 生成前预检（配置/角色/种子/模型超时/字数预算） |
| `novel_workspace_manager` | 工作空间管理（含专家 `list_experts` / `dispatch_expert` / `handoff_chapter_contract`） |
| `novel_plan_story_outline` | 故事大纲规划 |
| `novel_strategy_policy_view` | 编辑策略信誉视图 |
| `novel_strategy_feedback` | 编辑策略反馈回灌 |

### 模型路由（真相源 `config/model-routing.json` v4.36.0）

生产写模型与端点由仓库根 `.env` 唯一决定，运行中修改不影响当前任务（`WRITER-ENV-RUN-FREEZE-1`）：

```env
GEMINI_MODEL=gemini-4-argon
GOOGLE_GEMINI_BASE_URL=https://aimagichub.xyz/v1
GEMINI_API_KEY=your-key
```

- `v2_rawstage2_gemini31` / `v2_amplified_gemini31`：默认生产写模型路由，`gemini31` 只是稳定路由标识，不绑定具体模型版本；单渠道，失败仅同渠道有界重试，耗尽即阻断，无跨模型 fallback。
- `v2_rawstage2` / `v2_amplified`：仅显式 `writerModel=claude`（Claude Opus 4.6）时使用，不作为默认模型备援。
- `gpt-5.6-sol`：文学裁判，仅隔离评测/回放，生产调用数为 0。
- `gpt-5.5`：结构化节点（类型路由 / 依赖检查 / Anti-AI 检测等）。
- `style_shaper` / `stage5_style_shaper` / `stage8_final_gate` / `character_agent`：Claude Opus 4.6。
- Doubao Seed 2.1 Pro：仅隔离评测/历史局部校准，不进生产。
- GLM 5.2：仅显式开发验证 / NovelBench lab route，生产默认与 fallback 禁用。
- Qwen / ERNIE：disabled。

缺 `GEMINI_MODEL` 或 `GOOGLE_GEMINI_BASE_URL` 时启动即报错，不静默回退旧模型。

### 商用平台（`platform/`）

| 组件 | 说明 |
|------|------|
| `apps/api` | NestJS API：用户门户、计费引擎、任务编排、数据库迁移与 bootstrap |
| `apps/web` | Vue 前端门户 |
| `services/novel-runtime` | 生成运行时容器（不映射宿主端口，仅 compose 内网可达） |
| `docker-compose.yml` | postgres + api-migrate + api-bootstrap + api + novel-runtime |

统一 writer 三变量必须与扩展链路同源；platform 容器不从镜像读取 `.env`，缺失任一变量时启动 fail-closed。

## 项目结构

```
PiNovelStudio/
├── .pi/
│   ├── extensions/novel-studio/     # 生成内核（npm workspace）
│   │   ├── index.ts                 # 生产入口（6 公开工具 + 统一主链路）
│   │   ├── v2/core/                 # 统一主链路编排、门禁、上下文、发布治理
│   │   ├── v2/governance/           # 发布状态机、eval-gate
│   │   ├── novelos/                 # Agentic runtime / 叙事工具 / trajectory
│   │   ├── craft/                   # 质量资产（中文自然度、连续性、状态、伏笔等）
│   │   ├── tools/                   # 工具注册与输入契约校验
│   │   ├── api/                     # provider 封装（超时、重试、故障归因）
│   │   ├── tests/                   # 单元测试（tests/）
│   │   ├── tests-eval/              # 评测测试（tests-eval/）
│   │   └── tsconfig.{prod,eval,test}.json
│   └── agents/                      # 10 个专家定义（剧本角色，不直接写正文）
├── platform/                        # 商用平台（pnpm workspace：api + web + novel-runtime）
├── config/                          # model-routing.json（路由唯一真相源）
├── data/                            # 蒸馏后的运行时规则 / Few-Shot / 对比知识
├── docs/                            # 架构、治理、运行手册与基线文档
├── scripts/                         # 数据处理（Python）+ replay / 发布治理（Node）
├── reports/                         # 本地评测与 replay 产物（多数不纳入版本控制）
└── workspaces/                      # 小说创作空间（不纳入版本控制）
```

## 快速开始

### 1. 安装与构建

```bash
npm install
npm run build          # 三目标：dist/ + dist-eval/ + dist-test/
```

### 2. 配置

```bash
cp .env.example .env   # 填入 GEMINI_* / GPT_* / CLAUDE_* 密钥
```

必需项为 `GEMINI_MODEL` / `GOOGLE_GEMINI_BASE_URL` / `GEMINI_API_KEY`；可选 `PINOVEL_MODEL_REQUEST_TIMEOUT_MS=300000`。

### 3. 初始化小说

```bash
> novel_workspace_manager --action init --name "心魔界" --genre "都市异能"
```

### 4. 生成章节

```bash
> novel_preflight_workspace --workspaceId xinmo --chapterNumber 12
> novel_generate_chapter --workspaceId xinmo --chapterId 12 --chapterNumber 12
```

### 5. 商用平台（可选）

```bash
cd platform
pnpm install
pnpm dev:db        # 开发用 postgres
pnpm dev:api
pnpm dev:web
```

## 验证与测试

```bash
npm run build          # 编译 prod + eval + test 三目标
npm test               # 单元测试（tests/）
npm run test:eval      # 评测测试（tests-eval/）
npm run test:all       # 两者串行
```

其它校验入口：

```bash
npm run verify:prompt-registry   # prompt registry 漂移检查
npm run replay:generation-matrix # 生产回放矩阵（确定性 harness）
npm run simplicity-gate          # 复杂度门
```

## 发布治理

- **状态机**：`draft → candidate → frozen → evaluated → approved_dev → active_dev → candidate_prod → active_prod`；`held` 为软终态。
- **变更级别**：R1 级变更强制四臂矩阵（`baseline` / `candidate` / `raw_direct` / `recovery`），candidate 需样本 ≥3 且 `pass^3 = 1`。
- **eval-gate**：`evalRunRoot` 必须同时含 `manifest.json` 与 `matrix-report.json`；R0-R3 一律要求矩阵报告，并重算 verdict 与 `pass^3`。
- **确定性 grader**：13 项检查覆盖 manifest schema、trace 留存、fixture hash 一致性、release bundle 绑定、隔离约束、状态不变量、原子保存、FailureEnvelope 完整性、silent degrade、恢复边界、模型调用证据、真实模型绑定、trace 身份绑定。
- **生产指针**：`active-development.json` 与 `active-production.json` 独立；未通过门禁不得推进 `active_prod`。

详细操作见 [生产发布治理运行手册](./docs/production-release-governance-runbook-20261102.md)。

## 专家团（`.pi/agents/`）

10 个专家（导演、情节架构、世界观、角色、连续性、伏笔、风格、读者代理、质量门、章节意图）以剧本角色形式定义，通过 `novel_workspace_manager` 的 `list_experts` / `dispatch_expert` / `handoff_chapter_contract` 手动调用：

- 专家不得撰写章节正文，不得直接写长期状态，不得调用文学裁判。
- 专家输出必须以「主链路契约交接」形式回灌，最终正文仍由 `novel_generate_chapter` 产出。
- 当前**未接入 PI 自动调度**；自动派发属于后续规划，不作为已实现能力对外宣称。

## 明确的边界

- **外部语料 RAG 增强小说：已停止推进**。代码保留现状，唯一合法形态是 P4 `style_advisory` Craft Pattern Card（Top-K=1、`canAffectHardGate=false`、生产永不注入外部小说原文含 ≤120 字 span）。长程记忆召回与 RAG 无关，继续保留。
- **AI 不得直接撰写章节正文**：所有正文必须经统一编排产出。
- **文学评价权归用户**：机器 judge 不进入生产，用户修改稿与反馈是后续学习信号。
- **不引入框架性依赖**：现有 `typebox` + `FailureEnvelope` + trace 已覆盖核心价值，新增依赖需与三构建隔离、离线可回放目标一致。

## 文档

- [统一主链路开发计划](./docs/top-tier-chinese-novel-system-development-plan.md) — 架构真相源
- [项目记忆](./docs/project-memory.md) — 当前代码基线、清理状态、保护边界与已知阻断
- [生产发布治理运行手册](./docs/production-release-governance-runbook-20261102.md)
- [生产架构](./docs/production-architecture.md) / [生产运行手册](./docs/production-runbook.md)
- [文档索引](./docs/documentation-index.md)
- [AGENTS.md](./AGENTS.md) — PI 项目指令文件（架构决策、硬约束、审计入口）
- [CLAUDE.md](./CLAUDE.md) — Claude Code 工作指南

## License

MIT
