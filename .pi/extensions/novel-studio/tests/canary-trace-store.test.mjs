/** G5 P1 canary trace store tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCanaryTraceStore } from "../dist-test/v2/governance/canary-trace-store.js";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "canary-trace-"));
}

function makeTrace(overrides = {}) {
  return {
    schemaId: "pinovel.canary-run-trace",
    schemaVersion: 1,
    runId: "canary-rel-001-20260717T000000Z",
    releaseId: "rel-001",
    previousReleaseId: "rel-000",
    workspaceId: "workspace-001",
    startedAt: "2026-07-17T00:00:00.000Z",
    completedAt: null,
    strategy: "bounded_canary",
    status: "canary_started",
    healthSnapshot: {
      status: "healthy",
      alignmentRate: 0.9,
      sampleCount: 5,
      rollbackRate: 0,
      consecutiveNegative: 0,
    },
    evidence: { changeClass: "R2", currentStatus: "active_dev", authorizationId: "auth-001" },
    outcome: { promoted: false, heldByAutoHold: false },
    shadowPendingRealRun: true,
    ...overrides,
  };
}

test("write/read canary trace round-trips", () => {
  const root = makeRoot();
  try {
    const store = createCanaryTraceStore({ workspacePath: root });
    const trace = makeTrace();
    store.writeCanaryTrace(trace);
    assert.deepEqual(store.readCanaryTrace(trace.runId), trace);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate runId is append-only and rejected", () => {
  const root = makeRoot();
  try {
    const store = createCanaryTraceStore({ workspacePath: root });
    store.writeCanaryTrace(makeTrace());
    assert.throws(() => store.writeCanaryTrace(makeTrace()), /already exists|重复/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("list by release filters other releases", () => {
  const root = makeRoot();
  try {
    const store = createCanaryTraceStore({ workspacePath: root });
    store.writeCanaryTrace(makeTrace());
    store.writeCanaryTrace(makeTrace({ runId: "canary-rel-002-20260717T000001Z", releaseId: "rel-002" }));
    assert.deepEqual(store.listCanaryTracesByRelease("rel-001").map((trace) => trace.releaseId), ["rel-001"]);
    assert.equal(store.listAllCanaryTraces().length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid runId and releaseId traversal are rejected", () => {
  const root = makeRoot();
  try {
    const store = createCanaryTraceStore({ workspacePath: root });
    assert.throws(() => store.writeCanaryTrace(makeTrace({ runId: "../escape" })), /runId|非法/);
    assert.throws(() => store.listCanaryTracesByRelease("../escape"), /releaseId|非法/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("damaged trace JSON fails closed", () => {
  const root = makeRoot();
  try {
    const runsDir = join(root, "canary-runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "canary-damaged.json"), "{", "utf-8");
    const store = createCanaryTraceStore({ workspacePath: root });
    assert.throws(() => store.readCanaryTrace("canary-damaged"), /JSON|解析/);
    assert.throws(() => store.listAllCanaryTraces(), /JSON|解析/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing trace returns null", () => {
  const root = makeRoot();
  try {
    const store = createCanaryTraceStore({ workspacePath: root });
    assert.equal(store.readCanaryTrace("canary-missing"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
