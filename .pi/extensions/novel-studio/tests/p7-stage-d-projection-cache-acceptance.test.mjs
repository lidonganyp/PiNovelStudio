/**
 * P7 Stage D — 旧文件收敛为可重建投影缓存（删除前验收）
 *
 * 阶段 D 绑定约束（VERBATIM）：
 *   - 将 quality-trace / trajectory 文件最终收敛为可重建投影缓存
 *   - 完成「删除前验收」：证明旧文件不再承担独立真相源职责，可从审计流 +
 *     内容库逐字段重建；legacy 强制回退仍保留完整文件（删除可逆）
 *   - 暂不执行真实 SIGKILL 注入 / re-FactGuard
 *
 * 本文件覆盖「删除前验收」三项闸门：
 *   1. quality-trace.json 是投影缓存：物化后的 failureEnvelopes[] 与 gates[]
 *      逐字段等价于 rebuildQualityTraceFromEvents（审计流）输出，证明该文件
 *      已不再是独立真相源，删除独立写路径后可由投影重建。
 *   2. trajectory.jsonl 是摘要投影缓存：单行 flush 摘要等价于
 *      rebuildTrajectoryFromEvents 输出；完整 message/tool 明细在
 *      trajectory-content.jsonl 内容库，可独立重建，证明删除旧全量文件安全。
 *   3. legacy 强制回退仍写完整文件：rollback 开关未被破坏，删除可逆。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  rebuildQualityTraceFromEvents,
  rebuildTrajectoryFromEvents,
} from "../dist/v2/core/audit/trace-projections.js";
import { createQualityTraceRecorder } from "../dist/craft/quality-trace-recorder.js";
import { createTraceContentStore } from "../dist/v2/core/audit/trace-content-store.js";
import { createTrajectoryContentStore } from "../dist/v2/core/audit/trajectory-content-store.js";
import { createAuditRunSession } from "../dist/v2/core/audit/audit-run-session.js";
import { TrajectoryStore } from "../dist/novelos/trajectory/trajectory-store.js";

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf-8").trim();
  if (!text) return [];
  return text.split("\n").map((l) => JSON.parse(l));
}

/** 断言两条 failureEnvelope（物化文件 vs 投影重建）8 字段逐字段一致。 */
function assertFailureEnvelopeEquivalent(actual, expected, label) {
  assert.equal(actual.stage, expected.stage, `${label} stage`);
  assert.equal(actual.gate, expected.gate, `${label} gate`);
  assert.equal(actual.severity, expected.severity, `${label} severity`);
  assert.equal(actual.reason, expected.reason, `${label} reason`);
  assert.deepEqual(actual.evidence, expected.evidence, `${label} evidence`);
  assert.equal(actual.recoverable, expected.recoverable, `${label} recoverable`);
  assert.deepEqual(actual.retryPlan, expected.retryPlan, `${label} retryPlan`);
  assert.deepEqual(actual.userActionRequired, expected.userActionRequired, `${label} userActionRequired`);
}

// ============================================================================
// 1. quality-trace.json 是投影缓存：failureEnvelopes + gates 逐字段等价于投影
// ============================================================================

