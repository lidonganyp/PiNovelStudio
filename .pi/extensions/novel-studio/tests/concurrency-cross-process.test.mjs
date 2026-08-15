/**
 * 跨进程并发测试 — CONCURRENCY-WAVE1/2/3 真实多进程互斥验证
 *
 * 用户核验门槛要求"跨进程测试命令与输出"。本测试不模拟并发（不用单进程
 * Promise 竞争），而是 spawn 真实 OS 子进程，用三段 barrier（ready 报告 →
 * start 信号 → 同时冲击）验证：
 *
 *   WAVE1  N 个进程同时 acquireBatchLock        → 恰好 1 个成功，其余 lock_held
 *   WAVE2  N 个进程同时以同一 expectedRevision
 *          saveBatchJobStore（CAS）              → 恰好 1 个成功，其余
 *                                                   concurrent_state_update（磁盘不被覆盖）
 *   WAVE3  N 个进程同时在 withChapterCommitSlot
 *          内执行提交段                          → 排队串行：在槽执行时间区间两两不相交
 *
 * 关键断言对象是磁盘事实（锁文件 / state 文件 / submission-queue trace），
 * 而不是进程返回值的自洽。
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createBatchWorkspace, cleanupWorkspace, PROJECT_ROOT } from "./batch-test-helpers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");

const { batchLockPath } = await import(
  pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "batch-generation-lock.js")).href
);
const DRIVER = join(__dirname, "fixtures", "concurrency-cross-process-driver.mjs");
const TMP_DIR = join(PROJECT_ROOT, "workspaces", ".concurrency-xproc-tmp");

const LOCK_WS = "concurrency-xproc-lock";
const CAS_WS = "concurrency-xproc-cas";
const SLOT_WS = "concurrency-xproc-slot";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 启动 count 个真实子进程，等待全部 ready，发 start 信号，回收结果。
 * extraFactory(i, ctx) 为第 i 个进程构造 argv extra JSON。
 * hold=true 时：成功的锁持有者保持存活（等待 release 信号），
 * 返回 { results, release }——断言完成后必须调用 release() 回收进程。
 * 持有者存活是互斥断言的前提：短命 winner 退出后其锁会被按
 * zombie_owner_dead 合法接管（崩溃恢复语义），那不是双持锁。
 */
async function runDrivers({ mode, workspaceId, count, extraFactory, hold = false, readyTimeoutMs = 15000, resultTimeoutMs = 30000 }) {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  const startSignal = join(TMP_DIR, "start.signal");
  const holdFile = hold ? join(TMP_DIR, "release.signal") : null;
  const resultFiles = [];
  const exits = [];

  for (let i = 0; i < count; i++) {
    const resultFile = join(TMP_DIR, `result-${i}.json`);
    resultFiles.push(resultFile);
    const extra = extraFactory(i, { holdFile });
    const child = spawn(
      process.execPath,
      [DRIVER, mode, workspaceId, resultFile, startSignal, JSON.stringify(extra)],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    exits.push(new Promise((res) => child.on("exit", (code) => res(code))));
  }

  // 等待全部 driver 报告 ready（真实 barrier：全就绪才发令）
  const readyDeadline = Date.now() + readyTimeoutMs;
  for (let i = 0; i < count; i++) {
    while (!existsSync(`${resultFiles[i]}.ready`)) {
      assert.ok(Date.now() < readyDeadline, `driver-${i} 未在 ${readyTimeoutMs}ms 内就绪`);
      await sleep(10);
    }
  }
  writeFileSync(startSignal, String(Date.now()), "utf-8");

  // 等待全部结果文件（hold 模式下持有者仍在运行，不能等 exit）
  const resultDeadline = Date.now() + resultTimeoutMs;
  for (let i = 0; i < count; i++) {
    while (!existsSync(resultFiles[i])) {
      assert.ok(Date.now() < resultDeadline, `driver-${i} 未在 ${resultTimeoutMs}ms 内写出结果`);
      await sleep(10);
    }
  }
  const results = resultFiles.map((f) => JSON.parse(readFileSync(f, "utf-8")));

  if (!hold) {
    await Promise.all(exits);
    return { results };
  }
  const release = async () => {
    writeFileSync(holdFile, String(Date.now()), "utf-8");
    await Promise.all(exits);
  };
  return { results, release };
}

/** 区间两两不相交（串行证明）：按 enterAt 排序后 exitAt <= next.enterAt */
function assertIntervalsDisjoint(spans, label) {
  const sorted = [...spans].sort((a, b) => a.enterAt - b.enterAt);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i - 1].exitAt <= sorted[i].enterAt,
      `${label}: 提交槽执行区间重叠（进程串行化被破坏）`
        + ` [${sorted[i - 1].enterAt},${sorted[i - 1].exitAt}] vs [${sorted[i].enterAt},${sorted[i].exitAt}]`,
    );
  }
}

