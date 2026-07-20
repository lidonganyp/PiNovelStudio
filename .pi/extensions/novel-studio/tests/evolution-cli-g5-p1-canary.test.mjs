/**
 * EVOLUTION-RELEASE-GOVERNANCE-G5 P1 — evolution:canary CLI 测试（RED）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §G5 line 380-395
 * 计划：.trae/documents/g5-p1-bounded-canary-implementation-plan.md §CLI 子命令
 *
 * G5 P1 CLI 子命令：
 *   evolution:canary --release-id <id> --workspace <path>
 *     打印 canary 决策（evaluate，默认模式）
 *   evolution:canary --release-id <id> --workspace <path> --apply
 *     执行决策（写 trace + 可选 G8 auto-hold）
 *   evolution:canary --release-id <id> --workspace <path> --status
 *     查看 release 的 canary 运行历史
 *   evolution:canary --release-id <id> --workspace <path> --authorize --auth-file <path> | --auth-json '<json>'
 *     写入 workspace 级 canary 授权
 *
 * 退出码：0 成功 / 2 参数错误 / 3 release 不存在 / 4 状态不合法 / 5 操作失败 / 6 未授权
 *
 * RED 状态：cmdCanary 尚未实现，CLI dispatch 走 default 分支 → exit 1（"未知子命令：canary"），
 * 所有测试因期望 exit 0/2/3/4/5/6 但实际 exit 1 而失败。
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不生成章节正文、不提交长期状态
 * - 复用 G8 governance 模块（evaluator / actions / aggregator）
 * - 不修改 evolution-release-registry / release-pointer-store / chapter-proxy-approval-registry
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";
import { createChapterProxyApprovalRegistry } from "../dist-test/v2/governance/chapter-proxy-approval-registry.js";
import { recordProxyApprovalFeedback } from "../dist-test/v2/governance/chapter-proxy-approval-feedback-recorder.js";
import {
  CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
  CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION,
} from "../dist-test/v2/governance/chapter-proxy-approval-types.js";
import {
  CANARY_AUTHORIZATION_SCHEMA_ID,
  CANARY_AUTHORIZATION_SCHEMA_VERSION,
} from "../dist-test/v2/governance/canary-workspace-authorization.js";
import { createCanaryTraceStore } from "../dist-test/v2/governance/canary-trace-store.js";
import {
  CANARY_RUN_TRACE_SCHEMA_ID,
  CANARY_RUN_TRACE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/canary-trace-store.js";

// ============================================================================
// helpers
// ============================================================================

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "..", "scripts", "evolution-cli.mjs");
const EXT_ROOT = join(__dirname, "..");

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "evolution-cli-g5p1-"));
}

function makeTempWorkspace(workspaceId = "ws-test") {
  const projectRoot = mkdtempSync(join(tmpdir(), "g5p1-ws-"));
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(join(workspacePath, "chapter-approvals"), { recursive: true });
  mkdirSync(join(workspacePath, "traces"), { recursive: true });
  return { projectRoot, workspaceId, workspacePath };
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
    changeClass: opts.changeClass ?? "R2",
    claims: opts.claims ?? ["test-claim"],
    environmentFingerprint: "fp-test-hash",
    artifactRefs: [],
    approvalRef: opts.approvalRef ?? null,
    createdAt: "2026-07-17T00:00:00.000Z",
    activatedAt: null,
  };
}

function setupReleases(root, manifests) {
  const releasesDir = join(root, "releases");
  const registry = createEvolutionReleaseRegistry({ releasesDir });
  for (const m of manifests) {
    registry.writeManifest(m);
  }
  return registry;
}

function makeRegistry(root) {
  return createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
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
    rationale: "stub approval for test",
    decidedAt: "2026-07-17T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 300000 },
    changeClass: manifest.changeClass ?? "R2",
    r3SelfApproval: false,
  };
  registry.writeArtifact(artifact);
  return artifact;
}

function makeChapterApproval(overrides = {}) {
  return {
    schemaId: CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
    schemaVersion: CHAPTER_PROXY_APPROVAL_SCHEMA_VERSION,
    approvalId: overrides.approvalId ?? "cpa-001",
    releaseId: overrides.releaseId ?? "rel-001",
    workspaceId: overrides.workspaceId ?? "ws-test",
    chapterId: overrides.chapterId ?? "1",
    candidateIds: ["cand-raw", "cand-editorial"],
    anonymousMapping: {
      forward: { A: "cand-raw", B: "cand-editorial" },
      reverse: { A: "cand-editorial", B: "cand-raw" },
      seed: 12345,
    },
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    finalStatus: "PROXY_APPROVED",
    recommendedCandidateId: "cand-editorial",
    recommendedSource: "editorial",
    winningSpans: [],
    losingSpans: [],
    risks: [],
    rationale: "stub chapter approval for test",
    reviewerType: "validated_human_proxy",
    reviewerModel: "gpt5.6-sol",
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    promptHash: "stub-prompt-hash",
    inputArtifactHash: "stub-input-hash",
    decidedAt: "2026-07-17T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 300000 },
    ...overrides,
  };
}

function writeChapterApproval(workspacePath, artifact) {
  const registry = createChapterProxyApprovalRegistry({
    approvalsDir: join(workspacePath, "chapter-approvals"),
  });
  registry.writeArtifact(artifact);
}

function makeFeedback(overrides = {}) {
  return {
    timestamp: overrides.timestamp ?? "2026-07-17T00:00:00.000Z",
    approvalId: overrides.approvalId ?? "cpa-001",
    chapterId: overrides.chapterId ?? "1",
    workspaceId: overrides.workspaceId ?? "ws-test",
    action: overrides.action ?? "accept",
    proxyJudgmentBias: overrides.proxyJudgmentBias ?? {
      proxyRecommendedSource: "editorial",
      userAcceptedSource: "editorial",
      aligned: true,
    },
    ...overrides,
  };
}

function writeFeedback(workspacePath, feedback) {
  recordProxyApprovalFeedback({ workspacePath, feedback });
}

function writeBulkFeedback(workspacePath, approvalId, chapterId, alignedCount, misalignedCount) {
  let idx = 0;
  for (let i = 0; i < alignedCount; i++) {
    writeFeedback(workspacePath, makeFeedback({
      timestamp: `2026-07-17T00:00:${String(idx).padStart(2, "0")}.000Z`,
      approvalId, chapterId,
      proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "editorial", aligned: true },
    }));
    idx++;
  }
  for (let i = 0; i < misalignedCount; i++) {
    writeFeedback(workspacePath, makeFeedback({
      timestamp: `2026-07-17T00:01:${String(idx).padStart(2, "0")}.000Z`,
      approvalId, chapterId,
      proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "raw", aligned: false },
    }));
    idx++;
  }
}

/** 写入 canary-authorization.json 到 workspace。 */
function writeCanaryAuthorization(workspacePath, overrides = {}) {
  const auth = {
    schemaId: CANARY_AUTHORIZATION_SCHEMA_ID,
    schemaVersion: CANARY_AUTHORIZATION_SCHEMA_VERSION,
    authorizationId: "cauth-001",
    workspaceId: "ws-test",
    allowedReleaseIds: ["rel-001"],
    budget: { maxChapters: 5, maxCalls: 10 },
    issuedAt: "2026-07-17T00:00:00.000Z",
    expiresAt: "2026-12-31T00:00:00.000Z",
    issuer: "test-issuer",
    notes: "test authorization",
    ...overrides,
  };
  const authPath = join(workspacePath, "canary-authorization.json");
  writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\n", "utf-8");
  return authPath;
}

