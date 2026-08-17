/**
 * RUN-LIFECYCLE P6 — compensation_run + evidence revoke
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createEmptyRunAggregate,
  reduceRunAggregate,
  createAuditEvent,
  createTraceId,
  createRunId,
  createEventId,
  startCompensationRun,
  assertParentRunNotRetreated,
  revokeEvidence,
  isEvidenceActive,
  listActiveEvidenceIds,
  createRunAggregateRepository,
  AuditEventStore,
  RUN_ERROR_CODES,
} from "../dist/v2/core/unified-entry.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "run-life-p6-"));
}

function evt(partial) {
  return createAuditEvent({
    traceId: partial.traceId,
    runId: partial.runId,
    parentEventId: partial.parentEventId ?? null,
    sequence: partial.sequence,
    actor: partial.actor ?? "orchestrator",
    stage: partial.stage ?? "run",
    eventType: partial.eventType,
    status: partial.status ?? "completed",
    evidenceLevel: "observed",
    eventId: partial.eventId ?? createEventId(),
    payload: partial.payload,
  });
}

describe("P6 compensation run", () => {
  test("starts new run without retreating parent committed", () => {
    const root = tempRoot();
    try {
      const parentRunId = createRunId();
      const parent = {
        ...createEmptyRunAggregate({
          workspaceId: "ws",
          chapterId: "ch1",
          runId: parentRunId,
          traceId: createTraceId(),
        }),
        workflowState: "committed",
        terminalStatus: "committed",
      };
      assert.equal(assertParentRunNotRetreated(parent).ok, true);

      const session = startCompensationRun({
        projectRoot: root,
        workspaceId: "ws",
        chapterId: "ch1",
        parentRunId,
        reason: "user rollback chapter",
        commandId: "cmd-rb-1",
        persist: true,
      });
      assert.notEqual(session.runId, parentRunId);
      const agg = session.repository.getAggregate();
      assert.equal(agg.workflowState, "compensation_run");
      assert.equal(agg.parentRunId, parentRunId);
      assert.equal(parent.workflowState, "committed");

      const types = session.store.getEntries().map((e) => e.eventType);
      assert.ok(types.includes("run_started"));
      assert.ok(types.includes("compensation_started"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("user_rollback on committed parent keeps committed", () => {
    const ids = {
      workspaceId: "ws",
      chapterId: "ch1",
      runId: createRunId(),
      traceId: createTraceId(),
    };
    let agg = {
      ...createEmptyRunAggregate(ids),
      workflowState: "committed",
      terminalStatus: "committed",
      lastSequence: 5,
    };
    const e = evt({
      ...ids,
      sequence: 6,
      eventType: "user_rollback",
      actor: "user",
      parentEventId: createEventId(),
    });
    // parentEventId 不在 seen 集合；reducer 不校验 parent 存在
    const r = reduceRunAggregate(agg, e, { strictSequence: true });
    assert.equal(r.ok, true);
    assert.equal(r.aggregate.workflowState, "committed");
    assert.equal(r.aggregate.lastErrorCode, RUN_ERROR_CODES.ILLEGAL_TRANSITION);
  });
});

describe("P6 evidence revoke", () => {
  test("revoke removes from active set; other evidence kept", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-ev";
      const runId = createRunId();
      const traceId = createTraceId();
      const store = new AuditEventStore({
        projectRoot: root,
        workspaceId,
        runId,
        traceId,
        persist: false,
      });
      const repo = createRunAggregateRepository({
        projectRoot: root,
        workspaceId,
        chapterId: "ch1",
        runId,
        traceId,
        persist: false,
      });
      repo.appendEvent(store, {
        actor: "orchestrator",
        stage: "run",
        eventType: "run_started",
        status: "started",
        evidenceLevel: "observed",
        parentEventId: null,
      });
      // 注入 active 集
      const base = repo.getAggregate();
      repo.applyAppendedEvent(
        // no-op path: manually patch via recover with synthetic not available;
        // use reduce path by setting through private — instead append custom then patch via revoke only
        {
          ...store.getEntries()[0],
        },
      );
      // 直接在内存对象上模拟已有证据（生产由学习摄入写入 activeEvidenceIds）
      const seeded = {
        ...repo.getAggregate(),
        activeEvidenceIds: ["ev-a", "ev-b", "ev-c"],
        lastSequence: 1,
      };
      // re-bind by recoverFromEvents after mutating isn't exported set;
      // use revoke which only needs active set on aggregate — patch via repository internals:
      // apply a no-op by recovering empty then force through reduce evidence after inject
      const store2 = new AuditEventStore({
        projectRoot: root,
        workspaceId: workspaceId + "2",
        runId: createRunId(),
        traceId: createTraceId(),
        persist: false,
      });
      const repo2 = createRunAggregateRepository({
        projectRoot: root,
        workspaceId: workspaceId + "2",
        chapterId: "ch1",
        runId: store2.runId,
        traceId: store2.traceId,
        persist: false,
      });
      repo2.appendEvent(store2, {
        actor: "orchestrator",
        stage: "run",
        eventType: "run_started",
        status: "started",
        evidenceLevel: "observed",
        parentEventId: null,
      });
      // Monkey-seed activeEvidenceIds on aggregate by applying a fake fold via reduce export
      const withEvidence = {
        ...repo2.getAggregate(),
        activeEvidenceIds: ["ev-a", "ev-b", "ev-c"],
      };
      // Replace internal state: recoverFromEvents won't set activeEvidenceIds;
      // use revokeEvidence only after manually applying reduce on a local aggregate
      // Simpler path: unit-test listActiveEvidenceIds / isEvidenceActive + reduce evidence_revoked
      const ids = {
        workspaceId: "w",
        chapterId: "c",
        runId: createRunId(),
        traceId: createTraceId(),
      };
      const e1 = evt({
        ...ids,
        sequence: 1,
        eventType: "run_started",
        status: "started",
        parentEventId: null,
      });
      let r = reduceRunAggregate(createEmptyRunAggregate(ids), e1);
      const seededAgg = {
        ...r.aggregate,
        activeEvidenceIds: ["ev-a", "ev-b", "ev-c"],
      };
      const e2 = evt({
        ...ids,
        sequence: 2,
        eventType: "evidence_revoked",
        parentEventId: e1.eventId,
        payload: { evidenceId: "ev-b" },
      });
      r = reduceRunAggregate(seededAgg, e2);
      assert.equal(r.ok, true);
      assert.deepEqual(listActiveEvidenceIds(r.aggregate), ["ev-a", "ev-c"]);
      assert.equal(isEvidenceActive(r.aggregate, "ev-b"), false);
      assert.equal(isEvidenceActive(r.aggregate, "ev-a"), true);
      assert.ok(r.aggregate.revokedEvidenceIds.includes("ev-b"));

      // store path revoke
      const seeded2 = {
        ...repo2.getAggregate(),
        activeEvidenceIds: ["ev-x", "ev-y"],
      };
      // inject by recover not possible; call revoke after forcing via appendEvent on a repo
      // whose aggregate we can't seed — verify revokeEvidence API with empty active still records revoke
      const rev = revokeEvidence(store2, repo2, {
        evidenceId: "ev-x",
        reason: "rollback chapter",
        chapterId: "ch1",
        commandId: "cmd-rev-1",
      });
      assert.equal(rev.ok, true);
      assert.ok(rev.aggregate.revokedEvidenceIds.includes("ev-x"));
      void withEvidence;
      void seeded;
      void base;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
