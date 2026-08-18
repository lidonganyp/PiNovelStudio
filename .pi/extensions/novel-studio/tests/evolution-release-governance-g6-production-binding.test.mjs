/**
 * EVOLUTION-RELEASE-GOVERNANCE-G6 — 生产入口绑定测试
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §Phase G6 / §11
 *
 * G6 要求：
 * - novel_generate_chapter preflight 读取 active production release；
 * - manifest 与当前运行环境不一致时 hard block 或显式进入非生产开发模式；
 * - 未审批策略、prompt 和 dirty build 不得静默进入生产；
 * - trace / stageResults 写入 releaseId/environmentFingerprint/approvalRef；
 * - eval/test 模式不得修改 active pointer（eval 模式跳过 G6 门禁）。
 *
 * 本测试覆盖：
 * 1. gate 模块单元测试（no active release / fingerprint mismatch / match / dev mode / wrong status）
 * 2. runUnifiedPipeline 集成测试（blocked when no active release / populates stageResults）
 * 3. 生产闭包边界测试（dist/v2/governance/ 含门禁模块）
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型（V2_FORCE_STUB=1）
 * - 不修改用户真实治理数据（使用独立临时目录）
 * - 不切换 active pointer（只读取）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import { createReleasePointerStore } from "../dist-test/v2/governance/release-pointer-store.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import {
  PROXY_APPROVAL_SCHEMA_ID,
  PROXY_APPROVAL_SCHEMA_VERSION,
  PROXY_APPROVAL_REVIEWER_MODEL,
} from "../dist-test/v2/governance/release-proxy-approval-types.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";
import {
  evaluateProductionReleaseGate,
  captureDefaultEnvironmentFingerprint,
} from "../dist-test/v2/governance/production-release-gate.js";
import {
  collectDefaultEnvironmentFingerprint,
  computeFingerprintHash,
  DEFAULT_RELEASE_FINGERPRINT_SPEC,
} from "../dist-test/v2/governance/environment-fingerprint.js";
import { captureDefaultBehaviorSnapshot } from "../dist-test/v2/governance/behavior-snapshot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

// ============================================================================
// helpers
// ============================================================================

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "evolution-g6-"));
}

function attachLiveBehaviorIdentity(manifest) {
  const snapshot = captureDefaultBehaviorSnapshot(
    PROJECT_ROOT,
    DEFAULT_RELEASE_FINGERPRINT_SPEC.generationModel,
    "2026-08-01",
  );
  return {
    ...manifest,
    bundleId: snapshot.bundleId,
    modelVersion: snapshot.modelVersion,
    evalProtocolVersion: snapshot.evalProtocolVersion,
    promptBundleHash: snapshot.promptBundleHash,
    modelRoutingHash: snapshot.modelRoutingHash,
    toolSchemaHash: snapshot.toolSchemaHash,
    contextCompilerHash: snapshot.contextCompilerHash,
    qualityPolicyHash: snapshot.qualityPolicyHash,
    recoveryPolicyHash: snapshot.recoveryPolicyHash,
    knowledgeSnapshotHash: snapshot.knowledgeSnapshotHash,
    runtimeFingerprint: snapshot.runtimeFingerprint,
    capabilityPackageSetHash: snapshot.capabilityPackageSetHash,
    strategyEvidencePartition: [],
  };
}

function makeManifest(releaseId, status, fingerprintHash, approvalRef = null, options = {}) {
  return attachLiveBehaviorIdentity({
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status,
    parentReleaseId: "rel-000",
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass: options.changeClass ?? "R1",
    claims: ["g6-test-claim"],
    environmentFingerprint: fingerprintHash,
    artifactRefs: [],
    approvalRef,
    createdAt: "2026-07-16T00:00:00.000Z",
    activatedAt: status === "active_prod" ? "2026-07-16T00:00:00.000Z" : null,
  });
}

function setupReleaseInRoot(root, manifest) {
  const releasesDir = join(root, "releases");
  const registry = createEvolutionReleaseRegistry({ releasesDir });
  // frozen 不可变守护：直接 writeManifest 会拒绝 frozen/active_prod 状态覆盖，
  // 测试场景用 atomicWrite 风格直接写入（registry.writeManifest 对 draft/candidate 可用，
  // 对 frozen 后状态需 transitionStatus；此处测试 manifest 已是终态，用底层写入）。
  mkdirSync(join(releasesDir, manifest.releaseId), { recursive: true });
  writeFileSync(
    join(releasesDir, manifest.releaseId, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
  return registry;
}

function setActiveProduction(root, releaseId, actor = "user", reason = "g6 test") {
  const store = createReleasePointerStore({ configDir: root });
  // 测试场景绕过 manifest resolver（actor=user 即可通过 actor 校验）
  store.switchActive("production", releaseId, { actor, reason });
}

/** 临时清除 PINOVEL_DEV_MODE，返回原值供恢复。 */
function clearDevMode() {
  const prev = process.env.PINOVEL_DEV_MODE;
  delete process.env.PINOVEL_DEV_MODE;
  return prev;
}