/** 手动写一条 canary trace（用于 status 测试）。 */
function writeCanaryTrace(workspacePath, overrides = {}) {
  const traceStore = createCanaryTraceStore({ canaryRunsDir: join(workspacePath, "canary-runs") });
  const trace = {
    schemaId: CANARY_RUN_TRACE_SCHEMA_ID,
    schemaVersion: CANARY_RUN_TRACE_SCHEMA_VERSION,
    runId: "canary-rel-001-test-001",
    releaseId: "rel-001",
    previousReleaseId: null,
    workspaceId: "ws-test",
    startedAt: "2026-07-17T00:00:00.000Z",
    completedAt: null,
    strategy: "bounded_canary",
    status: "canary_started",
    healthSnapshot: {
      status: "healthy",
      alignmentRate: 0.85,
      sampleCount: 5,
      rollbackRate: 0.0,
      consecutiveNegative: 0,
    },
    evidence: { changeClass: "R2", currentStatus: "active_dev" },
    outcome: { promoted: false, heldByAutoHold: false },
    shadowPendingRealRun: true,
    ...overrides,
  };
  traceStore.writeCanaryTrace(trace);
  return trace;
}

function writeCompletionResult(workspacePath, sourceTrace, manifest, overrides = {}) {
  // P0 修复后：artifact 必须是真实 chapter trace（traces/{chapterId}-quality-trace.json），
  // 含 gates[].stage === "v2_final_selected" + evidence.modelCalls 数组，
  // 且 observedChapters/observedCalls 与 trace 内容一致。
  // 写入 5 个 chapter trace，每个含 2 次 modelCalls → observedChapters=5, observedCalls=10。
  mkdirSync(join(workspacePath, "traces"), { recursive: true });
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
  const trace = {
    ...sourceTrace,
    runId: `${sourceTrace.runId}-completed`,
    completedAt: "2026-07-17T00:10:00.000Z",
    status: "completed",
    evidence: {
      ...sourceTrace.evidence,
      sourceRunId: sourceTrace.runId,
      environmentFingerprint: manifest.environmentFingerprint,
      approvalRef: manifest.approvalRef,
      verdict: "pass",
      observedChapters: 5,
      observedCalls: 10,
      resultArtifactRefs,
      resultArtifactHashes,
    },
    shadowPendingRealRun: false,
    ...overrides,
  };
  const resultFile = join(workspacePath, "canary-completion-input.json");
  writeFileSync(resultFile, JSON.stringify(trace, null, 2) + "\n", "utf-8");
  return { trace, resultFile };
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

// ============================================================================
// 1. evaluate（默认模式）：R1 + insufficient_data → direct_promote
// ============================================================================

test("1. canary evaluate：R1 + insufficient_data → direct_promote（exit 0）", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { changeClass: "R1", approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);
    // 无 feedback → insufficient_data

    const result = runCli(
      ["canary", "--release-id", "rel-001", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /direct_promote/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. evaluate：R2 + insufficient_data → shadow_required
// ============================================================================

test("2. canary evaluate：R2 + insufficient_data → shadow_required（exit 0）", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { changeClass: "R2", approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    const result = runCli(
      ["canary", "--release-id", "rel-001", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /shadow_required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. apply：bounded_canary 无授权 → exit 6
// ============================================================================

test("3. canary apply：bounded_canary 无授权 → exit 6", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { changeClass: "R2", approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    // 5 aligned → alignmentRate=1.0 → healthy → R2+healthy=bounded_canary
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeBulkFeedback(workspacePath, "cpa-001", "1", 5, 0);

    // 不写 canary-authorization.json → 无授权

    const result = runCli(
      ["canary", "--release-id", "rel-001", "--workspace", workspacePath, "--apply"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 6, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /REQUIRES_AUTH|未授权/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. apply：bounded_canary 有授权写 trace → exit 0
// ============================================================================

test("4. canary apply：bounded_canary 有授权写 trace → exit 0", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { changeClass: "R2", approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    // 5 aligned → healthy → bounded_canary
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeBulkFeedback(workspacePath, "cpa-001", "1", 5, 0);

    // 写授权
    writeCanaryAuthorization(workspacePath);

    const result = runCli(
      ["canary", "--release-id", "rel-001", "--workspace", workspacePath, "--apply"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /canary_started|bounded_canary/);

    // 验证 trace 已写入
    const traceStore = createCanaryTraceStore({ canaryRunsDir: join(workspacePath, "canary-runs") });
    const traces = traceStore.listCanaryTracesByRelease("rel-001");
    assert.ok(traces.length >= 1, "应至少有一条 canary trace");
    assert.equal(traces[0].status, "canary_started");
    assert.equal(traces[0].shadowPendingRealRun, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. apply：blocked(auto_hold_eligible) → exit 5
// ============================================================================

test("5. canary apply：blocked(auto_hold_eligible) → exit 5 + auto-hold 触发", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { changeClass: "R2", approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    // 1 aligned + 4 misaligned → alignmentRate=0.2 < 0.4 → auto_hold_eligible
    writeChapterApproval(workspacePath, makeChapterApproval({
      approvalId: "cpa-001", releaseId: "rel-001", chapterId: "1",
    }));
    writeBulkFeedback(workspacePath, "cpa-001", "1", 1, 4);

    const result = runCli(
      ["canary", "--release-id", "rel-001", "--workspace", workspacePath, "--apply"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 5, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /blocked|auto_hold/);

    // 验证 release 状态已迁移到 held
    const registry = makeRegistry(root);
    const updated = registry.loadManifest("rel-001");
    assert.equal(updated.status, "held");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. status：查看 canary 运行历史
// ============================================================================

test("6. canary status：打印 canary 运行历史（exit 0）", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { changeClass: "R2", approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    // 手动写一条 trace
    writeCanaryTrace(workspacePath);

    const result = runCli(
      ["canary", "--release-id", "rel-001", "--workspace", workspacePath, "--status"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /canary-rel-001-test-001|bounded_canary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. authorize --auth-file：从文件写入授权
// ============================================================================

test("7. canary authorize --auth-file：写入 canary-authorization.json（exit 0）", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  const tmpAuthDir = mkdtempSync(join(tmpdir(), "canary-auth-src-"));
  try {
    const manifest = makeManifest("rel-001", "active_dev", { changeClass: "R2", approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    // 写入源授权文件
    const authJson = {
      schemaId: CANARY_AUTHORIZATION_SCHEMA_ID,
      schemaVersion: CANARY_AUTHORIZATION_SCHEMA_VERSION,
      authorizationId: "cauth-from-file",
      workspaceId: "ws-test",
      allowedReleaseIds: ["rel-001"],
      budget: { maxChapters: 3, maxCalls: 6 },
      issuedAt: "2026-07-17T00:00:00.000Z",
      expiresAt: "2026-12-31T00:00:00.000Z",
      issuer: "test-issuer",
    };
    const authFile = join(tmpAuthDir, "auth.json");
    writeFileSync(authFile, JSON.stringify(authJson, null, 2), "utf-8");

    const result = runCli(
      ["canary", "--release-id", "rel-001", "--workspace", workspacePath, "--authorize", "--auth-file", authFile],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    // 验证 canary-authorization.json 已写入 workspace
    const writtenPath = join(workspacePath, "canary-authorization.json");
    assert.ok(existsSync(writtenPath), "canary-authorization.json 应存在");
    const written = JSON.parse(readFileSync(writtenPath, "utf-8"));
    assert.equal(written.authorizationId, "cauth-from-file");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(tmpAuthDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. authorize --auth-json：从 inline JSON 写入授权
// ============================================================================

test("8. canary authorize --auth-json：写入 canary-authorization.json（exit 0）", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "active_dev", { changeClass: "R2", approvalRef: "apr-001" });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    const authJson = JSON.stringify({
      schemaId: CANARY_AUTHORIZATION_SCHEMA_ID,
      schemaVersion: CANARY_AUTHORIZATION_SCHEMA_VERSION,
      authorizationId: "cauth-inline",
      workspaceId: "ws-test",
      allowedReleaseIds: ["rel-001"],
      budget: { maxChapters: 3, maxCalls: 6 },
      issuedAt: "2026-07-17T00:00:00.000Z",
      expiresAt: "2026-12-31T00:00:00.000Z",
      issuer: "test-issuer",
    });

    const result = runCli(
      ["canary", "--release-id", "rel-001", "--workspace", workspacePath, "--authorize", "--auth-json", authJson],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const writtenPath = join(workspacePath, "canary-authorization.json");
    assert.ok(existsSync(writtenPath), "canary-authorization.json 应存在");
    const written = JSON.parse(readFileSync(writtenPath, "utf-8"));
    assert.equal(written.authorizationId, "cauth-inline");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 9. 缺 --release-id → exit 2
// ============================================================================

test("9. canary：缺 --release-id → exit 2", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const result = runCli(
      ["canary", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /release-id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 10. release 不存在 → exit 3
// ============================================================================

test("10. canary：release 不存在 → exit 3", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const result = runCli(
      ["canary", "--release-id", "rel-nonexistent", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 3);
    assert.match(result.stderr, /不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 11. release 非 active 状态 → exit 4
// ============================================================================

test("11. canary：release 状态 draft 非 active → exit 4", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "draft", { changeClass: "R2" });
    setupReleases(root, [manifest]);

    const result = runCli(
      ["canary", "--release-id", "rel-001", "--workspace", workspacePath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 4);
    assert.match(result.stderr, /draft|active/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 12. 缺 --workspace → exit 2
// ============================================================================

test("12. canary：缺 --workspace 且无 PINOVEL_WORKSPACE_PATH → exit 2", () => {
  const root = makeTempRoot();
  try {
    const result = runCli(
      ["canary", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root, PINOVEL_WORKSPACE_PATH: "" },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /workspace|PINOVEL_WORKSPACE_PATH/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("13. canary complete：缺 run-id/result-file → exit 2", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "candidate_prod", {
      changeClass: "R2",
      approvalRef: "apr-001",
    });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);

    const result = runCli(
      ["canary", "--release-id", "rel-001", "--workspace", workspacePath, "--complete"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    assert.equal(result.code, 2, `stdout: ${result.stdout}`);
    assert.match(result.stderr, /run-id|result-file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("14. canary complete：无 workspace 授权 → exit 6", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "candidate_prod", {
      changeClass: "R2",
      approvalRef: "apr-001",
    });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);
    const source = writeCanaryTrace(workspacePath, {
      evidence: {
        changeClass: "R2",
        currentStatus: "candidate_prod",
        authorizationId: "cauth-001",
      },
    });
    const completion = writeCompletionResult(workspacePath, source, manifest);

    const result = runCli(
      [
        "canary", "--release-id", "rel-001", "--workspace", workspacePath,
        "--complete", "--run-id", source.runId, "--result-file", completion.resultFile,
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    assert.equal(result.code, 6, `stdout: ${result.stdout}`);
    assert.match(result.stderr, /REQUIRES_AUTH|未授权/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("15. canary complete：sourceRunId 不匹配 → exit 5", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "candidate_prod", {
      changeClass: "R2",
      approvalRef: "apr-001",
    });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);
    writeCanaryAuthorization(workspacePath);
    const source = writeCanaryTrace(workspacePath, {
      evidence: {
        changeClass: "R2",
        currentStatus: "candidate_prod",
        authorizationId: "cauth-001",
      },
    });
    const completion = writeCompletionResult(workspacePath, source, manifest, {
      evidence: {
        ...source.evidence,
        sourceRunId: "canary-other",
        environmentFingerprint: manifest.environmentFingerprint,
        approvalRef: manifest.approvalRef,
        verdict: "pass",
        observedChapters: 5,
        observedCalls: 10,
        resultArtifactRefs: ["reports/real-canary-result.json"],
        resultArtifactHashes: {
          "reports/real-canary-result.json": createHash("sha256")
            .update('{"verdict":"pass","cases":5}\n', "utf-8")
            .digest("hex"),
        },
      },
    });

    const result = runCli(
      [
        "canary", "--release-id", "rel-001", "--workspace", workspacePath,
        "--complete", "--run-id", source.runId, "--result-file", completion.resultFile,
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    assert.equal(result.code, 5, `stdout: ${result.stdout}`);
    assert.match(result.stderr, /sourceRunId|source trace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("16. canary complete：合法真实结果写入 completed trace", () => {
  const root = makeTempRoot();
  const { workspacePath } = makeTempWorkspace();
  try {
    const manifest = makeManifest("rel-001", "candidate_prod", {
      changeClass: "R2",
      approvalRef: "apr-001",
    });
    setupReleases(root, [manifest]);
    writeStubApproval(root, "rel-001", "apr-001", manifest);
    writeCanaryAuthorization(workspacePath);
    const source = writeCanaryTrace(workspacePath, {
      evidence: {
        changeClass: "R2",
        currentStatus: "candidate_prod",
        authorizationId: "cauth-001",
      },
    });
    const completion = writeCompletionResult(workspacePath, source, manifest);

    const result = runCli(
      [
        "canary", "--release-id", "rel-001", "--workspace", workspacePath,
        "--complete", "--run-id", source.runId, "--result-file", completion.resultFile,
      ],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /completed/);
    const stored = createCanaryTraceStore({
      canaryRunsDir: join(workspacePath, "canary-runs"),
    }).readCanaryTrace(completion.trace.runId);
    assert.equal(stored?.status, "completed");
    assert.equal(stored?.shadowPendingRealRun, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
