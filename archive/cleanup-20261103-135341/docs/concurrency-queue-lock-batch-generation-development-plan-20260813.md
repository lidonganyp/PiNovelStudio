# PiNovelStudio 并发、队列、锁与批量生成调度开发计划

**版本**：v1.0  
**日期**：2026-08-13  
**适用范围**：统一主链路生产生成、批量章节生成、章节审批/确认、NarrativeState 与 frontier 推进、production pointer/release 治理  
**执行方式**：按波次分派；每个波次完成其验收门槛后，才能进入下一波次

## 1. 目标与不可变架构原则

本计划将本轮讨论收敛为一套唯一生产并发模型：

> **计算并发，状态串行；提交幂等，冲突显式化。**

小说生成不追求“章节越多并行越快”。章节 N 的最终正文会更新 CanonState、CharacterState、PromiseLedger、PatternMemory，并成为章节 N+1 的 ContextCompiler 输入。因此：

- 模型调用、检索、候选生成、诊断和 Review Surface 准备可以并行；
- 同一 workspace 的 NarrativeState、正式章节、frontier 必须按叙事顺序串行提交；
- 同一章节可以并发生成多个候选，但只能有一个正式 revision；
- 不同 workspace 可以并行；离线 Eval 与生产状态隔离；
- 锁只保护副作用，不覆盖整个模型生成生命周期；
- 锁不是事实源，事件、commit intent、receipt 和磁盘 revision 才是事实源；
- 生产只保留一套最新实现，不建立 legacy/新并行生产链路，不引入回退双轨。

## 2. 当前基线与复用边界

当前实现已经具备以下能力，后续工作应在其上增量收敛，不重复建设：

| 现有能力 | 当前位置 | 处理结论 |
|---|---|---|
| workspace 批量锁、PID 检查、30 分钟租约、heartbeat、jobId 释放校验 | `.pi/extensions/novel-studio/v2/core/batch-generation-lock.ts` | 保留 API 语义，升级为原子获取与完整租约协议 |
| BatchJobState、frontier、checkpoint、cancel、章节结果持久化 | `.pi/extensions/novel-studio/v2/core/batch-generation-job-store.ts` | 保留 materialized state，增加 revision/CAS 与事件绑定 |
| 批量逐章运行、失败/ checkpoint 停止、resume 幂等 | `.pi/extensions/novel-studio/v2/core/batch-generation-orchestrator.ts` | 保留串行 frontier 语义，接入提交队列与冲突处理 |
| 批量入口 start/resume/status/cancel | `.pi/extensions/novel-studio/handlers/batch-generation-handler.ts` | 保留公开入口，补充 commandId、队列状态和并发错误码 |
| 正文原子保存、状态提交回滚、commitIntentId、完成账本 | `.pi/extensions/novel-studio/v2/core/orchestrator-commit-save.ts` | 作为章节提交事务底座，补齐 revision/hash/receipt 绑定 |
| RunAggregate、事件折叠、commandId 幂等、commit intent 状态 | `.pi/extensions/novel-studio/v2/core/run/` | 作为事实源与恢复依据，避免再造第二套事实账本 |
| 审批 pending/stale/rejected fail-closed | `v2/governance/`、`chapter-proxy-finalization-handler.ts` | 复用，统一错误码与 stale 语义 |

当前工作树存在用户未完成的改动。本计划不要求恢复、删除、覆盖或暂存这些改动；开发执行时必须先以干净的基线快照记录实际差异。

## 3. 资源分层模型

所有任务必须先声明资源类型，禁止把所有工作塞入一条 workspace 全局队列。

### Level 1：只读计算池

允许高并发；只能读取快照，输出隔离 artifact：

- Preflight、retrieval、ContextCompiler；
- NovelOS Agentic 候选生成；
- 本地 FactGuard/diagnostics；
- Review Surface 渲染；
- 离线 Eval/replay。

约束：不得写正式 `chapters/`、不得提交 NarrativeState、不得推进 frontier、不得切换 production pointer。

