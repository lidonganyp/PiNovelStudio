/**
 * STRATEGY-ADMISSION-1B：分区 evidence 驱动的状态建议、回滚与反向测试
 *
 * 验收口径（docs/remaining-development-dispatch-plan-20260715.md §7 STRATEGY-ADMISSION-1B）：
 * - 消费 evidence artifact（StrategyEvidenceRecord[]），显式产生 candidate/active 建议
 * - 按 modelVersion + strategyId 分区；同一 modelVersion 不同 strategyId 互不汇总
 * - 阈值：每分区 eligible decisions >=5 且 human-equivalent verdicts >=3 才建议 active
 * - rollback/reverse：revoke evidence 后重算，active 建议应降回 candidate
 * - 不自动改生产（不调用 StrategyPolicyStore.setStatus、不写 alpha/beta、不写文件）
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不保存章节、不提交长期状态
 * - 仅产生纯读建议；调用方决定是否显式 setStatus
 * - 普通机器审阅不得冒充 human-equivalent
 * - 跨模型/跨策略污染测试失败即阻断
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compileAdmissionDecisions,
  MIN_ADMISSION_ELIGIBLE_DECISIONS,
  MIN_ADMISSION_HUMAN_VERDICTS,
  revokeEvidence,
} from "../dist/v2/core/strategy-evidence-dataset.js";

// ============================================================================
// Fixture
// ============================================================================

function makeRecord(overrides = {}) {
  return {
    evidenceId: "ev-001",
    strategyId: "strategy-A",
    modelVersion: "glm-5.2",
    orchestratorRunId: "run-001",
    sourceChapter: "ch17",
    outcome: "win",
    source: "judge",
    weight: 1.0,
    timestamp: "2026-07-14T10:00:00Z",
    revoked: false,
    hasHumanVerdict: false,
    fromEligiblePair: false,
    polluted: false,
    quarantined: false,
    ...overrides,
  };
}

/** 构造 N 条同 (modelVersion, strategyId) 的 effective+human+eligible 证据 */
function makeEligibleHumanEvidence({
  count,
  modelVersion,
  strategyId,
  startEvidenceId,
  startRunId,
}) {
  const records = [];
  for (let i = 0; i < count; i += 1) {
    records.push(
      makeRecord({
        evidenceId: `${startEvidenceId}-${i}`,
        orchestratorRunId: `${startRunId}-${i}`,
        modelVersion,
        strategyId,
        fromEligiblePair: true,
        hasHumanVerdict: true,
      })
    );
  }
  return records;
}

// ============================================================================
// 0. 常量与导出契约
// ============================================================================

test("STRATEGY-ADMISSION-1B: 阈值常量导出且与 StrategyPolicyStore 一致", () => {
  assert.equal(MIN_ADMISSION_ELIGIBLE_DECISIONS, 5);
  assert.equal(MIN_ADMISSION_HUMAN_VERDICTS, 3);
});

test("STRATEGY-ADMISSION-1B: compileAdmissionDecisions 是函数", () => {
  assert.equal(typeof compileAdmissionDecisions, "function");
});

// ============================================================================
// 1. 空/无证据输入
// ============================================================================

test("空 records 返回空数组（不伪造分区）", () => {
  const decisions = compileAdmissionDecisions([]);
  assert.deepEqual(decisions, []);
});

test("无 effective 证据（全部 revoked/polluted/quarantined）返回空数组", () => {
  const decisions = compileAdmissionDecisions([
    makeRecord({ evidenceId: "ev-r", revoked: true }),
    makeRecord({ evidenceId: "ev-p", polluted: true }),
    makeRecord({ evidenceId: "ev-q", quarantined: true }),
  ]);
  assert.deepEqual(decisions, []);
});

// ============================================================================
// 2. 单分区阈值
// ============================================================================

test("单分区满足 5 eligible + 3 human → 建议 active", () => {
  const records = makeEligibleHumanEvidence({
    count: 5,
    modelVersion: "glm-5.2",
    strategyId: "reader_payoff_strengthen",
    startEvidenceId: "ev-active",
    startRunId: "run-active",
  });
  const decisions = compileAdmissionDecisions(records);
  assert.equal(decisions.length, 1);
  const d = decisions[0];
  assert.equal(d.strategyId, "reader_payoff_strengthen");
  assert.equal(d.modelVersion, "glm-5.2");
  assert.equal(d.recommendedStatus, "active");
  assert.equal(d.eligibleDecisionCount, 5);
  assert.equal(d.humanVerdictCount, 5);
  assert.match(d.reason, /admission|threshold|satisf/i);
});

