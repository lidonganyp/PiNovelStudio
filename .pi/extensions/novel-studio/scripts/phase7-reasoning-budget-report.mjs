#!/usr/bin/env node
/**
 * PHASE7-REASONING-BUDGET-REPORT CLI：Phase 7 推理预算 A/B/C 确定性报告生成
 *
 * 运行 reasoning-budget-runner 的确定性 A/B/C replay（零模型调用），把结果写入
 * 项目根目录 reports/phase7-reasoning-budget/：
 *   reasoning-budget-comparison.json     完整 A/B/C 对比（JSON）
 *   reasoning-budget-comparison.md       人类可读对比报告（含门禁与三臂明细）
 *   scenarios.jsonl                      每场景每臂的指标明细（JSONL，审计用）
 *
 * 用法：
 *   node scripts/phase7-reasoning-budget-report.mjs [--output <dir>]
 *
 * 选项：
 *   --output <dir>   输出目录（默认 <projectRoot>/reports/phase7-reasoning-budget）
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { values } = parseArgs({
  options: {
    "output": { type: "string" },
    "help": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`PHASE7-REASONING-BUDGET-REPORT CLI：Phase 7 推理预算 A/B/C 确定性报告生成

用法：
  node scripts/phase7-reasoning-budget-report.mjs [--output <dir>]

选项：
  --output <dir>   输出目录（默认 reports/phase7-reasoning-budget）

产物：
  reasoning-budget-comparison.json     完整 A/B/C 对比（JSON）
  reasoning-budget-comparison.md       人类可读对比报告（含门禁与三臂明细）
  scenarios.jsonl                      每场景每臂的指标明细（JSONL，审计用）
`);
  process.exit(0);
}

// ── 路径常量 ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = resolve(__filename, "..");
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..", "..", "..");
const EXT_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const OUTPUT_DIR = values.output
  ? resolve(values.output)
  : join(PROJECT_ROOT, "reports", "phase7-reasoning-budget");

const MODULE_PATH = pathToFileURL(
  join(EXT_ROOT, "dist-eval", "novelos", "eval", "reasoning-budget-runner.js"),
).href;

function log(message) {
  process.stderr.write(`[phase7-reasoning-budget-report] ${message}\n`);
}

// ── 动态 import dist-eval 模块 ────────────────────────────────────────────
const mod = await import(MODULE_PATH);

log("运行 Phase 7 推理预算 A/B/C 确定性 replay（零模型调用、确定性）...");
const comparison = await mod.runReasoningBudgetAbcReplay();

mkdirSync(OUTPUT_DIR, { recursive: true });

// 1. JSON
writeFileSync(
  join(OUTPUT_DIR, "reasoning-budget-comparison.json"),
  mod.formatReasoningBudgetJson(comparison),
  "utf-8",
);

// 2. Markdown
writeFileSync(
  join(OUTPUT_DIR, "reasoning-budget-comparison.md"),
  mod.formatReasoningBudgetMarkdown(comparison),
  "utf-8",
);

// 3. scenarios JSONL（每场景每臂指标明细，审计用）
const scenarioLines = comparison.scenarios.map((s) =>
  JSON.stringify({
    scenarioId: s.scenarioId,
    category: s.category,
    riskScore: {
      score: s.riskScore.score,
      tier: s.riskScore.tier,
      p0Count: s.riskScore.p0Count,
      p1Count: s.riskScore.p1Count,
      p2Count: s.riskScore.p2Count,
    },
    budgetA: { tier: s.budgetA.tier, maxTurns: s.budgetA.budgetConfig.maxTurns, maxToolCalls: s.budgetA.budgetConfig.maxToolCalls, retrievalDepth: s.budgetA.retrievalDepth, maxRepairRounds: s.budgetA.maxRepairRounds },
    budgetB: { tier: s.budgetB.tier, maxTurns: s.budgetB.budgetConfig.maxTurns, maxToolCalls: s.budgetB.budgetConfig.maxToolCalls, retrievalDepth: s.budgetB.retrievalDepth, maxRepairRounds: s.budgetB.maxRepairRounds },
    budgetC: { tier: s.budgetC.tier, maxTurns: s.budgetC.budgetConfig.maxTurns, maxToolCalls: s.budgetC.budgetConfig.maxToolCalls, retrievalDepth: s.budgetC.retrievalDepth, maxRepairRounds: s.budgetC.maxRepairRounds },
    coverageA: s.metricsA.mustVerify.coverageRatio,
    coverageB: s.metricsB.mustVerify.coverageRatio,
    coverageC: s.metricsC.mustVerify.coverageRatio,
    resultCharsA: s.metricsA.totalResultChars,
    resultCharsB: s.metricsB.totalResultChars,
    resultCharsC: s.metricsC.totalResultChars,
  }),
);
writeFileSync(join(OUTPUT_DIR, "scenarios.jsonl"), scenarioLines.join("\n") + "\n", "utf-8");

const agg = comparison.aggregation;
log("报告完成。");
log(`场景数：${comparison.scenarios.length}`);
log(`工具面：A=${agg.A.toolSurface}，B=${agg.B.toolSurface}，C=${agg.C.toolSurface}`);
log(`平均 mustVerify 覆盖率：A=${agg.A.avgCoverageRatio.toFixed(3)}，B=${agg.B.avgCoverageRatio.toFixed(3)}，C=${agg.C.avgCoverageRatio.toFixed(3)}`);
log(`估算 token：A=${agg.A.totalEstimateTokens}，B=${agg.B.totalEstimateTokens}，C=${agg.C.totalEstimateTokens}`);
log(`B 组全部通过：${comparison.gateB.allPassed}`);
log(`C 组全部通过：${comparison.gateC.allPassed}`);
log(`JSON：${join(OUTPUT_DIR, "reasoning-budget-comparison.json")}`);
log(`Markdown：${join(OUTPUT_DIR, "reasoning-budget-comparison.md")}`);
log(`scenarios：${join(OUTPUT_DIR, "scenarios.jsonl")}`);

process.exit(0);