/**
 * RUN-LIFECYCLE P0 修复验收：
 * 1) 相同 commitIntentId 不得重复 chapter_saved / final_submission 副作用
 * 2) approvalState=pending 时即使删除 pending sentinel 也不得写正文
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitAndSave } from "../dist/v2/core/orchestrator-commit-save.js";
import { createAuditRunSession } from "../dist/v2/core/audit/index.js";
import { computeFinalTextHash } from "../dist/v2/core/final-state-commit.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "commit-p0-"));
}

function makeMemorySink(gateState) {
  const events = [];
  return {
    events,
    recordModelTurn() {
      return null;
    },
    recordToolEvent() {
      return null;
    },
    recordPersistenceEvent(input) {
      events.push({ kind: "persistence", ...input });
      return `p-${events.length}`;
    },
    recordLifecycleEvent(input) {
      events.push({ kind: "lifecycle", ...input });
      if (input.eventType === "commit_started" && gateState) {
        // 模拟聚合：attempted → 不自动 completed（completed 由成功路径磁盘账本覆盖）
        gateState.commitIntent = {
          commitIntentId: input.payload?.commitIntentId,
          status: "attempted",
          artifactHash: input.outputHash,
          artifactRevision: input.payload?.artifactRevision ?? "r",
        };
      }
      return `l-${events.length}`;
    },
    getLifecycleGate() {
      return gateState
        ? {
            approvalState: gateState.approvalState ?? "none",
            workflowState: gateState.workflowState ?? "running",
            commitIntent: gateState.commitIntent ?? null,
            artifactHash: gateState.artifactHash ?? null,
            artifactRevision: gateState.artifactRevision ?? null,
            foldError: gateState.foldError ?? null,
          }
        : null;
    },
  };
}

describe("P0 commitIntentId idempotency + hash binding", () => {
  test("same commitIntentId + same content → idempotent, no re-save, no side effects", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-idem";
      const chapterId = "ch1";
      const ws = join(root, "workspaces", workspaceId);
      mkdirSync(join(ws, "chapters"), { recursive: true });
      mkdirSync(join(ws, "chapter-approvals"), { recursive: true });

      const text = "幂等提交正文 v1";
      const hash = computeFinalTextHash(text);
      const commitIntentId = `ci-test-${hash.slice(0, 12)}`;
      const stageResults1 = { commitIntentId, artifactRevision: "rev-1" };
      const sink1 = makeMemorySink({ approvalState: "none" });

      const r1 = commitAndSave(
        {
          workspaceId,
          projectRoot: root,
          chapterId,
          chapterNumber: 1,
          characterNames: [],
          auditSink: sink1,
        },
        "cand-1",
        text,
        stageResults1,
      );
      assert.equal(r1.ok, true);
      assert.equal(r1.idempotent, undefined);
      const chapterPath = join(ws, "chapters", `${chapterId}.md`);
      assert.equal(existsSync(chapterPath), true);
      assert.equal(readFileSync(chapterPath, "utf-8"), text);

      const saved1 = sink1.events.filter((e) => e.eventType === "chapter_saved").length;
      const final1 = sink1.events.filter((e) => e.eventType === "final_submission").length;
      assert.equal(saved1, 1);
      assert.equal(final1, 1);

      // 第二次：相同 commitIntentId + 相同正文
      const stageResults2 = { commitIntentId, artifactRevision: "rev-1" };
      const sink2 = makeMemorySink({ approvalState: "none" });
      const r2 = commitAndSave(
        {
          workspaceId,
          projectRoot: root,
          chapterId,
          chapterNumber: 1,
          characterNames: [],
          auditSink: sink2,
        },
        "cand-1",
        text,
        stageResults2,
      );
      assert.equal(r2.ok, true);
      assert.equal(r2.idempotent, true);
      // 正文不得被第二次覆盖
      assert.equal(readFileSync(chapterPath, "utf-8"), text);
      const saved2 = sink2.events.filter((e) => e.eventType === "chapter_saved").length;
      const final2 = sink2.events.filter((e) => e.eventType === "final_submission").length;
      assert.equal(saved2, 0, "idempotent path must not emit chapter_saved");
      assert.equal(final2, 0, "idempotent path must not emit final_submission");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("same commitIntentId + different content → ARTIFACT_HASH_MISMATCH (not idempotent)", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-mismatch";
      const chapterId = "ch1";
      const ws = join(root, "workspaces", workspaceId);
      mkdirSync(join(ws, "chapters"), { recursive: true });
      mkdirSync(join(ws, "chapter-approvals"), { recursive: true });

      const text = "原始已提交正文";
      const hash = computeFinalTextHash(text);
      const commitIntentId = `ci-test-${hash.slice(0, 12)}`;

      const r1 = commitAndSave(
        {
          workspaceId,
          projectRoot: root,
          chapterId,
          chapterNumber: 1,
          characterNames: [],
          auditSink: makeMemorySink({ approvalState: "none" }),
        },
        "cand-1",
        text,
        { commitIntentId, artifactRevision: "rev-1" },
      );
      assert.equal(r1.ok, true);

      const chapterPath = join(ws, "chapters", `${chapterId}.md`);
      const sink2 = makeMemorySink({ approvalState: "none" });
      const r2 = commitAndSave(
        {
          workspaceId,
          projectRoot: root,
          chapterId,
          chapterNumber: 1,
          characterNames: [],
          auditSink: sink2,
        },
        "cand-1",
        text + " MUTATED-SHOULD-NOT-WRITE",
        { commitIntentId, artifactRevision: "rev-1" },
      );
      // hash 绑定：相同 commitIntentId 但正文不同 → 拒绝覆盖，非幂等
      assert.equal(r2.ok, false);
      assert.equal(r2.idempotent, undefined);
      assert.match(r2.error ?? "", /ARTIFACT_HASH_MISMATCH/);
      // 正文不得被第二次覆盖
      assert.equal(readFileSync(chapterPath, "utf-8"), text);
      const saved2 = sink2.events.filter((e) => e.eventType === "chapter_saved").length;
      assert.equal(saved2, 0, "hash mismatch must not emit chapter_saved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("AuditRunSession gate: completed commitIntent short-circuits (same content)", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-sess";
      const chapterId = "ch2";
      mkdirSync(join(root, "workspaces", workspaceId, "chapters"), {
        recursive: true,
      });
      const session = createAuditRunSession({
        projectRoot: root,
        workspaceId,
        chapterId,
        chapterNumber: 2,
        persist: true,
      });
      session.start({ path: "commit-idempotency" });
      const text = "session idempotent body";
      const hash = computeFinalTextHash(text);
      const commitIntentId = `ci-sess-${hash.slice(0, 12)}`;

      const r1 = commitAndSave(
        {
          workspaceId,
          projectRoot: root,
          chapterId,
          chapterNumber: 2,
          characterNames: [],
          auditSink: session,
        },
        "c1",
        text,
        { commitIntentId, artifactRevision: hash.slice(0, 16) },
      );
      assert.equal(r1.ok, true);

      // 相同正文重放：磁盘账本应已写入 → 幂等命中
      const r2 = commitAndSave(
        {
          workspaceId,
          projectRoot: root,
          chapterId,
          chapterNumber: 2,
          characterNames: [],
          auditSink: session,
        },
        "c1",
        text,
        { commitIntentId, artifactRevision: hash.slice(0, 16) },
      );
      assert.equal(r2.ok, true);
      assert.equal(r2.idempotent, true);
      const path = join(
        root,
        "workspaces",
        workspaceId,
        "chapters",
        `${chapterId}.md`,
      );
      assert.equal(readFileSync(path, "utf-8"), text);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P0 approvalState gate without file sentinel", () => {
  test("approvalState=pending blocks save even if pending.json deleted", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-pend";
      const chapterId = "ch3";
      const ws = join(root, "workspaces", workspaceId);
      mkdirSync(join(ws, "chapters"), { recursive: true });
      mkdirSync(join(ws, "chapter-approvals"), { recursive: true });

      // 模拟：曾有 pending，文件已被误删，但聚合仍 pending
      const gateState = {
        approvalState: "pending",
        workflowState: "awaiting_approval",
        artifactHash: "a".repeat(64),
        artifactRevision: "rev-p",
      };
      const sink = makeMemorySink(gateState);
      const text = "should not be written";
      const result = commitAndSave(
        {
          workspaceId,
          projectRoot: root,
          chapterId,
          chapterNumber: 3,
          characterNames: [],
          auditSink: sink,
        },
        "c-pend",
        text,
        { commitIntentId: "ci-pend-1", artifactRevision: "rev-p" },
      );
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /approval_state/);
      const chapterPath = join(ws, "chapters", `${chapterId}.md`);
      assert.equal(existsSync(chapterPath), false);
      const saved = sink.events.filter((e) => e.eventType === "chapter_saved");
      assert.equal(saved.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("file pending still blocks when gate is absent", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-file";
      const chapterId = "ch4";
      const ws = join(root, "workspaces", workspaceId);
      mkdirSync(join(ws, "chapters"), { recursive: true });
      const approvals = join(ws, "chapter-approvals");
      mkdirSync(approvals, { recursive: true });
      writeFileSync(
        join(approvals, `${chapterId}.pending.json`),
        JSON.stringify({
          chapterId,
          approvalId: "ap-1",
          status: "pending",
          savedAt: new Date().toISOString(),
        }),
        "utf-8",
      );
      const sink = makeMemorySink(null);
      // getLifecycleGate returns null
      sink.getLifecycleGate = undefined;
      const result = commitAndSave(
        {
          workspaceId,
          projectRoot: root,
          chapterId,
          chapterNumber: 4,
          characterNames: [],
          auditSink: sink,
        },
        "c",
        "blocked by file",
        {},
      );
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /pending_proxy_draft/);
      assert.equal(
        existsSync(join(ws, "chapters", `${chapterId}.md`)),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("foldError blocks commit fail-closed", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-fold";
      const chapterId = "ch5";
      mkdirSync(join(root, "workspaces", workspaceId, "chapters"), {
        recursive: true,
      });
      const sink = makeMemorySink({
        approvalState: "none",
        foldError: "SEQUENCE_GAP: expected 2 got 9",
      });
      const result = commitAndSave(
        {
          workspaceId,
          projectRoot: root,
          chapterId,
          chapterNumber: 5,
          characterNames: [],
          auditSink: sink,
        },
        "c",
        "no write on fold error",
        { commitIntentId: "ci-fold" },
      );
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /audit_fold_error/);
      assert.equal(
        existsSync(
          join(root, "workspaces", workspaceId, "chapters", `${chapterId}.md`),
        ),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
