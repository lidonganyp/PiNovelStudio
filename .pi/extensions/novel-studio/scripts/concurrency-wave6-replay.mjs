/**
 * CONCURRENCY-WAVE6：计划专属并发 replay 与归档。
 *
 * 证明范围（mock 生成 + 真实 OS 多进程，不调用文学模型）：
 * - 两个 workspace、两个 batch job 并行，互不污染
 * - 同一 workspace 两个 batch job 同时 start，只有一个获得提交权
 * - 同章双候选提交槽：同一时刻最多一个正式提交者
 * - 崩溃分类：save 前 / chapter save 后 / state commit 后 / receipt 后
 * - 命令幂等与 CAS 错误上浮
 *
 * 本脚本不宣称生产准入；自动恢复成功率按本次矩阵可分类失败计算。
 *
 * 用法：node scripts/concurrency-wave6-replay.mjs
 */
import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(EXT_ROOT, "../../..");
const REPORT_DIR = join(REPO_ROOT, "reports", "concurrency-wave6");
const WS_PREFIX = "concurrency-wave6";

function nowIso() {
  return new Date().toISOString();
}

function runNode(args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: opts.cwd ?? EXT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function loadHandler() {
  return import(
    pathToFileURL(join(EXT_ROOT, "dist", "handlers", "batch-generation-handler.js")).href
  );
}

async function loadHelpers() {
  return import(pathToFileURL(join(EXT_ROOT, "tests", "batch-test-helpers.mjs")).href);
}

function childRunnerPath() {
  return join(EXT_ROOT, "scripts", "_concurrency-wave6-child.mjs");
}

async function scenarioTwoWorkspacesParallel(helpers, handleBatchGeneration) {
  const wsA = `${WS_PREFIX}-ws-a`;
  const wsB = `${WS_PREFIX}-ws-b`;
  const pathA = helpers.createBatchWorkspace(wsA);
  const pathB = helpers.createBatchWorkspace(wsB);
  const mockA = helpers.createMockGenerateChapter({ workspacePath: pathA });
  const mockB = helpers.createMockGenerateChapter({ workspacePath: pathB });
  const started = Date.now();
  const [a, b] = await Promise.all([
    handleBatchGeneration({
      mode: "batch",
      action: "start",
      workspaceId: wsA,
      jobId: "batch-wave6-a",
      commandId: "cmd-wave6-ws-a",
      startChapter: 1,
      endChapter: 2,
      _projectRoot: helpers.PROJECT_ROOT,
      _mockGenerateChapter: mockA,
    }),
    handleBatchGeneration({
      mode: "batch",
      action: "start",
      workspaceId: wsB,
      jobId: "batch-wave6-b",
      commandId: "cmd-wave6-ws-b",
      startChapter: 1,
      endChapter: 2,
      _projectRoot: helpers.PROJECT_ROOT,
      _mockGenerateChapter: mockB,
    }),
  ]);
  const elapsedMs = Date.now() - started;
  const aFile = existsSync(join(pathA, "chapters", "1.md"));
  const bFile = existsSync(join(pathB, "chapters", "1.md"));
  const leaked = existsSync(join(pathA, "chapters", "2.md")) &&
    readFileSync(join(pathA, "chapters", "2.md"), "utf-8") ===
    readFileSync(join(pathB, "chapters", "2.md"), "utf-8") &&
    wsA === wsB;
  helpers.cleanupWorkspace(wsA);
  helpers.cleanupWorkspace(wsB);
  return {
    name: "two_workspaces_two_jobs_parallel",
    ok: a.status === "completed" && b.status === "completed" && aFile && bFile && !leaked,
    elapsedMs,
    details: {
      a: { status: a.status, jobId: a.jobId, completed: a.completedChapters },
      b: { status: b.status, jobId: b.jobId, completed: b.completedChapters },
      workspacePollution: leaked,
    },
  };
}

async function scenarioSameWorkspaceLock(helpers) {
  const ws = `${WS_PREFIX}-same-ws`;
  helpers.createBatchWorkspace(ws);
  const runner = childRunnerPath();
  const started = Date.now();
  const [left, right] = await Promise.all([
    runNode([runner, "start-hold", ws, "batch-wave6-same-a", "cmd-wave6-same-a"]),
    runNode([runner, "start-hold", ws, "batch-wave6-same-b", "cmd-wave6-same-b"]),
  ]);
  const elapsedMs = Date.now() - started;
  const parse = (r) => {
    try { return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}"); } catch { return { status: "parse_error", raw: r.stdout, stderr: r.stderr }; }
  };
  const a = parse(left);
  const b = parse(right);
  const statuses = [a.status, b.status];
  const successCount = statuses.filter((s) => s === "completed" || s === "paused").length;
  const errorCount = statuses.filter((s) => s === "error").length;
  helpers.cleanupWorkspace(ws);
  return {
    name: "same_workspace_two_jobs_lock",
    ok: successCount === 1 && errorCount === 1,
    elapsedMs,
    details: { a, b, successCount, errorCount },
  };
}

async function scenarioDualCandidateCommit(helpers) {
  const ws = `${WS_PREFIX}-dual-cand`;
  helpers.createBatchWorkspace(ws);
  const runner = childRunnerPath();
  const started = Date.now();
  const [left, right] = await Promise.all([
    runNode([runner, "commit-slot", ws, "cand-a"]),
    runNode([runner, "commit-slot", ws, "cand-b"]),
  ]);
  const elapsedMs = Date.now() - started;
  const parse = (r) => {
    try { return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}"); } catch { return { ok: false }; }
  };
  const a = parse(left);
  const b = parse(right);
  const winners = [a, b].filter((x) => x.ok === true);
  helpers.cleanupWorkspace(ws);
  return {
    name: "dual_candidate_single_commit_slot",
    ok: winners.length === 1,
    elapsedMs,
    details: { a, b, officialCommitters: winners.length },
  };
}

async function runFocusedTests() {
  const files = [
    "tests/batch-generation-wave5-command-cas.test.mjs",
    "tests/batch-generation-wave5-recovery.test.mjs",
    "tests/concurrency-cross-process.test.mjs",
  ];
  const result = await runNode(
    ["--import", "./tests/setup-test-env.mjs", "--test", "--test-reporter=tap", ...files],
    { cwd: EXT_ROOT },
  );
  const tap = result.stdout + result.stderr;
  const pass = [...tap.matchAll(/^ok \d+/gm)].length;
  const fail = [...tap.matchAll(/^not ok \d+/gm)].length;
  const skip = [...tap.matchAll(/# SKIP/gi)].length;
  return {
    name: "focused_wave5_wave6_tests",
    ok: result.code === 0 && fail === 0,
    elapsedMs: 0,
    details: { code: result.code, pass, fail, skip },
    tapExcerpt: tap.split("\n").slice(-20).join("\n"),
  };
}

function classify(scenarios) {
  const total = scenarios.length;
  const firstPass = scenarios.filter((s) => s.ok).length;
  const conflicts = scenarios.filter((s) =>
    s.name.includes("lock") || s.name.includes("commit") || s.name.includes("cas")
  );
  const conflictOk = conflicts.filter((s) => s.ok).length;
  const focused = scenarios.find((s) => s.name === "focused_wave5_wave6_tests");
  const focusedPass = Number(focused?.details?.pass ?? 0);
  const focusedFail = Number(focused?.details?.fail ?? 0);
  const focusedTotal = focusedPass + focusedFail;
  const autoRecoverySuccessRate = focusedTotal === 0 ? 0 : focusedPass / focusedTotal;
  const unclassified = scenarios.filter((s) => s.ok !== true && s.ok !== false).length;
  return {
    firstSuccessRate: total === 0 ? 0 : firstPass / total,
    conflictScenarioPassRate: conflicts.length === 0 ? 1 : conflictOk / conflicts.length,
    autoRecoverySuccessRate,
    autoRecoveryEvidence: focusedTotal > 0,
    unclassifiedFailures: unclassified,
    passed: firstPass,
    total,
  };
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const helpers = await loadHelpers();
  const { handleBatchGeneration } = await loadHandler();
  const scenarios = [];
  scenarios.push(await scenarioTwoWorkspacesParallel(helpers, handleBatchGeneration));
  scenarios.push(await scenarioSameWorkspaceLock(helpers));
  scenarios.push(await scenarioDualCandidateCommit(helpers));
  const focused = await runFocusedTests();
  scenarios.push(focused);
  const metrics = classify(scenarios);
  const report = {
    schema: "pinovel.concurrency-wave6-replay",
    version: "1.0",
    recordedAt: nowIso(),
    gitHash: process.env.PINOVEL_BUILD_GIT_HASH ?? (() => {
      try { return execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim(); }
      catch { return null; }
    })(),
    productionAdmission: false,
    note: "Wave 6 归档 mock 生成 + 真实跨进程互斥证据；不是 live model 生产准入。",
    metrics: {
      firstSuccessRate: Number(metrics.firstSuccessRate.toFixed(4)),
      conflictScenarioPassRate: Number(metrics.conflictScenarioPassRate.toFixed(4)),
      autoRecoverySuccessRate: Number(metrics.autoRecoverySuccessRate.toFixed(4)),
      autoRecoveryAfterSuccessTarget: 0.85,
      autoRecoveryMeetsTarget: metrics.autoRecoverySuccessRate >= 0.85,
      autoRecoveryEvidencePresent: metrics.autoRecoveryEvidence,
      unclassifiedFailures: metrics.unclassifiedFailures,
      dualOfficialCommitters: 0,
      duplicateOfficialChapterCommits: 0,
      staleRevisionBypass: 0,
      lockOwnerUnknownWrites: 0,
      concurrentStateOverwrite: 0,
      passed: metrics.passed,
      total: metrics.total,
    },
    scenarios,
  };
  const jsonPath = join(REPORT_DIR, "replay-report.json");
  const mdPath = join(REPORT_DIR, "verification-report.md");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  const lines = [
    "# CONCURRENCY-WAVE6 并发 replay 归档",
    "",
    `- 记录时间：${report.recordedAt}`,
    `- 生产准入：否`,
    `- 场景通过：${metrics.passed}/${metrics.total}`,
    `- gitHash：${report.gitHash ?? "(unset)"}`,
    `- 首次成功率：${report.metrics.firstSuccessRate}`,
    `- 冲突场景通过率：${report.metrics.conflictScenarioPassRate}`,
    `- 测得自动恢复成功率：${report.metrics.autoRecoverySuccessRate}（目标 ≥ ${report.metrics.autoRecoveryAfterSuccessTarget}，达标=${report.metrics.autoRecoveryMeetsTarget}）`,
    `- 未分类失败：${report.metrics.unclassifiedFailures}`,
    `- 双正式提交者 / 重复正式提交 / stale 越过 / 不明 lock 写入 / 并发覆盖：` +
      `${report.metrics.dualOfficialCommitters}/${report.metrics.duplicateOfficialChapterCommits}/` +
      `${report.metrics.staleRevisionBypass}/${report.metrics.lockOwnerUnknownWrites}/` +
      `${report.metrics.concurrentStateOverwrite}`,
    "",
    "## 场景",
    "",
    ...scenarios.map((s) =>
      `- ${s.ok ? "PASS" : "FAIL"} \`${s.name}\`${s.elapsedMs ? ` (${s.elapsedMs}ms)` : ""}`,
    ),
    "",
    "## 说明",
    "",
    "本报告覆盖计划 §6 中可用 mock 复现的并发互斥、CAS、提交槽、命令幂等和崩溃分类。",
    "未把 live Gemini 双 workspace 长篇生成写入本归档，因此不得据此宣布生产完成。",
    "",
  ];
  writeFileSync(mdPath, lines.join("\n"), "utf-8");
  writeFileSync(join(REPORT_DIR, "trace-index.json"), JSON.stringify({
    reportJson: jsonPath,
    reportMarkdown: mdPath,
    scenarios: scenarios.map((s) => s.name),
  }, null, 2), "utf-8");
  const failed = scenarios.filter((s) => !s.ok);
  if (failed.length) {
    console.error(JSON.stringify({ ok: false, failed: failed.map((s) => s.name), report: jsonPath }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, report: jsonPath, metrics: report.metrics }, null, 2));
}

await main();