### Level 2：候选与诊断写入队列

允许有限并发；写入必须绑定 `runId + candidateId + artifactHash + baseRevision`：

- candidate artifact；
- trace/trajectory；
- checkpoint/review package；
- 诊断报告与证据索引。

约束：候选 artifact 不等于正式章节；不得消费为下一章正式上下文。

### Level 3：workspace 章节提交队列

同一 workspace 严格串行；队列项执行：

```text
重新读取基线
→ FinalFactRecheck
→ FinalStateCommit
→ AtomicChapterSave
→ commit receipt
→ frontier advance
```

不同 workspace 可并行。提交队列只保护副作用阶段，不持有模型生成期间的长锁。

### Level 4：release/governance 串行队列

项目级或全局串行：

- production pointer switch；
- release hold/rollback；
- strategy/data promotion。

该队列与生产章节提交必须有明确顺序关系，不能无序互相覆盖。

## 4. 目标数据契约

### 4.1 锁租约契约

`BatchLockInfo` 至少包含：

```text
workspaceId
lockId
ownerRunId
ownerJobId
hostId
pid
acquiredAt
heartbeatAt
expiresAt
```

释放、续租和接管必须使用 `lockId + ownerJobId` 双绑定；仅凭 PID 或 jobId 不足以完成所有权判断。

锁获取必须采用“原子创建 → 失败后读取租约 → 仅在租约过期且 owner 不存活时接管”的流程。禁止 `exists → write` 的非原子模式。

### 4.2 BatchJobState CAS 契约

在现有 `BatchJobState` 增加：

```text
stateRevision: number
lastEventId: string | null
ownerRunId: string | null
```

持久化接口改为概念上的：

```text
save(expectedRevision, nextState) -> ok | concurrent_state_update
```

磁盘当前 revision 不等于 `expectedRevision` 时必须拒绝写入，不能静默覆盖。

### 4.3 候选/提交命名空间

候选记录至少绑定：

```text
candidateId
runId
chapterId
sourceRevision
baseStateRevision
artifactHash
createdAt
```

正式提交记录至少绑定：

```text
chapterId
finalRevision
commitIntentId
approvalId
artifactHash
baseStateRevision
baseReleaseId
chapterFileHash
narrativeStateRevision
receiptId
```

候选可并存；正式 revision、approval 消费和 frontier 推进只能各成功一次。

### 4.4 命令幂等契约

用户操作 `accept`、`accept_with_edits`、`reject`、`rollback`、`resume`、`cancel` 必须携带 `commandId`。

- 相同 `commandId`：返回第一次结果，不重复保存、提交或写反馈；
- 不同 `commandId` 操作同一 revision：先到者成功，后到者返回 `stale` 或 `already_consumed`；
- 典型错误码：`approval_already_consumed`、`stale_revision`、`concurrent_state_update`、`commit_conflict`、`stale_release`。

## 5. 开发波次与工作包

### Wave 0：基线冻结、接口盘点与可观测性基线

**目标**：在修改并发语义前，固定现状、确认复用边界，建立后续回放所需的统一事件字段。

**任务**：

1. 盘点 batch lock、BatchJobState、commit/save、审批、RunAggregate 的生产调用图；
2. 列出现有事件、trace、ledger、receipt 的字段差异；
3. 固定并发错误码、FailureEnvelope 映射和 trace 字段命名；
4. 为每个提交操作补齐 `workspaceId/chapterId/runId/jobId/commandId/baseRevision` 的审计上下文；
5. 建立并发 Eval fixture：双进程、损坏锁、状态冲突、崩溃点注入。

**交付物**：

- 并发资源/调用关系图；
- 错误码与 FailureEnvelope 对照表；
- 现有测试覆盖矩阵；
- Wave 1 可直接使用的 fixture 与脚本。

**通过条件**：不改变生产行为；现有 batch、commit intent、run lifecycle 测试通过；所有后续改动点有明确文件归属。

**依赖**：无。

### Wave 1：原子租约锁与 owner 身份升级

