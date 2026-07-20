/**
 * EVOLUTION-RELEASE-GOVERNANCE-G8 - eligibility 重算纯函数测试
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §8 Phase G8
 * 计划：.trae/documents/g8-health-monitoring-and-retirement-implementation.md §2.6
 *
 * 本测试覆盖 release-eligibility-recomputer 纯函数：
 * - eligibility 判定（intact / needs_requalify / unverifiable）
 * - retired strategy 关联检查（通过 approvalRef）
 * - suggestedAction 建议（requalify / hold / retire）
 * - 多个 retired strategy 全部列出
 *
 * 注：计划文档使用 "revoked" 术语，但实际 StrategyStatus 类型为 "retired"
 *（见 v2/learning/strategy-policy-store.ts:59）。测试数据使用 "retired" 匹配实际类型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { recomputeEligibility } from "../dist-test/v2/governance/release-eligibility-recomputer.js";

// ============================================================================
// helpers
// ============================================================================

/**
 * 构造 StrategyReputationSnapshot 测试数据。
 * 默认值代表一个 active 状态、sampleCount=5、winRate=0.8 的健康策略。
 */
function makeStrategy(overrides = {}) {
  return {
    modelVersion: "doubao-seed-2-1-pro",
    strategyId: "editorial-opportunity-v1",
    status: "active",
    alpha: 4,
    beta: 1,
    sampleCount: 5,
    winRate: 0.8,
    consecutiveLosses: 0,
    lastUpdated: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function makeOptions(overrides = {}) {
  return {
    strategyReputations: [],
    releaseId: "rel-test-001",
    approvalRef: "approval-artifact-001",
    alignmentRate: 0.8,
    longTermAlignmentRate: 0.8,
    ...overrides,
  };
}

// ============================================================================
// 1. intact: 无 revoked strategy
// ============================================================================

test("1. intact: 无 revoked strategy -> eligibility=intact, revokedStrategies=[], suggestedAction=undefined", () => {
  const result = recomputeEligibility(makeOptions({
    strategyReputations: [
      makeStrategy({ strategyId: "s1", status: "active" }),
      makeStrategy({ strategyId: "s2", status: "dormant" }),
    ],
  }));

  assert.equal(result.releaseId, "rel-test-001");
  assert.equal(result.eligibility, "intact");
  assert.equal(result.revokedStrategies.length, 0);
  assert.equal(result.suggestedAction, undefined, "intact 时不应有 suggestedAction");
  assert.equal(result.reason, undefined, "intact 时不应有 reason");
});

// ============================================================================
// 2. needs_requalify: 有 revoked strategy 且 approvalRef 非空
// ============================================================================

test("2. needs_requalify: 有 revoked strategy 且 approvalRef 非空 -> eligibility=needs_requalify", () => {
  const revokedStrategy = makeStrategy({
    strategyId: "s-revoked",
    status: "retired",
    sampleCount: 5,
  });
  const result = recomputeEligibility(makeOptions({
    strategyReputations: [
      makeStrategy({ strategyId: "s1", status: "active" }),
      revokedStrategy,
    ],
    approvalRef: "approval-artifact-001",
  }));

  assert.equal(result.eligibility, "needs_requalify");
  assert.equal(result.revokedStrategies.length, 1);
  assert.equal(result.revokedStrategies[0].strategyId, "s-revoked");
  assert.equal(result.revokedStrategies[0].status, "retired");
  assert.equal(result.reason, "strategy_retired");
});

// ============================================================================
// 3. unverifiable: approvalRef=null
// ============================================================================

test("3. unverifiable: approvalRef=null -> eligibility=unverifiable", () => {
  const revokedStrategy = makeStrategy({
    strategyId: "s-revoked",
    status: "retired",
  });
  const result = recomputeEligibility(makeOptions({
    strategyReputations: [
      revokedStrategy,
    ],
    approvalRef: null,
  }));

  assert.equal(result.eligibility, "unverifiable");
  assert.equal(result.revokedStrategies.length, 1);
  assert.equal(result.revokedStrategies[0].strategyId, "s-revoked");
  assert.ok(result.reason, "unverifiable 应有 reason 说明");
  assert.ok(result.reason.includes("approvalRef"), "reason 应提及 approvalRef 为空");
});

// ============================================================================
// 4. suggestedAction="requalify": needs_requalify 且 revoked strategy sampleCount >= 3
// ============================================================================

test("4. suggestedAction=requalify: needs_requalify 且 revoked strategy sampleCount >= 3 且 alignment/longTerm 健康", () => {
  const revokedStrategy = makeStrategy({
    strategyId: "s-revoked",
    status: "retired",
    sampleCount: 5, // >= MIN_SAMPLE_SIZE (3)
  });
  const result = recomputeEligibility(makeOptions({
    strategyReputations: [revokedStrategy],
    approvalRef: "approval-artifact-001",
    // alignmentRate 与 longTermAlignmentRate 都健康，不应触发 hold/retire
    alignmentRate: 0.8,
    longTermAlignmentRate: 0.8,
  }));

  assert.equal(result.eligibility, "needs_requalify");
  assert.equal(result.suggestedAction, "requalify");
});

// ============================================================================
// 5. suggestedAction="hold": needs_requalify 且 alignmentRate < 0.4
// ============================================================================

test("5. suggestedAction=hold: needs_requalify 且 alignmentRate < AUTO_HOLD_ALIGNMENT_RATE(0.4)", () => {
  const revokedStrategy = makeStrategy({
    strategyId: "s-revoked",
    status: "retired",
    sampleCount: 5,
  });
  const result = recomputeEligibility(makeOptions({
    strategyReputations: [revokedStrategy],
    approvalRef: "approval-artifact-001",
    alignmentRate: 0.3, // < 0.4
    longTermAlignmentRate: 0.5, // >= 0.3（不触发 retire）
  }));

  assert.equal(result.eligibility, "needs_requalify");
  assert.equal(result.suggestedAction, "hold");
});

// ============================================================================
// 6. suggestedAction="retire": needs_requalify 且 longTermAlignmentRate < 0.3
// ============================================================================

test("6. suggestedAction=retire: needs_requalify 且 longTermAlignmentRate < RETIRED_ALIGNMENT_RATE(0.3)", () => {
  const revokedStrategy = makeStrategy({
    strategyId: "s-revoked",
    status: "retired",
    sampleCount: 5,
  });
  const result = recomputeEligibility(makeOptions({
    strategyReputations: [revokedStrategy],
    approvalRef: "approval-artifact-001",
    alignmentRate: 0.3, // < 0.4 但 longTerm 更差，应优先 retire
    longTermAlignmentRate: 0.2, // < 0.3
  }));

  assert.equal(result.eligibility, "needs_requalify");
  assert.equal(result.suggestedAction, "retire", "longTerm < 0.3 应优先 retire 而非 hold");
});

// ============================================================================
// 7. 多个 revoked strategy：全部列出
// ============================================================================

test("7. 多个 revoked strategy: revokedStrategies 全部列出", () => {
  const revoked1 = makeStrategy({ strategyId: "s-revoked-1", status: "retired", modelVersion: "m1" });
  const revoked2 = makeStrategy({ strategyId: "s-revoked-2", status: "retired", modelVersion: "m2" });
  const result = recomputeEligibility(makeOptions({
    strategyReputations: [
      makeStrategy({ strategyId: "s-active", status: "active" }),
      revoked1,
      revoked2,
    ],
    approvalRef: "approval-artifact-001",
  }));

  assert.equal(result.eligibility, "needs_requalify");
  assert.equal(result.revokedStrategies.length, 2, "应列出所有 revoked strategy");
  const ids = result.revokedStrategies.map((s) => s.strategyId).sort();
  assert.deepEqual(ids, ["s-revoked-1", "s-revoked-2"]);
});

// ============================================================================
// 8. eligibility="intact" 时 suggestedAction=undefined
// ============================================================================

test("8. eligibility=intact 时 suggestedAction=undefined（即使 alignmentRate 低）", () => {
  // 即使 alignmentRate 很低，如果没有 revoked strategy，eligibility=intact，不应有 suggestedAction
  const result = recomputeEligibility(makeOptions({
    strategyReputations: [
      makeStrategy({ strategyId: "s-active", status: "active" }),
    ],
    approvalRef: "approval-artifact-001",
    alignmentRate: 0.1, // 很低
    longTermAlignmentRate: 0.1, // 很低
  }));

  assert.equal(result.eligibility, "intact");
  assert.equal(result.suggestedAction, undefined, "intact 时不应有 suggestedAction");
});
