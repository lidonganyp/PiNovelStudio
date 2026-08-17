# PiNovelStudio — PI 项目指令文件

## 版本收敛原则（最高优先级，2026-08-11）

> 本原则为项目全局约束，与目标架构、发布治理同样为最高优先级；只要明确有正收益，后续一律按此执行。

1. **所有基线只保留一套版本**：能力、数据、配置、发布基线一律收敛为单一最新版本；不维护多套并行版本。
2. **哪个版本更新，就只保留哪个**：当新版本产生正收益并进入生产后，直接替换旧逻辑并物理删除旧版本，不保留回退/并行副本。
3. **不保守存储**：系统不需要多套并行与环境切换；生产更新即是替换，旧版本删除。
4. **示例**：rel-prod-104（声明 telemetry-only 但实际携带 memory 的版本）与误建的 rel-prod-105（telemetry-only @ 5bc0eb9）均非最新生产版本；memory（`v2/core/memory`，HEAD `eeb0ed3`）是最新版本，被确认为唯一生产版本，其余并行基线废弃删除。

## 目标架构：统一主链路（最高优先级，2026-07-10）

PiNovelStudio 的目标架构收敛为**单一生成主链路**。真相源为 [docs/top-tier-chinese-novel-system-development-plan.md](docs/top-tier-chinese-novel-system-development-plan.md)（v1.2，2026-07-21）。本节为项目最高优先级；下文任何旧规则与本节或新计划冲突时，以本节和新计划为准。

### 架构决策（取代旧双模式设计）

1. **单一生成主链路**：系统最终只保留 `novel_generate_chapter` 一个公开入口与一套运行时编排。不再存在 `legacy | quality_amplifier_v2` 两种生成模式，不再保留章节白名单。
2. **NovelOS Agentic 是正式生产初稿阶段**：生产章节不调用 one-shot raw，不启用 shadow 旁路；Agentic 初稿必须进入作者风格整章优化。
3. **作者风格整章优化是正式必经阶段**：读取 workspace 风格档案中的定性指导，禁止把历史统计转成机械配额；优化稿经事实、故事保持和完整性复检后保存。
4. **文学评价权归用户**：生产不调用 opportunity judge、pairwise judge 或 SelectionPolicy；系统只做事实安全与事务保存，用户通过最终正文和后续修改反馈评价文学质量。
5. **作品级 CreativeConstitution + 四类长期叙事状态**：CanonState / CharacterState / PromiseLedger / PatternMemory；状态只在最终正文选定后提交。
6. **按模型版本隔离策略信誉**：contextual bandit 在线调整编辑策略；旧模型经验不限制新模型能力。

### 取代的旧约束（不再生效）

- ❌ "阶段0→阶段8必须按顺序执行，严禁跳过" —— legacy Stage0-8 编排已物理删除（`LEGACY-RUNTIME-REMOVAL-1`）；正收益资产已迁移到统一主链路 `v2/core/`。
- ❌ `legacy | quality_amplifier_v2` 双模式与章节白名单、`generationMode` 配置。
- ❌ 机械 comparator 11 维等权总分决定 winner / `clearWinThreshold` 一类总分差门槛。
- ❌ "V2 在通过重跑验收前不得取代 legacy 作为默认生产链路" —— 该历史约束被本架构决策反转：不再维护双链路，统一主链路取代二者；不再以 V2 重跑验收为前置条件。

### Phase 7 状态（迁移已完成）

- `PINOVEL_UNIFIED_PIPELINE=1`：**生产回滚用途已退役**。Phase 7 已删除旧 v2-orchestrator（含 `V2_WHITELIST`/`isWhitelisted`/`v2NotImplemented`/`degradedTo:"legacy"`）与 `generationMode` 双模式 config，统一主链路是唯一公开生成路径，生产路径无回退到 Stage0-8 的分支。
- 该开关仅保留为**测试基础设施**：legacy 测试套件（`tests/setup-test-env.mjs`）设置 `PINOVEL_UNIFIED_PIPELINE=1` 以覆盖已迁移的 A 类资产行为（trace、原子保存、门禁、NarrativeState 等），不代表产品模式。
- **legacy 已物理删除（2026-07-11）**：生产入口 `index.ts` 收敛为 ~85 行（6 公开工具 + 统一主链路，零 legacy 依赖）。三 tsconfig 隔离：`tsconfig.prod.json` → `dist/`（生产入口传递依赖闭包），`tsconfig.eval.json` → `dist-eval/`（NovelBench 评测模块），`tsconfig.test.json` → `dist-test/`（测试专用 craft/agents/v2 模块）。legacy Stage0-8 编排入口、`legacy-index.ts`、`lab/`、`tsconfig.lab.json`、`dist-lab/` 均已物理删除（`LEGACY-RUNTIME-REMOVAL-1`）。生产 `dist/index.js` 不含任何 legacy 分支（`tests/dependency-boundary.test.mjs` 自动守护此约束，含 13 项断言验证 lab-only 产物不出现在 `dist/`）。

