/**
 * Phase 7 - 推理预算 A/B/C runner（eval-only）
 *
 * 对比三臂（见 docs/phase7-reasoning-budget-design.md）：
 * - A：当前预算（基线，与生产 DEFAULT_BUDGET_CONFIG 一致）
 * - B：温和降低预算（maxTurns -30%, retrievalDepth 2->1, maxRepairRounds 2->1）
 * - C：按查询风险自适应预算（riskScore -> low/medium/high -> 不同预算）
 *
 * 确定性 stub 模式：直接驱动工具 execute（零模型调用）。
 * 在 stub 模式下，三臂的工具调用结果完全相同（runScenarioWithTools 不尊重预算限制），
 * 但预算配置元数据和 riskScore 分档会记录在报告中。
 * 真实模型 replay 时，预算会实际影响 agent loop 行为。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import { createNarrativeTools } from "../tools/narrative-tools.js";
import {
  runScenarioWithTools,
  BASELINE_SCENARIOS,
  type BaselineScenario,
  type BaselineScenarioMetrics,
} from "./tool-interface-baseline.js";
import { aggregateArm, type ToolAbArmAggregation } from "./tool-ab-runner.js";
import {
  getBudgetA,
  getBudgetB,
  getBudgetC,
  computeRiskScore,
  type ReasoningBudgetConfig,
  type RiskScoreResult,
  type BudgetTier,
} from "./reasoning-budget-config.js";
import {
  evaluateBudgetGateB,
  evaluateBudgetGateC,
  type BudgetArmAggregation,
  type BudgetGateB,
  type BudgetGateC,
} from "./reasoning-budget-gate.js";

// ============================================================================
// 类型
// ============================================================================

/** 单场景三臂对比 */
export interface BudgetScenarioResult {
  scenarioId: string;
  category: string;
  /** C 组的 riskScore 结果 */
  riskScore: RiskScoreResult;
  /** 三臂预算配置 */
  budgetA: ReasoningBudgetConfig;
  budgetB: ReasoningBudgetConfig;
  budgetC: ReasoningBudgetConfig;
  /** 三臂场景指标（stub 模式下 A=B=C） */
  metricsA: BaselineScenarioMetrics;
  metricsB: BaselineScenarioMetrics;
  metricsC: BaselineScenarioMetrics;
}

/** 完整 A/B/C 对比报告 */
export interface ReasoningBudgetComparison {
  schema: string;
  timestamp: string;
  phase: string;
  mode: "stub" | "real";
  scenarios: BudgetScenarioResult[];
  aggregation: { A: BudgetArmAggregation; B: BudgetArmAggregation; C: BudgetArmAggregation };
  /** 低风险场景聚合（C 组分档用） */
  lowRiskAggregation: { A: BudgetArmAggregation | null; C: BudgetArmAggregation | null };
  /** 高风险场景聚合（C 组分档用） */
  highRiskAggregation: { A: BudgetArmAggregation | null; C: BudgetArmAggregation | null };
  gateB: BudgetGateB;
  gateC: BudgetGateC;
}

// ============================================================================
// 辅助：把 ToolAbArmAggregation 转为 BudgetArmAggregation
// ============================================================================

function toBudgetAggregation(
  agg: ToolAbArmAggregation,
  stopRate = 1.0,
  avgFirstEvidenceLatencyMs = 0,
  budgetExhaustedCount = 0,
): BudgetArmAggregation {
  return {
    ...agg,
    stopRate,
    avgFirstEvidenceLatencyMs,
    budgetExhaustedCount,
  };
}

// ============================================================================
// 场景级 riskScore 计算
// ============================================================================

/**
 * 从场景的 mustVerify 列表计算 riskScore。
 *
 * BaselineScenario 的 calls 中每个 call 有 mustVerify: string[]，
 * 汇总所有 call 的 mustVerify 作为该场景的待验证事实列表。
 * inviolableFacts 从场景 workspace 中提取（当前场景无显式 inviolableFacts，
 * assessMustVerifyRisk 会用标记词做 P0 判定）。
 */
