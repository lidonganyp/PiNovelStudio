/**
 * RUN-LIFECYCLE P8 — 并发 / 重启重复 commitIntentId 验收
 *
 * 补 run-lifecycle-crash-matrix（reducer 层）与 commit-intent-idempotency（磁盘账本层）未覆盖的
 * 中间窗口：commitAndSave 已在事件流落 final_submission（聚合 → committed/completed），
 * 但磁盘账本 markCommitIntentCompleted 尚未执行（崩溃点）。此时用新 AuditRunSession
 * （模拟进程重启）重放事件流，聚合应从事件流恢复 committed 并单独提供幂等 / hash 绑定，
 * 不依赖磁盘账本是否存在。
 *
 * 双源 fail-closed 的两半分别验证：
 *   1. 磁盘账本（commit-intent-idempotency-approval-gate.test.mjs 已覆盖）
 *   2. 事件流恢复的 RunAggregate.commitIntent（本文件覆盖）
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { commitAndSave } from "../dist/v2/core/orchestrator-commit-save.js";
import { createAuditRunSession } from "../dist/v2/core/audit/index.js";
import { computeFinalTextHash } from "../dist/v2/core/final-state-commit.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "run-conc-ci-"));
}

function wsDir(root, workspaceId) {
  return join(root, "workspaces", workspaceId);
}

function diskLedgerPath(root, workspaceId, chapterId) {
  return join(wsDir(root, workspaceId), "chapter-approvals", `${chapterId}.commit-intents.json`);
}

function chapterPath(root, workspaceId, chapterId) {
  return join(wsDir(root, workspaceId), "chapters", `${chapterId}.md`);
}

function makeSession(root, workspaceId, chapterId, chapterNumber, runId, traceId) {
  return createAuditRunSession({
    projectRoot: root,
    workspaceId,
    chapterId,
    chapterNumber,
    persist: true,
    runId,
    traceId,
  });
}

function makeInput(root, workspaceId, chapterId, chapterNumber, session) {
  return {
    workspaceId,
    projectRoot: root,
    chapterId,
    chapterNumber,
    characterNames: [],
    auditSink: session,
  };
}

describe("P8: 并发/重启重复 commitIntentId — 事件流恢复提供幂等（磁盘账本缺失）", () => {
  test("崩溃于 markCommitIntentCompleted 前 → 新 session 从事件流恢复 committed，重复提交幂等且无第二次副作用", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-conc";
      const chapterId = "ch1";
      const chapterNumber = 1;
      const runId = "run-conc-1";
      const traceId = "trc-conc-1";

      mkdirSync(join(wsDir(root, workspaceId), "chapters"), { recursive: true });
      mkdirSync(join(wsDir(root, workspaceId), "chapter-approvals"), { recursive: true });

      const text = "并发幂等正文";
      const hash = computeFinalTextHash(text);
      const commitIntentId = `ci-conc-${hash.slice(0, 12)}`;
      const artifactRevision = hash.slice(0, 16);

      // ── 第一次提交：事件流 + 磁盘账本均完成 ──
      const s1 = makeSession(root, workspaceId, chapterId, chapterNumber, runId, traceId);
      s1.start();
      const r1 = commitAndSave(
        makeInput(root, workspaceId, chapterId, chapterNumber, s1),
        "cand-1",
        text,
        { commitIntentId, artifactRevision },
      );
      assert.equal(r1.ok, true);
      assert.equal(r1.idempotent, undefined);
      assert.equal(readFileSync(chapterPath(root, workspaceId, chapterId), "utf-8"), text);
      // 聚合已 committed（final_submission 折叠）
      assert.equal(s1.getRunAggregate().workflowState, "committed");
      assert.equal(s1.getRunAggregate().commitIntent?.status, "completed");

      // ── 模拟崩溃窗口：删除磁盘账本（markCommitIntentCompleted 未执行），保留事件流 ──
      assert.ok(existsSync(diskLedgerPath(root, workspaceId, chapterId)));
      rmSync(diskLedgerPath(root, workspaceId, chapterId), { force: true });
      assert.equal(existsSync(diskLedgerPath(root, workspaceId, chapterId)), false);

      // ── 重启：新 session 从事件流 bootstrap + recover ──
      const s2 = makeSession(root, workspaceId, chapterId, chapterNumber, runId, traceId);
      // 构造即恢复；确认聚合从事件流回到 committed（磁盘账本已删，唯一来源是事件流）
      assert.equal(s2.getRunAggregate().workflowState, "committed");
      assert.equal(s2.getRunAggregate().commitIntent?.status, "completed");
      assert.equal(s2.getLifecycleGate().commitIntent?.commitIntentId, commitIntentId);

      const r2 = commitAndSave(
        makeInput(root, workspaceId, chapterId, chapterNumber, s2),
        "cand-1",
        text,
        { commitIntentId, artifactRevision },
      );
      // 幂等命中，来源应为聚合（磁盘账本缺失）
      assert.equal(r2.ok, true);
      assert.equal(r2.idempotent, true);

      // 正文未被二次覆盖
      assert.equal(readFileSync(chapterPath(root, workspaceId, chapterId), "utf-8"), text);

      // 持久化事件流中 chapter_saved / final_submission 各只出现一次
      const allEvents = [
        ...s1.getEntries(),
        ...s2.getEntries().filter((e) => !s1.getEntries().some((x) => x.eventId === e.eventId)),
      ];
      const saved = allEvents.filter((e) => e.eventType === "chapter_saved");
      const final = allEvents.filter((e) => e.eventType === "final_submission");
      assert.equal(saved.length, 1, "must emit exactly one chapter_saved");
      assert.equal(final.length, 1, "must emit exactly one final_submission");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("崩溃于账本前 + 不同正文重放 → ARTIFACT_HASH_MISMATCH（聚合 hash 绑定，不依赖磁盘账本）", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-conc-hash";
      const chapterId = "ch2";
      const chapterNumber = 2;
      const runId = "run-conc-2";
      const traceId = "trc-conc-2";

      mkdirSync(join(wsDir(root, workspaceId), "chapters"), { recursive: true });
      mkdirSync(join(wsDir(root, workspaceId), "chapter-approvals"), { recursive: true });

      const text = "原始已提交正文";
      const hash = computeFinalTextHash(text);
      const commitIntentId = `ci-conc-${hash.slice(0, 12)}`;
      const artifactRevision = hash.slice(0, 16);

      const s1 = makeSession(root, workspaceId, chapterId, chapterNumber, runId, traceId);
      s1.start();
      const r1 = commitAndSave(
        makeInput(root, workspaceId, chapterId, chapterNumber, s1),
        "cand-1",
        text,
        { commitIntentId, artifactRevision },
      );
      assert.equal(r1.ok, true);

      // 删除磁盘账本模拟崩溃窗口
      rmSync(diskLedgerPath(root, workspaceId, chapterId), { force: true });

      // 重启后不同正文重放
      const s2 = makeSession(root, workspaceId, chapterId, chapterNumber, runId, traceId);
      assert.equal(s2.getLifecycleGate().commitIntent?.status, "completed");
      const r2 = commitAndSave(
        makeInput(root, workspaceId, chapterId, chapterNumber, s2),
        "cand-1",
        text + " MUTATED",
        { commitIntentId, artifactRevision },
      );
      assert.equal(r2.ok, false);
      assert.match(r2.error ?? "", /ARTIFACT_HASH_MISMATCH/);
      // 正文不得被覆盖
      assert.equal(readFileSync(chapterPath(root, workspaceId, chapterId), "utf-8"), text);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