### 下文旧内容的地位

下文 P44 Quality Amplifier v2、老版核心架构、P13 知识检索等章节，**保留为 legacy 行为说明与历史决策参考**；其中与单主链路目标冲突的强制条款（如"阶段0-8 必须执行""双模式"）不再生效。legacy 正收益资产（中文自然度、连续性、状态管理、伏笔追踪、模型路由/熔断/trace/原子保存等）已迁移到统一主链路 `v2/core/` 对应模块。

> 仍生效的铁律：`novel_generate_chapter` 是章节生成唯一公开入口；AI 不得直接撰写章节正文；正文必须经统一编排产出。这三条在单主链路目标下继续有效。

### 当前项目记忆（2026-07-20）

- 跨会话快照见 [docs/project-memory.md](docs/project-memory.md)。它记录当前代码基线、已完成清理、脏工作树保护、模型路由状态与授权边界。
- 当前路由基线为 `config/model-routing.json` v4.31.0：Gemini 3.1 Pro Preview 负责 NovelOS Agentic 生成与作者风格整章优化；普通 one-shot raw 仅保留为隔离评测资产。生产不调用 GPT 文学裁判，用户反馈是唯一文学评价来源。
- 7.75GB `corpus/` 已从仓库删除，生产路径对原始语料零依赖。离线数据重建必须显式使用外部语料，不得继续把“仓库内置 100+ 部全文”写成当前事实。
- `cd15cd2` 删除 4 个 craft 文件后 `030420f`（P0 阻断项修复）已恢复并纳入版本控制，`npm run build` / `build:prod` 通过，clean checkout 完整。
- 当前工作树包含用户正在进行的代理审批代码、staged 测试修改、未跟踪 RED 测试与模型验证输出；未经明确指示不得恢复、删除、暂存或覆盖。现有 stash 也不得擅自 `pop/drop`。

---

## P44 Quality Amplifier v2（legacy，2026-07-08，已被统一主链路目标取代）

PiNovelStudio 的唯一存在理由是：在同等模型、同等上下文下，系统输出必须稳定优于裸模型输出。项目约束必须放大强模型能力，而不是用小学生式强控把模型能力磨平。

从 P44 起，`quality_amplifier_v2` 曾作为目标生成内核设计。legacy Stage0-8 编排已物理删除，正收益资产已迁移到统一主链路；本节保留为历史决策参考。所有新增质量能力必须遵循以下原则：

1. **少约束生成，多约束选择**：提示词只给清晰目标、可靠资料与关键边界，不用机械指标控制模型句子、段落、对白比例。
2. **少强迫改文，多比较胜负**：任何 StyleShaper、patch、event rewrite、chapter rewrite 都必须产出 candidate，并与 raw/current/direct baseline A/B 比较；没有明确胜出不得覆盖正文。
3. **少管句子，多管目标**：项目规则服务读者体验、情节推进、人物状态、群像层次、信息释放、期待兑现和中文自然度，不服务单一指标本身。
4. **裸写是基线，不是废料**：Stage 2/raw candidate 必须保存为 baseline。后续链路若负收益，系统必须能保留 rawStage2 或 direct baseline。
5. **小说判断是核心资产，不是硬控清单**：项目文档中的群像、情节把控、细节判断、期待兑现、伏笔、信息释放、情绪节拍等经验必须进入 `CraftJudgmentLibrary`，用于 scene contract、diagnostic 和 candidate comparator；未经 replay 证明正收益，不得直接成为生产强制规则。
6. **gate 降权为诊断提供者**：除乱码/空文/格式损坏、大段重复污染、明确实体幻觉、严重连续性断裂、世界观硬冲突、缺关键输入等事实性硬伤外，对话比例、段落节奏、风格偏移、AI 腔、翻译腔、群像层次不足、钩子弱等只能作为 diagnostic 或 repair suggestion，不能直接触发整章重写。
7. **默认最小修复**：修订优先级为 `no_op` → `sentence_patch` → `paragraph_patch` → `bridge_patch` → `event_patch` → `event_rewrite`。`chapter_rewrite` 仅允许灾难级失败使用。
8. **项目必须证明正收益**：每次 v2 验收必须比较 direct baseline、rawStage2、legacy full-chain、v2 amplified。不能只以 build/test 通过宣称小说质量提升。