function computeScenarioRiskScore(scenario: BaselineScenario): RiskScoreResult {
  const allMustVerify: string[] = [];
  for (const call of scenario.calls) {
    if (call.mustVerify) {
      allMustVerify.push(...call.mustVerify);
    }
  }
  // 去重
  const unique = [...new Set(allMustVerify)];
  return computeRiskScore(unique);
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 运行 Phase 7 推理预算 A/B/C 确定性 replay（stub，零模型调用）。
 *
 * @param options.scenarios 参与对比的场景（默认 BASELINE_SCENARIOS）
 * @param options.timestamp 报告时间戳（默认 now）
 */
export async function runReasoningBudgetAbcReplay(
  options: { scenarios?: BaselineScenario[]; timestamp?: string } = {},
): Promise<ReasoningBudgetComparison> {
  const scenarios = options.scenarios ?? BASELINE_SCENARIOS;

  const perScenario: BudgetScenarioResult[] = [];
  for (const scenario of scenarios) {
    // 计算 riskScore（C 组用）
    const riskScore = computeScenarioRiskScore(scenario);

    // 三臂预算配置
    const budgetA = getBudgetA();
    const budgetB = getBudgetB();
    const budgetC = getBudgetC(riskScore);

    // 确定性 stub：三臂用相同的 9 专用工具 + 相同场景执行
    // 在 stub 模式下，预算不影响工具执行结果（runScenarioWithTools 执行全部调用）
    // 真实模型 replay 时，预算会通过 BudgetPolicy 和 retrievalBudget 影响 agent loop
    const [metricsA, metricsB, metricsC] = await Promise.all([
      runScenarioWithTools(scenario, (searchService) =>
        createNarrativeTools({ searchService }),
      ),
      runScenarioWithTools(scenario, (searchService) =>
        createNarrativeTools({ searchService }),
      ),
      runScenarioWithTools(scenario, (searchService) =>
        createNarrativeTools({ searchService }),
      ),
    ]);

    perScenario.push({
      scenarioId: scenario.id,
      category: scenario.category,
      riskScore,
      budgetA,
      budgetB,
      budgetC,
      metricsA,
      metricsB,
      metricsC,
    });
  }

  // 聚合
  const aggregation = {
    A: toBudgetAggregation(aggregateArm(perScenario.map((s) => s.metricsA))),
    B: toBudgetAggregation(aggregateArm(perScenario.map((s) => s.metricsB))),
    C: toBudgetAggregation(aggregateArm(perScenario.map((s) => s.metricsC))),
  };

  // 按 riskTier 分场景聚合（C 组门禁用）
  const lowRiskScenarios = perScenario.filter((s) => s.riskScore.tier === "low");
  const highRiskScenarios = perScenario.filter((s) => s.riskScore.tier === "high");

  const lowRiskAggregation = {
    A: lowRiskScenarios.length > 0
      ? toBudgetAggregation(aggregateArm(lowRiskScenarios.map((s) => s.metricsA)))
      : null,
    C: lowRiskScenarios.length > 0
      ? toBudgetAggregation(aggregateArm(lowRiskScenarios.map((s) => s.metricsC)))
      : null,
  };

  const highRiskAggregation = {
    A: highRiskScenarios.length > 0
      ? toBudgetAggregation(aggregateArm(highRiskScenarios.map((s) => s.metricsA)))
      : null,
    C: highRiskScenarios.length > 0
      ? toBudgetAggregation(aggregateArm(highRiskScenarios.map((s) => s.metricsC)))
      : null,
  };

  // 门禁评估
  const gateB = evaluateBudgetGateB(aggregation.A, aggregation.B);
  const gateC = evaluateBudgetGateC(
    aggregation.A,
    aggregation.C,
    lowRiskAggregation.A,
    lowRiskAggregation.C,
    highRiskAggregation.A,
    highRiskAggregation.C,
  );

  return {
    schema: "reasoning-budget-abc/v1",
    timestamp: options.timestamp ?? new Date().toISOString(),
    phase: "phase7-reasoning-budget",
    mode: "stub",
    scenarios: perScenario,
    aggregation,
    lowRiskAggregation,
    highRiskAggregation,
    gateB,
    gateC,
  };
}

// ============================================================================
// 报告格式化
// ============================================================================

export function formatReasoningBudgetJson(comparison: ReasoningBudgetComparison): string {
  return JSON.stringify(comparison, null, 2);
}

export function formatReasoningBudgetMarkdown(comparison: ReasoningBudgetComparison): string {
  const l: string[] = [];
  l.push("# Phase 7 推理预算 A/B/C 对比报告");
  l.push("");
  l.push(`**schema**：${comparison.schema}`);
  l.push(`**时间**：${comparison.timestamp}`);
  l.push(`**阶段**：${comparison.phase}`);
  l.push(`**模式**：${comparison.mode}（${comparison.mode === "stub" ? "确定性 stub，零模型调用" : "真实模型"}）`);
  l.push("");

  // 三臂定义
  l.push("## 三臂定义");
  l.push("");
  l.push("- **A**：当前预算（基线，与生产 DEFAULT_BUDGET_CONFIG 一致）");
  l.push("- **B**：温和降低预算（maxTurns -30%, retrievalDepth 2->1, maxRepairRounds 2->1）");
  l.push("- **C**：按查询风险自适应预算（riskScore -> low/medium/high -> 不同预算）");
  l.push("");

  // 门禁结论
  l.push("## 门禁结论");
  l.push("");
  l.push("### B 组门禁（温和降低不降级）");
  l.push("");
  l.push("| 门禁 | 结论 | 详情 |");
  l.push("|------|------|------|");
  l.push(`| mustVerify 覆盖率不降级 | ${comparison.gateB.coverageNotDegraded ? "✓" : "✗"} | ${comparison.gateB.details.coverageNotDegraded} |`);
  l.push(`| sourceRef 完整率不降级 | ${comparison.gateB.sourceRefNotDegraded ? "✓" : "✗"} | ${comparison.gateB.details.sourceRefNotDegraded} |`);
  l.push(`| 失败行为不恶化 | ${comparison.gateB.failureNotWorse ? "✓" : "✗"} | ${comparison.gateB.details.failureNotWorse} |`);
  l.push(`| token 成本下降 | ${comparison.gateB.tokenCostReduced ? "✓" : "✗"} | ${comparison.gateB.details.tokenCostReduced} |`);
  l.push(`| 停止率不降级 | ${comparison.gateB.stopRateNotDegraded ? "✓" : "✗"} | ${comparison.gateB.details.stopRateNotDegraded} |`);
  l.push(`| 首证据延迟不恶化 | ${comparison.gateB.latencyNotWorse ? "✓" : "✗"} | ${comparison.gateB.details.latencyNotWorse} |`);
  l.push("");
  l.push(`**B 组全部通过**：${comparison.gateB.allPassed ? "是" : "否"}`);
  l.push("");

  l.push("### C 组门禁（自适应不降级 + 分类收益）");
  l.push("");
  l.push("| 门禁 | 结论 | 详情 |");
  l.push("|------|------|------|");
  l.push(`| mustVerify 覆盖率不降级 | ${comparison.gateC.coverageNotDegraded ? "✓" : "✗"} | ${comparison.gateC.details.coverageNotDegraded} |`);
  l.push(`| sourceRef 完整率不降级 | ${comparison.gateC.sourceRefNotDegraded ? "✓" : "✗"} | ${comparison.gateC.details.sourceRefNotDegraded} |`);
  l.push(`| 失败行为不恶化 | ${comparison.gateC.failureNotWorse ? "✓" : "✗"} | ${comparison.gateC.details.failureNotWorse} |`);
  l.push(`| 低风险 token 下降 | ${comparison.gateC.lowRiskTokenReduced ? "✓" : "✗"} | ${comparison.gateC.details.lowRiskTokenReduced} |`);
  l.push(`| 高风险覆盖率提升 | ${comparison.gateC.highRiskCoverageImproved ? "✓" : "✗"} | ${comparison.gateC.details.highRiskCoverageImproved} |`);
  l.push(`| 停止率不降级 | ${comparison.gateC.stopRateNotDegraded ? "✓" : "✗"} | ${comparison.gateC.details.stopRateNotDegraded} |`);
  l.push(`| 聚合 token 不膨胀 | ${comparison.gateC.tokenNotInflated ? "✓" : "✗"} | ${comparison.gateC.details.tokenNotInflated} |`);
  l.push("");
  l.push(`**C 组全部通过**：${comparison.gateC.allPassed ? "是" : "否"}`);
  l.push("");

  // 聚合指标
  l.push("## 聚合指标");
  l.push("");
  l.push("| 指标 | A 组（当前预算） | B 组（温和降低） | C 组（自适应） |");
  l.push("|------|------|------|------|");
  const agg = comparison.aggregation;
  l.push(`| 总调用 | ${agg.A.totalCalls} | ${agg.B.totalCalls} | ${agg.C.totalCalls} |`);
  l.push(`| 估算 token | ${agg.A.totalEstimateTokens} | ${agg.B.totalEstimateTokens} | ${agg.C.totalEstimateTokens} |`);
  l.push(`| 平均覆盖率 | ${agg.A.avgCoverageRatio.toFixed(3)} | ${agg.B.avgCoverageRatio.toFixed(3)} | ${agg.C.avgCoverageRatio.toFixed(3)} |`);
  l.push(`| sourceRef 完整率 | ${agg.A.sourceRefCompleteness.toFixed(3)} | ${agg.B.sourceRefCompleteness.toFixed(3)} | ${agg.C.sourceRefCompleteness.toFixed(3)} |`);
  l.push(`| 空结果 | ${agg.A.totalEmptyResults} | ${agg.B.totalEmptyResults} | ${agg.C.totalEmptyResults} |`);
  l.push(`| 失败 | ${agg.A.totalErrors} | ${agg.B.totalErrors} | ${agg.C.totalErrors} |`);
  l.push(`| 停止率 | ${(agg.A.stopRate * 100).toFixed(0)}% | ${(agg.B.stopRate * 100).toFixed(0)}% | ${(agg.C.stopRate * 100).toFixed(0)}% |`);
  l.push("");

  // 各场景详情
  l.push("## 各场景详情");
  l.push("");
  for (const s of comparison.scenarios) {
    l.push(`### ${s.scenarioId}（${s.category}）`);
    l.push("");
    l.push(`- riskScore: ${s.riskScore.score}（tier=${s.riskScore.tier}，P0=${s.riskScore.p0Count} P1=${s.riskScore.p1Count} P2=${s.riskScore.p2Count}）`);
    l.push(`- A 预算: maxTurns=${s.budgetA.budgetConfig.maxTurns}, maxToolCalls=${s.budgetA.budgetConfig.maxToolCalls}, depth=${s.budgetA.retrievalDepth}, repair=${s.budgetA.maxRepairRounds}`);
    l.push(`- B 预算: maxTurns=${s.budgetB.budgetConfig.maxTurns}, maxToolCalls=${s.budgetB.budgetConfig.maxToolCalls}, depth=${s.budgetB.retrievalDepth}, repair=${s.budgetB.maxRepairRounds}`);
    l.push(`- C 预算: maxTurns=${s.budgetC.budgetConfig.maxTurns}, maxToolCalls=${s.budgetC.budgetConfig.maxToolCalls}, depth=${s.budgetC.retrievalDepth}, repair=${s.budgetC.maxRepairRounds}（tier=${s.budgetC.tier}）`);
    l.push(`- 覆盖率: A=${s.metricsA.mustVerify.coverageRatio.toFixed(3)}，B=${s.metricsB.mustVerify.coverageRatio.toFixed(3)}，C=${s.metricsC.mustVerify.coverageRatio.toFixed(3)}`);
    l.push(`- 返回字符: A=${s.metricsA.totalResultChars}，B=${s.metricsB.totalResultChars}，C=${s.metricsC.totalResultChars}`);
    l.push("");
  }

  // 说明
  l.push("## 说明");
  l.push("");
  l.push("- 本报告为**确定性 stub 对比**（直接驱动工具 execute），零模型调用。");
  l.push("- 在 stub 模式下，三臂工具调用结果完全相同（预算不影响工具执行）；");
  l.push("  预算配置元数据和 riskScore 分档记录在报告中，供真实模型 replay 对比。");
  l.push("- 真实模型 replay 时，预算通过 BudgetPolicy 和 retrievalBudget 影响 agent loop 行为。");
  l.push("- 固定 9 专用工具 + 完整上下文（Phase 6 冻结），只变化推理预算。");
  l.push("");

  return l.join("\n");
}
