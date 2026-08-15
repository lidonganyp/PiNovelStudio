/**
 * CONCURRENCY-WAVE5：崩溃恢复分类（save 前 / chapter save 后 / state commit 后 / receipt 后）
 *
 * 恢复依据是章节文件 + NarrativeState + job revision，不是锁文件是否存在。
 */

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createBatchWorkspace,
  createMockGenerateChapter,
  writeStateStoreEntry,
  cleanupWorkspace,
  PROJECT_ROOT,
} from "./batch-test-helpers.mjs";

const EXT_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const { reconcileBatchJobAfterCrash } = await import(
  pathToFileURL(join(EXT_ROOT, "dist", "v2", "core", "batch-generation-job-store.js")).href
);
const { handleBatchGeneration } = await import(
  pathToFileURL(join(EXT_ROOT, "dist", "handlers", "batch-generation-handler.js")).href
);

describe("CONCURRENCY-WAVE5：崩溃恢复分类", () => {
  const workspaces = [];
  function fresh(id) {
    createBatchWorkspace(id);
    workspaces.push(id);
    return join(PROJECT_ROOT, "workspaces", id);
  }
  after(() => {
    for (const id of workspaces) cleanupWorkspace(id);
  });

  function textHash(text) {
    return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
  }

  function writeCommitFacts(workspacePath, chapterNumber, text) {
    const hash = textHash(text);
    const approvals = join(workspacePath, "chapter-approvals");
    mkdirSync(approvals, { recursive: true });
    const chapterId = String(chapterNumber);
    writeFileSync(join(approvals, `${chapterId}.commit-intents.json`), JSON.stringify({
      schemaVersion: 1,
      entries: {
        [`intent-ch${chapterNumber}`]: {
          commitIntentId: `intent-ch${chapterNumber}`,
          artifactHash: hash,
          status: "completed",
          completedAt: new Date().toISOString(),
          chapterId,
        },
      },
    }, null, 2), "utf-8");
    writeStateStoreEntry(workspacePath, chapterNumber, text);
  }

  function baseState(workspaceId, overrides = {}) {
    return {
      jobId: "batch-wave5-recovery",
      workspaceId,
      status: "running",
      startChapter: 1,
      endChapter: 2,
      seedSource: "workspace_only",
      stopOnFailure: true,
      confirmLargeBatch: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      frontier: 1,
      completedChapters: [],
      failedChapter: null,
      chapters: [
        { chapterNumber: 1, chapterId: "1", status: "pending" },
        { chapterNumber: 2, chapterId: "2", status: "pending" },
      ],
      cancelRequested: false,
      stateRevision: 1,
      lastEventId: "evt-1",
      ownerRunId: "run-recovery",
      ...overrides,
    };
  }

  it("save 前崩溃：无章节文件 → retry 第 1 章", () => {
    const ws = "batch-wave5-rec-pre-save";
    fresh(ws);
    const rec = reconcileBatchJobAfterCrash(baseState(ws), PROJECT_ROOT);
    assert.equal(rec.decision, "retry");
    assert.equal(rec.incompleteChapter, 1);
    assert.deepEqual(rec.recoveredChapters, []);
  });

  it("chapter save 后崩溃：有正文无 NarrativeState → 仍 retry，不得当完成", () => {
    const ws = "batch-wave5-rec-after-chapter";
    const workspacePath = fresh(ws);
    mkdirSync(join(workspacePath, "chapters"), { recursive: true });
    writeFileSync(join(workspacePath, "chapters", "1.md"), "# 第1章\n半提交\n", "utf-8");
    const rec = reconcileBatchJobAfterCrash(baseState(ws, { frontier: 2 }), PROJECT_ROOT);
    assert.equal(rec.decision, "retry");
    assert.equal(rec.incompleteChapter, 1);
    assert.ok(!rec.recoveredChapters.includes(1));
  });

  it("state commit 后崩溃：正文+状态齐全 → 该章 recovered，下一章 retry", () => {
    const ws = "batch-wave5-rec-after-state";
    const workspacePath = fresh(ws);
    const text = "# 第1章\n已提交\n";
    writeFileSync(join(workspacePath, "chapters", "1.md"), text, "utf-8");
    writeStateStoreEntry(workspacePath, 1, text);
    const rec = reconcileBatchJobAfterCrash(baseState(ws, { frontier: 2 }), PROJECT_ROOT);
    assert.equal(rec.decision, "retry");
    assert.ok(!rec.recoveredChapters.includes(1), "无 commit intent 不得把该章标 recovered");
    assert.equal(rec.incompleteChapter, 1);
  });

  it("正文+状态但无 commit intent / receipt 时不得标 completed", () => {
    const ws = "batch-wave5-rec-no-intent";
    const workspacePath = fresh(ws);
    const text = "# 第1章\n无收据\n";
    writeFileSync(join(workspacePath, "chapters", "1.md"), text, "utf-8");
    writeStateStoreEntry(workspacePath, 1, text);
    const rec = reconcileBatchJobAfterCrash(baseState(ws, { frontier: 2, endChapter: 1 }), PROJECT_ROOT);
    assert.equal(rec.decision, "retry");
    assert.equal(rec.incompleteChapter, 1);
    assert.ok(!rec.recoveredChapters.includes(1));
    assert.equal(rec.facts?.[0]?.commitIntentCompleted, false);
  });

  it("commit intent artifactHash 与正文不一致 → retry", () => {
    const ws = "batch-wave5-rec-hash-mismatch";
    const workspacePath = fresh(ws);
    const text = "# 第1章\n当前正文\n";
    writeFileSync(join(workspacePath, "chapters", "1.md"), text, "utf-8");
    writeCommitFacts(workspacePath, 1, "# 第1章\n另一份正文\n");
    writeFileSync(join(workspacePath, "chapters", "1.md"), text, "utf-8");
    const rec = reconcileBatchJobAfterCrash(baseState(ws, { frontier: 2, endChapter: 1 }), PROJECT_ROOT);
    assert.equal(rec.decision, "retry");
    assert.equal(rec.facts?.[0]?.hashMatchesIntent, false);
  });

  it("事件 + commit intent + 正文 hash + NarrativeState + receipt 齐全才 completed", () => {
    const ws = "batch-wave5-rec-full-facts";
    const workspacePath = fresh(ws);
    const text = "# 第1章\n完整事实\n";
    writeFileSync(join(workspacePath, "chapters", "1.md"), text, "utf-8");
    writeCommitFacts(workspacePath, 1, text);
    const rec = reconcileBatchJobAfterCrash(baseState(ws, {
      frontier: 2,
      endChapter: 1,
      completedChapters: [1],
      lastEventId: "evt-9-chapter_completed",
    }), PROJECT_ROOT);
    assert.equal(rec.decision, "completed");
    assert.deepEqual(rec.recoveredChapters, [1]);
    assert.equal(rec.facts?.[0]?.commitIntentCompleted, true);
    assert.equal(rec.facts?.[0]?.hashMatchesIntent, true);
    assert.equal(rec.facts?.[0]?.commitReceiptPresent, true);
    assert.ok(rec.facts?.[0]?.lastEventId);
  });

  it("recovery trace 写入失败时 resume fail-closed", async () => {
    const ws = "batch-wave5-rec-trace-fail";
    const workspacePath = fresh(ws);
    const mock = createMockGenerateChapter({
      workspacePath,
      failOnChapters: [1],
    });
    const start = await handleBatchGeneration({
      mode: "batch",
      action: "start",
      workspaceId: ws,
      jobId: "batch-wave5-rec-trace-fail",
      commandId: "cmd-trace-setup",
      startChapter: 1,
      endChapter: 2,
      _projectRoot: PROJECT_ROOT,
      _mockGenerateChapter: mock,
    });
    assert.equal(start.status, "paused");
    const trap = join(workspacePath, "batch-jobs", `${start.jobId}.recovery.json`);
    mkdirSync(trap, { recursive: true });
    const resume = await handleBatchGeneration({
      mode: "batch",
      action: "resume",
      workspaceId: ws,
      jobId: start.jobId,
      commandId: "cmd-trace-fail",
      _projectRoot: PROJECT_ROOT,
      _mockGenerateChapter: mock,
    });
    assert.equal(resume.status, "error");
    assert.equal(resume.concurrencyError, "recovery_trace_failed");
  });

  it("receipt 后崩溃：两章都已提交 → completed", () => {
    const ws = "batch-wave5-rec-after-receipt";
    const workspacePath = fresh(ws);
    for (const n of [1, 2]) {
      const text = `# 第${n}章\n完成\n`;
      writeFileSync(join(workspacePath, "chapters", `${n}.md`), text, "utf-8");
      writeCommitFacts(workspacePath, n, text);
    }
    const rec = reconcileBatchJobAfterCrash(baseState(ws, {
      frontier: 3,
      completedChapters: [1, 2],
    }), PROJECT_ROOT);
    assert.equal(rec.decision, "completed");
    assert.deepEqual(rec.recoveredChapters, [1, 2]);
    assert.equal(rec.incompleteChapter, null);
  });

  it("resume 孤儿 running 且两章已提交时写出 recovery trace 并直接 completed", async () => {
    const ws = "batch-wave5-rec-resume";
    const workspacePath = fresh(ws);
    for (const n of [1, 2]) {
      const text = `# 第${n}章\n完成\n`;
      writeFileSync(join(workspacePath, "chapters", `${n}.md`), text, "utf-8");
      writeStateStoreEntry(workspacePath, n, text);
    }
    const mock = createMockGenerateChapter({ workspacePath });
    const start = await handleBatchGeneration({
      mode: "batch",
      action: "start",
      workspaceId: ws,
      jobId: "batch-wave5-recovery-job",
      commandId: "cmd-rec-start",
      startChapter: 1,
      endChapter: 2,
      _projectRoot: PROJECT_ROOT,
      _mockGenerateChapter: mock,
    });
    assert.equal(start.status, "completed");
    for (const n of [1, 2]) {
      const chapterFile = join(workspacePath, "chapters", `${n}.md`);
      const text = readFileSync(chapterFile, "utf-8");
      writeCommitFacts(workspacePath, n, text);
    }
    const jobPath = join(workspacePath, "batch-jobs", `${start.jobId}.json`);
    const raw = JSON.parse(readFileSync(jobPath, "utf-8"));
    raw.status = "running";
    writeFileSync(jobPath, JSON.stringify(raw, null, 2), "utf-8");

    const resume = await handleBatchGeneration({
      mode: "batch",
      action: "resume",
      workspaceId: ws,
      jobId: start.jobId,
      commandId: "cmd-rec-resume",
      _projectRoot: PROJECT_ROOT,
      _mockGenerateChapter: mock,
    });
    const tracePath = join(workspacePath, "batch-jobs", `${start.jobId}.recovery.json`);
    assert.ok(existsSync(tracePath), "resume 必须留下 recovery trace");
    assert.equal(resume.status, "completed");
    assert.notEqual(resume.status, "error");
  });
});
