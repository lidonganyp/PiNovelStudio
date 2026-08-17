/**
 * P7 Stage C-3 — TrajectoryStore 降级为审计流/内容库投影（默认 projection，legacy 强制回退）
 *
 * 阶段 C-3 绑定约束（VERBATIM）：
 *   - 保留 legacy 强制回退（PINOVEL_TRAJECTORY_WRITE_MODE=legacy）
 *   - message/tool 明细不得丢失
 *   - 旧 trajectory.jsonl 暂不删除
 *   - SIGKILL 注入 / re-FactGuard 仍不执行
 *
 * 本文件覆盖：
 *   1. resolveTrajectoryWriteMode 开关解析（默认 projection / 显式 legacy 强制回退）
 *   2. legacy 强制回退不变：完整轨迹只进 trajectory.jsonl，不产内容库
 *   3. projection 模式分流：完整明细进 content store + trajectory.jsonl 收敛为摘要投影缓存（Stage D）
 *   4. projection 模式 message/tool 明细只在 content store，旧文件为摘要（Stage D）
 *   5. 默认模式（未设置 writeMode/env）→ projection，自动创建 content store
 *   6. PINOVEL_TRAJECTORY_WRITE_MODE=legacy → 强制回退 legacy
 *   7. 内容库写失败 → 完整明细仍进 trajectory.jsonl + 非静默 audit 事件
 *
 * Stage D 变更：projection 模式下旧 trajectory.jsonl 从「继续全量写」收敛为
 * 「单行 flush 摘要投影缓存」（可重建，与 rebuildTrajectoryFromEvents 一致）；
 * 完整明细只在 trajectory-content.jsonl。生产/eval 读点改读 getDetailOutputPath()。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveTrajectoryWriteMode } from "../dist/v2/core/audit/trajectory-write-mode.js";
import { createTrajectoryContentStore } from "../dist/v2/core/audit/trajectory-content-store.js";
import { TrajectoryStore } from "../dist/novelos/trajectory/trajectory-store.js";
import { createAuditRunSession } from "../dist/v2/core/audit/audit-run-session.js";

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 在 fn 执行期间把 PINOVEL_TRAJECTORY_WRITE_MODE 设为 mode（含 undefined=删除），结束后还原。 */
function withEnvMode(mode, fn) {
  const prev = process.env.PINOVEL_TRAJECTORY_WRITE_MODE;
  if (mode === undefined) {
    delete process.env.PINOVEL_TRAJECTORY_WRITE_MODE;
  } else {
    process.env.PINOVEL_TRAJECTORY_WRITE_MODE = mode;
  }
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.PINOVEL_TRAJECTORY_WRITE_MODE;
    } else {
      process.env.PINOVEL_TRAJECTORY_WRITE_MODE = prev;
    }
  }
}

/** 读取 JSONL 文件为对象数组（空/缺失返回 []）。 */
function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf-8").trim();
  if (!text) return [];
  return text.split("\n").map((l) => JSON.parse(l));
}

function trajectoryPath(root, workspaceId, sessionId) {
  return join(root, "workspaces", workspaceId, "novelos-sessions", sessionId, "trajectory.jsonl");
}

function contentPath(root, workspaceId, sessionId) {
  return join(root, "workspaces", workspaceId, "novelos-sessions", sessionId, "trajectory-content.jsonl");
}

/** 记录一条 message + 一条 tool_event 明细，供断言「明细不丢失」。 */
function recordDetailEntries(store) {
  store.recordSessionStart({ id: "sess-c3" });
  store.recordMessage({ role: "assistant", content: "完整的 message 明细正文" });
  store.recordToolEvent({ type: "tool_execution_start", toolName: "search_narrative_evidence", toolCallId: "t1", detail: "完整的 tool_event 明细" });
}

// ============================================================================
// 1. 开关解析
// ============================================================================

test("P7-C3: resolveTrajectoryWriteMode 默认 projection，显式 legacy 强制回退", () => {
  assert.equal(resolveTrajectoryWriteMode({}), "projection");
  assert.equal(resolveTrajectoryWriteMode({ PINOVEL_TRAJECTORY_WRITE_MODE: "legacy" }), "legacy");
  assert.equal(resolveTrajectoryWriteMode({ PINOVEL_TRAJECTORY_WRITE_MODE: "projection" }), "projection");
  assert.equal(resolveTrajectoryWriteMode({ PINOVEL_TRAJECTORY_WRITE_MODE: "PROJECTION" }), "projection");
});

