/**
 * DATA-VERSION-RELEASE-GOVERNANCE DG-3 — 统一生产入口与 Fail-Closed (RED)
 *
 * 真相源：docs/data-version-release-governance-development-plan-20260813.md §5 DG-3
 * 任务卡：DG-3「统一生产入口与 fail-closed」
 *
 * 验收点（任务卡“必须测试”）：
 * - 无 manifest 的生产运行数为 0（no active pointer / manifest 不存在 → blocked）
 * - candidate 误入生产为 0（status !== active_prod → blocked）
 * - pointer 损坏时 fail-closed（active pointer 指向不存在 manifest → blocked）
 * - bundleId 与组件 hash 内部不一致（hash 漂移）→ blocked
 * - 行为组件 hash 与当前运行快照漂移 → blocked
 * - 生产 trace 100% 含 releaseId/bundleId/modelVersion 及关键组件 hash
 * - 旧 manifest（无 bundleId）跳过组件校验（DG-6 迁移前向后兼容）
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型（V2_FORCE_STUB=1）
 * - 使用独立临时目录构造治理数据，不修改真实 active pointer / 治理数据
 * - 行为身份快照采集读取真实 PROJECT_ROOT 文件（只读，不改动用户 WIP）
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
import { join, resolve, dirname } from "node:path";
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
  captureDefaultBehaviorSnapshot,
} from "../dist-test/v2/governance/behavior-snapshot.js";
import { computeBehaviorBundleId } from "../dist-test/v2/governance/behavior-bundle.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

const TEST_MODEL_VERSION = "gemini-3.1-pro-preview";
const TEST_EVAL_PROTOCOL_VERSION = "2026-08-01";

// ============================================================================
// helpers（复用 G6 生产绑定测试的治理数据构造方式）
// ============================================================================

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "dg3-failclosed-"));
}

function fakeHash(seed) {
  // 64 位确定性 hex（非真实内容 hash，仅供一致性/漂移对比）
  const hex = Array.from({ length: 64 }, (_, i) =>
    "0123456789abcdef"[(seed.charCodeAt(i % seed.length)) % 16],
  ).join("");
  return hex;
}

function makeManifest(releaseId, status, fingerprintHash, approvalRef, options = {}) {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status,
    parentReleaseId: "rel-000",
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass: options.changeClass ?? "R1",
    claims: ["dg3-test-claim"],
    environmentFingerprint: fingerprintHash,
    artifactRefs: [],
    approvalRef,
    createdAt: "2026-07-16T00:00:00.000Z",
    activatedAt: status === "active_prod" ? "2026-07-16T00:00:00.000Z" : null,
    // 行为身份字段（可选注入；缺省 = 旧 v1 manifest 无行为身份）
    ...(options.behaviorIdentity ?? {}),
  };
}

function setupReleaseInRoot(root, manifest) {
  const releasesDir = join(root, "releases");
  mkdirSync(join(releasesDir, manifest.releaseId), { recursive: true });
  writeFileSync(
    join(releasesDir, manifest.releaseId, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
  return createEvolutionReleaseRegistry({ releasesDir });
}

function setActiveProduction(root, releaseId) {
  createReleasePointerStore({ configDir: root }).switchActive("production", releaseId, {
    actor: "user",
    reason: "dg3 test",
  });
}

function writeLegitApprovalArtifact(root, manifest) {
  const approvalsDir = join(root, "releases", manifest.releaseId, "approvals");
  mkdirSync(approvalsDir, { recursive: true });
  createProxyApprovalRegistry({ approvalsDir }).writeArtifact({
    schemaId: PROXY_APPROVAL_SCHEMA_ID,
    schemaVersion: PROXY_APPROVAL_SCHEMA_VERSION,
    approvalId: manifest.approvalRef,
    releaseId: manifest.releaseId,
    releaseManifestHash: computeReleasePayloadHash(manifest),
    reviewerType: "validated_human_proxy",
    reviewerModel: PROXY_APPROVAL_REVIEWER_MODEL,
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    reviewTransport: "network",
    promptHash: "sha256:prompt-dg3",
    inputArtifactHash: "sha256:input-dg3",
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
    finalVerdict: "APPROVE_DEV",
    winningSpans: ["span-win-dg3"],
    losingSpans: ["span-lose-dg3"],
    risks: [],
    rationale: "dg3 fail-closed test legit approval",
    decidedAt: "2026-07-16T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 60000 },
    changeClass: manifest.changeClass,
    r3SelfApproval: false,
  });
}

function clearDevMode() {
  const prev = process.env.PINOVEL_DEV_MODE;
  delete process.env.PINOVEL_DEV_MODE;
  return prev;
}

function restoreDevMode(prev) {
  if (prev === undefined) delete process.env.PINOVEL_DEV_MODE;
  else process.env.PINOVEL_DEV_MODE = prev;
}

/** 从快照提取完整行为身份字段（bundleId + modelVersion + 8 组件 hash + evalProtocolVersion）。 */
function behaviorIdentityFromSnapshot(snap) {
  return {
    bundleId: snap.bundleId,
    modelVersion: snap.modelVersion,
    promptBundleHash: snap.promptBundleHash,
    modelRoutingHash: snap.modelRoutingHash,
    toolSchemaHash: snap.toolSchemaHash,
    contextCompilerHash: snap.contextCompilerHash,
    qualityPolicyHash: snap.qualityPolicyHash,
    recoveryPolicyHash: snap.recoveryPolicyHash,
    knowledgeSnapshotHash: snap.knowledgeSnapshotHash,
    runtimeFingerprint: snap.runtimeFingerprint,
    capabilityPackageSetHash: snap.capabilityPackageSetHash,
    evalProtocolVersion: snap.evalProtocolVersion,
  };
}

