/**
 * P7 Stage C-2 — quality-trace 默认写路径切换为 projection（默认 ON，legacy 强制回退）
 *
 * 阶段 C-2 绑定约束（VERBATIM）：
 *   - 仅切换 quality-trace，暂不处理 TrajectoryStore
 *   - 保留 PINOVEL_TRACE_WRITE_MODE=legacy 强制回退
 *   - 内容库写入失败不得静默丢失完整 evidence
 *   - 旧文件继续作为投影缓存
 *
 * 本文件覆盖：
 *   1. resolveTraceWriteMode 开关解析（默认 projection / 显式 legacy 强制回退）
 *   2. legacy 强制回退不变：recordGate 完整 evidence 仍进 document.gates（含完整正文）
 *   3. projection 模式分流：完整 evidence 进 content store，旧文件与审计流只带策展子集
 *   4. 等价物化：projection 模式下旧文件 gates[] == rebuildQualityTraceFromEvents 策展子集
 *   5. getEntries 缺失回退：projection 模式但 sink 无 getEntries → flush 不崩、gates 空
 *   6. 默认模式（未设置 writeMode/env）→ projection
 *   7. PINOVEL_TRACE_WRITE_MODE=legacy → 强制回退 legacy
 *   8. 内容库写失败 → 完整 evidence 回退进旧文件 + 非静默 audit 事件
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { resolveTraceWriteMode } from "../dist/v2/core/audit/trace-write-mode.js";
import { createTraceContentStore } from "../dist/v2/core/audit/trace-content-store.js";
import { rebuildQualityTraceFromEvents } from "../dist/v2/core/audit/trace-projections.js";
import { createQualityTraceRecorder } from "../dist/craft/quality-trace-recorder.js";
import { createAuditRunSession } from "../dist/v2/core/audit/audit-run-session.js";

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 在 fn 执行期间把 PINOVEL_TRACE_WRITE_MODE 设为 mode（含 undefined=删除），结束后还原。 */
function withEnvMode(mode, fn) {
  const prev = process.env.PINOVEL_TRACE_WRITE_MODE;
  if (mode === undefined) {
    delete process.env.PINOVEL_TRACE_WRITE_MODE;
  } else {
    process.env.PINOVEL_TRACE_WRITE_MODE = mode;
  }
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.PINOVEL_TRACE_WRITE_MODE;
    } else {
      process.env.PINOVEL_TRACE_WRITE_MODE = prev;
    }
  }
}

/** 一个携带「完整正文」的 gate evidence（用于证明策展子集不携带 fullProse）。 */
function fullEvidence() {
  return {
    strategyContext: {
      modelVersion: "claude-4.6",
      selectedStrategyIds: ["s1", "s2"],
      sourceChapter: "11",
      opportunityType: "author_style",
    },
    modelCalls: [
      { route: "claude", kind: "generate", model: "claude-4.6", durationMs: 1000, failed: false, provider: "claude" },
    ],
    fullProse: "这是完整的候选正文，不应进入审计流与旧文件投影缓存，只进 content store。",
    candidates: [{ id: "c1", text: "候选正文全文" }],
  };
}

function gateRecord() {
  return {
    stage: "v2_final_selected",
    status: "PASS",
    passed: true,
    blocked: false,
    score: 1,
    reason: "selected",
    issueTypes: [],
    revisionHints: [],
    evidence: fullEvidence(),
  };
}

// ============================================================================
// 1. 开关解析
// ============================================================================

test("P7-C2: resolveTraceWriteMode 默认 projection，显式 legacy 强制回退", () => {
  assert.equal(resolveTraceWriteMode({}), "projection");
  assert.equal(resolveTraceWriteMode({ PINOVEL_TRACE_WRITE_MODE: "legacy" }), "legacy");
  assert.equal(resolveTraceWriteMode({ PINOVEL_TRACE_WRITE_MODE: "projection" }), "projection");
  assert.equal(resolveTraceWriteMode({ PINOVEL_TRACE_WRITE_MODE: "PROJECTION" }), "projection");
});

// ============================================================================
// 2. legacy 强制回退不变（显式 PINOVEL_TRACE_WRITE_MODE=legacy / writeMode=legacy）
// ============================================================================