// ============================================================================
// 2. legacy 强制回退不变
// ============================================================================

test("P7-C3: legacy 模式完整轨迹只进 trajectory.jsonl，不产内容库", async () => {
  const root = tmpRoot("p7c3-legacy-");
  try {
    const ws = "ws-legacy";
    const sess = "sess-legacy";
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: ws,
      chapterId: "1",
      chapterNumber: 1,
      persist: false,
    });
    session.start({});

    const store = new TrajectoryStore({
      projectRoot: root,
      workspaceId: ws,
      sessionId: sess,
      persist: true,
      auditSink: session,
      writeMode: "legacy",
    });
    recordDetailEntries(store);
    await store.flush();

    const traj = readJsonl(trajectoryPath(root, ws, sess));
    assert.equal(traj.length, 3, "legacy 模式 trajectory.jsonl 承载全部 3 条");
    const msg = traj.find((e) => e.type === "message");
    assert.equal(msg.data.content, "完整的 message 明细正文", "legacy 模式 message 明细保留");
    assert.ok(!existsSync(contentPath(root, ws, sess)), "legacy 模式不产内容库");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. projection 模式分流：内容库 + 旧文件全量 + 审计流摘要
// ============================================================================

test("P7-D: projection 模式完整明细进 content store，旧 trajectory.jsonl 收敛为摘要投影缓存", async () => {
  const root = tmpRoot("p7c3-proj-");
  try {
    const ws = "ws-proj";
    const sess = "sess-proj";
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: ws,
      chapterId: "2",
      chapterNumber: 2,
      persist: false,
    });
    session.start({});

    const contentStore = createTrajectoryContentStore({
      projectRoot: root,
      workspaceId: ws,
      sessionId: sess,
    });
    const store = new TrajectoryStore({
      projectRoot: root,
      workspaceId: ws,
      sessionId: sess,
      persist: true,
      auditSink: session,
      writeMode: "projection",
      contentStore,
    });
    recordDetailEntries(store);
    await store.flush();

    // content store：完整明细（message/tool detail 均保留）
    assert.equal(contentStore.size(), 3, "projection 模式完整明细写 content store");
    const contentEntries = readJsonl(contentStore.getOutputPath());
    assert.equal(contentEntries[0].schemaVersion, 1, "content store 条目带 schemaVersion");
    const contentMsg = contentEntries.find((e) => e.type === "message");
    assert.equal(contentMsg.data.content, "完整的 message 明细正文", "content store message 明细保留");
    const contentTool = contentEntries.find((e) => e.type === "tool_event");
    assert.equal(contentTool.data.toolName, "search_narrative_evidence", "content store tool_event 明细保留");

    // 旧 trajectory.jsonl：收敛为单行 flush 摘要投影缓存（不再承载 message/tool 明细）
    const traj = readJsonl(trajectoryPath(root, ws, sess));
    assert.equal(traj.length, 1, "projection 模式旧 trajectory.jsonl 收敛为单行摘要");
    assert.equal(traj[0].type, "trajectory_flush_summary", "旧文件为 flush 摘要");
    assert.equal(traj[0].entryCount, 3, "摘要 entryCount 与完整明细一致");
    assert.equal(traj[0].failureCount, 0, "摘要 failureCount 正确");
    assert.equal(traj[0].sessionId, sess, "摘要 sessionId 正确");

    // 审计流：只带摘要（trajectory_flushed），不含 message/tool 明细
    const flushEvent = session.getEntries().find((e) => e.payload?.eventTypeHint === "trajectory_flushed");
    assert.ok(flushEvent, "审计流应含 trajectory_flushed 摘要");
    assert.equal(flushEvent.payload.entryCount, 3);
    assert.equal(flushEvent.payload.failureCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. message/tool 明细不得丢失（内容库 + 旧文件双份保留）
// ============================================================================

test("P7-D: projection 模式 message/tool 明细只在 content store，旧文件为摘要", async () => {
  const root = tmpRoot("p7c3-detail-");
  try {
    const ws = "ws-detail";
    const sess = "sess-detail";
    const store = new TrajectoryStore({
      projectRoot: root,
      workspaceId: ws,
      sessionId: sess,
      persist: true,
      writeMode: "projection",
    });
    store.recordMessage({ role: "assistant", content: "不可丢失的完整 message 正文" });
    store.recordToolEvent({ type: "tool_execution_start", toolName: "query_narrative_production", toolCallId: "t9", payload: { sourceRefs: ["a", "b"] } });
    await store.flush();

    const contentEntries = readJsonl(contentPath(root, ws, sess));
    assert.equal(contentEntries.length, 2, "content store 承载 2 条明细");
    const contentMsg = contentEntries.find((e) => e.type === "message");
    assert.equal(contentMsg.data.content, "不可丢失的完整 message 正文");
    const contentTool = contentEntries.find((e) => e.type === "tool_event");
    assert.deepEqual(contentTool.data.payload, { sourceRefs: ["a", "b"] });

    // 旧 trajectory.jsonl：单行摘要，不再承载明细
    const traj = readJsonl(trajectoryPath(root, ws, sess));
    assert.equal(traj.length, 1, "旧文件为单行摘要");
    assert.equal(traj[0].type, "trajectory_flush_summary");
    assert.equal(traj[0].entryCount, 2, "摘要 entryCount=2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. 默认模式（未设置 writeMode + 未设置 env）→ projection，自动创建 content store
// ============================================================================

test("P7-C3: 默认（未设置 writeMode 且未设置 env）→ projection 模式", async () => {
  const root = tmpRoot("p7c3-default-");
  try {
    await withEnvMode(undefined, async () => {
      const ws = "ws-default";
      const sess = "sess-default";
      const store = new TrajectoryStore({
        projectRoot: root,
        workspaceId: ws,
        sessionId: sess,
        persist: true,
        // 不传 writeMode，未设置 env → 默认 projection
      });
      store.recordMessage({ role: "assistant", content: "默认投影" });
      await store.flush();

      assert.ok(existsSync(contentPath(root, ws, sess)), "默认 projection 自动创建 content store");
      const contentEntries = readJsonl(contentPath(root, ws, sess));
      assert.equal(contentEntries.length, 1);
      assert.equal(contentEntries[0].data.content, "默认投影");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. PINOVEL_TRAJECTORY_WRITE_MODE=legacy → 强制回退 legacy
// ============================================================================

test("P7-C3: PINOVEL_TRAJECTORY_WRITE_MODE=legacy 强制回退 → legacy 模式", async () => {
  const root = tmpRoot("p7c3-legacyenv-");
  try {
    await withEnvMode("legacy", async () => {
      const ws = "ws-legacyenv";
      const sess = "sess-legacyenv";
      const store = new TrajectoryStore({
        projectRoot: root,
        workspaceId: ws,
        sessionId: sess,
        persist: true,
        // 不传 writeMode，env=legacy → 强制回退 legacy
      });
      store.recordMessage({ role: "assistant", content: "legacy 回退" });
      await store.flush();

      assert.ok(existsSync(trajectoryPath(root, ws, sess)), "legacy 回退 trajectory.jsonl 存在");
      assert.ok(!existsSync(contentPath(root, ws, sess)), "legacy 强制回退不产内容库");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. 内容库写失败 → 完整明细仍进 trajectory.jsonl + 非静默 audit 事件
// ============================================================================

test("P7-C3: 内容库写失败 → 完整明细回退进旧文件 + 非静默 audit 事件", async () => {
  const root = tmpRoot("p7c3-fallback-");
  try {
    const ws = "ws-fallback";
    const sess = "sess-fallback";
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: ws,
      chapterId: "7",
      chapterNumber: 7,
      persist: false,
    });
    session.start({});

    // 模拟内容库写失败：writeAll 恒返回 false
    const failingStore = {
      writeAll: () => false,
      getOutputPath: () => "unused",
      size: () => 0,
      getLastWriteError: () => new Error("disk full"),
    };

    const store = new TrajectoryStore({
      projectRoot: root,
      workspaceId: ws,
      sessionId: sess,
      persist: true,
      auditSink: session,
      writeMode: "projection",
      contentStore: failingStore,
    });
    recordDetailEntries(store);
    await store.flush();

    // 完整明细仍进旧 trajectory.jsonl（不丢 message/tool 明细）
    const traj = readJsonl(trajectoryPath(root, ws, sess));
    assert.equal(traj.length, 3, "内容库失败后旧文件仍承载完整轨迹");
    assert.equal(traj.find((e) => e.type === "message").data.content, "完整的 message 明细正文", "内容库失败时 message 明细不丢失");

    const warn = session.getEntries().find((e) => e.payload?.eventTypeHint === "trajectory_content_store_write_failed");
    assert.ok(warn, "内容库失败应发射非静默审计事件 trajectory_content_store_write_failed");
    assert.equal(warn.payload.sessionId, sess);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
