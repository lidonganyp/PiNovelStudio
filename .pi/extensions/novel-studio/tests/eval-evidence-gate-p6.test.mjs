/**
 * EVAL-REPLAY-ACCEPTANCE-LOOP P6 契约测试 — eval-evidence-gate + fixture capture + CLI 接入
 *
 * 覆盖：
 *  - eval-fixture-capture：合法 workspace+manifest 冻结落盘 / 行为身份缺失 fail-closed /
 *    workspace 不存在 / 前章 NarrativeState 缺失 / 只读性；
 *  - eval-evidence-gate：证据缺失 → insufficient / manifest 无效 / release 不匹配 → rejected /
 *    deterministic 失败 → rejected / R3 无 matrix → insufficient /
 *    两字段伪造 matrix → MATRIX_INVALID / 完整四臂矩阵 recompute pass → approved /
 *    R0/R1 无四臂 → EVAL_EVIDENCE_MATRIX_MISSING / R0-R3 生产晋级全部 mandatory；
 *  - CLI：eval-capture 成功冻结 / eval-gate 证据通过 exit 0、缺失 exit 1 /
 *    promote active_prod R3 → EVAL_EVIDENCE_REQUIRED exit 5 /
 *    promote active_prod R1 无证据 → 同样强制阻断 exit 5。
 *
 * 治理边界验证：eval-gate 绝不修改 production pointer。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import { createReleasePointerStore } from "../dist-test/v2/governance/release-pointer-store.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";
import {
  evaluateEvalEvidenceGate,
  writeEvalPendingReviewReport,
  resolveEvalEvidenceEnforcement,
  evaluateReplayCliSuccess,
  matrixEvidenceRequired,
} from "../dist-test/v2/governance/eval-evidence-gate.js";
import { captureEvalFixture } from "../dist-test/v2/core/eval-fixture-capture.js";
import {
  computeEvalFixtureHash,
  parseEvalFixtureV1,
} from "../dist-test/v2/core/eval-fixture-contract.js";
import {
  generateMatrixReportFromReplayRuns,
  writeMatrixReport,
  computeMatrixReportHash,
} from "../dist-test/v2/core/eval-replay-matrix.js";

// ============================================================================
// helpers
// ============================================================================

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "..", "scripts", "evolution-cli.mjs");
const EXT_ROOT = join(__dirname, "..");

function makeTempRoot(prefix = "eval-p6-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(args, env = {}) {
  // spawnSync：成功（exit 0）时也要捕获 stderr（console.warn 的 advisory
  // 警告走 stderr，execFileSync 只在非 0 退出时提供 stderr）。
  const result = spawnSync("node", [CLI_PATH, ...args], {
    cwd: EXT_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 30000,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
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
    claims: opts.claims ?? ["test-claim"],
    environmentFingerprint: "fp-test-hash",
    artifactRefs: [],
    approvalRef: opts.approvalRef ?? null,
    createdAt: "2026-07-16T00:00:00.000Z",
    activatedAt: null,
    // 行为身份（DG-1）：fixture capture 的 provenance 来源
    bundleId: opts.bundleId ?? "bundle-test-001",
    modelVersion: opts.modelVersion ?? "gemini-3.1-pro-preview",
    promptBundleHash: opts.promptBundleHash ?? "0123456789abcdef",
    modelRoutingHash: opts.modelRoutingHash ?? "0123456789abcdef",
    toolSchemaHash: opts.toolSchemaHash ?? "0123456789abcdef",
    contextCompilerHash: opts.contextCompilerHash ?? "0123456789abcdef",
    qualityPolicyHash: opts.qualityPolicyHash ?? "0123456789abcdef",
    recoveryPolicyHash: opts.recoveryPolicyHash ?? "0123456789abcdef",
    knowledgeSnapshotHash: opts.knowledgeSnapshotHash ?? "0123456789abcdef",
    runtimeFingerprint: opts.runtimeFingerprint ?? "rf-test",
    evalProtocolVersion: opts.evalProtocolVersion ?? "pinovel.eval-protocol/1",
  };
}

/** 构造最小合法 workspace（第 2 章场景：含前章 + NarrativeState）。 */
function makeWorkspace(projectRoot, workspaceId, opts = {}) {
  const ws = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(join(ws, "characters"), { recursive: true });
  mkdirSync(join(ws, "chapters"), { recursive: true });
  mkdirSync(join(ws, "narrative-state"), { recursive: true });
  writeFileSync(
    join(ws, "config.json"),
    JSON.stringify({ novelName: "测试", genre: "xianxia", characters: [] }),
  );
  writeFileSync(join(ws, "characters", "protagonist.md"), "# 主角档案");
  writeFileSync(join(ws, "chapters", "chapter-001.md"), "# 第一章\n正文内容");
  if (!opts.skipNarrativeState) {
    writeFileSync(
      join(ws, "narrative-state", "chapter-001-narrative-state.json"),
      JSON.stringify({ canon: [], promises: [] }),
    );
  }
  return ws;
}

