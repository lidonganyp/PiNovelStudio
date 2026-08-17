/**
 * DATA-VERSION-RELEASE-GOVERNANCE DG-1 — 统一行为身份与 bundleId 派生 (RED)
 *
 * 真相源：docs/data-version-release-governance-development-plan-20260813.md §2 / §4
 * 任务卡：DG-1「统一 Behavior Bundle 与 Manifest」
 *
 * 验收点（任务卡“必须测试”）：
 * - 任一行为组成项变化 → 新 bundleId
 * - 同输入重复 capture → 完全一致 hash
 * - bundleId 与组件 hash / modelVersion 一致性校验
 * - 行为身份完整性（缺失字段被列出）
 * - 策略证据分区形状校验（四元组键 + 去重）
 * - frozen 后新增行为身份字段同样不可原地修改
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不保存章节、不提交长期状态
 * - 不进入生产闭包（仅 dist-test/）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeBehaviorBundleId,
  extractBehaviorComponents,
  assertBehaviorIdentityComplete,
  validateBundleIdConsistency,
  validateStrategyEvidencePartitions,
} from "../dist-test/v2/governance/behavior-bundle.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
  validateManifest,
  assertFrozenImmutable,
} from "../dist-test/v2/governance/evolution-release-schema.js";

// ============================================================================
// Fixture builders
// ============================================================================

function makeComponents(overrides = {}) {
  return {
    modelVersion: "gemini-3.1-pro",
    promptBundleHash: "sha256:p1",
    modelRoutingHash: "sha256:r1",
    toolSchemaHash: "sha256:t1",
    contextCompilerHash: "sha256:c1",
    qualityPolicyHash: "sha256:q1",
    recoveryPolicyHash: "sha256:v1",
    knowledgeSnapshotHash: "sha256:k1",
    runtimeFingerprint: "sha256:rf1",
    capabilityPackageSetHash: "sha256:cp1",
    evalProtocolVersion: "2026-08-01",
    ...overrides,
  };
}

function makeManifest(overrides = {}) {
  const components = makeComponents();
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
    bundleId: computeBehaviorBundleId(components),
    ...components,
    strategyEvidencePartition: [
      {
        modelVersion: components.modelVersion,
        bundleId: computeBehaviorBundleId(components),
        strategyId: "editorial-depth",
        evalProtocolVersion: components.evalProtocolVersion,
      },
    ],
    ...overrides,
  };
}

// ============================================================================
// 1. bundleId 派生：确定性与敏感性
// ============================================================================

test("DG-1 bundleId: 相同组件生成相同 bundleId（确定性）", () => {
  const a = computeBehaviorBundleId(makeComponents());
  const b = computeBehaviorBundleId(makeComponents());
  assert.equal(a, b);
});

test("DG-1 bundleId: 任一组件变化生成不同 bundleId", () => {
  const base = computeBehaviorBundleId(makeComponents());
  const changed = computeBehaviorBundleId(makeComponents({ promptBundleHash: "sha256:p2" }));
  assert.notEqual(base, changed);
});

test("DG-1 bundleId: 组件字段顺序不影响结果（规范化）", () => {
  // 构造字段顺序不同的对象，但值相同
  const a = computeBehaviorBundleId(makeComponents());
  const reordered = computeBehaviorBundleId({
    evalProtocolVersion: "2026-08-01",
    capabilityPackageSetHash: "sha256:cp1",
    runtimeFingerprint: "sha256:rf1",
    knowledgeSnapshotHash: "sha256:k1",
    recoveryPolicyHash: "sha256:v1",
    qualityPolicyHash: "sha256:q1",
    contextCompilerHash: "sha256:c1",
    toolSchemaHash: "sha256:t1",
    modelRoutingHash: "sha256:r1",
    promptBundleHash: "sha256:p1",
    modelVersion: "gemini-3.1-pro",
  });
  assert.equal(a, reordered);
});

test("DG-1 bundleId: 结果为 64 位 hex", () => {
  const id = computeBehaviorBundleId(makeComponents());
  assert.equal(typeof id, "string");
  assert.match(id, /^[a-f0-9]{64}$/);
});

// ============================================================================
// 2. 组件提取
// ============================================================================

test("DG-1 extract: 完整 manifest 提取全部组件", () => {
  const m = makeManifest();
  const components = extractBehaviorComponents(m);
  assert.ok(components !== null);
  assert.equal(components.modelVersion, "gemini-3.1-pro");
  assert.equal(components.promptBundleHash, "sha256:p1");
});

test("DG-1 extract: 任一组件缺失返回 null", () => {
  const m = makeManifest();
  delete m.modelRoutingHash;
  assert.equal(extractBehaviorComponents(m), null);
});

test("DG-1 extract: 组件为空字符串返回 null", () => {
  const m = makeManifest({ modelVersion: "" });
  assert.equal(extractBehaviorComponents(m), null);
});

// ============================================================================
// 3. 行为身份完整性
// ============================================================================

test("DG-1 identity: 完整 manifest 完整性 ok", () => {
  const result = assertBehaviorIdentityComplete(makeManifest());
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingFields, []);
});

test("DG-1 identity: 旧 manifest（无行为身份）列出全部缺失字段", () => {
  const m = {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId: "rel-legacy",
    status: "active_prod",
    parentReleaseId: null,
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass: "R1",
    claims: [],
    environmentFingerprint: "sha256:abc",
    artifactRefs: [],
    approvalRef: "approval-x",
    createdAt: "2026-07-16T00:00:00Z",
    activatedAt: null,
  };
  const result = assertBehaviorIdentityComplete(m);
  assert.equal(result.ok, false);
  assert.ok(result.missingFields.includes("bundleId"));
  assert.ok(result.missingFields.includes("modelVersion"));
  assert.ok(result.missingFields.includes("evalProtocolVersion"));
  assert.ok(result.missingFields.includes("strategyEvidencePartition"));
});

test("DG-1 identity: 仅缺单一字段时精确列出该字段", () => {
  const m = makeManifest();
  delete m.qualityPolicyHash;
  const result = assertBehaviorIdentityComplete(m);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingFields, ["qualityPolicyHash"]);
});

// ============================================================================
// 4. bundleId 一致性
// ============================================================================

test("DG-1 consistency: 记录的 bundleId 与组件派生一致 → ok", () => {
  const result = validateBundleIdConsistency(makeManifest());
  assert.equal(result.ok, true);
  assert.equal(result.recomputed, result.recorded);
});

test("DG-1 consistency: bundleId 漂移（记录值 ≠ 派生值）→ ok=false", () => {
  const m = makeManifest({ bundleId: "deadbeef".repeat(8) });
  const result = validateBundleIdConsistency(m);
  assert.equal(result.ok, false);
  assert.notEqual(result.recomputed, result.recorded);
  assert.match(result.recomputed, /^[a-f0-9]{64}$/);
});

test("DG-1 consistency: 组件缺失时 recomputed=null", () => {
  const m = makeManifest();
  delete m.runtimeFingerprint;
  const result = validateBundleIdConsistency(m);
  assert.equal(result.ok, false);
  assert.equal(result.recomputed, null);
});

test("DG-1 consistency: bundleId 缺失时 recorded=null", () => {
  const m = makeManifest();
  delete m.bundleId;
  const result = validateBundleIdConsistency(m);
  assert.equal(result.ok, false);
  assert.equal(result.recorded, null);
});

// ============================================================================
// 5. 策略证据分区形状
// ============================================================================

test("DG-1 partition: 合法分区通过", () => {
  const partitions = makeManifest().strategyEvidencePartition;
  const result = validateStrategyEvidencePartitions(partitions);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("DG-1 partition: undefined 视为通过（可选）", () => {
  const result = validateStrategyEvidencePartitions(undefined);
  assert.equal(result.ok, true);
});

test("DG-1 partition: 缺键项报告错误", () => {
  const result = validateStrategyEvidencePartitions([
    { modelVersion: "v1", bundleId: "b1", strategyId: "s1" }, // 缺 evalProtocolVersion
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /evalProtocolVersion/.test(e)));
});

test("DG-1 partition: 重复四元组报告错误", () => {
  const p = { modelVersion: "v1", bundleId: "b1", strategyId: "s1", evalProtocolVersion: "e1" };
  const result = validateStrategyEvidencePartitions([p, { ...p }]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /重复/.test(e)));
});

// ============================================================================
// 6. schema 校验扩展（可选字段类型校验）
// ============================================================================

test("DG-1 schema: bundleId 存在但为空字符串拒绝", () => {
  const m = makeManifest({ bundleId: "" });
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /bundleId/);
});

test("DG-1 schema: strategyEvidencePartition 项缺键拒绝", () => {
  const m = makeManifest({
    strategyEvidencePartition: [{ modelVersion: "v1", bundleId: "b1", strategyId: "s1" }],
  });
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /evalProtocolVersion/);
});

test("DG-1 schema: 合法完整 manifest（含行为身份）通过", () => {
  const result = validateManifest(makeManifest());
  assert.equal(result.ok, true);
});

// ============================================================================
// 7. frozen 不可变覆盖新增字段
// ============================================================================

test("DG-1 frozen: bundleId 变更 → frozen 违规", () => {
  const before = makeManifest({ status: "frozen" });
  const after = makeManifest({ status: "frozen", bundleId: "deadbeef".repeat(8) });
  const result = assertFrozenImmutable(before, after);
  assert.equal(result.ok, false);
  assert.ok(result.changedFields.includes("bundleId"));
});

test("DG-1 frozen: strategyEvidencePartition 变更 → frozen 违规", () => {
  const before = makeManifest({ status: "frozen" });
  const after = makeManifest({ status: "frozen", strategyEvidencePartition: [] });
  const result = assertFrozenImmutable(before, after);
  assert.equal(result.ok, false);
  assert.ok(result.changedFields.includes("strategyEvidencePartition"));
});
