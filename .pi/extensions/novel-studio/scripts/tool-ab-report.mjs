#!/usr/bin/env node
/**
 * PHASE4-TOOL-AB-REPORT CLI：Phase 4 工具接口 A/B 确定性报告生成
 *
 * 运行 tool-ab-runner 的确定性 A/B replay（零模型调用），把结果写入项目根目录
 * reports/phase4-tool-ab/：
 *   ab-comparison.json            完整 A/B 对比（JSON）
 *   ab-comparison.md              人类可读对比报告（含"有效证据引用率"与无效分类明细）
 *   trajectory/{scenarioId}-{A|B}.jsonl  每场景每组的持久化 trajectory 副本
 *
 * 用法：
 *   node scripts/tool-ab-report.mjs [--output <dir>]
 *
 * 选项：
 *   --output <dir>   输出目录（默认 <projectRoot>/reports/phase4-tool-ab）
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
  process.stdout.write(`PHASE4-TOOL-AB-REPORT CLI：Phase 4 工具接口 A/B 确定性报告生成

用法：
  node scripts/tool-ab-report.mjs [--output <dir>]

选项：
  --output <dir>   输出目录（默认 reports/phase4-tool-ab）

产物：
  ab-comparison.json            完整 A/B 对比（JSON）
  ab-comparison.md              人类可读对比报告（含"有效证据引用率"与无效分类明细）
  trajectory/{scenarioId}-{A|B}.jsonl  每场景每组的持久化 trajectory 副本
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
  : join(PROJECT_ROOT, "reports", "phase4-tool-ab");

const MODULE_PATH = pathToFileURL(
  join(EXT_ROOT, "dist-eval", "novelos", "eval", "tool-ab-runner.js"),
).href;

function log(message) {
  process.stderr.write(`[tool-ab-report] ${message}\n`);
}

// ── 动态 import dist-eval 模块 ────────────────────────────────────────────
const mod = await import(MODULE_PATH);

log("运行 Phase 4 A/B 确定性 replay（零模型调用、确定性）...");
const comparison = await mod.runToolAbReplay();

const trajDir = join(OUTPUT_DIR, "trajectory");
mkdirSync(trajDir, { recursive: true });

// 1. JSON
writeFileSync(join(OUTPUT_DIR, "ab-comparison.json"), mod.formatToolAbJson(comparison), "utf-8");

// 2. Markdown
writeFileSync(join(OUTPUT_DIR, "ab-comparison.md"), mod.formatToolAbMarkdown(comparison), "utf-8");

// 3. trajectory 副本（每场景每组的 JSONL）
// 注意：trajectory key 形如 "SC1-canon-fact:A"，含冒号在 Windows 文件名中非法，
// 故把 ":" 替换为 "-" 作为文件名（key 内部语义不变，仅用于落盘命名）。
const trajectory = mod.buildToolAbTrajectory(comparison);
let trajectoryFiles = 0;
for (const [key, entries] of Object.entries(trajectory)) {
  const safeName = key.replaceAll(":", "-");
  const file = join(trajDir, `${safeName}.jsonl`);
  writeFileSync(file, mod.formatTrajectoryJsonl(entries), "utf-8");
  trajectoryFiles++;
}

log("报告完成。");
log(`场景数：${comparison.scenarios.length}`);
log(`A 组工具面：${comparison.aggregation.A.toolSurface}，B 组工具面：${comparison.aggregation.B.toolSurface}`);
log(`有效证据引用率：A=${comparison.aggregation.A.sourceRefCompleteness.toFixed(3)}，B=${comparison.aggregation.B.sourceRefCompleteness.toFixed(3)}`);
log(`平均 mustVerify 覆盖率：A=${comparison.aggregation.A.avgCoverageRatio.toFixed(3)}，B=${comparison.aggregation.B.avgCoverageRatio.toFixed(3)}`);
log(`全部通过：${comparison.gate.allPassed}`);
log(`JSON：${join(OUTPUT_DIR, "ab-comparison.json")}`);
log(`Markdown：${join(OUTPUT_DIR, "ab-comparison.md")}`);
log(`trajectory 副本：${trajectoryFiles} 个（${trajDir}）`);

process.exit(0);