/** 构造合法 eval run root（stub replay；默认 1 样本全过）。 */
function makeEvalRunRoot(root, releaseId, bundleId, opts = {}) {
  const runRoot = opts.runRoot ?? join(root, opts.runDirName ?? "eval-run");
  const fixtureIdBase = opts.fixtureId ?? "fixture.p6-001";
  const sampleCount = opts.sampleCount ?? 1;
  const runId = opts.runId ?? "run-p6-001";
  const samples = [];
  let firstFixtureHash = "";

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
      createdAt: "2026-08-15T00:00:00.000Z",
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
    const fixtureHash = computeEvalFixtureHash(fixture);
    if (i === 0) firstFixtureHash = fixtureHash;
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
      fixtureHash,
      replayMode: "stub",
      scratchWorkspaceId: `eval-stub-x-${i + 1}`,
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

  const manifest = {
    schemaId: "pinovel.eval-replay-run-manifest",
    schemaVersion: 1,
    runId,
    evalProtocolVersion: "pinovel.eval-protocol/1",
    replayMode: "stub",
    releaseId,
    bundleId,
    runRoot,
    startedAt: "2026-08-15T00:00:00.000Z",
    finishedAt: "2026-08-15T00:01:00.000Z",
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
  };
  writeFileSync(join(runRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { runRoot, fixtureHash: firstFixtureHash };
}

function writeGeneratedPassingMatrix(evalRunRoot, releaseId, bundleId, opts = {}) {
  const armIds = ["baseline", "candidate", "raw_direct", "recovery"];
  const armRunRoots = {};
  for (const armId of armIds) {
    const { runRoot } = makeEvalRunRoot(evalRunRoot, releaseId, bundleId, {
      runDirName: join("arms", armId),
      fixtureId: `fixture.${armId}`,
      sampleCount: 3,
      runId: `run-${armId}`,
    });
    armRunRoots[armId] = runRoot;
  }
  const report = generateMatrixReportFromReplayRuns({
    candidateReleaseId: releaseId,
    candidateBundleId: bundleId,
    baselineReleaseId: opts.baselineReleaseId ?? releaseId,
    armRunRoots,
    codeCommit: opts.codeCommit ?? "deadbeefcafebabe0123456789abcdef01234567",
  });
  writeMatrixReport(evalRunRoot, report);
  return report;
}

/** production_like completed 但 manifest.modelCalls=0、trace 有 3 次调用。 */
function writeLyingProductionLikeArm(evalRunRoot, releaseId, bundleId) {
  const runRoot = join(evalRunRoot, "arms", "baseline-lying");
  const fixtureId = "fixture.baseline-lying";
  const tracesDir = join(runRoot, "samples", fixtureId, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const fixture = JSON.parse(
    readFileSync(join(evalRunRoot, "samples", readdirSync(join(evalRunRoot, "samples"))[0], "fixture.json"), "utf-8"),
  );
  fixture.fixtureId = fixtureId;
  fixture.replayMode = "production_like";
  writeFileSync(join(runRoot, "samples", fixtureId, "fixture.json"), JSON.stringify(fixture, null, 2));
  writeFileSync(
    join(tracesDir, "chapter-001-quality-trace.json"),
    JSON.stringify({
      gates: [
        {
          stage: "v2_final_selected",
          evidence: {
            modelCalls: [
              { requestedRoute: "v2_rawstage2_gemini31", actualProvider: "gemini31" },
              { requestedRoute: "v2_amplified_gemini31", actualProvider: "gemini31" },
              { requestedRoute: "v2_amplified_gemini31", actualProvider: "gemini31" },
            ],
          },
        },
      ],
      recoveryAttempts: [],
    }),
  );
  writeFileSync(
    join(runRoot, "samples", fixtureId, "state-projection.json"),
    JSON.stringify({ narrativeStateHash: "a".repeat(64) }),
  );
  const fixtureHash = computeEvalFixtureHash(fixture);
  writeFileSync(
    join(runRoot, "manifest.json"),
    JSON.stringify({
      schemaId: "pinovel.eval-replay-run-manifest",
      schemaVersion: 1,
      runId: "run-baseline-lying",
      evalProtocolVersion: "pinovel.eval-protocol/1",
      replayMode: "production_like",
      releaseId,
      bundleId,
      runRoot,
      startedAt: "2026-08-15T00:00:00.000Z",
      finishedAt: "2026-08-15T00:01:00.000Z",
      samples: [
        {
          fixtureId,
          fixtureHash,
          replayMode: "production_like",
          scratchWorkspaceId: "eval-lying-baseline",
          status: "completed",
          failureAttribution: null,
          failureEnvelopes: [],
          traceArchived: true,
          traceArchivePath: tracesDir,
          isolationViolations: [],
          modelCalls: 0,
          durationMs: 1000,
        },
      ],
      summary: {
        totalSamples: 1,
        countedSamples: 1,
        completed: 1,
        failed: 0,
        skipped: 0,
        traceRetentionRate: 1,
        isolationViolationCount: 0,
      },
    }),
  );
  return runRoot;
}

/**
 * 写入合法 approval artifact（与 G5 promote 测试同构）。
 * promote 命令在 eval gate 之前先做 approval 四元绑定校验，
 * 因此所有 promote CLI 测试必须先落盘合法 artifact。
 */
function writeMatchingStateEvent(root, releaseId, status) {
  const registry = createEvolutionReleaseRegistry({
    releasesDir: join(root, "releases"),
  });
  const fromByTo = {
    candidate: "draft",
    frozen: "candidate",
    evaluated: "frozen",
    approved_dev: "evaluated",
    active_dev: "approved_dev",
    candidate_prod: "active_dev",
    active_prod: "candidate_prod",
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
    timestamp: "2026-08-16T00:00:00.000Z",
  });
}

function writeStubApproval(root, releaseId, approvalId, manifest) {
  const approvalsDir = join(root, "releases", releaseId, "approvals");
  const registry = createProxyApprovalRegistry({ approvalsDir });
  const artifact = {
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
    rationale: "stub approval for eval-gate p6 test",
    decidedAt: "2026-08-15T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 300000 },
    changeClass: manifest.changeClass ?? "R1",
    r3SelfApproval: false,
  };
  registry.writeArtifact(artifact);
  return artifact;
}

// ============================================================================
// eval-fixture-capture 单元测试
// ============================================================================

test("capture: 合法 workspace + manifest → fixture 落盘 + hash + 幂等索引", () => {
  const root = makeTempRoot();
  try {
    makeWorkspace(root, "ws-cap");
    const manifest = makeManifest("rel-cap-001", "frozen");
    const archiveDir = join(root, "fixtures");

    const result = captureEvalFixture({
      projectRoot: root,
      workspaceId: "ws-cap",
      chapterNumber: 2,
      chapterId: "chapter-002",
      chapterTitle: "第二章",
      replayMode: "stub",
      manifest,
      archiveDir,
    });

    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.errors.length, 0);
    assert.match(result.fixtureHash, /^[0-9a-f]{64}$/);
    assert.ok(existsSync(result.fixturePath));

    // 落盘内容可通过契约校验
    const raw = JSON.parse(readFileSync(result.fixturePath, "utf-8"));
    const parsed = parseEvalFixtureV1(raw);
    assert.equal(parsed.ok, true);

    // provenance 同源 manifest
    assert.equal(raw.provenance.releaseId, "rel-cap-001");
    assert.equal(raw.provenance.bundleId, "bundle-test-001");

    // 快照内容
    assert.equal(raw.workspace.sourceWorkspaceId, "ws-cap");
    assert.equal(Object.keys(raw.workspace.characterProfiles).length, 1);
    assert.equal(raw.workspace.historicalChapters.length, 1);
    assert.equal(raw.workspace.historicalChapters[0].chapterNumber, 1);
    assert.match(raw.workspace.historicalChapters[0].contentHash, /^[0-9a-f]{64}$/);
    // stub 模式不内联正文
    assert.equal(raw.workspace.historicalChapters[0].content, undefined);
    // 前章 NarrativeState 已捕获
    assert.ok(raw.priorNarrativeState);

    // 索引幂等
    const indexPath = join(archiveDir, "fixture-index.jsonl");
    assert.ok(existsSync(indexPath));
    const lines1 = readFileSync(indexPath, "utf-8").trim().split("\n");
    captureEvalFixture({
      projectRoot: root,
      workspaceId: "ws-cap",
      chapterNumber: 2,
      chapterId: "chapter-002",
      chapterTitle: "第二章",
      replayMode: "stub",
      manifest,
      archiveDir,
    });
    const lines2 = readFileSync(indexPath, "utf-8").trim().split("\n");
    assert.equal(lines1.length, lines2.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture: manifest 行为身份缺失 → fail-closed 不落盘", () => {
  const root = makeTempRoot();
  try {
    makeWorkspace(root, "ws-cap2");
    const manifest = makeManifest("rel-old-001", "frozen");
    delete manifest.bundleId;
    const archiveDir = join(root, "fixtures");
    // 预建归档目录：fail-closed 时 capture 不应创建任何文件（含目录）
    mkdirSync(archiveDir, { recursive: true });
    const result = captureEvalFixture({
      projectRoot: root,
      workspaceId: "ws-cap2",
      chapterNumber: 1,
      chapterId: "chapter-001",
      chapterTitle: "第一章",
      replayMode: "stub",
      manifest,
      archiveDir,
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.rule === "manifest_identity_incomplete"));
    assert.equal(readdirSync(archiveDir).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture: workspace 不存在 → fail-closed", () => {
  const root = makeTempRoot();
  try {
    const result = captureEvalFixture({
      projectRoot: root,
      workspaceId: "ghost",
      chapterNumber: 1,
      chapterId: "chapter-001",
      chapterTitle: "第一章",
      replayMode: "stub",
      manifest: makeManifest("rel-x", "frozen"),
      archiveDir: join(root, "fixtures"),
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.rule === "workspace_not_found"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture: 第 2 章缺前章 NarrativeState → 校验错误", () => {
  const root = makeTempRoot();
  try {
    makeWorkspace(root, "ws-cap3", { skipNarrativeState: true });
    const result = captureEvalFixture({
      projectRoot: root,
      workspaceId: "ws-cap3",
      chapterNumber: 2,
      chapterId: "chapter-002",
      chapterTitle: "第二章",
      replayMode: "stub",
      manifest: makeManifest("rel-y", "frozen"),
      archiveDir: join(root, "fixtures"),
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.rule === "missing_prior_state"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture: 只读性 — 源 workspace 文件采集后不变", () => {
  const root = makeTempRoot();
  try {
    const ws = makeWorkspace(root, "ws-ro");
    const configPath = join(ws, "config.json");
    const before = readFileSync(configPath, "utf-8");
    captureEvalFixture({
      projectRoot: root,
      workspaceId: "ws-ro",
      chapterNumber: 2,
      chapterId: "chapter-002",
      chapterTitle: "第二章",
      replayMode: "stub",
      manifest: makeManifest("rel-ro", "frozen"),
      archiveDir: join(root, "fixtures"),
    });
    assert.equal(readFileSync(configPath, "utf-8"), before);
    // 无新增生产面文件（chapters 目录仅原有 chapter-001.md）
    assert.deepEqual(readdirSync(join(ws, "chapters")), ["chapter-001.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// eval-evidence-gate 单元测试
// ============================================================================

test("gate: evalRunRoot 缺失 → insufficient (EVAL_EVIDENCE_MISSING)", () => {
  const gate = evaluateEvalEvidenceGate({
    releaseId: "rel-z",
    bundleId: "bundle-z",
    changeClass: "R1",
    evalRunRoot: null,
  });
  assert.equal(gate.verdict, "insufficient");
  assert.equal(gate.code, "EVAL_EVIDENCE_MISSING");
});

test("gate: 合法 stub run 但 R1 无四臂 → EVAL_EVIDENCE_MATRIX_MISSING", () => {
  const root = makeTempRoot();
  try {
    const { runRoot: evalRunRoot } = makeEvalRunRoot(root, "rel-ok", "bundle-ok");
    const gate = evaluateEvalEvidenceGate({
      releaseId: "rel-ok",
      bundleId: "bundle-ok",
      changeClass: "R1",
      evalRunRoot,
    });
    assert.equal(gate.verdict, "insufficient", gate.reason);
    assert.equal(gate.code, "EVAL_EVIDENCE_MATRIX_MISSING");
    assert.equal(gate.evidence.deterministicGradePassed, true);
    assert.equal(gate.evidence.matrixReportFound, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: release 不匹配 → rejected（证据不可跨 release 复用）", () => {
  const root = makeTempRoot();
  try {
    const { runRoot: evalRunRoot } = makeEvalRunRoot(root, "rel-a", "bundle-a");
    const gate = evaluateEvalEvidenceGate({
      releaseId: "rel-b",
      bundleId: "bundle-a",
      changeClass: "R1",
      evalRunRoot,
    });
    assert.equal(gate.verdict, "rejected");
    assert.equal(gate.code, "EVAL_EVIDENCE_RELEASE_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: bundle 不匹配 → rejected", () => {
  const root = makeTempRoot();
  try {
    const { runRoot: evalRunRoot } = makeEvalRunRoot(root, "rel-a", "bundle-a");
    const gate = evaluateEvalEvidenceGate({
      releaseId: "rel-a",
      bundleId: "bundle-other",
      changeClass: "R1",
      evalRunRoot,
    });
    assert.equal(gate.verdict, "rejected");
    assert.equal(gate.code, "EVAL_EVIDENCE_BUNDLE_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: manifest.json 缺失 → insufficient (MANIFEST_INVALID)", () => {
  const root = makeTempRoot();
  try {
    mkdirSync(join(root, "empty-run"), { recursive: true });
    const gate = evaluateEvalEvidenceGate({
      releaseId: "rel-a",
      bundleId: "bundle-a",
      changeClass: "R1",
      evalRunRoot: join(root, "empty-run"),
    });
    assert.equal(gate.verdict, "insufficient");
    assert.equal(gate.code, "EVAL_EVIDENCE_MANIFEST_INVALID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: deterministic 失败（trace 缺失）→ rejected", () => {
  const root = makeTempRoot();
  try {
    const { runRoot: evalRunRoot } = makeEvalRunRoot(root, "rel-f", "bundle-f");
    // 破坏 trace 归档
    rmSync(join(evalRunRoot, "samples"), { recursive: true, force: true });
    const gate = evaluateEvalEvidenceGate({
      releaseId: "rel-f",
      bundleId: "bundle-f",
      changeClass: "R1",
      evalRunRoot,
    });
    assert.equal(gate.verdict, "rejected");
    assert.equal(gate.code, "EVAL_EVIDENCE_DETERMINISTIC_FAILED");
    assert.ok(gate.evidence.failedChecks.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: R3 无 matrix → insufficient；两字段伪造 → MATRIX_INVALID；生成四臂矩阵 → approved", () => {
  const root = makeTempRoot();
  try {
    const { runRoot: evalRunRoot } = makeEvalRunRoot(root, "rel-r3", "bundle-r3");
    const missing = evaluateEvalEvidenceGate({
      releaseId: "rel-r3",
      bundleId: "bundle-r3",
      changeClass: "R3",
      evalRunRoot,
    });
    assert.equal(missing.verdict, "insufficient");
    assert.equal(missing.code, "EVAL_EVIDENCE_MATRIX_MISSING");

    writeFileSync(
      join(evalRunRoot, "matrix-report.json"),
      JSON.stringify({ verdict: "pass", candidatePassPow3: 1 }),
    );
    const forged = evaluateEvalEvidenceGate({
      releaseId: "rel-r3",
      bundleId: "bundle-r3",
      changeClass: "R3",
      evalRunRoot,
    });
    assert.equal(forged.verdict, "rejected");
    assert.equal(forged.code, "EVAL_EVIDENCE_MATRIX_INVALID");

    const generated = writeGeneratedPassingMatrix(evalRunRoot, "rel-r3", "bundle-r3");
    assert.equal(generated.schemaId, "pinovel.eval-replay-matrix");
    assert.equal(generated.verdict, "pass");
    assert.equal(generated.candidatePassPow3, 1);
    assert.match(generated.reportHash, /^[0-9a-f]{64}$/);
    assert.equal(generated.arms.length, 4);

    const ok = evaluateEvalEvidenceGate({
      releaseId: "rel-r3",
      bundleId: "bundle-r3",
      changeClass: "R3",
      evalRunRoot,
    });
    assert.equal(ok.verdict, "approved", ok.reason);
    assert.equal(ok.evidence.matrixRecomputed, true);

    const tampered = JSON.parse(readFileSync(join(evalRunRoot, "matrix-report.json"), "utf-8"));
    tampered.arms.find((a) => a.armId === "candidate").perSamplePass = [true, false, true];
    tampered.verdict = "pass";
    tampered.candidatePassPow3 = 1;
    tampered.reportHash = computeMatrixReportHash(tampered);
    writeFileSync(join(evalRunRoot, "matrix-report.json"), JSON.stringify(tampered, null, 2));
    const recomputedReject = evaluateEvalEvidenceGate({
      releaseId: "rel-r3",
      bundleId: "bundle-r3",
      changeClass: "R3",
      evalRunRoot,
    });
    assert.equal(recomputedReject.verdict, "rejected");
    assert.ok(
      recomputedReject.code === "EVAL_EVIDENCE_MATRIX_REJECTED" ||
        recomputedReject.code === "EVAL_EVIDENCE_PASS_POW3_UNSATISFIED",
      recomputedReject.code,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: baseline production_like modelCalls 与 trace 不一致 → ARM_GRADER_FAILED", () => {
  const root = makeTempRoot();
  try {
    const { runRoot: evalRunRoot } = makeEvalRunRoot(root, "rel-arm-g", "bundle-arm-g");
    const generated = writeGeneratedPassingMatrix(evalRunRoot, "rel-arm-g", "bundle-arm-g");
    assert.equal(generated.verdict, "pass", generated.verdictReasons.join("；"));

    const lyingRoot = writeLyingProductionLikeArm(evalRunRoot, "rel-arm-g", "bundle-arm-g");
    const armRoots = {};
    for (const arm of generated.arms) {
      armRoots[arm.armId] = arm.runRoot;
    }
    armRoots.baseline = lyingRoot;
    const mixed = generateMatrixReportFromReplayRuns({
      candidateReleaseId: "rel-arm-g",
      candidateBundleId: "bundle-arm-g",
      baselineReleaseId: "rel-arm-g",
      armRunRoots: armRoots,
      codeCommit: "deadbeefcafebabe0123456789abcdef01234567",
    });
    assert.equal(mixed.verdict, "reject", "生成器必须因 baseline grader 失败而 reject");
    assert.ok(
      mixed.verdictReasons.some((reason) => /baseline/.test(reason) && /Grader/.test(reason)),
      mixed.verdictReasons.join("；"),
    );

    mixed.verdict = "pass";
    mixed.verdictReasons = [];
    mixed.reportHash = computeMatrixReportHash(mixed);
    writeMatrixReport(evalRunRoot, mixed);

    const gate = evaluateEvalEvidenceGate({
      releaseId: "rel-arm-g",
      bundleId: "bundle-arm-g",
      changeClass: "R1",
      evalRunRoot,
    });
    assert.equal(gate.verdict, "rejected", gate.reason);
    assert.equal(gate.code, "EVAL_EVIDENCE_ARM_GRADER_FAILED");
    assert.ok(gate.evidence.armGraderFailures.some((item) => /baseline/.test(item)), gate.reason);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: R0/R1 无四臂 → MATRIX_MISSING；完整四臂 + pass^3=1 → approved", () => {
  const root = makeTempRoot();
  try {
    for (const changeClass of ["R0", "R1"]) {
      const { runRoot: evalRunRoot } = makeEvalRunRoot(
        root,
        `rel-${changeClass.toLowerCase()}`,
        `bundle-${changeClass.toLowerCase()}`,
        { runDirName: `eval-${changeClass}` },
      );
      const missing = evaluateEvalEvidenceGate({
        releaseId: `rel-${changeClass.toLowerCase()}`,
        bundleId: `bundle-${changeClass.toLowerCase()}`,
        changeClass,
        evalRunRoot,
      });
      assert.equal(missing.verdict, "insufficient", changeClass);
      assert.equal(missing.code, "EVAL_EVIDENCE_MATRIX_MISSING", changeClass);

      writeGeneratedPassingMatrix(
        evalRunRoot,
        `rel-${changeClass.toLowerCase()}`,
        `bundle-${changeClass.toLowerCase()}`,
      );
      const ok = evaluateEvalEvidenceGate({
        releaseId: `rel-${changeClass.toLowerCase()}`,
        bundleId: `bundle-${changeClass.toLowerCase()}`,
        changeClass,
        evalRunRoot,
      });
      assert.equal(ok.verdict, "approved", `${changeClass}: ${ok.reason}`);
      assert.equal(ok.evidence.matrixRecomputed, true);
      assert.equal(ok.evidence.candidatePassPow3, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: 强制级别策略 — R0/R1/R2/R3 全部 mandatory 且一律要求四臂", () => {
  assert.equal(resolveEvalEvidenceEnforcement("R3"), "mandatory");
  assert.equal(resolveEvalEvidenceEnforcement("R2"), "mandatory");
  assert.equal(resolveEvalEvidenceEnforcement("R1"), "mandatory");
  assert.equal(resolveEvalEvidenceEnforcement("R0"), "mandatory");
  for (const changeClass of ["R0", "R1", "R2", "R3"]) {
    assert.equal(matrixEvidenceRequired(changeClass), true, changeClass);
  }
});

test("gate: 回放 CLI 成功判定必须包含 grader + P6，不能只看 completed/isolation", () => {
  const weak = evaluateReplayCliSuccess({
    allCompleted: true,
    isolationViolationCount: 0,
    traceRetentionRate: 1,
    unclassifiedCount: 0,
    gradePassed: false,
    evalGateVerdict: "approved",
  });
  assert.equal(weak.ok, false);
  assert.ok(weak.reasons.some((r) => r.includes("grader")));

  const noGate = evaluateReplayCliSuccess({
    allCompleted: true,
    isolationViolationCount: 0,
    traceRetentionRate: 1,
    unclassifiedCount: 0,
    gradePassed: true,
    evalGateVerdict: "insufficient",
  });
  assert.equal(noGate.ok, false);
  assert.ok(noGate.reasons.some((r) => /eval.?gate|P6|evidence/i.test(r)));

  const unclassified = evaluateReplayCliSuccess({
    allCompleted: true,
    isolationViolationCount: 0,
    traceRetentionRate: 1,
    unclassifiedCount: 1,
    gradePassed: true,
    evalGateVerdict: "approved",
  });
  assert.equal(unclassified.ok, false);

  const ok = evaluateReplayCliSuccess({
    allCompleted: true,
    isolationViolationCount: 0,
    traceRetentionRate: 1,
    unclassifiedCount: 0,
    gradePassed: true,
    evalGateVerdict: "approved",
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.reasons, []);
});

test("gate: production_like 在 modelCalls=0 / devMode / 身份缺失 / 路由漂移时 fail-closed", () => {
  const base = {
    allCompleted: true,
    isolationViolationCount: 0,
    traceRetentionRate: 1,
    unclassifiedCount: 0,
    gradePassed: true,
    evalGateVerdict: "approved",
    replayMode: "production_like",
    expectedRelease: {
      releaseId: "rel-prod-116",
      environmentFingerprint: "fp-116",
      approvalRef: "apr-116",
      bundleId: "bundle-116",
      modelVersion: "gemini-3.1-pro-preview",
    },
  };
  const zeroCalls = evaluateReplayCliSuccess({ ...base, modelCalls: 0 });
  assert.equal(zeroCalls.ok, false);
  assert.ok(zeroCalls.reasons.some((r) => r.includes("modelCalls")));

  const devMode = evaluateReplayCliSuccess({
    ...base,
    modelCalls: 3,
    releaseIdentity: {
      devMode: true,
      releaseId: "rel-prod-116",
      environmentFingerprint: "fp-116",
      approvalRef: "apr-116",
      bundleId: "bundle-116",
      modelVersion: "gemini-3.1-pro-preview",
    },
  });
  assert.equal(devMode.ok, false);
  assert.ok(devMode.reasons.some((r) => r.includes("devMode")));

  const missingIdentity = evaluateReplayCliSuccess({
    ...base,
    modelCalls: 3,
    releaseIdentity: null,
  });
  assert.equal(missingIdentity.ok, false);
  assert.ok(missingIdentity.reasons.some((r) => r.includes("身份")));

  const drifted = evaluateReplayCliSuccess({
    ...base,
    modelCalls: 3,
    unauthorizedCrossModelCount: 1,
    modelCallsByProvider: { glm: 3 },
    modelCallsByRequestedRoute: { narrator_testing_glm: 3 },
    releaseIdentity: {
      devMode: false,
      releaseId: "rel-prod-116",
      environmentFingerprint: "fp-116",
      approvalRef: "apr-116",
      bundleId: "bundle-116",
      modelVersion: "gemini-3.1-pro-preview",
    },
  });
  assert.equal(drifted.ok, false);
  assert.ok(drifted.reasons.some((r) => /漂移|unauthorized/.test(r)));

  const pass = evaluateReplayCliSuccess({
    ...base,
    modelCalls: 3,
    unauthorizedCrossModelCount: 0,
    modelCallsByProvider: { gemini31: 3 },
    modelCallsByRequestedRoute: {
      v2_rawstage2_gemini31: 1,
      v2_amplified_gemini31: 2,
    },
    releaseIdentity: {
      devMode: false,
      releaseId: "rel-prod-116",
      environmentFingerprint: "fp-116",
      approvalRef: "apr-116",
      bundleId: "bundle-116",
      modelVersion: "gemini-3.1-pro-preview",
    },
  });
  assert.equal(pass.ok, true, JSON.stringify(pass.reasons));
});

test("gate: 待审批报告落盘（不执行状态迁移）", () => {
  const root = makeTempRoot();
  try {
    const { runRoot: evalRunRoot } = makeEvalRunRoot(root, "rel-rep", "bundle-rep");
    writeGeneratedPassingMatrix(evalRunRoot, "rel-rep", "bundle-rep");
    const gate = evaluateEvalEvidenceGate({
      releaseId: "rel-rep",
      bundleId: "bundle-rep",
      changeClass: "R1",
      evalRunRoot,
    });
    const reportPath = writeEvalPendingReviewReport({
      releasesDir: join(root, "releases"),
      releaseId: "rel-rep",
      gate,
      changeClass: "R1",
    });
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    assert.equal(report.schemaId, "pinovel.eval-pending-review");
    assert.equal(report.verdict, "approved");
    assert.equal(report.nextAction, "human_review_required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// CLI 集成测试
// ============================================================================

test("CLI eval-capture: 合法输入 → 冻结成功 exit 0", () => {
  const root = makeTempRoot();
  try {
    makeWorkspace(root, "ws-cli");
    const releasesDir = join(root, "releases");
    const registry = createEvolutionReleaseRegistry({ releasesDir });
    registry.writeManifest(makeManifest("rel-cli-001", "frozen"));
    const archiveDir = join(root, "fixtures");

    const result = runCli(
      [
        "eval-capture",
        "--release-id", "rel-cli-001",
        "--workspace-id", "ws-cli",
        "--chapter-number", "2",
        "--archive-dir", archiveDir,
      ],
      { PINOVEL_EVOLUTION_ROOT: root, PINOVEL_PROJECT_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /fixture 已冻结/);
    const files = readdirSync(archiveDir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI eval-capture: release 不存在 → exit 3", () => {
  const root = makeTempRoot();
  try {
    const result = runCli(
      [
        "eval-capture",
        "--release-id", "rel-ghost",
        "--workspace-id", "ws",
        "--chapter-number", "1",
        "--archive-dir", join(root, "fixtures"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root, PINOVEL_PROJECT_ROOT: root },
    );
    assert.equal(result.code, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI eval-gate: 证据通过 → exit 0 + 待审批报告；缺失 → exit 1", () => {
  const root = makeTempRoot();
  try {
    const releasesDir = join(root, "releases");
    const registry = createEvolutionReleaseRegistry({ releasesDir });
    registry.writeManifest(makeManifest("rel-gate-001", "candidate_prod", { approvalRef: "apr-1" }));
    const { runRoot } = makeEvalRunRoot(root, "rel-gate-001", "bundle-test-001");
    writeGeneratedPassingMatrix(runRoot, "rel-gate-001", "bundle-test-001");

    // 通过
    const ok = runCli(
      ["eval-gate", "--release-id", "rel-gate-001", "--eval-run-root", runRoot],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(ok.code, 0, `stderr: ${ok.stderr}`);
    assert.match(ok.stdout, /APPROVED/);
    assert.ok(
      existsSync(join(releasesDir, "rel-gate-001", "eval-pending-review.json")),
    );

    // 缺失
    const missing = runCli(
      ["eval-gate", "--release-id", "rel-gate-001", "--eval-run-root", join(root, "no-such-run")],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(missing.code, 1);
    assert.match(missing.stderr + missing.stdout, /EVAL_EVIDENCE_MISSING/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI eval-gate: rejected + --hold-on-reject → hold 且不切 pointer", () => {
  const root = makeTempRoot();
  try {
    const releasesDir = join(root, "releases");
    const registry = createEvolutionReleaseRegistry({ releasesDir });
    registry.writeManifest(
      makeManifest("rel-hold-001", "active_dev", { approvalRef: "apr-1" }),
    );
    const store = createReleasePointerStore({ configDir: root });
    store.switchActive("development", "rel-hold-001", { actor: "user", reason: "test" });

    // release 不匹配 → rejected → hold
    const { runRoot } = makeEvalRunRoot(root, "rel-other", "bundle-other");
    const result = runCli(
      [
        "eval-gate",
        "--release-id", "rel-hold-001",
        "--eval-run-root", runRoot,
        "--hold-on-reject",
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 1);
    assert.match(result.stdout, /REJECTED/);

    const manifest = registry.loadManifest("rel-hold-001");
    assert.equal(manifest.status, "held");
    // pointer 未被 eval-gate 触碰
    assert.equal(store.readActive("development")?.releaseId, "rel-hold-001");
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI promote: R3 active_prod 缺 eval 证据 → EVAL_EVIDENCE_REQUIRED exit 5", () => {
  const root = makeTempRoot();
  try {
    const releasesDir = join(root, "releases");
    const registry = createEvolutionReleaseRegistry({ releasesDir });
    registry.writeManifest(
      makeManifest("rel-r3-001", "candidate_prod", {
        approvalRef: "apr-r3",
        changeClass: "R3",
      }),
    );
    writeMatchingStateEvent(root, "rel-r3-001", "candidate_prod");
    writeStubApproval(
      root,
      "rel-r3-001",
      "apr-r3",
      makeManifest("rel-r3-001", "candidate_prod", {
        approvalRef: "apr-r3",
        changeClass: "R3",
      }),
    );
    const result = runCli(
      [
        "promote",
        "--release-id", "rel-r3-001",
        "--target", "active_prod",
        "--confirm-prod",
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5);
    assert.match(result.stderr, /EVAL_EVIDENCE_REQUIRED/);

    // pointer 未切换
    const store = createReleasePointerStore({ configDir: root });
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI promote: R1 active_prod 无 eval 证据 → EVAL_EVIDENCE_REQUIRED exit 5", () => {
  const root = makeTempRoot();
  try {
    const releasesDir = join(root, "releases");
    const registry = createEvolutionReleaseRegistry({ releasesDir });
    registry.writeManifest(
      makeManifest("rel-r1-001", "candidate_prod", {
        approvalRef: "apr-r1",
        changeClass: "R1",
      }),
    );
    writeMatchingStateEvent(root, "rel-r1-001", "candidate_prod");
    writeStubApproval(
      root,
      "rel-r1-001",
      "apr-r1",
      makeManifest("rel-r1-001", "candidate_prod", {
        approvalRef: "apr-r1",
        changeClass: "R1",
      }),
    );
    const result = runCli(
      [
        "promote",
        "--release-id", "rel-r1-001",
        "--target", "active_prod",
        "--confirm-prod",
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /EVAL_EVIDENCE_REQUIRED/);
    const store = createReleasePointerStore({ configDir: root });
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI promote: R1 active_prod 提供非法 eval root → fail-closed exit 5", () => {
  const root = makeTempRoot();
  try {
    const releasesDir = join(root, "releases");
    const registry = createEvolutionReleaseRegistry({ releasesDir });
    registry.writeManifest(
      makeManifest("rel-r1b-001", "candidate_prod", {
        approvalRef: "apr-r1b",
        changeClass: "R1",
      }),
    );
    writeMatchingStateEvent(root, "rel-r1b-001", "candidate_prod");
    writeStubApproval(
      root,
      "rel-r1b-001",
      "apr-r1b",
      makeManifest("rel-r1b-001", "candidate_prod", {
        approvalRef: "apr-r1b",
        changeClass: "R1",
      }),
    );
    const result = runCli(
      [
        "promote",
        "--release-id", "rel-r1b-001",
        "--target", "active_prod",
        "--confirm-prod",
        "--eval-evidence-root", join(root, "bogus-run"),
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5);
    assert.match(result.stderr, /EVAL_EVIDENCE_REQUIRED/);

    const store = createReleasePointerStore({ configDir: root });
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