function restoreDevMode(prev) {
  if (prev === undefined) {
    delete process.env.PINOVEL_DEV_MODE;
  } else {
    process.env.PINOVEL_DEV_MODE = prev;
  }
}

/**
 * 写入合法审批 artifact 到 {root}/releases/{releaseId}/approvals/{approvalId}.json。
 * P0 第二层修复后，门禁会加载并验证真实 artifact；G6 ok=true 路径必须写入合法 artifact。
 */
function writeLegitApprovalArtifact(root, manifest, overrides = {}) {
  const approvalsDir = join(root, "releases", manifest.releaseId, "approvals");
  mkdirSync(approvalsDir, { recursive: true });
  const registry = createProxyApprovalRegistry({ approvalsDir });
  registry.writeArtifact({
    schemaId: PROXY_APPROVAL_SCHEMA_ID,
    schemaVersion: PROXY_APPROVAL_SCHEMA_VERSION,
    approvalId: manifest.approvalRef,
    releaseId: manifest.releaseId,
    releaseManifestHash: computeReleasePayloadHash(manifest),
    reviewerType: "validated_human_proxy",
    reviewerModel: PROXY_APPROVAL_REVIEWER_MODEL,
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    reviewTransport: "network",
    promptHash: "sha256:prompt-g6-test",
    inputArtifactHash: "sha256:input-g6-test",
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
    finalVerdict: "APPROVE_DEV",
    winningSpans: ["span-win-g6"],
    losingSpans: ["span-lose-g6"],
    risks: [],
    rationale: "g6 production binding test legit approval",
    decidedAt: "2026-07-16T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 60000 },
    changeClass: manifest.changeClass,
    r3SelfApproval: false,
    ...overrides,
  });
}

