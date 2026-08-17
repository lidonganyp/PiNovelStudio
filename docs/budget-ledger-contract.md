# PiNovelStudio BudgetLedger 契约文档（BG-00）

**版本**: 1.0.0  
**日期**: 2026-08-14  
**状态**: 契约冻结（BG-00 已完成）；**实现未完成**  
**目标权威**: `BudgetLedger`（目标取代 `layered-budget.ts` + `recovery-budget.ts` + `legacyRecovery`，生产尚未收敛）

> **实现口径（2026-08-15）**：当前只完成「BudgetLedger 最小接入切片」（类型契约、主链路 reserve/settle、4 个基础测试）。附件计划 BG-00～BG-08 的完整治理闭环仍未完成；不得把本契约或最小切片标成整包完成。未完成项与推进顺序见 `docs/project-memory.md`「BUDGET-LEDGER」节。

## 1. 核心概念

- **BudgetLedger**: 唯一预算来源与账本。所有资源消耗（模型调用、token、延迟、recovery、批量章节、并发预留）必须经过此账本。
- **硬预算 (Hard Budget)**: 不可被模型或普通配置覆盖的硬边界。必须预留、结算、失败也要记账。
- **软预算 (Soft Budget)**: 模型/Agent 自主决策的建议指标（检索轮次、token 目标等）。
- **Reservation**: 原子并发预留（reservationId + ownerRunId + expiresAt）。
- **Exhaustion**: 硬预算耗尽时必须 `checkpoint` / `blocked` / `requestAdditionalBudget`，不得静默降级。
- **State Machine**: 状态机包含 `reserve` → `settle` → `release` → `snapshot` 路径。

## 2. 数据模型

```ts
export interface BudgetLedger {
  runIdentity: {
    runId: string;
    releaseId: string;
    modelVersion: string;
    bundleId: string;
    budgetGrantId: string;
  };

  hardBudget: HardBudget;
  softBudget: SoftBudget;
  mandatoryReserve: MandatoryReserve;   // 必经安全阶段最低预算
  optionalExploration: number;         // 可选检索/验证预算
  recoveryReserve: RecoveryReserve;
  userExtension?: UserBudgetExtension;

  reservations: Record<string, BudgetReservation>; // reservationId -> Reservation
  usage: UsageSnapshot;

  costSnapshots: CostSnapshot[];             // 按调用时间排序
  decisions: BudgetDecision[];                // 每次决策记录
}

export interface HardBudget {
  maxModelCalls: number;
  maxRecoveryModelCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalWaitMs: number;
  maxSingleStageMs: number;
  maxProviderCost: number;
  maxBatchChapters: number;
  mandatoryReserveMin: number;  // 必经阶段最低保留
}

export interface SoftBudget {
  suggestedRetrievalRounds?: number;
  suggestedToolCalls?: number;
  targetContextSize?: number;
  targetFirstResponseMs?: number;
  targetChapterCost?: number;
  recommendedRecoveryTimes?: number;
}

export interface BudgetReservation {
  reservationId: string;
  ownerRunId: string;
  stage: BudgetStage;
  budgetType: 'normal' | 'recovery';
  reservedCalls: number;
  reservedTokens: number;
  reservedLatencyMs: number;
  reservedCost: number;
  expiresAt: number; // timestamp
  createdAt: number;
}
```

## 3. 预算阶段与硬边界

```ts
export type BudgetStage = 
  | 'preflight' 
  | 'chapterIntent' 
  | 'novelOSAgentic' 
  | 'agenticFactGuard' 
  | 'authorStyleOptimization' 
  | 'storyPreservation' 
  | 'finalFactRecheck' 
  | 'completeness' 
  | 'finalStateCommit';

export interface MandatoryReserve {
  agenticDraft: number;      // 必经
  styleOptimization: number;
  storyPreservation: number;
  finalFactRecheck: number;
  completeness: number;
}
```

## 4. 耗尽语义 (Exhaustion)

```ts
export type ExhaustionReason =
  | 'hard_model_calls_exceeded'
  | 'hard_tokens_exceeded'
  | 'mandatory_reserve_depleted'
  | 'no_progress'
  | 'recovery_exhausted'
  | 'batch_chapters_remaining_zero';

export interface BudgetExhaustion {
  reason: ExhaustionReason;
  evidence: string[]; // trace paths
  recoverable: boolean;
  retryPlan?: string;
  userActionRequired?: boolean;
}
```

## 5. 旧预算字段迁移表

| 旧字段              | 新 BudgetLedger 映射                  | 迁移动作                  |
|---------------------|--------------------------------------|---------------------------|
| layered.normal     | hardBudget.maxModelCalls             | 并行比对后删除           |
| layered.recovery   | recoveryReserve + hardBudget        | 并行比对后删除           |
| legacyRecovery     | 废弃，直接删除                      | 物理删除                  |
| recovery-budget.ts | 统一到 BudgetLedger.reserve()       | 替换为 BudgetLedger.reserve |
| AgentWorkPackage.budget | 统一到 ledger.budget + reservation | 接入 BudgetLedger        |

## 6. 事件命名规范

- `budget_reservation_created`
- `budget_settled`
- `budget_exhausted`
- `budget_request_additional`
- `budget_decision_made`
- `budget_snapshot_taken`

所有事件必须写入 `decisions` 数组并进入 trace。

## 7. 验收标准 (BG-00)

- 唯一预算权威明确为 `BudgetLedger`
- 所有硬预算字段不可被模型覆盖
- 旧 `layered-budget.ts` + `recovery-budget.ts` 保留为历史/兼容层，生产路径全部走新账本（**目标**；生产仍双写旧账本）
- 迁移表完成
- ADR 完成

**已完成**: 契约冻结（BG-00）。BG-01 仅落地最小 reserve/settle 接入，不是完整实现。

实现状态（2026-08-15）：真实成本、价格版本、Batch 准入、队列级预留/释放/过期、mandatory lock、动态追加决策、wrapModelFn 单一准入、Replay Matrix 均已落地。layered-budget / recovery-budget 保留为兼容投影，生产阻断只认 BudgetLedger。
