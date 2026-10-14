# PiNovelStudio

> 顶尖网文级小说章节生成系统
>
> **版本**: v2.0 | **更新日期**: 2026-07-20

## 项目概述

PiNovelStudio 是一个基于 PI (AI Coding Agent) 的**中文长篇小说章节生成系统**。它以 PI 为编排大脑，以 `NovelOS Agentic → 作者风格整章优化 → 事实复检 → 状态提交/原子保存` 为生产内核。原始 `corpus/` 已从仓库删除；生产章节生成不依赖原始语料。

## 核心特性

- **统一主链路生成内核**: `novel_generate_chapter` 唯一公开入口；NovelOS Agentic 检索/验证初稿 → 作者风格整章优化 → StoryPreservation/FactGuard/Completeness → 原子保存
- **6 个公开工具**: `novel_generate_chapter` / `novel_preflight_workspace` / `novel_workspace_manager` / `novel_plan_story_outline` / `novel_strategy_policy_view` / `novel_strategy_feedback`
- **作者风格正式消费**: 每章强制读取 workspace 风格档案中的定性指导做整章优化，历史统计不转成机械配额
- **用户文学裁决**: 生产不调用 opportunity/pairwise/reverse judge；最终正文由用户评价，修改稿作为后续学习信号
- **四类长期叙事状态**: CanonState / CharacterState / PromiseLedger / PatternMemory；状态只在最终正文选定后提交
- **三 tsconfig 构建隔离**: `dist/`（生产入口）+ `dist-eval/`（NovelBench 评测）+ `dist-test/`（测试专用模块）；生产闭包零 legacy 依赖
- **模型请求超时保护**: 所有模型 API 请求使用 bounded timeout，默认 300000ms，可通过 `PINOVEL_MODEL_REQUEST_TIMEOUT_MS` 覆盖
- **多小说 Workspace**: 一套引擎，多本小说复用

## 技术架构

```
PI Agent（编排大脑）
└── 统一主链路（v2/core/unified-orchestrator.ts）:
    Preflight → ContextCompiler → ChapterIntent → NovelOS Agentic
    → Agentic FactGuard → 作者风格整章优化 → StoryPreservation
    → FinalFactRecheck → Completeness → FinalStateCommit → AtomicSave + Trace

AI 路由策略（真相源: config/model-routing.json v4.35.0）:
├── Gemini 3.8 Flash: 默认 NovelOS Agentic + 作者风格整章优化；fallback=[]
├── Claude Opus 4.6: 显式 `writerModel=claude` 正文备选，并继续负责风格塑形、终审与角色节点；不作为静默 fallback
├── 同模型 bounded best-of-3: 显式 `boundedBestOf3=true` 时由当前主写生成 raw + 最多 2 个场景解法候选；Gemini 4 次尝试中 2 次受控且均由 raw 胜出，默认关闭
├── gpt-5.6-sol: 仅隔离评测/回放使用，生产调用数为 0
├── GPT 5.5: 结构化节点（类型路由/依赖检查/Anti-AI 检测等）
├── Doubao Seed 2.1 Pro: 受限 span 驱动中文校准候选（1C COMPLETE_L0）
├── GLM 5.2: 显式开发验证 / NovelBench lab route，生产默认禁用
└── Qwen / ERNIE: 当前 disabled providers
```

## 项目结构

