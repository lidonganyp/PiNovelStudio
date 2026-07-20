/**
 * EVOLUTION-RELEASE-GOVERNANCE-1A — Manifest schema、状态机、frozen 不可变 (RED)
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §3-§4
 * 任务卡：EVOLUTION-RELEASE-GOVERNANCE-1A 第一批
 *
 * 验收点（任务卡“必须测试”）：
 * - frozen manifest 无法修改（frozen 后任何字段变更必须创建新 releaseId）
 * - 缺少 rollback 目标不能冻结
 * - 未知 schema 和损坏 artifact 必须明确失败
 * - 状态机非法迁移必须拒绝
 * - parent/supersedes/rollback 链校验
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不保存章节、不提交长期状态
 * - 不修改用户当前未提交代码
 * - 不进入生产闭包（仅 dist-test/）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
  validateManifest,
  isStatusTransitionValid,
  getValidTransitions,
  assertFrozenImmutable,
  validateManifestChain,
  computeManifestHash,
} from "../dist-test/v2/governance/evolution-release-schema.js";

// ============================================================================
// Fixture builders
// ============================================================================

function makeManifest(overrides = {}) {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId: "rel-001",
    status: "draft",
    parentReleaseId: null,
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass: "R1",
    claims: ["improve reader payoff"],
    environmentFingerprint: "sha256:abc",
    artifactRefs: [],
    approvalRef: null,
    createdAt: "2026-07-16T00:00:00Z",
    activatedAt: null,
    ...overrides,
  };
}

// ============================================================================
// 1. Schema 校验
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A schema: 合法 manifest 通过校验", () => {
  const m = makeManifest();
  const result = validateManifest(m);
  assert.ok(result.ok, "合法 manifest 应通过校验");
  assert.equal(result.manifest.releaseId, "rel-001");
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A schema: 未知 schemaId 拒绝", () => {
  const m = makeManifest({ schemaId: "pinovel.unknown-schema" });
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /schemaId/);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A schema: schemaVersion 不匹配拒绝", () => {
  const m = makeManifest({ schemaVersion: 99 });
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /schemaVersion/);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A schema: 缺少必填字段拒绝", () => {
  const m = makeManifest();
  delete m.releaseId;
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /releaseId/);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A schema: 非法 status 值拒绝", () => {
  const m = makeManifest({ status: "unknown_status" });
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /status/);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A schema: 非法 changeClass 拒绝", () => {
  const m = makeManifest({ changeClass: "R9" });
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /changeClass/);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A schema: environmentFingerprint 为空拒绝", () => {
  const m = makeManifest({ environmentFingerprint: "" });
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /environmentFingerprint/);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A schema: 损坏 JSON（非对象）拒绝", () => {
  const result1 = validateManifest("not an object");
  assert.equal(result1.ok, false);
  const result2 = validateManifest(null);
  assert.equal(result2.ok, false);
  const result3 = validateManifest([]);
  assert.equal(result3.ok, false);
});

// ============================================================================
// 2. 状态机
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: draft→candidate 合法", () => {
  assert.equal(isStatusTransitionValid("draft", "candidate"), true);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: candidate→frozen 合法", () => {
  assert.equal(isStatusTransitionValid("candidate", "frozen"), true);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: frozen→evaluated 合法", () => {
  assert.equal(isStatusTransitionValid("frozen", "evaluated"), true);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: evaluated→approved_dev 合法", () => {
  assert.equal(isStatusTransitionValid("evaluated", "approved_dev"), true);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: evaluated→held/rejected/quarantined 合法", () => {
  assert.equal(isStatusTransitionValid("evaluated", "held"), true);
  assert.equal(isStatusTransitionValid("evaluated", "rejected"), true);
  assert.equal(isStatusTransitionValid("evaluated", "quarantined"), true);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: approved_dev→active_dev 合法", () => {
  assert.equal(isStatusTransitionValid("approved_dev", "active_dev"), true);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: active_dev→candidate_prod 合法", () => {
  assert.equal(isStatusTransitionValid("active_dev", "candidate_prod"), true);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: candidate_prod→active_prod 合法", () => {
  assert.equal(isStatusTransitionValid("candidate_prod", "active_prod"), true);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: active 状态→held/revoked/retired 合法", () => {
  assert.equal(isStatusTransitionValid("active_dev", "held"), true);
  assert.equal(isStatusTransitionValid("active_dev", "revoked"), true);
  assert.equal(isStatusTransitionValid("active_dev", "retired"), true);
  assert.equal(isStatusTransitionValid("active_prod", "held"), true);
  assert.equal(isStatusTransitionValid("active_prod", "revoked"), true);
  assert.equal(isStatusTransitionValid("active_prod", "retired"), true);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: 非法跳转拒绝（draft→frozen）", () => {
  assert.equal(isStatusTransitionValid("draft", "frozen"), false);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: 非法跳转拒绝（draft→active_dev）", () => {
  assert.equal(isStatusTransitionValid("draft", "active_dev"), false);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: 非法跳转拒绝（candidate→active_dev）", () => {
  assert.equal(isStatusTransitionValid("candidate", "active_dev"), false);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: 终态拒绝迁移（rejected→active_dev）", () => {
  assert.equal(isStatusTransitionValid("rejected", "active_dev"), false);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: 终态拒绝迁移（retired→active_dev）", () => {
  assert.equal(isStatusTransitionValid("retired", "active_dev"), false);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: null→draft 合法（初始创建）", () => {
  assert.equal(isStatusTransitionValid(null, "draft"), true);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: null→非draft 非法（必须从 draft 开始）", () => {
  assert.equal(isStatusTransitionValid(null, "candidate"), false);
  assert.equal(isStatusTransitionValid(null, "frozen"), false);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A state machine: getValidTransitions 返回合法后继", () => {
  const draftNext = getValidTransitions("draft");
  assert.ok(draftNext.includes("candidate"));
  assert.ok(!draftNext.includes("frozen"));

  const evaluatedNext = getValidTransitions("evaluated");
  assert.ok(evaluatedNext.includes("approved_dev"));
  assert.ok(evaluatedNext.includes("held"));
  assert.ok(evaluatedNext.includes("rejected"));
  assert.ok(evaluatedNext.includes("quarantined"));
});

// ============================================================================
// 3. Frozen 不可变
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A frozen immutable: 字段未变 → ok=true", () => {
  const before = makeManifest({ status: "frozen" });
  const after = makeManifest({ status: "frozen" });
  const result = assertFrozenImmutable(before, after);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedFields, []);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A frozen immutable: status 变更 → ok=false", () => {
  const before = makeManifest({ status: "frozen" });
  const after = makeManifest({ status: "evaluated" });
  const result = assertFrozenImmutable(before, after);
  assert.equal(result.ok, false);
  assert.ok(result.changedFields.includes("status"));
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A frozen immutable: claims 变更 → ok=false", () => {
  const before = makeManifest({ status: "frozen", claims: ["a"] });
  const after = makeManifest({ status: "frozen", claims: ["a", "b"] });
  const result = assertFrozenImmutable(before, after);
  assert.equal(result.ok, false);
  assert.ok(result.changedFields.includes("claims"));
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A frozen immutable: environmentFingerprint 变更 → ok=false", () => {
  const before = makeManifest({ status: "frozen", environmentFingerprint: "sha256:aaa" });
  const after = makeManifest({ status: "frozen", environmentFingerprint: "sha256:bbb" });
  const result = assertFrozenImmutable(before, after);
  assert.equal(result.ok, false);
  assert.ok(result.changedFields.includes("environmentFingerprint"));
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A frozen immutable: 非 frozen 状态允许字段变更（status 除外需走状态机）", () => {
  // draft 状态下补充 claims 不触发 frozen immutable（仍可能需要新 releaseId，但不是 frozen 检查）
  const before = makeManifest({ status: "draft", claims: ["a"] });
  const after = makeManifest({ status: "draft", claims: ["a", "b"] });
  const result = assertFrozenImmutable(before, after);
  assert.equal(result.ok, true);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A frozen immutable: releaseId 变更不算 frozen 违规（新版本应创建新 releaseId）", () => {
  const before = makeManifest({ status: "frozen", releaseId: "rel-001" });
  const after = makeManifest({ status: "frozen", releaseId: "rel-002" });
  const result = assertFrozenImmutable(before, after);
  // releaseId 变更意味着这是新版本，不是原地修改；不算 frozen 违规
  // 但其他字段若同时变更且 releaseId 相同才算违规
  assert.equal(result.ok, true);
});

// ============================================================================
// 4. freeze 前置：必须有 rollback 目标
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A freeze gate: rollbackReleaseId 为空拒绝冻结", () => {
  const m = makeManifest({ status: "candidate", rollbackReleaseId: "" });
  // 校验链时，rollbackReleaseId 必须非空
  const chainResult = validateManifestChain(m, {
    parent: null,
    rollback: null,
  });
  assert.equal(chainResult.ok, false);
  assert.ok(
    chainResult.errors.some((e) => /rollback/i.test(e.message)),
    "应报告 rollback 缺失",
  );
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A freeze gate: rollbackReleaseId 非空通过链校验", () => {
  const m = makeManifest({
    status: "candidate",
    rollbackReleaseId: "rel-000",
    parentReleaseId: null,
  });
  const chainResult = validateManifestChain(m, {
    parent: null,
    rollback: makeManifest({ releaseId: "rel-000", status: "active_dev" }),
  });
  assert.equal(chainResult.ok, true);
});

// ============================================================================
// 5. 链校验：parent / supersedes / rollback
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A chain: parentReleaseId 指向不存在 manifest 拒绝", () => {
  const m = makeManifest({
    status: "candidate",
    parentReleaseId: "rel-missing",
    rollbackReleaseId: "rel-000",
  });
  const chainResult = validateManifestChain(m, {
    parent: null,
    rollback: makeManifest({ releaseId: "rel-000", status: "active_dev" }),
  });
  assert.equal(chainResult.ok, false);
  assert.ok(
    chainResult.errors.some((e) => /parent/i.test(e.message)),
    "应报告 parent 缺失",
  );
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A chain: parent 存在通过", () => {
  const parent = makeManifest({ releaseId: "rel-000", status: "active_dev" });
  const m = makeManifest({
    releaseId: "rel-001",
    status: "candidate",
    parentReleaseId: "rel-000",
    rollbackReleaseId: "rel-000",
  });
  const chainResult = validateManifestChain(m, {
    parent,
    rollback: parent,
  });
  assert.equal(chainResult.ok, true);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A chain: supersedesRef 指向不存在 manifest 拒绝", () => {
  const m = makeManifest({
    status: "evaluated",
    supersedesRef: "rel-superseded-missing",
    rollbackReleaseId: "rel-000",
    parentReleaseId: null,
  });
  const chainResult = validateManifestChain(m, {
    parent: null,
    rollback: makeManifest({ releaseId: "rel-000", status: "active_dev" }),
    superseded: null,
  });
  assert.equal(chainResult.ok, false);
  assert.ok(
    chainResult.errors.some((e) => /supersede/i.test(e.message)),
    "应报告 supersedes 缺失",
  );
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A chain: supersedesRef 存在通过", () => {
  const superseded = makeManifest({ releaseId: "rel-old", status: "rejected" });
  const m = makeManifest({
    releaseId: "rel-new",
    status: "evaluated",
    supersedesRef: "rel-old",
    rollbackReleaseId: "rel-000",
    parentReleaseId: null,
  });
  const chainResult = validateManifestChain(m, {
    parent: null,
    rollback: makeManifest({ releaseId: "rel-000", status: "active_dev" }),
    superseded,
  });
  assert.equal(chainResult.ok, true);
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A chain: rollback 指向不存在 manifest 拒绝", () => {
  const m = makeManifest({
    status: "candidate",
    rollbackReleaseId: "rel-missing-rollback",
    parentReleaseId: null,
  });
  const chainResult = validateManifestChain(m, {
    parent: null,
    rollback: null,
  });
  assert.equal(chainResult.ok, false);
  assert.ok(
    chainResult.errors.some((e) => /rollback/i.test(e.message)),
    "应报告 rollback 缺失",
  );
});

// ============================================================================
// 6. manifest hash（用于审批 artifact 双向绑定）
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A hash: 相同 manifest 生成相同 hash", () => {
  const m1 = makeManifest();
  const m2 = makeManifest();
  assert.equal(computeManifestHash(m1), computeManifestHash(m2));
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A hash: 任一字段变更生成不同 hash", () => {
  const m1 = makeManifest();
  const m2 = makeManifest({ claims: ["different"] });
  assert.notEqual(computeManifestHash(m1), computeManifestHash(m2));
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A hash: hash 非空且为 hex 字符串", () => {
  const hash = computeManifestHash(makeManifest());
  assert.ok(typeof hash === "string");
  assert.ok(hash.length > 0);
  assert.match(hash, /^[a-f0-9]+$/);
});
