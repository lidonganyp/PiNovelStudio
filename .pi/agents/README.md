# 小说创作专家智能体（agents/）

本目录是 PiNovelStudio 的**专家智能体定义层**。每个 `*.md` 是一个可被 PI 派发的专家角色，采用
「提示词（正文）+ 附属技能（frontmatter `skills`）+ 展示信息（frontmatter `display`）+ 领域资料（`knowledge/`）」四件套。

## 目录结构

```
.pi/agents/
├── README.md                      # 本索引
├── <agent-name>.md                # 专家定义：正文固定五要素（角色/指令/约束/示例/输出格式）+ 领域资料
└── <agent-name>/
    └── knowledge/*.md             # 该专家专属领域资料（随时可调用，不注入他人上下文）
```

## Frontmatter 契约

```yaml
---
name: novel-director            # 唯一标识（小写短横线，不含 ":"）
description: |                  # 何时应该派发这个专家（决定调度的唯一依据）
  一句话说明适用场景与产出。
skills:                         # 附属技能，指向 .pi/skills/ 下的技能名
  - novel-init
tools:                          # 只读/只调白名单工具（最小权限原则）；必须写实际注册名
  - read
  - grep
  - find
display:                        # 展示信息：人类可读的角色卡
  title: 总策划（Director）
  emoji: 🎬
  category: 统筹调度
  bestFor: 立项、赛道定位、专家调度、交付汇总
  notFor: 直接写正文
  triggers: ["立项", "定赛道", "开始写这本书"]
knowledge:                      # 领域资料入口，路径相对本目录：<role>/knowledge/<file>.md
  - novel-director/knowledge/director-playbook.md
---
```

> **不要写 `model` 字段**。省略即继承宿主当前模型；写 `model: inherit` 会被当作模型名 `inherit` 传给运行时，导致该专家无法启动。
>
> **工具名必须是实际注册名**：PI 内置只读工具是小写 `read` / `grep` / `find` / `ls`；`Read` / `Grep` / `Glob` 这类写法不会被识别，专家加载时应被拒绝。本项目公开的 `novel_*` 工具按 `index.ts` 注册名书写（且专家不得持有 `novel_generate_chapter`）。
>
> **未被宿主识别的字段（`display` / `knowledge` / `skills`）**会被宿主安全忽略，因此**不是**运行时契约；本项目由 `novelos/experts/expert-registry.ts` 自行解析与校验（含工具白名单、knowledge 路径可解析、正文五要素顺序）。

## 专家清单

| # | 智能体 | 展示名 | 分类 | 核心产出 | 附属技能 |
|---|--------|--------|------|----------|----------|
| 1 | `novel-director` | 🎬 总策划 | 统筹调度 | 立项卡、专家派发单、交付汇总 | novel-init / novel-ai-fullauto-blueprint |
| 2 | `world-builder` | 🌍 世界观构建师 | 设定 | 世界规则、势力/地理/金手指、术语表 | novel-init |
| 3 | `character-designer` | 👥 角色设计师 | 设定 | 人物卡、动机与弧光、关系网、声音标签 | novel-brainhole-mine |
| 4 | `plot-architect` | 🗺️ 情节架构师 | 结构 | 高层背景、分卷功能、期待兑现曲线 | novel-ai-fullauto-blueprint |
| 5 | `foreshadow-keeper` | 🧵 伏笔与承诺管家 | 结构 | 埋设/回收台账、PromiseLedger 核对单 | novel-ai-fullauto-blueprint |
| 6 | `chapter-intent-builder` | 📐 章节契约构建者 | 执行前置 | ChapterSeed 意图、章末目标、不可违背事实 | novel-write |
| 7 | `style-guardian` | 🎨 文风校准师 | 表达 | 定性风格指导、禁用机械配额、漂移诊断 | novel-style-extract |
| 8 | `continuity-auditor` | 🔍 连续性审校师 | 质检 | 时间线/实体/称谓/状态差异报告 | novel-chapter-revision |
| 9 | `reader-proxy` | 👓 读者视角评审 | 质检 | 期待/爽点/信息释放诊断（只诊断不裁决） | novel-chapter-revision |
| 10 | `quality-gate-runner` | 🚦 交付质检员 | 质检 | FailureEnvelope 归因、trace 复核、阻断说明 | novel-write |

## 调度关系（谁在什么阶段找谁）

```
立项   novel-director
        ├─ 设定   world-builder ──► character-designer
        ├─ 结构   plot-architect ──► foreshadow-keeper
        ├─ 写前   chapter-intent-builder（产出 ChapterSeed 意图，交 novel_generate_chapter）
        ├─ 写后   style-guardian / continuity-auditor / reader-proxy（只出诊断）
        └─ 交付   quality-gate-runner（复核 trace + FailureEnvelope）
```

**并行原则**：写后三个质检专家（7/8/9 号）互不依赖，可并行派发；写前设定与结构专家有依赖顺序，必须串行。

## 派发器状态（如实标注）

