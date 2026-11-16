# 提示注入信任架构 Wave 0 基线盘点

**任务**：PROMPT-INJECTION-TRUST-ARCHITECTURE-1  
**日期**：2026-08-12  
**范围**：只读盘点 + 契约冻结；未恢复/删除/覆盖用户既有脏工作树

## 1. 生产边界清单

| 边界类型 | 位置 | 现状 | 本计划动作 |
|---|---|---|---|
| 上下文拼接点 | `v2/core/context-safety.ts`、`context-compiler.ts` | 有 P0–P4 预算与冲突阻断；缺统一 trustClass/slot | 扩展 manifest + ContextPackage 分槽 |
| 工具结果消费 | `novelos/tools/tool-protocol.ts`、`narrative-tool-registry.ts` | sourceRef/evidenceLevel 已有；缺 contentTrust 闸门 | TrustedToolResult + 消费闸门 |
| 工具注册 | `narrative-tool-registry.ts` | 已拒绝 `final_commit` 与白名单外工具 | 保持；测试矩阵覆盖 |
| 状态写入 | `v2/core/final-state-commit.ts`、`memory/*` | 最终正文后提交；缺事实晋级状态机 | FactPromotion 流水线 |
| 审批入口 | `v2/governance/action-approval-receipt.ts`、`autonomy-policy.ts` | 已有 hash/actor/审批对象；模型确认已忽略 | 绑定 user-revision 失效与审计 |
| 反馈入口 | `v2/learning/feedback-evidence-contracts.ts`、`user-feedback-ingestor.ts` | next-request-only 已部分落地 | 信任分类 + 安全敏感拒绝 |
| Review Surface | `review-artifact-schema.ts`、`review-surface-cli.ts` | 只读/未知 schema 降级已有 | 脱敏 + 证据层展示契约 |
| 审计 | `v2/core/audit/*` | AuditEvent 已冻结 | 追加 TrustAuditEvent 决策链 |

## 2. 数据流（目标）

```text
来源分层 → 指令/资料分槽 (ContextPackage)
        → 受限上下文编译 (ContextSafety)
        → 工具结果分级 (TrustedToolResult)
        → FactGuard / 事实验证
        → 候选隔离 (UNTRUSTED_DRAFT)
        → 用户显式确认 + approval hash 绑定
        → FinalStateCommit + 原子保存
        → 追加式 TrustAuditEvent + 安全 Eval
```

## 3. 未授权动作矩阵（测试可读）

实现：`v2/core/trust/authority-matrix.ts` → `listAuthorityMatrix()` / `sourceMayAffectStage()`

关键拒绝：

- `model_output` → `state_commit` / `security_boundary` / `hard_gate` = false
- `reference_material` → `chapter_intent` / `hard_gate` = false
- `user_feedback` → `fact_guard` / `security_boundary` = false
- `system_rule` → 可形成硬约束

## 4. 迁移策略（冻结）

- 单一最新 schema：`pinovel.context-package/1.0`、`pinovel.trust-audit-event/1.0`
- 旧 ConstraintManifest 单向映射到 TrustMetadata；不维护长期双写
- 历史缺来源数据降为 `retrieved_reference`，不猜测提升

## 5. 新增模块

```text
v2/core/trust/
  trust-types.ts
  authority-matrix.ts
  context-package.ts
  tool-result-trust.ts
  fact-promotion.ts
  user-revision.ts
  review-surface-safety.ts
  trust-audit.ts
  index.ts
```

## 6. Eval

`tests/prompt-injection-trust-architecture-eval.test.mjs` 覆盖计划 §7 全部 20 项。
