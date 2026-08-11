#!/usr/bin/env node
/**
 * REASONING-BUDGET-REAL-BASELINE：在隔离 eval 副本上运行真实 Gemini 章节，
 * 采集带 inputTokens/outputTokens 的 quality trace，用于推理预算 Phase 1 基线。
 *
 * 约束：
 *   - 不修改原 workspaces/xinmo；只在隔离副本 reports/reasoning-budget-baseline/workspaces/xinmo-eval 操作
 *   - 固定 v2_rawstage2_gemini31 / Gemini 3.1 Pro Preview / 默认 A 上下文 / 9 专用工具 / DISABLE_FALLBACK=1
 *   - 只采集 telemetry，不改压缩参数、预算策略、production pointer
 *
 * 用法：
 *   node scripts/reasoning-budget-real-baseline.mjs --chapters 22,23,24
 *
 * 选项：
 *   --chapters <n,n,...>  要生成的章节号（默认 22,23,24）
 *   --workspace <id>      隔离副本 workspaceId（默认 xinmo-eval）
 *   --base-dir <path>     隔离副本所在目录（默认 reports/reasoning-budget-baseline）
 *   --help                打印帮助
 */
import { parseArgs } from "node:util";
import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { values } = parseArgs({
  options: {
    "chapters": { type: "string", default: "22,23,24" },
    "workspace": { type: "string", default: "xinmo-eval" },
    "base-dir": { type: "string" },
    "help": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`REASONING-BUDGET-REAL-BASELINE：真实 Gemini 章节生成 + trace 采集

用法：
  node scripts/reasoning-budget-real-baseline.mjs --chapters 22,23,24

选项：
  --chapters <n,n,...>  要生成的章节号（默认 22,23,24）
  --workspace <id>      隔离副本 workspaceId（默认 xinmo-eval）
  --base-dir <path>     隔离副本所在目录（默认 reports/reasoning-budget-baseline）
`);
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = resolve(__filename, "..");
const EXTENSION_ROOT = resolve(SCRIPT_DIR, "..");
const PROJECT_ROOT = resolve(EXTENSION_ROOT, "..", "..", "..");
const BASE_DIR = values["base-dir"]
  ? resolve(values["base-dir"])
  : join(PROJECT_ROOT, "reports", "reasoning-budget-baseline");
const WORKSPACE_ID = values.workspace;
// 隔离副本实际在项目根 workspaces/ 下（getProjectRoot 解析到 PROJECT_ROOT）
const WORKSPACE_DIR = join(PROJECT_ROOT, "workspaces", WORKSPACE_ID);

const chapters = values.chapters.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);

if (chapters.length === 0) {
  console.error("无有效章节号");
  process.exit(1);
}
if (!existsSync(join(WORKSPACE_DIR, "config.json"))) {
  console.error(`隔离副本不存在或缺少 config.json: ${WORKSPACE_DIR}`);
  console.error("请先复制 xinmo workspace 到该目录。");
  process.exit(1);
}

function log(msg) {
  process.stderr.write(`[reasoning-budget-real] ${msg}\n`);
}

// ── 环境约束 ────────────────────────────────────────────────────────────
// 不设置 PINOVEL_PROJECT_ROOT：让 getProjectRoot() 正确解析到 d:\CODE\PiNovelStudio
// （isProjectRoot 检查 .pi/extensions/novel-studio + docs/top-tier-...-plan.md）
// 隔离副本 workspaces/xinmo-eval 在项目根下，不动原 workspaces/xinmo
process.env.PINOVEL_DISABLE_FALLBACK = "1";
// PINOVEL_DEV_MODE=1：eval-only bypass g6_release_gate（环境指纹不匹配）
// 合法用途：production-release-gate.ts 决策顺序第 1 步，devMode=true，
// releaseId/environmentFingerprint/approvalRef 全部 null，不修改 active pointer。
// 本轮只采集 telemetry，不改压缩参数/预算策略/production pointer。
process.env.PINOVEL_DEV_MODE = "1";

log(`隔离副本: ${WORKSPACE_DIR}`);
log(`章节: ${chapters.join(", ")}`);
log(`DISABLE_FALLBACK=1, Gemini 3.1 Pro Preview, 默认 A 上下文, 9 专用工具`);
log(``+ `只采集 telemetry，不改压缩参数/预算策略/production pointer`);

// ── 加载生产入口 ────────────────────────────────────────────────────────
const extPath = join(EXTENSION_ROOT, "dist", "index.js");
if (!existsSync(extPath)) {
  console.error(`生产构建产物不存在: ${extPath}`);
  console.error("请先运行 npm run build:prod");
  process.exit(1);
}

const extModule = await import(pathToFileURL(extPath).href);
const extensionSetup = extModule.default;

const registeredTools = {};
const ui = {
  notify(msg, level) {
    log(`[PI UI ${level}] ${msg}`);
  },
};
const pi = {
  registerTool(toolDef) {
    registeredTools[toolDef.name] = toolDef;
    return toolDef;
  },
  registerCommand(cmdDef) {
    return cmdDef;
  },
  on(_event, _handler) {},
  ui,
};

extensionSetup(pi);
const generateTool = registeredTools["novel_generate_chapter"];
if (!generateTool) {
  console.error("novel_generate_chapter 工具未注册");
  process.exit(1);
}
log("生产扩展已加载，novel_generate_chapter 已注册");

// ── 逐章生成 ────────────────────────────────────────────────────────────
const results = [];
const traceCollectorDir = join(BASE_DIR, "traces");
mkdirSync(traceCollectorDir, { recursive: true });

for (const chapterNumber of chapters) {
  const chapterId = String(chapterNumber);
  log(`\n${"=".repeat(70)}`);
  log(`  生成第 ${chapterNumber} 章 (workspace=${WORKSPACE_ID})`);
  log(`${"=".repeat(70)}`);

  const startTime = Date.now();
  let result;
  let error = null;
  try {
    result = await generateTool.execute(
      `reasoning-budget-baseline-${chapterId}-${Date.now()}`,
      { workspaceId: WORKSPACE_ID, chapterId, chapterNumber },
      undefined,
      (update) => {
        const msg = typeof update === "string" ? update : JSON.stringify(update).slice(0, 200);
        log(`  [进度] ${msg}`);
      },
      { cwd: PROJECT_ROOT, ui },
    );
  } catch (err) {
    error = err;
    log(`  [异常] ${err.message}`);
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const details = result?.details || result || {};
  const status = details.status || (result?.isError ? "error" : (error ? "error" : "unknown"));

  log(`  [结果] 耗时 ${elapsedSec}s, status=${status}`);

  // 采集 trace 副本（trace 实际写入 PROJECT_ROOT/workspaces/xinmo-eval/traces/）
  const tracePath = join(PROJECT_ROOT, "workspaces", WORKSPACE_ID, "traces", `${chapterId}-quality-trace.json`);
  const traceArchivePath = join(traceCollectorDir, `${chapterId}-quality-trace.json`);
  let traceCopied = false;
  if (existsSync(tracePath)) {
    copyFileSync(tracePath, traceArchivePath);
    traceCopied = true;
    log(`  trace 已复制到 ${traceArchivePath}`);
  } else {
    log(`  [警告] trace 不存在: ${tracePath}`);
  }

  results.push({
    chapterNumber,
    chapterId,
    status,
    isError: result?.isError || !!error,
    elapsedSec: parseFloat(elapsedSec),
    traceCopied,
    traceArchivePath: traceCopied ? traceArchivePath : null,
    error: error?.message || null,
  });
}

// ── 汇总 ────────────────────────────────────────────────────────────────
log(`\n${"=".repeat(70)}`);
log("  采集汇总");
log(`${"=".repeat(70)}`);
for (const r of results) {
  const icon = r.traceCopied ? "OK" : "FAIL";
  log(`  第${r.chapterNumber}章: ${icon} status=${r.status} 耗时=${r.elapsedSec}s trace=${r.traceCopied ? "已采集" : "缺失"}`);
}

const successCount = results.filter((r) => r.traceCopied && !r.isError).length;
log(`\n成功采集 ${successCount}/${results.length} 章的 trace`);

if (successCount > 0) {
  const tracePaths = results.filter((r) => r.traceCopied).map((r) => r.traceArchivePath).join(",");
  log(`\n运行基线聚合：`);
  log(`  node scripts/reasoning-budget-baseline.mjs --trace ${tracePaths}`);
}

// 写入采集元数据
const metaPath = join(BASE_DIR, "real-baseline-meta.json");
const meta = {
  workspaceId: WORKSPACE_ID,
  workspaceDir: WORKSPACE_DIR,
  chapters: results,
  successCount,
  config: {
    route: "v2_rawstage2_gemini31",
    model: "gemini-3.1-pro-preview",
    context: "A (default)",
    tools: "9 dedicated",
    disableFallback: true,
  },
  collectedAt: new Date().toISOString(),
};
import("node:fs").then(({ writeFileSync }) => {
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
  log(`元数据已写入 ${metaPath}`);
});