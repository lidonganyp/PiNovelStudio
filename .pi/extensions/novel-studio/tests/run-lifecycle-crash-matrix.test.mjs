/**
 * RUN-LIFECYCLE P8 — 故障注入矩阵（事务边界崩溃/重启）
 *
 * 覆盖计划 §6 三类进程退出场景（在 reducer/repository 层模拟）：
 *   1. 正文保存前崩溃 → 聚合非 committed；可 resume
 *   2. 正文保存后、状态提交前崩溃 → 正文已存、状态未提交；可补状态后 resume
 *   3. 状态提交后崩溃 → 重放识别 committed；重复 commitIntent 幂等
 *
 * "进程退出" = 事件流停止追加；"重启" = 新 store 从磁盘 bootstrap + 新 repo recoverFromEvents。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AuditEventStore,
  createRunAggregateRepository,
  RUN_ERROR_CODES,
  createTraceId,
  createRunId,
} from "../dist/v2/core/unified-entry.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "run-crash-"));
}

const HASH = "a".repeat(64);
const REV = "rev-1";
const NS_REV = "ns-1";

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

/** 前导事件：run_started + candidate_created（建立 artifact 绑定） */
function seed(repo, store) {
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
}

function commitStarted(repo, store, commitIntentId) {
  repo.appendEvent(store, {
    actor: "orchestrator",
    stage: "state_commit",
    eventType: "commit_started",
    status: "started",
    evidenceLevel: "observed",
    revision: REV,
    outputHash: HASH,
    payload: { commitIntentId, artifactHash: HASH, artifactRevision: REV },
  });
}

