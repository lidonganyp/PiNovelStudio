/**
 * P7 Stage B — 读侧投影（rebuildQualityTraceFromEvents / rebuildTrajectoryFromEvents）
 *
 * 阶段 B 绑定约束（VERBATIM）：
 *   - 实现 rebuildQualityTraceFromEvents / rebuildTrajectoryFromEvents 纯函数投影
 *   - 完成读侧投影与双向一致性测试
 *   - 暂不执行 Stage C 写侧收口；暂不删除旧文件；暂不处理 SIGKILL / re-FactGuard
 *
 * 本文件覆盖：
 *   1. failureEnvelopes[] 逐字段还原（8 个 FailureEnvelope 核心字段，§5.2 等价契约）
 *   2. 区分两类 failure_recorded：source=quality_trace 还原，recordFailure/other 跳过
 *   3. unreconstructed 显式标注（诚实声明缺位字段，不伪造等价）
 *   4. trajectory_flushed 摘要还原（sessionId/entryCount/failureCount/outputPath）+ 去重
 *   5. 空事件边界
 *
 * recordedAt 契约说明：审计事件不携带 legacy 的 recordedAt 扩展字段，投影从
 * event.timestamp（Unix ms）best-effort 还原。因此双向一致断言只覆盖 8 个核心
 * FailureEnvelope 字段（§5.2），recordedAt 只断言存在且可解析，不要求与旧文件相等。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  rebuildQualityTraceFromEvents,
  rebuildTrajectoryFromEvents,
} from "../dist/v2/core/audit/trace-projections.js";
import { createQualityTraceRecorder } from "../dist/craft/quality-trace-recorder.js";
import { createAuditRunSession } from "../dist/v2/core/audit/audit-run-session.js";
import { TrajectoryStore } from "../dist/novelos/trajectory/trajectory-store.js";

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ============================================================================
// 1. failureEnvelopes[] 逐字段还原（§5.2 双向一致）
// ============================================================================

test("P7-B: failureEnvelopes[] 逐字段还原（8 核心字段与旧文件一致）", () => {
  const root = tmpRoot("p7b-env-");
  try {
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: "ws-b",
      chapterId: "7",
      chapterNumber: 7,
      persist: false,
    });
    session.start({});

    const recorder = createQualityTraceRecorder({
      workspacePath: root,
      workspaceId: "ws-b",
      chapterId: "7",
      auditSink: session,
    });

    const envelopes = [
      {
        stage: "agentic",
        gate: "model_timeout",
        severity: "recoverable",
        reason: "模型调用超时",
        evidence: { provider: "stub", latencyMs: 300001 },
        recoverable: true,
        retryPlan: { strategy: "retry_gate", maxAttempts: 1 },
        userActionRequired: false,
      },
      {
        stage: "preflight",
        gate: "style_missing",
        severity: "preflight",
        reason: "no fingerprint",
        evidence: { kind: "fingerprint", missing: true },
        recoverable: false,
        retryPlan: null,
        userActionRequired: ["provide style fingerprint"],
      },
    ];
    for (const env of envelopes) recorder.recordFailureEnvelope(env);

    // 旧文件继续写（Stage B 不切写路径，旧 trace 仍是事实来源之一）
    const tracePath = recorder.flush();
    const legacyDoc = JSON.parse(readFileSync(tracePath, "utf-8"));
    assert.equal(legacyDoc.failureEnvelopes.length, 2, "旧 failureEnvelopes[] 仍写入");

    // 读侧投影：仅凭审计流重建
    const events = session.getEntries();
    const rebuilt = rebuildQualityTraceFromEvents(events, {
      workspaceId: "ws-b",
      chapterId: "7",
    });

    assert.equal(rebuilt.schemaVersion, 1);
    assert.equal(rebuilt.workspaceId, "ws-b");
    assert.equal(rebuilt.chapterId, "7");
    assert.equal(rebuilt.failureEnvelopes.length, 2);

    // 8 个 FailureEnvelope 核心字段逐字段一致（§5.2 等价契约）
    for (let i = 0; i < envelopes.length; i++) {
      const legacy = legacyDoc.failureEnvelopes[i];
      const proj = rebuilt.failureEnvelopes[i];
      assert.equal(proj.stage, legacy.stage, `[${i}] stage`);
      assert.equal(proj.gate, legacy.gate, `[${i}] gate`);
      assert.equal(proj.severity, legacy.severity, `[${i}] severity`);
      assert.equal(proj.reason, legacy.reason, `[${i}] reason`);
      assert.deepEqual(proj.evidence, legacy.evidence, `[${i}] evidence`);
      assert.equal(proj.recoverable, legacy.recoverable, `[${i}] recoverable`);
      assert.deepEqual(proj.retryPlan, legacy.retryPlan, `[${i}] retryPlan`);
      assert.deepEqual(proj.userActionRequired, legacy.userActionRequired, `[${i}] userActionRequired`);
    }

    // recordedAt best-effort：存在且可解析（不要求与旧文件逐字节相等）
    for (const proj of rebuilt.failureEnvelopes) {
      assert.ok(proj.recordedAt, "recordedAt 从 event.timestamp 还原");
      assert.ok(!Number.isNaN(Date.parse(proj.recordedAt)), "recordedAt 可解析为时间");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. 区分两类 failure_recorded
// ============================================================================

test("P7-B: 仅还原 source=quality_trace，跳过 recordFailure 类 failure_recorded", () => {
  const root = tmpRoot("p7b-disc-");
  try {
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: "ws-b",
      chapterId: "8",
      chapterNumber: 8,
      persist: false,
    });
    session.start({});

    // 类 A：QualityTraceRecorder 发射（payload.source=quality_trace）
    const recorder = createQualityTraceRecorder({
      workspacePath: root,
      workspaceId: "ws-b",
      chapterId: "8",
      auditSink: session,
    });
    recorder.recordFailureEnvelope({
      stage: "agentic",
      gate: "model_timeout",
      severity: "recoverable",
      reason: "超时",
      recoverable: true,
    });

    // 类 B：recordFailure（payload 携带 nextStep/completedWork，无 source=envelope）
    session.recordFailure({
      stage: "style_optimization",
      reason: "no candidate",
      gate: "style_optimization_no_candidate",
      severity: "blocked",
    });

    const events = session.getEntries();
    const allFailures = events.filter((e) => e.eventType === "failure_recorded");
    assert.equal(allFailures.length, 2, "两类 failure_recorded 均存在");

    const rebuilt = rebuildQualityTraceFromEvents(events, {
      workspaceId: "ws-b",
      chapterId: "8",
    });
    assert.equal(
      rebuilt.failureEnvelopes.length,
      1,
      "只还原 quality_trace 类，recordFailure 类不进入 failureEnvelopes[]",
    );
    assert.equal(rebuilt.failureEnvelopes[0].gate, "model_timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. unreconstructed 显式标注
// ============================================================================

test("P7-B: unreconstructed 显式标注缺位字段（不伪造等价）", () => {
  const root = tmpRoot("p7b-unrec-");
  try {
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: "ws-b",
      chapterId: "9",
      chapterNumber: 9,
      persist: false,
    });
    session.start({});

    const rebuilt = rebuildQualityTraceFromEvents(session.getEntries(), {
      workspaceId: "ws-b",
      chapterId: "9",
    });
    assert.deepEqual(rebuilt.failureEnvelopes, []);
    assert.ok(rebuilt.unreconstructed.includes("events"));
    assert.ok(rebuilt.unreconstructed.includes("patches"));
    // Stage B-Read：gates 已从 unreconstructed 移除（gate_evaluated 事件可重建 gates[]）。
    assert.ok(
      !rebuilt.unreconstructed.includes("gates"),
      "gates 已在 Stage B-Read 可重建，不应再标记为 unreconstructed",
    );
    assert.ok(Array.isArray(rebuilt.gates), "gates 应作为数组字段重建");
    assert.ok(rebuilt.unreconstructed.includes("v2Summary"));
    assert.ok(rebuilt.unreconstructed.includes("strategyContext"));
    assert.ok(rebuilt.unreconstructed.includes("performanceProfile"));
    // createdAt：有 run_started 事件时从最早 timestamp 还原
    assert.ok(rebuilt.createdAt, "run_started 存在 → createdAt 非空");
    assert.ok(!Number.isNaN(Date.parse(rebuilt.createdAt)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. trajectory_flushed 摘要还原 + 去重
// ============================================================================

test("P7-B: trajectory_flushed 摘要还原（sessionId/entryCount/failureCount/outputPath）", async () => {
  const root = tmpRoot("p7b-traj-");
  try {
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: "ws-b",
      chapterId: "10",
      chapterNumber: 10,
      persist: false,
    });
    session.start({});

    const store = new TrajectoryStore({
      projectRoot: root,
      workspaceId: "ws-b",
      sessionId: "sess-b",
      persist: true,
      auditSink: session,
    });
    store.recordSessionStart({ id: "sess-b" });
    store.recordMessage({ role: "assistant", content: "hi" });
    store.recordFailure({ stage: "agentic", severity: "blocked", reason: "x", recoverable: false });
    await store.flush();

    const events = session.getEntries();
    const flushes = rebuildTrajectoryFromEvents(events);
    assert.equal(flushes.length, 1);
    assert.equal(flushes[0].sessionId, "sess-b");
    assert.equal(flushes[0].entryCount, 3);
    assert.equal(flushes[0].failureCount, 1);
    assert.ok(flushes[0].outputPath.endsWith("trajectory.jsonl"), "outputPath 指向旧 trajectory.jsonl");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P7-B: trajectory 投影按 sessionId 去重，保留 entryCount 最大者", () => {
  const events = [
    { eventType: "custom", payload: { eventTypeHint: "trajectory_flushed", sessionId: "s1", entryCount: 3, failureCount: 1, outputPath: "/t/1" } },
    { eventType: "custom", payload: { eventTypeHint: "trajectory_flushed", sessionId: "s1", entryCount: 5, failureCount: 2, outputPath: "/t/1" } },
    { eventType: "custom", payload: { eventTypeHint: "trajectory_flushed", sessionId: "s2", entryCount: 2, failureCount: 0, outputPath: "/t/2" } },
    { eventType: "custom", payload: { eventTypeHint: "other_hint", sessionId: "s3", entryCount: 99, failureCount: 0, outputPath: "/t/3" } },
  ];
  const flushes = rebuildTrajectoryFromEvents(events);
  assert.equal(flushes.length, 2, "s1 去重为一条 + s2 一条；other_hint 忽略");
  const s1 = flushes.find((f) => f.sessionId === "s1");
  assert.equal(s1.entryCount, 5, "s1 保留 entryCount 最大者");
  assert.equal(s1.failureCount, 2);
  const s2 = flushes.find((f) => f.sessionId === "s2");
  assert.equal(s2.entryCount, 2);
});

// ============================================================================
// 5. 空事件边界
// ============================================================================

test("P7-B: 空事件 → 空 failureEnvelopes[] + 空 trajectory flushes", () => {
  const q = rebuildQualityTraceFromEvents([], { workspaceId: "w", chapterId: "1", createdAt: "2026-08-13T00:00:00.000Z" });
  assert.deepEqual(q.failureEnvelopes, []);
  assert.equal(q.createdAt, "2026-08-13T00:00:00.000Z", "无事件时回退 options.createdAt");
  assert.ok(q.unreconstructed.length > 0);

  const t = rebuildTrajectoryFromEvents([]);
  assert.deepEqual(t, []);
});
