#!/usr/bin/env node
/**
 * PHASE4-TOOL-AB-REAL-REPORT CLI：Phase 4.2 真实模型 A/B 报告生成（默认 dry-run）
 *
 * 运行 tool-ab-real-runner 的模型自主决策 replay。默认使用 dry-run stub（确定性，
 * 零 API 调用），仅验证 runner 框架；真实模型需显式 `--mode real` 并注入已授权的
 * modelFn（当前不支持 CLI 注入，需改代码）。结果写入项目根目录
 * reports/phase4-tool-ab-real/：
 *   real-ab-comparison.json            完整 A/B 对比（JSON）
 *   real-ab-comparison.md              人类可读对比报告（含"有效证据引用率"与无效分类明细）
 *   trajectory/{scenarioId}-{A|B}-{seed}.jsonl  每场景每 arm 每 seed 的持久化 trajectory 副本
 *
 * 用法：
 *   node scripts/tool-ab-real-report.mjs [--output <dir>] [--mode dry-run]
 *
 * 选项：
 *   --output <dir>   输出目录（默认 <projectRoot>/reports/phase4-tool-ab-real）
 *   --mode <dry-run|real>   执行模式（默认 dry-run；real 需 --require-auth + GLM/Doubao 授权）
 *   --route <name>   real 模式测试路由（默认 narrator_testing_glm，须在 GLM/Doubao allowlist 内）
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
    "maxTokens": { type: "string" },
    "scenario": { type: "string" },
    "require-auth": { type: "boolean", default: false },
    "help": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`PHASE4-TOOL-AB-REAL-REPORT CLI：Phase 4.2 真实模型 A/B 报告生成

用法：
  node scripts/tool-ab-real-report.mjs [--output <dir>] [--mode dry-run]

选项：
  --output <dir>   输出目录（默认 <projectRoot>/reports/phase4-tool-ab-real）
  --mode <dry-run|real>   执行模式（默认 dry-run；real 注入真实模型决策 fn，需 GLM/Doubao 授权）
  --route <name>   real 模式使用的测试路由（默认 narrator_testing_glm）
  --maxTokens <n>  real 模式单次输出上限 token（默认 2048）
  --require-auth   real 模式显式授权开关：确认已获 GLM/Doubao 临时调用授权。
                   必须显式传入，否则 real 模式拒绝执行（默认 dry-run 无需）。

产物：
  real-ab-comparison.json            完整 A/B 对比（JSON）
  real-ab-comparison.md              人类可读对比报告
  trajectory/{场景}-{A|B}-{seed}.jsonl  每场景每 arm 每 seed 的 persistence trajectory 副本
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
  : join(PROJECT_ROOT, "reports", "phase4-tool-ab-real");

const MODULE_PATH = pathToFileURL(
  join(EXT_ROOT, "dist-eval", "novelos", "eval", "tool-ab-real-runner.js"),
).href;

function log(message) {
  process.stderr.write(`[tool-ab-real-report] ${message}\n`);
}

// ── 动态 import dist-eval 模块 ────────────────────────────────────────────
const mod = await import(MODULE_PATH);

const mode = values.mode === "real" ? "real" : "dry-run";
let modelFn = undefined;
if (mode === "real") {
  // 项目记忆硬约束：临时/批量测试只用 GLM/Doubao，必须 PINOVEL_DISABLE_FALLBACK=1
  // + PINOVEL_BENCHMARK_COST_PROFILE=package_screening（provider allowlist 守卫）。
  process.env.PINOVEL_PROJECT_ROOT = PROJECT_ROOT;
  process.env.PINOVEL_DISABLE_FALLBACK = "1";
  process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";

  // 显式授权开关：real 模式必须显式 --require-auth 确认 GLM/Doubao 临时授权，
  // 防止在未授权情况下无意识触发真实模型计费调用。
  if (!values["require-auth"]) {
    log("real 模式拒绝执行：未传入 --require-auth 显式授权开关。");
    log("请确认已获 GLM/Doubao 临时调用授权，并显式加 --require-auth 后重试。");
    process.exit(1);
  }

  // route allowlist：仅允许 GLM/Doubao 测试路由（provider-gated），
  // 禁止用户凭 --route 指定按量模型（GPT/Claude）或其他生产路由。
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
  modelFn = await mod.createRealToolAbModelDecide({
    route,
    maxTokens: values.maxTokens ? Number(values.maxTokens) : 2048,
    timeoutMs: 120000,
    temperature: 0.72,
  });
}

log(`运行 Phase 4.2 模型自主决策 A/B replay（模式=${mode}，dry-run 零 API）...`);
const seedCount = values.samples ? Math.max(1, parseInt(values.samples, 10)) : 3;
const seeds = Array.from({ length: seedCount }, (_, i) => i);

// --scenario：仅重跑指定高信号场景（如 SC1-canon-fact），用于定向诊断。
let scenarios;
if (values.scenario) {
  const all = mod.getBaselineScenarios ? mod.getBaselineScenarios() : undefined;
  const ids = values.scenario.split(",").map((s) => s.trim()).filter(Boolean);
  scenarios = all ? all.filter((s) => ids.includes(s.id)) : undefined;
  if (scenarios && scenarios.length === 0) {
    log(`--scenario 未匹配到任何高信号场景：${ids.join(",")}（合法：SC1-canon-fact / SC6-low-risk-no-retrieval / SC7-multi-tool-mixed）`);
    process.exit(1);
  }
}

const comparison = await mod.runRealToolAbReplay({ modelFn, seeds, scenarios });

const trajDir = join(OUTPUT_DIR, "trajectory");
mkdirSync(trajDir, { recursive: true });

// 1. JSON
writeFileSync(
  join(OUTPUT_DIR, "real-ab-comparison.json"),
  mod.formatRealToolAbJson(comparison),
  "utf-8",
);

// 2. Markdown
writeFileSync(
  join(OUTPUT_DIR, "real-ab-comparison.md"),
  mod.formatRealToolAbMarkdown(comparison),
  "utf-8",
);

// 3. trajectory 副本（每场景每 arm 每 seed 的 JSONL）
// key 形如 "SC1-canon-fact:A:0"，冒号在 Windows 文件名中非法，替换为 "-"。
const trajectory = mod.buildRealToolAbTrajectory(comparison);
let trajectoryFiles = 0;
for (const [key, entries] of Object.entries(trajectory)) {
  const safeName = key.replaceAll(":", "-");
  const file = join(trajDir, `${safeName}.jsonl`);
  writeFileSync(file, mod.formatRealTrajectoryJsonl(entries), "utf-8");
  trajectoryFiles++;
}

log("报告完成。");
log(`场景数：${comparison.scenarios.length}（每场景 × seeds=${comparison.scenarios[0]?.A.length ?? 0}）`);
log(`模式：${comparison.mode}`);
log(`A 组工具面：${comparison.aggregation.A.toolSurface}，B 组工具面：${comparison.aggregation.B.toolSurface}`);
log(`schema token：A=${comparison.aggregation.A.schemaTokenCost}，B=${comparison.aggregation.B.schemaTokenCost}`);
log(`有效证据引用率：A=${comparison.aggregation.A.sourceRefCompleteness.toFixed(3)}，B=${comparison.aggregation.B.sourceRefCompleteness.toFixed(3)}`);
log(`平均 mustVerify 覆盖率：A=${comparison.aggregation.A.avgCoverageRatio.toFixed(3)}，B=${comparison.aggregation.B.avgCoverageRatio.toFixed(3)}`);
log(`改善负担项：${comparison.gate.improvedBurdenMetrics.join(", ") || "无"}`);
log(`全部通过：${comparison.gate.allPassed}`);
log(`JSON：${join(OUTPUT_DIR, "real-ab-comparison.json")}`);
log(`Markdown：${join(OUTPUT_DIR, "real-ab-comparison.md")}`);
log(`trajectory 副本：${trajectoryFiles} 个（${trajDir}）`);

process.exit(0);