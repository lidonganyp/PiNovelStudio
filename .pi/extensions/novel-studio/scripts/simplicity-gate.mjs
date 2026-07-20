#!/usr/bin/env node
/**
 * PiNovelStudio — SIMPLICITY-GATE-1：CI 复杂度门禁
 *
 * 防止"自找的复杂度"回归，守护三 tsconfig 隔离与模块精简成果。
 *
 * 三道门禁：
 *   1. dist-eval gitignore 守护：dist-eval/ 必须在 .gitignore 中且不被 git 跟踪
 *   2. 模块行数门禁：生产编排模块单文件 ≤ 800 行（特殊情况需书面豁免）
 *   3. 生产闭包门禁：dist/ 必须存在且非空（fail-fast：未构建时 0 文件/0 行直接阻断，防止虚假通过）
 *
 * 用法：
 *   node scripts/simplicity-gate.mjs                    # 运行全部门禁，失败时 exit 1
 *   node scripts/simplicity-gate.mjs --check-dist-eval  # 仅检查 dist-eval gitignore
 *   node scripts/simplicity-gate.mjs --check-line-count # 仅检查模块行数
 *   node scripts/simplicity-gate.mjs --record-metrics   # 仅记录生产闭包指标
 *   node scripts/simplicity-gate.mjs --json-out <path>  # 输出 JSON 报告
 *
 * 约束：本脚本仅 import node 内建模块，不依赖任何项目源码。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const EXT_ROOT = resolve(__dirname, ".."); // .pi/extensions/novel-studio
const REPO_ROOT = resolve(EXT_ROOT, "..", "..", ".."); // d:\CODE\PiNovelStudio

// ============================================================================
// 配置
// ============================================================================

/** 单文件行数上限（项目约束：禁止单个编排模块超过约800行） */
const MAX_LINES_PER_MODULE = 800;

/** 需要检查行数的源码目录（相对 EXT_ROOT） */
const SCAN_DIRS = [
  "v2/core",
  "v2/adapters",
  "v2/learning",
  "v2/replay",
  "v2/governance",
  "handlers",
  "tools",
  "novelos",
];

/** 需要检查行数的根级源文件（相对 EXT_ROOT） */
const SCAN_FILES = ["index.ts"];

/**
 * 行数豁免清单（特殊情况书面豁免）。
 * 路径相对 EXT_ROOT，使用 posix 分隔符。
 * 新增豁免需在 PR 中说明理由。
 *
 * 从 scripts/simplicity-gate-exemptions.json 加载，支持：
 *   - path: 文件路径（posix）
 *   - lines: 记录的行数（豁免时的快照）
 *   - reason: 豁免理由
 *   - category: 分类（planned-refactor / eval-only / legacy-test-only）
 *
 * 门禁逻辑：
 *   - 文件在豁免清单中 → 跳过（不阻断）
 *   - 文件不在豁免清单中且 > 800 行 → 阻断（新违规）
 *   - 豁免文件被重构到 ≤800 行后应从清单移除（ratchet）
 */
const EXEMPTIONS_CONFIG_PATH = join(EXT_ROOT, "scripts", "simplicity-gate-exemptions.json");

function loadExemptions() {
  if (!existsSync(EXEMPTIONS_CONFIG_PATH)) {
    return { exemptions: new Map(), raw: { exemptions: [] } };
  }
  const raw = JSON.parse(readFileSync(EXEMPTIONS_CONFIG_PATH, "utf-8"));
  const exemptions = new Map();
  for (const e of raw.exemptions || []) {
    exemptions.set(e.path, e);
  }
  return { exemptions, raw };
}

/** 生产闭包指标输出路径（相对 EXT_ROOT） */
const METRICS_PATH = "reports/simplicity-metrics.json";

// ============================================================================
// 工具函数
// ============================================================================

function toRelPosix(absPath) {
  let rel = absPath;
  if (rel.startsWith(EXT_ROOT)) {
    rel = rel.slice(EXT_ROOT.length);
    if (rel.startsWith(sep)) rel = rel.slice(1);
  }
  return rel.split(sep).join("/");
}

function readLines(filePath) {
  return readFileSync(filePath, "utf-8").split(/\r?\n/);
}

/** 递归收集目录下所有 .ts 文件 */
function collectTsFiles(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  function walk(current) {
    for (const e of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".ts")) result.push(full);
    }
  }
  walk(dir);
  return result;
}

/** 递归收集目录下所有 .js 文件及行数 */
function collectJsFileStats(dir) {
  if (!existsSync(dir)) return { files: 0, lines: 0 };
  let files = 0;
  let lines = 0;
  function walk(current) {
    for (const e of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".js")) {
        files++;
        try {
          lines += readLines(full).length;
        } catch {
          // 跳过无法读取的文件
        }
      }
    }
  }
  walk(dir);
  return { files, lines };
}

// ============================================================================
// Gate 1: dist-eval gitignore 守护
// ============================================================================

