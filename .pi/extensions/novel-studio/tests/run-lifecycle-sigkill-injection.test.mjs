/**
 * RUN-LIFECYCLE P8 — 真实子进程 SIGKILL 注入 + 重启恢复验收
 *
 * 与既有 run-lifecycle-crash-matrix.test.mjs（事件流/仓储/文件级模拟）互补：
 * 本文件在真实独立子进程中执行 commitAndSave 事务边界，用 OS SIGKILL 硬杀，
 * 暴露跨进程残留状态（正文文件 / 叙事状态 / 磁盘账本 / 内容库）的真实退出恢复行为。
 *
 * 故障点（由 PINOVEL_SIGKILL_FAULT_POINT 控制，注入点写 marker 后同步阻塞）：
 *   1. before_chapter_save      正文保存前（chapter_save_attempted 已记、原子写前）
 *   2. after_chapter_save       正文保存后（chapter_saved 已记、状态提交前）
 *   3. before_state_commit      状态提交前（backup + state_commit_attempted 已记、commit 前）
 *   4. after_state_commit       状态提交后（state_committed 已记、final_submission 前）
 *   5. during_content_store_write 内容库原子写过程中（临时文件已写、rename 前）
 *
 * 每个故障点验证三段：
 *   A. 进程在故障点被 SIGKILL（marker 已写 + stdout 无 "mode:done"）
 *   B. 崩溃瞬间磁盘中间态符合该故障点的语义（正文/状态/账本 的预期状态）
 *   C. 重启恢复（同 runId/traceId 复用事件文件 bootstrap）后达到一致终态：
 *      正文==finalText、状态恰提交一次（无重复累积）、账本已写、聚合 completed、无 foldError
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT_DRIVER = join(EXT_DIR, "tests", "fixtures", "sigkill-commit-driver.mjs");
const CONTENT_STORE_DRIVER = join(EXT_DIR, "tests", "fixtures", "sigkill-content-store-driver.mjs");

const FINAL_TEXT = "暗流在水面之下悄然涌动，叶尘握紧了手中的剑。";
const CANON_ID = "canon:fact:0:ch1";

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 只读检查磁盘中间态（正文 / 状态 / 账本） */
function inspectDisk(root, workspaceId, chapterId) {
  const wsPath = join(root, "workspaces", workspaceId);
  const chapterPath = join(wsPath, "chapters", `${chapterId}.md`);
  const statePath = join(wsPath, "narrative-state-store.json");
  const ledgerPath = join(wsPath, "chapter-approvals", `${chapterId}.commit-intents.json`);
  let stateCanonCount = 0;
  if (existsSync(statePath)) {
    try {
      const raw = JSON.parse(readFileSync(statePath, "utf-8"));
      stateCanonCount = Array.isArray(raw?.canon) ? raw.canon.length : 0;
    } catch {
      stateCanonCount = -1;
    }
  }
  return {
    chapterExists: existsSync(chapterPath),
    chapterContent: existsSync(chapterPath) ? readFileSync(chapterPath, "utf-8") : null,
    stateCanonCount,
    ledgerExists: existsSync(ledgerPath),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询 marker 文件，出现则返回 true，超时返回 false。 */
async function waitForMarker(markerPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) return true;
    await sleep(25);
  }
  return existsSync(markerPath);
}

/**
 * 派生子进程执行 driver，等待故障点 marker，SIGKILL，返回 { markerSeen, stdout, stderr, signal }。
 */
async function spawnAndKill(driver, args, faultPoint, markerDir) {
  const markerPath = join(markerDir, `${faultPoint}.marker`);
  const child = spawn(process.execPath, [driver, ...args], {
    cwd: EXT_DIR,
    env: {
      ...process.env,
      PINOVEL_SIGKILL_FAULT_POINT: faultPoint,
      PINOVEL_SIGKILL_MARKER_DIR: markerDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  const markerSeen = await waitForMarker(markerPath, 15000);
  let signal = null;
  if (markerSeen) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 进程可能已退出
    }
    const exit = await new Promise((resolve) => {
      child.once("exit", (code, sig) => resolve({ code, sig }));
    });
    signal = exit.sig;
  } else {
    // marker 未出现：清理残留进程，避免悬挂
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => child.once("exit", () => resolve()));
  }
  return { markerSeen, stdout, stderr, signal };
}

