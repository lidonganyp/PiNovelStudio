/**
 * Wave 6 子进程：真实 OS 进程上的 batch start / 提交槽冲击。
 * 用法：node _concurrency-wave6-child.mjs <start-hold|commit-slot> <workspaceId> [jobOrCandId] [commandId]
 */
import { pathToFileURL } from "node:url";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const [mode, workspaceId, token = "wave6", commandId = `cmd-${token}`] = process.argv.slice(2);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const helpers = await import(pathToFileURL(join(EXT_ROOT, "tests", "batch-test-helpers.mjs")).href);

if (mode === "start-hold") {
  const { handleBatchGeneration } = await import(
    pathToFileURL(join(EXT_ROOT, "dist", "handlers", "batch-generation-handler.js")).href
  );
  const workspacePath = join(helpers.PROJECT_ROOT, "workspaces", workspaceId);
  const inner = helpers.createMockGenerateChapter({ workspacePath });
  const mock = async (input) => {
    await sleep(800);
    return inner(input);
  };
  const result = await handleBatchGeneration({
    mode: "batch",
    action: "start",
    workspaceId,
    jobId: token,
    commandId,
    startChapter: 1,
    endChapter: 1,
    _projectRoot: helpers.PROJECT_ROOT,
    _mockGenerateChapter: mock,
  });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    jobId: result.jobId,
    reason: result.failureEnvelope?.reason ?? null,
    concurrencyError: result.concurrencyError ?? null,
  })}\n`);
  process.exit(0);
}

if (mode === "commit-slot") {
  const { withChapterCommitSlot, CommitSlotBusyError } = await import(
    pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "submission-queue.js")).href
  );
  const { syncSleepMs } = await import(
    pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "fs-atomic.js")).href
  );
  const started = Date.now();
  try {
    const outcome = withChapterCommitSlot({
      workspaceId,
      projectRoot: helpers.PROJECT_ROOT,
      owner: token,
      chapterId: "1",
      runId: token,
      waitMs: 150,
    }, () => {
      syncSleepMs(700);
      return { committed: true, owner: token };
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      owner: token,
      elapsedMs: Date.now() - started,
      slotOk: outcome.slot?.ok ?? true,
    })}\n`);
    process.exit(0);
  } catch (e) {
    const busy = e instanceof CommitSlotBusyError || /commit_slot_busy|busy/i.test(String(e?.message ?? e));
    process.stdout.write(`${JSON.stringify({
      ok: false,
      busy,
      owner: token,
      error: String(e?.message ?? e),
      elapsedMs: Date.now() - started,
    })}\n`);
    process.exit(0);
  }
}

process.stdout.write(`${JSON.stringify({ ok: false, error: `unknown mode ${mode}` })}\n`);
process.exit(1);
