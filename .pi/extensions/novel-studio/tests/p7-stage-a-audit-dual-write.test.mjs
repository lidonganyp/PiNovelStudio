/**
 * P7 Stage A — 双写过渡审计事件（failure_recorded / trajectory_flushed）+ 防漏记
 *
 * 阶段 A 绑定约束（VERBATIM）：
 *   - 旧文件继续写入（quality-trace.json / trajectory.jsonl 不切换写路径）
 *   - 仅追加 trace_persisted、failure_recorded、trajectory_flushed 事件
 *   - 不切换读路径、不删除或修改现有写路径
 *   - 停止闸门 = 投影逐字段一致 + dependency-boundary 通过 + 全量回归
 *
 * 本文件覆盖 unit 级断言：
 *   1. failure_recorded 原样携带完整 FailureEnvelope（逐字段一致，§5.2）
 *   2. failure_recorded 内容寻址去重（§8.1）
 *   3. failureClass 映射（preflight/recoverable/hard_block→blocked）
 *   4. sink 缺省 no-op（未注入不抛、不发射，零行为变化）
 *   5. trajectory_flushed 在 flush 后追加（entryCount + failure 摘要 + 去重）
 *   6. createLegacyTraceAdapter 透传 sink（防漏记，非 no-op）
 *
 * trace_persisted 的 end-to-end 断言在 audit-run-pipeline-integration.test.mjs
 * （需要 runUnifiedPipeline + stub 生产入口，故不在此文件重复搭建工作区）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { createQualityTraceRecorder } from "../dist/craft/quality-trace-recorder.js";
import { createLegacyTraceAdapter } from "../dist/v2/adapters/legacy-trace-adapter.js";
import { createAuditRunSession } from "../dist/v2/core/audit/audit-run-session.js";
import { TrajectoryStore } from "../dist/novelos/trajectory/trajectory-store.js";

/** 捕获型 AuditEventRecorder：记录每次 recordEvent 入参，返回 eventId。 */
function makeSink() {
  const events = [];
  return {
    events,
    recordEvent(input) {
      events.push(input);
      return input.eventId ?? null;
    },
  };
}

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ============================================================================
// 1. failure_recorded 原样携带完整 FailureEnvelope（投影逐字段一致）
// ============================================================================

