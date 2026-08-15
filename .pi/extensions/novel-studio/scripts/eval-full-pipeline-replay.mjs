#!/usr/bin/env node
/**
 * F5 - 完整公共入口离线回放 CLI（EvalFixtureV1 -> runFullPipelineReplay）
 *
 * 消费 dist-eval/eval/full-pipeline-replay-runner.js（需先 npm run build 或
 * npm run build:eval）。支持全部五种回放模式（stub / recorded / synthetic /
 * dev_real_model / production_like），fixture 契约与隔离前置由 runner 内部
 * fail-closed 校验。
 *
 * 用法：
 *   node scripts/eval-full-pipeline-replay.mjs --fixture <path> [--fixture <path2> ...]
 *   node scripts/eval-full-pipeline-replay.mjs --fixtures-dir <dir>
 *   可选：--out <dir>              报告目录（默认 reports/eval-full-pipeline-replay）
 *         --run-id <id>            运行标识（默认自动生成）
 *         --timeout-ms <n>         单样本调用超时覆盖
 *         --archive-root <dir>     归档根（默认 .pi/eval-replay-archives）
 *         --scratch-parent <dir>   scratch 父目录（默认 .pi/eval-scratch）
 *
 * 输出：
 *   {out}/report.json   完整 FullPipelineReplayRunReport
 *   {out}/report.md     样本状态 / 失败归因 / 隔离违规摘要
 *   {archiveRoot}/{runId}/   逐样本归档（trace / result / invocation / manifest）
 *
 * CI：所有样本 completed 且零隔离违规 -> exit 0；否则 exit 1
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");
const DEFAULT_OUT_DIR = join(EXT_ROOT, "reports", "eval-full-pipeline-replay");

function usageAndExit() {
  const usage = [
    "用法：node scripts/eval-full-pipeline-replay.mjs --fixture <path> [--fixture <path2> ...]",
    "      node scripts/eval-full-pipeline-replay.mjs --fixtures-dir <dir>",
    "可选：--out <dir> | --run-id <id> | --timeout-ms <n> | --archive-root <dir> | --scratch-parent <dir>",
  ].join("\n");
  console.error(usage);
  process.exit(2);
}

function parseArgs(argv) {
  const fixturePaths = [];
  let fixturesDir = null;
  let outDir = DEFAULT_OUT_DIR;
  let runId = null;
  let timeoutMs = null;
  let archiveRoot = null;
  let scratchParentDir = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fixture" && i + 1 < argv.length) {
      fixturePaths.push(argv[++i]);
    } else if (arg.startsWith("--fixture=")) {
      fixturePaths.push(arg.slice("--fixture=".length));
    } else if (arg === "--fixtures-dir" && i + 1 < argv.length) {
      fixturesDir = argv[++i];
    } else if (arg.startsWith("--fixtures-dir=")) {
      fixturesDir = arg.slice("--fixtures-dir=".length);
    } else if (arg === "--out" && i + 1 < argv.length) {
      outDir = argv[++i];
    } else if (arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length);
    } else if (arg === "--run-id" && i + 1 < argv.length) {
      runId = argv[++i];
    } else if (arg.startsWith("--run-id=")) {
      runId = arg.slice("--run-id=".length);
    } else if (arg === "--timeout-ms" && i + 1 < argv.length) {
      timeoutMs = Number(argv[++i]);
    } else if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = Number(arg.slice("--timeout-ms=".length));
    } else if (arg === "--archive-root" && i + 1 < argv.length) {
      archiveRoot = argv[++i];
    } else if (arg.startsWith("--archive-root=")) {
      archiveRoot = arg.slice("--archive-root=".length);
    } else if (arg === "--scratch-parent" && i + 1 < argv.length) {
      scratchParentDir = argv[++i];
    } else if (arg.startsWith("--scratch-parent=")) {
      scratchParentDir = arg.slice("--scratch-parent=".length);
    } else {
      console.error(`[eval-replay-cli] 未知参数：${arg}`);
      usageAndExit();
    }
  }
  return {
    fixturePaths,
    fixturesDir,
    outDir,
    runId,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null,
    archiveRoot,
    scratchParentDir,
  };
}

const args = parseArgs(process.argv.slice(2));

// fixture 收集：显式路径 + 目录内全部 *.json
if (args.fixturesDir) {
  if (!existsSync(args.fixturesDir)) {
    console.error(`[eval-replay-cli] --fixtures-dir 不存在：${args.fixturesDir}`);
    process.exit(2);
  }
  for (const name of readdirSync(args.fixturesDir).sort()) {
    if (name.endsWith(".json")) {
      args.fixturePaths.push(join(args.fixturesDir, name));
    }
  }
}
if (args.fixturePaths.length === 0) {
  console.error("[eval-replay-cli] 至少提供一个 --fixture <path> 或 --fixtures-dir <dir>");
  usageAndExit();
}

const fixtures = [];
for (const fixturePath of args.fixturePaths) {
  if (!existsSync(fixturePath)) {
    console.error(`[eval-replay-cli] fixture 文件不存在：${fixturePath}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fixturePath, "utf-8"));
  } catch (error) {
    console.error(`[eval-replay-cli] fixture 不是合法 JSON：${fixturePath}：${String(error)}`);
    process.exit(2);
  }
  fixtures.push(parsed);
}

// dist-eval 构建产物前置检查（fail-closed：不静默回退旧产物）
const runnerDist = join(EXT_ROOT, "dist-eval", "eval", "full-pipeline-replay-runner.js");
if (!existsSync(runnerDist)) {
  console.error(
    "[eval-replay-cli] 缺少 dist-eval 构建产物，请先执行 npm run build（或 npm run build:eval）",
  );
  process.exit(2);
}
const runner = await import(pathToFileURL(runnerDist).href);

console.error(
  `[eval-replay-cli] 开始回放：${fixtures.length} 个 fixture，projectRoot=${EXT_ROOT}`,
);
const report = await runner.runFullPipelineReplay({
  projectRoot: EXT_ROOT,
  fixtures,
  ...(args.runId ? { runId: args.runId } : {}),
  ...(args.archiveRoot ? { archiveRoot: args.archiveRoot } : {}),
  ...(args.scratchParentDir ? { scratchParentDir: args.scratchParentDir } : {}),
  ...(args.timeoutMs ? { invokeTimeoutMs: args.timeoutMs } : {}),
});

// 报告输出
mkdirSync(args.outDir, { recursive: true });
const reportJsonPath = join(args.outDir, "report.json");
writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

const statusCounts = new Map();
for (const sample of report.samples) {
  statusCounts.set(sample.entry.status, (statusCounts.get(sample.entry.status) ?? 0) + 1);
}
const attributionCounts = new Map();
for (const [key, count] of Object.entries(report.attributionSummary ?? {})) {
  if (typeof count === "number" && count > 0) attributionCounts.set(key, count);
}
const lines = [];
lines.push(`# Eval Full Pipeline Replay Report`);
lines.push("");
lines.push(`- runId: ${report.runId}`);
lines.push(`- runPath: ${report.runPath}`);
lines.push(`- report.json: ${reportJsonPath}`);
lines.push(`- 样本总数: ${report.samples.length}`);
lines.push(`- 隔离违规总数: ${report.isolationViolationCount}（必须为 0）`);
lines.push(`- 样本状态分布: ${[...statusCounts.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
if (attributionCounts.size > 0) {
  lines.push(`- 失败归因分布: ${[...attributionCounts.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
}
lines.push("");
lines.push(`| # | fixtureId | mode | status | 归因 |`);
lines.push(`|---|-----------|------|--------|------|`);
report.samples.forEach((sample, index) => {
  const attribution =
    sample.attribution?.attribution ??
    sample.entry.failureAttribution ??
    "-";
  lines.push(
    `| ${index + 1} | ${sample.entry.fixtureId} | ${sample.entry.replayMode} | ${sample.entry.status} | ${attribution} |`,
  );
});
const reportMdPath = join(args.outDir, "report.md");
writeFileSync(reportMdPath, `${lines.join("\n")}\n`, "utf-8");
console.error(`[eval-replay-cli] 报告已写入：${reportJsonPath} / ${reportMdPath}`);

// CI 判定：全部 completed + 零隔离违规
const allCompleted = report.samples.every((s) => s.entry.status === "completed");
const ciOk = allCompleted && report.isolationViolationCount === 0;
if (ciOk) {
  console.error(`[eval-replay-cli] PASS：${report.samples.length} 个样本全部 completed，零隔离违规`);
} else {
  const notCompleted = report.samples
    .filter((s) => s.entry.status !== "completed")
    .map((s) => `${s.entry.fixtureId}(${s.entry.status})`)
    .join(", ");
  console.error(
    `[eval-replay-cli] FAIL：未全部 completed（${notCompleted}）` +
      (report.isolationViolationCount > 0
        ? `；存在 ${report.isolationViolationCount} 条隔离违规`
        : ""),
  );
}
process.exit(ciOk ? 0 : 1);
