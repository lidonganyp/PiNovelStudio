# 统一运行生命周期 P0：基线盘点与契约冻结

> 日期：2026-08-13  
> 状态：P0 冻结交付  
> 范围：生产主链路（`novel_generate_chapter` → unified pipeline）；不新增文学评分/生成旁路。

## 1. 目标架构（冻结）

```text
一个 RunAggregate
+ 一条追加式 Audit Event Stream（AuditEventStore JSONL）
+ 多个可重建 Projection
```

原则：

| 原则 | 含义 |
|---|---|
| 事件是不可变事实 | 只追加，不改写历史事件 |
| 聚合由事件重放得到 | `RunAggregate` 不是权威真相源，是物化缓存 |
| checkpoint / pending / latest.json | 派生投影，可删除后重建 |
| 禁止「文件存在即状态」 | 任务状态只能来自聚合/事件 |
| 五类状态分离 | Workflow / Artifact / Approval / Narrative / Learning |
| 单一生产主链路 | 迁移期不并行第二套生命周期 |

## 2. 状态写入/读取清单（生产相关）

### 2.1 事实源（Fact）候选 → 目标归属

| 写入点 | 当前路径 | 当前身份 | 目标身份 | 权威修改者 |
|---|---|---|---|---|
| AuditEvent JSONL | `workspaces/{id}/traces/{runId}/events.jsonl` | **事实源（部分接线）** | **唯一追加式事实源** | orchestrator / recovery / governance |
| RecoveryStateMachine | 进程内 `transitionHistory[]` | 局部内存真相 | 事件投影 | orchestrator |
| RecoveryCheckpoint | `recovery-checkpoints/{chapterId}.{id}.json` + `{chapterId}.latest.json` | 局部文件真相 | 投影（checkpoint-index） | recovery |
| Proxy pending sentinel | `chapter-approvals/{chapterId}.pending.json` | 局部文件真相（`hasPendingProxyDraft` 用存在性判断） | `approvalState=pending` 投影 | governance / user |
| Proxy draft | `chapter-approvals/{chapterId}.{approvalId}.draft.json` | 审批稿 artifact | Artifact 投影 + artifactHash 绑定 | governance |
| Chapter body | `chapters/{chapterId}.md` | 正文产物 | Artifact 活动版本（revision/hash） | commit 事务 |
| NarrativeStateStore | `narrative-state-store.json` | 叙事状态事实 | Narrative State（仅 final commit） | final-state-commit |
| Pre-commit state backup | `chapter-approvals/{chapterId}.pre-commit-state-*.json` | 回滚辅助 | 补偿运行证据 | commit / rollback |
| Quality trace | `traces/{chapterId}-quality-trace.json` | 旁路写入 | 只读投影（trace-summary） | audit projection |
| TrajectoryStore | `novelos/trajectory/*` | 旁路写入 | 只读兼容，禁止新生产写 | legacy compat |
| Strategy policy | `strategy-policy.json` | 学习证据派生 | Learning 投影（evidenceId 可撤销） | evidence governance |
| Feedback ledger | learning feedback stores | 学习证据 | Learning（原始保留 + revoke） | feedback pipeline |
| Action approval receipt | governance receipts | 治理收据 | Approval 绑定证据 | governance |
| Batch job store | batch-generation-job-store | 批任务状态 | 不进入本章 run 聚合（边界外） | batch orchestrator |

### 2.2 关键读取路径（当前仍依赖文件存在性）

| 读取点 | 文件 | 问题 |
|---|---|---|
| `hasPendingProxyDraft` | `{chapterId}.pending.json` | **文件存在/可解析 → 阻断提交**（P4 须改为读聚合 `approvalState`） |
| `loadLatestRecoveryCheckpoint` | `{chapterId}.latest.json` | 指针文件缺失即视为无 checkpoint |
| `commitAndSave` 章节存在性 | `chapters/{id}.md` | 用于回滚备份，可保留为产物 I/O，但不得单独推断 run 终态 |
| Finalization rollback | chapter + pre-commit backup | 文件级回滚，非 compensation_run |

