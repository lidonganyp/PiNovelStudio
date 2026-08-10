/**
 * Phase 7 - 推理预算配置（eval-only）
 *
 * 三臂预算配置 + riskScore 计算 + BudgetTier 分档。
 *
 * 设计见 docs/phase7-reasoning-budget-design.md。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 * 生产路径不修改 DEFAULT_BUDGET_CONFIG，不修改 createEvidencePlan 的默认 retrievalDepth。
 */

import type { BudgetConfig } from "../runtime/budget-policy.js";
import { DEFAULT_BUDGET_CONFIG } from "../runtime/budget-policy.js";
import { retrievalCallBudgetForDepth, MAX_RETRIEVAL_DEPTH } from "../agent/evidence-decision.js";
import type { FactRiskLevel } from "../agent/must-verify-coverage-gate.js";
import { assessMustVerifyRisk } from "../agent/must-verify-coverage-gate.js";

// ============================================================================
// 类型
// ============================================================================

export type BudgetArm = "A" | "B" | "C";

export type BudgetTier = "low" | "medium" | "high";

/**
 * 推理预算配置：BudgetConfig + 检索预算 + 修复预算。
 *
 * BudgetConfig 来自 budget-policy.ts（maxTurns/maxToolCalls/maxLatencyMs/maxTokens）。
 * retrievalDepth 映射到 retrievalCallBudget（检索工具调用次数上限）。
 * maxRepairRounds / maxStagnantRounds / maxCoverageRetries 控制 verify/patch 闭环。
 */
export interface ReasoningBudgetConfig {
  arm: BudgetArm;
  tier: BudgetTier | "fixed";
  budgetConfig: BudgetConfig;
  retrievalDepth: number;
  retrievalCallBudget: number;
  maxRepairRounds: number;
  maxStagnantRounds: number;
  maxCoverageRetries: number;
}

/**
 * riskScore 计算结果。
 */
export interface RiskScoreResult {
  score: number;
  tier: BudgetTier;
  classified: Array<{ item: string; riskLevel: FactRiskLevel; reason: string }>;
  p0Count: number;
  p1Count: number;
  p2Count: number;
}

// ============================================================================
// riskScore 计算
// ============================================================================

/** P0=3 分, P1=2 分, P2=1 分 */
const RISK_WEIGHTS: Record<FactRiskLevel, number> = {
  P0: 3,
  P1: 2,
  P2: 1,
};

/** 低风险阈值：riskScore <= 3（如 0-1 个 P0 或 1.5 个 P1） */
export const LOW_RISK_THRESHOLD = 3;

/** 高风险阈值：riskScore > 10（如 3+ 个 P0 或 5+ 个 P1） */
export const HIGH_RISK_THRESHOLD = 10;

/**
 * 根据 mustVerify 列表和 inviolableFacts 计算 riskScore 和 BudgetTier。
 *
 * 使用 must-verify-coverage-gate.ts 的 assessMustVerifyRisk 做风险分类，
 * 然后按 P0=3 / P1=2 / P2=1 加权求和。
 *
 * @param mustVerify 必须验证的事实列表（string[]）
 * @param inviolableFacts 不可违背事实列表（用于 P0 判定）
 */
export function computeRiskScore(
  mustVerify: string[],
  inviolableFacts: string[] = [],
): RiskScoreResult {
  const classified = assessMustVerifyRisk(mustVerify, inviolableFacts);

  let p0Count = 0;
  let p1Count = 0;
  let p2Count = 0;
  let score = 0;

  for (const item of classified) {
    score += RISK_WEIGHTS[item.riskLevel];
    if (item.riskLevel === "P0") p0Count++;
    else if (item.riskLevel === "P1") p1Count++;
    else p2Count++;
  }

  const tier: BudgetTier =
    score <= LOW_RISK_THRESHOLD ? "low" :
    score <= HIGH_RISK_THRESHOLD ? "medium" :
    "high";

  return { score, tier, classified, p0Count, p1Count, p2Count };
}

// ============================================================================
// 三臂预算配置
// ============================================================================

/**
 * A 组：当前预算（基线）。
 *
 * 与生产 DEFAULT_BUDGET_CONFIG 完全一致，不修改任何参数。
 */
export function getBudgetA(): ReasoningBudgetConfig {
  return {
    arm: "A",
    tier: "fixed",
    budgetConfig: { ...DEFAULT_BUDGET_CONFIG },
    retrievalDepth: 2,
    retrievalCallBudget: retrievalCallBudgetForDepth(2),
    maxRepairRounds: 2,
    maxStagnantRounds: 2,
    maxCoverageRetries: 1,
  };
}

/**
 * B 组：温和降低预算。
 *
 * maxTurns -30%, maxToolCalls -30%, retrievalDepth 2->1 (-50%),
 * maxRepairRounds 2->1 (-50%), maxStagnantRounds 2->1 (-50%)。
 */
