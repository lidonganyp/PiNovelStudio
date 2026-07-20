/**
 * CanaryPolicy — G5 P1 bounded canary 决策矩阵纯函数（EVOLUTION-RELEASE-GOVERNANCE-G5 P1）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §G5 line 380-395
 * 计划：.trae/documents/g5-p1-bounded-canary-implementation-plan.md §决策矩阵
 *
 * 基于 changeClass × healthStatus × currentStatus 输出 5 策略之一：
 *   skip / direct_promote / shadow_required / bounded_canary / blocked
 *
 * 决策矩阵（changeClass × healthStatus → strategy，仅当 currentStatus ∈ active 集合）：
 *
 *   changeClass \\ healthStatus | healthy | warning | insufficient_data | auto_hold_eligible | retired_suggestion |
 *   --------------------------------------------------------------------------------------------------------------------------------
 *   R0                          | skip    | skip    | skip               | skip                | skip                |
 *   R1                          | direct  | direct  | direct             | blocked             | blocked             |
 *   R2                          | bounded | shadow  | shadow             | blocked             | blocked             |
 *   R3                          | shadow  | shadow  | shadow             | blocked             | blocked             |
 *
 * 额外约束：
 * - currentStatus 非 active（draft/held/retired 等）→ 一律 skip（不参与 canary）
 * - 决策/执行分离：本函数不查授权（hasAuthorization 不进入输入）；授权检查在执行层（canary-actions）
 *
 * 设计原则：
 * - 纯函数：无副作用、不调模型、不读写文件
 * - 闭包自包含：仅 type-only 依赖（evolution-release-types + release-health-evaluator）
 *
 * 边界（READY_LOCAL）：
 * - 可被 dist-test/ / dist/ / dist-eval/ 任意闭包消费
 * - 不依赖 finalization / draft-checkpoint 运行时
 */

import type { ChangeClass, ReleaseStatus } from "./evolution-release-types.js";
import type { ReleaseHealthStatus } from "./release-health-evaluator.js";

// ============================================================================
// 类型
// ============================================================================

/** canary 策略枚举 */
export type CanaryStrategy =
  | "skip"
  | "direct_promote"
  | "shadow_required"
  | "bounded_canary"
  | "blocked";

/** blocked 原因（仅当 strategy=blocked 时填充） */
export type CanaryBlockedReason = "auto_hold_eligible" | "retired_suggestion";

/** 决策输入 */
export interface CanaryPolicyInput {
  changeClass: ChangeClass;
  healthStatus: ReleaseHealthStatus;
  currentStatus: ReleaseStatus;
}

/** 决策输出 */
export interface CanaryPolicyDecision {
  strategy: CanaryStrategy;
  /** 仅当 strategy=blocked 时填充；其他策略为 undefined */
  blockedReason?: CanaryBlockedReason;
}

// ============================================================================
// 常量
// ============================================================================

/** 参与 canary 的 active 状态集合 */
const PARTICIPATING_STATUSES: ReadonlySet<ReleaseStatus> = new Set<ReleaseStatus>([
  "evaluated",
  "active_dev",
  "candidate_prod",
  "active_prod",
]);

// ============================================================================
// 纯函数实现
// ============================================================================

/**
 * 决策 canary 策略（纯函数，无副作用）。
 *
 * 判定流程（优先级从高到低）：
 * 1. currentStatus 非 active → skip（不参与 canary）
 * 2. changeClass=R0 → skip（零风险变更不参与 canary）
 * 3. healthStatus ∈ {auto_hold_eligible, retired_suggestion} → blocked
 * 4. changeClass=R1 → direct_promote（低风险直接晋级）
 * 5. changeClass=R2 + healthStatus=healthy → bounded_canary（中风险 + 健康走 bounded canary）
 * 6. 其他 → shadow_required（默认走 shadow）
 *
 * @param input { changeClass, healthStatus, currentStatus }
 * @returns CanaryPolicyDecision，含 strategy 与可选 blockedReason
 */
export function decideCanaryStrategy(input: CanaryPolicyInput): CanaryPolicyDecision {
  const { changeClass, healthStatus, currentStatus } = input;

  // 1. currentStatus 非 active → skip（不参与 canary）
  if (!PARTICIPATING_STATUSES.has(currentStatus)) {
    return { strategy: "skip" };
  }

  // 2. changeClass=R0 → skip（零风险变更不参与 canary）
  if (changeClass === "R0") {
    return { strategy: "skip" };
  }

  // 3. healthStatus ∈ {auto_hold_eligible, retired_suggestion} → blocked
  if (healthStatus === "auto_hold_eligible") {
    return { strategy: "blocked", blockedReason: "auto_hold_eligible" };
  }
  if (healthStatus === "retired_suggestion") {
    return { strategy: "blocked", blockedReason: "retired_suggestion" };
  }

  // 4. changeClass=R1 → direct_promote（低风险直接晋级）
  if (changeClass === "R1") {
    return { strategy: "direct_promote" };
  }

  // 5. changeClass=R2 + healthStatus=healthy → bounded_canary
  if (changeClass === "R2" && healthStatus === "healthy") {
    return { strategy: "bounded_canary" };
  }

  // 6. 其他 → shadow_required（R2+warning/insufficient_data, R3+任何健康状态）
  return { strategy: "shadow_required" };
}