test("eligible < 5 → 建议 candidate（即使 human 充足）", () => {
  const records = makeEligibleHumanEvidence({
    count: 4,
    modelVersion: "glm-5.2",
    strategyId: "strategy-A",
    startEvidenceId: "ev-low-elig",
    startRunId: "run-low-elig",
  });
  const decisions = compileAdmissionDecisions(records);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].recommendedStatus, "candidate");
  assert.equal(decisions[0].eligibleDecisionCount, 4);
  assert.match(decisions[0].reason, /eligible/i);
});

test("human < 3 → 建议 candidate（即使 eligible 充足）", () => {
  // 5 个 eligible，但只有 2 个含 human verdict
  const records = [];
  for (let i = 0; i < 5; i += 1) {
    records.push(
      makeRecord({
        evidenceId: `ev-low-h-${i}`,
        orchestratorRunId: `run-low-h-${i}`,
        strategyId: "strategy-A",
        modelVersion: "glm-5.2",
        fromEligiblePair: true,
        hasHumanVerdict: i < 2,
      })
    );
  }
  const decisions = compileAdmissionDecisions(records);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].recommendedStatus, "candidate");
  assert.equal(decisions[0].eligibleDecisionCount, 5);
  assert.equal(decisions[0].humanVerdictCount, 2);
  assert.match(decisions[0].reason, /human/i);
});

test("刚好 5/3 边界 → 建议 active", () => {
  const records = [];
  for (let i = 0; i < 5; i += 1) {
    records.push(
      makeRecord({
        evidenceId: `ev-bound-${i}`,
        orchestratorRunId: `run-bound-${i}`,
        strategyId: "strategy-A",
        modelVersion: "glm-5.2",
        fromEligiblePair: true,
        hasHumanVerdict: i < 3,
      })
    );
  }
  const decisions = compileAdmissionDecisions(records);
  assert.equal(decisions[0].recommendedStatus, "active");
  assert.equal(decisions[0].eligibleDecisionCount, 5);
  assert.equal(decisions[0].humanVerdictCount, 3);
});

// ============================================================================
// 3. 分区隔离：modelVersion + strategyId
// ============================================================================

test("同一 modelVersion 不同 strategyId 互不汇总（各自独立分区）", () => {
  // strategy-A 满足 5/3；strategy-B 只有 1 条
  const recordsA = makeEligibleHumanEvidence({
    count: 5,
    modelVersion: "glm-5.2",
    strategyId: "strategy-A",
    startEvidenceId: "ev-A",
    startRunId: "run-A",
  });
  const recordsB = [
    makeRecord({
      evidenceId: "ev-B-0",
      orchestratorRunId: "run-B-0",
      strategyId: "strategy-B",
      modelVersion: "glm-5.2",
      fromEligiblePair: true,
      hasHumanVerdict: true,
    }),
  ];
  const decisions = compileAdmissionDecisions([...recordsA, ...recordsB]);
  assert.equal(decisions.length, 2);
  const decA = decisions.find((d) => d.strategyId === "strategy-A");
  const decB = decisions.find((d) => d.strategyId === "strategy-B");
  assert.ok(decA);
  assert.ok(decB);
  assert.equal(decA.recommendedStatus, "active");
  assert.equal(decB.recommendedStatus, "candidate");
  assert.equal(decB.eligibleDecisionCount, 1);
});

test("同一 strategyId 不同 modelVersion 互不汇总（模型版本隔离）", () => {
  // glm-5.2 分区满足 5/3；doubao-2.1 分区只有 1 条
  const recordsGlm = makeEligibleHumanEvidence({
    count: 5,
    modelVersion: "glm-5.2",
    strategyId: "strategy-A",
    startEvidenceId: "ev-glm",
    startRunId: "run-glm",
  });
  const recordsDoubao = [
    makeRecord({
      evidenceId: "ev-doubao-0",
      orchestratorRunId: "run-doubao-0",
      strategyId: "strategy-A",
      modelVersion: "doubao-2.1",
      fromEligiblePair: true,
      hasHumanVerdict: true,
    }),
  ];
  const decisions = compileAdmissionDecisions([...recordsGlm, ...recordsDoubao]);
  assert.equal(decisions.length, 2);
  const decGlm = decisions.find((d) => d.modelVersion === "glm-5.2");
  const decDoubao = decisions.find((d) => d.modelVersion === "doubao-2.1");
  assert.equal(decGlm.recommendedStatus, "active");
  assert.equal(decDoubao.recommendedStatus, "candidate");
});

