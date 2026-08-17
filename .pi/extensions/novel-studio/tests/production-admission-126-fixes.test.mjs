/**
 * rel-prod-126 forward-fix: bounded timeout, retryIndex forwarding,
 * post-save commit faults, and production-admission harness contracts.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { commitAndSave } from "../dist/v2/core/orchestrator-commit-save.js";
import {
  fetchWithTimeout,
  getModelRequestTimeoutMs,
} from "../dist/api/request-timeout.js";

const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readSrc(relPath) {
  return readFileSync(join(EXT_ROOT, relPath), "utf8");
}

test("getModelRequestTimeoutMs honors PINOVEL_MODEL_REQUEST_TIMEOUT_MS", () => {
  const prev = process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS;
  const prevForce = process.env.PINOVEL_FORCE_REQUEST_TIMEOUT_MS;
  try {
    delete process.env.PINOVEL_FORCE_REQUEST_TIMEOUT_MS;
    process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS = "1";
    assert.equal(getModelRequestTimeoutMs(), 1);
    process.env.PINOVEL_FORCE_REQUEST_TIMEOUT_MS = "25";
    process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS = "300000";
    assert.equal(getModelRequestTimeoutMs(), 25);
  } finally {
    if (prev === undefined) delete process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS;
    else process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS = prev;
    if (prevForce === undefined) delete process.env.PINOVEL_FORCE_REQUEST_TIMEOUT_MS;
    else process.env.PINOVEL_FORCE_REQUEST_TIMEOUT_MS = prevForce;
  }
});

test("fetchWithTimeout releases the caller when fetch ignores abort", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  const started = Date.now();
  try {
    await assert.rejects(
      () => fetchWithTimeout("https://example.invalid/hang", { method: "POST" }, {
        label: "hang-fetch",
        timeoutMs: 30,
      }),
      /hang-fetch timed out after 30ms/,
    );
    assert.ok(Date.now() - started < 1500, "bounded timeout must not wait on the hung fetch");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("legacy adapter and wrapModelFn must apply request timeout, not 600000 default", () => {
  const adapter = readSrc("v2/adapters/legacy-model-route-adapter.ts");
  assert.match(adapter, /getModelRequestTimeoutMs/);
  assert.doesNotMatch(
    adapter,
    /const candidateTimeoutMs = input\.timeoutMs \?\? 600000/,
    "adapter must not default a missing timeoutMs to 600000",
  );
  const orch = readSrc("v2/core/unified-orchestrator.ts");
  assert.match(orch, /getModelRequestTimeoutMs/);
  assert.match(orch, /timeoutMs:\s*resolvedTimeoutMs|resolvedTimeoutMs/);
});

test("tool-layer retry attempt must reach orchestrator retryIndex", () => {
  const handler = readSrc("handlers/public-handlers.ts");
  assert.match(handler, /_modelTimeoutRetryAttempt/);
  const entry = readSrc("v2/core/unified-entry.ts");
  assert.match(entry, /_modelTimeoutRetryAttempt/);
  assert.match(entry, /orchestrate\([\s\S]*_modelTimeoutRetryAttempt/);
});

test("PINOVEL_COMMIT_FAULT=after_chapter_save rolls back a saved chapter", () => {
  const root = mkdtempSync(join(tmpdir(), "commit-fault-save-"));
  const prev = process.env.PINOVEL_COMMIT_FAULT;
  process.env.PINOVEL_COMMIT_FAULT = "after_chapter_save";
  try {
    const workspaceId = "ws-after-save";
    const chapterId = "1";
    mkdirSync(join(root, "workspaces", workspaceId, "chapters"), { recursive: true });
    const chapterPath = join(root, "workspaces", workspaceId, "chapters", `${chapterId}.md`);
    const stageResults = {};
    const result = commitAndSave(
      {
        workspaceId,
        projectRoot: root,
        chapterId,
        chapterNumber: 1,
        characterNames: [],
      },
      "candidate-1",
      "saved then rolled back",
      stageResults,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /commit-fault|after_chapter_save|state commit/i);
    assert.equal(existsSync(chapterPath), false, "chapter must not remain after post-save rollback");
    assert.equal(stageResults.atomicSave?.rolledBack, true);
    assert.ok(stageResults.atomicSave?.filePath || stageResults.atomicSave?.bytes);
  } finally {
    if (prev === undefined) delete process.env.PINOVEL_COMMIT_FAULT;
    else process.env.PINOVEL_COMMIT_FAULT = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("PINOVEL_COMMIT_FAULT=state_commit rolls back after chapter_saved", () => {
  const root = mkdtempSync(join(tmpdir(), "commit-fault-state-"));
  const prev = process.env.PINOVEL_COMMIT_FAULT;
  process.env.PINOVEL_COMMIT_FAULT = "state_commit";
  try {
    const workspaceId = "ws-state-fail";
    const chapterId = "1";
    mkdirSync(join(root, "workspaces", workspaceId, "chapters"), { recursive: true });
    const chapterPath = join(root, "workspaces", workspaceId, "chapters", `${chapterId}.md`);
    const stageResults = {};
    const result = commitAndSave(
      {
        workspaceId,
        projectRoot: root,
        chapterId,
        chapterNumber: 1,
        characterNames: [],
        stagedStateUpdate: {
          sourceChapter: "ch1",
          entries: [],
        },
      },
      "candidate-1",
      "saved then state failed",
      stageResults,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /commit-fault|state_commit|state commit/i);
    assert.equal(existsSync(chapterPath), false, "chapter must be rolled back after state-commit fault");
    assert.equal(stageResults.atomicSave?.rolledBack, true);
  } finally {
    if (prev === undefined) delete process.env.PINOVEL_COMMIT_FAULT;
    else process.env.PINOVEL_COMMIT_FAULT = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("production-admission harness must not bypass G6 or hardcode productionComplete", () => {
  const harness = readSrc("scripts/production-admission-replay.mjs");
  assert.doesNotMatch(harness, /PINOVEL_DEV_MODE["']?\s*:\s*["']1["']/);
  assert.match(harness, /--real/);
  assert.doesNotMatch(harness, /const REAL = true/);
  assert.doesNotMatch(harness, /productionComplete:\s*true/);
  assert.match(harness, /retryIndex/);
  assert.match(harness, /PINOVEL_COMMIT_FAULT/);
  assert.match(harness, /PINOVEL_FORCE_REQUEST_TIMEOUT_MS/);
  assert.match(harness, /PINOVEL_ADMISSION_STUB/);
  assert.doesNotMatch(harness, /PINOVEL_MODEL_REQUEST_TIMEOUT_MS:\s*["']1["']/);
  assert.doesNotMatch(harness, /V2_FORCE_STUB:\s*["']1["']/);
  assert.match(harness, /durationMs|bounded/);
});