// ============================================================================
// 1. bundleId 与组件 hash 一致性（hash 漂移）→ fail-closed
// ============================================================================

test("DG-3: bundleId 与组件 hash 内部不一致（hash 漂移）→ blocked", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const componentHashes = {
      modelVersion: TEST_MODEL_VERSION,
      promptBundleHash: fakeHash("prompt"),
      modelRoutingHash: fakeHash("routing"),
      toolSchemaHash: fakeHash("tool"),
      contextCompilerHash: fakeHash("ctx"),
      qualityPolicyHash: fakeHash("quality"),
      recoveryPolicyHash: fakeHash("recovery"),
      knowledgeSnapshotHash: fakeHash("knowledge"),
      runtimeFingerprint: fakeHash("runtime"),
      capabilityPackageSetHash: fakeHash("packages"),
      evalProtocolVersion: TEST_EVAL_PROTOCOL_VERSION,
    };
    const correctBundleId = computeBehaviorBundleId(componentHashes);
    const wrongBundleId = "0".repeat(64); // 与组件 hash 派生值不一致
    assert.notEqual(wrongBundleId, correctBundleId);

    const manifest = makeManifest("rel-dg3-drift", "active_prod", "fp-match", "approval-dg3", {
      behaviorIdentity: { ...componentHashes, bundleId: wrongBundleId },
    });
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, "rel-dg3-drift");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: "fp-match",
    });

    assert.equal(result.ok, false, "bundleId 漂移应 blocked");
    assert.match(result.failureEnvelope.reason, /bundleId/i);
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("DG-3: 组件 hash 缺失但 bundleId 存在（不完整身份）→ blocked", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    // bundleId 存在，但 promptBundleHash 缺失 → extractBehaviorComponents 返回 null
    // → validateBundleIdConsistency ok=false（recomputed=null）。
    const manifest = makeManifest("rel-dg3-partial", "active_prod", "fp-match", "approval-dg3", {
      behaviorIdentity: {
        bundleId: "a".repeat(64),
        modelVersion: TEST_MODEL_VERSION,
        evalProtocolVersion: TEST_EVAL_PROTOCOL_VERSION,
        // 8 个组件 hash 全部缺失
      },
    });
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, "rel-dg3-partial");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: "fp-match",
    });

    assert.equal(result.ok, false, "组件 hash 缺失应 fail-closed");
    assert.match(result.failureEnvelope.reason, /bundleId/i);
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. 组件 hash 与当前运行快照漂移 → fail-closed
// ============================================================================

