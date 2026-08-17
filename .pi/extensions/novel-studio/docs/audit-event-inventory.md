# 统一生产事件：事件生产点清单与兼容映射

> Phase 0 交付物。事实源以 `v2/core/audit/*` 与 `v2/core/failure-envelope.ts` 为准。

## 1. 唯一生产事件模型

| 项 | 路径 |
|---|---|
| 类型/枚举 | `v2/core/audit/audit-event-types.ts` |
| 校验/工厂 | `v2/core/audit/audit-event-schema.ts` |
| 追加式存储 | `v2/core/audit/audit-event-store.ts` |
| 崩溃恢复 | `v2/core/audit/audit-event-recovery.ts` |
| 完整性诊断 | `v2/core/audit/audit-event-validator.ts` |
| 内容 hash | `v2/core/audit/content-hash.ts` |
| 旧结构只读映射 | `v2/core/audit/legacy-trace-compat.ts` |
| 统一失败信封 | `v2/core/failure-envelope.ts` |
| 失败分类 | `v2/core/failure-types.ts` |

存储路径：

```text
workspaces/{workspaceId}/traces/{runId}/events.jsonl
workspaces/{workspaceId}/traces/{runId}/artifacts/   # Phase 4
workspaces/{workspaceId}/traces/{runId}/review-package.json  # Phase 5
```

## 2. 旧字段兼容映射（只读）

详见代码常量 `LEGACY_FIELD_COMPAT_MAP`。摘要：

| 旧字段 | 新字段 |
|---|---|
| `craft.severity=soft` | `failureClass=recoverable` |
| `craft.severity=hard_block` / `hard` | `failureClass=blocked` |
| `TrajectoryFailureEnvelope.severity` | `failureClass`（`mapLegacyFailureClass`） |
| `UnifiedFailureEnvelope.severity` | 仅兼容；生产真相=`failureClass` |
| `trajectory.type=session_start` | `run_started` |
| `trajectory.type=failure` | `failure_recorded` |
| `trajectory.type=tool_event` | `tool_result_received`（派生） |
| `quality-trace.failureEnvelopes[]` | `failure_recorded` 投影 |
| `quality-trace.gates[]` | `gate_evaluated` 投影 |

**生产禁止**：写入 `soft` / `hard` / `hard_block` 作为 `failureClass`。

## 3. 事件生产点清单（接线目标）

### 3.1 已具备（契约层 + Phase 3 最小接线）

| 点 | 状态 | 说明 |
|---|---|---|
| `AuditEvent` 契约 | DONE | Phase 0 冻结 |
| `buildProductionFailureEnvelope` | DONE | 含 eventId/parent/causedBy |
| `productionFailureToAuditEvent` | DONE | 失败→事件 |
| `AuditEventStore.append` | DONE | 追加 JSONL + sequence |
| 崩溃尾行恢复 | DONE | `recoverEventsJsonl` |
| Trajectory 只读映射 | DONE | `mapTrajectoryEntriesToAuditEvents` |
| `AuditRunSession` | DONE | Phase 3 会话封装 |
| `runUnifiedPipeline` 生命周期 | DONE（最小） | `run_started` + 终止 + `failure_recorded` |
| `stageResults.auditRun` | DONE | 暴露 path / completeness |
| 产品级落盘断言 | DONE | `tests/audit-run-pipeline-integration.test.mjs` |

### 3.2 主链路接线（Phase 3 续，待做）

