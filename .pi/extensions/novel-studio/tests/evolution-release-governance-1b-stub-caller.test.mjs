/**
 * EVOLUTION-RELEASE-GOVERNANCE-1B 代理审批 stub caller + 编排测试 — 4 verdict 路径 / 预算 / 非 APPROVE_DEV 不晋级
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6 / Phase G4
 *
 * 1B 阶段使用 stub caller（不调用真实 gpt5.6-sol）；真实模型调用为 REQUIRES_AUTH。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStubProxyApprovalCaller,
  executeProxyApproval,
} from "../dist-test/v2/governance/proxy-approval-caller.js";
import { buildAnonymousApprovalPacket } from "../dist-test/v2/governance/approval-packet-builder.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";
import {
  verifyManifestBinding,
  detectReviewerShopping,
} from "../dist-test/v2/governance/release-proxy-approval-schema.js";

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

function makePacketInput(releaseId) {
  return {
    releaseId,
    releaseManifestHash: computeReleasePayloadHash(makeManifest(releaseId)),
    changeClass: "R2",
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
  return mkdtempSync(join(tmpdir(), "proxy-caller-"));
}

// ============================================================================
// createStubProxyApprovalCaller
// ============================================================================

test("stubCaller: APPROVE_DEV 路径", async () => {
  const caller = createStubProxyApprovalCaller({
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
  });
  const packet = buildAnonymousApprovalPacket(makePacketInput("rel-001"));
  const result = await caller.call(packet, { promptHash: "sha256:p", modelVersion: "v1", budget: { maxCalls: 2, timeoutMs: 60000 } });
  assert.equal(result.forwardVerdict, "APPROVE_DEV");
  assert.equal(result.reverseVerdict, "APPROVE_DEV");
  assert.equal(result.finalVerdict, "APPROVE_DEV");
  assert.equal(result.reviewerType, "validated_human_proxy");
  assert.equal(result.reviewerModel, "gpt5.6-sol");
});

test("stubCaller: REJECT 路径", async () => {
  const caller = createStubProxyApprovalCaller({
    forwardVerdict: "REJECT",
    reverseVerdict: "REJECT",
  });
  const packet = buildAnonymousApprovalPacket(makePacketInput("rel-001"));
  const result = await caller.call(packet, { promptHash: "sha256:p", modelVersion: "v1", budget: { maxCalls: 2, timeoutMs: 60000 } });
  assert.equal(result.finalVerdict, "REJECT");
});

test("stubCaller: QUARANTINE 路径", async () => {
  const caller = createStubProxyApprovalCaller({
    forwardVerdict: "QUARANTINE",
    reverseVerdict: "QUARANTINE",
    quarantineReason: "provenance mismatch",
  });
  const packet = buildAnonymousApprovalPacket(makePacketInput("rel-001"));
  const result = await caller.call(packet, { promptHash: "sha256:p", modelVersion: "v1", budget: { maxCalls: 2, timeoutMs: 60000 } });
  assert.equal(result.finalVerdict, "QUARANTINE");
  assert.match(result.rationale, /provenance/);
});

test("stubCaller: 正反不一致 → HOLD 路径", async () => {
  const caller = createStubProxyApprovalCaller({
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "REJECT",
  });
  const packet = buildAnonymousApprovalPacket(makePacketInput("rel-001"));
  const result = await caller.call(packet, { promptHash: "sha256:p", modelVersion: "v1", budget: { maxCalls: 2, timeoutMs: 60000 } });
  assert.equal(result.finalVerdict, "HOLD");
});

test("stubCaller: slight verdict → HOLD", async () => {
  const caller = createStubProxyApprovalCaller({
    forwardVerdict: "SLIGHT_WIN",
    reverseVerdict: "SLIGHT_WIN",
  });
  const packet = buildAnonymousApprovalPacket(makePacketInput("rel-001"));
  const result = await caller.call(packet, { promptHash: "sha256:p", modelVersion: "v1", budget: { maxCalls: 2, timeoutMs: 60000 } });
  assert.equal(result.finalVerdict, "HOLD");
});

test("stubCaller: 记录 reviewerType=validated_human_proxy，不得为 natural_person", async () => {
  const caller = createStubProxyApprovalCaller({
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
  });
  const packet = buildAnonymousApprovalPacket(makePacketInput("rel-001"));
  const result = await caller.call(packet, { promptHash: "sha256:p", modelVersion: "v1", budget: { maxCalls: 2, timeoutMs: 60000 } });
  assert.equal(result.reviewerType, "validated_human_proxy");
  assert.notEqual(result.reviewerType, "natural_person");
});

test("stubCaller: 记录 promptHash / modelVersion / budgetUsed", async () => {
  const caller = createStubProxyApprovalCaller({
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
  });
  const packet = buildAnonymousApprovalPacket(makePacketInput("rel-001"));
  const result = await caller.call(packet, { promptHash: "sha256:prompt-xyz", modelVersion: "gpt5.6-sol-2026-07", budget: { maxCalls: 2, timeoutMs: 60000 } });
  assert.equal(result.promptHash, "sha256:prompt-xyz");
  assert.equal(result.reviewerModelVersion, "gpt5.6-sol-2026-07");
  assert.ok(result.budgetUsed);
  assert.equal(result.budgetUsed.calls, 2); // forward + reverse = 2 calls
});

test("stubCaller: 超预算拒绝", async () => {
  const caller = createStubProxyApprovalCaller({
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
  });
  const packet = buildAnonymousApprovalPacket(makePacketInput("rel-001"));
  // maxCalls=1 但 forward+reverse 需要 2 次
  await assert.rejects(
    () => caller.call(packet, { promptHash: "sha256:p", modelVersion: "v1", budget: { maxCalls: 1, timeoutMs: 60000 } }),
    /budget|预算/i,
  );
});

test("stubCaller: 不调用真实模型（无网络/API）", async () => {
  // stub caller 必须零网络调用；通过断言 caller.identity === "stub" 验证
  const caller = createStubProxyApprovalCaller({
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
  });
  assert.equal(caller.identity, "stub");
});

// ============================================================================
// executeProxyApproval: 完整编排
// ============================================================================

test("executeProxyApproval: APPROVE_DEV → 写入 artifact + manifest 绑定通过", async () => {
  const dir = makeTempDir();
  try {
    const registry = createProxyApprovalRegistry({ approvalsDir: dir });
    const caller = createStubProxyApprovalCaller({
      forwardVerdict: "APPROVE_DEV",
      reverseVerdict: "APPROVE_DEV",
    });
    const input = makePacketInput("rel-001");
    const result = await executeProxyApproval({
      packetInput: input,
      caller,
      registry,
      promptHash: "sha256:p",
      modelVersion: "gpt5.6-sol-2026-07",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    assert.equal(result.finalVerdict, "APPROVE_DEV");
    assert.ok(result.artifact);
    assert.ok(result.artifact.approvalId);

    // manifest 绑定
    const binding = verifyManifestBinding(result.artifact, input.releaseManifestHash);
    assert.equal(binding.ok, true);

    // 已写入 registry
    const loaded = registry.loadArtifact(result.artifact.approvalId);
    assert.equal(loaded.approvalId, result.artifact.approvalId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeProxyApproval: HOLD → 不晋级（verdict 非 APPROVE_DEV）", async () => {
  const dir = makeTempDir();
  try {
    const registry = createProxyApprovalRegistry({ approvalsDir: dir });
    const caller = createStubProxyApprovalCaller({
      forwardVerdict: "APPROVE_DEV",
      reverseVerdict: "REJECT", // 不一致 → HOLD
    });
    const result = await executeProxyApproval({
      packetInput: makePacketInput("rel-001"),
      caller,
      registry,
      promptHash: "sha256:p",
      modelVersion: "v1",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    assert.equal(result.finalVerdict, "HOLD");
    assert.equal(result.canPromote, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeProxyApproval: REJECT → canPromote=false", async () => {
  const dir = makeTempDir();
  try {
    const registry = createProxyApprovalRegistry({ approvalsDir: dir });
    const caller = createStubProxyApprovalCaller({
      forwardVerdict: "REJECT",
      reverseVerdict: "REJECT",
    });
    const result = await executeProxyApproval({
      packetInput: makePacketInput("rel-001"),
      caller,
      registry,
      promptHash: "sha256:p",
      modelVersion: "v1",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    assert.equal(result.finalVerdict, "REJECT");
    assert.equal(result.canPromote, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeProxyApproval: QUARANTINE → canPromote=false + 记录风险", async () => {
  const dir = makeTempDir();
  try {
    const registry = createProxyApprovalRegistry({ approvalsDir: dir });
    const caller = createStubProxyApprovalCaller({
      forwardVerdict: "QUARANTINE",
      reverseVerdict: "QUARANTINE",
      quarantineReason: "provenance mismatch detected",
    });
    const result = await executeProxyApproval({
      packetInput: makePacketInput("rel-001"),
      caller,
      registry,
      promptHash: "sha256:p",
      modelVersion: "v1",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    assert.equal(result.finalVerdict, "QUARANTINE");
    assert.equal(result.canPromote, false);
    assert.ok(result.artifact.risks.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeProxyApproval: R3 自审批 → 拒绝（canPromote=false）", async () => {
  const dir = makeTempDir();
  try {
    const registry = createProxyApprovalRegistry({ approvalsDir: dir });
    const caller = createStubProxyApprovalCaller({
      forwardVerdict: "APPROVE_DEV",
      reverseVerdict: "APPROVE_DEV",
    });
    const r3Input = makePacketInput("rel-001");
    r3Input.changeClass = "R3";
    r3Input.releaseManifestHash = computeReleasePayloadHash(makeManifest("rel-001", "R3"));
    const result = await executeProxyApproval({
      packetInput: r3Input,
      caller,
      registry,
      promptHash: "sha256:p",
      modelVersion: "v1",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    // R3 必须由用户审批，代理不得自审批
    assert.equal(result.canPromote, false);
    assert.match(result.blockReason || "", /R3|用户/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeProxyApproval: 审批后检测 reviewer shopping", async () => {
  const dir = makeTempDir();
  try {
    const registry = createProxyApprovalRegistry({ approvalsDir: dir });
    const caller1 = createStubProxyApprovalCaller({
      forwardVerdict: "REJECT",
      reverseVerdict: "REJECT",
    });
    const caller2 = createStubProxyApprovalCaller({
      forwardVerdict: "APPROVE_DEV",
      reverseVerdict: "APPROVE_DEV",
      modelVersion: "gpt5.6-sol-different-version", // 不同版本 = reviewer shopping
    });
    const input = makePacketInput("rel-001");
    await executeProxyApproval({
      packetInput: input,
      caller: caller1,
      registry,
      promptHash: "sha256:p",
      modelVersion: "v1",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    const result2 = await executeProxyApproval({
      packetInput: input,
      caller: caller2,
      registry,
      promptHash: "sha256:p",
      modelVersion: "gpt5.6-sol-different-version",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    // 检测到 reviewer shopping
    assert.equal(result2.reviewerShoppingDetected, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
