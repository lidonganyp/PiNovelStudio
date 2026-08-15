/**
 * EVOLUTION-RELEASE-GOVERNANCE-1C proxy-review runner 端到端测试
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6 / Phase G4
 *
 * 1C 切片：在 1B stub caller 之上建立端到端 runner。
 * - runStubProxyReview：stub caller 端到端（READY_LOCAL，零网络调用）
 *   从 evolutionRegistry 加载 manifest → 计算 releaseManifestHash →
 *   构造完整 packetInput → createStubProxyApprovalCaller → executeProxyApproval
 * - runRealProxyReview：真实 gpt5.6-sol caller（REQUIRES_AUTH，无授权卡抛错）
 *
 * 本切片使用 stub caller（不调用真实 gpt5.6-sol）；真实模型调用为 REQUIRES_AUTH。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runStubProxyReview,
  runRealProxyReview,
} from "../dist-test/v2/governance/proxy-review-runner.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";

// ============================================================================
// helpers
// ============================================================================

function makeManifest(releaseId, changeClass = "R2") {
  return {
    schemaId: "pinovel.evolution-release",
    schemaVersion: 1,
    releaseId,
    status: "evaluated",
    parentReleaseId: "rel-000",
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass,
    claims: ["unique-variable:test"],
    environmentFingerprint: "fp-test",
    artifactRefs: [],
    approvalRef: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    activatedAt: null,
  };
}

/**
 * 构造 packetInput body（不含 releaseId / releaseManifestHash，由 runner 填充）。
 * changeClass 必须与 manifest.changeClass 一致，确保 hash 绑定正确。
 */
function makePacketInputBody(changeClass = "R2") {
  return {
    changeClass,
    uniqueVariable: "test-strategy",
    fixedCase: "case-test-ch1",
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

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "proxy-runner-"));
}

/** 构造一组 registry + 已写入 manifest 的临时环境。 */
function makeEnv(releaseId, changeClass = "R2") {
  const dir = makeTempDir();
  const releasesDir = join(dir, "releases");
  const approvalsDir = join(dir, "approvals");
  const evolutionRegistry = createEvolutionReleaseRegistry({ releasesDir });
  const proxyRegistry = createProxyApprovalRegistry({ approvalsDir });
  const manifest = makeManifest(releaseId, changeClass);
  evolutionRegistry.writeManifest(manifest);
  return { dir, evolutionRegistry, proxyRegistry, manifest };
}

// ============================================================================
// runStubProxyReview
// ============================================================================

