/**
 * RUN-AGGREGATE-REPOSITORY / PROJECTIONS — P2
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AuditEventStore,
  createRunAggregateRepository,
  rebuildRunAggregateFromEvents,
  loadMaterializedRunAggregate,
  assertAggregateMatchesReplay,
  writeRunProjections,
  rebuildProjectionsFromAggregate,
  projectTransitionHistory,
  projectApprovalPending,
  RUN_ERROR_CODES,
  createTraceId,
  createRunId,
} from "../dist/v2/core/unified-entry.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "run-agg-repo-"));
}

describe("P2 RunAggregate repository", () => {
  test("append order: event then materialize; delete materialize rebuilds", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-p2";
      const chapterId = "ch1";
      const runId = createRunId();
      const traceId = createTraceId();

      const store = new AuditEventStore({
        projectRoot: root,
        workspaceId,
        runId,
        traceId,
        persist: true,
      });
      const repo = createRunAggregateRepository({
        projectRoot: root,
        workspaceId,
        chapterId,
        runId,
        traceId,
        persist: true,
      });

      const { append: a1, fold: f1 } = repo.appendEvent(store, {
        actor: "orchestrator",
        stage: "run",
        eventType: "run_started",
        status: "started",
        evidenceLevel: "observed",
        parentEventId: null,
      });
      assert.equal(f1.ok, true, f1.error?.message);
      assert.equal(f1.aggregate.lastSequence, 1);
      assert.ok(a1.persisted);

      const hash = "a".repeat(64);
      const rev = "rev-1";
      const { fold: f2 } = repo.appendEvent(store, {
        actor: "orchestrator",
        stage: "candidate",
        eventType: "candidate_created",
        status: "completed",
        evidenceLevel: "observed",
        candidateId: "c1",
        revision: rev,
        outputHash: hash,
      });
      assert.equal(f2.ok, true, f2.error?.message);

      const matPath = join(
        root,
        "workspaces",
        workspaceId,
        "traces",
        runId,
        "run-aggregate.json",
      );
      assert.equal(existsSync(matPath), true);
      const mat = loadMaterializedRunAggregate(root, workspaceId, runId);
      assert.ok(mat);
      assert.equal(mat.artifactHash, hash);

      // 删除物化 → 从事件重建
      unlinkSync(matPath);
      assert.equal(loadMaterializedRunAggregate(root, workspaceId, runId), null);

      const rebuilt = rebuildRunAggregateFromEvents(
        { workspaceId, chapterId, runId, traceId },
        store.getEntries(),
      );
      assert.equal(rebuilt.ok, true);
      assert.equal(rebuilt.aggregate.artifactHash, hash);
      assert.equal(rebuilt.aggregate.lastSequence, 2);

      const match = assertAggregateMatchesReplay(f2.aggregate, rebuilt.aggregate);
      assert.equal(match.ok, true, match.error?.message);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recoverFromEvents restores aggregate after restart", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-p2r";
      const chapterId = "ch2";
      const runId = createRunId();
      const traceId = createTraceId();

      const store = new AuditEventStore({
        projectRoot: root,
        workspaceId,
        runId,
        traceId,
        persist: true,
      });
      const repo1 = createRunAggregateRepository({
        projectRoot: root,
        workspaceId,
        chapterId,
        runId,
        traceId,
        persist: true,
      });

      repo1.appendEvent(store, {
        actor: "orchestrator",
        stage: "run",
        eventType: "run_started",
        status: "started",
        evidenceLevel: "observed",
        parentEventId: null,
      });
      repo1.appendEvent(store, {
        actor: "recovery",
        stage: "recovery",
        eventType: "checkpoint_saved",
        status: "completed",
        evidenceLevel: "observed",
        payload: { checkpointId: "cp-restart" },
      });

      // 模拟重启：新 store bootstrap + 新 repo recover
      const store2 = new AuditEventStore({
        projectRoot: root,
        workspaceId,
        runId,
        traceId,
        persist: true,
      });
      const repo2 = createRunAggregateRepository({
        projectRoot: root,
        workspaceId,
        chapterId,
        runId,
        traceId,
        persist: true,
      });
      const recovered = repo2.recoverFromEvents(store2.getEntries());
      assert.equal(recovered.ok, true, recovered.error?.message);
      assert.equal(recovered.aggregate.workflowState, "checkpoint");
      assert.equal(recovered.aggregate.checkpointId, "cp-restart");
      assert.equal(recovered.aggregate.lastSequence, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("duplicate eventId on fold is rejected", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-dup";
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
      const { append } = repo.appendEvent(store, {
        actor: "orchestrator",
        stage: "run",
        eventType: "run_started",
        status: "started",
        evidenceLevel: "observed",
        parentEventId: null,
      });
      // 直接 apply 同一事件二次
      const fold2 = repo.applyAppendedEvent(append.event);
      assert.equal(fold2.ok, false);
      assert.equal(fold2.error?.code, RUN_ERROR_CODES.DUPLICATE_EVENT_ID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P2 projections", () => {
  test("write projections and rebuild after delete", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-proj";
      const chapterId = "ch9";
      const runId = createRunId();
      const traceId = createTraceId();
      const store = new AuditEventStore({
        projectRoot: root,
        workspaceId,
        runId,
        traceId,
        persist: true,
      });
      const repo = createRunAggregateRepository({
        projectRoot: root,
        workspaceId,
        chapterId,
        runId,
        traceId,
        persist: true,
      });

      repo.appendEvent(store, {
        actor: "orchestrator",
        stage: "run",
        eventType: "run_started",
        status: "started",
        evidenceLevel: "observed",
        parentEventId: null,
      });
      const hash = "b".repeat(64);
      repo.appendEvent(store, {
        actor: "orchestrator",
        stage: "candidate",
        eventType: "candidate_created",
        status: "completed",
        evidenceLevel: "observed",
        candidateId: "c9",
        revision: "r9",
        outputHash: hash,
      });
      repo.appendEvent(store, {
        actor: "governance",
        stage: "proxy_approval",
        eventType: "approval_requested",
        status: "started",
        evidenceLevel: "observed",
        approvalId: "ap-9",
        revision: "r9",
        outputHash: hash,
      });

      const agg = repo.getAggregate();
      const paths = writeRunProjections({
        projectRoot: root,
        aggregate: agg,
        events: store.getEntries(),
      });

      assert.equal(existsSync(paths.currentRunStatePath), true);
      assert.equal(existsSync(paths.approvalPendingPath), true);
      assert.equal(existsSync(paths.transitionHistoryPath), true);

      const pending = JSON.parse(
        readFileSync(paths.approvalPendingPath, "utf-8"),
      );
      assert.equal(pending.pending, true);
      assert.equal(pending.approvalId, "ap-9");

      const history = projectTransitionHistory(store.getEntries());
      assert.ok(history.some((h) => h.to === "awaiting_approval"));

      // 删除投影 → 重建
      unlinkSync(paths.approvalPendingPath);
      unlinkSync(paths.currentRunStatePath);
      const rebuilt = rebuildProjectionsFromAggregate(
        root,
        agg,
        store.getEntries(),
      );
      assert.equal(existsSync(rebuilt.approvalPendingPath), true);
      const pending2 = projectApprovalPending(agg);
      assert.equal(pending2.pending, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