test("跨模型污染：glm-5.2 的证据不得让 doubao-2.1 同 strategy 越级 active", () => {
  // glm-5.2 有 5/3；doubao-2.1 实际只有 1 条；合并后 doubao 仍应 candidate
  const records = [
    ...makeEligibleHumanEvidence({
      count: 5,
      modelVersion: "glm-5.2",
      strategyId: "shared-strategy",
      startEvidenceId: "ev-glm",
      startRunId: "run-glm",
    }),
    makeRecord({
      evidenceId: "ev-doubao-0",
      orchestratorRunId: "run-doubao-0",
      strategyId: "shared-strategy",
      modelVersion: "doubao-2.1",
      fromEligiblePair: true,
      hasHumanVerdict: true,
    }),
  ];
  const decisions = compileAdmissionDecisions(records);
  const decDoubao = decisions.find(
    (d) => d.modelVersion === "doubao-2.1" && d.strategyId === "shared-strategy"
  );
  assert.ok(decDoubao);
  assert.equal(decDoubao.recommendedStatus, "candidate");
  assert.equal(decDoubao.eligibleDecisionCount, 1);
});

test("跨策略污染：strategy-A 的证据不得让同模型 strategy-B 越级 active", () => {
  const records = [
    ...makeEligibleHumanEvidence({
      count: 5,
      modelVersion: "glm-5.2",
      strategyId: "strategy-A",
      startEvidenceId: "ev-A",
      startRunId: "run-A",
    }),
    makeRecord({
      evidenceId: "ev-B-0",
      orchestratorRunId: "run-B-0",
      strategyId: "strategy-B",
      modelVersion: "glm-5.2",
      fromEligiblePair: true,
      hasHumanVerdict: true,
    }),
  ];
  const decisions = compileAdmissionDecisions(records);
  const decB = decisions.find(
    (d) => d.modelVersion === "glm-5.2" && d.strategyId === "strategy-B"
  );
  assert.ok(decB);
  assert.equal(decB.recommendedStatus, "candidate");
  assert.equal(decB.eligibleDecisionCount, 1);
});

// ============================================================================
// 4. 证据过滤：revoked / polluted / quarantined 不计分区
// ============================================================================

test("revoked evidence 不计入分区（active 失去证据后降为 candidate）", () => {
  // 6 条 eligible+human，其中 2 条 revoked → effective 4 条 → candidate
  const records = [];
  for (let i = 0; i < 6; i += 1) {
    records.push(
      makeRecord({
        evidenceId: `ev-r-${i}`,
        orchestratorRunId: `run-r-${i}`,
        strategyId: "strategy-A",
        modelVersion: "glm-5.2",
        fromEligiblePair: true,
        hasHumanVerdict: true,
        revoked: i >= 4,
      })
    );
  }
  const decisions = compileAdmissionDecisions(records);
  assert.equal(decisions[0].eligibleDecisionCount, 4);
  assert.equal(decisions[0].recommendedStatus, "candidate");
});

test("polluted evidence 不计入分区（RQ3 负面样本不得提升策略）", () => {
  const records = [];
  for (let i = 0; i < 6; i += 1) {
    records.push(
      makeRecord({
        evidenceId: `ev-p-${i}`,
        orchestratorRunId: `run-p-${i}`,
        strategyId: "strategy-A",
        modelVersion: "glm-5.2",
        fromEligiblePair: true,
        hasHumanVerdict: true,
        polluted: i >= 4,
      })
    );
  }
  const decisions = compileAdmissionDecisions(records);
  assert.equal(decisions[0].eligibleDecisionCount, 4);
  assert.equal(decisions[0].recommendedStatus, "candidate");
});

test("quarantined evidence 不计入分区（冲突证据不自动选边）", () => {
  const records = [];
  for (let i = 0; i < 6; i += 1) {
    records.push(
      makeRecord({
        evidenceId: `ev-q-${i}`,
        orchestratorRunId: `run-q-${i}`,
        strategyId: "strategy-A",
        modelVersion: "glm-5.2",
        fromEligiblePair: true,
        hasHumanVerdict: true,
        quarantined: i >= 4,
      })
    );
  }
  const decisions = compileAdmissionDecisions(records);
  assert.equal(decisions[0].eligibleDecisionCount, 4);
  assert.equal(decisions[0].recommendedStatus, "candidate");
});

