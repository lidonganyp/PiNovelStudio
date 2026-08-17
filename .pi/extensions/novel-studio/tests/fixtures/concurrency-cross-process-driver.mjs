#!/usr/bin/env node
/**
 * 跨进程并发测试 driver — CONCURRENCY-WAVE1/2/3 真实多进程互斥验证。
 *
 * 由 tests/concurrency-cross-process.test.mjs 以 spawn(process.execPath, ...) 启动。
 * 用法：
 *   node concurrency-cross-process-driver.mjs <mode> <workspaceId> <resultFile> <startSignalFile> [extraJson]
 *
 * mode：
 *   lock        — acquireBatchLock（Wave 1 原子租约锁）
 *   cas         — saveBatchJobStore with expectedRevision（Wave 2 CAS）
 *   commit-slot — withChapterCommitSlot（Wave 3 提交槽串行化）
 *
 * 并发 barrier：driver 就绪后写 ${resultFile}.ready，然后等待 startSignalFile
 * 出现才执行操作——保证 N 个真实 OS 进程在毫秒窗口内同时冲击同一资源。
 */

import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// fixtures → tests → novel-studio（EXT_ROOT 上 2 级）
const EXT_ROOT = resolve(__dirname, "..", "..");
// fixtures → tests → novel-studio → extensions → .pi → PiNovelStudio 仓库根（上 5 级）
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");

const [mode, workspaceId, resultFile, startSignalFile, extraJson] = process.argv.slice(2);
const extra = extraJson ? JSON.parse(extraJson) : {};

function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 就绪 → 报告 → 等待发令（三段 barrier） */
function barrier() {
  writeFileSync(`${resultFile}.ready`, String(process.pid), "utf-8");
  const deadline = Date.now() + 20000;
  while (!existsSync(startSignalFile)) {
    if (Date.now() > deadline) {
      throw new Error(`start signal timeout: ${startSignalFile}`);
    }
    syncSleep(5);
  }
}

async function main() {
  barrier();

  if (mode === "lock") {
    const { acquireBatchLock } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "batch-generation-lock.js")).href
    );
    const r = acquireBatchLock(workspaceId, extra.jobId, PROJECT_ROOT);
    writeFileSync(resultFile, JSON.stringify({
      mode, pid: process.pid, ok: r.ok, code: r.code ?? null, lock: r.lock ?? null,
    }), "utf-8");
    // 成功持有者保持存活直到 release 信号（模拟真实批量任务进程持锁运行；
    // 短命进程立即退出会被他方按 zombie_owner_dead 合法接管——那是崩溃恢复语义）
    if (r.ok && extra.holdFile) {
      const deadline = Date.now() + 60000;
      while (!existsSync(extra.holdFile) && Date.now() < deadline) {
        syncSleep(10);
      }
    }
    return;
  }

  if (mode === "cas") {
    const { saveBatchJobStore } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "batch-generation-job-store.js")).href
    );
    const state = JSON.parse(JSON.stringify(extra.state));
    const r = saveBatchJobStore(state, workspaceId, extra.jobId, PROJECT_ROOT, {
      expectedRevision: extra.expectedRevision,
      event: extra.event ?? "cross_process_test",
    });
    writeFileSync(resultFile, JSON.stringify({ mode, pid: process.pid, result: r }), "utf-8");
    return;
  }

  if (mode === "commit-slot") {
    const { withChapterCommitSlot, CommitSlotBusyError } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "submission-queue.js")).href
    );
    let enterAt = null;
    let exitAt = null;
    try {
      const { slot } = withChapterCommitSlot(
        {
          workspaceId,
          projectRoot: PROJECT_ROOT,
          chapterId: extra.chapterId,
          owner: extra.owner,
          runId: extra.runId,
          waitMs: extra.waitMs,
        },
        () => {
          enterAt = Date.now();
          syncSleep(extra.holdMs ?? 300); // 模拟毫秒~秒级提交段文件事务
          exitAt = Date.now();
          return true;
        },
      );
      writeFileSync(resultFile, JSON.stringify({
        mode, pid: process.pid, ok: true,
        waitedMs: slot.waitedMs, lockId: slot.lockId, enterAt, exitAt,
      }), "utf-8");
    } catch (e) {
      const busy = e instanceof CommitSlotBusyError;
      writeFileSync(resultFile, JSON.stringify({
        mode, pid: process.pid, ok: false, busy,
        code: e?.code ?? null, message: String(e?.message ?? e),
      }), "utf-8");
    }
    return;
  }

  if (mode === "budget-reserve") {
    const { reservePersistedBudget } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "budget-ledger-store.js")).href
    );
    const r = reservePersistedBudget(workspaceId, PROJECT_ROOT, {
      stage: extra.stage ?? "agenticDraft",
      modelCalls: extra.modelCalls ?? 1,
      reservationId: extra.reservationId ?? `xproc-${process.pid}`,
    });
    writeFileSync(resultFile, JSON.stringify({
      mode, pid: process.pid, ok: r.ok, reason: r.reason ?? null,
      remaining: r.snapshot?.remainingModelCalls ?? null,
    }), "utf-8");
    return;
  }

  throw new Error(`unknown mode: ${mode}`);
}

main().catch((e) => {
  try {
    writeFileSync(resultFile, JSON.stringify({
      mode, pid: process.pid, fatal: String(e?.stack ?? e),
    }), "utf-8");
  } catch { /* 结果文件不可写时静默 */ }
  process.exitCode = 1;
});