### 2.3 已接入 Audit 的生产点（基线）

来源：`docs/audit-event-inventory.md` + 代码核对。

| 点 | 状态 |
|---|---|
| `run_started` / terminal | DONE（最小） |
| `failure_recorded` | DONE |
| `chapter_save_*` / `state_commit_*` / `final_submission` | DONE |
| proxy finalization accept 路径 persistence | DONE |
| model/tool 细事件 | 部分 |
| checkpoint_* / approval_requested / commit_started | **缺失或未接** |
| RunAggregate 重放 | **不存在** |

## 3. 事件所有权表（P1 冻结）

### 3.1 既有 AuditEventType（保留）

见 `v2/core/audit/audit-event-types.ts`：run / context / model / tool / candidate / gate / save / commit / user / recovery。

### 3.2 本板块新增事件（P1 扩展，禁止业务模块私自加字段）

| eventType | actor | stage | 修改聚合字段 |
|---|---|---|---|
| `stage_started` | orchestrator | 对应 stage | workflowState, lastStage |
| `retry_reserved` | recovery | recovery | recoveryBudget |
| `checkpoint_saved` | recovery | recovery | workflowState=checkpoint, checkpointId |
| `checkpoint_resumed` | recovery | recovery | workflowState=running |
| `approval_requested` | governance | proxy_approval | approvalState=pending, approvalId, artifact* |
| `user_accepted` | user | user_revision | approvalState=accepted |
| `user_modified` | user | user_revision | approvalState=modified, artifactRevision 升版 |
| `user_rejected` | user | user_revision | approvalState=rejected |
| `commit_started` | orchestrator | final_submission | commitIntentId, workflowState=commit_pending |
| `commit_failed` | orchestrator | final_submission | terminal 或 blocked + envelope |
| `evidence_revoked` | governance | recovery/unknown | learning 有效集 |
| `state_recomputed` | system | state_commit | narrativeStateRevision |
| `compensation_started` | recovery | recovery | workflowState=compensation_run, parentRunId |

> 注：`user_accepted` / `user_modified` / `user_rejected` / `checkpoint_saved` / `checkpoint_resumed` 已在类型字典中；P1 补齐缺失项与 payload 契约。

### 3.3 三类幂等键

| 键 | 作用域 | 规则 |
|---|---|---|
| `eventId` | 全局 | 重复 append 拒绝 |
| `commandId` | 用户/治理命令 | 同 commandId 返回首次结果，无新副作用 |
| `commitIntentId` / `finalizationId` | 提交事务 | 同 id 只提交一次正文+状态 |

### 3.4 统一绑定字段（checkpoint / 审批稿 / 正文 / NarrativeState）

```text
runId, traceId, chapterId,
artifactRevision, artifactHash,
approvalId?, narrativeBaseRevision?,
commitIntentId?
```

## 4. 五类状态与工作流枚举（P1 冻结）

### 4.1 WorkflowState

```text
running
retryable_failure
retrying
checkpoint
interrupted
blocked
awaiting_approval   ← 新增（对齐 proxy pending）
commit_pending
committed
compensation_run    ← 新增（回滚不倒退旧 run）
```

迁移：`RecoveryLifecycleState` 作为适配层子集；`commit_pending` 与 proxy pending **不得**再分两套真相。

### 4.2 ApprovalState

```text
none | pending | accepted | modified | rejected | stale | cleared
```

### 4.3 Artifact / Narrative / Learning

- **Artifact**：`activeCandidateId`, `artifactRevision`, `artifactHash`, `supersededRevisions[]`
- **Narrative**：`narrativeStateRevision`, `narrativeBaseRevision`, `commitIntentId`
- **Learning**：`evidenceIds[]` 有效集；撤销写 `evidence_revoked`，不删原始反馈

### 4.4 合法转换（核心）

```text
running → retryable_failure | interrupted | awaiting_approval | commit_pending | blocked | checkpoint
retryable_failure → retrying | checkpoint | blocked
retrying → running | checkpoint | blocked | retryable_failure
interrupted → checkpoint | blocked
checkpoint → running (仅显式 resume) | blocked
awaiting_approval → commit_pending | blocked | running(reject regenerate)
commit_pending → committed | blocked
committed → ∅（终态；回滚启动新 compensation_run）
compensation_run → committed | blocked
blocked → ∅（需用户介入后新 run）
```