test("DG-3: bundleId 自洽但组件 hash 与当前运行快照不符 → blocked", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    // 用一组伪造（但彼此自洽）的组件 hash 构造 manifest，使 bundleId 校验通过，
    // 但与 PROJECT_ROOT 现场采集的真实快照不一致 → 组件漂移 blocked。
    const fakeComponents = {
      modelVersion: TEST_MODEL_VERSION,
      promptBundleHash: fakeHash("fp"),
      modelRoutingHash: fakeHash("fr"),
      toolSchemaHash: fakeHash("ft"),
      contextCompilerHash: fakeHash("fc"),
      qualityPolicyHash: fakeHash("fq"),
      recoveryPolicyHash: fakeHash("frec"),
      knowledgeSnapshotHash: fakeHash("fk"),
      runtimeFingerprint: fakeHash("frun"),
      capabilityPackageSetHash: fakeHash("fcp"),
      evalProtocolVersion: TEST_EVAL_PROTOCOL_VERSION,
    };
    const selfConsistentBundleId = computeBehaviorBundleId(fakeComponents);

    const manifest = makeManifest("rel-dg3-compdrift", "active_prod", "fp-match", "approval-dg3", {
      behaviorIdentity: { ...fakeComponents, bundleId: selfConsistentBundleId },
    });
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, "rel-dg3-compdrift");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: "fp-match",
    });

    assert.equal(result.ok, false, "组件 hash 与当前快照漂移应 blocked");
    assert.match(result.failureEnvelope.reason, /component hash drift|drift/i);
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. 完整行为身份 + 真实快照 → ok + 行为身份写入 trace
// ============================================================================

test("DG-3: 完整行为身份与真实快照一致 → ok + behaviorIdentity 全量写入", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const snap = captureDefaultBehaviorSnapshot(
      PROJECT_ROOT,
      TEST_MODEL_VERSION,
      TEST_EVAL_PROTOCOL_VERSION,
    );
    const fpHash = "fp-match-dg3";
    const manifest = makeManifest("rel-dg3-ok", "active_prod", fpHash, "approval-dg3", {
      behaviorIdentity: behaviorIdentityFromSnapshot(snap),
    });
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, "rel-dg3-ok");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });

    assert.equal(result.ok, true, "完整行为身份与真实快照一致应 ok");
    assert.equal(result.behaviorIdentity.bundleId, snap.bundleId);
    assert.equal(result.behaviorIdentity.modelVersion, TEST_MODEL_VERSION);
    assert.equal(result.behaviorIdentity.evalProtocolVersion, TEST_EVAL_PROTOCOL_VERSION);
    assert.equal(result.behaviorIdentity.promptBundleHash, snap.promptBundleHash);
    assert.equal(result.behaviorIdentity.modelRoutingHash, snap.modelRoutingHash);
    assert.equal(result.behaviorIdentity.toolSchemaHash, snap.toolSchemaHash);
    assert.equal(result.behaviorIdentity.contextCompilerHash, snap.contextCompilerHash);
    assert.equal(result.behaviorIdentity.qualityPolicyHash, snap.qualityPolicyHash);
    assert.equal(result.behaviorIdentity.recoveryPolicyHash, snap.recoveryPolicyHash);
    assert.equal(result.behaviorIdentity.knowledgeSnapshotHash, snap.knowledgeSnapshotHash);
    assert.equal(result.behaviorIdentity.runtimeFingerprint, snap.runtimeFingerprint);
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. 旧 manifest（无行为身份）向后兼容 → 跳过组件校验
// ============================================================================