function checkDistEvalGitignore() {
  const errors = [];
  const warnings = [];

  // 1. .gitignore 必须含 dist-eval/ 条目
  const gitignorePath = join(REPO_ROOT, ".gitignore");
  if (!existsSync(gitignorePath)) {
    errors.push(".gitignore 不存在（repo root）");
  } else {
    const gitignoreContent = readFileSync(gitignorePath, "utf-8");
    const hasDistEval = /^dist-eval\/\s*$/m.test(gitignoreContent);
    if (!hasDistEval) {
      errors.push(".gitignore 缺少 `dist-eval/` 条目（防止 dist-eval/ 构建产物再次进入 Git）");
    }
  }

  // 2. git 不得跟踪 dist-eval/ 下任何文件
  let trackedDistEvalFiles = [];
  try {
    const output = execSync("git ls-files -- dist-eval/", {
      cwd: EXT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
      windowsHide: true,
    }).trim();
    trackedDistEvalFiles = output ? output.split(/\r?\n/) : [];
  } catch (e) {
    warnings.push(`无法执行 git ls-files 检查 dist-eval/ 跟踪状态: ${e.message}`);
  }

  if (trackedDistEvalFiles.length > 0) {
    errors.push(
      `git 跟踪了 ${trackedDistEvalFiles.length} 个 dist-eval/ 文件（必须 git rm --cached 或加入 .gitignore）：\n` +
        trackedDistEvalFiles.slice(0, 10).map((f) => `  - ${f}`).join("\n") +
        (trackedDistEvalFiles.length > 10 ? `\n  ... 还有 ${trackedDistEvalFiles.length - 10} 个` : ""),
    );
  }

  return {
    gate: "dist-eval-gitignore",
    passed: errors.length === 0,
    errors,
    warnings,
    trackedDistEvalFileCount: trackedDistEvalFiles.length,
  };
}

// ============================================================================
// Gate 2: 模块行数门禁（≤ 800 行）
// ============================================================================

function checkLineCount() {
  const { exemptions, raw } = loadExemptions();
  const violations = [];
  const scanned = [];
  const exemptedHits = [];
  const staleExemptions = [];

  const allFiles = [];
  for (const dir of SCAN_DIRS) {
    const absDir = join(EXT_ROOT, dir);
    for (const f of collectTsFiles(absDir)) {
      allFiles.push(f);
    }
  }
  for (const f of SCAN_FILES) {
    const abs = join(EXT_ROOT, f);
    if (existsSync(abs)) allFiles.push(abs);
  }

  for (const file of allFiles) {
    const relPath = toRelPosix(file);
    const lines = readLines(file).length;
    scanned.push({ path: relPath, lines });

    if (lines > MAX_LINES_PER_MODULE) {
      const exempt = exemptions.get(relPath);
      if (exempt) {
        exemptedHits.push({
          path: relPath,
          lines,
          recordedLines: exempt.lines,
          category: exempt.category,
          reason: exempt.reason,
        });
      } else {
        violations.push({
          path: relPath,
          lines,
          limit: MAX_LINES_PER_MODULE,
          excess: lines - MAX_LINES_PER_MODULE,
        });
      }
    }
  }

  // 检查过期豁免：豁免清单中的文件已 ≤800 行（已被重构）或已不存在
  for (const [path, exempt] of exemptions) {
    const scannedEntry = scanned.find((s) => s.path === path);
    if (!scannedEntry) {
      staleExemptions.push({ path, reason: "文件不存在（可能已删除/重命名）" });
    } else if (scannedEntry.lines <= MAX_LINES_PER_MODULE) {
      staleExemptions.push({
        path,
        lines: scannedEntry.lines,
        recordedLines: exempt.lines,
        reason: `文件已 ≤${MAX_LINES_PER_MODULE} 行（${scannedEntry.lines}），应从豁免清单移除（ratchet）`,
      });
    }
  }

  scanned.sort((a, b) => b.lines - a.lines);

  return {
    gate: "line-count",
    passed: violations.length === 0,
    limit: MAX_LINES_PER_MODULE,
    scannedCount: scanned.length,
    topFiles: scanned.slice(0, 10),
    violations,
    exemptedCount: exemptedHits.length,
    exemptedHits,
    staleExemptionCount: staleExemptions.length,
    staleExemptions,
    exemptionsConfigPath: "scripts/simplicity-gate-exemptions.json",
  };
}

// ============================================================================
// Gate 3: 生产闭包门禁（dist/ 必须存在且非空 — fail-fast）
// ============================================================================