| 生产点 | 文件（预期） | 事件 | 状态 |
|---|---|---|---|
| 入口开始/结束 | `v2/core/unified-entry.ts` | `run_started` / `run_finished` / `run_failed` | DONE（最小） |
| Preflight 阻断 | `unified-entry.ts` | `failure_recorded` (via seal) | DONE（经 seal） |
| 顶层 catch | `unified-entry.ts` | `run_interrupted` + `failure_recorded` | DONE |
| 上下文编译 | `context-compiler.ts` / orchestrator | `context_compile_*` | TODO |
| 模型回合 | `unified-orchestrator.ts` / model adapter | `model_turn_*` | TODO |
| 工具授权与结果 | `novelos/agent/*` / tool runtime | `tool_call_*` | TODO |
| Agentic 候选 | `agentic-raw-candidate-source.ts` | `candidate_created` | TODO |
| FactGuard / StoryPreservation | `orchestrator-factguard.ts` 等 | `gate_evaluated` / `candidate_blocked` | TODO |
| 风格优化失败 | style optimizer 路径 | `failure_recorded` / `candidate_blocked` | TODO |
| 修复轮 | repair / patch | `repair_*` / `retry_scheduled` | TODO |
| 代理审批 | governance proxy approval | 用户/治理事件 | TODO |
| 用户修改/接受 | finalization handlers | `user_*` | TODO |
| 正文保存 | `orchestrator-commit-save.ts` | `chapter_save_*` | DONE |
| 状态提交 | `orchestrator-commit-save.ts` | `state_commit_*` | DONE |
| 最终提交 | `orchestrator-commit-save.ts` | `final_submission`（绑定 hash + 双结果） | DONE |
| 代理审批定稿 accept/accept_with_edits | `handlers/chapter-proxy-finalization-handler.ts` | 注入 auditSink → 同上 persistence 事件 | DONE |
| 恢复 checkpoint | `recovery-checkpoint.ts` | `checkpoint_*` / `run_recovered` | TODO |
| RunAggregate 契约 | `v2/core/run/*` | 事件重放物化 | DONE（P1–P3：类型+reducer+repository+session fold） |
| 生命周期扩展事件 | audit-event-types | `stage_started` / `retry_reserved` / `approval_requested` / `commit_started` / `commit_failed` / `evidence_revoked` / `state_recomputed` / `compensation_started` | DONE（字典冻结 + 主路径接线） |
| 会话折叠 RunAggregate | `audit-run-session.ts` | 每 append 后 fold；seal 注入 `runAggregate` | DONE |
| checkpoint_saved 接线 | `unified-orchestrator.ts` | recovery checkpoint 落盘后 | DONE |
| approval_requested 接线 | `orchestrator-proxy-approval.ts` | pending draft 落盘后 | DONE |
| user_* + commandId | `chapter-proxy-finalization-handler.ts` | finalization 副作用前 | DONE |
| commit_started | `orchestrator-commit-save.ts` | commitIntentId + hash 绑定 | DONE |
| compensation / evidence API | `compensation-run.ts` / `evidence-governance.ts` | 新 run 补偿 + evidenceId 撤销 | DONE（API；learning 全链路待接） |
| 实现状态总表 | `docs/run-lifecycle-implementation-status.md` | P0–P8 进度 | DONE |

### 3.3 现有旁路写入（迁移前只读兼容）

| 旁路 | 文件 | 迁移策略 |
|---|---|---|
| TrajectoryStore 整文件重写 | `novelos/trajectory/trajectory-store.ts` | Phase 7 删除写入；期间可双读 |
| QualityTraceRecorder | `craft/quality-trace-recorder.ts` | Phase 5 改为投影 |
| LegacyTraceAdapter | `v2/adapters/legacy-trace-adapter.ts` | 只读/投影 |
| craft FailureEnvelope | `craft/failure-envelope.ts` | 只读映射，禁止新生产写 soft/hard_block 语义 |

## 3.4 RunAggregate 生命周期（P0/P1）

权威盘点：`docs/run-lifecycle-p0-inventory.md`。

- 实现：`v2/core/run/run-aggregate-types.ts`、`run-aggregate-reducer.ts`、`run-aggregate-errors.ts`
- 生产闭包入口 re-export：`v2/core/unified-entry.ts`
- 测试：`tests/run-aggregate-contract.test.mjs`
- 原则：事件流唯一事实源；聚合可重放；checkpoint/pending/latest 为投影

## 4. Hash 规则（Phase 0 冻结）

- 算法：SHA-256
- 文本编码：UTF-8
- 事件字段：完整 64 位 hex（`inputHash` / `outputHash` / `contentHash`）
- 短前缀仅展示，不得作审计主键
- 实现：`v2/core/audit/content-hash.ts`

## 5. 脱敏规则（Phase 4 实现，Phase 0 约定）

扫描并剥离/遮罩：

- API key / Bearer token / 环境变量形态密钥
- `<think>` 块
- 内部系统提示词全文
- 未授权原始工具参数

原则：**事件 hash 基于真实内容；脱敏只影响展示文本，不可与 hash 混淆。**

## 6. Artifact 引用规则

- 事件只存 `artifactRefs` + hash
- 正文 / 候选 / 完整工具结果进 `artifacts/`
- Review Package 只含脱敏摘要

## 7. 退出条件对照（Phase 0–2）

| 条件 | 状态 |
|---|---|
| 生产只认可一个标准事件模型 | 契约已冻结；主链路接线前旧写路径仍在 |
| 新代码不得新增旧 FailureEnvelope 字段 | 新字段只加在统一信封 + AuditEvent |
| 字段有明确事实含义与空值规则 | `AUDIT_NULL_RULES` |
| 失败含 eventId/因果/attempt | `buildProductionFailureEnvelope` |
| 追加式 JSONL + 恢复 | `AuditEventStore` + `recoverEventsJsonl` |