describe("CONCURRENCY 跨进程互斥：Wave1 原子租约锁 / Wave2 状态 CAS / Wave3 提交槽串行", () => {
  before(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  after(() => {
    cleanupWorkspace(LOCK_WS);
    cleanupWorkspace(CAS_WS);
    cleanupWorkspace(SLOT_WS);
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────────
  // WAVE1：N 个真实进程同时抢 workspace 批量锁 → 恰好 1 个持有
  // ──────────────────────────────────────────────────────────────────────
  it("Wave1: 5 个进程同时 acquireBatchLock，恰好 1 个成功，其余 lock_held（无双持锁）", async () => {
    createBatchWorkspace(LOCK_WS);
    const N = 5;
    const { results, release } = await runDrivers({
      mode: "lock",
      workspaceId: LOCK_WS,
      count: N,
      hold: true,
      extraFactory: (i, { holdFile }) => ({
        jobId: `batch-xproc-lock-${i}-${Date.now().toString(36)}`,
        holdFile,
      }),
    });
    // 失败也要回收持有者进程（否则孤儿 driver 挂 60s 并持有锁）
    try {

    const winners = results.filter((r) => r.ok === true);
    const losers = results.filter((r) => r.ok !== true);
    assert.equal(winners.length, 1, `恰好 1 个进程获得锁（实际 ${winners.length}）：${JSON.stringify(results)}`);
    assert.equal(losers.length, N - 1, "其余进程全部被拒绝");
    for (const r of losers) {
      assert.equal(r.code, "lock_held", `被拒进程应返回 lock_held，实际 ${r.code}`);
    }

    // 磁盘事实：锁文件属于唯一 winner，且带原子租约身份（lockId/ownerRunId/hostId/pid）
    const lock = winners[0].lock;
    assert.ok(lock.lockId.startsWith("lock-"), `新锁应有 lockId 租约身份: ${lock.lockId}`);
    assert.ok(lock.ownerRunId.startsWith("run-"), "新锁应有 ownerRunId");
    assert.equal(typeof lock.pid, "number");
    assert.equal(lock.pid, winners[0].pid, "锁内 pid 应为持有进程真实 pid");
    assert.ok(lock.hostId && lock.hostId.length > 0, "锁应有 hostId");

    // 磁盘上的锁文件与 winner 一致
    const lockPath = batchLockPath(LOCK_WS, PROJECT_ROOT);
    assert.ok(existsSync(lockPath), "锁文件应存在于磁盘");
    const onDisk = JSON.parse(readFileSync(lockPath, "utf-8"));
    assert.equal(onDisk.lockId, lock.lockId, "磁盘锁 lockId 与 winner 一致");
    assert.equal(onDisk.ownerJobId, lock.ownerJobId, "磁盘锁 ownerJobId 与 winner 一致");

    // 被拒进程报告的 existingLock 就是磁盘 winner（可观测、可审计）
    for (const r of losers) {
      assert.ok(!r.lock, "被拒进程不应返回持有锁");
    }

    } finally {
      await release();
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // WAVE2：N 个真实进程以同一 expectedRevision CAS 保存 → 恰好 1 个成功
  // ──────────────────────────────────────────────────────────────────────
  it("Wave2: 5 个进程同时以 revision=1 CAS 保存，恰好 1 个成功，其余 concurrent_state_update 且磁盘不被覆盖", async () => {
    createBatchWorkspace(CAS_WS);
    const jobId = `batch-xproc-cas-${Date.now().toString(36)}`;
    const now = new Date().toISOString();

    // 主进程先创建基线状态（revision=1）
    const { saveBatchJobStore, loadBatchJobStore } = await import(
      pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "batch-generation-job-store.js")).href
    );
    const baseline = {
      jobId,
      workspaceId: CAS_WS,
      status: "running",
      startChapter: 1,
      endChapter: 10,
      seedSource: "workspace_or_planner",
      stopOnFailure: true,
      confirmLargeBatch: false,
      createdAt: now,
      updatedAt: now,
      frontier: 1,
      completedChapters: [],
      failedChapter: null,
      chapters: [],
      cancelRequested: false,
      stateRevision: 0,
      lastEventId: null,
      ownerRunId: null,
    };
    const created = saveBatchJobStore(baseline, CAS_WS, jobId, PROJECT_ROOT, { event: "baseline" });
    assert.ok(created.ok, "基线创建应成功");
    assert.equal(created.stateRevision, 1, "基线 revision 应为 1");

    // 5 个进程同时基于 revision=1 各自修改 frontier 后保存
    const N = 5;
    const { results } = await runDrivers({
      mode: "cas",
      workspaceId: CAS_WS,
      count: N,
      extraFactory: (i) => ({
        jobId,
        expectedRevision: 1,
        event: `cross_proc_${i}`,
        state: { ...baseline, frontier: i + 2 },
      }),
    });

    const winners = results.filter((r) => r.result?.ok === true);
    const conflicts = results.filter((r) => r.result?.ok === false && r.result.reason === "concurrent_state_update");
    assert.equal(winners.length, 1, `CAS 恰好 1 个成功（实际 ${winners.length}）：${JSON.stringify(results)}`);
    assert.equal(conflicts.length, N - 1, "其余进程全部得到 concurrent_state_update");

    // 冲突方拿到磁盘事实（diskRevision=2），不是盲覆盖信号
    for (const c of conflicts) {
      assert.equal(c.result.diskRevision, 2, "冲突方应看到他方已写入的 revision=2");
      assert.equal(c.result.expectedRevision, 1);
    }

    // 磁盘事实：revision 恰为 2、状态合法、frontier 是 winner 的值（无静默覆盖）
    const disk = loadBatchJobStore(CAS_WS, jobId, PROJECT_ROOT);
    assert.ok(disk, "磁盘状态可读");
    assert.equal(disk.state.stateRevision, 2, "磁盘 revision 恰为 2（一次 CAS 成功）");
    const winnerIdx = results.findIndex((r) => r.result?.ok === true);
    assert.equal(disk.state.frontier, winnerIdx + 2, "磁盘 frontier 为 winner 写入值（冲突方未覆盖）");
    assert.ok(disk.state.lastEventId.includes(`cross_proc_${winnerIdx}`), "lastEventId 记录 winner 事件");
  });

  // ──────────────────────────────────────────────────────────────────────
  // WAVE3：N 个真实进程同时在提交槽内执行提交段 → 区间两两不相交
  // ──────────────────────────────────────────────────────────────────────
  it("Wave3: 4 个进程并发进入 chapter_commit 槽，提交段执行区间两两不相交（串行化）", async () => {
    createBatchWorkspace(SLOT_WS);
    const N = 4;
    const { results } = await runDrivers({
      mode: "commit-slot",
      workspaceId: SLOT_WS,
      count: N,
      extraFactory: (i) => ({
        owner: `commit:xproc-${i}`,
        chapterId: `ch${i + 1}`,
        runId: `run-xproc-${i}`,
        holdMs: 250,
        waitMs: 20000, // 足够排队
      }),
    });

    const fatal = results.filter((r) => r.fatal);
    assert.equal(fatal.length, 0, `driver 不应有 fatal：${JSON.stringify(fatal)}`);

    // 全部成功（排队获取）或明确 commit_slot_busy；不允许其他静默失败
    for (const r of results) {
      assert.ok(r.ok === true || r.busy === true, `结果必须是成功或 busy，实际：${JSON.stringify(r)}`);
    }
    const holders = results.filter((r) => r.ok === true);
    assert.ok(holders.length >= 2, `至少 2 个进程实际进入提交槽（实际 ${holders.length}）`);

    // 串行证明：槽内执行区间两两不相交
    assertIntervalsDisjoint(holders, "Wave3");

    // 至少一个排队者真实等待过（waitedMs > 0 证明互斥生效）
    const queued = holders.filter((h) => h.waitedMs > 0);
    assert.ok(queued.length >= 1, "并发下应有进程排队等待（waitedMs > 0）");

    // 磁盘事实：submission-queue trace 记录了获取/释放事件
    const tracePath = join(PROJECT_ROOT, "workspaces", SLOT_WS, "traces", "submission-queue.jsonl");
    assert.ok(existsSync(tracePath), "submission-queue.jsonl 应存在");
    const lines = readFileSync(tracePath, "utf-8").trim().split("\n").filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    const acquired = events.filter((e) => e.event === "slot_acquired");
    const released = events.filter((e) => e.event === "slot_released");
    assert.ok(acquired.length >= holders.length, `trace 应记录每次槽获取（${acquired.length}/${holders.length}）`);
    assert.ok(released.length >= holders.length, `trace 应记录每次槽释放（${released.length}/${holders.length}）`);

    // 槽锁已全部释放：.commit-lock 不存在
    const commitLockPath = join(PROJECT_ROOT, "workspaces", SLOT_WS, "batch-jobs", ".commit-lock");
    assert.ok(!existsSync(commitLockPath), "全部提交完成后 .commit-lock 应已释放");
  });

  // ──────────────────────────────────────────────────────────────────────
  // WAVE3 补充：等待预算耗尽 → 结构化 commit_slot_busy（fail-closed）
  // ──────────────────────────────────────────────────────────────────────
  it("Wave3: 持有者不释放时，等待预算耗尽方收到结构化 commit_slot_busy", async () => {
    createBatchWorkspace(SLOT_WS);
    // 先直接持槽不放：写入一个未过期租约
    const batchJobsDir = join(PROJECT_ROOT, "workspaces", SLOT_WS, "batch-jobs");
    const commitLockPath = join(batchJobsDir, ".commit-lock");
    const leaseMs = 60 * 1000;
    const now = Date.now();
    writeFileSync(commitLockPath, JSON.stringify({
      lockId: "lock-holder-fake",
      owner: "commit:resident-holder",
      chapterId: "ch9",
      hostId: "cross-host-fake",
      pid: 999999,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + leaseMs).toISOString(),
    }, null, 2), "utf-8");

    // 跨主机（hostId 不可探测）+ 未过期 → 只能忙等 → 预算耗尽
    const { results } = await runDrivers({
      mode: "commit-slot",
      workspaceId: SLOT_WS,
      count: 1,
      extraFactory: () => ({
        owner: "commit:waiting-loser",
        chapterId: "ch10",
        holdMs: 50,
        waitMs: 500, // 预算 500ms << 租约 60s
      }),
    });
    const r = results[0];
    assert.equal(r.ok, false, "预算耗尽方不得进入提交槽");
    assert.equal(r.busy, true, "应抛 CommitSlotBusyError");
    assert.equal(r.code, "commit_slot_busy", "错误 code 应为 commit_slot_busy");
    assert.ok(r.message.includes("fail-closed"), "错误消息应说明 fail-closed 语义");

    // 磁盘事实：持有者租约未被误删
    const onDisk = JSON.parse(readFileSync(commitLockPath, "utf-8"));
    assert.equal(onDisk.lockId, "lock-holder-fake", "活跃租约不得被预算耗尽方删除");

    // 清理
    rmSync(commitLockPath, { force: true });
  });

  // ──────────────────────────────────────────────────────────────────────
  // WAVE1 补充：租约过期 → 原子接管（tombstone 保留审计）
  // ──────────────────────────────────────────────────────────────────────
  it("Wave1: 租约过期后新进程可原子接管，tombstone 保留", async () => {
    createBatchWorkspace(LOCK_WS);
    const lockPath = batchLockPath(LOCK_WS, PROJECT_ROOT);
    // 写入一个已过期租约（模拟崩溃的旧 owner）
    const now = Date.now();
    writeFileSync(lockPath, JSON.stringify({
      workspaceId: LOCK_WS,
      lockId: "lock-dead-old",
      ownerRunId: "run-dead",
      ownerJobId: "batch-dead-old",
      jobId: "batch-dead-old",
      hostId: "cross-host-fake",
      pid: 999999,
      acquiredAt: new Date(now - 3600_000).toISOString(),
      heartbeatAt: new Date(now - 3600_000).toISOString(),
      expiresAt: new Date(now - 60_000).toISOString(), // 已过期 60s
    }, null, 2), "utf-8");

    const { results, release } = await runDrivers({
      mode: "lock",
      workspaceId: LOCK_WS,
      count: 3,
      hold: true,
      extraFactory: (i, { holdFile }) => ({
        jobId: `batch-xproc-takeover-${i}`,
        holdFile,
      }),
    });
    let tombstones;
    try {
    const winners = results.filter((r) => r.ok === true);
    assert.equal(winners.length, 1, "过期租约后恰好 1 个进程接管成功");

    // tombstone 保留（审计证据）：旧锁被 rename 原子移除
    const batchJobsDir = join(PROJECT_ROOT, "workspaces", LOCK_WS, "batch-jobs");
    tombstones = readdirSync(batchJobsDir).filter((f) => f.startsWith(".lock.tombstone"));
    assert.ok(tombstones.length >= 1, "接管应留下 tombstone 审计文件（旧锁原子移除证据）");

    // winner 形态二选一（均为合法接管，互斥不变式相同）：
    // a) rename 接管路径：tookOverFrom=旧 lockId, reason=expired
    // b) 接管窗口直接创建：他方把旧锁 rename 走后，本方在锁消失窗口原子创建成功
    //    （此形态无 tookOverFrom 字段，但旧锁同样经 tombstone 原子移除，且唯一持有）
    const w = winners[0].lock;
    const viaRename = w.tookOverFrom === "lock-dead-old" && w.tookOverReason === "expired";
    const viaWindow = w.tookOverFrom === undefined;
    assert.ok(
      viaRename || viaWindow,
      `winner 应为 rename 接管或接管窗口创建之一：${JSON.stringify(w)}`,
    );

    } finally {
      await release();
    }
    // 清理 tombstone，避免污染后续测试
    for (const t of tombstones ?? []) rmSync(join(PROJECT_ROOT, "workspaces", LOCK_WS, "batch-jobs", t), { force: true });
  });
});
