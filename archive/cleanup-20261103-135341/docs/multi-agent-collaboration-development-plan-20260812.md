# PiNovelStudio 多代理协作边界化开发计划

**版本**：v1.0  
**日期**：2026-08-12  
**状态**：生产主路径已接线；多代理协议核心已落地；上下文强制隔离与统一血缘索引已补强；策略反馈血缘门闩已接公共反馈路径；stub multi-agent boundary replay 已入 CI（见 `docs/multi-agent-wave-completion-20260812.md`）  
**适用范围**：统一生产主链路 `novel_generate_chapter` 及其隔离评测、审计和学习链路

## 1. 正式结论

PiNovelStudio 不应改造成“多个 AI 一起写小说”的系统。多代理协作的核心是：让不同代理承担不同类型的判断，通过严格的输入、输出和权限边界互相放大；模型负责探索、验证、生成和提出建议，编排器与系统负责阶段推进、硬门禁、事务提交和不可逆副作用。

本计划只建设一套统一主链路，不新增第二套生成模式，不恢复 legacy Stage0-8，不把机会裁判、pairwise judge、SelectionPolicy 或固定多候选选择带回生产路径。

生产责任链固定为：

```text
Preflight
  → ContextCompiler
  → ChapterIntent
  → NovelOS Agentic（创作代理）
  → Agentic FactGuard（事实门禁）
  → AuthorStyleOptimizer（作者风格代理）
  → StoryPreservation（故事保持门禁）
  → FinalFactRecheck
  → Completeness
  → FinalStateCommit
  → AtomicSave + Trace
```

## 2. 当前基线与开发原则

### 2.1 已有可复用资产

以下能力已经存在或已有明显实现，不应重复建设：

| 领域 | 当前资产 | 本计划中的动作 |
|---|---|---|
| 统一编排 | `v2/core/unified-entry.ts`、`unified-orchestrator.ts` | 以现有阶段为主线补齐协议和联调 |
| 能力控制 | `v2/core/control-plane.ts` | 扩展到代理级工作包、动作授权和审计 |
| 模型自主性 | `v2/core/control-types.ts`、`autonomy-policy.ts`、`action-catalog.ts` | 固化模型最高权限与 fail-closed 规则 |
| 候选隔离 | `novelos/security/permission-policy.ts`、`novelos/agent/candidate-workspace.ts` | 验证所有代理只能写隔离区 |
| 工具边界 | `novelos/tools/tool-protocol.ts`、工具注册表 | 建立按角色的工具白名单和资源范围 |
| 失败治理 | `craft/failure-envelope.ts`、`quality-trace-recorder.ts`、恢复模块 | 统一各代理失败分类、重试和 trace 关联 |
| Agentic 血缘 | `novelos/trajectory/*`、`agentic-raw-candidate-source.ts` | 补齐 candidate/session/agent role 统一索引 |
| 风格与故事门禁 | `author-style-optimizer.ts`、`editorial-story-preservation-gate.ts` | 明确输入输出契约，禁止越权改事实骨架 |
| 策略学习 | `v2/learning/*` | 按 strategy bundle 归因，不平均伪造单策略胜负 |

### 2.2 必须遵守的边界

1. `NovelOS Agentic` 是创作代理，不是总指挥；它只能在 `ChapterIntent + Context + ConstraintManifest` 内工作。
2. 模型代理最多拥有 `bounded_execute`，不能拥有 `chapter.save`、`state.commit`、`release.promote`、`baseline.replace`。
3. 模型输出只能形成 `evidence` 或 `proposal`；关键 `decision` 由编排器、FactGuard、FinalFactRecheck 和事务系统确认。
4. 所有正文改写都必须是候选或受控 patch；不得由代理直接覆盖正式章节。
5. Agentic 初稿不得直接交付；作者风格整章优化是生产必经阶段，失败必须结构化阻断。
6. 生产文学评价权归用户；机器 judge 只允许存在于隔离评测和回放。
7. 当前工作树已有用户进行中的修改、测试和未跟踪产物；开发开始前只做只读盘点和基线快照，不恢复、删除、暂存或覆盖这些改动。