function writeProductionCanaryEvidence(root, workspacePath, manifest) {
  const workspaceId = "ws-test";
  // P0 修复后：artifact 必须是真实 chapter trace（traces/{chapterId}-quality-trace.json），
  // 含 gates[].stage === "v2_final_selected" + evidence.modelCalls 数组，
  // 且 observedChapters/observedCalls 与 trace 内容一致。
  // 写入 5 个 chapter trace，每个含 2 次 modelCalls → observedChapters=5, observedCalls=10。
  mkdirSync(join(workspacePath, "traces"), { recursive: true });
  mkdirSync(join(workspacePath, "canary-runs"), { recursive: true });
  const chapterIds = ["1", "2", "3", "4", "5"];
  const resultArtifactRefs = [];
  const resultArtifactHashes = {};
  for (const chapterId of chapterIds) {
    const traceDoc = {
      schemaVersion: 1,
      workspaceId,
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
  const sourceRunId = `canary-${manifest.releaseId}-started`;
  const completedRunId = `canary-${manifest.releaseId}-completed`;
  const common = {
    schemaId: "pinovel.canary-run-trace",
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    previousReleaseId: manifest.rollbackReleaseId,
    workspaceId,
    startedAt: "2026-07-17T01:00:00.000Z",
    strategy: "bounded_canary",
    healthSnapshot: {
      status: "healthy",
      alignmentRate: 0.8,
      sampleCount: 5,
      rollbackRate: 0,
      consecutiveNegative: 0,
    },
    outcome: { promoted: false, heldByAutoHold: false },
  };
  const source = {
    ...common,
    runId: sourceRunId,
    completedAt: null,
    status: "canary_started",
    evidence: {
      changeClass: manifest.changeClass,
      currentStatus: "candidate_prod",
      authorizationId: "cauth-001",
    },
    shadowPendingRealRun: true,
  };
  const completed = {
    ...common,
    runId: completedRunId,
    completedAt: "2026-07-17T01:10:00.000Z",
    status: "completed",
    evidence: {
      ...source.evidence,
      sourceRunId,
      environmentFingerprint: manifest.environmentFingerprint,
      approvalRef: manifest.approvalRef,
      verdict: "pass",
      observedChapters: 5,
      observedCalls: 10,
      resultArtifactRefs,
      resultArtifactHashes,
    },
    shadowPendingRealRun: false,
  };
  for (const trace of [source, completed]) {
    writeFileSync(
      join(workspacePath, "canary-runs", `${trace.runId}.json`),
      JSON.stringify(trace, null, 2) + "\n",
      "utf-8",
    );
  }
  createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") }).recordStateEvent({
    eventId: `evt-${manifest.releaseId}-promote-test`,
    releaseId: manifest.releaseId,
    fromStatus: "candidate_prod",
    toStatus: "active_prod",
    reason: "g6 canary evidence test",
    actor: "user",
    evidenceRefs: [`canary:${workspaceId}/${completedRunId}`],
    timestamp: "2026-07-17T01:11:00.000Z",
  });
  // 返回首个 chapter trace 路径供篡改测试使用（P0 修复后 artifact 是真实 chapter trace）
  return { completedRunId, artifactRef: resultArtifactRefs[0] };
}

// ============================================================================
// 1. gate 模块单元测试
// ============================================================================

