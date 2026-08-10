#!/usr/bin/env node
/**
 * PHASE7-REASONING-BUDGET-REAL-REPORT CLI：Phase 7 推理预算 A/B/C 真实模型 replay 报告生成
 *
 * 运行 reasoning-budget-runner 的模型驱动 A/B/C replay（三臂统一 9 专用工具，只变推理预算
 * maxTurns → agent loop 回合上限）。默认 dry-run（确定性 stub，零 API），仅验证 runner
 * 框架与报告；真实模型需显式 `--mode real --require-auth` 并注入已授权的 modelFn
 * （GLM 5.2，route narrator_testing_glm）。结果写入项目根目录
 * reports/phase7-reasoning-budget-real/：
 *   phase7-real-comparison.json          完整 A/B/C 对比（JSON）
 *   phase7-real-comparison.md            人类可读对比报告（含 B/C 门禁）
 *   trajectory/{scenarioId}-{A|B|C}-{seed}.jsonl  每场景每臂每 seed 的 trajectory 副本
 *
 * 用法：
 *   node scripts/phase7-reasoning-budget-real-report.mjs [--output <dir>] [--mode dry-run]
 *
 * 选项：
 *   --output <dir>   输出目录（默认 <projectRoot>/reports/phase7-reasoning-budget-real）
 *   --mode <dry-run|real>   执行模式（默认 dry-run；real 需 --require-auth + GLM/Doubao 授权）
 *   --route <name>   real 模式测试路由（默认 narrator_testing_glm，须在 GLM/Doubao allowlist 内）
 *   --samples <n>    seed 数（默认 3，即 1 批 × 3 seed；用 --batches 放大批次）
 *   --batches <n>    批次（默认 1；每批独立跑 --samples 个 seed，批次偏移 seed 起始值）
 *   --require-auth   real 模式显式授权开关（未传则拒绝执行）
 *   --help           打印帮助
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { values } = parseArgs({
  options: {
    "output": { type: "string" },
    "mode": { type: "string", default: "dry-run" },
    "route": { type: "string" },
    "samples": { type: "string" },
    "batches": { type: "string" },
    "scenario": { type: "string" },
    "require-auth": { type: "boolean", default: false },
    "help": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`PHASE7-REASONING-BUDGET-REAL-REPORT CLI：Phase 7 推理预算 A/B/C 真实 replay 报告生成

用法：
  node scripts/phase7-reasoning-budget-real-report.mjs [--output <dir>] [--mode dry-run]

选项：
  --output <dir>   输出目录（默认 <projectRoot>/reports/phase7-reasoning-budget-real）
  --mode <dry-run|real>   执行模式（默认 dry-run；real 注入真实模型决策 fn，需 GLM/Doubao 授权）
  --route <name>   real 模式测试路由（默认 narrator_testing_glm = glm-5.2）
  --samples <n>    每批 seed 数（默认 3）
  --batches <n>    批次（默认 1；总 seed = batches × samples，seed 起始随批次偏移）
  --scenario <ids> 定向重跑指定基线场景（逗号分隔）
  --require-auth   real 模式显式授权开关：确认已获 GLM/Doubao 临时调用授权。
                   必须显式传入，否则 real 模式拒绝执行（默认 dry-run 无需）。

产物：
  phase7-real-comparison.json            完整 A/B/C 对比（JSON）
  phase7-real-comparison.md              人类可读对比报告（含 B/C 门禁）
  trajectory/{场景}-{A|B|C}-{seed}.jsonl  每场景每臂每 seed 的 trajectory 副本
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
  : join(PROJECT_ROOT, "reports", "phase7-reasoning-budget-real");

const MODULE_PATH = pathToFileURL(
  join(EXT_ROOT, "dist-eval", "novelos", "eval", "reasoning-budget-runner.js"),
).href;
const REAL_RUNNER_PATH = pathToFileURL(
  join(EXT_ROOT, "dist-eval", "novelos", "eval", "tool-ab-real-runner.js"),
).href;
const BASELINE_PATH = pathToFileURL(
  join(EXT_ROOT, "dist-eval", "novelos", "eval", "tool-interface-baseline.js"),
).href;

function log(message) {
  process.stderr.write(`[phase7-real-report] ${message}\n`);
}

// ── 动态 import dist-eval 模块 ────────────────────────────────────────────
const mod = await import(MODULE_PATH);
const realRunner = await import(REAL_RUNNER_PATH);
const baseline = await import(BASELINE_PATH);
const ALL_SCENARIOS = baseline.BASELINE_SCENARIOS;

const mode = values.mode === "real" ? "real" : "dry-run";
const batches = values.batches ? Math.max(1, parseInt(values.batches, 10)) : 1;
const samples = values.samples ? Math.max(1, parseInt(values.samples, 10)) : 3;

let modelFn;
if (mode === "real") {
  // 项目记忆硬约束：临时/批量测试只用 GLM/Doubao，必须 PINOVEL_DISABLE_FALLBACK=1
  // + PINOVEL_BENCHMARK_COST_PROFILE=package_screening（provider allowlist 守卫）。
  process.env.PINOVEL_PROJECT_ROOT = PROJECT_ROOT;
  process.env.PINOVEL_DISABLE_FALLBACK = "1";
  process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";

  if (!values["require-auth"]) {
    log("real 模式拒绝执行：未传入 --require-auth 显式授权开关。");
    log("请确认已获 GLM/Doubao 临时调用授权，并显式加 --require-auth 后重试。");
    process.exit(1);
  }

  const route = values.route ?? process.env.PINOVEL_TOOL_AB_ROUTE ?? "narrator_testing_glm";
  const REAL_ROUTE_ALLOWLIST = new Set([
    "narrator_testing_glm", // glm-5.2
    "narrator_testing", // doubao-seed-2-1-pro
    "style_shaper_testing_glm",
    "chinese_naturalizer_glm",
    "reference_analyzer_glm",
    "nb4_generate_glm",
    "nb4_judge_glm",
    "nb5_judge_glm",
    "reference_analyzer_doubao",
    "nb4_generate_doubao",
    "nb4_judge_doubao",
    "nb5_judge_doubao",
  ]);
  if (!REAL_ROUTE_ALLOWLIST.has(route)) {
    log(`real 模式拒绝执行：路由 "${route}" 不在 GLM/Doubao 测试 allowlist 内。`);
    log(`允许路由：${[...REAL_ROUTE_ALLOWLIST].join(", ")}`);
    process.exit(1);
  }

  log(`--mode real：注入真实模型决策 fn（route=${route}，GLM/Doubao 授权，DISABLE_FALLBACK=1）`);
  modelFn = await realRunner.createRealToolAbModelDecide({
    route,
    maxTokens: 2048,
    timeoutMs: 120000,
    temperature: 0.72,
  });
} else {
  // dry-run：用 SC1 的 dry-run 模型（确定性 stub，零 API）。runner 内部固定 arm="A"，
  // 故这里传 "A"。注意 dry-run model 绑定单场景；此模式仅用于验证 runner 框架与报告。
  modelFn = realRunner.createDryRunModel(ALL_SCENARIOS[0], "A");
}

// 场景范围：--scenario 定向重跑，否则全部基线场景。
let scenarios;
if (values.scenario) {
  const ids = values.scenario.split(",").map((s) => s.trim()).filter(Boolean);
  scenarios = ALL_SCENARIOS.filter((s) => ids.includes(s.id));
  if (scenarios.length === 0) {
    log(`--scenario 未匹配到任何基线场景：${ids.join(",")}`);
    process.exit(1);
  }
} else {
  scenarios = ALL_SCENARIOS;
}

log(`运行 Phase 7 推理预算 A/B/C replay（模式=${mode}，工具面=9 专用，场景=${scenarios.length}，批次=${batches}，每批 seed=${samples}）...`);

// 每批独立跑 --samples 个 seed；seed 起始随批次偏移（batch 0: 0..samples-1, batch 1: samples..2*samples-1 ...）。
for (let b = 0; b < batches; b++) {
  const seedStart = b * samples;
  const seeds = Array.from({ length: samples }, (_, i) => seedStart + i);
  log(`批次 ${b + 1}/${batches}：seed=${seeds.join(",")}`);
  const comparison = await mod.runReasoningBudgetAbcRealReplay({ modelFn, seeds, scenarios });

  const batchDir = batches > 1 ? join(OUTPUT_DIR, `batch-${b + 1}`) : OUTPUT_DIR;
  mkdirSync(batchDir, { recursive: true });

  // 1. JSON
  writeFileSync(
    join(batchDir, "phase7-real-comparison.json"),
    mod.formatReasoningBudgetRealJson(comparison),
    "utf-8",
  );

  // 2. Markdown
  writeFileSync(
    join(batchDir, "phase7-real-comparison.md"),
    mod.formatReasoningBudgetRealMarkdown(comparison),
    "utf-8",
  );

  // 3. scenario-level 明细（JSONL）
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
      budgetA: { tier: s.budgetA.tier, maxTurns: s.budgetA.budgetConfig.maxTurns },
      budgetB: { tier: s.budgetB.tier, maxTurns: s.budgetB.budgetConfig.maxTurns },
      budgetC: { tier: s.budgetC.tier, maxTurns: s.budgetC.budgetConfig.maxTurns },
      coverageA: s.metricsA.map((m) => m.mustVerify.coverageRatio),
      coverageB: s.metricsB.map((m) => m.mustVerify.coverageRatio),
      coverageC: s.metricsC.map((m) => m.mustVerify.coverageRatio),
      callsA: s.metricsA.map((m) => m.totalCalls),
      callsB: s.metricsB.map((m) => m.totalCalls),
      callsC: s.metricsC.map((m) => m.totalCalls),
      tokensA: s.metricsA.map((m) => m.totalEstimateTokens),
      tokensB: s.metricsB.map((m) => m.totalEstimateTokens),
      tokensC: s.metricsC.map((m) => m.totalEstimateTokens),
      stoppedA: s.metricsA.map((m) => m.stopped),
      stoppedB: s.metricsB.map((m) => m.stopped),
      stoppedC: s.metricsC.map((m) => m.stopped),
    }),
  );
  writeFileSync(join(batchDir, "scenarios.jsonl"), scenarioLines.join("\n") + "\n", "utf-8");

  const agg = comparison.aggregation;
  log(`批次 ${b + 1} 完成。`);
  log(`平均 mustVerify 覆盖率：A=${agg.A.avgCoverageRatio.toFixed(3)}，B=${agg.B.avgCoverageRatio.toFixed(3)}，C=${agg.C.avgCoverageRatio.toFixed(3)}`);
  log(`估算 token：A=${agg.A.totalEstimateTokens}，B=${agg.B.totalEstimateTokens}，C=${agg.C.totalEstimateTokens}`);
  log(`预算耗尽：A=${agg.A.budgetExhaustedCount}，B=${agg.B.budgetExhaustedCount}，C=${agg.C.budgetExhaustedCount}`);
  log(`B 组门禁全部通过：${comparison.gateB.allPassed}`);
  log(`C 组门禁全部通过：${comparison.gateC.allPassed}`);
  log(`产出：${join(batchDir, "phase7-real-comparison.md")}`);
}

log("全部批次完成。");
process.exit(0);