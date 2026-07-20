/**
 * EVOLUTION-RELEASE-GOVERNANCE-G8 - 健康判定纯函数测试（RED）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §8 Phase G8
 * 计划：.trae/documents/g8-health-monitoring-and-retirement-implementation.md §2.2
 *
 * 本测试覆盖 release-health-evaluator 纯函数：
 * - 健康状态判定（healthy/warning/auto_hold_eligible/retired_suggestion/insufficient_data）
 * - 幂等（已 held 不重复触发 shouldAutoHold）
 * - 滞回（recoveryAlignmentRate=0.8 > AUTO_HOLD_ALIGNMENT_RATE=0.4）
 * - 优先级（auto_hold_eligible 优先于 retired_suggestion）
 * - 边界（null factGuardPassRate / sampleCount=0 / 窗口不足）
 *
 * RED 状态：import 的模块尚未实现，所有测试因 import 失败而 fail。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateReleaseHealth } from "../dist-test/v2/governance/release-health-evaluator.js";
import {
  MIN_SAMPLE_SIZE,
  HEALTHY_ALIGNMENT_RATE,
  AUTO_HOLD_ALIGNMENT_RATE,
  AUTO_HOLD_ROLLBACK_RATE,
  AUTO_HOLD_CONSECUTIVE_NEGATIVE,
  RETIRED_ALIGNMENT_RATE,
  RETIRED_EVALUATION_WINDOW,
  RECOVERY_ALIGNMENT_RATE,
  AUTO_HOLD_FACTGUARD_PASS_RATE,
} from "../dist-test/v2/governance/release-health-thresholds.js";

// ============================================================================
// helpers
// ============================================================================

/**
 * 构造最小 ReleaseHealthReport 测试数据。
 * 默认值代表一个 sampleCount=5, alignmentRate=0.8 的健康 release。
 */
function makeHealthReport(overrides = {}) {
  const aligned = overrides.alignmentStats?.aligned ?? 4;
  const misaligned = overrides.alignmentStats?.misaligned ?? 1;
  const total = aligned + misaligned;
  const alignmentRate = total > 0 ? aligned / total : 0;

  const rolledBack = overrides.rollbackStats?.rolledBack ?? 0;
  const notRolledBack = overrides.rollbackStats?.notRolledBack ?? 0;
  const totalFeedbackRecords = overrides.totalFeedbackRecords ?? 5;
  const rollbackRate = totalFeedbackRecords > 0 ? rolledBack / totalFeedbackRecords : 0;

  return {
    generatedAt: "2026-07-17T00:00:00.000Z",
    workspaceId: "ws-test",
    totalFeedbackRecords,
    actionBreakdown: {
      accept: 4,
      accept_with_edits: 0,
      reject: 1,
      inspect: 0,
      rollback: 0,
      ...overrides.actionBreakdown,
    },
    alignmentStats: {
      aligned,
      misaligned,
      alignmentRate,
      ...overrides.alignmentStats,
    },
    editStats: {
      editedApprovals: 0,
      averageEditDistance: null,
      heavyEdits: 0,
      ...overrides.editStats,
    },
    factGuardStats: {
      total: 0,
      passed: 0,
      blocked: 0,
      passRate: null,
      ...overrides.factGuardStats,
    },
    rollbackStats: {
      rolledBack,
      notRolledBack,
      ...overrides.rollbackStats,
    },
    strategyReputations: overrides.strategyReputations ?? [],
    ...overrides,
    // 重新计算 derived 字段（除非调用方显式覆盖）
    alignmentStats: {
      aligned,
      misaligned,
      alignmentRate,
      ...overrides.alignmentStats,
    },
  };
}

/**
 * 构造 evaluator 输入选项。
 * 默认 currentStatus="active_dev", longTermAlignmentRate=0.8, consecutiveNegative=0。
 */
function makeEvalOptions(overrides = {}) {
  return {
    releaseId: "rel-test-001",
    currentStatus: "active_dev",
    healthReport: makeHealthReport(),
    longTermAlignmentRate: 0.8,
    consecutiveNegative: 0,
    ...overrides,
  };
}

// ============================================================================
// 健康判定逻辑
// ============================================================================

test("1. insufficient_data: sampleCount < MIN_SAMPLE_SIZE", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 2,
    alignmentStats: { aligned: 2, misaligned: 0, alignmentRate: 1.0 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 1.0,
  }));
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.evidence.sampleCount, 2);
  assert.equal(result.decision.shouldAutoHold, false);
  assert.equal(result.decision.shouldSuggestRetired, false);
});

test("2. healthy: sampleCount=5, alignmentRate=0.8", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 4, misaligned: 1, alignmentRate: 0.8 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 0.8,
  }));
  assert.equal(result.status, "healthy");
  assert.equal(result.decision.shouldAutoHold, false);
  assert.equal(result.decision.shouldSuggestRetired, false);
});