```
PiNovelStudio/
├── .pi/                          # PI 扩展和技能
│   ├── extensions/novel-studio/  # 扩展代码（npm workspace）
│   │   ├── index.ts              # 生产入口（~85 行，6 公开工具 + 统一主链路）
│   │   ├── v2/core/              # 统一主链路编排（unified-orchestrator 等）
│   │   ├── v2/adapters/          # legacy 资产适配器（LanguageRisk / FactContinuity / State）
│   │   ├── v2/learning/          # Phase 6 在线学习（contextual bandit）
│   │   ├── craft/                # 技法引擎模块（迁移后保留的正收益资产）
│   │   ├── dag/                  # DAG 类型与验证
│   │   ├── tools/                # 工具注册（register-tools.ts 等）
│   │   ├── handlers/             # 公开工具 handler
│   │   ├── tests/                # 测试套件（统一主链路 + legacy 回归 + 边界）
│   │   └── tsconfig.{prod,eval,test}.json  # 三 tsconfig 隔离
│   └── skills/                   # PI 技能/历史工作流文档
├── workspaces/                    # 小说创作空间（不纳入版本控制）
├── data/                         # 蒸馏后的运行时规则 + Few-Shot + 对比知识
├── scripts/                      # 外部语料数据处理脚本（Python）+ eval/replay 工具（Node）
└── config/                       # 配置文件（model-routing.json 为路由真相源）
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 API 密钥

复制 `.env.example` 为 `.env`，填入 API 密钥：

```bash
cp .env.example .env
```

```env
CLAUDE_API_KEY=your-claude-api-key
GPT_API_KEY=your-gpt-api-key
ARK_API_KEY=your-doubao-api-key
PINOVEL_MODEL_REQUEST_TIMEOUT_MS=300000
```

### 3. 初始化新小说

```bash
# 在 PI Agent 中执行（novel_workspace_manager 是工作空间管理公开工具）
> novel_workspace_manager --action init --name "心魔界" --genre "都市异能"
```

### 4. 开始创作

```bash
# 生成第12章（novel_generate_chapter 是章节生成唯一公开入口）
> novel_generate_chapter --workspaceId xinmo --chapterId 12 --chapterNumber 12
```

## 开发路线图

当前跨会话状态、已完成清理、授权边界和已知阻断见 [项目记忆](./docs/project-memory.md)。默认主写为 Gemini 3.8 Flash，使用 `gemini_writer_v2`；Claude 4.6 为显式备选。生产必经 Agentic 初稿与作者风格整章优化，文学评价权归用户，机器文学 judge 仅用于隔离评测。

### Phase 1: 基础架构 ✅

- [x] DAG 类型系统
- [x] 基础 Agent 架构（Architect/WorldBuilder/DramaCoach 等已随统一主链路迁移退役，正收益资产已迁移到 `v2/core/`）
- [x] Workspace Manager
- [x] 配置系统

### Phase 2: 生成与审查 ✅

- [x] Narrator Agent（已退役为 thin shim，Stage 2 helpers 抽离到 `craft/narrator-stage2-helpers.ts`）
- [x] Critic Agent（已退役，四门判定改为本地 quad-gates）
- [x] DependencyChecker（已退役，依赖检查迁移到统一主链路 FactGuard）
- [x] CharacterAgent（已退役，角色状态由 `v2/core/final-state-commit.ts` CharacterState committer 管理）

### Phase 3: 质量壁垒 ✅

- [x] BrainholeInjector
- [x] StyleShaper
- [x] EmotionMetronome
- [x] AntiAIDetector

### Phase 4: 数据管线 ✅

- [x] 文本预处理脚本
- [x] 风格提取
- [x] 场景分类
- [x] 技法挖掘
- [x] Few-Shot 库构建（已接入检索链路，覆盖度随场景类型继续补齐）
- [x] 对比蒸馏（Critic 基准已接入，更多场景映射继续补齐）

### Phase 5: 端到端验证 [已完成]

- [x] 完整章节生成测试
- [x] 质量对比验证
- [x] 多本小说切换测试

### Phase 6-14: 质量工艺系统 [已完成]

- [x] 世界观展示系统 (WorldPresenter)
- [x] 群像戏编排系统 (EnsembleDirector + 6个子模块)
- [x] 收尾工艺系统 (ClosureTracker + 6个子模块)
- [x] 连栽预期管理系统 (ReaderExpectationManager)
- [x] 配角系统 (CharacterContextBuilder + CharacterLifecycleManager)
- [x] 中盘管理 (MidChapterChecker + NarrativeDebt + ThreeClocks)

### Phase 14: 类型感知系统 [已完成]

- [x] TypeRouter — 类型识别与路由 (113规则)
- [x] TypeProfileManager — 类型档案管理
- [x] TypeDriftDetector — 类型漂移检测
- [x] 4种预设类型 (爽文/悬疑/恋爱/玄幻)
- [x] 16个 Agent 类型化参数矩阵
- [x] Phase 1-14 完成；617 条规则运行链路约 93% 覆盖

### 统一主链路迁移 [已完成]

- [x] legacy Stage0-8 编排入口物理删除（`LEGACY-RUNTIME-REMOVAL-1`）
- [x] 统一主链路（NovelOS Agentic → 作者风格整章优化 → 事实复检 → 保存）成为唯一公开生成路径
- [x] 三 tsconfig 构建隔离（dist/ + dist-eval/ + dist-test/）
- [x] 6 公开工具收敛；~40 诊断工具由环境变量门控
- [x] legacy 正收益资产迁移到统一主链路（中文自然度/连续性/状态管理/伏笔追踪等）
- [x] `novel_architect` / `novel_critic` 等内部阶段 Agent 退役（正收益资产已迁移）

## 使用指南

### 章节生成入口

章节生成唯一公开入口是 `novel_generate_chapter`，走统一主链路编排。AI 不得直接撰写章节正文；所有正文必须经统一编排产出。

### 统一主链路生成流程

```
Preflight: 本地预检（config/角色档案/ChapterSeed 可生长性，不调用 LLM）
→ ContextCompiler: 编译事实/角色状态/开放线索/世界规则/风格参考
→ ChapterIntentBuilder: 构建本章意图（chapterFunction / readerExperience / currentPressure）
→ Raw candidate: 生成 raw 基线正文
→ FactGuard: 事实守护（候选前置检查）
→ EditorialOpportunity: 机会驱动检测（仅当存在可引用 span 证明的编辑机会）
→ EditorialCandidate (0-2): 生成 0-2 个 editorial candidate
→ PairwiseJudge: 匿名 A/B 裁判（span 约束、可反向复判）
→ SelectionPolicy: 选定最终正文（无明确胜出时交付 raw）
→ SpanRepair: 局部 span 修复
→ FinalFactRecheck: 最终事实复检
→ FinalStateCommit: 最终正文选定后提交四类长期叙事状态
→ AtomicSave + Trace: 原子保存 + quality-trace 落盘
```

> legacy Stage0-8 流程已退役（`LEGACY-RUNTIME-REMOVAL-1`）。正收益资产（中文自然度、连续性、状态管理、伏笔追踪等）已迁移到统一主链路。

### 核心概念

- **raw 基线**: 模型原生生成文本，是内部基线与安全回退；编辑层失败或候选无明确胜出时交付 raw
- **editorial candidate**: 机会驱动的编辑候选，必须有可引用正文 span 证明的编辑机会才生成
- **PairwiseJudge**: LLM 匿名 A/B 裁判，提供逐维证据；未通过自然人对齐前不得决定生产文学胜负
- **四类长期叙事状态**: CanonState（正典）/ CharacterState（角色）/ PromiseLedger（承诺账本）/ PatternMemory（模式记忆）
- **ChapterSeed + 作者章节契约**: 写前提供整体方向、章节功能、前文状态、人物动机、伏笔、因果、硬事实与章末目标；不指定正文表达方式

## 文档

- [统一主链路开发计划](./docs/top-tier-chinese-novel-system-development-plan.md) — 架构真相源（v1.1），统一主链路设计与迁移基线
- [项目记忆](./docs/project-memory.md) — 当前代码基线、清理状态、保护边界与已知阻断
- [当前派工计划](./docs/remaining-development-dispatch-plan-20260715.md) — 剩余开发派工与授权队列
- [AGENTS.md](./AGENTS.md) — PI 项目指令文件（含 legacy 迁移参考）
- [CLAUDE.md](./CLAUDE.md) — Claude Code 工作指南（当前架构与硬约束）

## 致谢

本项目参考了以下研究和资源：

## License

MIT
