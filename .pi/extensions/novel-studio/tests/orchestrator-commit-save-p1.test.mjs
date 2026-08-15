/**
 * Delivery consistency regression tests for commitAndSave.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitAndSave } from "../dist-test/v2/core/orchestrator-commit-save.js";

function createFailingInput(root, workspaceId, chapterId) {
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
  };
}

test("state commit failure fails delivery and removes a newly saved chapter", () => {
  const root = mkdtempSync(join(tmpdir(), "commit-save-p1-new-"));
  try {
    const workspaceId = "ws-new";
    const chapterId = "ch1";
    const chapterPath = join(root, "workspaces", workspaceId, "chapters", `${chapterId}.md`);
    mkdirSync(join(root, "workspaces", workspaceId, "chapters"), { recursive: true });
    const stageResults = {};

    const result = commitAndSave(
      createFailingInput(root, workspaceId, chapterId),
      "candidate-1",
      "new chapter text",
      stageResults,
    );

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /state commit|intentional/i);
    assert.equal(existsSync(chapterPath), false, "new chapter must be removed after rollback");
    assert.equal(stageResults.atomicSave?.rolledBack, true);
    assert.ok(result.stateCommit?.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit-intent ledger write failure fails delivery", () => {
  const root = mkdtempSync(join(tmpdir(), "commit-save-ledger-fail-"));
  try {
    const workspaceId = "ws-ledger-fail";
    const chapterId = "1";
    mkdirSync(join(root, "workspaces", workspaceId, "chapters"), { recursive: true });
    writeFileSync(join(root, "workspaces", workspaceId, "chapter-approvals"), "not-a-dir", "utf-8");
    const stageResults = {};
    const result = commitAndSave(
      {
        workspaceId,
        projectRoot: root,
        chapterId,
        chapterNumber: 1,
        characterNames: [],
      },
      "candidate-ledger",
      "chapter text for ledger fail",
      stageResults,
    );
    assert.equal(result.ok, false, "ledger 写入失败不得返回整体成功");
    assert.match(result.error ?? "", /commit.?intent|ledger/i);
    assert.equal(stageResults.commitIntentLedger?.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state commit failure restores the previous chapter content", () => {
  const root = mkdtempSync(join(tmpdir(), "commit-save-p1-existing-"));
  try {
    const workspaceId = "ws-existing";
    const chapterId = "ch1";
    const chapterPath = join(root, "workspaces", workspaceId, "chapters", `${chapterId}.md`);
    mkdirSync(join(root, "workspaces", workspaceId, "chapters"), { recursive: true });
    writeFileSync(chapterPath, "previous chapter text", "utf-8");
    const stageResults = {};

    const result = commitAndSave(
      createFailingInput(root, workspaceId, chapterId),
      "candidate-2",
      "replacement chapter text",
      stageResults,
    );

    assert.equal(result.ok, false);
    assert.equal(readFileSync(chapterPath, "utf-8"), "previous chapter text");
    assert.equal(stageResults.atomicSave?.rolledBack, true);
    assert.equal(stageResults.atomicSave?.rollbackAction, "restored_previous");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
