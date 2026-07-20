/**
 * EVOLUTION-RELEASE-GOVERNANCE P0 绕过漏洞修复测试（RED）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.4 / §G6
 *
 * 本测试文件验证两个 P0 绕过漏洞已修复：
 *
 * [P0-1] Reviewer shopping 未阻断晋级
 *   - 现状（BUG）：executeProxyApproval 检测到 reviewer shopping 后仍返回 canPromote=true
 *   - 期望：检测到 reviewer shopping 时 canPromote 必须为 false，即使 verdict=APPROVE_DEV
 *   - 计划 §6.4 veto：评审身份泄露、reviewer shopping、事后换阈值不得晋级
 *
 * [P0-2] Production pointer 可绕过审批
 *   - 现状（BUG）：system / gpt5.6-sol-proxy 可把任意不存在、未审批的 release 设为 production active
 *   - 期望：
 *     a) production pointer 只能由 user 切换（system/gpt5.6-sol-proxy/evaluation/test 均无权）
 *     b) 提供 resolveManifestForValidation 时，production pointer 切换必须校验：
 *        - manifest 存在
 *        - status ∈ {candidate_prod, active_prod}
 *        - approvalRef 非空
 *
 * 真相源约束（计划 §4 状态机）：
 * - active_prod 必须由用户审批（R3 必须用户审批；R0/R1/R2 可代理审批）
 * - 未审批 / 未冻结 / 不存在的 release 不得设为 production active
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
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import { createReleasePointerStore } from "../dist-test/v2/governance/release-pointer-store.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";

// ============================================================================
// helpers
// ============================================================================

function makeManifest(releaseId, changeClass = "R2", overrides = {}) {
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
    ...overrides,
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
  return mkdtempSync(join(tmpdir(), "evo-p0-fix-"));
}

// ============================================================================
// P0-1: Reviewer shopping 必须阻断晋级
// ============================================================================

test("P0-1: reviewer shopping 检测到时 canPromote 必须为 false（即使 verdict=APPROVE_DEV）", async () => {
  const dir = makeTempDir();
  try {
    const registry = createProxyApprovalRegistry({ approvalsDir: dir });
    // 第一次审批：REJECT
    const caller1 = createStubProxyApprovalCaller({
      forwardVerdict: "REJECT",
      reverseVerdict: "REJECT",
    });
    // 第二次审批：APPROVE_DEV，但使用不同 reviewer 版本 → reviewer shopping
    const caller2 = createStubProxyApprovalCaller({
      forwardVerdict: "APPROVE_DEV",
      reverseVerdict: "APPROVE_DEV",
      modelVersion: "gpt5.6-sol-different-version",
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

    // P0-1 修复后：reviewer shopping 必须 veto 晋级
    assert.equal(
      result2.reviewerShoppingDetected,
      true,
      "应检测到 reviewer shopping",
    );
    assert.equal(
      result2.canPromote,
      false,
      "P0-1: reviewer shopping 检测到时 canPromote 必须为 false（即使 verdict=APPROVE_DEV）",
    );
    assert.ok(
      result2.blockReason && /reviewer shopping/i.test(result2.blockReason),
      `blockReason 应提及 reviewer shopping，实际：${result2.blockReason}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1: 无 reviewer shopping 且 APPROVE_DEV → canPromote=true（正向回归）", async () => {
  const dir = makeTempDir();
  try {
    const registry = createProxyApprovalRegistry({ approvalsDir: dir });
    const caller = createStubProxyApprovalCaller({
      forwardVerdict: "APPROVE_DEV",
      reverseVerdict: "APPROVE_DEV",
    });
    const result = await executeProxyApproval({
      packetInput: makePacketInput("rel-clean-001"),
      caller,
      registry,
      promptHash: "sha256:p",
      modelVersion: "v1",
      budget: { maxCalls: 2, timeoutMs: 60000 },
    });
    assert.equal(result.finalVerdict, "APPROVE_DEV");
    assert.equal(result.reviewerShoppingDetected, false);
    assert.equal(
      result.canPromote,
      true,
      "正向回归：无 reviewer shopping + APPROVE_DEV 必须可晋级",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// P0-2: Production pointer 切换的 actor 限制
// ============================================================================

test("P0-2a: system 角色禁止切换 production pointer", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    assert.throws(
      () =>
        store.switchActive("production", "rel-001", {
          reason: "system attempt",
          actor: "system",
        }),
      /production|禁止|actor/i,
      "P0-2: system 角色不得修改 production pointer（必须由 user 切换）",
    );
    assert.equal(store.readActive("production"), null, "pointer 不应被写入");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-2a: gpt5.6-sol-proxy 角色禁止切换 production pointer", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    assert.throws(
      () =>
        store.switchActive("production", "rel-001", {
          reason: "proxy attempt",
          actor: "gpt5.6-sol-proxy",
        }),
      /production|禁止|actor/i,
      "P0-2: gpt5.6-sol-proxy 角色不得修改 production pointer（必须由 user 切换）",
    );
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-2a: user 角色可切换 production pointer（未提供 resolver 时兼容行为）", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    store.switchActive("production", "rel-001", {
      reason: "user approve",
      actor: "user",
    });
    const ptr = store.readActive("production");
    assert.ok(ptr !== null);
    assert.equal(ptr.releaseId, "rel-001");
    assert.equal(ptr.actor, "user");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// P0-2: Production pointer 切换的 manifest 校验
// ============================================================================

test("P0-2b: 提供 resolver 但 manifest 不存在 → 拒绝切换 production pointer", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({
      configDir: dir,
      resolveManifestForValidation: (_releaseId) => null, // manifest 不存在
    });
    assert.throws(
      () =>
        store.switchActive("production", "rel-nonexistent", {
          reason: "user attempt on missing manifest",
          actor: "user",
        }),
      /manifest|不存在|未审批/i,
      "P0-2: 不存在的 release 不得设为 production active",
    );
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-2b: manifest status 非 candidate_prod / active_prod → 拒绝", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({
      configDir: dir,
      resolveManifestForValidation: (releaseId) => ({
        releaseId,
        status: "evaluated", // 未审批状态
        approvalRef: "approval-xyz",
      }),
    });
    assert.throws(
      () =>
        store.switchActive("production", "rel-001", {
          reason: "user attempt on unapproved status",
          actor: "user",
        }),
      /status|candidate_prod|active_prod|未审批|未上线/i,
      "P0-2: status 非 candidate_prod/active_prod 不得设为 production active",
    );
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-2b: manifest approvalRef 为空 → 拒绝（必须经过代理审批）", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({
      configDir: dir,
      resolveManifestForValidation: (releaseId) => ({
        releaseId,
        status: "candidate_prod",
        approvalRef: null, // 未审批
      }),
    });
    assert.throws(
      () =>
        store.switchActive("production", "rel-001", {
          reason: "user attempt on unapproved manifest",
          actor: "user",
        }),
      /approvalRef|代理审批|未审批/i,
      "P0-2: approvalRef 为空不得设为 production active",
    );
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-2b: resolver 返回 releaseId 不匹配 → 拒绝", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({
      configDir: dir,
      resolveManifestForValidation: (_releaseId) => ({
        releaseId: "rel-other", // 不匹配
        status: "candidate_prod",
        approvalRef: "approval-xyz",
      }),
    });
    assert.throws(
      () =>
        store.switchActive("production", "rel-001", {
          reason: "user attempt on mismatched manifest",
          actor: "user",
        }),
      /releaseId|不一致/i,
      "P0-2: resolver 返回的 releaseId 与请求不一致必须拒绝",
    );
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-2b: manifest 合法（candidate_prod + approvalRef 非空）→ 允许切换", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({
      configDir: dir,
      resolveManifestForValidation: (releaseId) => ({
        releaseId,
        status: "candidate_prod",
        approvalRef: "approval-xyz",
      }),
    });
    store.switchActive("production", "rel-001", {
      reason: "user approve after manifest validation",
      actor: "user",
    });
    const ptr = store.readActive("production");
    assert.ok(ptr !== null);
    assert.equal(ptr.releaseId, "rel-001");
    assert.equal(ptr.actor, "user");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-2b: manifest 合法（active_prod + approvalRef 非空，reaffirm 场景）→ 允许切换", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({
      configDir: dir,
      resolveManifestForValidation: (releaseId) => ({
        releaseId,
        status: "active_prod", // 已上线，reaffirm 场景
        approvalRef: "approval-xyz",
      }),
    });
    store.switchActive("production", "rel-001", {
      reason: "user reaffirm",
      actor: "user",
    });
    const ptr = store.readActive("production");
    assert.ok(ptr !== null);
    assert.equal(ptr.releaseId, "rel-001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// P0-2: development pointer 不受 manifest 校验影响（开发期兼容）
// ============================================================================

test("P0-2c: development pointer 切换不触发 manifest 校验", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({
      configDir: dir,
      resolveManifestForValidation: (_releaseId) => null, // 即使 manifest 不存在
    });
    // development pointer 应能正常切换
    store.switchActive("development", "rel-001", {
      reason: "dev promote",
      actor: "system",
    });
    const ptr = store.readActive("development");
    assert.ok(ptr !== null);
    assert.equal(ptr.releaseId, "rel-001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