test("重复 run 去重：同 (orchestratorRunId, strategyId, modelVersion) 只算一次", () => {
  const records = [];
  // 5 个唯一 run，每个再重复一次 → effective 仍为 5
  for (let i = 0; i < 5; i += 1) {
    records.push(
      makeRecord({
        evidenceId: `ev-uniq-${i}`,
        orchestratorRunId: `run-uniq-${i}`,
        strategyId: "strategy-A",
        modelVersion: "glm-5.2",
        fromEligiblePair: true,
        hasHumanVerdict: true,
      })
    );
    records.push(
      makeRecord({
        evidenceId: `ev-dup-${i}`,
        orchestratorRunId: `run-uniq-${i}`, // 重复 run
        strategyId: "strategy-A",
        modelVersion: "glm-5.2",
        fromEligiblePair: true,
        hasHumanVerdict: true,
      })
    );
  }
  const decisions = compileAdmissionDecisions(records);
  assert.equal(decisions[0].eligibleDecisionCount, 5);
  assert.equal(decisions[0].recommendedStatus, "active");
});

// ============================================================================
// 5. Rollback / Reverse：revoke 后重算降级
// ============================================================================

test("rollback：active 建议在 revoke 关键 evidence 后降为 candidate", () => {
  // 初始 5/5 → active
  const records = makeEligibleHumanEvidence({
    count: 5,
    modelVersion: "glm-5.2",
    strategyId: "strategy-A",
    startEvidenceId: "ev-roll",
    startRunId: "run-roll",
  });
  const before = compileAdmissionDecisions(records);
  assert.equal(before[0].recommendedStatus, "active");

  // 撤销 2 条 → 3 eligible → candidate
  const revoked = revokeEvidence(records, "ev-roll-0", "事后发现人审代理身份失效");
  const revoked2 = revokeEvidence(revoked, "ev-roll-1", "事后发现人审代理身份失效");
  const after = compileAdmissionDecisions(revoked2);
  assert.equal(after[0].recommendedStatus, "candidate");
  assert.equal(after[0].eligibleDecisionCount, 3);
});

test("rollback：revoke 全部 evidence 后该分区消失", () => {
  const records = makeEligibleHumanEvidence({
    count: 3,
    modelVersion: "glm-5.2",
    strategyId: "strategy-A",
    startEvidenceId: "ev-all",
    startRunId: "run-all",
  });
  let revoked = records;
  for (let i = 0; i < 3; i += 1) {
    revoked = revokeEvidence(revoked, `ev-all-${i}`, "整批撤销");
  }
  const decisions = compileAdmissionDecisions(revoked);
  assert.equal(decisions.length, 0);
});

test("reverse：revoke 后再 add 回等效 evidence，建议恢复 active（幂等重算）", () => {
  const records = makeEligibleHumanEvidence({
    count: 5,
    modelVersion: "glm-5.2",
    strategyId: "strategy-A",
    startEvidenceId: "ev-rev",
    startRunId: "run-rev",
  });
  // revoke 1 条 → 4 eligible → candidate
  const revoked = revokeEvidence(records, "ev-rev-0", "临时撤销");
  const mid = compileAdmissionDecisions(revoked);
  assert.equal(mid[0].recommendedStatus, "candidate");
  // 补回 1 条新 evidence → 5 eligible → active
  const replenished = [
    ...revoked,
    makeRecord({
      evidenceId: "ev-rev-new",
      orchestratorRunId: "run-rev-new",
      strategyId: "strategy-A",
      modelVersion: "glm-5.2",
      fromEligiblePair: true,
      hasHumanVerdict: true,
    }),
  ];
  const after = compileAdmissionDecisions(replenished);
  assert.equal(after[0].recommendedStatus, "active");
});

// ============================================================================
// 6. 不自动改生产
// ============================================================================

test("返回纯数据结构，不含 setStatus/alpha/beta 修改指令", () => {
  const records = makeEligibleHumanEvidence({
    count: 5,
    modelVersion: "glm-5.2",
    strategyId: "strategy-A",
    startEvidenceId: "ev-pure",
    startRunId: "run-pure",
  });
  const decisions = compileAdmissionDecisions(records);
  const json = JSON.stringify(decisions);
  // 不应包含直接修改生产信誉的字段
  assert.ok(!/setStatus|putReputation|recordOutcome|alpha\s*[:=]|beta\s*[:=]/i.test(json));
});

