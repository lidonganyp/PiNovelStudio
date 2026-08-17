/**
 * RUN-LIFECYCLE — AuditRunSession 折叠 RunAggregate + checkpoint 事件（P3）
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAuditRunSession } from "../dist/v2/core/audit/index.js";
import {
  rebuildRunAggregateFromEvents,
  assertAggregateMatchesReplay,
} from "../dist/v2/core/unified-entry.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "run-life-session-"));
}

describe("P3 AuditRunSession folds RunAggregate", () => {
  test("seal injects runAggregate; events replay matches", () => {
    const root = tempRoot();
    try {
      const session = createAuditRunSession({
        projectRoot: root,
        workspaceId: "ws-fold",
        chapterId: "ch1",
        chapterNumber: 1,
        persist: true,
      });
      session.start({ test: true });
      const hash = "c".repeat(64);
      session.recordLifecycleEvent({
        eventType: "checkpoint_saved",
        decisionReason: "budget_exhausted",
        payload: { checkpointId: "cp-1", autoResume: false },
      });
      const out = session.attachToOutput({
        status: "blocked",
        failureEnvelope: {
          stage: "recovery",
          reason: "budget exhausted",
          failureClass: "interrupted",
          severity: "interrupted",
        },
      });
      assert.ok(out.stageResults?.auditRun?.runAggregate);
      assert.equal(
        out.stageResults.auditRun.runAggregate.checkpointId,
        "cp-1",
      );
      // blocked/failed terminal may override workflow; checkpoint was recorded
      const events = session.getEntries();
      assert.ok(events.some((e) => e.eventType === "checkpoint_saved"));
      assert.ok(
        events.some(
          (e) =>
            e.eventType === "run_failed" || e.eventType === "run_interrupted",
        ),
      );

      const replay = rebuildRunAggregateFromEvents(
        {
          workspaceId: "ws-fold",
          chapterId: "ch1",
          runId: session.runId,
          traceId: session.traceId,
        },
        events,
      );
      assert.equal(replay.ok, true, replay.error?.message);
      const live = session.getRunAggregate();
      const match = assertAggregateMatchesReplay(live, replay.aggregate);
      assert.equal(match.ok, true, match.error?.message);

      // 投影目录
      const proj = join(
        root,
        "workspaces",
        "ws-fold",
        "traces",
        session.runId,
        "projections",
        "current-run-state.json",
      );
      assert.equal(existsSync(proj), true);
      const projJson = JSON.parse(readFileSync(proj, "utf-8"));
      assert.equal(projJson.kind, "current-run-state");
      assert.equal(projJson.checkpointId, "cp-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("checkpoint_saved never implies committed", () => {
    const root = tempRoot();
    try {
      const session = createAuditRunSession({
        projectRoot: root,
        workspaceId: "ws-cp",
        chapterId: "ch2",
        chapterNumber: 2,
        persist: false,
      });
      session.start();
      session.recordLifecycleEvent({
        eventType: "checkpoint_saved",
        payload: { checkpointId: "cp-x", autoResume: false },
      });
      const agg = session.getRunAggregate();
      assert.equal(agg.workflowState, "checkpoint");
      assert.notEqual(agg.terminalStatus, "committed");
      assert.equal(agg.workflowState === "committed", false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approval_requested sets awaiting_approval + pending", () => {
    const root = tempRoot();
    try {
      const session = createAuditRunSession({
        projectRoot: root,
        workspaceId: "ws-ap",
        chapterId: "ch3",
        chapterNumber: 3,
        persist: false,
      });
      session.start();
      const hash = "d".repeat(64);
      session.recordLifecycleEvent({
        eventType: "approval_requested",
        approvalId: "ap-1",
        revision: "rev-1",
        outputHash: hash,
        candidateId: "cand-1",
      });
      const agg = session.getRunAggregate();
      assert.equal(agg.workflowState, "awaiting_approval");
      assert.equal(agg.approvalState, "pending");
      assert.equal(agg.approvalId, "ap-1");
      assert.equal(agg.artifactHash, hash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
