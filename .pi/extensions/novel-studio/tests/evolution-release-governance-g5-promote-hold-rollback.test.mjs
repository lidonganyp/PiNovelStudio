/**
 * EVOLUTION-RELEASE-GOVERNANCE-G5 CLI 测试 — promote / hold / rollback 子命令
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §G5（line 380-395）
 *
 * G5 CLI 子命令：
 *   evolution:promote --release-id <id> [--target active_dev|candidate_prod|active_prod]
 *                   [--actor system|user] [--reason <text>]
 *     - approved_dev → active_dev（默认 target，切 dev pointer）
 *     - active_dev → candidate_prod（不切 pointer）
 *     - candidate_prod → active_prod（切 prod pointer，强制 actor=user）
 *     - APPROVAL_REQUIRED 守护：approvalRef 必须非空
 *     - PRODUCTION_PROMOTION 守护：target ∈ {candidate_prod, active_prod} 时 actor 必须 user
 *   evolution:hold --release-id <id> [--actor system|user] [--reason <text>]
 *     - active_dev/candidate_prod/active_prod → held（不切 pointer）
 *   evolution:rollback [--kind development|production] [--actor user] [--reason <text>]
 *     - 回滚 active pointer 到前序 release（基于 switchHistory）
 *     - 同时标记当前 release 为 held（不删除失败版本和负面证据）
 *     - 无 history 或无 switch 前状态 → 退出码 5
 *
 * bounded canary（§G5 "晋级后先 shadow，再按风险等级进入 bounded canary"）推迟 P1，
 * 本测试不覆盖 canary 阶段；promote 直接全量切换指针。
 *
 * 验收边界：
 * - 复用 transitionStatus / switchActive / rollback 底层 API，不修改 governance 模块
 * - 不调用模型（READY_LOCAL）
 * - 退出码：0 成功 / 2 参数错误 / 3 release 不存在 / 4 状态不合法 / 5 操作失败
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

// ============================================================================
// helpers
// ============================================================================

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "..", "scripts", "evolution-cli.mjs");
const EXT_ROOT = join(__dirname, "..");

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "evolution-cli-g5-"));
}

/**
 * 构造 manifest fixture。
 * approvalRef 默认 null；对 APPROVAL_REQUIRED 状态（approved_dev/active_dev/candidate_prod/active_prod）
 * 调用方应显式传 approvalRef。
 */
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
    claims: opts.claims ?? ["test-claim"],
    environmentFingerprint: "fp-test-hash",
    artifactRefs: [],
    approvalRef: opts.approvalRef ?? null,
    createdAt: "2026-07-16T00:00:00.000Z",
    activatedAt: null,
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
    held: "active_dev",
    rejected: "evaluated",
    quarantined: "evaluated",
    revoked: "active_dev",
    retired: "active_prod",
  };
  const fromStatus = fromByTo[status];
  if (!fromStatus) {
    throw new Error(`writeMatchingStateEvent: 未覆盖的 status=${status}`);
  }
  registry.recordStateEvent({
    eventId: `evt-${releaseId}-${status}`,
    releaseId,
    fromStatus,
    toStatus: status,
    reason: `test fixture arrived at ${status}`,
    actor: "system",
    timestamp: "2026-07-16T00:00:00.000Z",
  });
}

function setupReleases(root, manifests) {
  const releasesDir = join(root, "releases");
  const registry = createEvolutionReleaseRegistry({ releasesDir });
  for (const m of manifests) {
    registry.writeManifest(m);
    writeMatchingStateEvent(registry, m.releaseId, m.status);
  }
  return registry;
}

function makeStore(root) {
  return createReleasePointerStore({ configDir: root });
}

function makeRegistry(root) {
  return createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
}