v2 目标模块与任务清单原见 `docs/quality-amplifier-v2-design.md`（该历史设计文档已在 HISTORY-RETIREMENT-1 中删除）。本节为 legacy 行为说明与迁移参考；与上文"目标架构：统一主链路"或新计划冲突时，**以上文统一主链路目标与新计划为准**。当前架构真相源为 [docs/top-tier-chinese-novel-system-development-plan.md](docs/top-tier-chinese-novel-system-development-plan.md)（v1.2）。

**版本**: v1.3 | **更新日期**: 2026-06-10

## 项目定位

PiNovelStudio 是基于 PI (AI Coding Agent) 的顶尖网文级小说章节生成系统。所有代码修改必须遵循以下指令。

## 老版核心架构

- **Writer's Room 多智能体（legacy 描述）**: 生产默认公开 6 个 `novel_*` 工具（`novel_generate_chapter` / `novel_preflight_workspace` / `novel_workspace_manager` / `novel_plan_story_outline` / `novel_strategy_policy_view` / `novel_strategy_feedback`）；章节生成唯一公开入口为 `novel_generate_chapter`，`novel_narrator` / `novel_critic` 为 legacy 内部阶段 Agent（已退役，正收益资产迁移到统一主链路）。
- **感知锚点驱动（legacy）**: 替代原 DAG 蓝图，四步锚点搜索法；统一主链路改用 ChapterSeed + ContextCompiler。
- **四大质量壁垒（legacy）**: 脑洞注入、风格指纹、情绪节拍、反 AI 腔检测；正收益资产已迁移到统一主链路对应 craft 模块。
- **五层数据壁垒**: 风格指纹库→场景模式库→技法原子库→Few-Shot 黄金示例库→对比蒸馏知识库；当前运行链路已接入风格指纹、Few-Shot 与对比蒸馏，离线场景/技法/风格层继续补齐显式消费链路
- **质量进化闭环（legacy）**: replay benchmark 只提供外部证据，默认生成链路只准入经过样本数/胜率验证的 runtime 规则。统一主链路 trace 已替代原 Stage 2/5/8 质量证据写入。
- **阶段化生成流程（已退役）**: legacy 9 个核心阶段（阶段0-8）+ 条件触发阶段的编排已物理删除。统一主链路编排顺序见上文"生成流程"。

> **阶段数说明（legacy）**：原 legacy 编排为 9 个核心阶段（阶段0-8）+ 1 个每章启用硬门禁（阶段6.5）+ 6 个条件触发阶段（1.5/1.6/4.5/4.6/5.5/8.5）。该编排已随 `LEGACY-RUNTIME-REMOVAL-1` 物理删除；统一主链路编排顺序以新计划 §3 为准。

## P13 知识检索优化（2026-06-02）

### 优化1: 按事件/节拍检索

**问题**: 原来 Narrator 先用整个 DAG 推断一个 `sceneType`，再构造一次知识上下文；多场景章节容易被单一标签主导。

**解决方案**:
- 新增 `buildEventKnowledgeContextBlock(event, dag)` 方法，逐事件构建知识检索上下文
- 新增 `inferEventSceneType(event)` 方法，基于单个事件的 `type/narrativeBeat/conflictLevel/emotionalArc` 推断场景类型
- `RetrieveContext` 新增字段：`eventNarrativeBeat`, `eventConflictLevel`, `eventType`, `eventEmotionArc`
- 评分函数新增：叙事节拍匹配、冲突等级匹配、情绪弧匹配

**文件**: `craft/knowledge-retriever.ts`（`agents/narrator.ts` 已随 legacy 退役删除）

### 优化2: 大纲意图对齐

**问题**: 脑洞优化已接入 `outline.md`，但 Narrator 的检索上下文没有直接使用"大纲意图/本章主题分类"。

**解决方案**:
- 新增 `OutlineIntentGenerator` 模块 (`craft/outline-intent-generator.ts`)
- 从大纲文本提取 `outlineIntent`：primary（主要意图）、secondary（次要意图）、keywords（关键词）、chapterTheme（主题）、targetEmotions（目标情绪）
- 在阶段1后、阶段2前，将 `outlineIntent` 写入 DAG `enhancements`

> **P22 更新**：`outlineIntent` 来源已迁移为 `chapterSeed.intent`，并添加 `_source: "chapterSeed"` 标记。
> 不再从 outline.md 提取意图。短期继续写入 `dag.enhancements.outlineIntent` 以保持下游兼容，但来源标记避免误判为写前章纲。
- Narrator 的 `buildOutlineIntentGuidanceBlock` 方法注入大纲意图指导块
- KnowledgeRetriever 评分函数新增 `scoreOutlineIntentMatch` 方法

