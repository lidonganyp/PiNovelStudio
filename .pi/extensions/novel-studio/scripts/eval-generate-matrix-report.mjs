#!/usr/bin/env node
/**
 * 从四臂回放 run 根目录生成绑定 matrix-report.json。
 *
 * 用法：
 *   node scripts/eval-generate-matrix-report.mjs \
 *     --candidate-run <dir> --baseline-run <dir> \
 *     --raw-direct-run <dir> --recovery-run <dir> \
 *     --out <dir> [--code-commit <sha>]
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");

function usageAndExit() {
  console.error(
    "用法：node scripts/eval-generate-matrix-report.mjs --candidate-run <dir> --baseline-run <dir> --raw-direct-run <dir> --recovery-run <dir> --out <dir> [--code-commit <sha>] [--candidate-release-id <id>] [--candidate-bundle-id <id>] [--baseline-release-id <id>]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    candidateRun: null,
    baselineRun: null,
    rawDirectRun: null,
    recoveryRun: null,
    outDir: null,
    codeCommit: null,
    candidateReleaseId: null,
    candidateBundleId: null,
    baselineReleaseId: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => argv[++i];
    if (arg === "--candidate-run") args.candidateRun = take();
    else if (arg === "--baseline-run") args.baselineRun = take();
    else if (arg === "--raw-direct-run") args.rawDirectRun = take();
    else if (arg === "--recovery-run") args.recoveryRun = take();
    else if (arg === "--out") args.outDir = take();
    else if (arg === "--code-commit") args.codeCommit = take();
    else if (arg === "--candidate-release-id") args.candidateReleaseId = take();
    else if (arg === "--candidate-bundle-id") args.candidateBundleId = take();
    else if (arg === "--baseline-release-id") args.baselineReleaseId = take();
    else {
      console.error(`未知参数：${arg}`);
      usageAndExit();
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.candidateRun || !args.baselineRun || !args.rawDirectRun || !args.recoveryRun || !args.outDir) {
  usageAndExit();
}

const matrixDist = join(EXT_ROOT, "dist-eval", "v2", "core", "eval-replay-matrix.js");
if (!existsSync(matrixDist)) {
  console.error("缺少 dist-eval 产物，请先 npm run build:eval");
  process.exit(2);
}
const matrix = await import(pathToFileURL(matrixDist).href);

const candidateManifest = JSON.parse(readFileSync(join(args.candidateRun, "manifest.json"), "utf-8"));
const baselineManifest = JSON.parse(readFileSync(join(args.baselineRun, "manifest.json"), "utf-8"));
const identity = {
  releaseId: candidateManifest.releaseId ?? "",
  bundleId: candidateManifest.bundleId ?? "",
};
const baselineReleaseId =
  args.baselineReleaseId || baselineManifest.releaseId || "";
if (!baselineReleaseId) {
  console.error("baseline releaseId 缺失：请传 --baseline-release-id 或保证 baseline manifest.releaseId 可读");
  process.exit(2);
}

const report = matrix.generateMatrixReportFromReplayRuns({
  candidateReleaseId: args.candidateReleaseId || identity.releaseId,
  candidateBundleId: args.candidateBundleId || identity.bundleId,
  baselineReleaseId,
  armRunRoots: {
    baseline: args.baselineRun,
    candidate: args.candidateRun,
    raw_direct: args.rawDirectRun,
    recovery: args.recoveryRun,
  },
  codeCommit: args.codeCommit,
});
const path = matrix.writeMatrixReport(args.outDir, report);
console.log(`matrix-report.json -> ${path}`);
console.log(`verdict=${report.verdict} pass^3=${report.candidatePassPow3} hash=${report.reportHash}`);
process.exit(report.verdict === "pass" && report.candidatePassPow3 === 1 ? 0 : 1);