test("3. warning: sampleCount=5, alignmentRate=0.6 (< HEALTHY_ALIGNMENT_RATE 但 > AUTO_HOLD_ALIGNMENT_RATE)", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 3, misaligned: 2, alignmentRate: 0.6 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 0.6,
  }));
  assert.equal(result.status, "warning");
  assert.equal(result.decision.shouldAutoHold, false);
});

test("4. auto_hold_eligible: alignmentRate=0.3 (< AUTO_HOLD_ALIGNMENT_RATE)", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 1, misaligned: 4, alignmentRate: 0.2 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 0.2,
  }));
  assert.equal(result.status, "auto_hold_eligible");
  assert.equal(result.decision.shouldAutoHold, true);
});

test("5. auto_hold_eligible: rollbackRate=0.4 (> AUTO_HOLD_ROLLBACK_RATE)", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 5, misaligned: 0, alignmentRate: 1.0 },
    rollbackStats: { rolledBack: 2, notRolledBack: 0 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 1.0,
  }));
  assert.equal(result.status, "auto_hold_eligible");
  assert.equal(result.decision.shouldAutoHold, true);
  // evidence.rollbackRate 应为 2/5=0.4
  assert.ok(result.evidence.rollbackRate >= AUTO_HOLD_ROLLBACK_RATE);
});

test("6. auto_hold_eligible: consecutiveNegative=3 (>= AUTO_HOLD_CONSECUTIVE_NEGATIVE)", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 5, misaligned: 0, alignmentRate: 1.0 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 1.0,
    consecutiveNegative: 3,
  }));
  assert.equal(result.status, "auto_hold_eligible");
  assert.equal(result.decision.shouldAutoHold, true);
  assert.equal(result.evidence.consecutiveNegative, 3);
});

test("7. auto_hold_eligible: factGuardPassRate=0.4 (< AUTO_HOLD_FACTGUARD_PASS_RATE)", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 5, misaligned: 0, alignmentRate: 1.0 },
    factGuardStats: { total: 5, passed: 2, blocked: 3, passRate: 0.4 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 1.0,
  }));
  assert.equal(result.status, "auto_hold_eligible");
  assert.equal(result.decision.shouldAutoHold, true);
});

test("8. retired_suggestion: longTermAlignmentRate=0.2 (< RETIRED_ALIGNMENT_RATE)", () => {
  // 构造一个 alignmentRate 健康（避免触发 auto_hold）、但长期 alignmentRate 低的数据
  const report = makeHealthReport({
    totalFeedbackRecords: 10,
    alignmentStats: { aligned: 7, misaligned: 3, alignmentRate: 0.7 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 0.2,
  }));
  assert.equal(result.status, "retired_suggestion");
  assert.equal(result.decision.shouldSuggestRetired, true);
  // retired_suggestion 不触发 auto-hold
  assert.equal(result.decision.shouldAutoHold, false);
});

// ============================================================================
// 幂等
// ============================================================================

test("9. alreadyHeld=true: currentStatus=held -> shouldAutoHold=false", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 0, misaligned: 5, alignmentRate: 0.0 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    currentStatus: "held",
    healthReport: report,
    longTermAlignmentRate: 0.0,
  }));
  assert.equal(result.decision.alreadyHeld, true);
  assert.equal(result.decision.shouldAutoHold, false);
});

test("10. alreadyHeld=false: currentStatus=active_dev -> shouldAutoHold=true (满足阈值时)", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 0, misaligned: 5, alignmentRate: 0.0 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    currentStatus: "active_dev",
    healthReport: report,
    longTermAlignmentRate: 0.0,
  }));
  assert.equal(result.decision.alreadyHeld, false);
  assert.equal(result.decision.shouldAutoHold, true);
});

// ============================================================================
// 滞回
// ============================================================================

test("11. recoveryAlignmentRate 始终返回 RECOVERY_ALIGNMENT_RATE=0.8", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 4, misaligned: 1, alignmentRate: 0.8 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 0.8,
  }));
  assert.equal(result.decision.recoveryAlignmentRate, RECOVERY_ALIGNMENT_RATE);
  assert.equal(result.decision.recoveryAlignmentRate, 0.8);
});

test("12. overrideHint: 已 held 且 alignmentRate=0.6 (< recoveryAlignmentRate=0.8)", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 3, misaligned: 2, alignmentRate: 0.6 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    currentStatus: "held",
    healthReport: report,
    longTermAlignmentRate: 0.6,
  }));
  assert.equal(result.decision.alreadyHeld, true);
  assert.ok(result.overrideHint, "应有 overrideHint");
  assert.ok(result.overrideHint.includes("--force"), "overrideHint 应提示 --force");
});

// ============================================================================
// 优先级
// ============================================================================

test("13. auto_hold_eligible 优先于 retired_suggestion (同时满足时取 auto_hold)", () => {
  // alignmentRate=0.2 触发 auto_hold；longTermAlignmentRate=0.2 触发 retired_suggestion
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 1, misaligned: 4, alignmentRate: 0.2 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 0.2,
  }));
  assert.equal(result.status, "auto_hold_eligible");
  assert.equal(result.decision.shouldAutoHold, true);
  // retired_suggestion 也可以为 true（建议层），但 status 取 auto_hold_eligible
  // 注：这里不强制 shouldSuggestRetired 的值，只验证 status 优先级
});