**意图分类**: foreshadow / character / reversal / romance / setting / combat / humor / tension

**文件**: `craft/outline-intent-generator.ts`, `dag/types.ts`, `index.ts`（`agents/narrator.ts` 已随 legacy 退役删除）

### 优化3: 统一 Few-shot 通道

**问题**: Few-shot 至少有三路：Narrator 直接取 Top3、`KnowledgeContextBuilder` 也取 Few-shot、运行时检索还可能取 Few-shot。好例子太多反而互相打架。

**解决方案**:
- 新增 `FewshotSelector` 统一管理类 (`craft/fewshot-selector.ts`)
- 检索优先级：运行时索引 > flat JSON
- 支持大纲意图匹配、叙事节拍匹配、冲突等级匹配
- 设置全局预算：最多 3 个示例，每个最多 520 字符

**文件**: `craft/fewshot-selector.ts`（`agents/narrator.ts` 已随 legacy 退役删除）

## P22 质量进化闭环（legacy，已随 Stage0-8 退役）

> 本节只记录旧 Stage0-8 行为，不是当前生产要求。其中事件级写作契约、StyleShaper、AntiAI 密度硬门、固定修订层级和自动回环均已退出统一主链路；当前只保留事实硬门、诊断证据、逐章候选比较和最终状态事务。

### 运行时目标

本轮实现不是把 AINovelTools / PiNovelStudio 的经验机械拼接进提示词，而是把经验分成三层：

- **候选经验**: AINovelTools 的质量证据、分段过门、作者学习、盲测回归等方法论，以及 `data/` 中从顶尖网文蒸馏出的场景/技法/风格经验。
- **外部证据**: replay benchmark 对 reference/candidate 做可回放对比，聚合候选规则的样本数、胜率和 delta。
- **运行时准入**: 只有达到 `sampleSize >= 3`、`validatedWinRate >= 0.55` 的规则进入 `data/runtime/validated-craft-rules.json` 并默认参与 Stage 2 事件级写作契约。

### 历史状态

- 本节原有 `EventWritingContract`、Stage 2/5/8 门禁、StyleShaper、AntiAI 2% 阈值、SceneContinuityGate 和 PatchQualityComparator 描述均已随 Stage0-8 物理退役，不得恢复为生产规则。
- replay 与历史 runtime rules 只保留为离线证据来源；任何经验必须按模型版本隔离，并经逐章 raw 对照与自然人复核后才可能获得新的生产授权。

### 验收边界

只通过 build/test 不能声称“小说质量已经提升”。必须同时具备真实 reference/candidate replay、规则晋级、下一轮生成 trace 中出现 active validated rule，以及人工抽检或盲测复核，才可以宣称质量闭环产生正收益。

## 代码规范

### TypeScript

- 使用 ES Module（import/export）
- 严格类型：所有函数参数和返回值必须有类型注解
- 类优先：核心逻辑用 class 封装，导出工厂函数 `createXxx()`
- 错误处理：使用 try-catch，不抛出未捕获异常
- 文件头注释：每个文件必须有模块说明注释

### Python（数据处理脚本）

- Python 3.10+ 语法
- 使用 argparse 处理命令行参数
- dataclass 定义数据结构
- 类型注解：所有函数参数和返回值
- UTF-8 编码：读写文件必须指定 encoding="utf-8"
- 中文编码兼容：语料文件需支持 GBK/GB18030 自动检测

### 文件组织

```
.pi/extensions/novel-studio/
├── agents/          # Agent 实现（每个 Agent 一个文件）
├── api/             # 外部 API 封装
├── craft/           # 质量壁垒引擎
│   ├── brainhole-engine.ts          # 脑洞注入引擎
│   ├── fewshot-selector.ts          # P13新增：统一 Few-shot 选择器
│   ├── knowledge-context.ts        # 轻量级知识上下文构建器
│   ├── knowledge-retriever.ts       # 运行时知识检索器
│   ├── outline-intent-generator.ts # P13新增：大纲意图提取器
│   └── ...                         # 其他质量引擎
├── dag/             # DAG 引擎
├── prompts/         # Agent 提示词模板
├── utils/           # 工具函数
└── workspace/       # Workspace 管理

data/                # 数据访问层（TypeScript）
├── runtime/         # 运行时索引（通过 manifest 准入控制）
├── fewshots/        # Few-shot 黄金示例
└── contrastive/     # 对比蒸馏知识库
scripts/             # 数据处理脚本（Python）
styles/profiles/     # 风格指纹 JSON
brainholes/patterns/ # 脑洞模式 Markdown
```