export function getBudgetB(): ReasoningBudgetConfig {
  return {
    arm: "B",
    tier: "fixed",
    budgetConfig: {
      maxTurns: 7,
      maxToolCalls: 14,
      maxLatencyMs: DEFAULT_BUDGET_CONFIG.maxLatencyMs,
      maxTokensIn: DEFAULT_BUDGET_CONFIG.maxTokensIn,
      maxTokensOut: DEFAULT_BUDGET_CONFIG.maxTokensOut,
    },
    retrievalDepth: 1,
    retrievalCallBudget: retrievalCallBudgetForDepth(1),
    maxRepairRounds: 1,
    maxStagnantRounds: 1,
    maxCoverageRetries: 1,
  };
}

/**
 * C 组：按查询风险自适应预算。
 *
 * 根据 riskScore 分 low/medium/high 三档：
 * - low（riskScore <= 3）：降低预算（同 B 组）
 * - medium（3 < riskScore <= 10）：当前默认（同 A 组）
 * - high（riskScore > 10）：提升预算（+40% turn/tool, depth=3, +50% repair）
 */
export function getBudgetC(riskScore: RiskScoreResult): ReasoningBudgetConfig {
  const tier = riskScore.tier;

  if (tier === "low") {
    return {
      arm: "C",
      tier: "low",
      budgetConfig: {
        maxTurns: 6,
        maxToolCalls: 10,
        maxLatencyMs: DEFAULT_BUDGET_CONFIG.maxLatencyMs,
        maxTokensIn: DEFAULT_BUDGET_CONFIG.maxTokensIn,
        maxTokensOut: DEFAULT_BUDGET_CONFIG.maxTokensOut,
      },
      retrievalDepth: 1,
      retrievalCallBudget: retrievalCallBudgetForDepth(1),
      maxRepairRounds: 1,
      maxStagnantRounds: 2,
      maxCoverageRetries: 1,
    };
  }

  if (tier === "medium") {
    return {
      arm: "C",
      tier: "medium",
      budgetConfig: { ...DEFAULT_BUDGET_CONFIG },
      retrievalDepth: 2,
      retrievalCallBudget: retrievalCallBudgetForDepth(2),
      maxRepairRounds: 2,
      maxStagnantRounds: 2,
      maxCoverageRetries: 1,
    };
  }

  // high
  return {
    arm: "C",
    tier: "high",
    budgetConfig: {
      maxTurns: 14,
      maxToolCalls: 28,
      maxLatencyMs: DEFAULT_BUDGET_CONFIG.maxLatencyMs,
      maxTokensIn: DEFAULT_BUDGET_CONFIG.maxTokensIn,
      maxTokensOut: DEFAULT_BUDGET_CONFIG.maxTokensOut,
    },
    retrievalDepth: 3,
    retrievalCallBudget: retrievalCallBudgetForDepth(3),
    maxRepairRounds: 3,
    maxStagnantRounds: 2,
    maxCoverageRetries: 1,
  };
}

/**
 * 验证 A 组配置与生产默认值完全一致。
 *
 * 此函数用于确定性测试，确保 A 组基线不偏离生产。
 */
export function verifyBudgetAMatchesProduction(): {
  matches: boolean;
  mismatches: string[];
} {
  const a = getBudgetA();
  const mismatches: string[] = [];

  if (a.budgetConfig.maxTurns !== DEFAULT_BUDGET_CONFIG.maxTurns) {
    mismatches.push(`maxTurns: A=${a.budgetConfig.maxTurns} != prod=${DEFAULT_BUDGET_CONFIG.maxTurns}`);
  }
  if (a.budgetConfig.maxToolCalls !== DEFAULT_BUDGET_CONFIG.maxToolCalls) {
    mismatches.push(`maxToolCalls: A=${a.budgetConfig.maxToolCalls} != prod=${DEFAULT_BUDGET_CONFIG.maxToolCalls}`);
  }
  if (a.budgetConfig.maxLatencyMs !== DEFAULT_BUDGET_CONFIG.maxLatencyMs) {
    mismatches.push(`maxLatencyMs: A=${a.budgetConfig.maxLatencyMs} != prod=${DEFAULT_BUDGET_CONFIG.maxLatencyMs}`);
  }
  if (a.budgetConfig.maxTokensIn !== DEFAULT_BUDGET_CONFIG.maxTokensIn) {
    mismatches.push(`maxTokensIn: A=${a.budgetConfig.maxTokensIn} != prod=${DEFAULT_BUDGET_CONFIG.maxTokensIn}`);
  }
  if (a.budgetConfig.maxTokensOut !== DEFAULT_BUDGET_CONFIG.maxTokensOut) {
    mismatches.push(`maxTokensOut: A=${a.budgetConfig.maxTokensOut} != prod=${DEFAULT_BUDGET_CONFIG.maxTokensOut}`);
  }
  if (a.retrievalDepth !== 2) {
    mismatches.push(`retrievalDepth: A=${a.retrievalDepth} != prod=2`);
  }
  if (a.retrievalCallBudget !== 4) {
    mismatches.push(`retrievalCallBudget: A=${a.retrievalCallBudget} != prod=4`);
  }
  if (a.maxRepairRounds !== 2) {
    mismatches.push(`maxRepairRounds: A=${a.maxRepairRounds} != prod=2`);
  }

  return { matches: mismatches.length === 0, mismatches };
}