**硬规则**：`checkpoint | blocked | interrupted | committed` 不得自动 → `committed`（除 `commit_pending→committed`）；rollback 不把旧 run 从 `committed` 倒退。

## 5. 标准错误码（P1）

| code | 含义 |
|---|---|
| `STALE_REVISION` | 提交/审批 revision 落后于聚合 |
| `ARTIFACT_HASH_MISMATCH` | 正文 hash 与绑定不一致 |
| `DUPLICATE_EVENT_ID` | eventId 重复 |
| `DUPLICATE_COMMAND_ID` | command 幂等命中 |
| `DUPLICATE_COMMIT_INTENT` | commitIntent 已完成或进行中 |
| `SEQUENCE_GAP` | sequence 非严格 +1 |
| `ILLEGAL_TRANSITION` | 工作流非法转换 |
| `BUDGET_EXHAUSTED` | 恢复预算耗尽 |
| `APPROVAL_REQUIRED` | 未确认审批不可提交 |
| `ORPHAN_PARENT_EVENT` | parentEventId 不在本 run |
| `JSONL_TAIL_CORRUPT` | 事件流尾部损坏（可报告恢复） |
| `AGGREGATE_REPLAY_DIVERGENCE` | 物化状态与重放不一致 |

## 6. 测试场景清单（故障注入 / 验收矩阵种子）

来自计划 P8，P0 登记为 RED 清单：

1. 正文保存前进程退出 → 无章节文件或无新 revision；可从事件恢复为非 committed
2. 正文保存后、状态提交前退出 → 不重复保存；可补偿/恢复状态
3. 状态提交后退出 → 重放识别已完成；重复 commitIntent 无副作用
4. 模型超时 / schema 错误 → FailureEnvelope + recovery 事件
5. 预算耗尽 → 后续 model/tool 调用次数 = 0
6. 用户重复 accept → commandId 幂等
7. hash 不匹配 / stale revision → 放行率 0
8. 用户编辑旧稿 → 旧 approval 不可复用；须 re-FactGuard
9. pending 损坏 → fail-closed
10. rollback → compensation_run；evidence 按 evidenceId 撤销；成本/trace 保留
11. JSONL 尾部损坏 → 报告 + 可恢复，不静默
12. 删除 latest.json / pending 投影 → 可由事件流重建

## 7. 迁移边界

| 允许 | 禁止 |
|---|---|
| 在统一主链路内接线 RunAggregate | 新增文学评分或第二套生成链路 |
| 一次性适配层包装 `RecoveryLifecycleState` | 恢复 legacy Stage0-8 |
| 投影读写优先事件流 | one-shot raw 生产失败回退 |
| fail-closed 不确定历史状态 | 用新枚举掩盖真相源分裂 |
| 切换后删除适配层 | 删除审计历史实现 rollback |
| | 保留两套并行生产基线 |

**生产入口唯一**：`novel_generate_chapter` → `runUnifiedPipeline`。

## 8. P0 验收核对

- [x] 生产状态写入点可定位（§2）
- [x] 未登记真相源：本清单覆盖核心路径；batch/canary 边界外已标注
- [x] 不引入新并行生产链路
- [x] 事件/状态/错误码契约冻结（§3–§5）
- [x] 测试场景清单（§6）

## 9. 后续阶段入口

| 阶段 | 交付 |
|---|---|
| P1 | `run-aggregate-types` / reducer 契约 / 事件扩展 / 单元测试 |
| P2 | reducer 重放 + repository + 投影物化顺序 |
| P3 | orchestrator + recovery 接入 |
| P4 | approval/pending 投影统一 |
| P5 | CommitIntent + finalization 幂等 |
| P6 | compensation_run + evidence revoke |
| P7 | 旧真相源清理 |
| P8 | 故障注入矩阵 |

实现索引：`v2/core/run/*`（P1+）。