## 关键约束

1. **作者内容契约优先**：写前必须传入整体剧情方向、章节功能、前文状态、人物动机、伏笔与承诺、因果关系、不可违背事实和章末目标。
2. **正文表达归模型**：开头、感官、词汇、句式、修辞、对白、段落节奏和具体场景表达不得由系统机械指定。
3. **事实硬门、文学软诊断**：空文、截断、事实/实体/时间线/世界观硬冲突可阻断；风格、AI 腔、节拍、对白比例和结构扫描只作 diagnostic/candidate evidence。
4. **Agentic 初稿不直接交付**：NovelOS Agentic 初稿必须经过作者风格整章优化；任何阶段失败都结构化阻断，不静默交付 one-shot raw 或未优化初稿。
5. **用户文学裁决**：机器 judge 不进入生产；最终正文由用户评价，用户修改稿与反馈用于后续学习和链路优化。
6. **状态事务**：长期状态只在最终正文经事实复检并由有效权威确认后提交。

## 生成流程

> **当前真相源**：统一主链路为唯一生成路径。`novel_generate_chapter` → `v2/core/unified-entry.ts:runUnifiedPipeline` → `v2/core/unified-orchestrator.ts`，生产编排顺序为 `Preflight → ContextCompiler → ChapterIntent → NovelOS Agentic → Agentic FactGuard → 作者风格整章优化 → StoryPreservation → FinalFactRecheck → Completeness → FinalStateCommit → AtomicSave + Trace`。旧 raw/judge 流程仅保留隔离评测。

> **legacy Stage0-8 已物理删除**（`LEGACY-RUNTIME-REMOVAL-1`）：原阶段0-8 编排入口、`legacy-index.ts`、`lab/`、`tsconfig.lab.json`、`dist-lab/` 均已删除，生产路径无回退到 Stage0-8 的分支。下文不再保留 Stage0-8 流程描述；其正收益资产（中文自然度、连续性、状态管理、伏笔追踪、模型路由/熔断/trace/原子保存等）已迁移到统一主链路对应模块。

## 数据管线

```bash
# 完整管线（原始 corpus 不在仓库；必须提供外部语料路径）
python scripts/run-pipeline.py --all --input D:/external-corpus --skip-check

# 单步执行
python scripts/preprocess.py --input D:/external-corpus --output corpus/clean/
python scripts/extract-style.py --input corpus/clean/ --output data/styles/
python scripts/extract-scenes.py --input corpus/clean/ --output data/scenes/
python scripts/mine-techniques.py --input corpus/clean/ --output data/techniques/
python scripts/build-fewshots.py --scenes data/scenes/ --styles data/styles/ --output data/fewshots/
python scripts/contrastive-distill.py --generate-samples --output data/contrastive/
```

## 测试要求

- TypeScript: 编译无错误
- Python: 脚本可独立运行
- 数据管线: 每步输出 JSON 格式正确

## AI 路由策略

| 任务类型 | 推荐模型 | 原因 |
|---------|---------|------|
| 规划/分析 | PI 默认模型 | 结构化推理 |
| Agentic 初稿 + 作者风格整章优化 | Gemini 3.1 Pro Preview | 未传 `writerModel` 时 NovelOS Agentic 使用 `v2_rawstage2_gemini31`，风格优化使用 `v2_amplified_gemini31`；`fallback=[]`，失败 hard block |
| 显式备选正文模型 | Claude Opus 4.6 | `writerModel=claude` 时使用 `v2_rawstage2` / `v2_amplified` 与 `claude_writer_v1`；`fallback=[]`，不作为 Gemini 的自动备援 |
| 中文校准候选(评测兼容) | Doubao Seed 2.1 Pro | `v2_chinese_calibration` 仅保留给隔离评测/历史局部校准，不进入正式生产主链路 |
| 文学裁判(评测兼容) | gpt-5.6-sol | `v2_opportunity_judge` / `v2_literary_judge` 仅保留隔离评测和回放，不在 `novel_generate_chapter` 生产路径调用 |
| 本地质量扫描 | local diagnostics | 只提供 span、事实、结构与风险证据；不得按风格、AI 腔、对白或段落指标阻断/改写/选 winner |
| 开发验证(GLM) | GLM 5.2 | MODEL-ROUTING-CLAUDE46-1D：GLM 仅作开发验证，只允许显式 `modelTestRoute=glm` / NovelBench lab route；不得进入生产默认或 fallback。`narrator_testing_glm` / `style_shaper_testing_glm` / `chinese_naturalizer_glm` 显式 `fallback=[]` + lab_testing 标注 |

