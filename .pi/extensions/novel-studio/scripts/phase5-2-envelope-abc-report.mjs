#!/usr/bin/env node
/**
 * PHASE5-2-ENVELOPE-ABC-REPORT CLI：Phase 5.2 紧凑结果 envelope 确定性 A/B/C 报告生成
 *
 * 运行 tool-ab-envelope-runner 的确定性 A/B/C replay（零模型调用），把结果写入项目根目录
 * reports/phase5-2-envelope-abc/：
 *   envelope-abc-comparison.json            完整 A/B/C 对比（JSON）
 *   envelope-abc-comparison.md              人类可读对比报告（含门禁与三臂明细）
 *   trajectory/{scenarioId}-{A|B|C}.jsonl   每场景每臂的持久化 trajectory 副本
 *
 * 用法：
 *   node scripts/phase5-2-envelope-abc-report.mjs [--output <dir>]
 *
 * 选项：
 *   --output <dir>   输出目录（默认 <projectRoot>/reports/phase5-2-envelope-abc）
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
  process.stdout.write(`PHASE5-2-ENVELOPE-ABC-REPORT CLI：Phase 5.2 envelope 确定性 A/B/C 报告生成

用法：
  node scripts/phase5-2-envelope-abc-report.mjs [--output <dir>]

选项：
  --output <dir>   输出目录（默认 reports/phase5-2-envelope-abc）

产物：
  envelope-abc-comparison.json            完整 A/B/C 对比（JSON）
  envelope-abc-comparison.md              人类可读对比报告（含门禁与三臂明细）
  trajectory/{scenarioId}-{A|B|C}.jsonl   每场景每臂的持久化 trajectory 副本
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
  : join(PROJECT_ROOT, "reports", "phase5-2-envelope-abc");

const MODULE_PATH = pathToFileURL(
  join(EXT_ROOT, "dist-eval", "novelos", "eval", "tool-ab-envelope-runner.js"),
).href;

function log(message) {
  process.stderr.write(`[phase5-2-envelope-abc-report] ${message}\n`);
}

// ── 动态 import dist-eval 模块 ────────────────────────────────────────────
const mod = await import(MODULE_PATH);

log("运行 Phase 5.2 envelope A/B/C 确定性 replay（零模型调用、确定性）...");
const comparison = await mod.runCompactEnvelopeAbcReplay();

const trajDir = join(OUTPUT_DIR, "trajectory");
mkdirSync(trajDir, { recursive: true });

// 1. JSON
writeFileSync(
  join(OUTPUT_DIR, "envelope-abc-comparison.json"),
  mod.formatCompactEnvelopeAbcJson(comparison),
  "utf-8",
);

// 2. Markdown
writeFileSync(
  join(OUTPUT_DIR, "envelope-abc-comparison.md"),
  mod.formatCompactEnvelopeAbcMarkdown(comparison),
  "utf-8",
);

// 3. trajectory 副本（每场景每臂 JSONL）
// 注意：trajectory key 形如 "SC1-canon-fact:A"，含冒号在 Windows 文件名中非法，
// 故把 ":" 替换为 "-" 作为文件名（key 内部语义不变，仅用于落盘命名）。
const trajectory = mod.buildEnvelopeAbcTrajectory(comparison);
let trajectoryFiles = 0;
for (const [key, entries] of Object.entries(trajectory)) {
  const safeName = key.replaceAll(":", "-");
  writeFileSync(join(trajDir, `${safeName}.jsonl`), mod.formatTrajectoryJsonl(entries), "utf-8");
  trajectoryFiles++;
}

log("报告完成。");
log(`场景数：${comparison.scenarios.length}`);
log(`工具面：A=${comparison.aggregation.A.toolSurface}，B=${comparison.aggregation.B.toolSurface}，C=${comparison.aggregation.C.toolSurface}`);
log(`返回字符：B=${comparison.aggregation.B.totalResultChars}，C=${comparison.aggregation.C.totalResultChars}（C<B=${comparison.gate.resultCharsReduced}）`);
log(`平均 mustVerify 覆盖率：B=${comparison.aggregation.B.avgCoverageRatio.toFixed(3)}，C=${comparison.aggregation.C.avgCoverageRatio.toFixed(3)}`);
log(`全部通过：${comparison.gate.allPassed}`);
log(`JSON：${join(OUTPUT_DIR, "envelope-abc-comparison.json")}`);
log(`Markdown：${join(OUTPUT_DIR, "envelope-abc-comparison.md")}`);
log(`trajectory 副本：${trajectoryFiles} 个（${trajDir}）`);

process.exit(0);