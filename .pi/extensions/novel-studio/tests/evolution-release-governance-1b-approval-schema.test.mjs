/**
 * EVOLUTION-RELEASE-GOVERNANCE-1B 审批 schema / verdict 归一化 / R3 自审批 / 双向绑定 / reviewer shopping 测试
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6 / Phase G4
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROXY_APPROVAL_SCHEMA_ID,
  PROXY_APPROVAL_SCHEMA_VERSION,
  validateApprovalArtifact,
  normalizeVerdict,
  isR3SelfApproval,
  computeApprovalArtifactHash,
  verifyManifestBinding,
  detectReviewerShopping,
} from "../dist-test/v2/governance/release-proxy-approval-schema.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";

// ============================================================================
// helpers
// ============================================================================

function makeMinimalManifest(overrides = {}) {
  return {
    schemaId: "pinovel.evolution-release",
    schemaVersion: 1,
    releaseId: "rel-test-001",
    status: "evaluated",
    parentReleaseId: "rel-000",
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass: "R2",
    claims: ["unique-variable:stage2-narrator-model"],
    environmentFingerprint: "fp-hash-abc",
    artifactRefs: ["eval/report.json"],
    approvalRef: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    activatedAt: null,
    ...overrides,
  };
}

function makeValidArtifact(overrides = {}) {
  return {
    schemaId: PROXY_APPROVAL_SCHEMA_ID,
    schemaVersion: PROXY_APPROVAL_SCHEMA_VERSION,
    approvalId: "approval-001",
    releaseId: "rel-test-001",
    releaseManifestHash: computeReleasePayloadHash(makeMinimalManifest()),
    reviewerType: "validated_human_proxy",
    reviewerModel: "gpt5.6-sol",
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    promptHash: "sha256:prompt-abc",
    inputArtifactHash: "sha256:input-def",
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
    finalVerdict: "APPROVE_DEV",
    winningSpans: ["候选第3段情绪节拍更稳"],
    losingSpans: ["当前版本第5段对白过多"],
    risks: ["成本延迟 +8%"],
    rationale: "候选在情绪节拍与对白密度上均明确胜出",
    decidedAt: "2026-07-16T10:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 60000 },
    changeClass: "R2",
    r3SelfApproval: false,
    ...overrides,
  };
}

// ============================================================================
// schema 常量
// ============================================================================

test("PROXY_APPROVAL_SCHEMA_ID 为 pinovel.release-proxy-approval", () => {
  assert.equal(PROXY_APPROVAL_SCHEMA_ID, "pinovel.release-proxy-approval");
  assert.equal(PROXY_APPROVAL_SCHEMA_VERSION, 1);
});

// ============================================================================
// validateApprovalArtifact
// ============================================================================

test("validateApprovalArtifact: 合法 artifact 通过", () => {
  const artifact = makeValidArtifact();
  const result = validateApprovalArtifact(artifact);
  assert.equal(result.ok, true);
  assert.deepEqual(result.artifact.releaseId, "rel-test-001");
});

test("validateApprovalArtifact: 非 object 拒绝", () => {
  assert.equal(validateApprovalArtifact(null).ok, false);
  assert.equal(validateApprovalArtifact("string").ok, false);
  assert.equal(validateApprovalArtifact([]).ok, false);
});

test("validateApprovalArtifact: 未知 schemaId 拒绝", () => {
  const result = validateApprovalArtifact(makeValidArtifact({ schemaId: "unknown" }));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /schemaId/);
});

test("validateApprovalArtifact: reviewerType 必须为 validated_human_proxy", () => {
  const result = validateApprovalArtifact(makeValidArtifact({ reviewerType: "natural_person" }));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /validated_human_proxy/);
});

test("validateApprovalArtifact: reviewerModel 必须为 gpt5.6-sol", () => {
  const result = validateApprovalArtifact(makeValidArtifact({ reviewerModel: "gpt-4" }));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /gpt5\.6-sol/);
});

test("validateApprovalArtifact: reviewerModelVersion 不能为空", () => {
  const result = validateApprovalArtifact(makeValidArtifact({ reviewerModelVersion: "" }));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /reviewerModelVersion/);
});

test("validateApprovalArtifact: finalVerdict 必须为合法枚举", () => {
  const result = validateApprovalArtifact(makeValidArtifact({ finalVerdict: "MAYBE" }));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /verdict/i);
});

test("validateApprovalArtifact: forwardVerdict/reverseVerdict 必须为合法枚举", () => {
  assert.equal(
    validateApprovalArtifact(makeValidArtifact({ forwardVerdict: "SLIGHT_WIN" })).ok,
    false,
  );
  assert.equal(
    validateApprovalArtifact(makeValidArtifact({ reverseVerdict: "uncertain" })).ok,
    false,
  );
});

test("validateApprovalArtifact: 缺少必填字段拒绝", () => {
  const { approvalId, ...missingApprovalId } = makeValidArtifact();
  assert.equal(validateApprovalArtifact(missingApprovalId).ok, false);
});

test("validateApprovalArtifact: r3SelfApproval=true 拒绝（R3 禁止自审批）", () => {
  const r3Manifest = makeMinimalManifest({ changeClass: "R3" });
  const artifact = makeValidArtifact({
    releaseManifestHash: computeReleasePayloadHash(r3Manifest),
    changeClass: "R3",
    r3SelfApproval: true,
  });
  const result = validateApprovalArtifact(artifact);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /R3/);
});

// ============================================================================
// normalizeVerdict
// ============================================================================

test("normalizeVerdict: APPROVE_DEV 原样保留", () => {
  assert.equal(normalizeVerdict("APPROVE_DEV"), "APPROVE_DEV");
  assert.equal(normalizeVerdict("REJECT"), "REJECT");
  assert.equal(normalizeVerdict("QUARANTINE"), "QUARANTINE");
});

test("normalizeVerdict: slight/uncertain/顺序敏感/冲突一律映射为 HOLD", () => {
  assert.equal(normalizeVerdict("SLIGHT_WIN"), "HOLD");
  assert.equal(normalizeVerdict("uncertain"), "HOLD");
  assert.equal(normalizeVerdict("order_sensitive"), "HOLD");
  assert.equal(normalizeVerdict("conflict"), "HOLD");
  assert.equal(normalizeVerdict("maybe"), "HOLD");
});

test("normalizeVerdict: 未知 verdict 映射为 HOLD（保守）", () => {
  assert.equal(normalizeVerdict("WHATEVER"), "HOLD");
  assert.equal(normalizeVerdict(""), "HOLD");
});

test("normalizeVerdict: forward/reverse 不一致时 finalVerdict 必须为 HOLD", () => {
  // forward APPROVE_DEV + reverse REJECT → 顺序敏感 → HOLD
  const cases = [
    { forward: "APPROVE_DEV", reverse: "REJECT", expected: "HOLD" },
    { forward: "APPROVE_DEV", reverse: "HOLD", expected: "HOLD" },
    { forward: "REJECT", reverse: "APPROVE_DEV", expected: "HOLD" },
    { forward: "APPROVE_DEV", reverse: "APPROVE_DEV", expected: "APPROVE_DEV" },
    { forward: "REJECT", reverse: "REJECT", expected: "REJECT" },
  ];
  for (const { forward, reverse, expected } of cases) {
    assert.equal(normalizeVerdict(forward, reverse), expected);
  }
});

// ============================================================================
// isR3SelfApproval
// ============================================================================

test("isR3SelfApproval: R3 + r3SelfApproval=true → true", () => {
  assert.equal(isR3SelfApproval({ changeClass: "R3", r3SelfApproval: true }), true);
});

test("isR3SelfApproval: R3 + r3SelfApproval=false → false", () => {
  assert.equal(isR3SelfApproval({ changeClass: "R3", r3SelfApproval: false }), false);
});

test("isR3SelfApproval: R2 + r3SelfApproval=true → false（非 R3 不触发）", () => {
  assert.equal(isR3SelfApproval({ changeClass: "R2", r3SelfApproval: true }), false);
});

test("isR3SelfApproval: R0/R1 不触发", () => {
  assert.equal(isR3SelfApproval({ changeClass: "R0", r3SelfApproval: true }), false);
  assert.equal(isR3SelfApproval({ changeClass: "R1", r3SelfApproval: true }), false);
});

// ============================================================================
// computeApprovalArtifactHash + verifyManifestBinding
// ============================================================================

test("computeApprovalArtifactHash: 同 artifact 生成同 hash", () => {
  const a = makeValidArtifact();
  const b = makeValidArtifact();
  assert.equal(computeApprovalArtifactHash(a), computeApprovalArtifactHash(b));
});

test("computeApprovalArtifactHash: decidedAt 不影响 hash（非行为字段）", () => {
  const a = makeValidArtifact();
  const b = makeValidArtifact({ decidedAt: "2026-07-17T00:00:00.000Z" });
  assert.equal(computeApprovalArtifactHash(a), computeApprovalArtifactHash(b));
});

test("computeApprovalArtifactHash: verdict 变化改变 hash", () => {
  const a = makeValidArtifact();
  const b = makeValidArtifact({ finalVerdict: "REJECT" });
  assert.notEqual(computeApprovalArtifactHash(a), computeApprovalArtifactHash(b));
});

test("verifyManifestBinding: hash 一致 → 通过", () => {
  const manifest = makeMinimalManifest();
  const manifestHash = computeReleasePayloadHash(manifest);
  const artifact = makeValidArtifact({ releaseManifestHash: manifestHash });
  const result = verifyManifestBinding(artifact, manifestHash);
  assert.equal(result.ok, true);
});

test("verifyManifestBinding: hash 不一致 → 拒绝", () => {
  const artifact = makeValidArtifact({ releaseManifestHash: "wrong-hash" });
  const result = verifyManifestBinding(artifact, "actual-hash");
  assert.equal(result.ok, false);
  assert.match(result.error, /hash/);
});

test("verifyManifestBinding: 空 manifestHash → 拒绝", () => {
  const artifact = makeValidArtifact({ releaseManifestHash: "" });
  const result = verifyManifestBinding(artifact, "actual-hash");
  assert.equal(result.ok, false);
});

// ============================================================================
// detectReviewerShopping
// ============================================================================

test("detectReviewerShopping: 单个审批 → 无 shopping", () => {
  const artifacts = [makeValidArtifact()];
  assert.equal(detectReviewerShopping(artifacts).detected, false);
});

test("detectReviewerShopping: 同 releaseId 多个不同 reviewer → 检测到", () => {
  const a = makeValidArtifact({ approvalId: "a1", reviewerModelVersion: "v1" });
  const b = makeValidArtifact({ approvalId: "a2", reviewerModelVersion: "v2" });
  const result = detectReviewerShopping([a, b]);
  assert.equal(result.detected, true);
});

test("detectReviewerShopping: 同 releaseId 多个不同 verdict 且非 HOLD → 检测到", () => {
  const a = makeValidArtifact({ approvalId: "a1", finalVerdict: "APPROVE_DEV" });
  const b = makeValidArtifact({ approvalId: "a2", finalVerdict: "REJECT" });
  const result = detectReviewerShopping([a, b]);
  assert.equal(result.detected, true);
});

test("detectReviewerShopping: 不同 releaseId → 无 shopping", () => {
  const a = makeValidArtifact({ approvalId: "a1", releaseId: "rel-1" });
  const b = makeValidArtifact({ approvalId: "a2", releaseId: "rel-2" });
  const result = detectReviewerShopping([a, b]);
  assert.equal(result.detected, false);
});

test("detectReviewerShopping: 事后更换阈值（同 release 多 APPROVE_DEV 后混 HOLD）→ 检测到", () => {
  const a = makeValidArtifact({ approvalId: "a1", finalVerdict: "REJECT" });
  const b = makeValidArtifact({ approvalId: "a2", finalVerdict: "HOLD" });
  const c = makeValidArtifact({ approvalId: "a3", finalVerdict: "APPROVE_DEV" });
  const result = detectReviewerShopping([a, b, c]);
  assert.equal(result.detected, true);
});
