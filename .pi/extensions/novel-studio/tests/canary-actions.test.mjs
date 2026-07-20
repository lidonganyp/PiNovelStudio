/** G5 P1 canary decision execution tests. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { executeCanaryDecision } from "../dist-test/v2/governance/canary-actions.js";

function evaluation(status = "healthy") {
  return {
    releaseId: "rel-001",
    status,
    evidence: {
      sampleCount: 5,
      alignmentRate: status === "auto_hold_eligible" ? 0.2 : 0.9,
      rollbackRate: 0,
      factGuardPassRate: 1,
      consecutiveNegative: status === "auto_hold_eligible" ? 3 : 0,
      longTermAlignmentRate: status === "retired_suggestion" ? 0.2 : 0.9,
    },
    decision: {
      shouldAutoHold: status === "auto_hold_eligible",
      shouldSuggestRetired: status === "retired_suggestion",
      recoveryAlignmentRate: 0.8,
      currentStatus: "active_dev",
      alreadyHeld: false,
    },
  };
}

function authorization() {
  return {
    schemaId: "pinovel.canary-authorization",
    schemaVersion: 1,
    authorizationId: "auth-001",
    workspaceId: "workspace-001",
    allowedReleaseIds: ["rel-001"],
    budget: { maxChapters: 2, maxCalls: 12 },
    issuedAt: "2026-07-17T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    issuer: "user",
  };
}

function harness({ failTrace = false } = {}) {
  const traces = [];
  const registry = {
    loadManifest: () => ({ releaseId: "rel-001", status: "active_dev", approvalRef: "approval-001" }),
    transitionStatus: () => ({ status: "held" }),
    recordStateEvent: () => undefined,
  };
  const traceStore = {
    writeCanaryTrace: (trace) => {
      if (failTrace) throw new Error("trace write failed");
      traces.push(trace);
      return "trace.json";
    },
  };
  return { traces, registry, traceStore };
}

function run(strategy, options = {}) {
  const support = harness(options);
  const result = executeCanaryDecision({
    decision: { strategy, reason: "test" },
    evaluation: options.evaluation ?? evaluation(),
    releaseId: "rel-001",
    previousReleaseId: "rel-000",
    workspaceId: "workspace-001",
    changeClass: "R2",
    currentStatus: "active_dev",
    authorization: options.authorization,
    registry: support.registry,
    traceStore: support.traceStore,
    actor: "system",
    now: "2026-07-17T00:00:00.000Z",
    runId: "canary-rel-001-20260717T000000Z",
  });
  return { result, traces: support.traces };
}

test("skip and direct_promote perform no trace write", () => {
  for (const strategy of ["skip", "direct_promote"]) {
    const { result, traces } = run(strategy);
    assert.equal(result.blocked, false);
    assert.equal(traces.length, 0);
  }
});

test("shadow_required records pending real shadow run", () => {
  const { result, traces } = run("shadow_required");
  assert.equal(result.blocked, false);
  assert.equal(traces[0].status, "shadow_started");
  assert.equal(traces[0].shadowPendingRealRun, true);
});

test("bounded_canary without authorization is blocked with exit 6", () => {
  const { result, traces } = run("bounded_canary");
  assert.equal(result.blocked, true);
  assert.equal(result.blockedExitCode, 6);
  assert.equal(traces.length, 0);
});

test("bounded_canary with authorization records canary_started", () => {
  const { result, traces } = run("bounded_canary", { authorization: authorization() });
  assert.equal(result.blocked, false);
  assert.equal(traces[0].status, "canary_started");
  assert.equal(traces[0].evidence.authorizationId, "auth-001");
});

test("blocked auto_hold health executes hold and records blocked trace", () => {
  const { result, traces } = run("blocked", { evaluation: evaluation("auto_hold_eligible") });
  assert.equal(result.blocked, true);
  assert.equal(result.autoHoldTriggered, true);
  assert.equal(traces[0].status, "blocked");
});

test("blocked retired suggestion does not auto-hold", () => {
  const { result, traces } = run("blocked", { evaluation: evaluation("retired_suggestion") });
  assert.equal(result.blocked, true);
  assert.equal(result.autoHoldTriggered, false);
  assert.equal(traces[0].status, "blocked");
});

test("trace failure returns fail-closed exit 5", () => {
  const { result } = run("shadow_required", { failTrace: true });
  assert.equal(result.blocked, true);
  assert.equal(result.blockedExitCode, 5);
  assert.match(result.errorReason, /trace write failed/);
});

test("authorization workspace mismatch is blocked", () => {
  const wrong = authorization();
  wrong.workspaceId = "other-workspace";
  const { result } = run("bounded_canary", { authorization: wrong });
  assert.equal(result.blocked, true);
  assert.equal(result.blockedExitCode, 6);
});