## 3. 目标协议模型

### 3.1 代理角色

| 角色 | 输入 | 允许动作 | 输出 | 明确禁止 |
|---|---|---|---|---|
| `Preflight` | workspace 配置、角色档案、前章状态、模型预算 | 只读检查 | `PreflightResult` | 创作、改状态 |
| `ContextCompiler` | 作品状态、章种子、事实来源 | 编译工作集 | `ContextPackage` | 文学裁决、写正式文件 |
| `ChapterIntent` | 作者章卡、长期承诺、前态 | 形成任务目标 | `ChapterIntent` | 规定句子写法 |
| `NovelOS Agentic` | intent、工作上下文、约束清单、工具白名单 | 检索、验证、生成、局部 patch 提案 | `DraftAgentResult` | 改 intent、改宪法、提交状态、保存章节 |
| `FactGuard` | 候选正文、硬事实、实体、时间线 | 事实核验 | `FactGuardResult` | 判断风格优劣、改正文 |
| `AuthorStyleOptimizer` | Agentic 初稿、作者风格定性指导、事件保持约束 | 形成优化候选 | `EditorialResult` | 改剧情事实、改事件骨架 |
| `StoryPreservation` | 原稿、优化稿、事件骨架、关键承诺 | 故事保持核验 | `StoryPreservationResult` | 重新设计剧情 |
| `FinalFactRecheck` | 最终候选、硬事实清单 | 最终事实复核 | `FinalFactRecheckResult` | 代替用户做文学裁决 |
| `FinalStateCommit` | 最终正文、复核结果、用户确认/系统授权 | 状态提交、原子保存 | `CommitResult` | 生成或自行改文 |
| `Audit` | 阶段结果、失败、工具轨迹、血缘 | 汇总证据 | `AuditRecord` | 改变生产决策 |

### 3.2 结构化输出契约

第一阶段统一协议，至少包含以下字段；所有接口必须可序列化、可校验、可写入 trace：

```ts
interface DraftAgentResult {
  status: "ok" | "recoverable" | "blocked";
  candidateId: string;
  text: string;
  unresolvedFindings: Finding[];
  usedEvidenceRefs: string[];
  actionsTaken: AgentActionSummary[];
  stopReason: string;
  sessionId: string;
  lineage: AgentLineage;
}

interface FactGuardResult {
  passed: boolean;
  hardFindings: FactFinding[];
  advisoryFindings: AdvisoryFinding[];
  checkedFacts: string[];
  sourceRefs: string[];
  candidateId: string;
}

interface EditorialResult {
  status: "ok" | "recoverable" | "blocked";
  sourceCandidateId: string;
  candidateId?: string;
  changedSpans?: Span[];
  preservationRisk: "low" | "medium" | "high";
  failureKind?: string;
  strategyBundleId?: string;
}
```

契约校验失败只能触发 `retry_gate`，不得触发正文重写；结果缺少 candidate/session/来源引用时必须 fail closed。

### 3.3 工作包模型

每次代理调用都必须携带不可变的 `AgentWorkPackage`，至少包含：

- `taskId / orchestratorRunId / workspaceId / chapterId`；
- `agentRole / sessionId / parentCandidateId`；
- 目标、阶段、输入字段白名单；
- `allowedResources / forbiddenResources`；
- `allowedActions / forbiddenActions`；
- 模型锁、预算、超时和重试预算；
- 输出 schema 版本和验收条件；
- `contextHash / promptBundleHash / constraintManifestHash`。

工作包只传当前职责所需的最小上下文，禁止自动继承全部历史章节、其他代理内部讨论、无关诊断或原始思维链。

## 4. 开发波次与任务卡

### Wave 0：基线冻结与协议盘点（P0，先行）

**目标**：在不改生产逻辑的前提下，确认当前代码、测试、未提交改动和生产闭包，避免新协议覆盖用户现有工作。

**任务**：