- **已实现**：`novelos/experts/expert-registry.ts`（加载与校验本目录定义）、`expert-dispatcher.ts`（director→单专家的结构化派发、预算与权限边界）、`chapter-contract-bridge.ts`（契约解析与校验）、`expert-result-summary.ts`（公开返回归一化）。
- **已接入生产工具面，但不是 PI 自动调度**（EXPERT-HOST-HANDOFF-1，2026-10-30）：`handlers/expert-handoff-handler.ts` 经现有 `novel_workspace_manager` 暴露三个子操作（不新增第 7 个公开工具）：
  - `action="list_experts"`：发现并校验本目录专家资产（registry 有 error 即 fail-closed）；
  - `action="dispatch_expert"`：校验角色/可读路径/提示词预算后返回**宿主可执行的专家任务包**（system prompt + task message + 只读工具白名单）。扩展自身不调用模型、不写任何文件；`executionMode="execute"` 在生产无授权执行器时 fail-closed；
  - `action="handoff_chapter_contract"`：`preview` 只校验并返回 `proposalHash`，**不签发 commit 凭证**；`commit` 必须回传**可信宿主审批层**调用 `issueChapterContractApproval({ workspaceId, chapterNumber, proposalHash, approvedBy })` 签发的一次性凭证（绑定 workspace/chapter/proposalHash、单次使用、15 分钟过期），并需 `confirm=true`，写入 `series/ch{N}-outline-explicit.md`（`novel_generate_chapter` 的唯一显式章纲消费路径）后落 `*.provenance.json`（expertRole / proposalHash / confirmedBy / approvalReceiptId / approval）。`confirmedBy` 仅作审计标签，不构成授权证明。
- **未接入 PI 运行时自动调度**：`.pi/settings.json` 只加载 `novel-studio` 扩展；扩展入口只注册 6 个公开工具，没有专家运行时注册或自动发现机制。PI 宿主既不会自动发现本目录，也不会自动派发或自动执行专家，因此**不能称为“专家已自动加入 PI 调度链路”**。专家只能由调用方显式发起 `dispatch_expert`，再由宿主用自己的模型执行返回的任务包；专家输出仍是提案，作者确认与机器事实检查才是权威。
- **权限边界（工具名 + action 双重校验，且在执行前拦截）**：`novel_plan_story_outline`（写 `series/outline.md`）与 `novel_strategy_feedback`（写策略信誉库）属于写入工具，专家一律不得持有，落盘/提交由父代理执行。`novel_workspace_manager` 只允许只读/零写入 action（`list` / `info` / `chapters` / `list_experts` / `dispatch_expert`）；`init` / `switch` / `proxy_finalization` / `ingest_reader_feedback` / `record_return_chapter` / `handoff_chapter_contract` 对专家 fail-closed。`dispatch_expert` 返回的任务包带 `allowedActions`，宿主执行时必须按此校验 action，不能只看工具名。
- **执行前授权守卫（EXPERT-PREAUTH-1）**：`expert-dispatcher` 在调用执行器前注入 `authorizeToolCall`，执行器必须在执行任何工具/action 前先调用；被拒绝的动作不得执行。执行器上报的 `toolCalls` 必须命中已授权判定，未预授权即上报执行会判 `tool_call_not_preeuthorized`；任何被守卫拒绝的尝试都会让本次派发 fail-closed（`denied`），并写入 `toolCallDecisions` 审计记录。
- 这些模块不注册公开工具、不产生第二个章节生成入口。

## 正文结构要求（强制）

专家定义正文必须按**五要素固定标题**组织，顺序固定，缺一即判定不合格：

1. `## 【角色】`：向谁交付、站在什么立场说话。
2. `## 【指令】`：允许的能力 + 工作流程（可直接执行的步骤）。
3. `## 【约束】`：红线（硬边界）+ 权限与预算（可用/不可用工具、单次量级、引用长度）。
4. `## 【示例】`：抽象正例 / 反例；生成正文类内容禁止给可仿写的整段范文。
5. `## 【输出格式】`：唯一允许的输出形态与必须标注的字段。

末尾可加 `## 领域资料（按需参考）`。

## 全目录统一红线（每个专家都必须遵守，文件内重复声明）

1. ⛔ **任何专家都不得自行撰写章节正文**。正文只能由 `novel_generate_chapter` 统一主链路产出。
2. ⛔ **不得调用文学裁判**（opportunity judge / pairwise judge / SelectionPolicy）；文学评价权归用户。
3. ⛔ **不得写 `chapters/`、`narrative-state-store.json`、`.env`**；长期状态只在最终正文选定后由编排器提交。
4. ⛔ **不得把历史统计变成机械配额**（段长百分位、对白比例等只能作为诊断证据）。
5. ⛔ **不得静默降级**：任何阻断/失败都要给结构化证据（`FailureEnvelope` 或同构 JSON），不得用"正在生成"敷衍。

## 版本与维护

- 新增专家必须先在 README 清单登记，并提供 `knowledge/` 目录，否则视为未完成。
- **每个专家只保留 1 份知识库**：`knowledge/` 恰好一个 `.md` 文件（合并后的主手册）。新增资料必须先与现有文件去重、合并进这一份，不得新建第二份并行资料。
- 专家定义是纯 Markdown 资产，不参与 `tsconfig` 三目标构建；修改后无需重新编译即可被 `list_experts` / `dispatch_expert` 读取（但宿主不会自动派发，需显式调用）。
- 新增/修改后自检四件事：① frontmatter 六字段齐全（`name` / `description` / `skills` / `tools` / `display` / `knowledge`，**不含 `model`**）；② 正文五要素齐全且顺序固定；③ **三方一致**——frontmatter `knowledge:` 列表 = 正文「领域资料」链接 = `knowledge/` 目录实际文件，数量**恰好 1 个**，路径形如 `<role>/knowledge/<file>.md` 且可解析；④ `tools` 全部为实际注册名，且不含 `novel_generate_chapter`、`novel_plan_story_outline`、`novel_strategy_feedback` 与任何写文件/执行命令工具。
- 离线校验入口：`node --import ./tests/setup-test-env.mjs --test --test-isolation=none tests/expert-registry.test.mjs`；生产接入回归：`tests/expert-production-handoff.test.mjs`。