test("gate: 无 active production release 且非 dev mode → blocked (g6_release_gate)", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const result = evaluateProductionReleaseGate({
      projectRoot: root,
      evolutionRoot: root,
      currentFingerprintHash: "fake-hash",
    });
    assert.equal(result.ok, false, "无 active release 应 blocked");
    assert.equal(result.devMode, false);
    assert.equal(result.failureEnvelope.stage, "g6_release_gate");
    assert.equal(result.failureEnvelope.severity, "preflight");
    assert.equal(result.failureEnvelope.recoverable, false);
    assert.equal(result.failureEnvelope.degradedTo, "hard_block");
    assert.match(
      result.failureEnvelope.reason,
      /no active production release/i,
      `reason 应说明无 active release，实际: ${result.failureEnvelope.reason}`,
    );
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: active release 存在但 fingerprint 不匹配 → blocked", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const manifest = makeManifest("rel-001", "active_prod", "recorded-hash-xxx", "approval-1");
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, "rel-001");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: "different-current-hash-yyy",
    });
    assert.equal(result.ok, false, "fingerprint 不匹配应 blocked");
    assert.equal(result.failureEnvelope.stage, "g6_release_gate");
    assert.match(
      result.failureEnvelope.reason,
      /fingerprint/i,
      `reason 应说明 fingerprint 不匹配，实际: ${result.failureEnvelope.reason}`,
    );
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: active release 存在且 fingerprint 匹配 → ok + 携带 releaseId/fingerprint/approvalRef", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const fpHash = "matched-hash-abc";
    const manifest = makeManifest("rel-001", "active_prod", fpHash, "approval-artifact-1");
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, "rel-001");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });
    assert.equal(result.ok, true, "fingerprint 匹配应 ok");
    assert.equal(result.devMode, false);
    assert.equal(result.releaseId, "rel-001");
    assert.equal(result.environmentFingerprint, fpHash);
    assert.equal(result.approvalRef, "approval-artifact-1");
    assert.ok(result.manifest, "应返回 manifest 引用");
    assert.equal(result.manifest.releaseId, "rel-001");
    assert.equal(result.manifest.status, "active_prod");
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: R2 active_prod 缺少 promote canary 证据事件 → blocked", () => {
  const root = makeTempRoot();
  const workspacePath = join(root, "workspaces", "ws-test");
  const prev = clearDevMode();
  try {
    const fpHash = "matched-r2-hash";
    const manifest = makeManifest("rel-r2", "active_prod", fpHash, "approval-r2", {
      changeClass: "R2",
    });
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, manifest.releaseId);

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      workspacePath,
      currentFingerprintHash: fpHash,
    });

    assert.equal(result.ok, false);
    assert.match(result.failureEnvelope.reason, /canary|证据/i);
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: R2 active_prod 的 completed canary artifact 被篡改 → blocked", () => {
  const root = makeTempRoot();
  const workspacePath = join(root, "workspaces", "ws-test");
  const prev = clearDevMode();
  try {
    const fpHash = "matched-r2-hash";
    const manifest = makeManifest("rel-r2", "active_prod", fpHash, "approval-r2", {
      changeClass: "R2",
    });
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, manifest.releaseId);
    const evidence = writeProductionCanaryEvidence(root, workspacePath, manifest);
    writeFileSync(join(workspacePath, evidence.artifactRef), '{"tampered":true}\n', "utf-8");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      workspacePath,
      currentFingerprintHash: fpHash,
    });

    assert.equal(result.ok, false);
    assert.match(result.failureEnvelope.reason, /hash|artifact|canary/i);
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: R2 active_prod 的 promote 事件与 canary 证据完整 → ok", () => {
  const root = makeTempRoot();
  const workspacePath = join(root, "workspaces", "ws-test");
  const prev = clearDevMode();
  try {
    const fpHash = "matched-r2-hash";
    const manifest = makeManifest("rel-r2", "active_prod", fpHash, "approval-r2", {
      changeClass: "R2",
    });
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, manifest.releaseId);
    const evidence = writeProductionCanaryEvidence(root, workspacePath, manifest);

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      workspacePath,
      currentFingerprintHash: fpHash,
    });

    assert.equal(result.ok, true);
    assert.equal(result.canaryEvidenceRunId, evidence.completedRunId);
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: release canary workspace 与当前生产 workspace 不同仍可复验", () => {
  const root = makeTempRoot();
  const canaryWorkspacePath = join(root, "workspaces", "ws-test");
  const productionWorkspacePath = join(root, "workspaces", "ws-production");
  const prev = clearDevMode();
  try {
    const fpHash = "matched-r2-hash";
    const manifest = makeManifest("rel-r2", "active_prod", fpHash, "approval-r2", {
      changeClass: "R2",
    });
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, manifest.releaseId);
    const evidence = writeProductionCanaryEvidence(root, canaryWorkspacePath, manifest);

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      workspacePath: productionWorkspacePath,
      workspacesRoot: join(root, "workspaces"),
      currentFingerprintHash: fpHash,
    });

    assert.equal(result.ok, true);
    assert.equal(result.canaryEvidenceRunId, evidence.completedRunId);
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: PINOVEL_DEV_MODE=1 + 无 active release → dev bypass (ok, devMode=true)", () => {
  const root = makeTempRoot();
  const prev = process.env.PINOVEL_DEV_MODE;
  process.env.PINOVEL_DEV_MODE = "1";
  try {
    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: "any",
    });
    assert.equal(result.ok, true, "dev mode 应 bypass");
    assert.equal(result.devMode, true);
    assert.equal(result.releaseId, null);
    assert.equal(result.environmentFingerprint, null);
    assert.equal(result.approvalRef, null);
    assert.equal(result.manifest, null);
  } finally {
    if (prev === undefined) delete process.env.PINOVEL_DEV_MODE;
    else process.env.PINOVEL_DEV_MODE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: active release status !== active_prod → blocked (未审批 release 不得生产运行)", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const fpHash = "matched-hash";
    // approved_dev 状态：已通过开发审批但未晋级 active_prod，不得生产运行
    setupReleaseInRoot(root, makeManifest("rel-002", "approved_dev", fpHash, "approval-2"));
    setActiveProduction(root, "rel-002");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });
    assert.equal(result.ok, false, "非 active_prod 状态应 blocked");
    assert.equal(result.failureEnvelope.stage, "g6_release_gate");
    assert.match(
      result.failureEnvelope.reason,
      /active_prod|status/i,
      `reason 应说明状态不合法，实际: ${result.failureEnvelope.reason}`,
    );
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: active pointer 指向不存在的 manifest → blocked", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    // 设置 active pointer 指向 rel-999，但不创建 rel-999 的 manifest
    setActiveProduction(root, "rel-999");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: "any",
    });
    assert.equal(result.ok, false, "manifest 不存在应 blocked");
    assert.equal(result.failureEnvelope.stage, "g6_release_gate");
    assert.match(
      result.failureEnvelope.reason,
      /manifest|不存在/i,
      `reason 应说明 manifest 不存在，实际: ${result.failureEnvelope.reason}`,
    );
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("captureDefaultEnvironmentFingerprint: 返回非空 sha256 hex 字符串", () => {
  const hash = captureDefaultEnvironmentFingerprint(PROJECT_ROOT);
  assert.equal(typeof hash, "string");
  assert.ok(hash.length > 0, "fingerprintHash 应非空");
  assert.match(hash, /^[0-9a-f]{64}$/i, `fingerprintHash 应为 64 位 hex，实际: ${hash}`);
});