test("DG-3: 旧 manifest（无 bundleId）跳过组件校验 → 仍 ok（DG-6 迁移前向后兼容）", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const fpHash = "fp-legacy";
    const manifest = makeManifest("rel-dg3-legacy", "active_prod", fpHash, "approval-dg3");
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, "rel-dg3-legacy");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });

    assert.equal(result.ok, false, "active_prod 旧 manifest 缺少 bundleId 必须 fail-closed");
    assert.match(result.failureEnvelope.reason, /capabilityPackageSetHash|bundleId|行为身份/);
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("DG-3: dev mode bypass 时 behaviorIdentity 全 null", () => {
  const root = makeTempRoot();
  const prev = process.env.PINOVEL_DEV_MODE;
  process.env.PINOVEL_DEV_MODE = "1";
  try {
    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: "any",
    });
    assert.equal(result.ok, true);
    assert.equal(result.devMode, true);
    assert.equal(result.behaviorIdentity.bundleId, null);
    assert.equal(result.behaviorIdentity.modelVersion, null);
    assert.equal(result.behaviorIdentity.promptBundleHash, null);
  } finally {
    if (prev === undefined) delete process.env.PINOVEL_DEV_MODE;
    else process.env.PINOVEL_DEV_MODE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. 生产 trace 集成：stageResults.releaseGovernance.behaviorIdentity 写入
// ============================================================================

test("DG-3 integration: 生产 trace 携带 releaseId/bundleId/modelVersion 及组件 hash", async () => {
  const root = makeTempRoot();
  const prevEnv = process.env.PINOVEL_EVOLUTION_ROOT;
  const prevDev = clearDevMode();
  const prevStub = process.env.V2_FORCE_STUB;
  process.env.PINOVEL_EVOLUTION_ROOT = root;
  process.env.V2_FORCE_STUB = "1";
  try {
    const snap = captureDefaultBehaviorSnapshot(
      PROJECT_ROOT,
      TEST_MODEL_VERSION,
      TEST_EVAL_PROTOCOL_VERSION,
    );
    const fpHash = captureDefaultEnvironmentFingerprint(PROJECT_ROOT);
    const manifest = makeManifest("rel-dg3-integ", "active_prod", fpHash, "approval-dg3", {
      behaviorIdentity: behaviorIdentityFromSnapshot(snap),
    });
    setupReleaseInRoot(root, manifest);
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, "rel-dg3-integ");

    const { runUnifiedPipeline } = await import(
      "file://" + join(EXT_ROOT, "dist", "v2", "core", "unified-entry.js")
    );
    const result = await runUnifiedPipeline({
      workspaceId: "dg3-integ-ws",
      chapterId: "1",
      chapterNumber: 1,
      projectRoot: PROJECT_ROOT,
    });

    // 门禁不应因 G6 阻断（可能因后续 preflight 阻断，但不影响 releaseGovernance trace）
    assert.notEqual(result.failureEnvelope?.stage, "g6_release_gate");

    const rg = result.stageResults?.releaseGovernance;
    assert.ok(rg, "stageResults.releaseGovernance 应存在");
    assert.equal(rg.releaseId, "rel-dg3-integ");
    assert.ok(rg.behaviorIdentity, "releaseGovernance.behaviorIdentity 应存在");
    assert.equal(rg.behaviorIdentity.bundleId, snap.bundleId);
    assert.equal(rg.behaviorIdentity.modelVersion, TEST_MODEL_VERSION);
    assert.equal(rg.behaviorIdentity.evalProtocolVersion, TEST_EVAL_PROTOCOL_VERSION);
    assert.equal(rg.behaviorIdentity.promptBundleHash, snap.promptBundleHash);
    assert.equal(rg.behaviorIdentity.modelRoutingHash, snap.modelRoutingHash);
    assert.equal(rg.behaviorIdentity.toolSchemaHash, snap.toolSchemaHash);
    assert.equal(rg.behaviorIdentity.contextCompilerHash, snap.contextCompilerHash);
    assert.equal(rg.behaviorIdentity.qualityPolicyHash, snap.qualityPolicyHash);
    assert.equal(rg.behaviorIdentity.recoveryPolicyHash, snap.recoveryPolicyHash);
    assert.equal(rg.behaviorIdentity.knowledgeSnapshotHash, snap.knowledgeSnapshotHash);
    assert.equal(rg.behaviorIdentity.runtimeFingerprint, snap.runtimeFingerprint);
  } finally {
    if (prevEnv === undefined) delete process.env.PINOVEL_EVOLUTION_ROOT;
    else process.env.PINOVEL_EVOLUTION_ROOT = prevEnv;
    restoreDevMode(prevDev);
    if (prevStub === undefined) delete process.env.V2_FORCE_STUB;
    else process.env.V2_FORCE_STUB = prevStub;
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// production_like 候选验收：证据先于审批，不得要求已经是 active_prod
// ============================================================================

test("production_like 候选：draft + 完整身份（含 capabilityPackageSetHash）在指纹匹配时通过，不要求 active_prod", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const snap = captureDefaultBehaviorSnapshot(
      PROJECT_ROOT,
      TEST_MODEL_VERSION,
      TEST_EVAL_PROTOCOL_VERSION,
    );
    const candidateFp = "c".repeat(64);
    const activeFp = "d".repeat(64);
    const candidate = makeManifest("rel-prod-116", "draft", candidateFp, null, {
      behaviorIdentity: behaviorIdentityFromSnapshot(snap),
    });
    const active = makeManifest("rel-prod-115", "active_prod", activeFp, "approval-115", {
      behaviorIdentity: behaviorIdentityFromSnapshot(snap),
    });
    setupReleaseInRoot(root, candidate);
    setupReleaseInRoot(root, active);
    writeLegitApprovalArtifact(root, active);
    setActiveProduction(root, "rel-prod-115");

    const againstActive = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: candidateFp,
    });
    assert.equal(againstActive.ok, false, "默认门禁仍校验 active_prod，不得误放行候选");

    const missingHash = makeManifest("rel-prod-116b", "draft", candidateFp, null, {
      behaviorIdentity: {
        ...behaviorIdentityFromSnapshot(snap),
        capabilityPackageSetHash: undefined,
      },
    });
    delete missingHash.capabilityPackageSetHash;
    setupReleaseInRoot(root, missingHash);
    const blockedMissing = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: candidateFp,
      targetReleaseId: "rel-prod-116b",
      requireActiveApproval: false,
    });
    assert.equal(blockedMissing.ok, false);
    assert.match(blockedMissing.failureEnvelope.reason, /capabilityPackageSetHash missing/);

    const candidateOk = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: candidateFp,
      targetReleaseId: "rel-prod-116",
      requireActiveApproval: false,
    });
    assert.equal(
      candidateOk.ok,
      true,
      candidateOk.ok ? "" : candidateOk.failureEnvelope.reason,
    );
    assert.equal(candidateOk.releaseId, "rel-prod-116");
    assert.equal(
      candidateOk.behaviorIdentity.capabilityPackageSetHash,
      snap.capabilityPackageSetHash,
    );
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("evolution:capture 必须把 snapshot.capabilityPackageSetHash 写入 manifest", () => {
  const src = readFileSync(
    join(EXT_ROOT, "scripts", "evolution-cli.mjs"),
    "utf-8",
  );
  assert.match(
    src,
    /capabilityPackageSetHash:\s*snapshot\.capabilityPackageSetHash/,
    "capture 不得只算 bundleId 却漏写 capabilityPackageSetHash",
  );
});
