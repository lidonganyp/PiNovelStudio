# 用户反馈证据管道运行手册

**任务**：USER-FEEDBACK-EVIDENCE-PIPELINE-1  
**日期**：2026-08-12

## 1. 查询策略暴露（exposure）

生成/风格优化阶段应在 quality-trace 中记录：

- `strategyContext.modelVersion`
- `selectedStrategyIds` / `exposureSnapshot.strategyIds`
- `strategyBundleId`（`bundle:a+b` 形式）
- `orchestratorRunId` / `candidateId` / `exposureId` / `promptBundleId`

公共反馈入口可通过 `handlers/strategy-feedback-trace-context.ts` 从 trace 恢复 model/strategy 元数据。

## 1.1 公共入口 `novel_strategy_feedback`

`handleStrategyFeedback` 现在要求完整 canonical lineage（可来自：

- 工具参数：`orchestratorRunId/candidateId/strategyBundleId/exposureId/promptBundleId`
- 或 `chapterId` 对应 quality-trace 的 `strategyContext`

缺失血缘时：

- `result.recorded = false`
- 不更新文学策略信誉
- 仍可写 ledger observation（`outcome=neutral`）供审计

成功路径会同时：

1. 更新 `strategy-policy.json`（物化缓存）
2. 追加 `workspaces/{id}/strategy-evidence/feedback-evidence-ledger.json`

## 1.2 历史 evidence 迁移 / 隔离

```bash
# dry-run（默认）：生成 quarantine 报告，不改文件
node scripts/migrate-strategy-evidence-lineage.mjs --workspace <id>

# 实际隔离：给缺血缘记录打 quarantined（不静默补全字段）
node scripts/migrate-strategy-evidence-lineage.mjs --workspace <id> --apply
```

## 1.3 真实 trace lineage 审计

```bash
# 扫描全部 workspaces 的 quality-trace
node scripts/audit-strategy-exposure-lineage.mjs

# 只扫某个 workspace
node scripts/audit-strategy-exposure-lineage.mjs --workspace xinmo
```

报告输出：`reports/feedback-lineage-audit/strategy-exposure-audit-*.json`

2026-08-12 实测：
- 历史 trace 多数 incomplete
- **xinmo ch22 新生成 complete=true**
- 真实反馈闭环报告：`reports/feedback-lineage-audit/USER-FEEDBACK-EVIDENCE-PIPELINE-1-real-audit.json`

```bash
# 真实章节生成（若 strict prod gate 指纹漂移，可临时 PINOVEL_DEV_MODE=1）
PINOVEL_DEV_MODE=1 node scripts/phase9-production-acceptance.mjs xinmo 22

# 审计 lineage
node scripts/audit-strategy-exposure-lineage.mjs --workspace xinmo

# 公共反馈入口 → ledger → policy
node scripts/real-feedback-pipeline-e2e.mjs xinmo 22
```

## 1.4 关键模块 focused coverage（可复核命令）

在 `.pi/extensions/novel-studio` 下执行：

```bash
node --experimental-test-coverage \
  --test-coverage-include="dist/v2/learning/user-feedback-ingestor.js" \
  --test-coverage-include="dist/v2/learning/strategy-policy-store.js" \
  --test-coverage-include="dist/v2/learning/feedback-evidence-ledger-store.js" \
  --test-coverage-include="dist/v2/learning/feedback-evidence-contracts.js" \
  --test-coverage-include="dist/v2/learning/strategy-reputation-recompute.js" \
  --test-coverage-include="dist/v2/learning/strategy-promotion-governance.js" \
  --test-coverage-include="dist/handlers/strategy-feedback-lineage.js" \
  --test-coverage-include="dist/v2/governance/chapter-proxy-approval-feedback-ingestor.js" \
  --import ./tests/setup-test-env.mjs --test \
  tests/phase6-online-learning.test.mjs \
  tests/user-feedback-attribution.test.mjs \
  tests/strategy-evidence-ledger-recompute.test.mjs \
  tests/feedback-ledger-production-path.test.mjs \
  tests/public-strategy-feedback-ledger-e2e.test.mjs \
  tests/evolution-release-governance-g7-feedback-ingestor.test.mjs \
  tests/strategy-promotion-governance.test.mjs \
  tests/feedback-pipeline-coverage-boost.test.mjs \
  tests/feedback-idempotency-limits.test.mjs \
  tests/feedback-rollback-transaction-boundary.test.mjs \
  tests/strategy-bundle-lineage.test.mjs \
  tests/public-tool-integration-repairs.test.mjs \
  tests/phase4-p1-3-natural-language-feedback-probes.test.mjs \
  tests/p1-review-package-backfill.test.mjs
```

2026-08-12 实测（报告 `reports/feedback-lineage-audit/focused-coverage-report.txt`）：
line 89.97% / branch 80.89% / funcs 96.47%。

## 2. 摄入反馈

```ts
// 显式选择
ingestor.ingestChoice(store, {
  context: { sourceChapter, modelVersion, strategyId, opportunityType },
  chosen: "editorial" | "raw",
  feedbackEventId, // 幂等键
  lineage,         // 可选；若提供必须完整
});

// 用户修改（优先先算 delta）
const delta = computeUserModificationDelta(deliveredText, userFinalText, note);
ingestor.ingestEdit(store, {
  context,
  deliveredSource: "editorial",
  modified: delta.modified,
  editDistance: delta.editDistance,
  delta,
  classification: delta.classification,
  feedbackEventId,
});
```

规则摘要：

| 情况 | 行为 |
|---|---|
| 完整血缘 + 选择 editorial | win，强证据 |
| 血缘不完整 | neutral，不更新 |
| raw 交付修改 | 不计入策略 |
| 事实/设定/剧情修改 | neutral（非文学） |
| 重度结构/声音修改 | loss，weight 可 >1，decisionCount=1 |
| 文学连续失败 | 最多 dormant，永不 auto-retired |

## 3. 撤销 evidence

```ts
// 推荐：定点撤销
store.revertOutcomeByEvidenceId(strategyId, modelVersion, evidenceId);

// 兼容：撤销最近一条
store.revertLastOutcome(strategyId, modelVersion);
```

从完整账本重算：

```ts
import { recomputeStrategyReputation } from "./v2/learning/strategy-reputation-recompute.js";
const rep = recomputeStrategyReputation(ledgerEvents, modelVersion, strategyKey);
```

## 4. 晋级审批

```ts
const recommendation = buildPromotionRecommendation(records, strategyId, modelVersion);
const result = applyPromotionWithApproval(store, recommendation, {
  approvalId,
  strategyId,
  modelVersion,
  approvedBy: "human-reviewer",
  approvedAt: new Date().toISOString(),
  checklist: {
    evalPassed: true,
    replayPassed: true,
    humanReviewPassed: true,
  },
});
```

缺 eval / replay / human 任一审批 → 拒绝。  
revoked / quarantined / polluted 证据不计入晋级。

## 5. 冲突与污染

- 同策略同源同时 win+loss → `detectEvidenceConflicts` 隔离
- 污染样本标记 `polluted`，不进 effective / 晋级
- 撤销追加 `revoke` 事件，不物理删除历史

## 6. 明确不做

- 反馈不改当前正文、事实、Prompt Bundle、硬门禁、生产基线
- 不用机器 judge / 单次拒绝自动退役文学策略
- 不把 bundle 结果伪造为单策略结果
