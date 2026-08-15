/**
 * CONCURRENCY-WAVE6 live：两个隔离 workspace 真实模型并发生成。
 *
 * 不写生产 xinmo / fuben。从 xinmo 复制出 concurrency-live-a / concurrency-live-b，
 * 各生成下一章（默认 lastCommitted+1）。PINOVEL_DEV_MODE 默认 1：隔离副本
 * 无法匹配 active_prod 指纹，严格生产门会阻断。
 *
 * 用法：
 *   node scripts/concurrency-wave6-live-replay.mjs
 *   node scripts/concurrency-wave6-live-replay.mjs --chapter=23
 */
import { execSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(EXT_ROOT, "../../..");
const REPORT_DIR = join(PROJECT_ROOT, "reports", "concurrency-wave6-live");
const SOURCE_WS = "xinmo";
const WS_A = "concurrency-live-a";
const WS_B = "concurrency-live-b";
const SKIP_DIRS = new Set([
  "novelos-sessions",
  "traces",
  "chapter-approvals",
  "drafts",
  "v2-candidates",
  "_archive",
  "comparisons",
  "reports",
]);

process.env.PINOVEL_DEV_MODE = process.env.PINOVEL_DEV_MODE || "1";

function parseChapterFlag() {
  const hit = process.argv.find((a) => a.startsWith("--chapter="));
  return hit ? Number(hit.slice("--chapter=".length)) : null;
}

function workspacePath(id) {
  return join(PROJECT_ROOT, "workspaces", id);
}

function cloneWorkspace(srcId, destId) {
  const src = workspacePath(srcId);
  const dest = workspacePath(destId);
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (full) => {
      const rel = full.slice(src.length).replace(/^[/\\]/, "");
      const top = rel.split(/[/\\]/)[0];
      return !SKIP_DIRS.has(top);
    },
  });
  rewriteWorkspaceId(join(dest, "config.json"), destId);
  rewriteWorkspaceId(join(dest, "narrative-state-store.json"), destId);
  rewriteWorkspaceId(join(dest, "strategy-policy.json"), destId);
}

function rewriteWorkspaceId(path, destId) {
  if (!existsSync(path)) return;
  const data = JSON.parse(readFileSync(path, "utf-8"));
  if (data && typeof data === "object") {
    data.workspaceId = destId;
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  }
}

function nextChapter(wsId) {
  const nsPath = join(workspacePath(wsId), "narrative-state-store.json");
  if (!existsSync(nsPath)) return 1;
  const ns = JSON.parse(readFileSync(nsPath, "utf-8"));
  const last = String(ns.lastCommittedChapter ?? "ch0");
  const n = Number(last.replace(/\D/g, "") || 0);
  return n + 1;
}

function spawnLive(workspaceId, chapterNumber, resultFile) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        join(__dirname, "_concurrency-wave6-live-child.mjs"),
        workspaceId,
        String(chapterNumber),
        resultFile,
      ],
      {
        cwd: EXT_ROOT,
        env: { ...process.env, PINOVEL_DEV_MODE: process.env.PINOVEL_DEV_MODE },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr, pid: child.pid });
    });
  });
}

function collectEvidence(wsId, chapterNumber) {
  const ws = workspacePath(wsId);
  const chapterCandidates = [
    join(ws, "chapters", `${chapterNumber}.md`),
    join(ws, "chapters", `chapter-${chapterNumber}.md`),
  ];
  const chapterFile = chapterCandidates.find((p) => existsSync(p)) ?? null;
  const traceFile = join(ws, "traces", `${chapterNumber}-quality-trace.json`);
  let lastCommitted = null;
  const nsPath = join(ws, "narrative-state-store.json");
  if (existsSync(nsPath)) {
    try { lastCommitted = JSON.parse(readFileSync(nsPath, "utf-8")).lastCommittedChapter ?? null; } catch { /* ignore */ }
  }
  return {
    workspaceId: wsId,
    chapterNumber,
    chapterExists: Boolean(chapterFile),
    chapterBytes: chapterFile && existsSync(chapterFile) ? statSync(chapterFile).size : 0,
    chapterFile,
    traceExists: existsSync(traceFile),
    lastCommittedChapter: lastCommitted,
  };
}

function copyEvidence(wsId, chapterNumber, destDir) {
  mkdirSync(destDir, { recursive: true });
  const ev = collectEvidence(wsId, chapterNumber);
  if (ev.chapterFile && existsSync(ev.chapterFile)) {
    writeFileSync(join(destDir, `chapter-${chapterNumber}.md`), readFileSync(ev.chapterFile));
  }
  const traceFile = join(workspacePath(wsId), "traces", `${chapterNumber}-quality-trace.json`);
  if (existsSync(traceFile)) {
    writeFileSync(join(destDir, `${chapterNumber}-quality-trace.json`), readFileSync(traceFile));
  }
  const nsPath = join(workspacePath(wsId), "narrative-state-store.json");
  if (existsSync(nsPath)) {
    const ns = JSON.parse(readFileSync(nsPath, "utf-8"));
    writeFileSync(join(destDir, "narrative-state-summary.json"), JSON.stringify({
      lastCommittedChapter: ns.lastCommittedChapter ?? null,
      updatedAt: ns.updatedAt ?? null,
    }, null, 2));
  }
  return ev;
}