function recordMetrics() {
  const distDir = join(EXT_ROOT, "dist");
  const errors = [];

  if (!existsSync(distDir)) {
    errors.push("dist/ 目录不存在 — 未构建生产闭包。请先运行 `npm run build:prod`（或 `npm run build`）再运行门禁。");
  }

  const stats = collectJsFileStats(distDir);

  if (stats.files === 0) {
    errors.push("dist/ 目录为空（0 个 .js 文件）— 生产闭包未构建，门禁 fail-fast 防止 0 文件/0 行虚假通过。请先运行 `npm run build:prod`（或 `npm run build`）。");
  }

  const report = {
    generatedAt: new Date().toISOString(),
    gate: "production-closure-metrics",
    distDir: "dist/",
    fileCount: stats.files,
    totalLines: stats.lines,
    targetLinesRange: "6万-8万行（生产入口闭包目标）",
    note: errors.length === 0
      ? "生产闭包已构建；指标用于追踪收敛趋势"
      : "生产闭包未构建 — fail-fast 阻断",
  };

  const metricsFullPath = join(EXT_ROOT, METRICS_PATH);
  mkdirSync(dirname(metricsFullPath), { recursive: true });
  writeFileSync(metricsFullPath, JSON.stringify(report, null, 2), "utf-8");

  return {
    gate: "production-closure-metrics",
    passed: errors.length === 0, // fail-fast：dist/ 缺失或空时阻断
    errors,
    ...report,
    metricsPath: METRICS_PATH,
  };
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(argv) {
  let checkDistEval = false;
  let checkLineCnt = false;
  let recordMetricsOnly = false;
  let jsonOut = null;
  let runAll = true;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check-dist-eval") { checkDistEval = true; runAll = false; }
    else if (a === "--check-line-count") { checkLineCnt = true; runAll = false; }
    else if (a === "--record-metrics") { recordMetricsOnly = true; runAll = false; }
    else if (a === "--json-out") { jsonOut = argv[++i]; }
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return { checkDistEval, checkLineCnt, recordMetricsOnly, jsonOut, runAll };
}

function printHelp() {
  console.log(`PiNovelStudio SIMPLICITY-GATE-1 — CI 复杂度门禁

用法:
  node scripts/simplicity-gate.mjs [options]

选项:
  --check-dist-eval    仅检查 dist-eval/ gitignore 守护
  --check-line-count   仅检查模块行数（≤ ${MAX_LINES_PER_MODULE} 行）
  --record-metrics     仅检查生产闭包门禁（dist/ 必须存在且非空，fail-fast）
  --json-out <path>    输出 JSON 报告到指定路径
  -h, --help           显示帮助

默认（无选项）：运行全部门禁，任一阻断门禁失败则 exit 1。
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = [];

  if (args.runAll || args.checkDistEval) {
    results.push(checkDistEvalGitignore());
  }
  if (args.runAll || args.checkLineCnt) {
    results.push(checkLineCount());
  }
  if (args.runAll || args.recordMetricsOnly) {
    results.push(recordMetrics());
  }

  // 全部门禁均为阻断性（含 production-closure-metrics fail-fast）
  const allPassed = results.every((r) => r.passed);

  // 人类可读摘要
  console.log("=== SIMPLICITY-GATE-1 ===");
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    if (r.gate === "dist-eval-gitignore") {
      console.log(`[${status}] ${r.gate}: tracked dist-eval files = ${r.trackedDistEvalFileCount}`);
      for (const e of r.errors) console.log(`       ERROR: ${e}`);
      for (const w of r.warnings) console.log(`       WARN:  ${w}`);
    } else if (r.gate === "line-count") {
      console.log(`[${status}] ${r.gate}: ${r.scannedCount} files scanned, limit = ${r.limit}, violations = ${r.violations.length}, exempted = ${r.exemptedCount}, stale = ${r.staleExemptionCount}`);
      for (const v of r.violations) {
        console.log(`       OVER:  ${v.path} = ${v.lines} 行 (超 ${v.excess} 行) — 新违规，需重构或加豁免`);
      }
      for (const s of r.staleExemptions) {
        console.log(`       STALE: ${s.path} — ${s.reason}`);
      }
      console.log(`       Top 5 largest:`);
      for (const f of r.topFiles.slice(0, 5)) {
        const ex = r.exemptedHits.find((e) => e.path === f.path);
        const flag = f.lines > r.limit ? (ex ? " (exempted)" : " ⚠") : "";
        console.log(`         ${f.lines.toString().padStart(5)} ${f.path}${flag}`);
      }
    } else if (r.gate === "production-closure-metrics") {
      console.log(`[${status}] ${r.gate}: dist/ = ${r.fileCount} files / ${r.totalLines} lines → ${r.metricsPath}`);
      for (const e of r.errors) console.log(`       ERROR: ${e}`);
    }
  }

  // JSON 输出
  if (args.jsonOut) {
    const jsonPath = args.jsonOut;
    const fullPath = jsonPath;
    mkdirSync(dirname(resolve(fullPath)), { recursive: true });
    writeFileSync(fullPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      allPassed,
      results,
    }, null, 2), "utf-8");
  }

  if (!allPassed) {
    console.error("\n[SIMPLICITY-GATE-1] 门禁失败，exit 1");
    process.exit(1);
  }
  console.log("\n[SIMPLICITY-GATE-1] 全部门禁通过");
}

main();