- `MA-0.1`：建立只读基线清单：统一入口、生产传递依赖、控制面、Agentic、风格优化、状态提交、trace、现有 RED/GREEN 测试。
- `MA-0.2`：列出现有字段与目标契约的差异矩阵，标记 `reuse / adapt / missing / conflict`。
- `MA-0.3`：冻结本计划的 schema 版本、动作目录、角色枚举和 FailureEnvelope 映射表。

**验收**：有一份基线报告；没有修改、删除、暂存或覆盖用户现有工作；生产入口仍只有 `novel_generate_chapter`。

### Wave 1：代理工作包与结构化契约（P0）

**目标**：让每个代理通过明确、可校验、可追踪的输入输出工作。

**任务**：

- `MA-1.1`：新增 `agent-work-package.ts`，实现创建、哈希、schema 校验和资源范围校验。
- `MA-1.2`：新增 `agent-result-contracts.ts`，统一 Draft/FactGuard/Editorial/StoryPreservation/Commit 结果。
- `MA-1.3`：将现有 Agentic、AuthorStyle、FactGuard、StoryPreservation 输出适配到统一契约；保留现有业务字段，不做无理由重命名。
- `MA-1.4`：工作包和结果写入 trace，但不得写入原始思维链；敏感信息按现有 redaction 规则处理。

**验收**：所有生产代理调用均有工作包；所有结果均可 schema 校验；缺失字段、伪造 candidateId、越界资源和未知角色均 fail closed。

### Wave 2：权限与动作控制收口（P0）

**目标**：把“不能越权”从 Prompt 约定变成代码强制边界。

**任务**：

- `MA-2.1`：统一 `ActorType`、`ActionName`、`CapabilityName` 和 `PermissionPolicy`，消除重复枚举或语义漂移。
- `MA-2.2`：为每个代理生成角色权限 profile；Agentic 仅允许 workspace read、检索、模型生成、candidate write、proposal。
- `MA-2.3`：在工具注册和执行前检查 `requiredPermission + sideEffect + workPackage scope`，拒绝模型伪造的确认字段。
- `MA-2.4`：在 `FinalStateCommit`、`chapter.save`、`state.commit` 前增加 orchestrator/system actor、artifact hash、revision 和一次性授权校验。
- `MA-2.5`：为越权尝试记录 `ControlDecisionRecord` 和对应 FailureEnvelope；默认 fail closed。

**验收**：模型触发正式保存、状态提交、生产晋级和基线替换的次数为 0；编排器提交前所有授权证据齐全；路径穿越和跨 workspace 写入全部被拒绝。

### Wave 3：最小上下文与隔离工作区（P0）

**目标**：代理只看到完成当前职责所需的信息，并且所有中间产物与正式作品物理隔离。

**任务**：

- `MA-3.1`：为 Preflight、Agentic、FactGuard、AuthorStyle、StateCommit 分别定义输入字段白名单。
- `MA-3.2`：接入 `ContextCompiler` 的紧凑工作集、来源引用和回源句柄；禁止代理直接读取全量 workspace。
- `MA-3.3`：统一 `novelos-sessions/{sessionId}/` 候选目录产物命名：draft、evidence、tool-events、verifier、patch、lineage。
- `MA-3.4`：为跨代理传递增加 `sourceCandidateId`、`parentCandidateId` 和只读 artifact 引用，禁止复制无关正文和内部讨论。

**验收**：越权读取无关上下文的测试为 0；候选目录之外无代理写入；正式 `chapters/`、NarrativeState、CreativeConstitution 在代理阶段保持不变。

### Wave 4：编排器裁决与冲突治理（P0）

**目标**：明确 evidence、proposal、decision 三类结果，确保冲突按硬规则裁决，不由模型自批自准。

**任务**：

