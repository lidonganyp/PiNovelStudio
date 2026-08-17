/**
 * BUDGET-TYPES — 统一预算账本类型定义（BG-01）
 *
 * budget-ledger.ts 的类型契约层：硬/软预算、必经阶段保留、恢复预算、
 * 预约（reservation）、用量（usage）、成本快照与决策记录。
 * 目标取代 layered-budget.ts + recovery-budget.ts 的分散类型定义；
 * 生产尚未收敛为单一权威（见 docs/project-memory.md BUDGET-LEDGER）。
 */

/** 必经阶段标识（mandatoryReserve 五键 + 辅助阶段） */
export type BudgetStage =
  | "agenticDraft"
  | "styleOptimization"
  | "storyPreservation"
  | "finalFactRecheck"
  | "completeness"
  | "agenticVerification"
  | "other";

/** 预算类别：normal 常规 / recovery 恢复 / mandatory 必经保留 */
export type BudgetType = "normal" | "recovery" | "mandatory";

/** 运行身份：预算归属的运行与发布上下文 */
export interface BudgetRunIdentity {
  runId: string;
  releaseId: string;
  modelVersion: string;
  bundleId: string;
  budgetGrantId: string;
}

/** 硬预算：超出即阻断，不可协商 */
export interface HardBudget {
  maxModelCalls: number;
  maxRecoveryModelCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalWaitMs: number;
  maxSingleStageMs: number;
  maxProviderCost: number;
  maxBatchChapters: number;
  mandatoryReserveMin: number;
}

/** 软预算：目标建议值，超限降级诊断而非阻断 */
export interface SoftBudget {
  suggestedRetrievalRounds: number;
  suggestedToolCalls: number;
  targetContextSize: number;
  targetFirstResponseMs: number;
  targetChapterCost: number;
  recommendedRecoveryTimes: number;
}

/** 必经阶段最低保留配额 */
export interface MandatoryReserve {
  agenticDraft: number;
  styleOptimization: number;
  storyPreservation: number;
  finalFactRecheck: number;
  completeness: number;
}

/** 恢复预算：gate 级重试与 bounded recovery 专用 */
export interface RecoveryReserve {
  maxRecoveryAttempts: number;
  maxRecoveryTokens: number;
}

/** 单条预算预约（原子预扣记录） */
export interface BudgetReservation {
  reservationId: string;
  ownerRunId: string;
  stage: BudgetStage;
  budgetType: BudgetType;
  reservedCalls: number;
  reservedTokens: number;
  reservedLatencyMs: number;
  reservedCost: number;
  expiresAt: number;
  createdAt: number;
}

/** 成本快照（阶段结算时追加；货币字段按结算时价格表版本解释） */
export interface BudgetCostSnapshot {
  timestamp: number;
  stage: BudgetStage;
  cost: number;
  actualCost: number;
  overage: number;
  unitPriceScheduleVersion: string;
  tokensInput: number;
  tokensOutput: number;
  provider?: string;
}

/** 用户追加授权 */
export interface UserBudgetExtension {
  extraCalls: number;
  extraCost: number;
  extraRecoveryCalls: number;
  grantedBy: string;
  reason: string;
  grantedAt: number;
}

/** 耗尽原因 */
export type ExhaustionReason =
  | "hard_model_calls_exceeded"
  | "hard_input_tokens_exceeded"
  | "hard_output_tokens_exceeded"
  | "hard_provider_cost_exceeded"
  | "hard_wait_exceeded"
  | "mandatory_reserve_depleted"
  | "recovery_exhausted"
  | "batch_chapters_remaining_zero"
  | "provider_quota_exceeded"
  | "no_progress";

/** 动态预算决策 */
export type BudgetAction = "continue" | "stop" | "request_additional";

/** 账本决策记录 */
export interface BudgetDecision {
  timestamp: number;
  type:
    | "budget_reservation_created"
    | "budget_settled"
    | "budget_released"
    | "budget_expired"
    | "budget_request_additional"
    | "budget_user_extension"
    | "budget_decision_made"
    | "budget_batch_admitted"
    | "budget_exhausted";
  reservationId?: string;
  stage?: BudgetStage;
  reservedCalls?: number;
  actualCalls?: number;
  actualCost?: number;
  reason?: string;
  action?: BudgetAction;
}

/** 累计用量 */
export interface BudgetUsage {
  totalModelCalls: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalLatencyMs: number;
  totalCost: number;
  failedCalls: number;
  recoveryModelCalls: number;
  batchChaptersUsed: number;
  lastAdmittedChapter?: number;
  providerUsage?: Record<string, { calls: number; cost: number; inputTokens: number; outputTokens: number }>;
}

/** 统一预算账本 */
export interface BudgetLedger {
  runIdentity: BudgetRunIdentity;
  hardBudget: HardBudget;
  softBudget: SoftBudget;
  mandatoryReserve: MandatoryReserve;
  optionalExploration: number;
  recoveryReserve: RecoveryReserve;
  unitPriceScheduleVersion: string;
  userExtension?: UserBudgetExtension;
  reservations: Record<string, BudgetReservation>;
  usage: BudgetUsage;
  costSnapshots: BudgetCostSnapshot[];
  decisions: BudgetDecision[];
}