describe("P8 crash matrix: 正文保存前崩溃", () => {
  test("commit_started 后进程退出 → 聚合 commit_pending 非 committed，可 resume 至 committed", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-crash1";
      const chapterId = "ch1";
      const runId = createRunId();
      const traceId = createTraceId();
      const commitIntentId = "ci-crash1";

      const store1 = makeStore(root, workspaceId, runId, traceId);
      const repo1 = makeRepo(root, workspaceId, chapterId, runId, traceId);
      seed(repo1, store1);
      commitStarted(repo1, store1, commitIntentId);

      // ── 崩溃 + 重启 ──
      const store2 = makeStore(root, workspaceId, runId, traceId);
      const repo2 = makeRepo(root, workspaceId, chapterId, runId, traceId);
      const recovered = repo2.recoverFromEvents(store2.getEntries());
      assert.equal(recovered.ok, true, recovered.error?.message);

      const agg = recovered.aggregate;
      assert.equal(agg.workflowState, "commit_pending");
      assert.equal(agg.terminalStatus, "none");
      assert.equal(agg.commitIntent?.status, "attempted");
      assert.equal(agg.artifactHash, HASH);

      // resume：补 final_submission → committed
      const resume = repo2.appendEvent(store2, {
        actor: "orchestrator",
        stage: "state_commit",
        eventType: "final_submission",
        status: "completed",
        evidenceLevel: "confirmed",
        revision: REV,
        outputHash: HASH,
        payload: { chapterSaveOk: true, stateCommitOk: true, commitIntentId },
      });
      assert.equal(resume.fold.ok, true, resume.fold.error?.message);
      assert.equal(resume.fold.aggregate.workflowState, "committed");
      assert.equal(resume.fold.aggregate.terminalStatus, "committed");
      assert.equal(resume.fold.aggregate.commitIntent?.status, "completed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P8 crash matrix: 正文保存后、状态提交前崩溃", () => {
  test("chapter_saved 后进程退出 → 正文已存但状态未提交；补状态后可 committed", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-crash2";
      const chapterId = "ch2";
      const runId = createRunId();
      const traceId = createTraceId();
      const commitIntentId = "ci-crash2";

      const store1 = makeStore(root, workspaceId, runId, traceId);
      const repo1 = makeRepo(root, workspaceId, chapterId, runId, traceId);
      seed(repo1, store1);
      commitStarted(repo1, store1, commitIntentId);
      // 正文已原子保存
      repo1.appendEvent(store1, {
        actor: "orchestrator",
        stage: "chapter_save",
        eventType: "chapter_saved",
        status: "completed",
        evidenceLevel: "observed",
        revision: REV,
        outputHash: HASH,
        payload: { chapterSaveOk: true },
      });

      // ── 崩溃 + 重启 ──
      const store2 = makeStore(root, workspaceId, runId, traceId);
      const repo2 = makeRepo(root, workspaceId, chapterId, runId, traceId);
      const recovered = repo2.recoverFromEvents(store2.getEntries());
      assert.equal(recovered.ok, true, recovered.error?.message);

      const agg = recovered.aggregate;
      assert.equal(agg.workflowState, "commit_pending");
      assert.equal(agg.terminalStatus, "none");
      // 正文已存，但叙事状态尚未提交
      assert.equal(agg.artifactHash, HASH);
      assert.equal(agg.narrativeStateRevision, null);

      // 补状态提交 + final_submission → committed
      repo2.appendEvent(store2, {
        actor: "orchestrator",
        stage: "state_commit",
        eventType: "state_committed",
        status: "completed",
        evidenceLevel: "observed",
        revision: NS_REV,
        payload: { narrativeStateRevision: NS_REV },
      });
      const resume = repo2.appendEvent(store2, {
        actor: "orchestrator",
        stage: "state_commit",
        eventType: "final_submission",
        status: "completed",
        evidenceLevel: "confirmed",
        revision: REV,
        outputHash: HASH,
        payload: { chapterSaveOk: true, stateCommitOk: true, commitIntentId },
      });
      assert.equal(resume.fold.ok, true, resume.fold.error?.message);
      assert.equal(resume.fold.aggregate.workflowState, "committed");
      assert.equal(resume.fold.aggregate.narrativeStateRevision, NS_REV);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P8 crash matrix: 状态提交后崩溃", () => {
  test("final_submission 后进程退出 → 重放识别 committed；重复 commitIntent 幂等", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-crash3";
      const chapterId = "ch3";
      const runId = createRunId();
      const traceId = createTraceId();
      const commitIntentId = "ci-crash3";

      const store1 = makeStore(root, workspaceId, runId, traceId);
      const repo1 = makeRepo(root, workspaceId, chapterId, runId, traceId);
      seed(repo1, store1);
      commitStarted(repo1, store1, commitIntentId);
      repo1.appendEvent(store1, {
        actor: "orchestrator",
        stage: "chapter_save",
        eventType: "chapter_saved",
        status: "completed",
        evidenceLevel: "observed",
        revision: REV,
        outputHash: HASH,
        payload: { chapterSaveOk: true },
      });
      repo1.appendEvent(store1, {
        actor: "orchestrator",
        stage: "state_commit",
        eventType: "state_committed",
        status: "completed",
        evidenceLevel: "observed",
        revision: NS_REV,
        payload: { narrativeStateRevision: NS_REV },
      });
      repo1.appendEvent(store1, {
        actor: "orchestrator",
        stage: "state_commit",
        eventType: "final_submission",
        status: "completed",
        evidenceLevel: "confirmed",
        revision: REV,
        outputHash: HASH,
        payload: { chapterSaveOk: true, stateCommitOk: true, commitIntentId },
      });

      // ── 崩溃 + 重启 ──
      const store2 = makeStore(root, workspaceId, runId, traceId);
      const repo2 = makeRepo(root, workspaceId, chapterId, runId, traceId);
      const recovered = repo2.recoverFromEvents(store2.getEntries());
      assert.equal(recovered.ok, true, recovered.error?.message);

      const agg = recovered.aggregate;
      assert.equal(agg.workflowState, "committed");
      assert.equal(agg.terminalStatus, "committed");
      assert.equal(agg.commitIntent?.status, "completed");
      assert.equal(agg.narrativeStateRevision, NS_REV);

      // 重复提交意图：幂等命中，不产生新副作用
      const replay = repo2.appendEvent(store2, {
        actor: "orchestrator",
        stage: "state_commit",
        eventType: "commit_started",
        status: "started",
        evidenceLevel: "observed",
        revision: REV,
        outputHash: HASH,
        payload: { commitIntentId, artifactHash: HASH, artifactRevision: REV },
      });
      assert.equal(replay.fold.ok, true);
      assert.equal(replay.fold.idempotentReplay, true);
      assert.equal(replay.fold.error?.code, RUN_ERROR_CODES.DUPLICATE_COMMIT_INTENT);
      // 仍 committed，未倒退
      assert.equal(replay.fold.aggregate.workflowState, "committed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
