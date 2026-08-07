#!/usr/bin/env node
/**
 * TOOL-INTERFACE-BASELINE CLI：Phase 4 pre-baseline replay
 *
 * 冻结「当前 9 个专用工具」行为作为 Phase 3（统一工具结果格式）的对照组。
 * 直接驱动 createNarrativeTools 真实实现（零模型调用、确定性）。
 *
 * 用法：
 *   node scripts/tool-interface-baseline.mjs [--output <dir>]
 *
 * 选项：
 *   --output <dir>   输出目录（默认 reports/）
 *
 * 产物：
 *   reports/tool-interface-baseline.json   完整基线（7 场景 × 9 指标）
 *   reports/tool-interface-baseline.md     人类可读对比报告 + Phase 3 兼容性要求
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
  process.stdout.write(`TOOL-INTERFACE-BASELINE CLI：Phase 4 pre-baseline replay

用法：
  node scripts/tool-interface-baseline.mjs [--output <dir>]

选项：
  --output <dir>   输出目录（默认 reports/）

产物：
  reports/tool-interface-baseline.json   完整基线（7 场景 × 9 指标）
  reports/tool-interface-baseline.md     人类可读对比报告 + Phase 3 兼容性要求
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
  : join(PROJECT_ROOT, "reports");

const MODULE_PATH = pathToFileURL(
  join(EXT_ROOT, "dist-eval", "novelos", "eval", "tool-interface-baseline.js"),
).href;

function log(message) {
  process.stderr.write(`[tool-interface-baseline] ${message}\n`);
}

// ── 动态 import dist-eval 模块 ────────────────────────────────────────────
const mod = await import(MODULE_PATH);

log("运行 Phase 4 pre-baseline replay（零模型调用、确定性）...");
const baseline = await mod.runToolInterfaceBaseline();

const jsonPath = join(OUTPUT_DIR, "tool-interface-baseline.json");
const mdPath = join(OUTPUT_DIR, "tool-interface-baseline.md");

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(jsonPath, mod.formatToolInterfaceBaselineJson(baseline), "utf-8");
writeFileSync(mdPath, mod.formatToolInterfaceBaselineMarkdown(baseline), "utf-8");

log("基线完成。");
log(`场景数：${baseline.summary.scenarioCount}`);
log(`总调用：${baseline.summary.totalCalls}`);
log(`重复查询：${baseline.summary.totalDuplicateQueries}`);
log(`平均 mustVerify 覆盖率：${baseline.summary.avgCoverageRatio.toFixed(2)}`);
log(`JSON：${jsonPath}`);
log(`Markdown：${mdPath}`);

process.exit(0);