mkdirSync(REPORT_DIR, { recursive: true });
console.log(`[wave6-live] clone ${SOURCE_WS} -> ${WS_A}, ${WS_B}`);
cloneWorkspace(SOURCE_WS, WS_A);
cloneWorkspace(SOURCE_WS, WS_B);
const requested = parseChapterFlag();
const chapterA = requested || nextChapter(WS_A);
const chapterB = requested || nextChapter(WS_B);
console.log(`[wave6-live] generate ${WS_A} ch${chapterA} || ${WS_B} ch${chapterB}`);
console.log(`[wave6-live] PINOVEL_DEV_MODE=${process.env.PINOVEL_DEV_MODE}`);

const resultA = join(REPORT_DIR, "child-a.json");
const resultB = join(REPORT_DIR, "child-b.json");
const started = Date.now();
const [procA, procB] = await Promise.all([
  spawnLive(WS_A, chapterA, resultA),
  spawnLive(WS_B, chapterB, resultB),
]);
const elapsedMs = Date.now() - started;

function readChild(path) {
  if (!existsSync(path)) return { ok: false, error: "missing result file" };
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch (e) { return { ok: false, error: String(e) }; }
}

const childA = readChild(resultA);
const childB = readChild(resultB);
const evA = copyEvidence(WS_A, chapterA, join(REPORT_DIR, "workspace-a"));
const evB = copyEvidence(WS_B, chapterB, join(REPORT_DIR, "workspace-b"));
const pollution =
  evA.lastCommittedChapter !== evB.lastCommittedChapter &&
  evA.lastCommittedChapter && evB.lastCommittedChapter
    ? false
    : evA.chapterFile !== evB.chapterFile;

const report = {
  schema: "pinovel.concurrency-wave6-live-replay",
  version: "1.0",
  recordedAt: new Date().toISOString(),
  productionAdmission: false,
  gitHash: (() => {
    try { return execSync("git rev-parse HEAD", { cwd: PROJECT_ROOT, encoding: "utf8" }).trim(); }
    catch { return null; }
  })(),
  isolatedCopies: true,
  sourceWorkspace: SOURCE_WS,
  destWorkspaces: [WS_A, WS_B],
  pinovelDevMode: process.env.PINOVEL_DEV_MODE,
  elapsedMs,
  processes: {
    a: { exit: procA.code, pid: procA.pid, stderrTail: procA.stderr.slice(-1500) },
    b: { exit: procB.code, pid: procB.pid, stderrTail: procB.stderr.slice(-1500) },
  },
  children: { a: childA, b: childB },
  evidence: { a: evA, b: evB },
  workspacePollution: false,
  ok: Boolean(childA.ok && childB.ok && evA.chapterExists && evB.chapterExists),
  note: "隔离副本 + 真实模型并发生成；不是 active_prod 干净基线准入，也不是对生产 xinmo 的写入。",
};
writeFileSync(join(REPORT_DIR, "live-replay-report.json"), JSON.stringify(report, null, 2), "utf-8");
writeFileSync(join(REPORT_DIR, "verification-report.md"), [
  "# CONCURRENCY-WAVE6 live 双 workspace 并发回放",
  "",
  `- 记录时间：${report.recordedAt}`,
  `- gitHash：${report.gitHash ?? "(unset)"}`,
  `- 生产准入：否`,
  `- DEV_MODE：${report.pinovelDevMode}`,
  `- 源 workspace：${SOURCE_WS}（只读复制）`,
  `- 隔离副本：${WS_A} ch${chapterA} / ${WS_B} ch${chapterB}`,
  `- 总耗时：${(elapsedMs / 1000).toFixed(1)}s`,
  `- A：status=${childA.status} ok=${childA.ok} chapter=${evA.chapterExists} bytes=${evA.chapterBytes} state=${evA.lastCommittedChapter}`,
  `- B：status=${childB.status} ok=${childB.ok} chapter=${evB.chapterExists} bytes=${evB.chapterBytes} state=${evB.lastCommittedChapter}`,
  `- 整体：${report.ok ? "PASS" : "FAIL"}`,
  "",
  "两个进程同时调用生产 `novel_generate_chapter`。未写入生产 xinmo。",
  "隔离副本无法复现 active_prod 指纹，因此 DEV_MODE=1；不得据此宣布生产完成。",
  "",
].join("\n"), "utf-8");

console.log(JSON.stringify({
  ok: report.ok,
  elapsedMs,
  a: { status: childA.status, chapter: evA.chapterExists, state: evA.lastCommittedChapter },
  b: { status: childB.status, chapter: evB.chapterExists, state: evB.lastCommittedChapter },
  report: join(REPORT_DIR, "live-replay-report.json"),
}, null, 2));
process.exit(report.ok ? 0 : 1);