test("P7-A: failure_recorded 原样携带完整 FailureEnvelope（逐字段一致）", () => {
  const root = tmpRoot("p7a-env-");
  try {
    const sink = makeSink();
    const recorder = createQualityTraceRecorder({
      workspacePath: root,
      workspaceId: "ws-a",
      chapterId: "1",
      auditSink: sink,
    });

    const envelope = {
      stage: "agentic",
      gate: "model_timeout",
      severity: "recoverable",
      reason: "模型调用超时",
      evidence: { provider: "stub", latencyMs: 300001 },
      recoverable: true,
      retryPlan: "tool-layer retry once",
      userActionRequired: false,
    };
    recorder.recordFailureEnvelope(envelope);

    // 旧文件继续写入（不切换写路径）
    const tracePath = recorder.flush();
    assert.ok(existsSync(tracePath), "quality-trace.json 应继续落盘");
    const doc = JSON.parse(readFileSync(tracePath, "utf-8"));
    assert.equal(doc.failureEnvelopes.length, 1, "旧 failureEnvelopes[] 仍写入");

    // 审计事件：恰好一条 failure_recorded
    assert.equal(sink.events.length, 1, "应恰好发射一条审计事件");
    const evt = sink.events[0];
    assert.equal(evt.eventType, "failure_recorded");
    assert.ok(String(evt.eventId).startsWith("failureRecorded:"), `eventId=${evt.eventId}`);
    assert.equal(evt.stage, "agentic");
    assert.equal(evt.status, "failed");
    assert.equal(evt.failureClass, "recoverable");
    assert.equal(evt.gate, "model_timeout");
    assert.equal(evt.decisionReason, "模型调用超时");

    // §5.2：payload.envelope 逐字段一致（非摘要）
    const e = evt.payload.envelope;
    assert.equal(e.stage, envelope.stage);
    assert.equal(e.gate, envelope.gate);
    assert.equal(e.severity, envelope.severity);
    assert.equal(e.reason, envelope.reason);
    assert.deepEqual(e.evidence, envelope.evidence);
    assert.equal(e.recoverable, envelope.recoverable);
    assert.equal(e.retryPlan, envelope.retryPlan);
    assert.equal(e.userActionRequired, envelope.userActionRequired);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P7-A: failure_recorded 内容寻址去重（同一 envelope 只发射一次）", () => {
  const root = tmpRoot("p7a-dedup-");
  try {
    const sink = makeSink();
    const recorder = createQualityTraceRecorder({
      workspacePath: root,
      workspaceId: "ws-a",
      chapterId: "1",
      auditSink: sink,
    });
    const envelope = {
      stage: "preflight",
      gate: "style_missing",
      severity: "preflight",
      reason: "no fingerprint",
      recoverable: false,
    };
    recorder.recordFailureEnvelope(envelope);
    recorder.recordFailureEnvelope(envelope); // 模拟 append 多实例 / 重试重放
    assert.equal(sink.events.length, 1, "重复记录同一 envelope 只应发射一次");

    // evidence 变化 → 不同内容寻址 → 新 eventId → 第二条
    recorder.recordFailureEnvelope({ ...envelope, evidence: { v: 2 } });
    assert.equal(sink.events.length, 2);
    assert.notEqual(sink.events[0].eventId, sink.events[1].eventId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P7-A: 多实例幂等——两个 recorder 共享同一 session 重复发射不置 writeError", () => {
  const root = tmpRoot("p7a-multi-");
  try {
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: "ws-a",
      chapterId: "1",
      chapterNumber: 1,
      persist: false,
    });
    session.start({});

    // 两个独立 recorder（各自实例级去重集合），共享同一 AuditRunSession
    const r1 = createQualityTraceRecorder({
      workspacePath: root, workspaceId: "ws-a", chapterId: "1", auditSink: session,
    });
    const r2 = createQualityTraceRecorder({
      workspacePath: root, workspaceId: "ws-a", chapterId: "1", auditSink: session,
    });

    const envelope = {
      stage: "preflight",
      gate: "style_missing",
      severity: "preflight",
      reason: "no fingerprint",
      recoverable: false,
    };
    r1.recordFailureEnvelope(envelope);
    // 多实例重放：r2 的去重集合为空，但对同一 session 重放同一 eventId
    r2.recordFailureEnvelope(envelope);

    // failure_recorded 恰好一条（会话级幂等），且不进入 writeError
    const failures = session
      .getEntries()
      .filter((e) => e.eventType === "failure_recorded");
    assert.equal(failures.length, 1, "跨实例重放应只保留一条 failure_recorded");
    assert.equal(session.toStageResultsSummary().writeError, null, "重复 eventId 不应置 writeError");

    // 会话未被 writeError 阻断，仍可继续追加新事件
    const appended = session.recordEvent({
      eventType: "custom",
      eventId: "custom:after-multi-instance",
      payload: { eventTypeHint: "smoke" },
    });
    assert.ok(appended, "会话未进入 writeError，仍可追加事件");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P7-A: failureClass 映射（preflight/recoverable/hard_block→blocked）", () => {
  const root = tmpRoot("p7a-cls-");
  try {
    const sink = makeSink();
    const recorder = createQualityTraceRecorder({
      workspacePath: root,
      workspaceId: "ws-a",
      chapterId: "1",
      auditSink: sink,
    });
    recorder.recordFailureEnvelope({
      stage: "s1", gate: "g1", severity: "preflight", reason: "r", recoverable: false,
    });
    recorder.recordFailureEnvelope({
      stage: "s2", gate: "g2", severity: "recoverable", reason: "r", recoverable: true,
    });
    recorder.recordFailureEnvelope({
      stage: "s3", gate: "g3", severity: "hard_block", reason: "r", recoverable: false,
    });
    assert.equal(sink.events.length, 3);
    assert.equal(sink.events[0].failureClass, "preflight");
    assert.equal(sink.events[1].failureClass, "recoverable");
    assert.equal(sink.events[2].failureClass, "blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. sink 缺省 no-op（零行为变化）
// ============================================================================

test("P7-A: 未注入 sink 时 no-op（不抛、不发射，零行为变化）", () => {
  const root = tmpRoot("p7a-noop-");
  try {
    const recorder = createQualityTraceRecorder({
      workspacePath: root,
      workspaceId: "ws-a",
      chapterId: "1",
    });
    assert.doesNotThrow(() => {
      recorder.recordFailureEnvelope({
        stage: "s", gate: "g", severity: "recoverable", reason: "r", recoverable: true,
      });
    });
    assert.ok(recorder.flush(), "旧 trace 写入不受影响");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. trajectory_flushed（TrajectoryStore flush 后追加）
// ============================================================================

test("P7-A: trajectory_flushed 在 flush 后追加（entryCount + failure 摘要 + 去重）", async () => {
  const root = tmpRoot("p7a-traj-");
  try {
    const sink = makeSink();
    const store = new TrajectoryStore({
      projectRoot: root,
      workspaceId: "ws-a",
      sessionId: "sess-1",
      persist: true,
      auditSink: sink,
    });
    store.recordSessionStart({ id: "sess-1" });
    store.recordMessage({ role: "assistant", content: "hi" });
    store.recordFailure({ stage: "agentic", severity: "blocked", reason: "x", recoverable: false });
    await store.flush();

    assert.equal(sink.events.length, 1);
    const evt = sink.events[0];
    assert.equal(evt.eventType, "custom");
    assert.equal(evt.payload.eventTypeHint, "trajectory_flushed");
    assert.equal(evt.payload.entryCount, 3);
    assert.equal(evt.payload.failureCount, 1);
    assert.equal(evt.payload.sessionId, "sess-1");

    // 旧 trajectory.jsonl 仍在写
    assert.ok(existsSync(store.getOutputPath()), "trajectory.jsonl 应继续落盘");

    // 去重：无新条目再次 flush 不重复发射
    await store.flush();
    assert.equal(sink.events.length, 1, "重复 flush（无新条目）不重复发射");

    // 新条目 → entryCount 增长 → 第二条事件
    store.recordOutput({ text: "out" });
    await store.flush();
    assert.equal(sink.events.length, 2);
    assert.equal(sink.events[1].payload.entryCount, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. 防漏记：createLegacyTraceAdapter 透传 sink（非 no-op）
// ============================================================================

test("P7-A: createLegacyTraceAdapter 透传 sink（防漏记，非 no-op）", () => {
  const root = tmpRoot("p7a-adapter-");
  try {
    const sink = makeSink();
    const adapter = createLegacyTraceAdapter({
      workspacePath: root,
      workspaceId: "ws-a",
      chapterId: "1",
      auditSink: sink,
    });
    adapter.record({
      stage: "error",
      timestamp: new Date().toISOString(),
      error: { message: "model timeout", code: "TIMEOUT", recoverable: true },
    });
    // record() 经 recordGate 发射 gate_evaluated（Stage B-Read 起），
    // error 路径再经 recordFailureEnvelope 发射 failure_recorded，共 2 条。
    assert.equal(sink.events.length, 2, "adapter 透传 sink 后应发射 gate_evaluated + failure_recorded");
    assert.equal(sink.events[0].eventType, "gate_evaluated");
    assert.equal(sink.events[1].eventType, "failure_recorded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P7-A: W5 顶层异常路径——adapter + AuditRunSession 发射 failure_recorded 且终态", () => {
  const root = tmpRoot("p7a-w5-");
  try {
    const session = createAuditRunSession({
      projectRoot: root, workspaceId: "ws-a", chapterId: "1", chapterNumber: 1, persist: false,
    });
    session.start({ topLevelException: true });

    // 复刻 public-handlers.ts 最外层 catch 的接线：透传 session 作为 auditSink
    const adapter = createLegacyTraceAdapter({
      workspacePath: root, workspaceId: "ws-a", chapterId: "1", auditSink: session,
    });
    const envelope = {
      stage: "unified_entry",
      gate: "unified_entry_exception",
      severity: "hard_block",
      reason: "统一主链路执行失败：boom",
      evidence: { error: "boom", stack: null },
      recoverable: false,
    };
    adapter.record({
      stage: "unified_entry",
      timestamp: new Date().toISOString(),
      error: { message: "boom", code: "unified_entry", recoverable: false },
      failureEnvelope: envelope,
      contextHash: "top-level-exception",
    });
    adapter.flush();
    session.finalizeInterrupted("unified entry exception: boom", new Error("boom"));

    const entries = session.getEntries();
    assert.ok(entries.some((e) => e.eventType === "run_started"), "run_started 存在");
    const failures = entries.filter((e) => e.eventType === "failure_recorded");
    assert.ok(
      failures.some((f) => f.gate === "unified_entry_exception"),
      "adapter 透传 sink 后发射 failure_recorded（gate=unified_entry_exception）",
    );
    assert.ok(entries.some((e) => e.eventType === "run_interrupted"), "终态 run_interrupted");
    assert.equal(session.toStageResultsSummary().writeError, null, "整条 W5 路径无 writeError");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P7-A: adapter 未注入 sink 时 no-op（不影响旧 trace 写入）", () => {
  const root = tmpRoot("p7a-adapter-noop-");
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: root,
      workspaceId: "ws-a",
      chapterId: "1",
    });
    adapter.record({
      stage: "error",
      timestamp: new Date().toISOString(),
      error: { message: "model timeout", code: "TIMEOUT", recoverable: true },
    });
    const path = adapter.flush();
    assert.ok(path, "旧 trace 写入不受影响");
    const doc = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(doc.failureEnvelopes.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