/** 派生子进程无故障点执行，返回解析后的 stdout JSON。 */
async function spawnRecover(driver, args) {
  const child = spawn(process.execPath, [driver, ...args], {
    cwd: EXT_DIR,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exit = await new Promise((resolve) => {
    child.once("exit", (code, sig) => resolve({ code, sig }));
  });
  return { code: exit.code, signal: exit.sig, stdout, stderr };
}

/** 提交类故障点公共断言（恢复后一致终态） */
function assertRecoveredCommitState(recovered) {
  assert.equal(recovered.code, 0, `recover 子进程应正常退出，stderr=${recovered.stderr}`);
  const out = JSON.parse(recovered.stdout.trim());
  assert.equal(out.mode, "done", "recover 应打印 done JSON");
  assert.equal(out.result.ok, true, `恢复提交应成功，error=${out.result.error}`);
  assert.equal(out.chapterExists, true, "恢复后正文应存在");
  assert.equal(out.chapterContent, FINAL_TEXT, "恢复后正文应 == finalText");
  assert.equal(out.stateCanonCount, 1, "状态应恰提交一次（无重复累积）");
  assert.deepEqual(out.stateCanonIds, [CANON_ID], "canon 条目 id 应唯一且无重复");
  assert.equal(out.ledgerExists, true, "恢复后磁盘账本应已写");
  assert.equal(out.gate.commitIntent.status, "completed", "聚合 commitIntent 应 completed");
  assert.equal(out.gate.workflowState, "committed", "聚合 workflowState 应 committed");
  assert.equal(out.gate.foldError, null, "恢复后不得残留 foldError");
  assert.ok(out.events.includes("final_submission"), "审计流应含 final_submission");
  return out;
}

/** 提交类故障点公共编排：crash → 断言中间态 → recover → 断言终态 */
async function runCommitFaultCase({
  prefix,
  faultPoint,
  expectIntermediate,
}) {
  const root = tmpRoot(prefix);
  try {
    const workspaceId = "ws-sigkill";
    const chapterId = "ch1";
    const runId = `run-sigkill-${faultPoint}`;
    const traceId = `trace-sigkill-${faultPoint}`;
    const commitIntentId = `ci-sigkill-${faultPoint}`;
    const artifactRevision = `rev-sigkill-${faultPoint}`;
    const markerDir = join(root, "markers");

    const args = [
      "--root", root,
      "--ws", workspaceId,
      "--chapter", chapterId,
      "--chapterNumber", "1",
      "--runId", runId,
      "--traceId", traceId,
      "--commitIntentId", commitIntentId,
      "--artifactRevision", artifactRevision,
      "--withState", "1",
    ];

    // A. 真实子进程在故障点被 SIGKILL
    const killed = await spawnAndKill(COMMIT_DRIVER, args, faultPoint, markerDir);
    assert.equal(killed.markerSeen, true, `${faultPoint}：marker 应出现（证明进程到达故障点）`);
    assert.equal(killed.stdout.includes("mode:done"), false, `${faultPoint}：子进程不得在 SIGKILL 前完成`);

    // B. 崩溃瞬间磁盘中间态
    const mid = inspectDisk(root, workspaceId, chapterId);
    expectIntermediate(mid);

    // C. 重启恢复
    const recovered = await spawnRecover(COMMIT_DRIVER, args);
    return { root, mid, out: assertRecoveredCommitState(recovered) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ============================================================================
// 1. before_chapter_save：正文保存前
// ============================================================================

test("SIGKILL before_chapter_save：正文未写 → 重启后完整提交（正文+状态+账本）", async () => {
  await runCommitFaultCase({
    prefix: "sigkill-before-cs-",
    faultPoint: "before_chapter_save",
    expectIntermediate: (mid) => {
      assert.equal(mid.chapterExists, false, "正文保存前崩溃：正文不得存在");
      assert.equal(mid.stateCanonCount, 0, "正文保存前崩溃：状态不得提交");
      assert.equal(mid.ledgerExists, false, "正文保存前崩溃：账本不得存在");
    },
  });
});

// ============================================================================
// 2. after_chapter_save：正文保存后、状态提交前
// ============================================================================

test("SIGKILL after_chapter_save：正文已写但状态未提交 → 重启补状态提交", async () => {
  await runCommitFaultCase({
    prefix: "sigkill-after-cs-",
    faultPoint: "after_chapter_save",
    expectIntermediate: (mid) => {
      assert.equal(mid.chapterExists, true, "正文保存后崩溃：正文应已落盘");
      assert.equal(mid.chapterContent, FINAL_TEXT, "正文保存后崩溃：正文内容应为 finalText");
      assert.equal(mid.stateCanonCount, 0, "正文保存后崩溃：状态尚未提交");
      assert.equal(mid.ledgerExists, false, "正文保存后崩溃：账本尚未写");
    },
  });
});

// ============================================================================
// 3. before_state_commit：状态提交前
// ============================================================================

test("SIGKILL before_state_commit：正文已写、状态未提交 → 重启提交状态", async () => {
  await runCommitFaultCase({
    prefix: "sigkill-before-sc-",
    faultPoint: "before_state_commit",
    expectIntermediate: (mid) => {
      assert.equal(mid.chapterExists, true, "状态提交前崩溃：正文应已落盘");
      assert.equal(mid.chapterContent, FINAL_TEXT, "状态提交前崩溃：正文内容应为 finalText");
      assert.equal(mid.stateCanonCount, 0, "状态提交前崩溃：状态尚未提交");
      assert.equal(mid.ledgerExists, false, "状态提交前崩溃：账本尚未写");
    },
  });
});

// ============================================================================
// 4. after_state_commit：状态提交后、final_submission 前
// ============================================================================

test("SIGKILL after_state_commit：状态已提交 → 重启幂等（不重复累积状态）", async () => {
  await runCommitFaultCase({
    prefix: "sigkill-after-sc-",
    faultPoint: "after_state_commit",
    expectIntermediate: (mid) => {
      assert.equal(mid.chapterExists, true, "状态提交后崩溃：正文应已落盘");
      assert.equal(mid.chapterContent, FINAL_TEXT, "状态提交后崩溃：正文内容应为 finalText");
      assert.equal(mid.stateCanonCount, 1, "状态提交后崩溃：状态应已提交（1 条 canon）");
      assert.equal(mid.ledgerExists, false, "状态提交后崩溃：账本尚未写（final_submission 前）");
    },
  });
});

// ============================================================================
// 5. during_content_store_write：内容库原子写过程中
// ============================================================================

test("SIGKILL during_content_store_write：内容库原子性（旧文件不损坏，无部分写）", async () => {
  const root = tmpRoot("sigkill-content-");
  try {
    const workspaceId = "ws-sigkill";
    const sessionId = "sess-sigkill";
    const markerDir = join(root, "markers");
    const contentPath = join(root, "workspaces", workspaceId, "novelos-sessions", sessionId, "trajectory-content.jsonl");

    // 预置旧内容库（2 条），之后子进程在「写 4 条 → rename 前」崩溃
    const { createTrajectoryContentStore } = await import(
      "../dist/v2/core/audit/trajectory-content-store.js"
    );
    const seedStore = createTrajectoryContentStore({ projectRoot: root, workspaceId, sessionId });
    seedStore.writeAll([
      { type: "message", timestamp: 1700000000000, data: { content: "seed-0" } },
      { type: "message", timestamp: 1700000000001, data: { content: "seed-1" } },
    ]);
    const oldLines = readFileSync(contentPath, "utf-8").trim().split("\n").length;
    assert.equal(oldLines, 2, "预置旧内容库应 2 条");

    const args = ["--root", root, "--ws", workspaceId, "--session", sessionId, "--n", "4"];

    // A. 子进程在 rename 前被 SIGKILL
    const killed = await spawnAndKill(CONTENT_STORE_DRIVER, args, "during_content_store_write", markerDir);
    assert.equal(killed.markerSeen, true, "during_content_store_write：marker 应出现");
    assert.equal(killed.stdout.includes("mode:done"), false, "内容库写入过程中不得完成");

    // B. 旧内容库不损坏（rename 未发生，仅孤儿 .tmp 残留）
    const midLines = readFileSync(contentPath, "utf-8").trim().split("\n").length;
    assert.equal(midLines, 2, "内容库写入过程中崩溃：旧内容库应保持 2 条不损坏");
    assert.ok(existsSync(contentPath + ".tmp"), "应残留孤儿 .tmp（临时文件已写、rename 前）");

    // C. 恢复：无故障点重写 4 条 → 内容库完整 4 条（孤儿 .tmp 被新写的 .tmp 覆盖）
    const recovered = await spawnRecover(CONTENT_STORE_DRIVER, args);
    assert.equal(recovered.code, 0, `内容库 recover 应正常退出，stderr=${recovered.stderr}`);
    const out = JSON.parse(recovered.stdout.trim());
    assert.equal(out.ok, true, "内容库恢复写入应成功");
    assert.equal(out.entryCount, 4, "恢复后内容库应 4 条");
    const finalLines = readFileSync(contentPath, "utf-8").trim().split("\n").length;
    assert.equal(finalLines, 4, "恢复后内容库文件应 4 条完整明细（无部分写）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