- `MA-4.1`：增加 `OrchestratorDecision` 和决策来源记录；代理返回不得直接改变阶段状态。
- `MA-4.2`：实现固定裁决优先级：硬事实冲突 > 权限/安全 > 状态事务 > 作者契约 > 故事保持 > 风格建议 > 机械指标。
- `MA-4.3`：实现阶段转移守卫：Agentic 初稿必须经过作者风格优化、StoryPreservation 和 FinalFactRecheck 才能进入提交。
- `MA-4.4`：为 FactGuard hard block、风格优化失败、StoryPreservation 漂移、状态提交失败分别接入对应恢复路径；禁止跨代理伪装成功。
- `MA-4.5`：确保 schema 错误只走 gate retry，模型超时只走同阶段 bounded retry，正文硬冲突不由风格代理覆盖。

**验收**：任何代理返回 `blocked` 都不能被转换为 warning 继续生产；所有阶段转移都有 decision record；不存在 Agentic 初稿直接交付路径。

### Wave 5：血缘、审计与策略归因（P1）

**目标**：让每个候选、代理、策略和用户结果可以完整追溯，支持可靠学习。

**任务**：

- `MA-5.1`：统一 lineage 字段：`orchestratorRunId`、`candidateId`、`sourceCandidateId`、`parentCandidateId`、`agentRole`、`agentSessionId`、`strategyId`、`strategyBundleId`、`modelVersion`、`promptBundleHash`、`contextHash`、`usedEvidenceRefs`。
- `MA-5.2`：把 Agentic trajectory、工具事件、阶段结果、FailureEnvelope 和最终提交关联到同一 run/candidate 索引。
- `MA-5.3`：策略共同作用时只记录 `strategyBundle win/loss`；单策略只有满足独立证据条件时才进入策略信誉。
- `MA-5.4`：将用户接受、拒绝、修改、回滚反馈接入 lineage 校验；不完整血缘不得更新生产策略。

**验收**：代理结果可追溯率 100%；FailureEnvelope 覆盖率 100%；多策略归因不拆分伪造；旧模型经验不污染新模型。

### Wave 6：评测矩阵与生产回归（P1）

**目标**：验证边界真实有效，而不是只验证类型能编译。

**任务**：

- `MA-6.1`：建立最小 15 项多代理 Eval 矩阵（见第 5 节）。
- `MA-6.2`：为每项增加正向、越权、失败恢复和 trace 断言。
- `MA-6.3`：接入现有 `tests-eval`、NovelOS runtime/architecture/tool protocol 测试，不重复创建并行测试框架。
- `MA-6.4`：运行真实 workspace replay，验证每条 sample 有 tracePath 或 traceArchivePath；不以单次 build/test 宣称质量提升。

**验收**：安全边界、职责边界、失败可解释性和血缘指标全部达到门槛；生产路径未引入 machine judge 或第二生成入口。

### Wave 7：文档、运维和发布收口（P1）

**目标**：让开发、排障和后续策略学习有稳定操作手册。

**任务**：

- `MA-7.1`：补充代理角色、权限、工作包、结果契约和冲突裁决文档。
- `MA-7.2`：补充 FailureEnvelope/trajectory/lineage 的查询和回放 runbook。
- `MA-7.3`：加入生产发布前检查：公开工具数量、生产闭包依赖、模型锁、权限拒绝、trace 完整率。
- `MA-7.4`：形成版本化迁移说明；新协议进入生产后只保留唯一最新基线，删除已被替换的并行旧实现。

## 5. 最小多代理 Eval 矩阵

以下用例必须全部具备可自动化断言：

1. 上下文足够时 Agentic 能直接生成。
2. 存在 `mustVerify` 时先检索再生成。
3. Agentic 不能调用被禁止工具。
4. Agentic 不能提交状态或保存章节。
5. FactGuard 硬冲突阻断后续提交。
6. 风格优化只改变表达，不改变事件骨架。
7. StoryPreservation 漂移触发有限 reduced-guidance 重试。
8. schema 错误只重试 gate，不重写正文。
9. 任一代理失败都有 FailureEnvelope。
10. 多代理结果可追溯到 candidate 和 session。
11. 多策略共同作用不会伪造单策略胜负。
12. Agentic 初稿不会绕过作者风格优化直接交付。
13. 最终状态只由系统在最终正文确认后提交。
14. 子代理看不到无关或超出授权范围的上下文。
15. 一个代理的建议不会自动改变另一个代理的权限。

