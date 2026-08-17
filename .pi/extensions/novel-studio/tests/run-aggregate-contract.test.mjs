/**
 * RUN-AGGREGATE — P0/P1 领域契约与 reducer 单元测试
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createEmptyRunAggregate,
  reduceRunAggregate,
  replayRunAggregate,
  assertWorkflowTransition,
  canWorkflowTransition,
  assertArtifactBinding,
  RUN_AGGREGATE_SCHEMA_VERSION,
  RUN_ERROR_CODES,
  toRecoveryLifecycleState,
  fromRecoveryLifecycleState,
  createAuditEvent,
  createTraceId,
  createRunId,
  createEventId,
} from "../dist/v2/core/unified-entry.js";

function baseIds() {
  return {
    traceId: createTraceId(),
    runId: createRunId(),
    workspaceId: "ws-run-agg",
    chapterId: "ch1",
  };
}

function evt(partial) {
  const { traceId, runId } = partial;
  return createAuditEvent({
    traceId,
    runId,
    parentEventId: partial.parentEventId ?? null,
    sequence: partial.sequence,
    actor: partial.actor ?? "orchestrator",
    stage: partial.stage ?? "run",
    eventType: partial.eventType,
    status: partial.status ?? "completed",
    evidenceLevel: partial.evidenceLevel ?? "observed",
    eventId: partial.eventId ?? createEventId(),
    timestamp: partial.timestamp ?? Date.now(),
    candidateId: partial.candidateId,
    revision: partial.revision,
    approvalId: partial.approvalId,
    outputHash: partial.outputHash,
    failureClass: partial.failureClass,
    payload: partial.payload,
  });
}

describe("P1 RunAggregate contract", () => {
  test("schema version frozen", () => {
    assert.equal(RUN_AGGREGATE_SCHEMA_VERSION, "1.0.0");
  });

  test("empty aggregate starts running", () => {
    const ids = baseIds();
    const agg = createEmptyRunAggregate(ids);
    assert.equal(agg.workflowState, "running");
    assert.equal(agg.approvalState, "none");
    assert.equal(agg.terminalStatus, "none");
    assert.equal(agg.lastSequence, 0);
  });

  test("illegal: checkpoint -> committed", () => {
    const r = assertWorkflowTransition("checkpoint", "committed");
    assert.equal(r.ok, false);
    assert.equal(r.code, RUN_ERROR_CODES.ILLEGAL_TRANSITION);
  });

  test("illegal: committed cannot retreat", () => {
    const r = assertWorkflowTransition("committed", "running");
    assert.equal(r.ok, false);
  });

  test("legal: commit_pending -> committed", () => {
    assert.equal(canWorkflowTransition("commit_pending", "committed"), true);
    assert.equal(assertWorkflowTransition("commit_pending", "committed").ok, true);
  });

  test("legal: running -> awaiting_approval", () => {
    assert.equal(canWorkflowTransition("running", "awaiting_approval"), true);
  });

  test("legacy adapter maps awaiting_approval -> commit_pending", () => {
    assert.equal(toRecoveryLifecycleState("awaiting_approval"), "commit_pending");
    assert.equal(fromRecoveryLifecycleState("running"), "running");
  });
});

describe("P1 RunAggregate reducer", () => {
  test("replay happy path to committed", () => {
    const ids = baseIds();
    const hash = "a".repeat(64);
    const rev = "rev-1";
    const e1 = evt({
      ...ids,
      sequence: 1,
      eventType: "run_started",
      status: "started",
      parentEventId: null,
    });
    const e2 = evt({
      ...ids,
      sequence: 2,
      eventType: "candidate_created",
      parentEventId: e1.eventId,
      candidateId: "cand-1",
      revision: rev,
      outputHash: hash,
    });
    const e3 = evt({
      ...ids,
      sequence: 3,
      eventType: "approval_requested",
      parentEventId: e2.eventId,
      approvalId: "appr-1",
      revision: rev,
      outputHash: hash,
      candidateId: "cand-1",
    });
    const e4 = evt({
      ...ids,
      sequence: 4,
      eventType: "user_accepted",
      actor: "user",
      parentEventId: e3.eventId,
      approvalId: "appr-1",
      payload: { commandId: "cmd-accept-1" },
    });
    const e5 = evt({
      ...ids,
      sequence: 5,
      eventType: "commit_started",
      parentEventId: e4.eventId,
      revision: rev,
      outputHash: hash,
      approvalId: "appr-1",
      payload: {
        commitIntentId: "ci-1",
        artifactRevision: rev,
        artifactHash: hash,
        commandId: "cmd-commit-1",
      },
    });
    const e6 = evt({
      ...ids,
      sequence: 6,
      eventType: "chapter_saved",
      parentEventId: e5.eventId,
      revision: rev,
      outputHash: hash,
      payload: { chapterSaveOk: true },
    });
    const e7 = evt({
      ...ids,
      sequence: 7,
      eventType: "state_committed",
      parentEventId: e6.eventId,
      revision: "ns-1",
      payload: { narrativeStateRevision: "ns-1" },
    });
    const e8 = evt({
      ...ids,
      sequence: 8,
      eventType: "final_submission",
      parentEventId: e7.eventId,
      revision: rev,
      outputHash: hash,
      payload: { chapterSaveOk: true, stateCommitOk: true },
    });

    const result = replayRunAggregate(ids, [e1, e2, e3, e4, e5, e6, e7, e8]);
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.aggregate.workflowState, "committed");
    assert.equal(result.aggregate.terminalStatus, "committed");
    // final_submission 成功后 pending/accepted/modified → cleared（审批流结束）
    assert.equal(result.aggregate.approvalState, "cleared");
    assert.equal(result.aggregate.artifactHash, hash);
    assert.equal(result.aggregate.artifactRevision, rev);
    assert.equal(result.aggregate.commitIntent?.status, "completed");
    assert.equal(result.aggregate.narrativeStateRevision, "ns-1");
    assert.equal(result.aggregate.lastSequence, 8);
  });

  test("sequence gap rejected", () => {
    const ids = baseIds();
    const e1 = evt({
      ...ids,
      sequence: 1,
      eventType: "run_started",
      status: "started",
      parentEventId: null,
    });
    const e3 = evt({
      ...ids,
      sequence: 3,
      eventType: "run_finished",
      parentEventId: e1.eventId,
    });
    const r = replayRunAggregate(ids, [e1, e3]);
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, RUN_ERROR_CODES.SEQUENCE_GAP);
  });

  test("duplicate eventId rejected", () => {
    const ids = baseIds();
    const id = createEventId();
    const e1 = evt({
      ...ids,
      sequence: 1,
      eventType: "run_started",
      status: "started",
      parentEventId: null,
      eventId: id,
    });
    const e2 = evt({
      ...ids,
      sequence: 2,
      eventType: "run_finished",
      parentEventId: id,
      eventId: id,
    });
    const seen = new Set();
    const a0 = createEmptyRunAggregate(ids);
    const r1 = reduceRunAggregate(a0, e1, { seenEventIds: seen });
    assert.equal(r1.ok, true);
    const r2 = reduceRunAggregate(r1.aggregate, e2, { seenEventIds: seen });
    assert.equal(r2.ok, false);
    assert.equal(r2.error?.code, RUN_ERROR_CODES.DUPLICATE_EVENT_ID);
  });

  test("duplicate commandId is idempotent", () => {
    const ids = baseIds();
    const e1 = evt({
      ...ids,
      sequence: 1,
      eventType: "run_started",
      status: "started",
      parentEventId: null,
    });
    const e2 = evt({
      ...ids,
      sequence: 2,
      eventType: "user_accepted",
      actor: "user",
      parentEventId: e1.eventId,
      payload: { commandId: "cmd-1" },
    });
    const e3 = evt({
      ...ids,
      sequence: 3,
      eventType: "user_accepted",
      actor: "user",
      parentEventId: e2.eventId,
      payload: { commandId: "cmd-1" },
    });
    const r1 = replayRunAggregate(ids, [e1, e2]);
    assert.equal(r1.ok, true);
    const r2 = reduceRunAggregate(r1.aggregate, e3);
    assert.equal(r2.ok, true);
    assert.equal(r2.idempotentReplay, true);
    assert.equal(r2.error?.code, RUN_ERROR_CODES.DUPLICATE_COMMAND_ID);
    assert.equal(r2.aggregate.lastSequence, 2);
  });

  test("artifact hash mismatch blocks commit_started", () => {
    const ids = baseIds();
    const hash1 = "b".repeat(64);
    const hash2 = "c".repeat(64);
    const rev = "rev-x";
    const e1 = evt({
      ...ids,
      sequence: 1,
      eventType: "run_started",
      status: "started",
      parentEventId: null,
    });
    const e2 = evt({
      ...ids,
      sequence: 2,
      eventType: "candidate_created",
      parentEventId: e1.eventId,
      revision: rev,
      outputHash: hash1,
      candidateId: "c1",
    });
    const events = [e1, e2];
    const base = replayRunAggregate(ids, events);
    assert.equal(base.ok, true);
    const bad = evt({
      ...ids,
      sequence: 3,
      eventType: "commit_started",
      parentEventId: events[1].eventId,
      revision: rev,
      outputHash: hash2,
      payload: {
        commitIntentId: "ci-bad",
        artifactRevision: rev,
        artifactHash: hash2,
      },
    });
    const r = reduceRunAggregate(base.aggregate, bad);
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, RUN_ERROR_CODES.ARTIFACT_HASH_MISMATCH);
  });

  test("stale revision blocks commit_started", () => {
    const ids = baseIds();
    const hash = "d".repeat(64);
    const e1 = evt({
      ...ids,
      sequence: 1,
      eventType: "run_started",
      status: "started",
      parentEventId: null,
    });
    const e2 = evt({
      ...ids,
      sequence: 2,
      eventType: "candidate_created",
      parentEventId: e1.eventId,
      revision: "rev-old",
      outputHash: hash,
      candidateId: "c1",
    });
    const base = replayRunAggregate(ids, [e1, e2]);
    const bad = evt({
      ...ids,
      sequence: 3,
      eventType: "commit_started",
      parentEventId: e2.eventId,
      revision: "rev-new",
      outputHash: hash,
      payload: {
        commitIntentId: "ci-stale",
        artifactRevision: "rev-new",
        artifactHash: hash,
      },
    });
    const r = reduceRunAggregate(base.aggregate, bad);
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, RUN_ERROR_CODES.STALE_REVISION);
  });

  test("用户编辑旧稿：user_modified 复用旧 revision + 不同 hash → STALE_REVISION（旧 approval 不可复用）", () => {
    const ids = baseIds();
    const oldHash = "f".repeat(64);
    const newHash = "0".repeat(64);
    const rev = "rev-old";
    const e1 = evt({
      ...ids,
      sequence: 1,
      eventType: "run_started",
      status: "started",
      parentEventId: null,
    });
    const e2 = evt({
      ...ids,
      sequence: 2,
      eventType: "candidate_created",
      parentEventId: e1.eventId,
      revision: rev,
      outputHash: oldHash,
      candidateId: "c1",
    });
    const e3 = evt({
      ...ids,
      sequence: 3,
      eventType: "approval_requested",
      parentEventId: e2.eventId,
      approvalId: "ap-1",
      revision: rev,
      outputHash: oldHash,
    });
    const base = replayRunAggregate(ids, [e1, e2, e3]);
    assert.equal(base.aggregate.approvalState, "pending");
    assert.equal(base.aggregate.artifactRevision, rev);

    // 用户编辑旧稿：复用同一 revision 但正文 hash 变了 → 旧 approval 不得复用
    const edit = evt({
      ...ids,
      sequence: 4,
      eventType: "user_modified",
      parentEventId: e3.eventId,
      revision: rev,
      outputHash: newHash,
    });
    const r = reduceRunAggregate(base.aggregate, edit);
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, RUN_ERROR_CODES.STALE_REVISION);
    // 状态未被污染：仍 pending + 旧 hash
    assert.equal(r.aggregate.approvalState, "pending");
    assert.equal(r.aggregate.artifactHash, oldHash);
  });

  test("用户编辑旧稿：user_modified 升版 revision → 接受并标记 modified", () => {
    const ids = baseIds();
    const oldHash = "a".repeat(64);
    const newHash = "b".repeat(64);
    const e1 = evt({
      ...ids,
      sequence: 1,
      eventType: "run_started",
      status: "started",
      parentEventId: null,
    });
    const e2 = evt({
      ...ids,
      sequence: 2,
      eventType: "candidate_created",
      parentEventId: e1.eventId,
      revision: "rev-1",
      outputHash: oldHash,
      candidateId: "c1",
    });
    const base = replayRunAggregate(ids, [e1, e2]);
    const edit = evt({
      ...ids,
      sequence: 3,
      eventType: "user_modified",
      parentEventId: e2.eventId,
      revision: "rev-2",
      outputHash: newHash,
    });
    const r = reduceRunAggregate(base.aggregate, edit);
    assert.equal(r.ok, true);
    assert.equal(r.aggregate.approvalState, "modified");
    assert.equal(r.aggregate.artifactRevision, "rev-2");
    assert.equal(r.aggregate.artifactHash, newHash);
  });

  test("pending approval blocks commit_started", () => {
    const ids = baseIds();
    const hash = "e".repeat(64);
    const rev = "rev-p";
    const e1 = evt({
      ...ids,
      sequence: 1,
      eventType: "run_started",
      status: "started",
      parentEventId: null,
    });
    const e2 = evt({
      ...ids,
      sequence: 2,
      eventType: "candidate_created",
      parentEventId: e1.eventId,
      revision: rev,
      outputHash: hash,
      candidateId: "c1",
    });
    const e3 = evt({
      ...ids,
      sequence: 3,
      eventType: "approval_requested",
      parentEventId: e2.eventId,
      approvalId: "ap-1",
      revision: rev,
      outputHash: hash,
    });
    const base = replayRunAggregate(ids, [e1, e2, e3]);
    assert.equal(base.aggregate.approvalState, "pending");
    const bad = evt({
      ...ids,
      sequence: 4,
      eventType: "commit_started",
      parentEventId: e3.eventId,
      revision: rev,
      outputHash: hash,
      payload: {
        commitIntentId: "ci-pending",
        artifactRevision: rev,
        artifactHash: hash,
      },
    });
    const r = reduceRunAggregate(base.aggregate, bad);
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, RUN_ERROR_CODES.APPROVAL_REQUIRED);
  });

  test("checkpoint resume only from checkpoint", () => {
    const ids = baseIds();
    const e1 = evt({
      ...ids,
      sequence: 1,
      eventType: "run_started",
      status: "started",
      parentEventId: null,
    });
    const bad = evt({
      ...ids,
      sequence: 2,
      eventType: "checkpoint_resumed",
      parentEventId: e1.eventId,
    });
    const r = replayRunAggregate(ids, [e1, bad]);
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, RUN_ERROR_CODES.ILLEGAL_TRANSITION);
  });

  test("checkpoint_saved then resume", () => {
    const ids = baseIds();
    const e1 = evt({
      ...ids,
      sequence: 1,
      eventType: "run_started",
      status: "started",
      parentEventId: null,
    });
    const e2 = evt({
      ...ids,
      sequence: 2,
      eventType: "checkpoint_saved",
      parentEventId: e1.eventId,
      payload: { checkpointId: "cp-1" },
    });
    const e3 = evt({
      ...ids,
      sequence: 3,
      eventType: "checkpoint_resumed",
      parentEventId: e2.eventId,
    });
    const r = replayRunAggregate(ids, [e1, e2, e3]);
    assert.equal(r.ok, true, r.error?.message);
    assert.equal(r.aggregate.workflowState, "running");
    assert.equal(r.aggregate.checkpointId, "cp-1");
  });

  test("user_rollback does not retreat committed workflow", () => {
    const ids = baseIds();
    const hash = "f".repeat(64);
    const rev = "rev-c";
    const events = [];
    let parent = null;
    const push = (partial) => {
      const e = evt({
        ...ids,
        parentEventId: parent,
        ...partial,
      });
      events.push(e);
      parent = e.eventId;
      return e;
    };
    push({ sequence: 1, eventType: "run_started", status: "started", parentEventId: null });
    push({
      sequence: 2,
      eventType: "candidate_created",
      revision: rev,
      outputHash: hash,
      candidateId: "c1",
    });
    push({
      sequence: 3,
      eventType: "user_accepted",
      actor: "user",
      payload: { commandId: "a1" },
    });
    push({
      sequence: 4,
      eventType: "commit_started",
      revision: rev,
      outputHash: hash,
      payload: {
        commitIntentId: "ci-c",
        artifactRevision: rev,
        artifactHash: hash,
      },
    });
    push({
      sequence: 5,
      eventType: "final_submission",
      revision: rev,
      outputHash: hash,
      payload: { chapterSaveOk: true, stateCommitOk: true },
    });
    const base = replayRunAggregate(ids, events);
    assert.equal(base.aggregate.workflowState, "committed");
    const rb = evt({
      ...ids,
      sequence: 6,
      eventType: "user_rollback",
      actor: "user",
      parentEventId: events[events.length - 1].eventId,
    });
    const r = reduceRunAggregate(base.aggregate, rb);
    assert.equal(r.ok, true);
    assert.equal(r.aggregate.workflowState, "committed");
    assert.equal(r.aggregate.lastErrorCode, RUN_ERROR_CODES.ILLEGAL_TRANSITION);
  });

  test("evidence_revoked removes from active set", () => {
    const ids = baseIds();
    const e1 = evt({
      ...ids,
      sequence: 1,
      eventType: "run_started",
      status: "started",
      parentEventId: null,
    });
    let agg = createEmptyRunAggregate(ids);
    agg = {
      ...agg,
      activeEvidenceIds: ["ev-1", "ev-2"],
      lastSequence: 0,
    };
    // manually set sequence by reducing run_started first
    const r0 = reduceRunAggregate(createEmptyRunAggregate(ids), e1);
    assert.equal(r0.ok, true);
    const withEv = {
      ...r0.aggregate,
      activeEvidenceIds: ["ev-1", "ev-2"],
    };
    const e2 = evt({
      ...ids,
      sequence: 2,
      eventType: "evidence_revoked",
      parentEventId: e1.eventId,
      payload: { evidenceId: "ev-1" },
    });
    const r = reduceRunAggregate(withEv, e2);
    assert.equal(r.ok, true);
    assert.deepEqual(r.aggregate.activeEvidenceIds, ["ev-2"]);
    assert.deepEqual(r.aggregate.revokedEvidenceIds, ["ev-1"]);
  });

  test("assertArtifactBinding detects mismatch", () => {
    const ids = baseIds();
    const agg = {
      ...createEmptyRunAggregate(ids),
      artifactRevision: "r1",
      artifactHash: "g".repeat(64),
    };
    const bad = assertArtifactBinding(agg, {
      artifactRevision: "r1",
      artifactHash: "h".repeat(64),
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, RUN_ERROR_CODES.ARTIFACT_HASH_MISMATCH);
  });

  test("new audit event types validate", () => {
    const ids = baseIds();
    for (const eventType of [
      "stage_started",
      "retry_reserved",
      "approval_requested",
      "commit_started",
      "commit_failed",
      "evidence_revoked",
      "state_recomputed",
      "compensation_started",
    ]) {
      const e = evt({
        ...ids,
        sequence: 1,
        eventType,
        status: "started",
        parentEventId: null,
      });
      assert.equal(e.eventType, eventType);
    }
  });
});