function makeEvalRunRoot(runRoot, releaseId, bundleId, opts = {}) {
  const fixtureIdBase = opts.fixtureId ?? "fixture.g5-001";
  const sampleCount = opts.sampleCount ?? 1;
  const runId = opts.runId ?? "run-g5-001";
  const samples = [];

  for (let i = 0; i < sampleCount; i += 1) {
    const fixtureId = sampleCount === 1 ? fixtureIdBase : `${fixtureIdBase}.${i + 1}`;
    const sampleDir = join(runRoot, "samples", fixtureId);
    const tracesDir = join(sampleDir, "traces");
    mkdirSync(tracesDir, { recursive: true });
    const fixture = {
      schemaId: "pinovel.eval-fixture",
      schemaVersion: 1,
      fixtureId,
      evalProtocolVersion: "pinovel.eval-protocol/1",
      evalOnly: true,
      replayMode: "stub",
      createdAt: "2026-08-16T00:00:00.000Z",
      provenance: {
        releaseId,
        bundleId,
        promptBundleHash: "0123456789abcdef",
        toolSchemaHash: "0123456789abcdef",
        contextCompilerHash: "0123456789abcdef",
        budgetHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        modelVersion: "gemini-3.1-pro-preview",
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
    };
    writeFileSync(join(sampleDir, "fixture.json"), JSON.stringify(fixture, null, 2));
    writeFileSync(
      join(tracesDir, "chapter-001-quality-trace.json"),
      JSON.stringify({ stageResults: [], recoveryAttempts: [] }),
    );
    writeFileSync(
      join(sampleDir, "state-projection.json"),
      JSON.stringify({ narrativeStateHash: "a".repeat(64) }),
    );
    samples.push({
      fixtureId,
      fixtureHash: computeEvalFixtureHash(fixture),
      replayMode: "stub",
      scratchWorkspaceId: `eval-stub-g5-${i + 1}`,
      status: "completed",
      failureAttribution: null,
      failureEnvelopes: [],
      traceArchived: true,
      traceArchivePath: tracesDir,
      isolationViolations: [],
      modelCalls: 0,
      durationMs: 500 + i,
    });
  }

  writeFileSync(
    join(runRoot, "manifest.json"),
    JSON.stringify({
      schemaId: "pinovel.eval-replay-run-manifest",
      schemaVersion: 1,
      runId,
      evalProtocolVersion: "pinovel.eval-protocol/1",
      replayMode: "stub",
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
    }, null, 2),
  );
  return runRoot;
}

function writePassingEvalEvidence(root, releaseId, changeClass = "R1") {
  const bundleId = "bundle-g5-001";
  const evalRunRoot = join(root, `eval-evidence-${releaseId}`);
  makeEvalRunRoot(evalRunRoot, releaseId, bundleId);
  if (changeClass === "R2" || changeClass === "R3") {
    const armIds = ["baseline", "candidate", "raw_direct", "recovery"];
    const armRunRoots = {};
    for (const armId of armIds) {
      armRunRoots[armId] = makeEvalRunRoot(join(evalRunRoot, "arms", armId), releaseId, bundleId, {
        fixtureId: `fixture.${armId}`,
        sampleCount: 3,
        runId: `run-${armId}`,
      });
    }
    writeMatrixReport(
      evalRunRoot,
      generateMatrixReportFromReplayRuns({
        candidateReleaseId: releaseId,
        candidateBundleId: bundleId,
        baselineReleaseId: releaseId,
        armRunRoots,
        codeCommit: "deadbeefcafebabe0123456789abcdef01234567",
      }),
    );
  }
  return ["--eval-evidence-root", evalRunRoot];
}

function runCli(args, env = {}) {
  const fullEnv = { ...process.env, ...env };
  try {
    const output = execFileSync("node", [CLI_PATH, ...args], {
      cwd: EXT_ROOT,
      env: fullEnv,
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

/**
 * 写入真实 stub approval artifact（schema 校验通过）。
 * 默认 finalVerdict=APPROVE_DEV；opts.finalVerdict 可覆盖（如 HOLD）。
 * opts.releaseManifestHash 可覆盖（用于测试 hash 不匹配场景）。
 */
function writeStubApproval(root, releaseId, approvalId, manifest, opts = {}) {
  const approvalsDir = join(root, "releases", releaseId, "approvals");
  const registry = createProxyApprovalRegistry({ approvalsDir });
  const finalVerdict = opts.finalVerdict ?? "APPROVE_DEV";
  const artifact = {
    schemaId: "pinovel.release-proxy-approval",
    schemaVersion: 1,
    approvalId,
    releaseId,
    releaseManifestHash: opts.releaseManifestHash ?? computeReleasePayloadHash(manifest),
    reviewerType: "validated_human_proxy",
    reviewerModel: "gpt5.6-sol",
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    reviewTransport: "network",
    promptHash: "stub-prompt-hash",
    inputArtifactHash: "stub-input-hash",
    forwardVerdict: finalVerdict,
    reverseVerdict: finalVerdict,
    finalVerdict,
    winningSpans: [],
    losingSpans: [],
    risks: [],
    rationale: "stub approval for test",
    decidedAt: "2026-07-17T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 300000 },
    changeClass: manifest.changeClass ?? "R1",
    r3SelfApproval: false,
  };
  registry.writeArtifact(artifact);
  return artifact;
}

function writeCanaryTrace(workspacePath, manifest, overrides = {}) {
  const canaryRunsDir = join(workspacePath, "canary-runs");
  mkdirSync(canaryRunsDir, { recursive: true });
  mkdirSync(join(workspacePath, "traces"), { recursive: true });

  // P0 修复后：artifact 必须是真实 chapter trace（traces/{chapterId}-quality-trace.json），
  // 含 gates[].stage === "v2_final_selected" + evidence.modelCalls 数组，
  // 且 observedChapters/observedCalls 与 trace 内容一致。
  // 写入 5 个 chapter trace，每个含 2 次 modelCalls → observedChapters=5, observedCalls=10。
  const chapterIds = ["1", "2", "3", "4", "5"];
  const resultArtifactRefs = [];
  const resultArtifactHashes = {};
  for (const chapterId of chapterIds) {
    const traceDoc = {
      schemaVersion: 1,
      workspaceId: "ws-test",
      chapterId,
      createdAt: "2026-07-17T00:00:00.000Z",
      events: [],
      patches: [],
      gates: [
        {
          stage: "v2_final_selected",
          status: "PASS",
          passed: true,
          blocked: false,
          score: 1,
          reason: "selected=cand-editorial source=editorial gain=positive",
          issueTypes: [],
          revisionHints: [],
          evidence: {
            stage: "final_selected",
            timestamp: "2026-07-17T00:00:00.000Z",
            finalSelection: {
              selectedCandidateId: "cand-editorial",
              selectedSource: "editorial",
              projectGain: "positive",
            },
            contextHash: "stub-context-hash",
            modelCalls: [
              { route: "v2_rawstage2", kind: "generation", model: "claude-opus-4.6", durationMs: 1500, provider: "claude" },
              { route: "v2_amplified", kind: "generation", model: "claude-opus-4.6", durationMs: 2000, provider: "claude" },
            ],
            // P0 修复（第四轮）：chapter trace 必须含 releaseGovernance 绑定，
            // verifyCanaryResultArtifacts 校验其与目标 release 一致。
            releaseGovernance: {
              releaseId: manifest.releaseId,
              environmentFingerprint: manifest.environmentFingerprint,
              approvalRef: manifest.approvalRef,
              devMode: false,
            },
          },
        },
      ],
    };
    const artifactRef = `traces/${chapterId}-quality-trace.json`;
    const content = JSON.stringify(traceDoc, null, 2) + "\n";
    writeFileSync(join(workspacePath, artifactRef), content, "utf-8");
    resultArtifactRefs.push(artifactRef);
    resultArtifactHashes[artifactRef] = createHash("sha256").update(content, "utf-8").digest("hex");
  }

  const sourceTrace = {
    schemaId: "pinovel.canary-run-trace",
    schemaVersion: 1,
    runId: "canary-rel-001-started",
    releaseId: manifest.releaseId,
    previousReleaseId: manifest.rollbackReleaseId,
    workspaceId: "ws-test",
    startedAt: "2026-07-17T01:00:00.000Z",
    completedAt: null,
    strategy: "bounded_canary",
    status: "canary_started",
    healthSnapshot: {
      status: "healthy",
      alignmentRate: 0.8,
      sampleCount: 5,
      rollbackRate: 0,
      consecutiveNegative: 0,
    },
    evidence: {
      changeClass: manifest.changeClass,
      currentStatus: "candidate_prod",
      authorizationId: "cauth-001",
    },
    outcome: { promoted: false, heldByAutoHold: false },
    shadowPendingRealRun: true,
  };
  writeFileSync(
    join(canaryRunsDir, `${sourceTrace.runId}.json`),
    JSON.stringify(sourceTrace, null, 2) + "\n",
    "utf-8",
  );
  const trace = {
    schemaId: "pinovel.canary-run-trace",
    schemaVersion: 1,
    runId: "canary-rel-001-result",
    releaseId: manifest.releaseId,
    previousReleaseId: manifest.rollbackReleaseId,
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
      changeClass: manifest.changeClass,
      currentStatus: "candidate_prod",
      authorizationId: "cauth-001",
      sourceRunId: sourceTrace.runId,
      environmentFingerprint: manifest.environmentFingerprint,
      approvalRef: manifest.approvalRef,
      verdict: "pass",
      observedChapters: 5,
      observedCalls: 10,
      resultArtifactRefs,
      resultArtifactHashes,
    },
    outcome: { promoted: false, heldByAutoHold: false },
    shadowPendingRealRun: false,
    ...overrides,
  };
  writeFileSync(
    join(canaryRunsDir, `${trace.runId}.json`),
    JSON.stringify(trace, null, 2) + "\n",
    "utf-8",
  );
  return trace;
}

// ============================================================================
// evolution:promote
// ============================================================================

test("promote: approved_dev → active_dev 切换 dev pointer 成功", () => {
  const root = makeTempRoot();
  try {
    const manifestSeed = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" });
    setupReleases(root, [manifestSeed]);
    writeStubApproval(root, "rel-001", "apr-001", manifestSeed);
    const result = runCli(
      ["promote", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /active_dev/);

    // manifest 状态迁移
    const registry = makeRegistry(root);
    const manifest = registry.loadManifest("rel-001");
    assert.equal(manifest.status, "active_dev");
    assert.equal(manifest.approvalRef, "apr-001");

    // dev pointer 切换
    const store = makeStore(root);
    const devPointer = store.readActive("development");
    assert.equal(devPointer?.releaseId, "rel-001");
    assert.equal(devPointer?.actor, "system");

    // prod pointer 未切换
    assert.equal(store.readActive("production"), null);

    // 状态事件
    const events = registry.loadStateEvents("rel-001");
    assert.ok(events.some((e) => e.toStatus === "active_dev"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: 缺 --release-id 退出码 2", () => {
  const root = makeTempRoot();
  try {
    const result = runCli(["promote"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /release-id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: --target 非法值退出码 2", () => {
  const root = makeTempRoot();
  try {
    setupReleases(root, [
      makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" }),
    ]);
    const result = runCli(
      ["promote", "--release-id", "rel-001", "--target", "bogus"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: release 不存在退出码 3", () => {
  const root = makeTempRoot();
  try {
    const result = runCli(
      ["promote", "--release-id", "rel-nonexistent"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 3);
    assert.match(result.stderr, /不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: 当前状态 draft 不允许晋级退出码 4", () => {
  const root = makeTempRoot();
  try {
    setupReleases(root, [makeManifest("rel-001", "draft")]);
    const result = runCli(
      ["promote", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 4);
    assert.match(result.stderr, /draft/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: 当前状态 held 不允许晋级退出码 4", () => {
  const root = makeTempRoot();
  try {
    setupReleases(root, [makeManifest("rel-001", "held")]);
    const result = runCli(
      ["promote", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 4);
    assert.match(result.stderr, /held/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: target=active_dev 但 approvalRef 为空退出码 5", () => {
  const root = makeTempRoot();
  try {
    // schema 允许 approvalRef=null + status=approved_dev；APPROVAL_REQUIRED 守护在 CLI/transitionStatus 层
    setupReleases(root, [makeManifest("rel-001", "approved_dev", { approvalRef: null })]);
    const result = runCli(
      ["promote", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5);
    assert.match(result.stderr, /approvalRef/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: active_dev → candidate_prod 不切指针", () => {
  const root = makeTempRoot();
  try {
    const manifestSeed = makeManifest("rel-001", "active_dev", { approvalRef: "apr-001" });
    setupReleases(root, [manifestSeed]);
    writeStubApproval(root, "rel-001", "apr-001", manifestSeed);
    const result = runCli(
      ["promote", "--release-id", "rel-001", "--target", "candidate_prod", "--confirm-prod", "--actor", "user"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    // manifest 状态迁移
    const registry = makeRegistry(root);
    const manifest = registry.loadManifest("rel-001");
    assert.equal(manifest.status, "candidate_prod");

    // 不切 pointer（candidate_prod 是候选态）
    const store = makeStore(root);
    assert.equal(store.readActive("development"), null);
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: candidate_prod → active_prod 强制 actor=user（默认）切换 prod pointer", () => {
  const root = makeTempRoot();
  try {
    const manifestSeed = makeManifest("rel-001", "candidate_prod", { approvalRef: "apr-001" });
    setupReleases(root, [manifestSeed]);
    writeStubApproval(root, "rel-001", "apr-001", manifestSeed);
    // 不传 --actor，CLI 应默认 user（PRODUCTION_PROMOTION 守护）
    const result = runCli(
      [
        "promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod",
        ...writePassingEvalEvidence(root, "rel-001"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    // manifest 状态迁移
    const registry = makeRegistry(root);
    const manifest = registry.loadManifest("rel-001");
    assert.equal(manifest.status, "active_prod");
    assert.equal(typeof manifest.activatedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(manifest.activatedAt)), "active_prod 必须写入 activatedAt");

    // prod pointer 切换（actor=user）
    const store = makeStore(root);
    const prodPointer = store.readActive("production");
    assert.equal(prodPointer?.releaseId, "rel-001");
    assert.equal(prodPointer?.actor, "user");

    // dev pointer 未切换
    assert.equal(store.readActive("development"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: R2 缺少 completed canary 证据不得切 active_prod", () => {
  const root = makeTempRoot();
  try {
    const manifestSeed = makeManifest("rel-001", "candidate_prod", {
      approvalRef: "apr-001",
      changeClass: "R2",
    });
    setupReleases(root, [manifestSeed]);
    writeStubApproval(root, "rel-001", "apr-001", manifestSeed);

    const result = runCli(
      [
        "promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod",
        ...writePassingEvalEvidence(root, "rel-001", "R2"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    assert.equal(result.code, 5, `stdout: ${result.stdout}`);
    assert.match(result.stderr, /CANARY_EVIDENCE_REQUIRED/);
    assert.equal(makeStore(root).readActive("production"), null);
    assert.equal(makeRegistry(root).loadManifest("rel-001").status, "candidate_prod");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: R2 canary_started 声明性 trace 不得切 active_prod", () => {
  const root = makeTempRoot();
  try {
    const workspacePath = join(root, "workspaces", "ws-test");
    const manifestSeed = makeManifest("rel-001", "candidate_prod", {
      approvalRef: "apr-001",
      changeClass: "R2",
    });
    setupReleases(root, [manifestSeed]);
    writeStubApproval(root, "rel-001", "apr-001", manifestSeed);
    const trace = writeCanaryTrace(workspacePath, manifestSeed, {
      status: "canary_started",
      completedAt: null,
      shadowPendingRealRun: true,
    });

    const result = runCli(
      [
        "promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod",
        "--workspace", workspacePath, "--canary-run", trace.runId,
        ...writePassingEvalEvidence(root, "rel-001", "R2"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    assert.equal(result.code, 5, `stdout: ${result.stdout}`);
    assert.match(result.stderr, /CANARY_NOT_COMPLETED/);
    assert.equal(makeStore(root).readActive("production"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: R2 completed 且绑定完整的 canary trace 才允许 active_prod", () => {
  const root = makeTempRoot();
  try {
    const workspacePath = join(root, "workspaces", "ws-test");
    const manifestSeed = makeManifest("rel-001", "candidate_prod", {
      approvalRef: "apr-001",
      changeClass: "R2",
    });
    setupReleases(root, [manifestSeed]);
    writeStubApproval(root, "rel-001", "apr-001", manifestSeed);
    const trace = writeCanaryTrace(workspacePath, manifestSeed);

    const result = runCli(
      [
        "promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod",
        "--workspace", workspacePath, "--canary-run", trace.runId,
        ...writePassingEvalEvidence(root, "rel-001", "R2"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(trace.runId));
    assert.equal(makeStore(root).readActive("production")?.releaseId, "rel-001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: R2 canary 结果 artifact 被篡改时不得切 active_prod", () => {
  const root = makeTempRoot();
  try {
    const workspacePath = join(root, "workspaces", "ws-test");
    const manifestSeed = makeManifest("rel-001", "candidate_prod", {
      approvalRef: "apr-001",
      changeClass: "R2",
    });
    setupReleases(root, [manifestSeed]);
    writeStubApproval(root, "rel-001", "apr-001", manifestSeed);
    const trace = writeCanaryTrace(workspacePath, manifestSeed);
    // P0 修复后 artifact 是真实 chapter trace；篡改其中一个 trace 文件触发 hash mismatch
    writeFileSync(
      join(workspacePath, "traces", "1-quality-trace.json"),
      '{"verdict":"tampered"}\n',
      "utf-8",
    );

    const result = runCli(
      [
        "promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod",
        "--workspace", workspacePath, "--canary-run", trace.runId,
        ...writePassingEvalEvidence(root, "rel-001", "R2"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    assert.equal(result.code, 5, `stdout: ${result.stdout}`);
    assert.match(result.stderr, /CANARY_ARTIFACT_MISMATCH/);
    assert.equal(makeStore(root).readActive("production"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: R2 canary 晋级事件写失败时不得改变 manifest 或 production pointer", () => {
  const root = makeTempRoot();
  try {
    const workspacePath = join(root, "workspaces", "ws-test");
    const manifestSeed = makeManifest("rel-001", "candidate_prod", {
      approvalRef: "apr-001",
      changeClass: "R2",
    });
    setupReleases(root, [manifestSeed]);
    writeStubApproval(root, "rel-001", "apr-001", manifestSeed);
    const trace = writeCanaryTrace(workspacePath, manifestSeed);
    mkdirSync(
      join(root, "releases", "rel-001", "state-events.jsonl.tmp"),
      { recursive: true },
    );

    const result = runCli(
      [
        "promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod",
        "--workspace", workspacePath, "--canary-run", trace.runId,
        ...writePassingEvalEvidence(root, "rel-001", "R2"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    assert.equal(result.code, 5, `stdout: ${result.stdout}`);
    assert.match(result.stderr, /状态事件|state event|EISDIR/i);
    assert.equal(makeStore(root).readActive("production"), null);
    assert.equal(makeRegistry(root).loadManifest("rel-001").status, "candidate_prod");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: target=active_prod 但 actor=system 拒绝退出码 2", () => {
  const root = makeTempRoot();
  try {
    setupReleases(root, [
      makeManifest("rel-001", "candidate_prod", { approvalRef: "apr-001" }),
    ]);
    const result = runCli(
      ["promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod", "--actor", "system"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /user/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// evolution:hold
// ============================================================================

test("hold: active_dev → held 不切 pointer 成功", () => {
  const root = makeTempRoot();
  try {
    const manifestSeed = makeManifest("rel-001", "active_dev", { approvalRef: "apr-001" });
    setupReleases(root, [manifestSeed]);
    writeStubApproval(root, "rel-001", "apr-001", manifestSeed);
    const result = runCli(
      ["hold", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    // manifest 状态迁移
    const registry = makeRegistry(root);
    const manifest = registry.loadManifest("rel-001");
    assert.equal(manifest.status, "held");

    // 状态事件
    const events = registry.loadStateEvents("rel-001");
    assert.ok(events.some((e) => e.toStatus === "held"));

    // 不切 pointer
    const store = makeStore(root);
    assert.equal(store.readActive("development"), null);
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hold: 缺 --release-id 退出码 2", () => {
  const root = makeTempRoot();
  try {
    const result = runCli(["hold"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /release-id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hold: release 不存在退出码 3", () => {
  const root = makeTempRoot();
  try {
    const result = runCli(
      ["hold", "--release-id", "rel-nonexistent"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 3);
    assert.match(result.stderr, /不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hold: 当前状态 draft 不允许 hold 退出码 4", () => {
  const root = makeTempRoot();
  try {
    setupReleases(root, [makeManifest("rel-001", "draft")]);
    const result = runCli(
      ["hold", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 4);
    assert.match(result.stderr, /draft/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hold: 当前状态已 held 不允许再 hold 退出码 4", () => {
  const root = makeTempRoot();
  try {
    setupReleases(root, [makeManifest("rel-001", "held")]);
    const result = runCli(
      ["hold", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 4);
    assert.match(result.stderr, /held/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hold: active_prod → held 不切 pointer 成功", () => {
  const root = makeTempRoot();
  try {
    const manifestSeed = makeManifest("rel-001", "active_prod", { approvalRef: "apr-001" });
    setupReleases(root, [manifestSeed]);
    writeStubApproval(root, "rel-001", "apr-001", manifestSeed);
    const result = runCli(
      ["hold", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const registry = makeRegistry(root);
    const manifest = registry.loadManifest("rel-001");
    assert.equal(manifest.status, "held");

    // 不切 pointer
    const store = makeStore(root);
    assert.equal(store.readActive("development"), null);
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// evolution:rollback
// ============================================================================

test("rollback: development 首次切换后无前序可回滚退出码 5", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" });
    setupReleases(root, [m1]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    // 先 promote 一次（首次 switch，fromReleaseId=null）
    const promoteResult = runCli(
      ["promote", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(promoteResult.code, 0, `promote stderr: ${promoteResult.stderr}`);

    // rollback 应失败：无 switch 前状态可回滚
    const result = runCli(
      ["rollback", "--kind", "development"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5);
    assert.match(result.stderr, /回滚|rollback/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback: development 成功回滚到前 pointer + 当前 release 标记 held", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" });
    const m2 = makeManifest("rel-002", "approved_dev", { approvalRef: "apr-002" });
    setupReleases(root, [m1, m2]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    writeStubApproval(root, "rel-002", "apr-002", m2);
    // promote rel-001 → active_dev（首次 switch）
    runCli(["promote", "--release-id", "rel-001"], { PINOVEL_EVOLUTION_ROOT: root });
    // promote rel-002 → active_dev（第二次 switch，fromReleaseId=rel-001）
    runCli(["promote", "--release-id", "rel-002"], { PINOVEL_EVOLUTION_ROOT: root });

    // rollback dev → 应回到 rel-001
    const result = runCli(
      ["rollback", "--kind", "development"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const store = makeStore(root);
    const devPointer = store.readActive("development");
    assert.equal(devPointer?.releaseId, "rel-001");

    // 当前 release（rel-002）标记 held
    const registry = makeRegistry(root);
    const rel002 = registry.loadManifest("rel-002");
    assert.equal(rel002.status, "held");

    // rel-001 保持 active_dev
    const rel001 = registry.loadManifest("rel-001");
    assert.equal(rel001.status, "active_dev");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback: 缺 --kind 默认 development", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" });
    const m2 = makeManifest("rel-002", "approved_dev", { approvalRef: "apr-002" });
    setupReleases(root, [m1, m2]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    writeStubApproval(root, "rel-002", "apr-002", m2);
    runCli(["promote", "--release-id", "rel-001"], { PINOVEL_EVOLUTION_ROOT: root });
    runCli(["promote", "--release-id", "rel-002"], { PINOVEL_EVOLUTION_ROOT: root });

    // 不传 --kind，默认 development
    const result = runCli(["rollback"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /development/);

    const store = makeStore(root);
    assert.equal(store.readActive("development")?.releaseId, "rel-001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback: --kind 非法值退出码 2", () => {
  const root = makeTempRoot();
  try {
    const result = runCli(
      ["rollback", "--kind", "bogus"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /kind/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback: 当前无 active pointer 退出码 4", () => {
  const root = makeTempRoot();
  try {
    // 不 setup 任何 release，也不切换 pointer
    const result = runCli(
      ["rollback", "--kind", "development"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 4);
    assert.match(result.stderr, /active pointer|无/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback: production 回滚到 held 旧基线被阻断（旧 release 仅审计读取）", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "candidate_prod", { approvalRef: "apr-001" });
    const m2 = makeManifest("rel-002", "candidate_prod", { approvalRef: "apr-002" });
    setupReleases(root, [m1, m2]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    writeStubApproval(root, "rel-002", "apr-002", m2);
    // promote rel-001 → active_prod（首次 prod switch，建立唯一生产基线）
    runCli(
      [
        "promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod",
        ...writePassingEvalEvidence(root, "rel-001"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    // DG-6 单一生产基线：晋级 rel-002 前必须先降级旧基线 rel-001（active_prod → held），
    // 否则 active_prod 单例约束会阻断第二次晋级。
    runCli(["hold", "--release-id", "rel-001"], { PINOVEL_EVOLUTION_ROOT: root });
    // promote rel-002 → active_prod（第二次 prod switch，fromReleaseId=rel-001）
    runCli(
      [
        "promote", "--release-id", "rel-002", "--target", "active_prod", "--confirm-prod",
        ...writePassingEvalEvidence(root, "rel-002"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    // 旧 release 仅审计读取：rollback 到 held 旧基线必须被阻断（exit 5，fail-closed）
    const result = runCli(
      ["rollback", "--kind", "production"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5, `期望阻断 exit 5，实际 ${result.code}：${result.stderr}`);
    assert.match(result.stderr, /held/);

    // fail-closed：pointer 未变，rel-002 仍是唯一 active_prod，rel-001 保持 held（仅审计读取）
    const store = makeStore(root);
    const prodPointer = store.readActive("production");
    assert.equal(prodPointer?.releaseId, "rel-002");

    const registry = makeRegistry(root);
    assert.equal(registry.loadManifest("rel-002").status, "active_prod");
    assert.equal(registry.loadManifest("rel-001").status, "held");
    const active = registry.listManifests().filter((x) => x.status === "active_prod");
    assert.deepEqual(active.map((x) => x.releaseId), ["rel-002"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promote: 双 active_prod 晋级被单例约束阻断（真实 production promote 路径）", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "candidate_prod", { approvalRef: "apr-001" });
    const m2 = makeManifest("rel-002", "candidate_prod", { approvalRef: "apr-002" });
    setupReleases(root, [m1, m2]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    writeStubApproval(root, "rel-002", "apr-002", m2);

    // 首次晋级 rel-001 → active_prod（成功，建立唯一生产基线）
    const first = runCli(
      [
        "promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod",
        ...writePassingEvalEvidence(root, "rel-001"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(first.code, 0, `first promote stderr: ${first.stderr}`);

    // 第二次晋级 rel-002 → active_prod 而不降级 rel-001：必须被 active_prod 单例约束阻断
    const second = runCli(
      [
        "promote", "--release-id", "rel-002", "--target", "active_prod", "--confirm-prod",
        ...writePassingEvalEvidence(root, "rel-002"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(second.code, 5, `期望单例阻断 exit 5，实际 ${second.code}：${second.stderr}`);
    assert.match(second.stderr, /单例|active_prod/);

    // fail-closed：rel-001 仍是唯一 active_prod，rel-002 仍是 candidate_prod，pointer 未变
    const registry = makeRegistry(root);
    assert.equal(registry.loadManifest("rel-001").status, "active_prod");
    assert.equal(registry.loadManifest("rel-002").status, "candidate_prod");
    const active = registry.listManifests().filter((x) => x.status === "active_prod");
    assert.deepEqual(active.map((x) => x.releaseId), ["rel-001"]);
    assert.equal(makeStore(root).readActive("production")?.releaseId, "rel-001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback: rollback history append-only", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" });
    const m2 = makeManifest("rel-002", "approved_dev", { approvalRef: "apr-002" });
    const m3 = makeManifest("rel-003", "approved_dev", { approvalRef: "apr-003" });
    setupReleases(root, [m1, m2, m3]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    writeStubApproval(root, "rel-002", "apr-002", m2);
    writeStubApproval(root, "rel-003", "apr-003", m3);
    runCli(["promote", "--release-id", "rel-001"], { PINOVEL_EVOLUTION_ROOT: root });
    runCli(["promote", "--release-id", "rel-002"], { PINOVEL_EVOLUTION_ROOT: root });

    // 第一次 rollback
    runCli(["rollback", "--kind", "development"], { PINOVEL_EVOLUTION_ROOT: root });
    const store = makeStore(root);
    let history = store.loadRollbackHistory("development");
    assert.equal(history.length, 1);
    assert.equal(history[0].operation, "rollback");

    // 再 promote rel-003 + rollback → history 应有 2 条
    runCli(["promote", "--release-id", "rel-003"], { PINOVEL_EVOLUTION_ROOT: root });
    runCli(["rollback", "--kind", "development"], { PINOVEL_EVOLUTION_ROOT: root });
    history = store.loadRollbackHistory("development");
    assert.equal(history.length, 2);
    for (const entry of history) {
      assert.equal(entry.operation, "rollback");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 状态机集成
// ============================================================================

test("promote → hold → rollback 完整工作流（dev 路径）", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" });
    const m2 = makeManifest("rel-002", "approved_dev", { approvalRef: "apr-002" });
    const m3 = makeManifest("rel-003", "approved_dev", { approvalRef: "apr-003" });
    setupReleases(root, [m1, m2, m3]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    writeStubApproval(root, "rel-002", "apr-002", m2);
    writeStubApproval(root, "rel-003", "apr-003", m3);

    // 1. promote rel-001 → active_dev
    let r = runCli(["promote", "--release-id", "rel-001"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(r.code, 0, `step 1 stderr: ${r.stderr}`);

    // 2. promote rel-002 → active_dev
    r = runCli(["promote", "--release-id", "rel-002"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(r.code, 0, `step 2 stderr: ${r.stderr}`);

    // 3. hold rel-002 → held（dev pointer 仍 = rel-002）
    r = runCli(["hold", "--release-id", "rel-002"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(r.code, 0, `step 3 stderr: ${r.stderr}`);

    let store = makeStore(root);
    assert.equal(store.readActive("development")?.releaseId, "rel-002");

    // 4. rollback dev → 回到 rel-001；rel-002 已 held（CLI 仅写 warning 不阻断）
    r = runCli(["rollback", "--kind", "development"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(r.code, 0, `step 4 stderr: ${r.stderr}`);

    store = makeStore(root);
    assert.equal(store.readActive("development")?.releaseId, "rel-001");

    // 5. promote rel-003 → active_dev
    r = runCli(["promote", "--release-id", "rel-003"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(r.code, 0, `step 5 stderr: ${r.stderr}`);

    store = makeStore(root);
    assert.equal(store.readActive("development")?.releaseId, "rel-003");

    // 最终状态验证
    const registry = makeRegistry(root);
    assert.equal(registry.loadManifest("rel-001").status, "active_dev");
    assert.equal(registry.loadManifest("rel-002").status, "held");
    assert.equal(registry.loadManifest("rel-003").status, "active_dev");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback 后失败版本仍可被 listManifests 列出（不删除负面证据）", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" });
    const m2 = makeManifest("rel-002", "approved_dev", { approvalRef: "apr-002" });
    setupReleases(root, [m1, m2]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    writeStubApproval(root, "rel-002", "apr-002", m2);
    runCli(["promote", "--release-id", "rel-001"], { PINOVEL_EVOLUTION_ROOT: root });
    runCli(["promote", "--release-id", "rel-002"], { PINOVEL_EVOLUTION_ROOT: root });
    runCli(["rollback", "--kind", "development"], { PINOVEL_EVOLUTION_ROOT: root });

    const registry = makeRegistry(root);
    const all = registry.listManifests();
    const ids = all.map((m) => m.releaseId).sort();
    assert.deepEqual(ids, ["rel-001", "rel-002"]);

    // rel-002（被回滚的失败版本）标记 held，未删除
    const rel002 = registry.loadManifest("rel-002");
    assert.equal(rel002.status, "held");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// P0/P1 修复 RED 测试
// ============================================================================

test("P0-1: promote 不存在的 approvalRef 退出码 5（artifact resolver 注入）", () => {
  const root = makeTempRoot();
  try {
    // 写 manifest 含 approvalRef="apr-fake"，但不写 artifact
    setupReleases(root, [
      makeManifest("rel-001", "approved_dev", { approvalRef: "apr-fake" }),
    ]);
    const result = runCli(
      ["promote", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5);
    assert.match(result.stderr, /artifact|approvalRef|不存在/);

    // manifest 未被污染（状态仍为 approved_dev）
    const registry = makeRegistry(root);
    assert.equal(registry.loadManifest("rel-001").status, "approved_dev");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1: promote approvalRef 指向 HOLD artifact 退出码 5", () => {
  const root = makeTempRoot();
  try {
    const manifestSeed = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" });
    setupReleases(root, [manifestSeed]);
    writeStubApproval(root, "rel-001", "apr-001", manifestSeed, { finalVerdict: "HOLD" });

    const result = runCli(
      ["promote", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5);
    assert.match(result.stderr, /APPROVE_DEV|finalVerdict|HOLD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1: promote approvalRef 指向其他 release 的 artifact 退出码 5", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-shared" });
    const m2 = makeManifest("rel-002", "approved_dev", { approvalRef: "apr-shared" });
    setupReleases(root, [m1, m2]);
    // 把 artifact 写到 rel-001 目录，rel-002 复用同一 approvalId
    writeStubApproval(root, "rel-001", "apr-shared", m1);
    // rel-002 目录下不写 artifact

    const result = runCli(
      ["promote", "--release-id", "rel-002"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5);
    assert.match(result.stderr, /artifact|不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1: promote artifact releaseManifestHash 不匹配退出码 5", () => {
  const root = makeTempRoot();
  try {
    const manifestSeed = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" });
    setupReleases(root, [manifestSeed]);
    writeStubApproval(root, "rel-001", "apr-001", manifestSeed, {
      releaseManifestHash: "0".repeat(64), // 假 hash
    });

    const result = runCli(
      ["promote", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5);
    assert.match(result.stderr, /hash|manifest|绑定/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-2: promote pointer 切换失败时 manifest 不被污染（原子性）", () => {
  const root = makeTempRoot();
  try {
    const manifestSeed = makeManifest("rel-001", "candidate_prod", { approvalRef: "apr-001" });
    setupReleases(root, [manifestSeed]);
    writeStubApproval(root, "rel-001", "apr-001", manifestSeed);

    // 第一次 promote 到 active_prod — 成功
    const first = runCli(
      [
        "promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod",
        ...writePassingEvalEvidence(root, "rel-001"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(first.code, 0, `first promote stderr: ${first.stderr}`);

    // 第二次 promote 同一 release 到 active_prod — 非法迁移（active_prod → active_prod）
    // 应在状态校验阶段失败（exit 4），pointer 仍是第一次成功后的状态
    const second = runCli(
      [
        "promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod",
        ...writePassingEvalEvidence(root, "rel-001-second"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(second.code, 4);
    // pointer 仍是第一次成功后的状态（rel-001 active_prod）
    const store = makeStore(root);
    assert.equal(store.readActive("production")?.releaseId, "rel-001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1-1: rollback 连续第二次退出码 5（consume 跟踪）", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" });
    const m2 = makeManifest("rel-002", "approved_dev", { approvalRef: "apr-002" });
    const m3 = makeManifest("rel-003", "approved_dev", { approvalRef: "apr-003" });
    setupReleases(root, [m1, m2, m3]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    writeStubApproval(root, "rel-002", "apr-002", m2);
    writeStubApproval(root, "rel-003", "apr-003", m3);

    runCli(["promote", "--release-id", "rel-001"], { PINOVEL_EVOLUTION_ROOT: root });
    runCli(["promote", "--release-id", "rel-002"], { PINOVEL_EVOLUTION_ROOT: root });
    runCli(["promote", "--release-id", "rel-003"], { PINOVEL_EVOLUTION_ROOT: root });

    // 第一次 rollback: 消费 rel-002→rel-003，回到 rel-002
    const r1 = runCli(["rollback", "--kind", "development"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(r1.code, 0, `r1 stderr: ${r1.stderr}`);

    // 第二次 rollback: 消费 rel-001→rel-002，回到 rel-001（合法）
    const r2 = runCli(["rollback", "--kind", "development"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(r2.code, 0, `r2 stderr: ${r2.stderr}`);
    const store = makeStore(root);
    assert.equal(store.readActive("development")?.releaseId, "rel-001");

    // 第三次 rollback: 只剩 null→rel-001（fromReleaseId=null 不可回滚），失败
    const r3 = runCli(["rollback", "--kind", "development"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(r3.code, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1-3: rollback rollbackReleaseId 不匹配退出码 5", () => {
  const root = makeTempRoot();
  try {
    // rel-002 的 rollbackReleaseId 故意声明为 "rel-rollback-target"
    // 但 history 中 switch 链指向 rel-001
    const m1 = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" });
    const m2 = makeManifest("rel-002", "approved_dev", {
      approvalRef: "apr-002",
      rollbackReleaseId: "rel-rollback-target", // 故意不匹配 history 目标
    });
    setupReleases(root, [m1, m2]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    writeStubApproval(root, "rel-002", "apr-002", m2);

    runCli(["promote", "--release-id", "rel-001"], { PINOVEL_EVOLUTION_ROOT: root });
    runCli(["promote", "--release-id", "rel-002"], { PINOVEL_EVOLUTION_ROOT: root });

    // rollback: history 指向 rel-001，但 rel-002.rollbackReleaseId="rel-rollback-target" 不匹配
    const result = runCli(["rollback", "--kind", "development"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(result.code, 5);
    assert.match(result.stderr, /rollbackReleaseId|不匹配/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1-3: rollback 目标 manifest 不存在退出码 5", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" });
    const m2 = makeManifest("rel-002", "approved_dev", { approvalRef: "apr-002" });
    setupReleases(root, [m1, m2]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    writeStubApproval(root, "rel-002", "apr-002", m2);

    runCli(["promote", "--release-id", "rel-001"], { PINOVEL_EVOLUTION_ROOT: root });
    runCli(["promote", "--release-id", "rel-002"], { PINOVEL_EVOLUTION_ROOT: root });

    // 删除 rel-001 manifest 目录，让 rollback 目标不存在
    rmSync(join(root, "releases", "rel-001"), { recursive: true, force: true });

    const result = runCli(["rollback", "--kind", "development"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(result.code, 5);
    assert.match(result.stderr, /不存在|目标/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1-3: rollback 目标 manifest 状态为 held 退出码 5", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "approved_dev", { approvalRef: "apr-001" });
    const m2 = makeManifest("rel-002", "approved_dev", { approvalRef: "apr-002" });
    setupReleases(root, [m1, m2]);
    writeStubApproval(root, "rel-001", "apr-001", m1);
    writeStubApproval(root, "rel-002", "apr-002", m2);

    runCli(["promote", "--release-id", "rel-001"], { PINOVEL_EVOLUTION_ROOT: root });
    // 手动把 rel-001 标 held（模拟曾经被 hold 过；rel-001 当前是 active_dev → held 合法迁移）
    const registry = makeRegistry(root);
    registry.transitionStatus("rel-001", "held", { actor: "system", reason: "test setup" });

    runCli(["promote", "--release-id", "rel-002"], { PINOVEL_EVOLUTION_ROOT: root });

    // rollback 目标 rel-001 状态为 held，不可回滚到
    const result = runCli(["rollback", "--kind", "development"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(result.code, 5);
    assert.match(result.stderr, /held|状态/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1-2: releaseId 含 ../ 路径穿越退出码 2（CLI 层）", () => {
  const root = makeTempRoot();
  try {
    const result = runCli(
      ["promote", "--release-id", "../etc/passwd"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /release-id|非法|字符/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1-2: approvalId 含 / 路径穿越（间接通过 approvalRef）退出码 5", () => {
  const root = makeTempRoot();
  try {
    // approvalRef 含 / — 即使 artifact 不存在，loadArtifact 也应被路径校验拦截
    const manifestSeed = makeManifest("rel-001", "approved_dev", { approvalRef: "evil/path" });
    setupReleases(root, [manifestSeed]);
    const result = runCli(
      ["promote", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    // 期望：CLI 退出码 5（approval artifact 解析失败 / 路径非法）
    assert.ok(result.code === 2 || result.code === 5, `expected 2 or 5, got ${result.code}`);
    assert.match(result.stderr, /approvalRef|artifact|非法|字符|不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// G8 后续 P0/P1 阻断 RED 测试
// ============================================================================

/**
 * P0-1: switchActive history 写入失败时 pointer 不得改变（fail-closed）
 *
 * 现状（RED）：switchActive 先写 pointer 再写 history；history 失败时 pointer 已改。
 * 期望（GREEN）：先写 history 后写 pointer；history 失败时 pointer 保持旧值。
 */
test("P0-1: switchActive history 写入失败时 pointer 不得改变（fail-closed）", () => {
  const root = makeTempRoot();
  try {
    const store = makeStore(root);
    // 先成功切换一次，建立 previous pointer 和 history
    store.switchActive("development", "rel-100", { actor: "system", reason: "init" });
    const beforePointer = store.readActive("development");
    assert.equal(beforePointer.releaseId, "rel-100");

    // 阻断 history 写入：在 history .tmp 路径创建目录，使 writeFileSync 抛 EISDIR
    // history 文件：{root}/rollback-history-development.jsonl
    // .tmp 路径：{root}/rollback-history-development.jsonl.tmp
    mkdirSync(join(root, "rollback-history-development.jsonl.tmp"));

    // 第二次切换：history 写入应失败
    // 期望：switchActive 抛错；readActive 仍返回 rel-100（pointer 未改）
    assert.throws(
      () => store.switchActive("development", "rel-200", { actor: "system", reason: "should-fail" }),
      /EISDIR|illegal operation on a directory/i,
    );

    const afterPointer = store.readActive("development");
    assert.equal(
      afterPointer.releaseId,
      "rel-100",
      "P0-1 fail-closed：history 写入失败时 pointer 必须保持旧值（rel-100），不得切换到 rel-200",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1: switchActive pointer 写入失败时不得追加虚假 history", () => {
  const root = makeTempRoot();
  try {
    const store = makeStore(root);
    mkdirSync(join(root, "active-development.json.tmp"));

    assert.throws(
      () => store.switchActive("development", "rel-100", { actor: "system", reason: "fail" }),
      /EISDIR|illegal operation on a directory/i,
    );

    assert.equal(store.readActive("development"), null, "pointer 写失败后不应出现 active pointer");
    const historyPath = join(root, "rollback-history-development.jsonl");
    assert.equal(
      existsSync(historyPath) ? readFileSync(historyPath, "utf-8").trim() : "",
      "",
      "pointer 写失败不得留下声称切换成功的 history",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1: rollback history 写入失败时 pointer 必须保持当前 release", () => {
  const root = makeTempRoot();
  try {
    const store = makeStore(root);
    store.switchActive("development", "rel-100", { actor: "system", reason: "first" });
    store.switchActive("development", "rel-200", { actor: "system", reason: "second" });
    mkdirSync(join(root, "rollback-history-development.jsonl.tmp"));

    assert.throws(
      () => store.rollback("development", { actor: "user", reason: "should-fail" }),
      /EISDIR|illegal operation on a directory/i,
    );

    assert.equal(
      store.readActive("development").releaseId,
      "rel-200",
      "rollback history 写失败时 pointer 必须保持回滚前 release",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * P0-2: production rollback 目标 approvalRef 非空但 artifact 不存在必须失败
 *
 * 现状（RED）：cmdRollback production 只检查 approvalRef 非空，不验 artifact 真实性。
 * 期望（GREEN）：cmdRollback production 必须像 cmdPromote 一样校验 artifact 四元绑定。
 */
test("P0-2: production rollback 目标 approvalRef 非空但 artifact 不存在必须失败", () => {
  const root = makeTempRoot();
  try {
    // rel-000：回滚目标，approvalRef 非空但故意不写 artifact 文件
    const m0 = makeManifest("rel-000", "active_prod", { approvalRef: "apr-000" });
    // rel-001：当前 active，有完整 artifact
    const m1 = makeManifest("rel-001", "active_prod", {
      approvalRef: "apr-001",
      parentReleaseId: "rel-000",
      rollbackReleaseId: "rel-000",
    });
    setupReleases(root, [m0, m1]);
    writeStubApproval(root, "rel-001", "apr-001", m1); // 只写 rel-001 的 artifact
    // 故意不写 rel-000 的 artifact — 伪造 approvalRef="apr-000" 但无真实审批

    // 手动切换 production pointer（绕过 CLI，直接用 store）
    const store = makeStore(root);
    store.switchActive("production", "rel-000", { actor: "user", reason: "init" });
    store.switchActive("production", "rel-001", { actor: "user", reason: "promote" });
    assert.equal(store.readActive("production").releaseId, "rel-001");

    // 执行 rollback：期望失败（exit 5），因为 rel-000 的 approval artifact 不存在
    const result = runCli(["rollback", "--kind", "production"], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(result.code, 5, `期望 exit 5（artifact 不存在），实际 ${result.code}：${result.stderr}`);
    assert.match(result.stderr, /approval.*artifact|artifact.*不存在|artifact.*解析失败/);

    // pointer 不应变（仍 rel-001）
    assert.equal(store.readActive("production").releaseId, "rel-001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * P0-3: 生产晋级缺 --confirm-prod 必须退出码 2
 *
 * 现状（RED）：cmdPromote 默认 actor=user 即可生产晋级，无显式确认参数。
 * 期望（GREEN）：生产晋级必须显式 --confirm-prod，缺则 exit 2。
 */
test("P0-3: 生产晋级缺 --confirm-prod 必须退出码 2", () => {
  const root = makeTempRoot();
  try {
    const m1 = makeManifest("rel-001", "active_dev", { approvalRef: "apr-001" });
    setupReleases(root, [m1]);
    writeStubApproval(root, "rel-001", "apr-001", m1);

    // 不带 --confirm-prod：期望 exit 2
    const result = runCli(
      ["promote", "--release-id", "rel-001", "--target", "candidate_prod"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 2, `期望 exit 2（缺 --confirm-prod），实际 ${result.code}：${result.stderr}`);
    assert.match(result.stderr, /--confirm-prod/);

    // 带 --confirm-prod：期望 exit 0（状态迁移到 candidate_prod）
    const result2 = runCli(
      ["promote", "--release-id", "rel-001", "--target", "candidate_prod", "--confirm-prod"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result2.code, 0, `期望 exit 0（带 --confirm-prod），实际 ${result2.code}：${result2.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