**目标**：消除 workspace 锁的竞态获取、PID 复用误判和旧 owner 误释放风险。

**主要修改范围**：

- `v2/core/batch-generation-lock.ts`；
- `handlers/batch-generation-handler.ts`；
- `v2/core/batch-generation-orchestrator.ts`；
- 对应 batch lock 测试与跨进程 fixture。

**任务**：

1. 引入 `lockId/ownerRunId/ownerJobId/hostId/heartbeatAt`；
2. 使用原子创建或等价的独占写入语义获取锁；
3. 将损坏锁处理改为 fail-closed 或结构化接管，不得静默覆盖；
4. 续租时 compare-and-swap 校验 lockId 与 owner；
5. 释放时校验 `lockId + ownerJobId`；
6. 明确定义“PID 已退出但租约未过期”“PID 复用”“heartbeat 失败”的恢复规则；
7. 保留现有 workspace 锁作为提交权兼容保护，直到 Wave 3 提交队列完成。

**通过条件**：

- 两个进程同时获取同一锁最多一个成功；
- 损坏锁不导致双写；
- PID 复用不会误认旧 owner；
- 旧任务 finally 不会删除新任务锁；
- heartbeat 失败有结构化结果，不能无限假装持锁；
- 不同 workspace 的锁互不影响。

**依赖**：Wave 0。

### Wave 2：BatchJobState revision/CAS 与 frontier 事实绑定

**目标**：阻止两个进程的 `load → modify → save` 静默覆盖，并把 frontier 从“文件推断”升级为提交事实。

**主要修改范围**：

- `v2/core/batch-generation-job-store.ts`；
- `v2/core/batch-generation-orchestrator.ts`；
- `handlers/batch-generation-handler.ts`；
- batch state/recovery 测试。

**任务**：

1. 为 BatchJobState 增加 `stateRevision/lastEventId/ownerRunId`；
2. 实现原子 compare-and-swap 保存；
3. 所有状态转移（running、paused、checkpoint、cancelled、completed）写入事件 ID；
4. CAS 失败返回 `concurrent_state_update`，保留磁盘状态，不做覆盖重试；
5. 将章节完成判定升级为 `commit receipt + chapter revision/hash + NarrativeState revision + commitIntentId`；
6. 文件存在、旧 completedChapters 仅作为辅助证据；
7. resume 前执行状态重读与 CAS，避免两个 resume 同时接管同一任务。

**通过条件**：

- 两个任务同时更新同一 BatchJobState 时一成功一冲突；
- frontier 不会跳过 checkpoint、审批未完成或提交冲突章节；
- 进程重启后可由 state revision 与事件恢复唯一状态；
- 重复 resume 不重复提交、不重复推进 frontier。

**依赖**：Wave 1 的 ownerRunId 与锁语义。

### Wave 3：workspace 章节提交队列与资源级锁

**目标**：把“生成生命周期互斥”改为“正式副作用互斥”，允许安全的只读并发和候选并发。

**主要修改范围**：

- 新增 `v2/core/submission-queue.ts`（或等价模块）；
- `v2/core/batch-generation-orchestrator.ts`；
- `v2/core/orchestrator-commit-save.ts`；
- `handlers/batch-generation-handler.ts`；
- review/diagnostic 入口的资源声明。

**任务**：

1. 定义资源类型：`readonly_compute`、`candidate_write`、`chapter_commit`、`release_governance`；
2. 实现 workspace 级章节提交队列；
3. 队列项只在 FinalFactRecheck 之后申请提交权；
4. 提交前重新读取 chapter/state/release 基线；
5. 提交完成后按固定顺序写 receipt、记录事件、推进 frontier；
6. Review Surface、只读诊断、离线 Eval 不获取提交锁；
7. 不同 workspace 的章节提交允许并行；
8. 队列拒绝、排队、执行、冲突、取消都写结构化 trace。

**通过条件**：

