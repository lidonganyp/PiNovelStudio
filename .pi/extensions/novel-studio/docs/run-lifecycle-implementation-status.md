# 统一运行生命周期 — 实现状态（2026-08-14）

## 目标

```text
RunAggregate + Audit Event Stream + Projections
```

## 当前状态（核验结论，2026-08-13 第三次核验）

> 核心架构已落地，P0 阻断已关闭，P8 事务边界矩阵已完成基础验证；P6、P7 及部分 P8 仍开放，暂不具备 §7 最终完成资格。

## 阶段状态

| 阶段 | 状态 | 交付 |
|---|---|---|
| P0 基线盘点 | **DONE** | `docs/run-lifecycle-p0-inventory.md` |
| P1 领域契约 | **DONE** | `v2/core/run/run-aggregate-types.ts` + reducer + errors + legacy adapter |
| P2 事件流与重放 | **DONE** | repository（先事件后物化）+ projections 可重建 |
| P3 编排器/恢复接入 | **DONE（主路径）** | `AuditRunSession` 折叠聚合；checkpoint_saved / commit_started 接线 |
| P4 审批/pending | **DONE（主路径）** | `approval_requested` 于 proxy 落盘后；finalization 写 user_* + commandId |
| P5 提交幂等 | **DONE（P0 修复）** | `commitIntentId` 磁盘账本 + 聚合门禁；重复调用不写正文/不发 final_submission |
| P6 补偿/证据 | **PARTIAL** | `compensation-run.ts` + `evidence-governance.ts` + 治理桥 `revokeEvidenceWithLearningRecompute`（`evidence_revoked` → ledger revoke → strategy-policy 投影重建）已存在。生产 `handleStrategyFeedback` revert 路径已改为「写账本 revoke + 由账本重算被撤销策略信誉」（`recomputeStrategyReputationFromLedger`，账本为唯一真相源、policy 仅投影）。**仍开放**：该路径未发射 audit `evidence_revoked` 事件（审计流侧统一接线未做，属 P7+ 摄入侧） |
| P7 旧真相源清理 | **PARTIAL（Stage D 完成）** | 聚合 `approvalState` 已守护提交；文件 sentinel 仍作双源 fail-closed；生产 revert 路径已写账本 revoke（`appendPublicFeedbackLedgerRevoke`）。**Stage A/B/C/D 已落地**：Stage A 双写（`failure_recorded` / `gate_evaluated` / `trajectory_flushed`）；Stage B 读侧投影（`rebuildQualityTraceFromEvents` / `rebuildTrajectoryFromEvents` + R1-R6 投影优先）；Stage C 写侧收口（`resolveTraceWriteMode` / `resolveTrajectoryWriteMode` 默认 projection + legacy 强制回退）；Stage D 旧文件收敛为投影缓存（quality-trace.json 物化 failureEnvelopes+gates；trajectory.jsonl 收敛单行摘要 + 完整明细进 content store；coverage gate 读点迁移 `getDetailOutputPath()`）+ **删除前验收**（`p7-stage-d-projection-cache-acceptance.test.mjs` 3/3）。**仍开放**：真实子进程 SIGKILL 注入（P8）、re-FactGuard 编排接线（P8）、旧独立写路径的最终物理删除与历史数据迁入内容库（发布收口） |
| P8 故障注入验收 | **PARTIAL** | 三类事务边界崩溃/重启（正文保存前/后、状态提交后）已由 `run-lifecycle-crash-matrix.test.mjs` 覆盖；JSONL 尾行损坏由 `audit-event-store.test.mjs` 覆盖；用户编辑旧稿 → `STALE_REVISION`（旧 approval 不可复用）由 `run-aggregate-contract.test.mjs` 覆盖；§6 场景 6（重复 accept commandId 幂等）与 12（删除投影重建）由 `run-lifecycle-fault-injection-matrix.test.mjs` 覆盖；并发/重启重复 `commitIntentId`（崩溃于账本写盘前，事件流恢复聚合单独提供幂等 + hash 绑定）由 `run-lifecycle-concurrent-commit-intent.test.mjs` 覆盖。**未验证/未接**：① 现有故障模拟是事件流/仓储/文件级（尾行损坏 + 停止追加），非真实子进程 SIGKILL 注入；② re-FactGuard 跨模块重触发（编排层）未接 |

### P0 阻断修复（核验后）

| 问题 | 修复 |
|---|---|
| `commitIntentId` 不保护写盘 | `commitAndSave` 查聚合 completed + `chapter-approvals/{chapterId}.commit-intents.json` 账本，命中则 `idempotent:true` 且 0 次 `chapter_saved` |
| `commitIntentId` hash 未绑定 | 磁盘账本存 `artifactHash`；相同 commitIntentId + 不同正文 → `ARTIFACT_HASH_MISMATCH`（拒绝覆盖，非幂等） |
| 仅文件 pending 决定提交 | 双源：`getLifecycleGate().approvalState` **或** `hasPendingProxyDraft`；聚合 pending 即使 sentinel 丢失也阻断 |
| fold 失败仍可提交 | `foldError` → fail-closed 阻断 `commitAndSave` |
| trust-audit-bridge 绕过 fold → `SEQUENCE_GAP` 误阻断正常生成 | bridge 走 `store.append` 后回调 `onEventAppended` 同步折叠；session `foldAppended` 加 SEQUENCE_GAP 自愈（`recoverFromEvents` 重放兜底） |