test("不修改入参 records（纯函数）", () => {
  const records = makeEligibleHumanEvidence({
    count: 5,
    modelVersion: "glm-5.2",
    strategyId: "strategy-A",
    startEvidenceId: "ev-immut",
    startRunId: "run-immut",
  });
  const snapshot = JSON.parse(JSON.stringify(records));
  compileAdmissionDecisions(records);
  assert.deepEqual(records, snapshot);
});

test("decisions 结构完整：strategyId/modelVersion/recommendedStatus/eligibleDecisionCount/humanVerdictCount/reason", () => {
  const records = makeEligibleHumanEvidence({
    count: 5,
    modelVersion: "glm-5.2",
    strategyId: "strategy-A",
    startEvidenceId: "ev-shape",
    startRunId: "run-shape",
  });
  const decisions = compileAdmissionDecisions(records);
  const d = decisions[0];
  assert.equal(typeof d.strategyId, "string");
  assert.equal(typeof d.modelVersion, "string");
  assert.ok(d.recommendedStatus === "candidate" || d.recommendedStatus === "active");
  assert.equal(typeof d.eligibleDecisionCount, "number");
  assert.equal(typeof d.humanVerdictCount, "number");
  assert.equal(typeof d.reason, "string");
  assert.ok(d.reason.length > 0);
});

// ============================================================================
// 7. 当前 dispatch plan 状态对照
// ============================================================================

test("当前 dispatch plan 状态：reader_payoff_strengthen=1/1 → candidate", () => {
  const records = [
    makeRecord({
      evidenceId: "ev-rps-0",
      orchestratorRunId: "run-rps-0",
      strategyId: "reader_payoff_strengthen",
      modelVersion: "glm-5.2",
      fromEligiblePair: true,
      hasHumanVerdict: true,
    }),
  ];
  const decisions = compileAdmissionDecisions(records);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].recommendedStatus, "candidate");
  assert.equal(decisions[0].eligibleDecisionCount, 1);
  assert.equal(decisions[0].humanVerdictCount, 1);
});

test("当前 dispatch plan 状态：character_agency_focus=2/2 → candidate", () => {
  const records = [
    makeRecord({
      evidenceId: "ev-caf-0",
      orchestratorRunId: "run-caf-0",
      strategyId: "character_agency_focus",
      modelVersion: "glm-5.2",
      fromEligiblePair: true,
      hasHumanVerdict: true,
    }),
    makeRecord({
      evidenceId: "ev-caf-1",
      orchestratorRunId: "run-caf-1",
      strategyId: "character_agency_focus",
      modelVersion: "glm-5.2",
      fromEligiblePair: true,
      hasHumanVerdict: true,
    }),
  ];
  const decisions = compileAdmissionDecisions(records);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].recommendedStatus, "candidate");
  assert.equal(decisions[0].eligibleDecisionCount, 2);
  assert.equal(decisions[0].humanVerdictCount, 2);
});

// ============================================================================
// 8. 反向验证：删除新逻辑后必须 RED
// ============================================================================

test("反向：仅 judge 证据（无 human）即便 5 条也不得 active", () => {
  const records = [];
  for (let i = 0; i < 5; i += 1) {
    records.push(
      makeRecord({
        evidenceId: `ev-judge-${i}`,
        orchestratorRunId: `run-judge-${i}`,
        strategyId: "strategy-A",
        modelVersion: "glm-5.2",
        source: "judge",
        fromEligiblePair: true,
        hasHumanVerdict: false, // 关键：无 human verdict
      })
    );
  }
  const decisions = compileAdmissionDecisions(records);
  assert.equal(decisions[0].recommendedStatus, "candidate");
  assert.equal(decisions[0].humanVerdictCount, 0);
});

test("反向：eligible 但无 human 的证据不得计入 humanVerdictCount", () => {
  const records = [
    makeRecord({
      evidenceId: "ev-mix-0",
      orchestratorRunId: "run-mix-0",
      strategyId: "strategy-A",
      modelVersion: "glm-5.2",
      fromEligiblePair: true,
      hasHumanVerdict: false,
    }),
    makeRecord({
      evidenceId: "ev-mix-1",
      orchestratorRunId: "run-mix-1",
      strategyId: "strategy-A",
      modelVersion: "glm-5.2",
      fromEligiblePair: false, // 非 eligible
      hasHumanVerdict: true,
    }),
  ];
  const decisions = compileAdmissionDecisions(records);
  // eligible=1, human=1，都不达阈值
  assert.equal(decisions[0].eligibleDecisionCount, 1);
  assert.equal(decisions[0].humanVerdictCount, 1);
  assert.equal(decisions[0].recommendedStatus, "candidate");
});