test("P7-D: quality-trace.json 物化缓存 == 审计流投影（failureEnvelopes + gates）", () => {
  const root = tmpRoot("p7d-qt-");
  try {
    const ws = "ws-d";
    const chapterId = "13";
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: ws,
      chapterId,
      chapterNumber: 13,
      persist: false,
    });
    session.start({});

    const recorder = createQualityTraceRecorder({
      workspacePath: root,
      workspaceId: ws,
      chapterId,
      auditSink: session,
      contentStore: createTraceContentStore({ workspacePath: root, workspaceId: ws, chapterId }),
    });

    recorder.recordFailureEnvelope({
      stage: "agentic",
      gate: "model_timeout",
      severity: "recoverable",
      reason: "模型调用超时",
      evidence: { provider: "stub", latencyMs: 300001 },
      recoverable: true,
      retryPlan: { strategy: "retry_gate", maxAttempts: 1 },
      userActionRequired: false,
    });
    recorder.recordGate({
      stage: "v2_final_selected",
      status: "PASS",
      passed: true,
      blocked: false,
      score: 1,
      reason: "selected",
      issueTypes: [],
      revisionHints: [],
      evidence: { strategyContext: { modelVersion: "claude-4.6", selectedStrategyIds: ["s1"] } },
    });

    const tracePath = recorder.flush();
    const file = JSON.parse(readFileSync(tracePath, "utf-8"));

    // 投影：仅凭审计流重建
    const rebuilt = rebuildQualityTraceFromEvents(session.getEntries(), {
      workspaceId: ws,
      chapterId,
    });

    // failureEnvelopes[] 逐字段等价（8 字段）
    assert.equal(file.failureEnvelopes.length, 1, "物化 failureEnvelopes[] 非空");
    assert.equal(rebuilt.failureEnvelopes.length, 1, "投影 failureEnvelopes[] 非空");
    assertFailureEnvelopeEquivalent(file.failureEnvelopes[0], rebuilt.failureEnvelopes[0], "failureEnvelopes[0]");

    // gates[] 逐字段等价（物化缓存与投影来自同一审计流，应完全一致）
    assert.equal(file.gates.length, 1, "物化 gates[] 从审计流重建");
    assert.equal(rebuilt.gates.length, 1, "投影 gates[] 非空");
    const fg = file.gates[0];
    const rg = rebuilt.gates[0];
    assert.equal(fg.stage, rg.stage, "gate stage");
    assert.equal(fg.status, rg.status, "gate status");
    assert.equal(fg.passed, rg.passed, "gate passed");
    assert.equal(fg.blocked, rg.blocked, "gate blocked");
    assert.equal(fg.score, rg.score, "gate score");
    assert.equal(fg.reason, rg.reason, "gate reason");
    assert.deepEqual(fg.issueTypes, rg.issueTypes, "gate issueTypes");
    assert.deepEqual(fg.revisionHints, rg.revisionHints, "gate revisionHints");
    assert.deepEqual(fg.evidence, rg.evidence, "gate evidence（策展子集）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. trajectory.jsonl 是摘要缓存 + 内容库可重建完整明细
// ============================================================================

test("P7-D: trajectory.jsonl 摘要缓存 == 投影，内容库承载可重建完整明细", async () => {
  const root = tmpRoot("p7d-traj-");
  try {
    const ws = "ws-d";
    const sess = "sess-d";
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: ws,
      chapterId: "14",
      chapterNumber: 14,
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

    store.recordSessionStart({ id: sess });
    store.recordMessage({ role: "assistant", content: "不可丢失的完整 message 正文" });
    store.recordToolEvent({ type: "tool_execution_start", toolName: "search_narrative_evidence", toolCallId: "t1", detail: "完整 tool_event 明细" });
    store.recordFailure({ stage: "agentic", severity: "blocked", reason: "x", recoverable: false });
    await store.flush();

    // 旧 trajectory.jsonl：单行摘要缓存，等价于投影重建
    const trajPath = join(root, "workspaces", ws, "novelos-sessions", sess, "trajectory.jsonl");
    const traj = readJsonl(trajPath);
    assert.equal(traj.length, 1, "旧 trajectory.jsonl 收敛为单行摘要");
    assert.equal(traj[0].type, "trajectory_flush_summary");

    const flushes = rebuildTrajectoryFromEvents(session.getEntries());
    assert.equal(flushes.length, 1, "投影重建一条 flush 摘要");
    assert.equal(traj[0].sessionId, flushes[0].sessionId, "摘要 sessionId 与投影一致");
    assert.equal(traj[0].entryCount, flushes[0].entryCount, "摘要 entryCount 与投影一致");
    assert.equal(traj[0].failureCount, flushes[0].failureCount, "摘要 failureCount 与投影一致");

    // 内容库：完整明细可独立重建（message/tool/failure 均不丢失）
    const content = readJsonl(contentStore.getOutputPath());
    assert.equal(content.length, 4, "内容库承载 4 条完整明细");
    assert.equal(content[0].schemaVersion, 1, "内容库条目带 schemaVersion");
    const msg = content.find((e) => e.type === "message");
    assert.equal(msg.data.content, "不可丢失的完整 message 正文", "内容库 message 明细可重建");
    const tool = content.find((e) => e.type === "tool_event");
    assert.equal(tool.data.toolName, "search_narrative_evidence", "内容库 tool_event 明细可重建");
    assert.equal(tool.data.detail, "完整 tool_event 明细", "内容库 tool detail 明细不丢失");
    const failure = content.find((e) => e.type === "failure");
    assert.equal(failure.data.stage, "agentic", "内容库 failure 明细可重建");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. legacy 强制回退仍写完整文件（删除可逆）
// ============================================================================

test("P7-D: legacy 强制回退保留完整文件（rollback 开关未被破坏）", async () => {
  const root = tmpRoot("p7d-legacy-");
  try {
    const ws = "ws-d";
    const sess = "sess-legacy";
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: ws,
      chapterId: "15",
      chapterNumber: 15,
      persist: false,
    });
    session.start({});

    // quality-trace：legacy 模式 failureEnvelope 直接写 document（不经投影物化）
    const recorder = createQualityTraceRecorder({
      workspacePath: root,
      workspaceId: ws,
      chapterId: "15",
      auditSink: session,
      writeMode: "legacy",
    });
    recorder.recordFailureEnvelope({
      stage: "preflight",
      gate: "style_missing",
      severity: "preflight",
      reason: "no fingerprint",
      recoverable: false,
      userActionRequired: ["provide style fingerprint"],
    });
    const tracePath = recorder.flush();
    const file = JSON.parse(readFileSync(tracePath, "utf-8"));
    assert.equal(file.failureEnvelopes.length, 1, "legacy 模式 failureEnvelope 直接落盘");

    // trajectory：legacy 模式完整轨迹进 trajectory.jsonl，不产内容库
    const store = new TrajectoryStore({
      projectRoot: root,
      workspaceId: ws,
      sessionId: sess,
      persist: true,
      auditSink: session,
      writeMode: "legacy",
    });
    store.recordMessage({ role: "assistant", content: "legacy 完整正文" });
    await store.flush();

    const trajPath = join(root, "workspaces", ws, "novelos-sessions", sess, "trajectory.jsonl");
    const traj = readJsonl(trajPath);
    assert.ok(traj.length >= 1, "legacy 模式 trajectory.jsonl 承载完整轨迹");
    assert.equal(traj.find((e) => e.type === "message").data.content, "legacy 完整正文", "legacy 模式 message 明细保留");
    const contentPath = join(root, "workspaces", ws, "novelos-sessions", sess, "trajectory-content.jsonl");
    assert.ok(!existsSync(contentPath), "legacy 模式不产内容库");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