> **路由真相源**：`config/model-routing.json` v4.31.0 为路由唯一真相源，本表与之同步；不一致时以 `model-routing.json` 为准。

## 生产规则

### 世界观强制注入
- 生成章节前，必须从 `workspaces/{id}/config.json` 加载世界观（genre, subGenres, 角色列表）
- 世界观信息由统一 `Preflight → ContextCompiler → ChapterContract` 注入正文模型
- **世界观缺失 = 生产阻断**，必须让用户补全后再生成

### 类型路由策略

- 写前只消费作者在 `config.json` / CreativeConstitution 中明确声明的类型与读者承诺，不用内容推断覆盖作者类型。
- 类型漂移在 raw 通过 FactGuard 后，由 `MethodologyDiagnosticState → CraftPhenomenonReport.genre_contract` 做 span-backed advisory；它不进入 raw prompt、不阻断正文，也不能独立授权候选。
- `orchestrator-raw.ts` 的 `driftGenre` 仍固定为 `null`，表示写前 TypeRouter 未接入；不得把 post-raw 诊断误写成“三源 TypeRouter 已接入”。
- `type-profile.json` 只保留为历史/辅助资产，不是统一主链路的类型真相源。

> **设计理由**：类型档案不属于主文档五层数据壁垒（风格指纹→场景→技法→Few-Shot→对比蒸馏），是增强能力而非强制前置。

### 状态维护与事务边界

章节生成流程的事务边界如下：
1. **原子事务**：章节文件保存是原子操作（临时文件 → rename），失败会回滚
2. **章节保存后执行**：模式疲劳检测、债务净增量检查、角色生命周期更新、伏笔追踪器更新
3. **状态隔离**：章节保存成功后才执行状态维护，避免失败章节污染全局状态

> **注意**：`triggerPostChapterStages` 中的能力（伏笔追踪器等）直接写文件，与章节文件不是同一事务。默认模式下后置能力失败不影响章节文件。如需严格一致性，可在 `config.json` 设置 `strictPostChapter: true`，此时后置能力失败将回滚章节文件。

### 章节生成铁律（最高优先级）

> ⛔ **严禁 AI 直接输出章节正文内容！**
> ⛔ **严禁 AI 自行生成任何章节内容！** 所有正文必须通过 `novel_generate_chapter` 统一编排生成。
> ⚠️ **legacy Stage0-8 已物理删除**：生产编排顺序由统一主链路 `Agentic → 作者风格优化 → 事实复检 → 保存` 决定。生产路径无 Stage0-8、one-shot raw 或机器文学裁判回退分支。

1. **章节生成唯一公开入口**：
   - `novel_generate_chapter` → 统一章节生成编排器，走 `NovelOS Agentic → 作者风格整章优化 → 事实复检 → 状态提交/原子保存` 主链路。
   - `novel_narrator` / `novel_critic` 是内部阶段 Agent，不作为外部独立入口调用。
   - 其他 `novel_*` 质检、投放、润色工具由 `novel_generate_chapter` 在对应阶段内部调用，禁止手动拆开流程替代统一编排器。

2. **AI 的角色仅限于**：
   - 读取上下文文件（Preflight/ContextCompiler）
   - 调用 `novel_generate_chapter`
   - 解析工具返回结果
   - 向用户展示中间产物和最终结果
   - 根据统一编排器返回的重写约束、阻断原因或人工审阅点，重新发起生成或交由用户修正

3. **禁止行为**：
   - ❌ 禁止 AI 自行撰写任何章节正文
   - ❌ 禁止绕开 `novel_generate_chapter` 自行拼接生成链路（legacy Stage0-8 已删除，统一编排器是唯一编排路径）
   - ❌ 禁止用 AI 推测替代工具返回结果
   - ❌ 禁止直接调用 `novel_narrator` 输出章节正文
   - ❌ 禁止直接调用 `novel_critic` 替代质量审查
   - ❌ 禁止在未通过 `novel_generate_chapter` 的情况下输出"第X章"内容

