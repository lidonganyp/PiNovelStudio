/**
 * promote / rollback 中间失败必须可补偿，不得留下孤立晋级事件或错位 pointer。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import { createReleasePointerStore } from "../dist-test/v2/governance/release-pointer-store.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";
import { computeEvalFixtureHash } from "../dist-test/v2/core/eval-fixture-contract.js";
import {
  generateMatrixReportFromReplayRuns,
  writeMatrixReport,
} from "../dist-test/v2/core/eval-replay-matrix.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "..", "scripts", "evolution-cli.mjs");
const EXT_ROOT = join(__dirname, "..");

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "evolution-txn-"));
}

function runCli(args, env = {}) {
  try {
    const output = execFileSync("node", [CLI_PATH, ...args], {
      cwd: EXT_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf-8",
      timeout: 30000,
    });
    return { code: 0, stdout: output, stderr: "" };
  } catch (e) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

function makeManifest(releaseId, status, opts = {}) {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status,
    parentReleaseId: opts.parentReleaseId ?? "rel-000",
    rollbackReleaseId: opts.rollbackReleaseId ?? "rel-000",
    supersedesRef: null,
    changeClass: opts.changeClass ?? "R1",
    claims: ["test-claim"],
    environmentFingerprint: "fp-test-hash",
    artifactRefs: [],
    approvalRef: opts.approvalRef ?? "apr-001",
    createdAt: "2026-07-16T00:00:00.000Z",
    activatedAt: status === "active_prod" ? "2026-07-16T00:00:00.000Z" : null,
    bundleId: opts.bundleId ?? "bundle-g5-001",
    modelVersion: "gemini-3.1-pro",
    promptBundleHash: "0123456789abcdef",
    modelRoutingHash: "0123456789abcdef",
    toolSchemaHash: "0123456789abcdef",
    contextCompilerHash: "0123456789abcdef",
    qualityPolicyHash: "0123456789abcdef",
    recoveryPolicyHash: "0123456789abcdef",
    knowledgeSnapshotHash: "0123456789abcdef",
    runtimeFingerprint: "rf-test",
    evalProtocolVersion: "pinovel.eval-protocol/1",
  };
}

function writeMatchingStateEvent(registry, releaseId, status) {
  if (status === "draft") return;
  const fromByTo = {
    candidate: "draft",
    frozen: "candidate",
    evaluated: "frozen",
    approved_dev: "evaluated",
    active_dev: "approved_dev",
    candidate_prod: "active_dev",
    active_prod: "candidate_prod",
    held: "active_prod",
    rejected: "evaluated",
    quarantined: "evaluated",
    revoked: "active_dev",
    retired: "active_prod",
  };
  registry.recordStateEvent({
    eventId: `evt-${releaseId}-${status}`,
    releaseId,
    fromStatus: fromByTo[status] ?? "draft",
    toStatus: status,
    reason: `test fixture arrived at ${status}`,
    actor: "system",
    timestamp: "2026-07-16T00:00:00.000Z",
  });
}

function setupReleases(root, manifests) {
  const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
  for (const m of manifests) {
    registry.writeManifest(m);
    writeMatchingStateEvent(registry, m.releaseId, m.status);
  }
  return registry;
}

function writeStubApproval(root, releaseId, approvalId, manifest) {
  const registry = createProxyApprovalRegistry({
    approvalsDir: join(root, "releases", releaseId, "approvals"),
  });
  registry.writeArtifact({
    schemaId: "pinovel.release-proxy-approval",
    schemaVersion: 1,
    approvalId,
    releaseId,
    releaseManifestHash: computeReleasePayloadHash(manifest),
    reviewerType: "validated_human_proxy",
    reviewerModel: "gpt5.6-sol",
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    reviewTransport: "network",
    promptHash: "stub-prompt-hash",
    inputArtifactHash: "stub-input-hash",
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
    finalVerdict: "APPROVE_DEV",
    winningSpans: [],
    losingSpans: [],
    risks: [],
    rationale: "stub approval for test",
    decidedAt: "2026-07-17T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 300000 },
    changeClass: "R1",
    r3SelfApproval: false,
  });
}

function g5PipelineTrace(kind, releaseId, bundleId, approvalRef) {
  const releaseGovernance = {
    devMode: false,
    releaseId,
    environmentFingerprint: "fp-test-hash",
    approvalRef,
    behaviorIdentity: { bundleId, modelVersion: "gemini31" },
  };
  if (kind === "independent_raw") {
    return {
      schemaId: "pinovel.independent-raw-quality-trace",
      matrixArm: "raw_direct",
      evalMode: "B0",
      createdAt: "2026-08-16T00:00:30.000Z",
      gates: [{
        stage: "v2_final_selected",
        evidence: {
          modelCalls: [{
            requestedRoute: "v2_rawstage2_gemini31",
            actualProvider: "gemini31",
            actualModel: "gemini-3.1-pro",
            kind: "raw_direct",
            tokenUsage: { in: 1600, out: 2600 },
          }],
        },
      }],
      recoveryAttempts: [],
    };
  }
  if (kind === "unified_full") {
    return {
      createdAt: "2026-08-16T00:00:30.000Z",
      buildInfo: { gitHash: "deadbeefcafebabe0123456789abcdef01234567" },
      gates: [{
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
          releaseGovernance,
        },
      }],
      recoveryAttempts: [],
    };
  }
  return { stageResults: [], recoveryAttempts: [] };
}

function makeEvalRunRoot(runRoot, releaseId, bundleId, opts = {}) {
  const fixtureIdBase = opts.fixtureId ?? "fixture.txn-001";
  const sampleCount = opts.sampleCount ?? 1;
  const pipelineKind = opts.pipelineKind ?? null;
  const replayMode = opts.replayMode ?? "stub";
  const modelCalls = pipelineKind === "independent_raw" ? 1 : pipelineKind === "unified_full" ? 2 : 0;
  const samples = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const fixtureId = sampleCount === 1 ? fixtureIdBase : `${fixtureIdBase}.${i + 1}`;
    const tracesDir = join(runRoot, "samples", fixtureId, "traces");
    mkdirSync(tracesDir, { recursive: true });
    const fixture = {
      schemaId: "pinovel.eval-fixture",
      schemaVersion: 1,
      fixtureId,
      evalProtocolVersion: "pinovel.eval-protocol/1",
      evalOnly: true,
      replayMode,
      ...(pipelineKind === "independent_raw" ? { matrixArm: "raw_direct" } : {}),
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
      workspace: { sourceWorkspaceId: "ws-src", config: {}, characterProfiles: {}, historicalChapters: [] },
      chapterSeed: { chapterNumber: 1, chapterId: "chapter-001", chapterTitle: "第一章", intent: {}, seedSource: "test" },
      priorNarrativeState: null,
      modelPolicy: { requestTimeoutMs: 60000, totalTimeoutMs: 600000, maxModelCalls: 40, maxRecoveryModelCalls: 4 },
      expectedInvariants: {
        statePollutionForbidden: true,
        productionPointerMutationForbidden: true,
        formalChapterSaveForbidden: true,
        traceArchiveRequired: true,
        scratchNarrativeStateCommitAllowed: true,
      },
      traceArchivePath: "traces/chapter-001-quality-trace.json",
    };
    writeFileSync(join(runRoot, "samples", fixtureId, "fixture.json"), JSON.stringify(fixture, null, 2));
    writeFileSync(
      join(tracesDir, "chapter-001-quality-trace.json"),
      JSON.stringify(g5PipelineTrace(pipelineKind, releaseId, bundleId, opts.approvalRef ?? "apr-001")),
    );
    writeFileSync(join(runRoot, "samples", fixtureId, "state-projection.json"), JSON.stringify({ narrativeStateHash: "a".repeat(64) }));
    if (pipelineKind === "independent_raw") {
      writeFileSync(join(runRoot, "samples", fixtureId, "invocation.json"), JSON.stringify({
        command: { args: ["--eval-layer=B0"] },
        transportEvidence: { transport: null, forceStub: false, evalOnly: true, mockAgent: false, evalLayer: "B0" },
        result: { exitCode: 0 },
      }));
    } else if (replayMode === "production_like") {
      writeFileSync(join(runRoot, "samples", fixtureId, "invocation.json"), JSON.stringify({
        command: { args: ["--project-root=scratch"] },
        transportEvidence: { transport: null, forceStub: false, evalOnly: true, mockAgent: false, evalLayer: null },
        result: { exitCode: 0 },
      }));
    }
    samples.push({
      fixtureId,
      fixtureHash: computeEvalFixtureHash(fixture),
      replayMode,
      scratchWorkspaceId: `eval-txn-${i + 1}`,
      status: "completed",
      failureAttribution: null,
      failureEnvelopes: [],
      traceArchived: true,
      traceArchivePath: tracesDir,
      isolationViolations: [],
      modelCalls,
      durationMs: 500 + i,
    });
  }
  writeFileSync(join(runRoot, "manifest.json"), JSON.stringify({
    schemaId: "pinovel.eval-replay-run-manifest",
    schemaVersion: 1,
    runId: opts.runId ?? "run-txn-001",
    evalProtocolVersion: "pinovel.eval-protocol/1",
    replayMode,
    releaseId,
    bundleId,
    runRoot,
    startedAt: "2026-08-16T00:00:00.000Z",
    finishedAt: "2026-08-16T00:01:00.000Z",
    samples,
    summary: {
      totalSamples: sampleCount,
      countedSamples: sampleCount,
      completed: sampleCount,
      failed: 0,
      skipped: 0,
      traceRetentionRate: 1,
      isolationViolationCount: 0,
    },
  }, null, 2));
  return runRoot;
}

function writePassingEvalEvidence(root, releaseId) {
  const bundleId = "bundle-g5-001";
  const evalRunRoot = join(root, `eval-evidence-${releaseId}`);
  makeEvalRunRoot(evalRunRoot, releaseId, bundleId);
  const armKinds = {
    baseline: "unified_full",
    candidate: "unified_full",
    raw_direct: "independent_raw",
    recovery: "synthetic_recovery",
  };
  const armRunRoots = {};
  for (const [armId, kind] of Object.entries(armKinds)) {
    armRunRoots[armId] = makeEvalRunRoot(join(evalRunRoot, "arms", armId), releaseId, bundleId, {
      fixtureId: `fixture.${armId}`,
      sampleCount: 3,
      runId: `run-${armId}`,
      pipelineKind: kind,
      replayMode: armId === "recovery" ? "synthetic" : "production_like",
    });
  }
  writeMatrixReport(evalRunRoot, generateMatrixReportFromReplayRuns({
    candidateReleaseId: releaseId,
    candidateBundleId: bundleId,
    baselineReleaseId: releaseId,
    armRunRoots,
    codeCommit: "deadbeefcafebabe0123456789abcdef01234567",
  }));
  return ["--eval-evidence-root", evalRunRoot];
}

function readStateEvents(root, releaseId) {
  const path = join(root, "releases", releaseId, "state-events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const ADMISSION_REPLAY_SAMPLE_IDS = [
  "timeout",
  "retry",
  "factguard-block",
  "atomic-rollback",
  "state-commit-fail",
];

// 生成合法 production-admission-replay.json（reportHash 覆盖 reportBody，与脚本一致）。
function makeAdmissionReport(root, releaseId) {
  const reportBody = {
    generatedAt: "2026-08-18T00:00:00.000Z",
    real: true,
    productionComplete: true,
    releaseId,
    sourceRoot: root,
    harnessHash: "a".repeat(64),
    samples: ADMISSION_REPLAY_SAMPLE_IDS.map((id) => ({
      id,
      scenario: `scenario ${id}`,
      transport: "stub",
      passed: true,
      detail: "ok",
      releaseGovernance: { devMode: false, releaseId },
    })),
    traceHashes: {},
    traceRetention: 1,
  };
  const reportHash = createHash("sha256").update(JSON.stringify(reportBody)).digest("hex");
  const path = join(root, "admission-replay.json");
  writeFileSync(path, JSON.stringify({ ...reportBody, reportHash }, null, 2));
  return path;
}

function admissionArgs(root, releaseId) {
  return ["--admission-replay", makeAdmissionReport(root, releaseId)];
}

test("promote: pointer 切换失败不得留下 active_prod 晋级事件", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "candidate_prod", { approvalRef: "apr-001" });
    setupReleases(root, [m1]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    const evalArgs = writePassingEvalEvidence(root, "rel-001");
    mkdirSync(join(root, "active-production.json.tmp"));

    const result = runCli(
      ["promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod", ...evalArgs, ...admissionArgs(root, "rel-001")],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5, result.stderr);
    const events = readStateEvents(root, "rel-001");
    assert.equal(
      events.some((e) => e.toStatus === "active_prod" && String(e.eventId).includes("promote")),
      false,
      `不应留下孤立晋级事件：${JSON.stringify(events)}`,
    );
    assert.equal(createReleasePointerStore({ configDir: root }).readActive("production"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: manifest 转移失败（单例冲突）不得残留孤立 active_prod 晋级事件", () => {
  const root = makeTempRoot();
  try {
    // rel-100 已是 active_prod 且 pointer 指向它；rel-001 晋级 active_prod 触发单例冲突
    const m100 = makeManifest("rel-100", "active_prod", { approvalRef: "apr-100" });
    const m1 = makeManifest("rel-001", "candidate_prod", { approvalRef: "apr-001" });
    setupReleases(root, [m100, m1]);
    writeStubApproval(root, "rel-100", "apr-100", m100);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    const store = createReleasePointerStore({ configDir: root });
    store.switchActive("production", "rel-100", { actor: "user", reason: "init" });
    const evalArgs = writePassingEvalEvidence(root, "rel-001");

    // pointer 切换成功 → transitionStatus 因 active_prod 单例约束失败 → 应回滚 pointer 且无事件
    const result = runCli(
      ["promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod", ...evalArgs, ...admissionArgs(root, "rel-001")],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5, result.stderr);
    assert.equal(
      createReleasePointerStore({ configDir: root }).readActive("production").releaseId,
      "rel-100",
      "manifest 转移失败后 pointer 必须回滚到原 release",
    );
    const events = readStateEvents(root, "rel-001");
    assert.equal(
      events.some((e) => e.toStatus === "active_prod" && String(e.eventId).includes("promote")),
      false,
      `manifest 转移失败不应残留孤立晋级事件：${JSON.stringify(events)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: --admission-replay 报告 releaseId 不匹配必须 fail-closed 且不晋级", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "candidate_prod", { approvalRef: "apr-001" });
    setupReleases(root, [m1]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    const evalArgs = writePassingEvalEvidence(root, "rel-001");
    const admissionPath = makeAdmissionReport(root, "rel-wrong");

    const result = runCli(
      [
        "promote",
        "--release-id",
        "rel-001",
        "--target",
        "active_prod",
        "--confirm-prod",
        ...evalArgs,
        "--admission-replay",
        admissionPath,
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5, result.stderr);
    assert.match(result.stderr, /ADMISSION_REPLAY_RELEASE_MISMATCH/);
    assert.equal(
      createReleasePointerStore({ configDir: root }).readActive("production"),
      null,
      "admission 校验失败不得切换 pointer",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: --admission-replay 报告校验通过后晋级成功并绑定 evidenceRef", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "candidate_prod", { approvalRef: "apr-001" });
    setupReleases(root, [m1]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    const evalArgs = writePassingEvalEvidence(root, "rel-001");
    const admissionPath = makeAdmissionReport(root, "rel-001");

    const result = runCli(
      [
        "promote",
        "--release-id",
        "rel-001",
        "--target",
        "active_prod",
        "--confirm-prod",
        ...evalArgs,
        "--admission-replay",
        admissionPath,
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /admission replay evidence: admission replay 报告校验通过（releaseId=rel-001，5\/5 场景通过）/);
    assert.equal(
      createReleasePointerStore({ configDir: root }).readActive("production").releaseId,
      "rel-001",
    );
    const events = readStateEvents(root, "rel-001");
    const promoteEvent = events.find((e) => e.toStatus === "active_prod");
    assert.ok(promoteEvent, "应有 active_prod 晋级事件");
    assert.ok(
      (promoteEvent.evidenceRefs ?? []).some((ref) => ref.startsWith("admission-replay:")),
      `晋级事件应绑定 admission-replay evidenceRef：${JSON.stringify(promoteEvent.evidenceRefs)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback: 指定目标 restore 失败必须把 pointer 补偿回原 release", () => {
  const root = makeTempRoot();
  try {
    const m0 = makeManifest("rel-100", "held", { approvalRef: "apr-100" });
    const m1 = makeManifest("rel-101", "active_prod", {
      approvalRef: "apr-101",
      parentReleaseId: "rel-100",
      rollbackReleaseId: "rel-100",
    });
    setupReleases(root, [m0, m1]);
    writeStubApproval(root, "rel-100", "apr-100", m0);
    writeStubApproval(root, "rel-101", "apr-101", m1);
    const store = createReleasePointerStore({ configDir: root });
    store.switchActive("production", "rel-100", { actor: "user", reason: "init" });
    store.switchActive("production", "rel-101", { actor: "user", reason: "promote" });
    mkdirSync(join(root, "releases", "rel-100", "manifest.json.tmp"));

    const result = runCli(
      ["rollback", "--kind", "production", "--actor", "user", "--reason", "txn-test"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5, result.stderr);
    assert.equal(
      store.readActive("production").releaseId,
      "rel-101",
      "restore 失败后 pointer 必须回到 rollback 前的 release",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