### 生产回归核验（2026-08-13 第二次核验后）

- `phase2-preflight-integration.test.mjs` + `phase5-unified-default-path.test.mjs` 均绿（foldError 回归已消除）
- `commit-intent-idempotency-approval-gate.test.mjs` 6/6 绿（含新增 hash-mismatch 用例：相同 commitIntentId + 不同正文 → `ARTIFACT_HASH_MISMATCH`）
- `run-lifecycle-crash-matrix.test.mjs` 3/3 绿（正文保存前/后、状态提交后三类崩溃→重启→恢复）
- `run-lifecycle-evidence-learning-bridge.test.mjs` 3/3 绿（`evidence_revoked` → ledger revoke → 策略信誉投影重建 + 孤儿复位 + 幂等）
- `run-aggregate-contract.test.mjs` 新增用户编辑旧稿 2 用例（旧 revision 复用 → `STALE_REVISION`；升版 → `modified`）
- `public-strategy-feedback-ledger-e2e.test.mjs` 新增 revert 用例：撤销写账本 revoke（`targetEvidenceId` 对齐观测）、policy 账本重算回弱先验、重复撤销幂等
- `run-lifecycle-fault-injection-matrix.test.mjs` 新增 2 用例：§6 场景 6（重复 accept commandId → `DUPLICATE_COMMAND_ID` 幂等）+ 场景 12（删除投影 → `rebuildProjectionsFromAggregate` 重建一致）
- 全量测试：**3334 tests / 3328 pass / 6 skipped / 0 fail**（含 Stage D 删除前验收 `p7-stage-d-projection-cache-acceptance.test.mjs` 3/3）

## 模块索引

```text
v2/core/run/
  run-aggregate-types.ts
  run-aggregate-errors.ts
  run-aggregate-reducer.ts
  run-aggregate-repository.ts
  run-projections.ts
  recovery-lifecycle-adapter.ts
  evidence-governance.ts
  compensation-run.ts
  index.ts
```

生产闭包入口 re-export：`v2/core/unified-entry.ts`  
会话折叠：`v2/core/audit/audit-run-session.ts`

## 测试

```bash
cd .pi/extensions/novel-studio
npx tsc -p tsconfig.prod.json
node --import ./tests/setup-test-env.mjs --test \
  tests/run-aggregate-contract.test.mjs \
  tests/run-aggregate-repository.test.mjs \
  tests/run-lifecycle-session-fold.test.mjs \
  tests/run-lifecycle-compensation-evidence.test.mjs \
  tests/audit-event-store.test.mjs
```

## 仍未宣称完成的最终条件（§7 剩余阻断）

计划 §7「最终完成定义」中，下列项仍开放，暂不具备 §7 最终完成资格：

1. **P7 — quality-trace / TrajectoryStore 已收敛为可重建投影缓存（Stage D 完成），但旧独立写路径的最终物理删除尚未执行。** quality-trace.json 现为审计流物化缓存（`materializeProjectionCache` 重建 failureEnvelopes + gates）；trajectory.jsonl 现为单行摘要缓存，完整明细进 `trajectory-content.jsonl` 内容库；coverage gate 读点已迁移 `getDetailOutputPath()`。删除前验收（`p7-stage-d-projection-cache-acceptance.test.mjs`）已证明文件 == 投影重建结果、legacy 强制回退可逆。仍开放：旧独立写路径的物理删除、历史数据迁入内容库（发布收口，任务 #26）；pending sentinel 仍 fail-closed 使用文件。
2. **P6 — 账本驱动的信誉重算已接，但审计流 `evidence_revoked` 事件尚未统一发射。** 生产 `handleStrategyFeedback` revert 路径现已「写账本 revoke → `recomputeStrategyReputationFromLedger` 由账本重算被撤销策略信誉」，账本为唯一真相源、`strategy-policy.json` 仅为可重建投影。仍开放的是审计流侧：revert 路径未向 `AuditEventStore` 发射 `evidence_revoked` 事件（治理桥 `revokeEvidenceWithLearningRecompute` 已实现该事件 → ledger revoke → 投影重建，但生产 feedback handler 不在 AuditRunSession 作用域内，摄入侧统一接线属 P7+）。
3. **P8 — 并发重复 `commitIntentId` 已由事件流恢复验收，但真实子进程退出注入仍未做。** 三类崩溃/重启、JSONL 尾行损坏（`audit-event-store.test.mjs` 尾行截断恢复）、STALE_REVISION、重复 accept commandId 幂等、删除投影重建均已覆盖；并发/重启重复 `commitIntentId`（崩溃于磁盘账本写盘前，`run-lifecycle-concurrent-commit-intent.test.mjs` 验证事件流恢复的聚合单独提供幂等 + `ARTIFACT_HASH_MISMATCH` 绑定）也已覆盖。剩余未做的是**真实子进程 SIGKILL 注入**（当前均为事件流/仓储/文件级模拟：停止追加 + 尾行损坏，非跨进程残留状态的真实退出）。
4. **用户编辑旧稿后的 re-FactGuard 尚未接入（编排层）。** 旧稿升版后需跨模块重触发 FactGuard 校验的编排接线仍开放。

## 约束遵守

- 未新增文学评分或第二套生成链路
- 未恢复 legacy Stage0-8
- 未删除审计历史实现 rollback
- 单一生产主链路：`novel_generate_chapter` → unified pipeline
