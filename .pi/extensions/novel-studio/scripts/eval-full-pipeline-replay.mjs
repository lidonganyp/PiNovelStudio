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
 *         --release-id <id>        P6 目标 release（默认取 fixture provenance）
 *         --bundle-id <id>         P6 目标 bundle（默认取 fixture provenance）
 *         --change-class <Rx>      P6 变更级别（默认 R1，R2/R3 强制四臂矩阵）
 *         --code-commit <sha>      写入矩阵绑定
 *         --arm <id>=<runRoot>     矩阵臂（baseline|candidate|raw_direct|recovery）
 *
 * 输出：
 *   {out}/report.json   完整 FullPipelineReplayRunReport
 *   {out}/report.md     样本状态 / 失败归因 / 隔离违规摘要
 *   {archiveRoot}/{runId}/   逐样本归档（trace / result / invocation / manifest）
 *
 * CI：全部 completed + 零隔离 + trace 留存率 1 + unclassified=0
 *     + 确定性 grader 通过 + P6 eval-gate approved -> exit 0；否则 exit 1
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
    "      --release-id <id> | --bundle-id <id> | --change-class <Rx> | --code-commit <sha>",
    "      --arm <id>=<runRoot>   id=baseline|candidate|raw_direct|recovery",
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
  let releaseId = null;
  let bundleId = null;
  let changeClass = "R1";
  let codeCommit = null;
  const armRunRoots = {};
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
    } else if (arg === "--release-id" && i + 1 < argv.length) {
      releaseId = argv[++i];
    } else if (arg.startsWith("--release-id=")) {
      releaseId = arg.slice("--release-id=".length);
    } else if (arg === "--bundle-id" && i + 1 < argv.length) {
      bundleId = argv[++i];
    } else if (arg.startsWith("--bundle-id=")) {
      bundleId = arg.slice("--bundle-id=".length);
    } else if (arg === "--change-class" && i + 1 < argv.length) {
      changeClass = argv[++i];
    } else if (arg.startsWith("--change-class=")) {
      changeClass = arg.slice("--change-class=".length);
    } else if (arg === "--code-commit" && i + 1 < argv.length) {
      codeCommit = argv[++i];
    } else if (arg.startsWith("--code-commit=")) {
      codeCommit = arg.slice("--code-commit=".length);
    } else if (arg === "--arm" && i + 1 < argv.length) {
      const spec = argv[++i];
      const eq = spec.indexOf("=");
      if (eq <= 0) {
        console.error(`[eval-replay-cli] --arm 需要 <id>=<runRoot>，收到：${spec}`);
        usageAndExit();
      }
      armRunRoots[spec.slice(0, eq)] = spec.slice(eq + 1);
    } else if (arg.startsWith("--arm=")) {
      const spec = arg.slice("--arm=".length);
      const eq = spec.indexOf("=");
      if (eq <= 0) {
        console.error(`[eval-replay-cli] --arm 需要 <id>=<runRoot>，收到：${spec}`);
        usageAndExit();
      }
      armRunRoots[spec.slice(0, eq)] = spec.slice(eq + 1);
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
    releaseId,
    bundleId,
    changeClass,
    codeCommit,
    armRunRoots,
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

const graderDist = join(EXT_ROOT, "dist-eval", "v2", "core", "eval-deterministic-grader.js");
const gateDist = join(EXT_ROOT, "dist-eval", "v2", "governance", "eval-evidence-gate.js");
const matrixDist = join(EXT_ROOT, "dist-eval", "v2", "core", "eval-replay-matrix.js");
if (!existsSync(graderDist) || !existsSync(gateDist) || !existsSync(matrixDist)) {
  console.error("[eval-replay-cli] 缺少 dist-eval grader/gate/matrix 产物，请先 npm run build:eval");
  process.exit(2);
}
const graderMod = await import(pathToFileURL(graderDist).href);
const gateMod = await import(pathToFileURL(gateDist).href);
const matrixMod = await import(pathToFileURL(matrixDist).href);

const releaseId = args.releaseId || report.manifest.releaseId;
const bundleId = args.bundleId || report.manifest.bundleId;
const changeClass = args.changeClass || "R1";
const armRunRoots = { ...args.armRunRoots };
if (!armRunRoots.candidate) {
  armRunRoots.candidate = report.runPath;
}
const providedArms = ["baseline", "candidate", "raw_direct", "recovery"].filter(
  (id) => typeof armRunRoots[id] === "string" && armRunRoots[id].length > 0,
);
if (providedArms.length >= 4) {
  try {
    const matrixReport = matrixMod.generateMatrixReportFromReplayRuns({
      candidateReleaseId: releaseId,
      candidateBundleId: bundleId,
      baselineReleaseId: releaseId,
      armRunRoots,
      codeCommit: args.codeCommit,
    });
    matrixMod.writeMatrixReport(report.runPath, matrixReport);
    console.error(
      `[eval-replay-cli] 已生成 matrix-report.json：verdict=${matrixReport.verdict} pass^3=${matrixReport.candidatePassPow3} hash=${matrixReport.reportHash}`,
    );
  } catch (error) {
    console.error(`[eval-replay-cli] 生成 matrix-report 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
} else if (changeClass === "R2" || changeClass === "R3") {
  console.error(
    `[eval-replay-cli] changeClass=${changeClass} 需要四臂 --arm，当前仅有 ${providedArms.join(",") || "(none)"}`,
  );
}

const grade = graderMod.gradeDeterministicFromRunRoot(report.runPath);
const evalGate = gateMod.evaluateEvalEvidenceGate({
  releaseId,
  bundleId,
  changeClass,
  evalRunRoot: report.runPath,
});
const allCompleted = report.samples.every((s) => s.entry.status === "completed");
const unclassifiedCount = report.attributionSummary?.unclassified ?? 0;
const cliVerdict = gateMod.evaluateReplayCliSuccess({
  allCompleted,
  isolationViolationCount: report.isolationViolationCount,
  traceRetentionRate: report.manifest.summary.traceRetentionRate,
  unclassifiedCount,
  gradePassed: grade.passed,
  evalGateVerdict: evalGate.verdict,
});

const verdictPath = join(args.outDir, "cli-verdict.json");
writeFileSync(
  verdictPath,
  `${JSON.stringify(
    {
      ok: cliVerdict.ok,
      reasons: cliVerdict.reasons,
      grade: { passed: grade.passed, failedChecks: grade.failedChecks },
      evalGate: { verdict: evalGate.verdict, code: evalGate.code, reason: evalGate.reason },
      releaseId,
      bundleId,
      changeClass,
      runPath: report.runPath,
    },
    null,
    2,
  )}\n`,
  "utf-8",
);

if (cliVerdict.ok) {
  console.error(
    `[eval-replay-cli] PASS：completed=${report.samples.length} isolation=0 trace=1 unclassified=0 grader=pass P6=${evalGate.code}`,
  );
} else {
  console.error(`[eval-replay-cli] FAIL：${cliVerdict.reasons.join("；")}`);
  if (!grade.passed) {
    console.error(`[eval-replay-cli] grader failedChecks=${grade.failedChecks.join(",")}`);
  }
  if (evalGate.verdict !== "approved") {
    console.error(`[eval-replay-cli] P6 ${evalGate.code}: ${evalGate.reason}`);
  }
}
process.exit(cliVerdict.ok ? 0 : 1);
