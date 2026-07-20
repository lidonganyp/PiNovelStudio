/**
 * STRATEGY-EVIDENCE-1：StrategyEvidenceDataset 可撤销 evidence 最小闭环测试
 *
 * 验收口径（STRATEGY-EVIDENCE-1 任务书）：
 * 1. 模型版本隔离（不同 modelVersion 分区，旧模型胜率不迁移为新模型先验）。
 * 2. 重复 run 去重（同 orchestratorRunId+strategyId 只算一次）。
 * 3. 撤销恢复计数（revoked evidence 不计入 effective；revocationCount 追踪）。
 * 4. 无 human/eligible 证据不晋级（canPromote=false）。
 * 5. RQ3 负面/污染样本不得提升策略（polluted=true 不计入 effective）。
 * 6. 证据冲突进入 review/quarantine，不自动选边。
 *
 * 边界（L0 工程闭环）：
 * - 默认只记录，不改变生产选择概率（无 alpha/beta 修改）
 * - 不自动修改 prompt/constitution/hard facts
 * - 不调用网络模型
 * - 不修改 finalText / 不提交状态
 * - 不是 gate；不阻断正文生成
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compileStrategyEvidenceDataset,
  detectEvidenceConflicts,
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

// ============================================================================
// 1. 模型版本隔离
// ============================================================================

test("模型版本隔离：不同 modelVersion 分区计数", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({ evidenceId: "ev-a", modelVersion: "glm-5.2", orchestratorRunId: "run-a" }),
    makeRecord({ evidenceId: "ev-b", modelVersion: "glm-5.2", orchestratorRunId: "run-b" }),
    makeRecord({ evidenceId: "ev-c", modelVersion: "doubao-2.1", orchestratorRunId: "run-c" }),
  ]);
  assert.equal(result.partitions["glm-5.2"], 2);
  assert.equal(result.partitions["doubao-2.1"], 1);
});

test("旧模型胜率不迁移为新模型先验（新模型分区独立计算 canPromote）", () => {
  // glm-5.2 有大量 human+eligible 证据，doubao-2.1 无任何证据
  const records = [
    makeRecord({ evidenceId: "ev-a", modelVersion: "glm-5.2", orchestratorRunId: "run-a", hasHumanVerdict: true, fromEligiblePair: true }),
    makeRecord({ evidenceId: "ev-b", modelVersion: "glm-5.2", orchestratorRunId: "run-b", hasHumanVerdict: true, fromEligiblePair: true }),
  ];
  const result = compileStrategyEvidenceDataset(records);
  // glm-5.2 可晋级
  assert.equal(result.canPromote, true);
  // 但 doubao-2.1 分区无证据，不应因 glm-5.2 胜率而可晋级
  // （调用方应按 modelVersion 分别调用 compile 或检查 partitions）
  const doubaoRecords = records.filter(r => r.modelVersion === "doubao-2.1");
  const doubaoResult = compileStrategyEvidenceDataset(doubaoRecords);
  assert.equal(doubaoResult.canPromote, false);
  assert.equal(doubaoResult.effectiveCount, 0);
});

// ============================================================================
// 2. 重复 run 去重
// ============================================================================

test("重复 run 去重：同 orchestratorRunId+strategyId 只算一次", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-dup" }),
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-dup" }), // 重复
    makeRecord({ evidenceId: "ev-3", orchestratorRunId: "run-uniq" }),
  ]);
  assert.equal(result.effectiveCount, 2); // 只算 run-dup（首个）+ run-uniq
});

test("同 orchestratorRunId 不同 strategyId 不去重（不同策略尝试）", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-x", strategyId: "strategy-A" }),
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-x", strategyId: "strategy-B" }),
  ]);
  assert.equal(result.effectiveCount, 2);
});

// ============================================================================
// 3. 撤销恢复计数
// ============================================================================

test("revoked evidence 不计入 effectiveCount", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", revoked: false }),
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-b", revoked: true, revokedReason: "数据污染" }),
  ]);
  assert.equal(result.effectiveCount, 1);
  assert.equal(result.revocationCount, 1);
});

test("revokeEvidence 函数：把指定 evidenceId 标记为 revoked", () => {
  const records = [
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a" }),
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-b" }),
  ];
  const revoked = revokeEvidence(records, "ev-1", "RQ3 负面样本");
  assert.equal(revoked[0].revoked, true);
  assert.equal(revoked[0].revokedReason, "RQ3 负面样本");
  assert.equal(revoked[0].revokedAt !== undefined, true);
  assert.equal(revoked[1].revoked, false); // 其他不受影响
});

test("revokeEvidence: 已 revoked 的 evidence 再次 revoke 不重复计数", () => {
  const records = [
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", revoked: true, revokedReason: "first" }),
  ];
  const revoked = revokeEvidence(records, "ev-1", "second");
  // 仍然 revoked，但原因可更新或保留首个（不重复计数）
  assert.equal(revoked[0].revoked, true);
  const result = compileStrategyEvidenceDataset(revoked);
  assert.equal(result.revocationCount, 1); // 不重复计数
});

// ============================================================================
// 4. 无 human/eligible 证据不晋级
// ============================================================================

test("无 human verdict 也不 eligible → canPromote=false", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", hasHumanVerdict: false, fromEligiblePair: false }),
  ]);
  assert.equal(result.canPromote, false);
});

test("仅 judge 证据（无 human）→ canPromote=false", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", source: "judge", hasHumanVerdict: false, fromEligiblePair: true }),
  ]);
  assert.equal(result.canPromote, false);
});

test("仅 eligible 但无 human → canPromote=false", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", hasHumanVerdict: false, fromEligiblePair: true }),
  ]);
  assert.equal(result.canPromote, false);
});

test("有 human + eligible → canPromote=true", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", hasHumanVerdict: true, fromEligiblePair: true }),
  ]);
  assert.equal(result.canPromote, true);
});

test("human + eligible 但 revoked → canPromote=false（撤销后不计入）", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", hasHumanVerdict: true, fromEligiblePair: true, revoked: true }),
  ]);
  assert.equal(result.canPromote, false);
  assert.equal(result.effectiveCount, 0);
});

// ============================================================================
// 5. RQ3 负面/污染样本不得提升策略
// ============================================================================

test("polluted=true 的 evidence 不计入 effective（不得提升策略）", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", polluted: true, pollutedReason: "RQ3 实体幻觉污染", hasHumanVerdict: true, fromEligiblePair: true }),
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-b", polluted: false, hasHumanVerdict: true, fromEligiblePair: true }),
  ]);
  assert.equal(result.effectiveCount, 1); // 只算非 polluted
  assert.equal(result.canPromote, true); // 因 ev-2 仍可晋级
});

test("全部 polluted → canPromote=false（负面样本不提升）", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", polluted: true, hasHumanVerdict: true, fromEligiblePair: true }),
  ]);
  assert.equal(result.effectiveCount, 0);
  assert.equal(result.canPromote, false);
});

// ============================================================================
// 6. 证据冲突 quarantine
// ============================================================================

test("detectEvidenceConflicts: 同 strategy 同源 win+loss → quarantined", () => {
  const records = [
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", strategyId: "strat-X", outcome: "win", source: "judge" }),
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-b", strategyId: "strat-X", outcome: "loss", source: "judge" }),
  ];
  const conflicted = detectEvidenceConflicts(records);
  // 冲突的 evidence 被标记 quarantined
  assert.ok(conflicted.some(r => r.quarantined === true));
  assert.ok(conflicted.some(r => r.quarantineReason && /conflict|冲突/i.test(r.quarantineReason)));
});

test("detectEvidenceConflicts: 同 strategy 不同源（judge vs user）不冲突", () => {
  const records = [
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", strategyId: "strat-X", outcome: "win", source: "judge" }),
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-b", strategyId: "strat-X", outcome: "loss", source: "user" }),
  ];
  const conflicted = detectEvidenceConflicts(records);
  // 不同源不自动冲突（user 可推翻 judge，是正常机制）
  assert.ok(conflicted.every(r => r.quarantined === false || r.quarantined === undefined));
});

test("quarantined evidence 不计入 effectiveCount", () => {
  const records = [
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", strategyId: "strat-X", outcome: "win", source: "judge", quarantined: true, quarantineReason: "conflict" }),
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-b", strategyId: "strat-Y", outcome: "win", source: "judge" }),
  ];
  const result = compileStrategyEvidenceDataset(records);
  assert.equal(result.effectiveCount, 1); // 只算非 quarantined
  assert.equal(result.quarantineCount, 1);
});

test("冲突进入 quarantine 不自动选边（quarantineReason 不指定胜方）", () => {
  const records = [
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", strategyId: "strat-X", outcome: "win", source: "judge" }),
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-b", strategyId: "strat-X", outcome: "loss", source: "judge" }),
  ];
  const conflicted = detectEvidenceConflicts(records);
  const quarantined = conflicted.find(r => r.quarantined === true);
  assert.ok(quarantined);
  // quarantineReason 不应指定哪方胜出
  assert.ok(!/win.*胜|loss.*胜|选.*win|选.*loss/i.test(quarantined.quarantineReason || ""));
});

// ============================================================================
// 7. 不变量
// ============================================================================

test("dataset 不含 alpha/beta 修改字段（不改变生产选择概率）", () => {
  const result = compileStrategyEvidenceDataset([makeRecord()]);
  const json = JSON.stringify(result);
  assert.ok(!/alpha|beta|prior/.test(json));
});

test("dataset 不含 promptModify/constitutionModify/hardFactModify 字段", () => {
  const result = compileStrategyEvidenceDataset([makeRecord()]);
  const json = JSON.stringify(result);
  assert.ok(!/promptModify|constitutionModify|hardFactModify/i.test(json));
});

test("dataset 不含 modelGenerate/callModel 字段（不调用模型）", () => {
  const result = compileStrategyEvidenceDataset([makeRecord()]);
  const json = JSON.stringify(result);
  assert.ok(!/modelGenerate|callModel|invokeModel/i.test(json));
});

test("汇总字段完整：effectiveCount/humanVerdictCount/eligiblePairCount/canPromote/revocationCount/quarantineCount/partitions", () => {
  const result = compileStrategyEvidenceDataset([
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-a", hasHumanVerdict: true, fromEligiblePair: true }),
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-b", revoked: true }),
    makeRecord({ evidenceId: "ev-3", orchestratorRunId: "run-c", quarantined: true }),
    makeRecord({ evidenceId: "ev-4", orchestratorRunId: "run-d", polluted: true }),
  ]);
  assert.equal(result.effectiveCount, 1);
  assert.equal(result.humanVerdictCount, 1);
  assert.equal(result.eligiblePairCount, 1);
  assert.equal(result.canPromote, true);
  assert.equal(result.revocationCount, 1);
  assert.equal(result.quarantineCount, 1);
  assert.ok(result.partitions && typeof result.partitions === "object");
});