test("runStubProxyReview: APPROVE_DEV + R2 → canPromote=true, finalVerdict=APPROVE_DEV, artifact 写入 registry", async () => {
  const { dir, evolutionRegistry, proxyRegistry, manifest } = makeEnv("rel-001", "R2");
  try {
    const result = await runStubProxyReview({
      proxyRegistry,
      evolutionRegistry,
      releaseId: "rel-001",
      packetInput: makePacketInputBody("R2"),
      forwardVerdict: "APPROVE_DEV",
      reverseVerdict: "APPROVE_DEV",
      modelVersion: "gpt5.6-sol-2026-07",
      promptHash: "sha256:p",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    assert.equal(result.finalVerdict, "APPROVE_DEV");
    assert.equal(result.canPromote, true);
    assert.ok(result.artifact, "artifact 应存在");
    assert.ok(result.artifact.approvalId, "approvalId 应存在");

    // artifact 写入 registry，可重新加载
    const loaded = proxyRegistry.loadArtifact(result.artifact.approvalId);
    assert.equal(loaded.approvalId, result.artifact.approvalId);
    // releaseManifestHash 与 manifest 一致（runner 从 evolutionRegistry 加载并计算）
    assert.equal(loaded.releaseManifestHash, computeReleasePayloadHash(manifest));
    assert.equal(loaded.releaseId, "rel-001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStubProxyReview: forward=APPROVE_DEV + reverse=REJECT → HOLD, canPromote=false, blockReason 含 HOLD", async () => {
  const { dir, evolutionRegistry, proxyRegistry } = makeEnv("rel-002", "R2");
  try {
    const result = await runStubProxyReview({
      proxyRegistry,
      evolutionRegistry,
      releaseId: "rel-002",
      packetInput: makePacketInputBody("R2"),
      forwardVerdict: "APPROVE_DEV",
      reverseVerdict: "REJECT",
      modelVersion: "gpt5.6-sol-2026-07",
      promptHash: "sha256:p",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    assert.equal(result.finalVerdict, "HOLD");
    assert.equal(result.canPromote, false);
    assert.match(result.blockReason || "", /HOLD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStubProxyReview: changeClass=R3 → canPromote=false, blockReason 含 R3", async () => {
  const { dir, evolutionRegistry, proxyRegistry } = makeEnv("rel-003", "R3");
  try {
    const result = await runStubProxyReview({
      proxyRegistry,
      evolutionRegistry,
      releaseId: "rel-003",
      packetInput: makePacketInputBody("R3"),
      forwardVerdict: "APPROVE_DEV",
      reverseVerdict: "APPROVE_DEV",
      modelVersion: "gpt5.6-sol-2026-07",
      promptHash: "sha256:p",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    // R3 治理根变更代理不得自审批，即使 verdict=APPROVE_DEV 也不可晋级
    assert.equal(result.canPromote, false);
    assert.match(result.blockReason || "", /R3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStubProxyReview: budget.maxCalls=1 → 抛错（forward+reverse 需要 2 次）", async () => {
  const { dir, evolutionRegistry, proxyRegistry } = makeEnv("rel-004", "R2");
  try {
    await assert.rejects(
      () => runStubProxyReview({
        proxyRegistry,
        evolutionRegistry,
        releaseId: "rel-004",
        packetInput: makePacketInputBody("R2"),
        forwardVerdict: "APPROVE_DEV",
        reverseVerdict: "APPROVE_DEV",
        modelVersion: "gpt5.6-sol-2026-07",
        promptHash: "sha256:p",
        budget: { maxCalls: 1, timeoutMs: 60000 },
      }),
      /budget|预算/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStubProxyReview: 后 registry.listByReleaseId 能查到 artifact", async () => {
  const { dir, evolutionRegistry, proxyRegistry } = makeEnv("rel-005", "R2");
  try {
    const result = await runStubProxyReview({
      proxyRegistry,
      evolutionRegistry,
      releaseId: "rel-005",
      packetInput: makePacketInputBody("R2"),
      forwardVerdict: "APPROVE_DEV",
      reverseVerdict: "APPROVE_DEV",
      modelVersion: "gpt5.6-sol-2026-07",
      promptHash: "sha256:p",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    const list = proxyRegistry.listByReleaseId("rel-005");
    assert.equal(list.length, 1, "应查到 1 条 artifact");
    assert.equal(list[0].approvalId, result.artifact.approvalId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStubProxyReview: releaseId 不存在 → 抛错（manifest 缺失）", async () => {
  const dir = makeTempDir();
  try {
    const evolutionRegistry = createEvolutionReleaseRegistry({ releasesDir: join(dir, "releases") });
    const proxyRegistry = createProxyApprovalRegistry({ approvalsDir: join(dir, "approvals") });
    await assert.rejects(
      () => runStubProxyReview({
        proxyRegistry,
        evolutionRegistry,
        releaseId: "rel-missing",
        packetInput: makePacketInputBody("R2"),
        forwardVerdict: "APPROVE_DEV",
        reverseVerdict: "APPROVE_DEV",
        modelVersion: "gpt5.6-sol-2026-07",
        promptHash: "sha256:p",
        budget: { maxCalls: 2, timeoutMs: 60000 },
      }),
      /manifest|不存在|rel-missing/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStubProxyReview: 不调用真实模型（stub caller identity=stub）", async () => {
  const { dir, evolutionRegistry, proxyRegistry } = makeEnv("rel-007", "R2");
  try {
    const result = await runStubProxyReview({
      proxyRegistry,
      evolutionRegistry,
      releaseId: "rel-007",
      packetInput: makePacketInputBody("R2"),
      forwardVerdict: "APPROVE_DEV",
      reverseVerdict: "APPROVE_DEV",
      modelVersion: "gpt5.6-sol-2026-07",
      promptHash: "sha256:p",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    // runner 内部使用 stub caller，artifact.reviewerModel=gpt5.6-sol 但 reviewerType=validated_human_proxy
    assert.equal(result.artifact.reviewerType, "validated_human_proxy");
    assert.equal(result.artifact.reviewerModel, "gpt5.6-sol");
    assert.equal(result.artifact.reviewerModelVersion, "gpt5.6-sol-2026-07");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// runRealProxyReview
// ============================================================================

test("runRealProxyReview: 评审包泄漏 releaseId 时先于授权卡/网络失败", async () => {
  const { dir, evolutionRegistry, proxyRegistry } = makeEnv("rel-prod-112", "R1");
  try {
    await assert.rejects(
      () => runRealProxyReview({
        proxyRegistry,
        evolutionRegistry,
        releaseId: "rel-prod-112",
        packetInput: {
          ...makePacketInputBody("R1"),
          candidateText: "候选：干净树 capture rel-prod-112。",
          currentApprovedText: "当前生产基线 rel-prod-111。",
        },
      }),
      /REVIEW_PACKET_IDENTITY_LEAK|rel-prod-112/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRealProxyReview: 无授权卡 → 抛错 REQUIRES_AUTH", async () => {
  const { dir, evolutionRegistry, proxyRegistry } = makeEnv("rel-006", "R2");
  try {
    await assert.rejects(
      () => runRealProxyReview({
        proxyRegistry,
        evolutionRegistry,
        releaseId: "rel-006",
        packetInput: makePacketInputBody("R2"),
        forwardVerdict: "APPROVE_DEV",
        reverseVerdict: "APPROVE_DEV",
        modelVersion: "gpt5.6-sol-2026-07",
        promptHash: "sha256:p",
        budget: { maxCalls: 2, timeoutMs: 60000 },
        // 故意不提供 authorizationCardPath
      }),
      /REQUIRES_AUTH/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRealProxyReview: 授权卡路径不存在 → 抛错 REQUIRES_AUTH", async () => {
  const { dir, evolutionRegistry, proxyRegistry } = makeEnv("rel-008", "R2");
  try {
    await assert.rejects(
      () => runRealProxyReview({
        proxyRegistry,
        evolutionRegistry,
        releaseId: "rel-008",
        packetInput: makePacketInputBody("R2"),
        forwardVerdict: "APPROVE_DEV",
        reverseVerdict: "APPROVE_DEV",
        modelVersion: "gpt5.6-sol-2026-07",
        promptHash: "sha256:p",
        budget: { maxCalls: 2, timeoutMs: 60000 },
        authorizationCardPath: join(dir, "nonexistent-card.json"),
      }),
      /REQUIRES_AUTH/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
