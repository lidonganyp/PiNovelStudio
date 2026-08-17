/**
 * AUDIT-EVENT — Phase 0/1/2 契约、FailureEnvelope 统一、追加式存储与恢复
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AUDIT_EVENT_SCHEMA_VERSION,
  createAuditEvent,
  validateAuditEvent,
  createTraceId,
  createRunId,
  createEventId,
  computeContentHash,
  computeStableJsonHash,
  isFullSha256Hex,
  AuditEventStore,
  recoverEventsJsonl,
  buildRecoveryFollowUpHint,
  diagnoseTraceCompleteness,
  mapTrajectoryEntriesToAuditEvents,
  mapLegacyFailureToNormalized,
  LEGACY_FIELD_COMPAT_MAP,
  createAuditRunSession,
} from "../dist/v2/core/audit/index.js";
import {
  buildProductionFailureEnvelope,
  toUnifiedFailureEnvelope,
  productionFailureToAuditEvent,
} from "../dist/v2/core/failure-envelope.js";
import { mapLegacyFailureClass } from "../dist/v2/core/failure-types.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "audit-event-"));
}

describe("Phase 0: AuditEvent contract", () => {
  test("schema version frozen", () => {
    assert.equal(AUDIT_EVENT_SCHEMA_VERSION, "1.0.0");
  });

  test("createAuditEvent requires parentEventId=null for run_started", () => {
    assert.throws(() =>
      createAuditEvent({
        traceId: createTraceId(),
        runId: createRunId(),
        parentEventId: "evt-not-null",
        sequence: 1,
        actor: "orchestrator",
        stage: "run",
        eventType: "run_started",
        status: "started",
        evidenceLevel: "observed",
      }),
    );
  });

  test("createAuditEvent accepts valid run lifecycle pair", () => {
    const traceId = createTraceId();
    const runId = createRunId();
    const start = createAuditEvent({
      traceId,
      runId,
      parentEventId: null,
      sequence: 1,
      actor: "orchestrator",
      stage: "run",
      eventType: "run_started",
      status: "started",
      evidenceLevel: "observed",
    });
    const end = createAuditEvent({
      traceId,
      runId,
      parentEventId: start.eventId,
      sequence: 2,
      actor: "orchestrator",
      stage: "run",
      eventType: "run_finished",
      status: "completed",
      evidenceLevel: "observed",
    });
    assert.equal(start.sequence, 1);
    assert.equal(end.parentEventId, start.eventId);
    assert.equal(validateAuditEvent(start).ok, true);
    assert.equal(validateAuditEvent(end).ok, true);
  });

  test("rejects legacy soft/hard as failureClass on write validation", () => {
    const base = {
      schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
      traceId: createTraceId(),
      runId: createRunId(),
      eventId: createEventId(),
      parentEventId: null,
      sequence: 1,
      timestamp: Date.now(),
      actor: "orchestrator",
      stage: "run",
      eventType: "failure_recorded",
      status: "failed",
      evidenceLevel: "observed",
    };
    assert.equal(validateAuditEvent({ ...base, failureClass: "soft" }).ok, false);
    assert.equal(validateAuditEvent({ ...base, failureClass: "hard" }).ok, false);
    assert.equal(validateAuditEvent({ ...base, failureClass: "hard_block" }).ok, false);
    assert.equal(validateAuditEvent({ ...base, failureClass: "blocked" }).ok, true);
  });

  test("legacy field compat map is non-empty documentation", () => {
    assert.ok(Object.keys(LEGACY_FIELD_COMPAT_MAP).length >= 10);
  });
});

describe("Phase 0: content hash", () => {
  test("UTF-8 SHA-256 full hex", () => {
    const h = computeContentHash("你好世界");
    assert.equal(isFullSha256Hex(h), true);
    assert.equal(h, computeContentHash("你好世界"));
    assert.notEqual(h, computeContentHash("hello"));
  });

  test("stable json hash ignores key order", () => {
    assert.equal(computeStableJsonHash({ b: 1, a: 2 }), computeStableJsonHash({ a: 2, b: 1 }));
  });
});

describe("Phase 1: FailureEnvelope unification", () => {
  test("buildProductionFailureEnvelope emits eventId + failureClass", () => {
    const env = buildProductionFailureEnvelope({
      stage: "agentic",
      gate: "model_timeout",
      reason: "timeout",
      severity: "recoverable",
      attempt: 0,
      maxAttempts: 1,
      causedByEventId: "evt-prev",
    });
    assert.ok(env.eventId);
    assert.ok(env.traceId);
    assert.equal(env.failureClass, "recoverable");
    assert.equal(env.causedByEventId, "evt-prev");
    assert.equal(env.parentEventId, null);
    assert.equal(typeof env.attempt, "number");
    assert.equal(typeof env.maxAttempts, "number");
  });

  test("legacy soft/hard severity maps to production failureClass", () => {
    assert.equal(mapLegacyFailureClass("soft"), "recoverable");
    assert.equal(mapLegacyFailureClass("hard"), "blocked");
    assert.equal(mapLegacyFailureClass("hard_block"), "blocked");
    const env = buildProductionFailureEnvelope({
      stage: "x",
      reason: "y",
      severity: "hard",
    });
    assert.equal(env.failureClass, "blocked");
    assert.notEqual(env.failureClass, "soft");
  });

  test("toUnifiedFailureEnvelope preserves causal fields", () => {
    const env = buildProductionFailureEnvelope({
      stage: "commit",
      reason: "state fail",
      failureClass: "blocked",
      parentEventId: "evt-parent",
      causedByEventId: "evt-cause",
    });
    const unified = toUnifiedFailureEnvelope(env);
    assert.equal(unified.eventId, env.eventId);
    assert.equal(unified.parentEventId, "evt-parent");
    assert.equal(unified.causedByEventId, "evt-cause");
    assert.equal(unified.failureClass, "blocked");
  });

  test("productionFailureToAuditEvent builds failure_recorded", () => {
    const env = buildProductionFailureEnvelope({
      stage: "preflight",
      reason: "missing style",
      failureClass: "preflight",
      userActionRequired: ["add_style_fingerprint"],
    });
    const event = productionFailureToAuditEvent(env, {
      runId: createRunId(),
      sequence: 2,
      parentEventId: "evt-start",
    });
    assert.equal(event.eventType, "failure_recorded");
    assert.equal(event.failureClass, "preflight");
    assert.equal(event.evidenceLevel, "observed");
    assert.deepEqual(event.userActionRequired, ["add_style_fingerprint"]);
    assert.equal(validateAuditEvent(event).ok, true);
  });

  test("mapLegacyFailureToNormalized reads craft soft envelope", () => {
    const n = mapLegacyFailureToNormalized({
      stage: "2-narrator",
      severity: "soft",
      gate: "anti_ai",
      reason: "pattern",
      recoverable: true,
      userActionRequired: true,
    });
    assert.ok(n);
    assert.equal(n.failureClass, "recoverable");
    assert.equal(n.evidenceLevel, "derived");
  });

  test("trajectory failure entry maps to failure_recorded", () => {
    const events = mapTrajectoryEntriesToAuditEvents(
      [
        { type: "session_start", timestamp: 1, data: { id: "s1" } },
        {
          type: "failure",
          timestamp: 2,
          data: {
            stage: "agentic",
            severity: "hard",
            reason: "blocked",
            recoverable: false,
            failureClass: "blocked",
          },
        },
        { type: "session_end", timestamp: 3, data: {} },
      ],
      { traceId: createTraceId(), runId: createRunId() },
    );
    assert.equal(events[0].eventType, "run_started");
    assert.equal(events[1].eventType, "failure_recorded");
    assert.equal(events[1].failureClass, "blocked");
    assert.equal(events[2].eventType, "run_finished");
  });
});

describe("Phase 2: append-only store + recovery", () => {
  test("memory mode append assigns strict sequence and parent chain", () => {
    const store = new AuditEventStore({
      projectRoot: tempRoot(),
      workspaceId: "ws-mem",
      persist: false,
    });
    const a = store.startRun({ chapterId: "ch1" });
    const b = store.append({
      actor: "orchestrator",
      stage: "context_compile",
      eventType: "context_compiled",
      status: "completed",
      evidenceLevel: "observed",
    });
    const c = store.finishRun("run_finished");
    assert.equal(a.event.sequence, 1);
    assert.equal(b.event.sequence, 2);
    assert.equal(c.event.sequence, 3);
    assert.equal(a.event.parentEventId, null);
    assert.equal(b.event.parentEventId, a.event.eventId);
    assert.equal(c.event.parentEventId, b.event.eventId);
    assert.equal(a.persisted, false);
  });

  test("persist mode writes JSONL lines append-only", () => {
    const root = tempRoot();
    try {
      const store = new AuditEventStore({
        projectRoot: root,
        workspaceId: "ws1",
        runId: "run-test-1",
        persist: true,
      });
      store.startRun();
      store.append({
        actor: "model",
        stage: "model_turn",
        eventType: "model_turn_completed",
        status: "completed",
        evidenceLevel: "observed",
        actualProvider: "glm",
        actualModel: "glm-x",
        inputHash: computeContentHash("in"),
        outputHash: computeContentHash("out"),
      });
      store.finishRun("run_finished");
      const path = store.outputPath;
      assert.ok(path && existsSync(path));
      const lines = readFileSync(path, "utf-8").trim().split("\n");
      assert.equal(lines.length, 3);
      const parsed = lines.map((l) => JSON.parse(l));
      assert.equal(parsed[0].eventType, "run_started");
      assert.equal(parsed[2].eventType, "run_finished");
      assert.equal(parsed[1].inputHash.length, 64);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("duplicate eventId rejected", () => {
    const store = new AuditEventStore({
      projectRoot: tempRoot(),
      workspaceId: "ws",
      persist: false,
    });
    const id = createEventId();
    store.append({
      eventId: id,
      actor: "orchestrator",
      stage: "run",
      eventType: "run_started",
      status: "started",
      evidenceLevel: "observed",
      parentEventId: null,
    });
    assert.throws(() =>
      store.append({
        eventId: id,
        actor: "orchestrator",
        stage: "run",
        eventType: "run_finished",
        status: "completed",
        evidenceLevel: "observed",
      }),
    );
  });

  test("sequence jump rejected", () => {
    const store = new AuditEventStore({
      projectRoot: tempRoot(),
      workspaceId: "ws",
      persist: false,
    });
    store.startRun();
    assert.throws(() =>
      store.append({
        sequence: 99,
        actor: "orchestrator",
        stage: "run",
        eventType: "run_finished",
        status: "completed",
        evidenceLevel: "observed",
      }),
    );
  });

  test("empty store rejects non-run_started first event", () => {
    const store = new AuditEventStore({
      projectRoot: tempRoot(),
      workspaceId: "ws",
      persist: false,
    });
    assert.throws(
      () =>
        store.append({
          actor: "orchestrator",
          stage: "run",
          eventType: "run_finished",
          status: "completed",
          evidenceLevel: "observed",
          parentEventId: null,
        }),
      /first event must be run_started/,
    );
  });

  test("orphan parentEventId rejected after start", () => {
    const store = new AuditEventStore({
      projectRoot: tempRoot(),
      workspaceId: "ws",
      persist: false,
    });
    store.startRun();
    assert.throws(
      () =>
        store.append({
          actor: "orchestrator",
          stage: "run",
          eventType: "run_finished",
          status: "completed",
          evidenceLevel: "observed",
          parentEventId: "evt-does-not-exist",
        }),
      /orphan parentEventId/,
    );
  });

  test("crash recovery truncates incomplete trailing line without losing prior events", () => {
    const root = tempRoot();
    try {
      const runId = "run-crash-1";
      const dir = join(root, "workspaces", "ws", "traces", runId);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "events.jsonl");
      const e1 = createAuditEvent({
        traceId: "trc-crash",
        runId,
        parentEventId: null,
        sequence: 1,
        actor: "orchestrator",
        stage: "run",
        eventType: "run_started",
        status: "started",
        evidenceLevel: "observed",
        timestamp: 1000,
      });
      const e2 = createAuditEvent({
        traceId: "trc-crash",
        runId,
        parentEventId: e1.eventId,
        sequence: 2,
        actor: "tool_runtime",
        stage: "tool",
        eventType: "tool_call_started",
        status: "started",
        evidenceLevel: "observed",
        timestamp: 1001,
        payload: { toolCallId: "tc-1" },
      });
      writeFileSync(
        path,
        JSON.stringify(e1) + "\n" + JSON.stringify(e2) + "\n" + '{"eventId":"evt-partial"',
        "utf-8",
      );

      const report = recoverEventsJsonl(path);
      assert.equal(report.truncatedTrailingGarbage, true);
      assert.equal(report.events.length, 2);
      assert.equal(report.events[0].eventId, e1.eventId);
      assert.equal(report.events[1].eventId, e2.eventId);
      assert.equal(report.openRun, true);
      assert.equal(report.lastCompleteSequence, 2);

      const disk = readFileSync(path, "utf-8");
      assert.ok(!disk.includes("evt-partial"));
      assert.equal(disk.trim().split("\n").length, 2);

      const hint = buildRecoveryFollowUpHint(report);
      assert.equal(hint.shouldEmitRunRecovered, true);

      const store = new AuditEventStore({
        projectRoot: root,
        workspaceId: "ws",
        runId,
        traceId: "trc-crash",
        persist: true,
      });
      assert.equal(store.getSequence(), 2);
      const recovered = store.append({
        actor: "recovery",
        stage: "recovery",
        eventType: "run_recovered",
        status: "recovered",
        evidenceLevel: "observed",
        decisionReason: hint.reason,
      });
      assert.equal(recovered.event.sequence, 3);
      store.finishRun("run_interrupted", {
        decisionReason: "open tool call after crash",
        payload: { openToolCallIds: ["tc-1"] },
      });
      assert.equal(store.getSnapshot().runTerminal, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parallel-style sequential allocation stays contiguous", () => {
    const store = new AuditEventStore({
      projectRoot: tempRoot(),
      workspaceId: "ws",
      persist: false,
    });
    store.startRun();
    const parent = store.getSnapshot().lastEventId;
    const t1 = store.append({
      actor: "tool_runtime",
      stage: "tool",
      eventType: "tool_call_requested",
      status: "started",
      evidenceLevel: "observed",
      parentEventId: parent,
      payload: { toolCallId: "p1" },
    });
    const t2 = store.append({
      actor: "tool_runtime",
      stage: "tool",
      eventType: "tool_call_requested",
      status: "started",
      evidenceLevel: "observed",
      parentEventId: parent,
      payload: { toolCallId: "p2" },
    });
    assert.equal(t1.event.sequence + 1, t2.event.sequence);
  });
});

describe("Phase 3: AuditRunSession persisted semantics", () => {
  test("persisted=false when writeError is set even if path exists", () => {
    const root = tempRoot();
    try {
      const session = createAuditRunSession({
        projectRoot: root,
        workspaceId: "ws-persisted",
        chapterId: "ch1",
        chapterNumber: 1,
        persist: true,
      });
      session.start();
      const before = session.toStageResultsSummary();
      assert.equal(before.persisted, true);
      assert.ok(before.eventsPath);

      session.markWriteErrorForTest("simulated disk failure");
      const after = session.toStageResultsSummary();
      assert.equal(after.persisted, false, "writeError must force persisted=false");
      assert.equal(after.writeError, "simulated disk failure");
      assert.ok(after.eventsPath, "path may still be known");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recordModelTurn writes started/completed chain", () => {
    const session = createAuditRunSession({
      projectRoot: tempRoot(),
      workspaceId: "ws-model",
      chapterId: "ch1",
      chapterNumber: 1,
      persist: false,
    });
    session.start();
    const startId = session.recordModelTurn({
      phase: "started",
      kind: "raw",
      requestedRoute: "v2_rawstage2",
    });
    assert.ok(startId);
    session.recordModelTurn({
      phase: "completed",
      kind: "raw",
      requestedRoute: "v2_rawstage2",
      actualProvider: "stub",
      actualModel: "stub-model",
      durationMs: 12,
      startedEventId: startId,
    });
    const types = session.getEntries().map((e) => e.eventType);
    assert.ok(types.includes("model_turn_started"));
    assert.ok(types.includes("model_turn_completed"));
  });

  test("recordToolEvent covers auth + result", () => {
    const session = createAuditRunSession({
      projectRoot: tempRoot(),
      workspaceId: "ws-tool",
      chapterId: "ch1",
      chapterNumber: 1,
      persist: false,
    });
    session.start();
    session.recordToolEvent({
      eventType: "tool_call_requested",
      toolCallId: "tc-1",
      toolName: "search_narrative_evidence",
    });
    session.recordToolEvent({
      eventType: "tool_call_authorized",
      toolCallId: "tc-1",
      toolName: "search_narrative_evidence",
    });
    session.recordToolEvent({
      eventType: "tool_result_received",
      toolCallId: "tc-1",
      toolName: "search_narrative_evidence",
      durationMs: 5,
    });
    const types = session.getEntries().map((e) => e.eventType);
    assert.ok(types.includes("tool_call_requested"));
    assert.ok(types.includes("tool_call_authorized"));
    assert.ok(types.includes("tool_result_received"));
  });

  test("recordPersistenceEvent separates chapter save vs state commit", () => {
    const session = createAuditRunSession({
      projectRoot: tempRoot(),
      workspaceId: "ws-persist",
      chapterId: "ch1",
      chapterNumber: 1,
      persist: false,
    });
    session.start();
    session.recordPersistenceEvent({
      eventType: "chapter_save_attempted",
      candidateId: "cand-1",
      outputHash: "a".repeat(64),
    });
    session.recordPersistenceEvent({
      eventType: "chapter_saved",
      candidateId: "cand-1",
      outputHash: "a".repeat(64),
      chapterSaveOk: true,
    });
    session.recordPersistenceEvent({
      eventType: "state_commit_attempted",
      candidateId: "cand-1",
      outputHash: "a".repeat(64),
    });
    session.recordPersistenceEvent({
      eventType: "state_commit_failed",
      candidateId: "cand-1",
      outputHash: "a".repeat(64),
      chapterSaveOk: true,
      stateCommitOk: false,
      decisionReason: "simulated state failure",
    });
    session.recordPersistenceEvent({
      eventType: "final_submission",
      candidateId: "cand-1",
      outputHash: "a".repeat(64),
      chapterSaveOk: false,
      stateCommitOk: false,
      decisionReason: "state failed after chapter save; rolled back",
    });
    const types = session.getEntries().map((e) => e.eventType);
    assert.ok(types.includes("chapter_save_attempted"));
    assert.ok(types.includes("chapter_saved"));
    assert.ok(types.includes("state_commit_attempted"));
    assert.ok(types.includes("state_commit_failed"));
    assert.ok(types.includes("final_submission"));
    const finalEvt = session.getEntries().find((e) => e.eventType === "final_submission");
    assert.equal(finalEvt?.payload?.chapterSaveOk, false);
    assert.equal(finalEvt?.payload?.stateCommitOk, false);
  });
});

describe("Phase 2: completeness diagnostics", () => {
  test("detects missing terminal and tool auth gaps", () => {
    const traceId = createTraceId();
    const runId = createRunId();
    const start = createAuditEvent({
      traceId,
      runId,
      parentEventId: null,
      sequence: 1,
      actor: "orchestrator",
      stage: "run",
      eventType: "run_started",
      status: "started",
      evidenceLevel: "observed",
    });
    const req = createAuditEvent({
      traceId,
      runId,
      parentEventId: start.eventId,
      sequence: 2,
      actor: "tool_runtime",
      stage: "tool",
      eventType: "tool_call_requested",
      status: "started",
      evidenceLevel: "observed",
      payload: { toolCallId: "tc-x" },
    });
    const report = diagnoseTraceCompleteness([start, req]);
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((i) => i.code === "missing_terminal"));
    assert.ok(report.issues.some((i) => i.code === "tool_request_without_auth"));
  });

  test("green path completeness", () => {
    const store = new AuditEventStore({
      projectRoot: tempRoot(),
      workspaceId: "ws",
      persist: false,
    });
    store.startRun();
    const req = store.append({
      actor: "tool_runtime",
      stage: "tool",
      eventType: "tool_call_requested",
      status: "started",
      evidenceLevel: "observed",
      payload: { toolCallId: "tc-ok" },
    });
    store.append({
      actor: "system",
      stage: "tool",
      eventType: "tool_call_authorized",
      status: "completed",
      evidenceLevel: "observed",
      capability: "retrieval",
      parentEventId: req.event.eventId,
      payload: { toolCallId: "tc-ok" },
    });
    store.append({
      actor: "tool_runtime",
      stage: "tool",
      eventType: "tool_result_received",
      status: "completed",
      evidenceLevel: "observed",
      payload: { toolCallId: "tc-ok" },
    });
    store.finishRun("run_finished");
    const report = diagnoseTraceCompleteness(store.getEntries());
    assert.equal(report.ok, true, JSON.stringify(report.issues));
  });
});