test("14. retired_suggestion 不触发 shouldAutoHold", () => {
  // alignmentRate 健康（0.8），longTermAlignmentRate=0.2 触发 retired_suggestion
  const report = makeHealthReport({
    totalFeedbackRecords: 10,
    alignmentStats: { aligned: 8, misaligned: 2, alignmentRate: 0.8 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 0.2,
  }));
  assert.equal(result.status, "retired_suggestion");
  assert.equal(result.decision.shouldAutoHold, false);
  assert.equal(result.decision.shouldSuggestRetired, true);
});

// ============================================================================
// 边界
// ============================================================================

test("15. factGuardPassRate=null: 不触发 auto_hold", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 5, misaligned: 0, alignmentRate: 1.0 },
    factGuardStats: { total: 0, passed: 0, blocked: 0, passRate: null },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 1.0,
  }));
  // factGuardPassRate=null 不触发 auto_hold；alignmentRate=1.0 健康
  assert.equal(result.status, "healthy");
  assert.equal(result.decision.shouldAutoHold, false);
});

test("16. longTermAlignmentRate 窗口不足: 用实际 feedback 数计算 (fallback 到 alignmentRate)", () => {
  // 未提供 longTermAlignmentRate 时，应 fallback 到 healthReport.alignmentStats.alignmentRate
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 4, misaligned: 1, alignmentRate: 0.8 },
  });
  const result = evaluateReleaseHealth({
    releaseId: "rel-test-001",
    currentStatus: "active_dev",
    healthReport: report,
    // 不提供 longTermAlignmentRate，期望 fallback 到 0.8
  });
  assert.equal(result.evidence.longTermAlignmentRate, 0.8);
  assert.equal(result.status, "healthy");
});

test("17. sampleCount=0: insufficient_data", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 0,
    alignmentStats: { aligned: 0, misaligned: 0, alignmentRate: 0 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 0,
  }));
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.evidence.sampleCount, 0);
});

test("18. alignmentRate=0: auto_hold_eligible", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 0, misaligned: 5, alignmentRate: 0.0 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 0.0,
  }));
  assert.equal(result.status, "auto_hold_eligible");
  assert.equal(result.decision.shouldAutoHold, true);
});

test("19. rollbackRate=0: 不触发 auto_hold (其他指标健康时)", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 5, misaligned: 0, alignmentRate: 1.0 },
    rollbackStats: { rolledBack: 0, notRolledBack: 0 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 1.0,
  }));
  assert.equal(result.status, "healthy");
  assert.equal(result.evidence.rollbackRate, 0);
});

test("20. consecutiveNegative=0: 不触发 auto_hold (其他指标健康时)", () => {
  const report = makeHealthReport({
    totalFeedbackRecords: 5,
    alignmentStats: { aligned: 5, misaligned: 0, alignmentRate: 1.0 },
  });
  const result = evaluateReleaseHealth(makeEvalOptions({
    healthReport: report,
    longTermAlignmentRate: 1.0,
    consecutiveNegative: 0,
  }));
  assert.equal(result.status, "healthy");
  assert.equal(result.evidence.consecutiveNegative, 0);
});

// ============================================================================
// 阈值常量验证
// ============================================================================

test("阈值常量: MIN_SAMPLE_SIZE=3", () => {
  assert.equal(MIN_SAMPLE_SIZE, 3);
});

test("阈值常量: HEALTHY_ALIGNMENT_RATE=0.7", () => {
  assert.equal(HEALTHY_ALIGNMENT_RATE, 0.7);
});

test("阈值常量: AUTO_HOLD_ALIGNMENT_RATE=0.4", () => {
  assert.equal(AUTO_HOLD_ALIGNMENT_RATE, 0.4);
});

test("阈值常量: AUTO_HOLD_ROLLBACK_RATE=0.3", () => {
  assert.equal(AUTO_HOLD_ROLLBACK_RATE, 0.3);
});

test("阈值常量: AUTO_HOLD_CONSECUTIVE_NEGATIVE=3", () => {
  assert.equal(AUTO_HOLD_CONSECUTIVE_NEGATIVE, 3);
});

test("阈值常量: RETIRED_ALIGNMENT_RATE=0.3", () => {
  assert.equal(RETIRED_ALIGNMENT_RATE, 0.3);
});

test("阈值常量: RETIRED_EVALUATION_WINDOW=10", () => {
  assert.equal(RETIRED_EVALUATION_WINDOW, 10);
});

test("阈值常量: RECOVERY_ALIGNMENT_RATE=0.8", () => {
  assert.equal(RECOVERY_ALIGNMENT_RATE, 0.8);
});

test("阈值常量: AUTO_HOLD_FACTGUARD_PASS_RATE=0.5", () => {
  assert.equal(AUTO_HOLD_FACTGUARD_PASS_RATE, 0.5);
});
