/**
 * RUN-LIFECYCLE P8 — 故障注入矩阵补充（§6 场景 6 / 12）
 *
 * 补充 crash-matrix 未覆盖的两类验收场景：
 *   6.  用户重复 accept → commandId 幂等（同 commandId 二次处理不产生副作用）
 *   12. 删除投影（current-run-state / approval-pending）→ 可由事件流重建
 *
 * 两者都只依赖 run-aggregate reducer + 投影物化，不触碰编排层。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AuditEventStore,
  createRunAggregateRepository,
  createRunId,
  createTraceId,
  rebuildProjectionsFromAggregate,
  RUN_ERROR_CODES,
  writeRunProjections,
} from "../dist/v2/core/unified-entry.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "run-fi-matrix-"));
}

const HASH = "a".repeat(64);
const REV = "rev-1";

function makeStore(root, workspaceId, runId, traceId) {
  return new AuditEventStore({
    projectRoot: root,
    workspaceId,
    runId,
    traceId,
    persist: true,
  });
}

function makeRepo(root, workspaceId, chapterId, runId, traceId) {
  return createRunAggregateRepository({
    projectRoot: root,
    workspaceId,
    chapterId,
    runId,
    traceId,
    persist: true,
  });
}

/** 前导事件：run_started + candidate_created + approval_requested */
function seedApprovalFlow(repo, store) {
  repo.appendEvent(store, {
    actor: "orchestrator",
    stage: "run",
    eventType: "run_started",
    status: "started",
    evidenceLevel: "observed",
    parentEventId: null,
  });
  repo.appendEvent(store, {
    actor: "orchestrator",
    stage: "candidate",
    eventType: "candidate_created",
    status: "completed",
    evidenceLevel: "observed",
    candidateId: "c1",
    revision: REV,
    outputHash: HASH,
  });
  repo.appendEvent(store, {
    actor: "orchestrator",
    stage: "proxy_approval",
    eventType: "approval_requested",
    status: "started",
    evidenceLevel: "observed",
    approvalId: "ap-1",
    revision: REV,
    outputHash: HASH,
  });
}

describe("P8 fault injection: §6 场景 6 — 用户重复 accept commandId 幂等", () => {
  test("同 commandId 二次 user_accepted → DUPLICATE_COMMAND_ID，不改变聚合状态", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-fi-accept";
      const chapterId = "ch1";
      const runId = createRunId();
      const traceId = createTraceId();

      const store = makeStore(root, workspaceId, runId, traceId);
      const repo = makeRepo(root, workspaceId, chapterId, runId, traceId);
      seedApprovalFlow(repo, store);

      const accept = repo.appendEvent(store, {
        actor: "user",
        stage: "user_revision",
        eventType: "user_accepted",
        status: "completed",
        evidenceLevel: "confirmed",
        approvalId: "ap-1",
        payload: { commandId: "accept-cmd-1" },
      });
      assert.equal(accept.fold.ok, true, accept.fold.error?.message);
      assert.equal(accept.fold.aggregate.approvalState, "accepted");

      // 同 commandId 重放（新 eventId）→ 幂等命中
      const replay = repo.appendEvent(store, {
        actor: "user",
        stage: "user_revision",
        eventType: "user_accepted",
        status: "completed",
        evidenceLevel: "confirmed",
        approvalId: "ap-1",
        payload: { commandId: "accept-cmd-1" },
      });
      assert.equal(replay.fold.ok, true);
      assert.equal(replay.fold.idempotentReplay, true);
      assert.equal(replay.fold.error?.code, RUN_ERROR_CODES.DUPLICATE_COMMAND_ID);
      // 聚合未改变：仍 accepted，seenCommandIds 只记录一次
      assert.equal(replay.fold.aggregate.approvalState, "accepted");
      assert.equal(
        Object.keys(replay.fold.aggregate.seenCommandIds).filter((k) => k === "accept-cmd-1").length,
        1,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P8 fault injection: §6 场景 12 — 删除投影可由事件流重建", () => {
  test("删除 current-run-state / approval-pending 后 rebuildProjectionsFromAggregate 重建一致", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-fi-proj";
      const chapterId = "ch2";
      const runId = createRunId();
      const traceId = createTraceId();

      const store = makeStore(root, workspaceId, runId, traceId);
      const repo = makeRepo(root, workspaceId, chapterId, runId, traceId);
      seedApprovalFlow(repo, store);

      const written = writeRunProjections({
        projectRoot: root,
        aggregate: repo.getAggregate(),
        events: store.getEntries(),
      });

      const original = {};
      for (const [key, path] of Object.entries({
        currentRunState: written.currentRunStatePath,
        checkpointIndex: written.checkpointIndexPath,
        approvalPending: written.approvalPendingPath,
        transitionHistory: written.transitionHistoryPath,
      })) {
        assert.ok(existsSync(path), `projection missing: ${path}`);
        original[key] = readFileSync(path, "utf8");
      }

      // 删除全部投影（模拟 latest.json / pending 丢失）
      for (const path of Object.values(written)) {
        rmSync(path, { force: true });
      }

      // 重启：从事件流 bootstrap + recover
      const store2 = makeStore(root, workspaceId, runId, traceId);
      const repo2 = makeRepo(root, workspaceId, chapterId, runId, traceId);
      const recovered = repo2.recoverFromEvents(store2.getEntries());
      assert.equal(recovered.ok, true, recovered.error?.message);

      // 重建投影并逐字节比对
      const rebuilt = rebuildProjectionsFromAggregate(
        root,
        recovered.aggregate,
        store2.getEntries(),
      );
      assert.equal(readFileSync(rebuilt.currentRunStatePath, "utf8"), original.currentRunState);
      assert.equal(readFileSync(rebuilt.approvalPendingPath, "utf8"), original.approvalPending);
      assert.equal(readFileSync(rebuilt.checkpointIndexPath, "utf8"), original.checkpointIndex);
      assert.equal(readFileSync(rebuilt.transitionHistoryPath, "utf8"), original.transitionHistory);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