## 6. 依赖关系与建议派工顺序

```text
MA-0 基线冻结
   ↓
MA-1 工作包/契约 ─────┐
   ↓                  │
MA-2 权限控制 ────────┼→ MA-4 编排器裁决
   ↓                  │          ↓
MA-3 上下文隔离 ──────┘       MA-5 血缘审计
                                      ↓
                               MA-6 Eval/Replay
                                      ↓
                               MA-7 发布收口
```

建议按以下批次安排开发：

- **批次 A（必须串行）**：`MA-0 → MA-1`。先确认基线，再冻结协议，避免各开发者各自发明字段。
- **批次 B（可并行）**：`MA-2` 与 `MA-3`。两者共享 Wave 1 契约，但彼此实现可分开。
- **批次 C（必须串行）**：`MA-4`。必须等权限和上下文边界稳定后接入统一编排器。
- **批次 D（可并行）**：`MA-5` 与文档初稿。血缘字段冻结后即可并行实现存储和查询。
- **批次 E（必须串行）**：`MA-6 → MA-7`。先用 Eval/Replay 证明边界，再办理生产收口。

## 7. 验收门槛

### P0 门槛：不满足不得进入生产

- 未授权副作用次数：`0`。
- 模型直接执行 `chapter.save/state.commit/release.promote/baseline.replace`：`0`。
- Agentic 初稿直接交付：`0`。
- FactGuard 或 FinalFactRecheck 被绕过：`0`。
- 无 FailureEnvelope 的失败：`0`。
- 代理职责越界率：`0`。
- 无关上下文泄露率：`0`。
- 生产公开章节入口：仅 `novel_generate_chapter`。
- 生产路径 machine judge / pairwise judge 调用数：`0`。

### P1 门槛：达到后才声明“协作边界闭环”

- 代理结果可追溯率：`100%`。
- trace/lineage 留存率：`100%`。
- 所有失败可定位到 `stage/gate/reason/evidence/retryPlan`。
- 多策略归因错误率：接近 `0`，不完整血缘不更新信誉。
- 真实 workspace replay 中，自动恢复成功率达到项目稳定性目标（当前目标为 `≥85%`）。

这些门槛只证明职责、权限、恢复和审计闭环，不等同于文学质量已经提升。文学质量仍需用户最终正文和后续修改反馈验证。

## 8. 明确不在本计划中的内容

- 不新增多个完整章节写作者并行竞争。
- 不恢复 legacy Stage0-8、`generationMode` 或章节白名单。
- 不把机械指标、对话比例、段落比例、AI 腔扫描升级为生产硬门。
- 不让模型直接修改 `CanonState`、`CreativeConstitution`、`NarrativeState` 或正式章节。
- 不在生产链路加入 opportunity judge、pairwise judge、SelectionPolicy 或自动文学 winner。
- 不因代理失败静默切换到未授权模型、raw 交付或另一代理冒充完成。
- 不以 build/test 通过单独宣称小说质量收益。

## 9. 开发完成定义

本计划只有在以下条件同时满足时才算完成：

1. 统一主链路所有代理均使用版本化工作包和结构化结果契约。
2. 模型、编排器、系统、用户四类 actor 的能力和动作边界由代码强制执行。
3. 代理只读最小工作上下文，中间产物只写隔离候选区。
4. 所有阶段冲突按固定优先级裁决，失败不能互相伪装。
5. 每个候选、代理、策略、模型和用户反馈都有完整血缘。
6. 第 5 节的 15 项 Eval 全部通过，真实 replay 有完整 trace。
7. 生产入口、模型路由、状态事务和发布基线没有新增并行版本。

完成后，PiNovelStudio 达到的不是“更多模型一起写”，而是：模型承担更多高层判断，系统只保留更少但更关键的不可逆决定。

