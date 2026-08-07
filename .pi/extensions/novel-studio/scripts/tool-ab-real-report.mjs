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
 *   --mode <dry-run|real>   执行模式（默认 dry-run；real 需代码层面注入已授权 modelFn）
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
  --mode <dry-run|real>   执行模式（默认 dry-run；real 需授权模型注入）

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
if (mode === "real") {
  log("注意：--mode real 需要代码层面注入已授权的 modelFn（createRealModelDecide）。");
  log("当前未获得临时模型调用授权，强制回退 dry-run，不执行真实 API 调用。");
}

log(`运行 Phase 4.2 模型自主决策 A/B replay（模式=${mode}，dry-run 零 API）...`);
const comparison = await mod.runRealToolAbReplay();

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