4. **统一主链路模型路由**（唯一真相源为 `config/model-routing.json` v4.31.0）：
   - `v2_rawstage2_gemini31` / `v2_amplified_gemini31` → Gemini 3.1 Pro Preview；默认 `writerModel`，使用 `gemini_writer_v2`，失败 hard block，不静默切换 Claude 或其他正文模型
   - 默认 Gemini 生产路径 → NovelOS Agentic 检索/验证生成初稿，再由同一 writer family 消费作者风格档案做整章优化；初稿不得直接交付
   - `v2_rawstage2` / `v2_amplified` → Claude Opus 4.6；仅由显式 `writerModel=claude` 选择，使用 `claude_writer_v1`，route-level `fallback=[]`，不作为 Gemini 的自动备援
   - `boundedBestOf3` → 历史评测兼容字段；固定场景多候选已退出生产，旧证据不限制当前或未来模型能力
   - `v2_chinese_calibration` → Doubao Seed 2.1 Pro；仅保留隔离评测/历史局部校准兼容，不进入生产
   - `v2_opportunity_judge` / `v2_literary_judge` → gpt-5.6-sol；仅保留隔离评测/回放，生产调用数必须为 0
   - `style_shaper` / `stage5_style_shaper` / `stage8_final_gate` / `character_agent` → Claude Opus 4.6
   - `novel_critic` → local / quad-gates；其他结构化检查按配置路由到 GPT 5.5
   - GLM 5.2 仅允许显式开发/NovelBench testing route，生产默认和 fallback 禁止使用；Qwen、ERNIE 当前 disabled

### 流程节点铁律（统一主链路口径）
- ~~阶段0→阶段8必须按顺序执行，严禁跳过~~ —— 已废止，legacy Stage0-8 已物理删除。统一主链路编排顺序以新计划 §3 为准。
- Preflight 前置检查：config.json、角色档案（必需）；前章 narrative-state（第 2 章及以后必需，第 1 章跳过）；series/outline.md（可选，仅高层背景参考）
- **任何前置条件不满足 → 停止并告知用户缺失项，不得继续**
- **缺少 series/outline.md 不得阻断生成**；Seed 不足时阻断，提示补种子源（不提示补章纲）
- 统一主链路的 FactGuard / RiskAnalyzer / FinalFactRecheck 等检查即使无 LLM 增强也要执行本地规则

### 稳定性门槛与阻断治理（治理方案新增）

把"随机阻断"治理成可预检、可诊断、可恢复、可回放的稳定生成系统。所有阻断必须有结构化证据，所有模型随机失败必须进入 bounded recovery。

**FailureEnvelope 阻断归因**：所有 Stage/Gate 失败（Preflight/ContextCompiler/Raw/FactGuard/Editorial/Judge/Selection + 顶层 catch）归一成 `FailureEnvelope`（stage/gate/severity/reason/evidence/recoverable/retryPlan/userActionRequired），写入 `workspaces/{id}/traces/{chapterId}-quality-trace.json` 的 `failureEnvelopes` 数组，并通过 `withFailureReturn` 返回给调用方。不再只返回笼统的"章节生成失败"。

> **Phase 1 整改（2026-07-28）**：`severity` 新增 `"recoverable"`（原仅 preflight|hard|fatal），用于模型超时/空结果等可自动恢复的失败。新增 `gate` 字段（如 `model_timeout` / `style_optimization` / `story_preservation` / `preflight`），工具层 `register-tools.ts` 用 `gate === "model_timeout" && severity === "recoverable"` 判断是否同阶段重试一次。风格优化失败不再回退 raw，blocked 路径 `selectedSource=null`。

**novel_preflight_workspace 生成前预检**：统一主链路 Preflight 阶段调用 `preflightWorkspace`，检查 config/角色档案/前章 skeleton/ChapterSeed 可生长性/manifest/模型 timeout/字数预算。预检失败不进入模型生成；缺 `series/outline.md` 不阻断；Seed 不足提示补种子源（不提示补章纲）。

**Gate 级恢复策略**（`craft/event-recovery-config.ts` 配置化预算）：
- schema/parse → `retry_gate`（只重试 gate 输出，不重写正文，`schemaMaxAttempts=2`）
- anti_ai → `rewrite_event`（带 detection snippet，`antiAiMaxAttempts=2`）→ 仍失败才 hard_block
- segment_contract → `rewrite_event`（只重写当前事件，`contractMaxAttempts=2`）
- event_progression → 保留主干硬门禁（`progressionMaxAttempts=1`）；类型专项义务按既有规则 warning/pass/block
- scene_continuity → `bridge_patch`（过 PatchQualityComparator）
- style → `style_patch`（span 级局部 patch；comparator 拒绝后缩小范围或重做，不覆盖原文）
- suspense_density → `local_repair`（局部增加 hook beat，再重跑悬念密度检查）→ 仍低于阈值才 hard_block

**Attempt History**：每次事件级重写必须调用 `makeRecoveryAttempt` 记录原因和命中证据，追加到 `recoveryAttempts`；重写耗尽后调用 `qualityTraceRecorder.recordFailureEnvelope(envelope, recoveryAttempts)` 把最终失败 envelope + attempt history 写入 trace。不允许无限循环；每次重写必须传入上一次 gate 的具体 failure evidence。

