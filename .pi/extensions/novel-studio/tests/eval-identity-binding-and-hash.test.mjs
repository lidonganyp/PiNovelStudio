/**
 * 生产身份绑定与 trace hash 对账
 *
 * - raw_direct / independent_raw 不得因缺少 candidate 生产身份被拒
 * - candidate 仍必须从底层 quality-trace 复算完整身份
 * - 已声明的 referenceTraceHash 必须与归档 trace 重算结果一致
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { gradeDeterministic } from "../dist-test/v2/core/eval-deterministic-grader.js";
import { computeEvalFixtureHash } from "../dist-test/v2/core/eval-fixture-contract.js";
import {
  evaluateEvalEvidenceGate,
  gradeBoundMatrixArms,
  buildExpectedTraceIdentity,
} from "../dist-test/v2/governance/eval-evidence-gate.js";
import {
  generateMatrixReportFromReplayRuns,
  writeMatrixReport,
} from "../dist-test/v2/core/eval-replay-matrix.js";

function sha256(content) {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "eval-identity-"));
}

function baseFixture(fixtureId, releaseId, bundleId, extras = {}) {
  return {
    schemaId: "pinovel.eval-fixture",
    schemaVersion: 1,
    fixtureId,
    evalProtocolVersion: "pinovel.eval-protocol/1",
    evalOnly: true,
    replayMode: extras.replayMode ?? "production_like",
    ...(extras.matrixArm ? { matrixArm: extras.matrixArm } : {}),
    createdAt: "2026-08-16T00:00:00.000Z",
    provenance: {
      releaseId,
      bundleId,
      promptBundleHash: "0123456789abcdef",
      toolSchemaHash: "0123456789abcdef",
      contextCompilerHash: "0123456789abcdef",
      budgetHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      modelVersion: "gemini-3.1-pro",
      modelRoute: "v2_rawstage2_gemini31",
      provider: "gemini",
      graderVersion: "deterministic-v1",
    },
    workspace: {
      sourceWorkspaceId: "ws-src",
      config: {},
      characterProfiles: {},
      historicalChapters: [],
    },
    chapterSeed: {
      chapterNumber: 1,
      chapterId: "chapter-001",
      chapterTitle: "第一章",
      intent: {},
      seedSource: "test",
    },
    priorNarrativeState: null,
    modelPolicy: {
      requestTimeoutMs: 60000,
      totalTimeoutMs: 600000,
      maxModelCalls: 40,
      maxRecoveryModelCalls: 4,
    },
    expectedInvariants: {
      statePollutionForbidden: true,
      productionPointerMutationForbidden: true,
      formalChapterSaveForbidden: true,
      traceArchiveRequired: true,
      scratchNarrativeStateCommitAllowed: true,
    },
    traceArchivePath: "traces/chapter-001-quality-trace.json",
    ...(extras.referenceTraceHash ? { referenceTraceHash: extras.referenceTraceHash } : {}),
  };
}

function writeSample(runRoot, fixture, trace, modelCalls) {
  const sampleDir = join(runRoot, "samples", fixture.fixtureId);
  const tracesDir = join(sampleDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const tracePath = join(tracesDir, "chapter-001-quality-trace.json");
  const traceText = `${JSON.stringify(trace)}\n`;
  writeFileSync(tracePath, traceText);
  if (!fixture.referenceTraceHash) {
    fixture.referenceTraceHash = sha256(traceText);
  }
  writeFileSync(join(sampleDir, "fixture.json"), JSON.stringify(fixture, null, 2));
  writeFileSync(
    join(sampleDir, "state-projection.json"),
    JSON.stringify({ narrativeStateHash: "a".repeat(64) }),
  );
  writeFileSync(
    join(sampleDir, "invocation.json"),
    JSON.stringify({
      command: {
        args: fixture.matrixArm === "raw_direct"
          ? ["--project-root=scratch", "--eval-layer=B0"]
          : ["--project-root=scratch"],
      },
      transportEvidence: {
        transport: null,
        forceStub: false,
        evalOnly: true,
        mockAgent: false,
        evalLayer: fixture.matrixArm === "raw_direct" ? "B0" : null,
      },
      result: { exitCode: 0 },
    }),
  );
  return {
    fixtureId: fixture.fixtureId,
    fixtureHash: computeEvalFixtureHash(fixture),
    replayMode: fixture.replayMode,
    scratchWorkspaceId: `eval-${fixture.fixtureId}`,
    status: "completed",
    failureAttribution: null,
    failureEnvelopes: [],
    traceArchived: true,
    traceArchivePath: tracesDir,
    isolationViolations: [],
    modelCalls,
    durationMs: 500,
  };
}

function writeRun(runRoot, releaseId, bundleId, samples, replayMode = "production_like") {
  writeFileSync(
    join(runRoot, "manifest.json"),
    JSON.stringify({
      schemaId: "pinovel.eval-replay-run-manifest",
      schemaVersion: 1,
      runId: `run-${releaseId}`,
      evalProtocolVersion: "pinovel.eval-protocol/1",
      replayMode,
      releaseId,
      bundleId,
      runRoot,
      startedAt: "2026-08-16T00:00:00.000Z",
      finishedAt: "2026-08-16T00:01:00.000Z",
      samples,
      summary: {
        totalSamples: samples.length,
        countedSamples: samples.length,
        completed: samples.length,
        failed: 0,
        skipped: 0,
        traceRetentionRate: 1,
        isolationViolationCount: 0,
      },
    }, null, 2),
  );
}

function rawDirectTrace() {
  return {
    schemaId: "pinovel.independent-raw-quality-trace",
    matrixArm: "raw_direct",
    evalMode: "B0",
    gates: [
      {
        stage: "v2_final_selected",
        evidence: {
          modelCalls: [
            {
              requestedRoute: "v2_rawstage2_gemini31",
              actualProvider: "gemini31",
              actualModel: "gemini-3.1-pro",
              kind: "raw_direct",
              tokenUsage: { in: 1600, out: 2600 },
            },
          ],
        },
      },
    ],
    recoveryAttempts: [],
  };
}

function candidateTrace(identity) {
  return {
    createdAt: "2026-08-16T00:00:30.000Z",
    buildInfo: { gitHash: identity.gitHash ?? "deadbeefcafebabe0123456789abcdef01234567" },
    gates: [
      {
        stage: "v2_final_selected",
        evidence: {
          modelCalls: [
            {
              requestedRoute: "v2_rawstage2_gemini31",
              actualProvider: "gemini31",
              actualModel: "gemini-3.1-pro",
              kind: "agentic_raw",
              tokenUsage: { in: 1600, out: 2600 },
            },
            {
              requestedRoute: "v2_amplified_gemini31",
              actualProvider: "gemini31",
              actualModel: "gemini-3.1-pro",
              kind: "author_style_optimization",
              tokenUsage: { in: 1700, out: 4700 },
            },
          ],
          releaseGovernance: {
            devMode: false,
            releaseId: identity.releaseId,
            environmentFingerprint: identity.environmentFingerprint,
            approvalRef: identity.approvalRef,
            behaviorIdentity: {
              bundleId: identity.bundleId,
              modelVersion: "gemini31",
            },
          },
        },
      },
    ],
    recoveryAttempts: [],
  };
}

test("raw_direct 无生产身份仍通过 identity binding；candidate 缺身份失败", () => {
  const root = makeTempRoot();
  try {
    const releaseId = "rel-id-001";
    const bundleId = "bundle-id-001";
    const rawRoot = join(root, "raw");
    const candRoot = join(root, "cand");
    const rawFixture = baseFixture("fixture.raw", releaseId, bundleId, { matrixArm: "raw_direct" });
    const rawSample = writeSample(rawRoot, rawFixture, rawDirectTrace(), 1);
    writeRun(rawRoot, releaseId, bundleId, [rawSample]);

    const rawReport = gradeDeterministic(
      JSON.parse(readFileSync(join(rawRoot, "manifest.json"), "utf-8")),
      rawRoot,
      { releaseId, bundleId, environmentFingerprint: "fp-x", approvalRef: "apr-x" },
    );
    assert.equal(rawReport.passed, true, rawReport.failedChecks.join(","));
    const rawIdentity = rawReport.checks.find((c) => c.name === "trace_identity_binding");
    assert.equal(rawIdentity.passed, true, JSON.stringify(rawIdentity.violations));

    const candFixture = baseFixture("fixture.cand", releaseId, bundleId);
    const candSample = writeSample(candRoot, candFixture, rawDirectTrace(), 1);
    writeRun(candRoot, releaseId, bundleId, [candSample]);
    const candReport = gradeDeterministic(
      JSON.parse(readFileSync(join(candRoot, "manifest.json"), "utf-8")),
      candRoot,
      { releaseId, bundleId, environmentFingerprint: "fp-x", approvalRef: "apr-x" },
    );
    assert.equal(candReport.passed, false);
    assert.ok(candReport.failedChecks.includes("trace_identity_binding"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("referenceTraceHash 与归档不一致 → trace_identity_binding 失败", () => {
  const root = makeTempRoot();
  try {
    const releaseId = "rel-hash-001";
    const bundleId = "bundle-hash-001";
    const runRoot = join(root, "cand");
    const identity = {
      releaseId,
      bundleId,
      environmentFingerprint: "fp-hash",
      approvalRef: "apr-hash",
      gitHash: "deadbeefcafebabe0123456789abcdef01234567",
    };
    const fixture = baseFixture("fixture.hash", releaseId, bundleId, {
      referenceTraceHash: "b".repeat(64),
    });
    const sample = writeSample(runRoot, fixture, candidateTrace(identity), 2);
    writeRun(runRoot, releaseId, bundleId, [sample]);
    const report = gradeDeterministic(
      JSON.parse(readFileSync(join(runRoot, "manifest.json"), "utf-8")),
      runRoot,
      identity,
    );
    assert.equal(report.passed, false);
    const identityCheck = report.checks.find((c) => c.name === "trace_identity_binding");
    assert.match(identityCheck.violations.map((v) => v.detail).join("\n"), /referenceTraceHash|hash/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw_direct 无身份四臂 gate 在完整身份绑定下仍可 approved", () => {
  const root = makeTempRoot();
  try {
    const releaseId = "rel-arm-raw";
    const bundleId = "bundle-arm-raw";
    const evalRunRoot = join(root, "eval");
    const identity = {
      releaseId,
      bundleId,
      environmentFingerprint: "fp-test-hash",
      approvalRef: "apr-p6",
      createdAt: "2026-07-16T00:00:00.000Z",
    };
    const armKinds = {
      baseline: "candidate",
      candidate: "candidate",
      raw_direct: "raw",
      recovery: "recovery",
    };
    const armRunRoots = {};
    for (const [armId, kind] of Object.entries(armKinds)) {
      const runRoot = armId === "candidate" ? evalRunRoot : join(evalRunRoot, "arms", armId);
      const samples = [];
      for (let i = 1; i <= 3; i += 1) {
        const fixture = baseFixture(`fixture.${armId}.${i}`, releaseId, bundleId, {
          matrixArm: armId === "raw_direct" ? "raw_direct" : undefined,
          replayMode: armId === "recovery" ? "synthetic" : "production_like",
        });
        const trace = kind === "raw"
          ? rawDirectTrace()
          : kind === "recovery"
            ? { stageResults: [], recoveryAttempts: [] }
            : candidateTrace(identity);
        const calls = kind === "raw" ? 1 : kind === "recovery" ? 0 : 2;
        samples.push(writeSample(runRoot, fixture, trace, calls));
      }
      writeRun(
        runRoot,
        releaseId,
        bundleId,
        samples,
        armId === "recovery" ? "synthetic" : "production_like",
      );
      armRunRoots[armId] = runRoot;
    }
    const matrix = generateMatrixReportFromReplayRuns({
      candidateReleaseId: releaseId,
      candidateBundleId: bundleId,
      baselineReleaseId: releaseId,
      armRunRoots,
      codeCommit: "deadbeefcafebabe0123456789abcdef01234567",
    });
    writeMatrixReport(evalRunRoot, matrix);

    const armGrades = gradeBoundMatrixArms(matrix, identity);
    assert.equal(armGrades.ok, true, armGrades.failures.join("；"));

    const gate = evaluateEvalEvidenceGate({
      releaseId,
      bundleId,
      changeClass: "R1",
      evalRunRoot,
      expectedTraceIdentity: identity,
    });
    assert.equal(gate.verdict, "approved", gate.reason);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildExpectedTraceIdentity 绑定 fingerprint/approvalRef/gitHash/createdAt", () => {
  const identity = buildExpectedTraceIdentity({
    releaseId: "rel-prod-134",
    bundleId: "bundle-134",
    environmentFingerprint: "fp-134",
    approvalRef: "apr-134",
    createdAt: "2026-08-18T02:29:04.508Z",
  }, { gitHash: "d238c7cd82475ef5b6775f778f7de97adde938d4" });
  assert.equal(identity.releaseId, "rel-prod-134");
  assert.equal(identity.bundleId, "bundle-134");
  assert.equal(identity.environmentFingerprint, "fp-134");
  assert.equal(identity.approvalRef, "apr-134");
  assert.equal(identity.gitHash, "d238c7cd82475ef5b6775f778f7de97adde938d4");
  assert.equal(identity.createdAt, "2026-08-18T02:29:04.508Z");
});
