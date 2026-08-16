/**
 * EVOLUTION-RELEASE-GOVERNANCE P0 生命周期 hash 绑定修复测试（RED → GREEN）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.4 / §11
 *
 * 用户复现的 P0 绕过（第三层）：
 *   "审批 artifact 在 evaluated manifest 上计算 releaseManifestHash，但生产门禁对包含
 *    active_prod 状态和 approvalRef 的最终 manifest 重新计算完整 hash。合法状态迁移本身
 *    就会改变 hash，导致真实审批版本永远无法通过 G6。"
 *
 * 根因：computeManifestHash 对全字段（含 status / approvalRef / activatedAt 生命周期字段）
 *       计算 hash。状态迁移 evaluated → approved_dev → ... → active_prod 必然改变这些字段，
 *       导致 artifact 的 releaseManifestHash 与最终 manifest hash 永远不一致。
 *
 * 修复方案：新增 computeReleasePayloadHash，排除 status / approvalRef / activatedAt 三个
 *   生命周期字段。审批 artifact 绑定不可变 release payload，而非可变生命周期状态。
 *
 * 本测试覆盖：
 *   1. computeReleasePayloadHash 在生命周期迁移中保持稳定（只改 status/approvalRef/activatedAt → hash 不变）
 *   2. computeReleasePayloadHash 在 payload 字段变更时改变（改 claims/environmentFingerprint → hash 变）
 *   3. 端到端：evaluated → runStubProxyReview → approved_dev → active_dev → candidate_prod → active_prod → G6 ok=true
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型（stub caller）
 * - 不修改用户真实治理数据（独立临时目录）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { executeProxyApproval } from "../dist-test/v2/governance/proxy-approval-caller.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import { createReleasePointerStore } from "../dist-test/v2/governance/release-pointer-store.js";
import {
  computeManifestHash,
  computeReleasePayloadHash,
} from "../dist-test/v2/governance/evolution-release-schema.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import {
  evaluateProductionReleaseGate,
  captureDefaultEnvironmentFingerprint,
} from "../dist-test/v2/governance/production-release-gate.js";
import { captureDefaultBehaviorSnapshot } from "../dist-test/v2/governance/behavior-snapshot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

// ============================================================================
// helpers
// ============================================================================

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "evolution-lifecycle-"));
}

function makeManifest(releaseId, status, fingerprintHash, approvalRef = null) {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status,
    parentReleaseId: "rel-000",
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass: "R1",
    claims: ["lifecycle-test-claim"],
    environmentFingerprint: fingerprintHash,
    artifactRefs: [],
    approvalRef,
    createdAt: "2026-07-16T00:00:00.000Z",
    activatedAt: null,
  };
}

function setActiveProduction(root, releaseId, actor = "user", reason = "lifecycle test") {
  const store = createReleasePointerStore({ configDir: root });
  store.switchActive("production", releaseId, { actor, reason });
}

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

function makePacketInputBody(changeClass = "R2") {
  return {
    changeClass,
    uniqueVariable: "lifecycle-strategy",
    fixedCase: "case-lifecycle-ch1",
    fixedModel: "doubao-seed-2.1-pro",
    fixedSeed: 0,
    budgetMaxCalls: 6,
    timeoutMs: 300000,
    candidateText: "候选正文",
    currentApprovedText: "当前正文",
    rawBaselineText: "raw 正文",
    factGuardReport: { candidatePass: true, currentPass: true, violations: [] },
    stateConsistency: { candidateConsistent: true, currentConsistent: true },
    costProfile: { candidateTokens: 1000, currentTokens: 900, candidateLatencyMs: 1000, currentLatencyMs: 900 },
    systemJudgeConclusion: "should be anonymized",
    developerExpectation: "should be anonymized",
    candidateSpans: [{ id: "s1", text: "候选更优", side: "candidate" }],
    currentSpans: [{ id: "s2", text: "当前较弱", side: "current" }],
  };
}

// ============================================================================
// 1. computeReleasePayloadHash 稳定性
// ============================================================================

test("P0-lifecycle-1a: payload hash 在 status 迁移中保持稳定（evaluated → active_prod）", () => {
  const base = makeManifest("rel-hash-1a", "evaluated", "fp-hash-1a");
  const evaluated = { ...base };
  const approvedDev = { ...base, status: "approved_dev", approvalRef: "apv-1a" };
  const activeDev = { ...base, status: "active_dev", approvalRef: "apv-1a" };
  const candidateProd = { ...base, status: "candidate_prod", approvalRef: "apv-1a" };
  const activeProd = { ...base, status: "active_prod", approvalRef: "apv-1a", activatedAt: "2026-07-16T12:00:00.000Z" };

  const hashEval = computeReleasePayloadHash(evaluated);
  const hashApproved = computeReleasePayloadHash(approvedDev);
  const hashActiveDev = computeReleasePayloadHash(activeDev);
  const hashCandidateProd = computeReleasePayloadHash(candidateProd);
  const hashActiveProd = computeReleasePayloadHash(activeProd);

  assert.equal(hashEval, hashApproved, "status evaluated→approved_dev 不应改变 payload hash");
  assert.equal(hashApproved, hashActiveDev, "status approved_dev→active_dev 不应改变 payload hash");
  assert.equal(hashActiveDev, hashCandidateProd, "status active_dev→candidate_prod 不应改变 payload hash");
  assert.equal(hashCandidateProd, hashActiveProd, "status candidate_prod→active_prod 不应改变 payload hash");
});

test("P0-lifecycle-1b: payload hash 在 approvalRef 变化中保持稳定", () => {
  const base = makeManifest("rel-hash-1b", "evaluated", "fp-hash-1b");
  const withoutApproval = { ...base, approvalRef: null };
  const withApproval = { ...base, approvalRef: "apv-1b" };

  assert.equal(
    computeReleasePayloadHash(withoutApproval),
    computeReleasePayloadHash(withApproval),
    "approvalRef 变化不应改变 payload hash（approvalRef 是生命周期字段）",
  );
});

test("P1.1: transitionStatus 进入 active_prod 必须写入 activatedAt", () => {
  const root = makeTempRoot();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    const base = makeManifest("rel-act-1", "candidate_prod", "fp-act", "apv-act");
    registry.writeManifest(base);
    assert.equal(registry.loadManifest("rel-act-1").activatedAt, null);

    const updated = registry.transitionStatus("rel-act-1", "active_prod", { actor: "user" });
    assert.equal(updated.status, "active_prod");
    assert.equal(typeof updated.activatedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(updated.activatedAt)));

    const reloaded = registry.loadManifest("rel-act-1");
    assert.equal(reloaded.activatedAt, updated.activatedAt);
    assert.equal(
      computeReleasePayloadHash(base),
      computeReleasePayloadHash(reloaded),
      "activatedAt 不得改变 payload hash",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-lifecycle-1c: payload hash 在 activatedAt 变化中保持稳定", () => {
  const base = makeManifest("rel-hash-1c", "active_prod", "fp-hash-1c", "apv-1c");
  const notActivated = { ...base, activatedAt: null };
  const activated = { ...base, activatedAt: "2026-07-16T12:00:00.000Z" };

  assert.equal(
    computeReleasePayloadHash(notActivated),
    computeReleasePayloadHash(activated),
    "activatedAt 变化不应改变 payload hash（activatedAt 是生命周期字段）",
  );
});

test("P0-lifecycle-1d: full manifest hash 在 status 迁移中改变（对比验证根因）", () => {
  const base = makeManifest("rel-hash-1d", "evaluated", "fp-hash-1d");
  const evaluated = { ...base };
  const activeProd = { ...base, status: "active_prod", approvalRef: "apv-1d", activatedAt: "2026-07-16T12:00:00.000Z" };

  assert.notEqual(
    computeManifestHash(evaluated),
    computeManifestHash(activeProd),
    "full manifest hash 应在生命周期迁移中改变（这是当前 P0 的根因）",
  );
});

test("P0-lifecycle-1e: payload hash 在 payload 字段变更时改变（claims/environmentFingerprint）", () => {
  const base = makeManifest("rel-hash-1e", "evaluated", "fp-hash-1e");
  const changedClaims = { ...base, claims: ["different-claim"] };
  const changedFingerprint = { ...base, environmentFingerprint: "different-fp" };
  const changedArtifactRefs = { ...base, artifactRefs: ["new-artifact.json"] };

  assert.notEqual(
    computeReleasePayloadHash(base),
    computeReleasePayloadHash(changedClaims),
    "claims 变更应改变 payload hash",
  );
  assert.notEqual(
    computeReleasePayloadHash(base),
    computeReleasePayloadHash(changedFingerprint),
    "environmentFingerprint 变更应改变 payload hash",
  );
  assert.notEqual(
    computeReleasePayloadHash(base),
    computeReleasePayloadHash(changedArtifactRefs),
    "artifactRefs 变更应改变 payload hash",
  );
});

// ============================================================================
// 2. 端到端：evaluated → runStubProxyReview → transitions → active_prod → G6 ok=true
// ============================================================================

test("P0-lifecycle-2: evaluated → runStubProxyReview → approved_dev → active_dev → candidate_prod → active_prod → G6 ok=true", async () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const releaseId = "rel-lifecycle-2";
    const fpHash = captureDefaultEnvironmentFingerprint(PROJECT_ROOT);

    // --- 1. 在 evaluated 状态创建 manifest ---
    const releasesDir = join(root, "releases");
    const approvalsDir = join(releasesDir, releaseId, "approvals");
    const evolutionRegistry = createEvolutionReleaseRegistry({ releasesDir });
    const proxyRegistry = createProxyApprovalRegistry({ approvalsDir });

    const snap = captureDefaultBehaviorSnapshot(PROJECT_ROOT, "gemini-3.1-pro-preview", "2026-08-01");
    const evaluatedManifest = {
      ...makeManifest(releaseId, "evaluated", fpHash),
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
    // writeManifest 对 draft/candidate 可用；对 evaluated 需直接写入（frozen 后状态）
    mkdirSync(join(releasesDir, releaseId), { recursive: true });
    writeFileSync(
      join(releasesDir, releaseId, "manifest.json"),
      JSON.stringify(evaluatedManifest, null, 2) + "\n",
      "utf-8",
    );

    // --- 2. 运行 stub 代理审批（在 evaluated 状态）---
    const reviewResult = await executeProxyApproval({
      registry: proxyRegistry,
      packetInput: {
        ...makePacketInputBody("R1"),
        releaseId,
        releaseManifestHash: computeReleasePayloadHash(evaluatedManifest),
      },
      caller: {
        identity: "gpt5.6-sol",
        async call(_packet, options) {
          return {
            forwardVerdict: "APPROVE_DEV",
            reverseVerdict: "APPROVE_DEV",
            finalVerdict: "APPROVE_DEV",
            reviewerType: "validated_human_proxy",
            reviewerModel: "gpt5.6-sol",
            reviewerModelVersion: "gpt5.6-sol-2026-07",
            promptHash: options.promptHash,
            budgetUsed: { calls: 2, timeoutMs: options.budget.timeoutMs },
            rationale: "network reviewer fixture",
            winningSpans: [],
            losingSpans: [],
            risks: [],
          };
        },
      },
      modelVersion: "gpt5.6-sol-2026-07",
      promptHash: "sha256:prompt-lifecycle",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });

    assert.equal(reviewResult.finalVerdict, "APPROVE_DEV");
    assert.equal(reviewResult.canPromote, true);
    const approvalId = reviewResult.artifact.approvalId;
    assert.ok(approvalId, "artifact 应有 approvalId");

    // artifact 已写入 {root}/releases/{releaseId}/approvals/{approvalId}.json
    const loadedArtifact = proxyRegistry.loadArtifact(approvalId);
    assert.ok(loadedArtifact, "artifact 应可从 registry 重新加载");

    // --- 3. 构造 resolver（供 transitionStatus 验证 artifact 真实性）---
    const resolveApprovalArtifact = (approvalRef) => {
      return proxyRegistry.loadArtifact(approvalRef);
    };

    // --- 4. 状态迁移：evaluated → approved_dev ---
    const approvedDev = evolutionRegistry.transitionStatus(releaseId, "approved_dev", {
      actor: "gpt5.6-sol-proxy",
      approvalRef: approvalId,
      resolveApprovalArtifact,
    });
    assert.equal(approvedDev.status, "approved_dev");
    assert.equal(approvedDev.approvalRef, approvalId);

    // --- 5. 状态迁移：approved_dev → active_dev ---
    const activeDev = evolutionRegistry.transitionStatus(releaseId, "active_dev", {
      actor: "system",
      approvalRef: approvalId,
      resolveApprovalArtifact,
    });
    assert.equal(activeDev.status, "active_dev");

    // --- 6. 状态迁移：active_dev → candidate_prod（actor=user）---
    const candidateProd = evolutionRegistry.transitionStatus(releaseId, "candidate_prod", {
      actor: "user",
      approvalRef: approvalId,
      resolveApprovalArtifact,
    });
    assert.equal(candidateProd.status, "candidate_prod");

    // --- 7. 状态迁移：candidate_prod → active_prod（actor=user）---
    const activeProd = evolutionRegistry.transitionStatus(releaseId, "active_prod", {
      actor: "user",
      approvalRef: approvalId,
      resolveApprovalArtifact,
    });
    assert.equal(activeProd.status, "active_prod");
    assert.equal(activeProd.approvalRef, approvalId);

    // --- 8. 设置 active production pointer ---
    setActiveProduction(root, releaseId);

    // --- 9. G6 门禁：应通过（payload hash 在生命周期中稳定）---
    const gateResult = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });

    assert.equal(
      gateResult.ok,
      true,
      `G6 门禁应通过（合法审批生命周期）；实际 failureEnvelope: ${JSON.stringify(gateResult.failureEnvelope)}`,
    );
    assert.equal(gateResult.releaseId, releaseId);
    assert.equal(gateResult.approvalRef, approvalId);
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});
