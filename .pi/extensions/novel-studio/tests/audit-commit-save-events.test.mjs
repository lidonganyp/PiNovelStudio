/**
 * AUDIT-1：commitAndSave 正文保存 vs 状态提交 分离事件
 *
 * 断言：
 * - 正文保存成功 + 状态失败：有 chapter_saved、state_commit_failed，final_submission 不伪装成功
 * - 双成功：有 chapter_saved、state_committed、final_submission(chapterSaveOk && stateCommitOk)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitAndSave } from "../dist/v2/core/orchestrator-commit-save.js";

function makeSink() {
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
      events.push(input);
      return `evt-${events.length}`;
    },
  };
}

function createFailingInput(root, workspaceId, chapterId, auditSink) {
  const stagedStateUpdate = new Proxy(
    {},
    {
      get() {
        throw new Error("intentional state commit failure");
      },
    },
  );
  return {
    workspaceId,
    projectRoot: root,
    chapterId,
    chapterNumber: 1,
    characterNames: [],
    stagedStateUpdate,
    auditSink,
  };
}

function createSuccessNoStateInput(root, workspaceId, chapterId, auditSink) {
  return {
    workspaceId,
    projectRoot: root,
    chapterId,
    chapterNumber: 1,
    characterNames: [],
    // no stagedStateUpdate → state path skipped but still emits state_committed(skipped)
    auditSink,
  };
}

test("state commit failure emits chapter_saved + state_commit_failed + final_submission not ok", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-commit-fail-"));
  try {
    const workspaceId = "ws-audit-fail";
    const chapterId = "ch1";
    mkdirSync(join(root, "workspaces", workspaceId, "chapters"), { recursive: true });
    const sink = makeSink();
    const stageResults = {};

    const result = commitAndSave(
      createFailingInput(root, workspaceId, chapterId, sink),
      "candidate-1",
      "new chapter text",
      stageResults,
    );

    assert.equal(result.ok, false);
    const types = sink.events.map((e) => e.eventType);
    assert.ok(types.includes("chapter_save_attempted"));
    assert.ok(types.includes("chapter_saved"), "chapter save must be recorded before state failure");
    assert.ok(types.includes("state_commit_attempted"));
    assert.ok(types.includes("state_commit_failed"));
    assert.ok(types.includes("final_submission"));

    // 不得出现“状态成功但正文未保存”的伪装；此处是正文曾成功、状态失败后回滚
    const finalEvt = sink.events.find((e) => e.eventType === "final_submission");
    assert.equal(finalEvt.stateCommitOk, false);
    // 回滚成功路径：最终交付未成立 → chapterSaveOk=false
    assert.equal(finalEvt.chapterSaveOk, false);
    assert.equal(finalEvt.payload?.stateCommitOutcome, "failed");

    // 不得报双成功
    assert.notEqual(finalEvt.chapterSaveOk && finalEvt.stateCommitOk, true);

    const chapterPath = join(root, "workspaces", workspaceId, "chapters", `${chapterId}.md`);
    assert.equal(existsSync(chapterPath), false, "rolled back chapter must not remain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("success path emits chapter_saved + state_committed + final_submission both ok", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-commit-ok-"));
  try {
    const workspaceId = "ws-audit-ok";
    const chapterId = "ch1";
    mkdirSync(join(root, "workspaces", workspaceId, "chapters"), { recursive: true });
    const sink = makeSink();
    const stageResults = {};

    const result = commitAndSave(
      createSuccessNoStateInput(root, workspaceId, chapterId, sink),
      "candidate-ok",
      "delivered chapter text",
      stageResults,
    );

    assert.equal(result.ok, true);
    const types = sink.events.map((e) => e.eventType);
    assert.ok(types.includes("chapter_save_attempted"));
    assert.ok(types.includes("chapter_saved"));
    assert.ok(types.includes("state_commit_attempted"));
    // 无 stagedStateUpdate：不得冒充真实 state_committed 成功
    assert.equal(types.includes("state_committed"), false);
    const stateAttempt = sink.events.find((e) => e.eventType === "state_commit_attempted");
    assert.equal(stateAttempt?.statusOverride, "skipped");
    assert.equal(stateAttempt?.payload?.noop, true);
    assert.ok(types.includes("final_submission"));

    const finalEvt = sink.events.find((e) => e.eventType === "final_submission");
    assert.equal(finalEvt.chapterSaveOk, true);
    assert.equal(finalEvt.stateCommitOk, true);
    assert.equal(
      finalEvt.payload?.stateCommitOutcome,
      "skipped",
      "no-op state path must expose stateCommitOutcome=skipped",
    );
    assert.ok(finalEvt.outputHash, "final_submission binds content hash");

    const chapterPath = join(root, "workspaces", workspaceId, "chapters", `${chapterId}.md`);
    assert.equal(existsSync(chapterPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state failure final_submission carries stateCommitOutcome=failed", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-commit-outcome-fail-"));
  try {
    const workspaceId = "ws-outcome-fail";
    const chapterId = "ch1";
    mkdirSync(join(root, "workspaces", workspaceId, "chapters"), { recursive: true });
    const sink = makeSink();
    const result = commitAndSave(
      createFailingInput(root, workspaceId, chapterId, sink),
      "candidate-fail",
      "text",
      {},
    );
    assert.equal(result.ok, false);
    const finalEvt = sink.events.find((e) => e.eventType === "final_submission");
    assert.equal(finalEvt?.payload?.stateCommitOutcome, "failed");
    assert.equal(finalEvt?.stateCommitOk, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending proxy draft blocks both save and state with explicit events", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-commit-pending-"));
  try {
    const workspaceId = "ws-audit-pending";
    const chapterId = "ch1";
    const ws = join(root, "workspaces", workspaceId);
    mkdirSync(join(ws, "chapters"), { recursive: true });
    mkdirSync(join(ws, "chapter-approvals"), { recursive: true });
    writeFileSync(
      join(ws, "chapter-approvals", `${chapterId}.pending.json`),
      JSON.stringify({ status: "pending", approvalId: "appr-1" }),
      "utf-8",
    );
    const sink = makeSink();
    const stageResults = {};

    const result = commitAndSave(
      createSuccessNoStateInput(root, workspaceId, chapterId, sink),
      "candidate-pending",
      "should not save",
      stageResults,
    );

    assert.equal(result.ok, false);
    const types = sink.events.map((e) => e.eventType);
    assert.ok(types.includes("chapter_save_attempted") || types.includes("chapter_save_failed"));
    assert.ok(types.includes("chapter_save_failed"));
    assert.ok(types.includes("final_submission"));
    const finalEvt = sink.events.find((e) => e.eventType === "final_submission");
    assert.equal(finalEvt.chapterSaveOk, false);
    assert.equal(finalEvt.stateCommitOk, false);
    assert.equal(
      existsSync(join(ws, "chapters", `${chapterId}.md`)),
      false,
      "pending draft must not write chapter",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
