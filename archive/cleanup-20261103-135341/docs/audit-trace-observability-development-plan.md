# PiNovelStudio：执行轨迹、可观测性与审计可见性开发计划

> 状态快照：2026-08-12  
> **总体：`Partial`（基础设施 + Phase 3 最小生产接线已落地；尚未成为唯一生产事实源）**

权威实现索引见：`.pi/extensions/novel-studio/docs/audit-event-inventory.md`。

## 状态总表

| 范围 | 状态 | 说明 |
|---|---|---|
| Phase 0 事件契约 | 已验证 | 类型/schema/hash/兼容映射 |
| Phase 1 FailureEnvelope 统一 | 已验证 | 因果字段 + failure_recorded |
| Phase 2 追加存储与恢复 | 已验证 | JSONL + 崩溃截断 + 孤儿父检测 |
| Phase 3 主链路接线 | **最小切片已验证** | run 生命周期 + 顶层失败；工具/候选/门禁未接 |
| Phase 4–7 | 未完成 | Artifact/投影/Eval/旧写清理 |

**不要宣称**「执行轨迹系统已完成」或「AuditEvent 已是唯一生产事实源」。  
当前生产仍并行写 `TrajectoryStore` / `quality-trace.json` / legacy adapter。

## 已完成

### Phase 0：契约冻结
- `v2/core/audit/audit-event-types.ts` — AuditEvent / 枚举 / 空值规则
- `v2/core/audit/audit-event-schema.ts` — 校验与工厂
- `v2/core/audit/audit-event-ids.ts` — traceId/runId/eventId
- `v2/core/audit/content-hash.ts` — SHA-256 UTF-8
- `v2/core/audit/legacy-trace-compat.ts` — 旧结构只读映射 + LEGACY_FIELD_COMPAT_MAP
- 事件生产点清单：`docs/audit-event-inventory.md`

### Phase 1：FailureEnvelope 统一
- `buildProductionFailureEnvelope` 写入 `eventId` / `parentEventId` / `causedByEventId` / `attempt` / `maxAttempts`
- `toUnifiedFailureEnvelope` 透传因果字段
- `productionFailureToAuditEvent` 转为 `failure_recorded`
- TrajectoryFailureEnvelope 标注为只读兼容 + 可选因果字段

### Phase 2：追加式存储与恢复
- `AuditEventStore` — JSONL append + fsync；内存/持久化双模式
- `recoverEventsJsonl` — 截断损坏尾行，不覆盖已确认事件
- `diagnoseTraceCompleteness` — 重复 id / sequence / 孤儿父 / 工具授权覆盖
- 空 store 首条必须 `run_started`；孤儿 parent 拒绝
- 测试：`tests/audit-event-store.test.mjs`

### Phase 3：最小生产接线 + 模型/工具细事件
- `AuditRunSession` — 持有 store，保证 start/terminal/failure_recorded
- `runUnifiedPipeline`（非 eval）创建 session，`seal()` 包装所有返回
- 未捕获异常 → `run_interrupted` + 结构化 blocked
- `stageResults.auditRun` 暴露 traceId/runId/eventsPath/completeness
- **`persisted` 语义修正**：仅当 `persist && path && writeError==null` 才为 true
- `AuditEventSink` 窄接口：
  - `wrapModelFn` → `model_turn_started/completed/failed`
  - runtime `beforeToolCall` → `tool_call_requested/authorized/denied`
  - tool-metrics-tracer → `tool_call_started` + `tool_result_received|timeout`
- 产品级测试：`tests/audit-run-pipeline-integration.test.mjs`
- preview 模式：审计仅内存（`persisted=false`）
- **正文保存 vs 状态提交分离事件（本轮）**
  - `commitAndSave` 写入：
    - `chapter_save_attempted` / `chapter_saved` / `chapter_save_failed`
    - `state_commit_attempted` / `state_committed` / `state_commit_failed`
    - `final_submission`（同时带 `chapterSaveOk` + `stateCommitOk`，禁止互相伪装）
  - 状态失败回滚正文后：`final_submission.chapterSaveOk=false && stateCommitOk=false`
  - 测试：`tests/audit-commit-save-events.test.mjs`
- **代理审批最终化路径（本轮补齐）**
  - `handleChapterProxyFinalization` 创建 `AuditRunSession` 并注入 `orchestratorInput.auditSink`
  - `accept / accept_with_edits` 经 `commitAndSave` 写同一 `events.jsonl`
  - 返回 `auditRun` 摘要（与主链路同形）
  - 无 `stagedStateUpdate`：`state_commit_attempted` 使用 `status=skipped` + `noop=true`，不冒充 `state_committed`
  - 测试：`tests/chapter-proxy-finalization-handler.test.mjs` accept 断言 events.jsonl 含 save/final_submission
- **审计风险修补（本轮）**
  1. accept/accept_with_edits：审计会话创建失败 → fail-closed 阻断正式提交（`audit_session_unavailable`），禁止无审计提交
  2. handler 外层异常 → `finalizeInterrupted`，避免缺终止事件
  3. 无 stagedStateUpdate：`final_submission.payload.stateCommitOutcome = "skipped"`（failed/committed 同理），避免统计把 no-op 当真实状态提交
  4. finalization feedback 补齐完整 lineage，恢复策略摄入（incomplete_lineage 回归修复）

## 未完成（按序）

| Phase | 内容 |
|------|------|
| 3 续 | 候选/门禁、修复/重试细事件（保存 vs 状态提交已接入） |
| 4 | Artifact manifest / 脱敏扫描 |
| 5 | quality-trace 投影 / Review Surface 审计视图 |
| 6 | 10 场景最小轨迹 Eval |
| 7 | 删除旧写路径，只保留只读适配 |

## 非目标（不变）

- 不评价文学质量；不保存思维链；不双写生产模式；不把派生指标当事实。