test("P7-C2: legacy 模式 recordGate 完整 evidence 仍进 document.gates（含 fullProse）", () => {
  const root = tmpRoot("p7c2-legacy-");
  try {
    const ws = "ws-legacy";
    const chapterId = "1";
    const recorder = createQualityTraceRecorder({
      workspacePath: join(root, "workspaces"),
      workspaceId: ws,
      chapterId,
      writeMode: "legacy",
    });
    recorder.recordGate(gateRecord());
    const path = recorder.flush();

    const doc = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(doc.gates.length, 1, "legacy 模式 gates 仍直接写入");
    assert.ok(doc.gates[0].evidence.fullProse, "legacy 模式完整 evidence 保留（含完整正文）");
    // legacy 模式不产生 content store（未启用）
    const contentPath = join(root, "workspaces", ws, "traces", `${chapterId}-content.jsonl`);
    assert.ok(!existsSync(contentPath), "legacy 模式不应产生 content store");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. projection 模式分流
// ============================================================================

test("P7-C2: projection 模式完整 evidence 进 content store，旧文件/审计流只带策展子集", () => {
  const root = tmpRoot("p7c1-proj-");
  try {
    const ws = "ws-proj";
    const chapterId = "2";
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: ws,
      chapterId,
      chapterNumber: 2,
      persist: false,
    });
    session.start({});

    const contentStore = createTraceContentStore({
      workspacePath: join(root, "workspaces"),
      workspaceId: ws,
      chapterId,
    });
    const recorder = createQualityTraceRecorder({
      workspacePath: join(root, "workspaces"),
      workspaceId: ws,
      chapterId,
      auditSink: session,
      writeMode: "projection",
      contentStore,
    });
    recorder.recordGate(gateRecord());
    const path = recorder.flush();

    // content store：完整 evidence（含 fullProse）
    assert.equal(contentStore.size(), 1, "projection 模式完整 evidence 应写 content store");
    const contentLines = readFileSync(contentStore.getOutputPath(), "utf-8").trim().split("\n");
    const contentEntry = JSON.parse(contentLines[0]);
    assert.equal(contentEntry.stage, "v2_final_selected");
    assert.ok(contentEntry.evidence.fullProse, "content store 保留完整正文");
    assert.deepEqual(contentEntry.evidence.candidates, [{ id: "c1", text: "候选正文全文" }]);

    // 旧文件：策展子集（无 fullProse）
    const doc = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(doc.gates.length, 1, "projection 模式旧文件 gates 为投影缓存");
    assert.ok(!doc.gates[0].evidence.fullProse, "旧文件投影缓存不携带完整正文");
    assert.deepEqual(doc.gates[0].evidence.strategyContext, fullEvidence().strategyContext);

    // 审计流：策展子集（无 fullProse）
    const gateEvent = session.getEntries().find((e) => e.eventType === "gate_evaluated");
    assert.ok(gateEvent, "审计流应含 gate_evaluated");
    assert.ok(!gateEvent.payload.evidence.fullProse, "审计流 gate_evaluated 不携带完整正文");
    assert.deepEqual(gateEvent.payload.evidence.modelCalls, fullEvidence().modelCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. 等价物化：旧文件 gates[] == rebuildQualityTraceFromEvents 策展子集
// ============================================================================

test("P7-C2: projection 模式旧文件 gates[] 与投影重建等价", () => {
  const root = tmpRoot("p7c1-equiv-");
  try {
    const ws = "ws-equiv";
    const chapterId = "3";
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: ws,
      chapterId,
      chapterNumber: 3,
      persist: false,
    });
    session.start({});

    const recorder = createQualityTraceRecorder({
      workspacePath: join(root, "workspaces"),
      workspaceId: ws,
      chapterId,
      auditSink: session,
      writeMode: "projection",
    });
    recorder.recordGate(gateRecord());
    recorder.recordGate({
      stage: "story_preservation",
      status: "PASS",
      passed: true,
      blocked: false,
      score: 0.9,
      reason: "ok",
      issueTypes: [],
      revisionHints: [],
      evidence: { modelCalls: [{ route: "glm", kind: "judge", durationMs: 500 }] },
    });
    const path = recorder.flush();

    const doc = JSON.parse(readFileSync(path, "utf-8"));
    const rebuilt = rebuildQualityTraceFromEvents(session.getEntries(), { workspaceId: ws, chapterId });

    assert.equal(doc.gates.length, rebuilt.gates.length, "旧文件 gates 数量与投影一致");
    for (let i = 0; i < rebuilt.gates.length; i++) {
      assert.equal(doc.gates[i].stage, rebuilt.gates[i].stage, `[${i}] stage`);
      assert.equal(doc.gates[i].passed, rebuilt.gates[i].passed, `[${i}] passed`);
      assert.equal(doc.gates[i].blocked, rebuilt.gates[i].blocked, `[${i}] blocked`);
      assert.deepEqual(doc.gates[i].evidence, rebuilt.gates[i].evidence, `[${i}] evidence 策展子集等价`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. getEntries 缺失回退
// ============================================================================

test("P7-C2: projection 模式但 sink 无 getEntries → flush 不崩、gates 空（不伪造）", () => {
  const root = tmpRoot("p7c1-noentries-");
  try {
    const ws = "ws-noe";
    const chapterId = "4";
    // 只有 recordEvent 的 sink（无 getEntries）
    const sink = { recordEvent: () => "ignored" };
    const recorder = createQualityTraceRecorder({
      workspacePath: join(root, "workspaces"),
      workspaceId: ws,
      chapterId,
      auditSink: sink,
      writeMode: "projection",
    });
    recorder.recordGate(gateRecord());
    const path = recorder.flush();

    const doc = JSON.parse(readFileSync(path, "utf-8"));
    assert.deepEqual(doc.gates, [], "无 getEntries 时投影缓存 gates 为空（不伪造等价）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. 默认模式（未设置 writeMode + 未设置 env）→ projection
// ============================================================================

test("P7-C2: 默认（未设置 writeMode 且未设置 env）→ projection 模式", () => {
  const root = tmpRoot("p7c2-default-");
  try {
    withEnvMode(undefined, () => {
      const ws = "ws-default";
      const chapterId = "5";
      const session = createAuditRunSession({
        projectRoot: root,
        workspaceId: ws,
        chapterId,
        chapterNumber: 5,
        persist: false,
      });
      session.start({});

      const recorder = createQualityTraceRecorder({
        workspacePath: join(root, "workspaces"),
        workspaceId: ws,
        chapterId,
        auditSink: session,
        // 不传 writeMode，未设置 env → 默认 projection
      });
      recorder.recordGate(gateRecord());
      const path = recorder.flush();

      const doc = JSON.parse(readFileSync(path, "utf-8"));
      assert.equal(doc.gates.length, 1, "默认 projection 旧文件 gates 为投影缓存");
      assert.ok(!doc.gates[0].evidence.fullProse, "默认 projection 旧文件不携带完整正文");

      // 默认 projection 自动创建 content store 并承载完整 evidence
      const contentPath = join(root, "workspaces", ws, "traces", `${chapterId}-content.jsonl`);
      assert.ok(existsSync(contentPath), "默认 projection 自动创建 content store");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. PINOVEL_TRACE_WRITE_MODE=legacy → 强制回退 legacy
// ============================================================================

test("P7-C2: PINOVEL_TRACE_WRITE_MODE=legacy 强制回退 → legacy 模式", () => {
  const root = tmpRoot("p7c2-legacyenv-");
  try {
    withEnvMode("legacy", () => {
      const ws = "ws-legacyenv";
      const chapterId = "6";
      const recorder = createQualityTraceRecorder({
        workspacePath: join(root, "workspaces"),
        workspaceId: ws,
        chapterId,
        // 不传 writeMode，env=legacy → 强制回退 legacy
      });
      recorder.recordGate(gateRecord());
      const path = recorder.flush();

      const doc = JSON.parse(readFileSync(path, "utf-8"));
      assert.equal(doc.gates.length, 1);
      assert.ok(doc.gates[0].evidence.fullProse, "legacy 强制回退保留完整正文");
      const contentPath = join(root, "workspaces", ws, "traces", `${chapterId}-content.jsonl`);
      assert.ok(!existsSync(contentPath), "legacy 强制回退不产生 content store");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. 内容库写失败 → 完整 evidence 回退进旧文件 + 非静默 audit 事件
// ============================================================================

test("P7-C2: 内容库写失败 → 完整 evidence 回退进旧文件 + 非静默 audit 事件", () => {
  const root = tmpRoot("p7c2-fallback-");
  try {
    const ws = "ws-fallback";
    const chapterId = "7";
    const session = createAuditRunSession({
      projectRoot: root,
      workspaceId: ws,
      chapterId,
      chapterNumber: 7,
      persist: false,
    });
    session.start({});

    // 模拟内容库写失败：writeGate 恒返回 false
    const failingStore = {
      writeGate: () => false,
      getOutputPath: () => "unused",
      size: () => 0,
      getLastWriteError: () => new Error("disk full"),
    };

    const recorder = createQualityTraceRecorder({
      workspacePath: join(root, "workspaces"),
      workspaceId: ws,
      chapterId,
      auditSink: session,
      writeMode: "projection",
      contentStore: failingStore,
    });
    recorder.recordGate(gateRecord());
    const path = recorder.flush();

    const doc = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(doc.gates.length, 1, "内容库失败后旧文件仍承载 gate");
    assert.ok(doc.gates[0].evidence.fullProse, "内容库失败时完整 evidence 回退进旧文件（不丢失）");

    const entries = session.getEntries();
    const warn = entries.find((e) => e.payload?.eventTypeHint === "trace_content_store_write_failed");
    assert.ok(warn, "内容库失败应发射非静默审计事件 trace_content_store_write_failed");
    assert.equal(warn.gate, "v2_final_selected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