test("captureDefaultEnvironmentFingerprint: 实际 model-routing 内容变化必须改变指纹", () => {
  const projectRoot = makeTempRoot();
  try {
    const configDir = join(projectRoot, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "model-routing.json"), '{"_version":"test-a"}\n', "utf-8");
    const firstHash = captureDefaultEnvironmentFingerprint(projectRoot);

    writeFileSync(join(configDir, "model-routing.json"), '{"_version":"test-b"}\n', "utf-8");
    const secondHash = captureDefaultEnvironmentFingerprint(projectRoot);

    assert.notEqual(
      secondHash,
      firstHash,
      "根目录 config/model-routing.json 是运行时真相源，内容变化必须触发生产指纹漂移",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("captureDefaultEnvironmentFingerprint: 使用当前 Gemini 主写生产元数据", () => {
  const projectRoot = makeTempRoot();
  try {
    const configDir = join(projectRoot, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "model-routing.json"), '{"_version":"test"}\n', "utf-8");

    const expectedFingerprint = collectDefaultEnvironmentFingerprint(projectRoot);
    assert.equal(expectedFingerprint.generationModel, "gemini-3.7-flash");
    assert.equal(DEFAULT_RELEASE_FINGERPRINT_SPEC.modelRoutingPath, "config/model-routing.json");
    assert.ok(
      DEFAULT_RELEASE_FINGERPRINT_SPEC.envSwitchNames.includes("PINOVEL_EVAL_REPLAY_TRANSPORT"),
      "默认规格必须包含 eval 传输开关，不能再回退到旧的内联短名单",
    );
    assert.equal(
      captureDefaultEnvironmentFingerprint(projectRoot),
      computeFingerprintHash(expectedFingerprint),
      "默认生产指纹必须绑定实际路由文件与 Gemini 3.7 Flash 主写元数据",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("evolution CLI: capture 与生产门禁使用同一当前路由真相源", () => {
  const cliSource = readFileSync(join(EXT_ROOT, "scripts", "evolution-cli.mjs"), "utf-8");
  const specSource = readFileSync(join(EXT_ROOT, "v2", "governance", "environment-fingerprint.ts"), "utf-8");
  assert.match(cliSource, /collectDefaultEnvironmentFingerprint/);
  assert.match(specSource, /modelRoutingPath:\s*["']config\/model-routing\.json["']/);
  assert.match(specSource, /generationModel:\s*["']gemini-3\.7-flash["']/);
  assert.doesNotMatch(
    specSource,
    /modelRoutingPath:\s*["']\.pi\/extensions\/novel-studio\/config\/model-routing\.json["']/,
  );
});

// ============================================================================
// 2. runUnifiedPipeline 集成测试
// ============================================================================

/**
 * 集成测试通过 dist/ 生产闭包验证 G6 门禁在 novel_generate_chapter 入口生效。
 * 要求先 npm run build:prod（dist/v2/core/unified-entry.js 含门禁调用）。
 */

test("gate blocks a stub approval artifact even when every legacy binding matches", () => {
  const root = makeTempRoot();
  const previousDevMode = clearDevMode();
  try {
    const fingerprint = "sha256:stub-transport-test";
    const manifest = makeManifest("rel-stub-transport", "active_prod", fingerprint, "approval-stub");
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest, { reviewTransport: "stub" });
    setActiveProduction(root, manifest.releaseId);

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fingerprint,
    });
    assert.equal(result.ok, false);
    assert.match(result.failureEnvelope?.reason ?? "", /reviewTransport.*network/i);
  } finally {
    restoreDevMode(previousDevMode);
    rmSync(root, { recursive: true, force: true });
  }
});

async function loadRunUnifiedPipeline() {
  const mod = await import("file://" + join(EXT_ROOT, "dist", "v2", "core", "unified-entry.js"));
  return mod.runUnifiedPipeline;
}

test("integration: runUnifiedPipeline 无 active release 且非 dev mode → blocked (g6_release_gate)", async () => {
  const root = makeTempRoot();
  const prevEnv = process.env.PINOVEL_EVOLUTION_ROOT;
  const prevDev = clearDevMode();
  process.env.PINOVEL_EVOLUTION_ROOT = root;
  try {
    const runUnifiedPipeline = await loadRunUnifiedPipeline();
    const result = await runUnifiedPipeline({
      workspaceId: "g6-integration-blocked",
      chapterId: "1",
      chapterNumber: 1,
      projectRoot: PROJECT_ROOT,
    });
    assert.equal(result.status, "blocked", "无 active release 应 blocked");
    assert.ok(result.failureEnvelope, "应返回 failureEnvelope");
    assert.equal(
      result.failureEnvelope.stage,
      "g6_release_gate",
      `failureEnvelope.stage 应为 g6_release_gate，实际: ${result.failureEnvelope.stage}`,
    );
    // stageResults 应含 releaseGovernance 摘要（即使 blocked 也记录门禁决策）
    assert.ok(result.stageResults, "stageResults 应存在");
    assert.ok(
      result.stageResults.releaseGovernance,
      "stageResults.releaseGovernance 应存在（记录门禁决策）",
    );
  } finally {
    if (prevEnv === undefined) delete process.env.PINOVEL_EVOLUTION_ROOT;
    else process.env.PINOVEL_EVOLUTION_ROOT = prevEnv;
    restoreDevMode(prevDev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: runUnifiedPipeline 有 active release 且 fingerprint 匹配 → stageResults.releaseGovernance 携带 releaseId", async () => {
  const root = makeTempRoot();
  const prevEnv = process.env.PINOVEL_EVOLUTION_ROOT;
  const prevDev = clearDevMode();
  const prevStub = process.env.V2_FORCE_STUB;
  process.env.PINOVEL_EVOLUTION_ROOT = root;
  process.env.V2_FORCE_STUB = "1";
  try {
    // 采集当前真实指纹，写入 manifest
    const fpHash = captureDefaultEnvironmentFingerprint(PROJECT_ROOT);
    const manifest = makeManifest("rel-g6-prod", "active_prod", fpHash, "approval-g6");
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, "rel-g6-prod");

    const runUnifiedPipeline = await loadRunUnifiedPipeline();
    const result = await runUnifiedPipeline({
      workspaceId: "g6-integration-ok",
      chapterId: "1",
      chapterNumber: 1,
      projectRoot: PROJECT_ROOT,
    });

    // 门禁应通过（可能因其他原因 blocked，但不应是 g6_release_gate）
    assert.notEqual(
      result.failureEnvelope?.stage,
      "g6_release_gate",
      "fingerprint 匹配时不应被 G6 门禁阻断",
    );

    // stageResults.releaseGovernance 应携带 releaseId / environmentFingerprint / approvalRef
    const rg = result.stageResults?.releaseGovernance;
    assert.ok(rg, "stageResults.releaseGovernance 应存在");
    assert.equal(rg.devMode, false);
    assert.equal(rg.releaseId, "rel-g6-prod");
    assert.equal(rg.environmentFingerprint, fpHash);
    assert.equal(rg.approvalRef, "approval-g6");
  } finally {
    if (prevEnv === undefined) delete process.env.PINOVEL_EVOLUTION_ROOT;
    else process.env.PINOVEL_EVOLUTION_ROOT = prevEnv;
    restoreDevMode(prevDev);
    if (prevStub === undefined) delete process.env.V2_FORCE_STUB;
    else process.env.V2_FORCE_STUB = prevStub;
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: PINOVEL_DEV_MODE=1 时 runUnifiedPipeline 不被 G6 门禁阻断", async () => {
  const root = makeTempRoot();
  const prevEnv = process.env.PINOVEL_EVOLUTION_ROOT;
  const prevDev = process.env.PINOVEL_DEV_MODE;
  const prevStub = process.env.V2_FORCE_STUB;
  process.env.PINOVEL_EVOLUTION_ROOT = root;
  process.env.PINOVEL_DEV_MODE = "1";
  process.env.V2_FORCE_STUB = "1";
  try {
    const runUnifiedPipeline = await loadRunUnifiedPipeline();
    const result = await runUnifiedPipeline({
      workspaceId: "g6-integration-dev",
      chapterId: "1",
      chapterNumber: 1,
      projectRoot: PROJECT_ROOT,
    });
    assert.notEqual(
      result.failureEnvelope?.stage,
      "g6_release_gate",
      "dev mode 不应被 G6 门禁阻断",
    );
    const rg = result.stageResults?.releaseGovernance;
    assert.ok(rg, "stageResults.releaseGovernance 应存在（即使 dev mode）");
    assert.equal(rg.devMode, true);
  } finally {
    if (prevEnv === undefined) delete process.env.PINOVEL_EVOLUTION_ROOT;
    else process.env.PINOVEL_EVOLUTION_ROOT = prevEnv;
    if (prevDev === undefined) delete process.env.PINOVEL_DEV_MODE;
    else process.env.PINOVEL_DEV_MODE = prevDev;
    if (prevStub === undefined) delete process.env.V2_FORCE_STUB;
    else process.env.V2_FORCE_STUB = prevStub;
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. 生产闭包边界测试（dist/v2/governance/ 含门禁模块）
// ============================================================================

test("build boundary: dist/v2/governance/ 含 production-release-gate.js", () => {
  const p = join(EXT_ROOT, "dist", "v2", "governance", "production-release-gate.js");
  assert.ok(existsSync(p), `dist/v2/governance/production-release-gate.js 应存在（G6 生产入口绑定）；先 npm run build:prod`);
});

test("build boundary: dist/v2/governance/ 含 release-pointer-store.js + environment-fingerprint.js + evolution-release-registry.js", () => {
  const files = [
    "release-pointer-store.js",
    "environment-fingerprint.js",
    "evolution-release-registry.js",
    "evolution-release-schema.js",
    "evolution-release-types.js",
  ];
  const missing = files.filter((f) => !existsSync(join(EXT_ROOT, "dist", "v2", "governance", f)));
  assert.deepEqual(
    missing,
    [],
    `dist/v2/governance/ 应含全部治理基础模块（G6 生产入口绑定），缺失：\n${missing.map((f) => `  - ${f}`).join("\n")}`,
  );
});
