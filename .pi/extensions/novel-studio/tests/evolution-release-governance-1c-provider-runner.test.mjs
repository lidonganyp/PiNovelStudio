/**
 * EVOLUTION-RELEASE-GOVERNANCE-1C Provider Runner 测试 — stub 端到端 + real 授权边界
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6 / Phase G4 / 1C 任务卡
 *
 * 1C provider runner 连接 1B proxy-approval-caller：
 * - stub 模式：本地端到端跑通，artifact 含 releaseId/verdict/provenance/budget
 * - real 模式：无授权卡 / 过期 / 未覆盖 releaseId / 预算不足 → REQUIRES_AUTH
 * - real 模式：有效卡片下返回 identity="gpt5.6-sol" 的 caller
 * - real 模式 caller.call() 本身仍 REQUIRES_AUTH（真实 API 集成为后续工程切片）
 * - 不切换 active pointer，不接 novel_generate_chapter
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProviderRunner } from "../dist-test/v2/governance/proxy-approval-provider-runner.js";
import { executeProxyApproval } from "../dist-test/v2/governance/proxy-approval-caller.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";
import {
  AUTHORIZATION_CARD_SCHEMA_ID,
  AUTHORIZATION_CARD_SCHEMA_VERSION,
  validateAuthorizationCard,
} from "../dist-test/v2/governance/authorization-card.js";

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
    candidateSpans: [{ id: "s1", text: "候选更优", side: "candidate" }],
    currentSpans: [{ id: "s2", text: "当前较弱", side: "current" }],
  };
}

function makeValidCard(overrides = {}) {
  return {
    schemaId: AUTHORIZATION_CARD_SCHEMA_ID,
    schemaVersion: AUTHORIZATION_CARD_SCHEMA_VERSION,
    cardId: "card-test-001",
    cardType: "real_gpt56sol",
    model: "gpt5.6-sol",
    allowedReleaseIds: ["rel-001"],
    budget: { maxCalls: 6, timeoutMs: 300000 },
    modelVersion: "gpt5.6-sol-2026-07",
    issuedAt: "2026-07-16T00:00:00.000Z",
    expiresAt: "2099-12-31T23:59:59.000Z",
    issuer: "test-issuer",
    ...overrides,
  };
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "provider-runner-"));
}

// ============================================================================
// stub 模式
// ============================================================================

test("providerRunner: stub 模式返回 identity=stub 的 caller", () => {
  const runner = createProviderRunner({
    mode: "stub",
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
  });
  assert.equal(runner.identity, "stub");
});

test("providerRunner: stub 端到端执行产出 artifact（含 releaseId/verdict/provenance/budget）", async () => {
  const dir = makeTempDir();
  try {
    const registry = createProxyApprovalRegistry({ approvalsDir: dir });
    const caller = createProviderRunner({
      mode: "stub",
      forwardVerdict: "APPROVE_DEV",
      reverseVerdict: "APPROVE_DEV",
      modelVersion: "gpt5.6-sol-2026-07",
    });

    const result = await executeProxyApproval({
      packetInput: makePacketInput("rel-001"),
      caller,
      registry,
      promptHash: "sha256:prompt-test",
      modelVersion: "gpt5.6-sol-2026-07",
      budget: { maxCalls: 6, timeoutMs: 300000 },
    });

    // artifact 必须含 releaseId/verdict/provenance/budget
    assert.equal(result.artifact.releaseId, "rel-001");
    assert.equal(result.artifact.finalVerdict, "APPROVE_DEV");
    assert.equal(result.artifact.reviewerModel, "gpt5.6-sol");
    assert.equal(result.artifact.reviewerModelVersion, "gpt5.6-sol-2026-07");
    assert.equal(result.artifact.promptHash, "sha256:prompt-test");
    assert.equal(typeof result.artifact.inputArtifactHash, "string");
    assert.ok(result.artifact.inputArtifactHash.length > 0);
    assert.equal(result.artifact.budgetUsed.calls, 2);
    assert.equal(result.artifact.budgetUsed.timeoutMs, 300000);
    assert.equal(result.artifact.releaseManifestHash, computeReleasePayloadHash(makeManifest("rel-001")));
    assert.equal(result.canPromote, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("providerRunner: stub HOLD 路径 canPromote=false", async () => {
  const dir = makeTempDir();
  try {
    const registry = createProxyApprovalRegistry({ approvalsDir: dir });
    const caller = createProviderRunner({
      mode: "stub",
      forwardVerdict: "HOLD",
      reverseVerdict: "HOLD",
    });

    const result = await executeProxyApproval({
      packetInput: makePacketInput("rel-001"),
      caller,
      registry,
      promptHash: "sha256:p",
      modelVersion: "v1",
      budget: { maxCalls: 6, timeoutMs: 300000 },
    });

    assert.equal(result.artifact.finalVerdict, "HOLD");
    assert.equal(result.canPromote, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// real 模式 — 授权边界
// ============================================================================

test("providerRunner: real 模式无授权卡抛 REQUIRES_AUTH", () => {
  assert.throws(
    () => createProviderRunner({
      mode: "real",
      releaseId: "rel-001",
      modelVersion: "gpt5.6-sol-2026-07",
    }),
    /REQUIRES_AUTH.*授权卡/,
  );
});

test("providerRunner: real 模式过期卡片抛 REQUIRES_AUTH", () => {
  const card = makeValidCard({ expiresAt: "2020-01-01T00:00:00.000Z" });
  assert.throws(
    () => createProviderRunner({
      mode: "real",
      authorizationCard: card,
      releaseId: "rel-001",
      modelVersion: "gpt5.6-sol-2026-07",
    }),
    /REQUIRES_AUTH.*过期/,
  );
});

test("providerRunner: real 模式未覆盖 releaseId 抛 REQUIRES_AUTH", () => {
  const card = makeValidCard({ allowedReleaseIds: ["rel-001"] });
  assert.throws(
    () => createProviderRunner({
      mode: "real",
      authorizationCard: card,
      releaseId: "rel-999",
      modelVersion: "gpt5.6-sol-2026-07",
    }),
    /REQUIRES_AUTH.*不覆盖/,
  );
});

test("providerRunner: real 模式预算不足抛 REQUIRES_AUTH", () => {
  const card = makeValidCard({ budget: { maxCalls: 1, timeoutMs: 300000 } });
  assert.throws(
    () => createProviderRunner({
      mode: "real",
      authorizationCard: card,
      releaseId: "rel-001",
      modelVersion: "gpt5.6-sol-2026-07",
    }),
    /REQUIRES_AUTH.*预算/,
  );
});

test("providerRunner: real 模式有效卡片返回 identity=gpt5.6-sol 的 caller", () => {
  const card = makeValidCard({ allowedReleaseIds: ["rel-001"] });
  const runner = createProviderRunner({
    mode: "real",
    authorizationCard: card,
    releaseId: "rel-001",
    modelVersion: "gpt5.6-sol-2026-07",
  });
  assert.equal(runner.identity, "gpt5.6-sol");
});

test("providerRunner: real 模式 caller.call() 仍抛 REQUIRES_AUTH（真实 API 集成为后续切片）", async () => {
  const card = makeValidCard({ allowedReleaseIds: ["rel-001"] });
  const runner = createProviderRunner({
    mode: "real",
    authorizationCard: card,
    releaseId: "rel-001",
    modelVersion: "gpt5.6-sol-2026-07",
  });
  await assert.rejects(
    () => runner.call(
      { schemaId: "pinovel.release-proxy-approval-packet", schemaVersion: 1, forward: { labelA: "A", labelB: "B", textA: "a", textB: "b", spans: [] }, reverse: { labelA: "A", labelB: "B", textA: "a", textB: "b", spans: [] }, rawBaseline: { text: "raw" }, fixedCase: "c", fixedModel: "m", fixedSeed: 0, budgetMaxCalls: 6, timeoutMs: 300000, factGuard: {}, stateConsistency: {}, costProfile: {}, uniqueVariableDeclared: { hasUniqueVariable: true } },
      { promptHash: "sha256:p", modelVersion: "v1", budget: { maxCalls: 6, timeoutMs: 300000 } },
    ),
    /REQUIRES_AUTH/,
  );
});

test("providerRunner: real 模式通配卡片覆盖任意 releaseId", () => {
  const card = makeValidCard({ allowedReleaseIds: ["*"] });
  const runner = createProviderRunner({
    mode: "real",
    authorizationCard: card,
    releaseId: "rel-anything",
    modelVersion: "gpt5.6-sol-2026-07",
  });
  assert.equal(runner.identity, "gpt5.6-sol");
});
