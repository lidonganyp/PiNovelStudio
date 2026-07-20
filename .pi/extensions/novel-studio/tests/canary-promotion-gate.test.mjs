/** Production promotion gate for completed canary evidence. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateCanaryPromotionGate,
  verifyCanaryResultArtifacts,
} from "../dist-test/v2/governance/canary-promotion-gate.js";

function makeTrace(overrides = {}) {
  return {
    schemaId: "pinovel.canary-run-trace",
    schemaVersion: 1,
    runId: "canary-rel-001-completed",
    releaseId: "rel-001",
    previousReleaseId: "rel-000",
    workspaceId: "ws-test",
    startedAt: "2026-07-17T01:00:00.000Z",
    completedAt: "2026-07-17T01:10:00.000Z",
    strategy: "bounded_canary",
    status: "completed",
    healthSnapshot: {
      status: "healthy",
      alignmentRate: 0.8,
      sampleCount: 5,
      rollbackRate: 0,
      consecutiveNegative: 0,
    },
    evidence: {
      changeClass: "R2",
      currentStatus: "candidate_prod",
      authorizationId: "cauth-001",
      sourceRunId: "canary-rel-001-started",
      environmentFingerprint: "fp-001",
      approvalRef: "apr-001",
      verdict: "pass",
      observedChapters: 5,
      observedCalls: 10,
      resultArtifactRefs: ["reports/canary-rel-001.json"],
      resultArtifactHashes: {
        "reports/canary-rel-001.json": "a".repeat(64),
      },
    },
    outcome: {
      promoted: false,
      heldByAutoHold: false,
    },
    shadowPendingRealRun: false,
    ...overrides,
  };
}

function evaluate(overrides = {}) {
  return evaluateCanaryPromotionGate({
    releaseId: "rel-001",
    changeClass: "R2",
    environmentFingerprint: "fp-001",
    approvalRef: "apr-001",
    workspaceId: "ws-test",
    trace: makeTrace(),
    ...overrides,
  });
}

test("R1 promotion does not require canary evidence", () => {
  assert.deepEqual(
    evaluate({ changeClass: "R1", trace: null }),
    { ok: true, evidenceRunId: null },
  );
});

test("R2 promotion without canary evidence is blocked", () => {
  const result = evaluate({ trace: null });
  assert.equal(result.ok, false);
  assert.equal(result.code, "CANARY_EVIDENCE_REQUIRED");
});

test("started or declarative-pending trace cannot authorize production", () => {
  for (const trace of [
    makeTrace({ status: "canary_started", completedAt: null }),
    makeTrace({ shadowPendingRealRun: true }),
  ]) {
    const result = evaluate({ trace });
    assert.equal(result.ok, false);
    assert.equal(result.code, "CANARY_NOT_COMPLETED");
  }
});

test("canary evidence must bind release, workspace, fingerprint, and approval", () => {
  const cases = [
    makeTrace({ releaseId: "rel-other" }),
    makeTrace({ workspaceId: "ws-other" }),
    makeTrace({ evidence: { ...makeTrace().evidence, environmentFingerprint: "fp-other" } }),
    makeTrace({ evidence: { ...makeTrace().evidence, approvalRef: "apr-other" } }),
  ];
  for (const trace of cases) {
    const result = evaluate({ trace });
    assert.equal(result.ok, false);
    assert.equal(result.code, "CANARY_BINDING_MISMATCH");
  }
});

test("canary pass requires positive observed work and result artifacts", () => {
  const cases = [
    makeTrace({ evidence: { ...makeTrace().evidence, verdict: "fail" } }),
    makeTrace({ evidence: { ...makeTrace().evidence, observedChapters: 0 } }),
    makeTrace({ evidence: { ...makeTrace().evidence, observedCalls: 0 } }),
    makeTrace({ evidence: { ...makeTrace().evidence, resultArtifactRefs: [] } }),
    makeTrace({ evidence: { ...makeTrace().evidence, resultArtifactHashes: {} } }),
  ];
  for (const trace of cases) {
    const result = evaluate({ trace });
    assert.equal(result.ok, false);
    assert.equal(result.code, "CANARY_RESULT_INVALID");
  }
});

test("canary result artifact hashes are verified against workspace files", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "canary-artifacts-"));
  try {
    // P0 修复后：artifact 必须是真实 chapter trace（traces/{chapterId}-quality-trace.json）
    const artifactRef = "traces/1-quality-trace.json";
    const artifactPath = join(workspacePath, artifactRef);
    mkdirSync(join(workspacePath, "traces"), { recursive: true });
    // 构造真实 trace doc：1 个 chapter、1 次 modelCall
    const traceDoc = {
      schemaVersion: 1,
      workspaceId: "ws-test",
      chapterId: "1",
      gates: [
        {
          stage: "v2_final_selected",
          status: "PASS",
          passed: true,
          evidence: {
            modelCalls: [
              { route: "v2_rawstage2", kind: "generation", durationMs: 1500, provider: "claude" },
            ],
          },
        },
      ],
    };
    const original = JSON.stringify(traceDoc, null, 2) + "\n";
    writeFileSync(artifactPath, original, "utf-8");
    const hash = createHash("sha256").update(original, "utf-8").digest("hex");
    const trace = makeTrace({
      evidence: {
        ...makeTrace().evidence,
        observedChapters: 1,
        observedCalls: 1,
        resultArtifactRefs: [artifactRef],
        resultArtifactHashes: { [artifactRef]: hash },
      },
    });

    assert.deepEqual(verifyCanaryResultArtifacts(workspacePath, trace), { ok: true });

    // 篡改 trace 内容 → hash 不匹配 → 拒绝
    const tamperedDoc = { ...traceDoc, chapterId: "tampered" };
    writeFileSync(artifactPath, JSON.stringify(tamperedDoc, null, 2) + "\n", "utf-8");
    const tampered = verifyCanaryResultArtifacts(workspacePath, trace);
    assert.equal(tampered.ok, false);
    assert.equal(tampered.code, "CANARY_ARTIFACT_MISMATCH");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("R2 completed bounded canary authorizes production", () => {
  assert.deepEqual(evaluate(), {
    ok: true,
    evidenceRunId: "canary-rel-001-completed",
  });
});

test("R3 requires completed shadow evidence", () => {
  const trace = makeTrace({
    strategy: "shadow_required",
    evidence: {
      ...makeTrace().evidence,
      changeClass: "R3",
      authorizationId: undefined,
    },
  });
  assert.deepEqual(evaluate({ changeClass: "R3", trace }), {
    ok: true,
    evidenceRunId: "canary-rel-001-completed",
  });
});

test("strategy and change class mismatch are blocked", () => {
  const result = evaluate({
    trace: makeTrace({ strategy: "direct_promote" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "CANARY_POLICY_MISMATCH");
});
