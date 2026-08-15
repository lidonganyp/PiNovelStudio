/**
 * Wave 6 live child：在隔离 workspace 上调用生产 novel_generate_chapter。
 * 用法：node _concurrency-wave6-live-child.mjs <workspaceId> <chapterNumber> <resultFile>
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(EXT_ROOT, "../../..");
const [workspaceId, chapterRaw, resultFile] = process.argv.slice(2);
const chapterNumber = Number(chapterRaw);
const chapterId = String(chapterNumber);

process.env.PINOVEL_DEV_MODE = process.env.PINOVEL_DEV_MODE || "1";

const started = Date.now();
const progressUpdates = [];

function finish(payload) {
  writeFileSync(resultFile, JSON.stringify({
    workspaceId,
    chapterNumber,
    elapsedMs: Date.now() - started,
    pid: process.pid,
    devMode: process.env.PINOVEL_DEV_MODE,
    ...payload,
  }, null, 2), "utf-8");
}

try {
  const extModule = await import(pathToFileURL(join(EXT_ROOT, "dist", "index.js")).href);
  const registered = {};
  extModule.default({
    registerTool(tool) { registered[tool.name] = tool; },
    registerCommand() {},
    on() {},
    ui: { notify(msg, level) { progressUpdates.push(`[${level}] ${msg}`); } },
  });
  const tool = registered.novel_generate_chapter;
  if (!tool) {
    finish({ ok: false, error: "novel_generate_chapter not registered" });
    process.exit(1);
  }
  const result = await tool.execute(
    `wave6-live-${workspaceId}-${chapterId}-${Date.now()}`,
    { workspaceId, chapterId, chapterNumber },
    undefined,
    (update) => {
      const msg = typeof update === "string" ? update : JSON.stringify(update).slice(0, 240);
      progressUpdates.push(msg);
    },
    { cwd: PROJECT_ROOT, ui: { notify(msg, level) { progressUpdates.push(`[${level}] ${msg}`); } } },
  );
  const details = result?.details || result || {};
  finish({
    ok: details.status === "ok" || details.status === "completed",
    status: details.status ?? (result?.isError ? "error" : "unknown"),
    isError: Boolean(result?.isError),
    jobId: details.jobId ?? null,
    failureEnvelope: details.failureEnvelope ?? null,
    selectedSource: details.selectedSource ?? details.stageResults?.finalSelection?.selectedSource ?? null,
    progressUpdates,
    detailsKeys: Object.keys(details),
  });
  process.exit(0);
} catch (error) {
  finish({
    ok: false,
    status: "exception",
    error: String(error?.message ?? error),
    stack: String(error?.stack ?? "").slice(0, 4000),
    progressUpdates,
  });
  process.exit(1);
}