**PatchQualityComparator 唯一补丁权威**：SpanRepair 修订补丁必须经过 comparator；退化改写（agency 稀释 / score 跨 70 阈值回落 / 新增 critical issue）`accepted=false` 时原文不被覆盖，补丁取舍写入 trace。禁止 patch comparator 拒绝后仍覆盖原文。

**Replay Matrix**：唯一脚本是 `scripts/replay-generation-matrix.mjs`（`npm run replay:generation-matrix`）。它只走已注册的 `novel_generate_chapter` 生产调用器 `scripts/production-generate-chapter.mjs`，拒绝 mock / preview / eval / qualityExperiment / modelTestRoute。当前实现是确定性 harness（工具注册、禁止旗标、隔离目录），输出 `reports/production-rollout-audit/replay-matrix.json` 与 `replay-summary.md`。`scripts/invoke-generate-chapter.mjs` 默认 `modelTestRoute=glm`，不得作为生产验收入口。产品级成功/失败/恢复/并发样本属于 Wave 5，必须在隔离副本中用 stub 或经授权的真实模型运行。

**稳定性门槛**（验收口径，必须通过真实 workspace replay 验证）：
| 指标 | 目标 |
|------|------|
| Preflight 可解释率 | 100%（所有预检阻断有 `severity=preflight` envelope + fixInstructions） |
| 所有阻断都有 FailureEnvelope | 100%（无 silent degrade） |
| 自动恢复后成功率 | ≥ 85% |
| 未分类失败 | 0（每条失败能定位 stage/gate/reason/evidence） |
| 无限等待模型调用 | 0（`PINOVEL_MODEL_REQUEST_TIMEOUT_MS` bounded timeout，replay 脚本 `--timeout-ms` 兜底） |
| 真实 replay trace 留存率 | 100%（每条 sample 有 tracePath 或 traceArchivePath） |

**严禁**：
- 禁止绕开 `novel_generate_chapter`
- 禁止 AI 直接生成章节正文
- 禁止把 Stage 8 硬门禁改成默认 warning pass
- 禁止 parser/schema 错误直接触发正文重写（应只 `retry_gate`）
- 禁止 patch comparator 拒绝后仍覆盖原文
- 禁止无 trace 的 silent degrade

## CodeGraph 集成规范（P21 新增）

### 概述
CodeGraph 是本地代码知识图谱工具，通过 MCP 协议为 AI Agent 提供预索引的代码结构查询能力。

### 使用原则
> **核心原则**：对于"X 是如何工作的"、"架构是什么"、"X 如何到达 Y"、"X 在哪里"等问题，Agent 应该用少量 CodeGraph 调用回答（通常零文件读取），而不是用 grep+Read 重新推导。

### MCP 工具集

| 工具 | 用途 |
|------|------|
| `codegraph_query` | 按名称搜索符号 |
| `codegraph_context` | 构建任务相关的代码上下文（搜索+节点+调用者+被调者） |
| `codegraph_trace` | 追踪两个符号之间的调用路径（需 MCP 服务运行） |
| `codegraph_callers` | 查找什么调用了某函数 |
| `codegraph_callees` | 查找某函数调用了什么 |
| `codegraph_impact` | 分析更改符号会影响的代码 |
| `codegraph_node` | 获取符号详情（含源码）（需 MCP 服务运行） |
| `codegraph_explore` | 返回相关符号源码和关系图（需 MCP 服务运行） |
| `codegraph_files` | 获取索引的文件结构 |
| `codegraph_status` | 检查索引健康状态 |

> **CLI 命令**：直接运行 `npx @colbymchenry/codegraph <command>`，如 `codegraph query "函数名"`，`codegraph callers "符号名"`

### 使用场景

**必须使用 CodeGraph**（而非 grep/Read）：
1. 查找符号/函数/类的定义位置
2. 了解代码架构和模块关系
3. 追踪调用链（callers/callees）
4. 理解模块间的依赖关系
5. 搜索代码结构而非文本内容

**可以使用 grep/Read**：
1. 搜索特定文本内容（如日志信息、注释）
2. 读取已知文件的特定部分
3. 搜索非结构化文本

### 代码修改流程

1. **修改前**：使用 CodeGraph 理解代码结构和关系
2. **修改中**：按需使用 Read/Edit 工具
3. **修改后**：运行 `codegraph sync` 更新索引（如有需要）

### 索引维护
- 索引已包含 112 个文件，3,017 个节点，6,968 条边
- 语言覆盖：TypeScript (70文件)、JavaScript (32文件)、Python (10文件)
- 修改代码后自动同步，无需手动更新