- 同一 workspace 同时存在正式提交者为 0/最多 1；
- 只读 Review 与章节提交并行时互不阻塞；
- 同一 workspace 的正式提交按 frontier 顺序执行；
- 不同 workspace 可并行且无状态污染；
- 锁丢失不能直接判定提交失败，恢复依据事件和 receipt。

**依赖**：Wave 1、Wave 2。

### Wave 4：候选 artifact 与正式提交隔离、stale 检测

**目标**：允许同一章节并行生成候选，但禁止过期上下文或过期审批稿越过正式提交边界。

**主要修改范围**：

- candidate artifact 存储/索引模块；
- `v2/core/orchestrator-commit-save.ts`；
- `v2/governance/chapter-proxy-approval-*`；
- `handlers/chapter-proxy-finalization-handler.ts`；
- candidate/revision 测试。

**任务**：

1. 建立 candidate namespace 与 commit namespace；
2. 候选生成只写隔离 artifact，不写正式正文和长期状态；
3. 提交时校验 chapter revision、approvalId、artifactHash、NarrativeState base revision、active releaseId；
4. CreativeConstitution 或 release pointer 变化时返回 `stale_revision`/`stale_release`，禁止提交；
5. 预生成候选可保留供 Review，但不得直接成为下一章正式上下文；
6. 明确 candidate 过期、撤销、清理和审计保留周期；
7. 将 `commitIntentId`、`approvalId`、`artifactHash` 绑定到 receipt。

**通过条件**：

- 两个候选可并存但只能一个正式 revision；
- 旧状态候选无法覆盖新状态；
- approval 被另一操作消费后，重复 accept 返回 `approval_already_consumed`；
- active release 改变时旧候选提交被阻断；
- 候选 artifact 不污染 chapters、NarrativeState、frontier。

**依赖**：Wave 2、Wave 3。

### Wave 5：命令幂等、崩溃恢复与取消/提交竞态

**目标**：把用户重复操作、进程崩溃和锁丢失统一到事件事实恢复模型。

**主要修改范围**：

- `v2/core/run/` 现有 aggregate/repository/projection；
- `v2/core/orchestrator-commit-save.ts`；
- 批量 handler 与审批 handler；
- recovery/reconciliation 模块和测试。

**任务**：

1. 统一所有用户操作的 commandId 接入；
2. 重复 commandId 返回首次结果，禁止重复副作用；
3. accept 与 rollback、cancel 与 commit、resume 与 active run 建立明确状态机顺序；
4. 重启恢复按以下顺序执行：

```text
事件流
→ commit intent ledger
→ 正文 revision/hash
→ NarrativeState revision
→ commit receipt
→ 决定 completed / retry / checkpoint / blocked
```

5. 覆盖 save 前崩溃、chapter save 后崩溃、state commit 后崩溃、receipt 写入后崩溃；
6. 锁存在不代表提交成功，锁删除不代表可安全重试；
7. 恢复过程必须产生 recovery trace，不得 silent degrade。

**通过条件**：

- chapter save 后崩溃不会重复保存或重复提交状态；
- state commit 后崩溃能识别已完成提交；
- cancel/commit 并发不会产生半提交；
- 重复 accept、resume、cancel、rollback 均幂等或明确冲突；
- 未分类恢复失败为 0。

**依赖**：Wave 2、Wave 3、Wave 4。

### Wave 6：并发 Eval、真实 replay 与生产准入

**目标**：用可回放证据证明并发治理没有破坏统一主链路的生成和事务语义。

**任务**：

1. 将下方 Eval 矩阵落为自动化测试与跨进程脚本；
2. 对至少两个 workspace、两个 batch job、同章双候选执行真实 replay；
3. 归档每个样例的 trace、事件流、state snapshot、receipt；
4. 检查生产 `dist/` 依赖边界，不允许评测/legacy 逻辑进入生产提交路径；
5. 生成并发稳定性报告，记录首次成功率、冲突率、自动恢复成功率和未分类失败；
6. 通过生产闸门后物理替换旧锁/旧保存实现，不保留双生产路径。

**依赖**：Wave 0–5 全部完成。

## 6. 最小 Eval 矩阵

| 场景 | 必须证明 |
|---|---|
| 两个 batch job 同时启动 | 只有一个获得同一 workspace 的提交权 |
| 两个进程同时获取锁 | 不会同时成功 |
| 锁文件损坏 | fail-closed 或明确接管，不静默双写 |
| PID 已退出但租约未过期 | 能识别可恢复僵尸锁 |
| PID 复用 | 不会误认旧 owner |
| heartbeat 失败 | 不会无限假装持锁 |
| 两个任务同时更新 BatchJobState | 一个成功，一个得到 revision conflict |
| 两个任务提交同一章节 | 只有一个成功 |
| 第 N 章 checkpoint | 第 N+1 章不执行正式生成/提交 |
| 第 N 章审批未完成 | frontier 不推进 |
| 用户重复 accept | 幂等，不重复副作用 |
| accept 与 rollback 并发 | 只有合法顺序的一方成功 |
| 生成期间 release pointer 改变 | 提交时检测 stale release |
| 生成期间 CreativeConstitution 改变 | 提交阻断或重新编译上下文 |
| 预生成候选基于旧状态 | 不得直接提交 |
| chapter save 后崩溃 | 重启不重复保存或重复提交状态 |
| state commit 后崩溃 | 重启正确识别已完成 |
| cancel 与 commit 并发 | 先后关系明确，不产生半提交 |
| 不同 workspace 并行 | 互不污染 |
| 只读 Review 与提交并行 | Review 不获取提交锁，也不阻塞提交 |

## 7. 统一验收指标

以下指标全部达到，才允许把本计划标记为生产完成：

- 同一 workspace 同时存在两个正式提交者：`0`；
- 同一章节重复正式提交：`0`；
- stale revision 越过率：`0`；
- 批量任务越过 checkpoint/approval 阻断章节：`0`；
- lock owner 不明时继续写入：`0`；
- 并发状态覆盖：`0`；
- 重复用户操作产生重复副作用：`0`；
- 正式提交缺少 commit receipt：`0`；
- 不同 workspace 状态污染：`0`；
- 未分类失败：`0`；
- 真实 replay trace 留存率：`100%`；
- 自动恢复后成功率：目标 `≥ 85%`。

## 8. 变更边界与禁止事项

本计划执行期间不得：

- 取消同一 workspace 的 frontier 串行约束；
- 用“预生成完成”越过未确认章节；
- 把锁文件存在/删除当作提交事实；
- 通过简单覆盖解决 CAS 冲突；
- 在提交队列外直接写正式正文或 NarrativeState；
- 让 parser/schema 错误触发无边界正文重写；
- 为并发改造重新引入 legacy Stage0–8、one-shot raw 或生产文学 judge；
- 建立新旧两套生产并发实现长期并存；
- 在未完成真实 replay 前以“build/test 通过”宣称并发治理完成。

## 9. 推荐分派顺序

建议按以下顺序安排开发执行：

1. Wave 0：基线与契约负责人；
2. Wave 1：锁/文件原子性负责人；
3. Wave 2：状态存储/CAS 负责人；
4. Wave 3：队列与提交边界负责人；
5. Wave 4：候选/审批/revision 负责人；
6. Wave 5：恢复与命令幂等负责人；
7. Wave 6：Eval/replay/生产验收负责人。

每个工作包交付时必须同时提交：实现、单元/集成测试、失败场景证据、trace 样例和对下一波次的接口说明。任何波次若发现现有事件事实源不足，应先补齐事件/receipt 契约，再继续实现，不允许用临时文件覆盖来绕过架构边界。

## 10. 完成定义

本计划完成的标准不是“批量任务能运行”，而是：

> 模型可以自由并行准备候选；同一 workspace 的正式正文、NarrativeState 和 frontier 始终按唯一叙事顺序提交；所有重复操作、崩溃、锁丢失、状态冲突和过期候选都能被明确识别、拒绝或恢复，并留下可回放证据。

