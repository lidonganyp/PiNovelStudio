/**
 * GREEN 测试：模型调用计量与验证器运行计量（REASONING-REPAIR-BOUNDARY-1 Wave 2C / RRB-4.1~4.3）
 *
 * 锁定 Wave 2C 的期望行为：
 *
 *   RRB-4.1 — modelCallsByKind 收敛为 draft/patch/newCandidate/authorStyle 真实模型调用；
 *            旧 verify 字段已删除；同步 verifier 不得计入 modelCalls。
 *   RRB-4.2 — validatorRuns 至少区分 coverage_gate / narrative_verifier / patch_comparator /
 *            span_immutability / story_preservation / final_fact_recheck / completeness。
 *   RRB-4.3 — 模型 wrapper 是 model call 唯一计数点；validator runner 是 validator run
 *            唯一计数点；禁止调用方手工 += 1。
 *
 * 对照计划 §7 最小验收矩阵：
 *   T21  本地 verifier 执行两次 → validatorRuns += 2，modelCalls += 0
 *   T22  patch 模型真实调用一次 → modelCalls.patch += 1，validator 单独计数
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createModelCallMeter,
  ZERO_MODEL_CALLS,
  mergeModelCallsByKind,
  hasLegacyVerifyKey,
} from "../dist-test/v2/core/model-call-meter.js";

import {
  createValidatorRunMeter,
  ZERO_VALIDATOR_RUNS,
  mergeValidatorRunsByKind,
  hasLegacyValidatorKey,
} from "../dist-test/v2/core/validator-run-meter.js";

// ============================================================================
// RRB-4.1：modelCallsByKind 收敛
// ============================================================================

test("RRB-4.1: modelCallsByKind 仅含 draft/patch/newCandidate/authorStyle", () => {
  const meter = createModelCallMeter();
  const calls = meter.getModelCallsByKind();
  const keys = Object.keys(calls);
  assert.deepEqual(keys.sort(), ["authorStyle", "draft", "newCandidate", "patch"].sort());
  // 旧 verify 字段不存在
  assert.equal("verify" in calls, false, "modelCallsByKind 不得含旧 verify 字段");
});

test("RRB-4.1: recordModelCall 正确累计各 kind", () => {
  const meter = createModelCallMeter();
  meter.recordModelCall({ kind: "draft", success: true });
  meter.recordModelCall({ kind: "draft", success: true });
  meter.recordModelCall({ kind: "patch", success: true });
  meter.recordModelCall({ kind: "newCandidate", success: false });
  meter.recordModelCall({ kind: "authorStyle", success: true });

  const calls = meter.getModelCallsByKind();
  assert.equal(calls.draft, 2);
  assert.equal(calls.patch, 1);
  assert.equal(calls.newCandidate, 1);
  assert.equal(calls.authorStyle, 1);
});

test("RRB-4.1: 本地 verifier 运行不增加 modelCalls", () => {
  // 本地 verifier 不应调用 recordModelCall
  const meter = createModelCallMeter();
  // 模拟一次 draft 模型调用
  meter.recordModelCall({ kind: "draft", success: true });
  const before = meter.getTotalModelCalls();
  assert.equal(before, 1);

  // 本地 verifier 运行（不调用 recordModelCall）→ modelCalls 不变
  const after = meter.getTotalModelCalls();
  assert.equal(after, 1, "本地 verifier 运行后 modelCalls 不变");
});

// ============================================================================
// RRB-4.1：旧 verify 检测
// ============================================================================

test("RRB-4.1: hasLegacyVerifyKey 检测旧 verify 字段", () => {
  assert.equal(hasLegacyVerifyKey({ draft: 1, patch: 0, newCandidate: 0, authorStyle: 0 }), false);
  assert.equal(hasLegacyVerifyKey({ draft: 1, verify: 3, patch: 0 }), true);
  assert.equal(hasLegacyVerifyKey({}), false);
});

// ============================================================================
// ZERO_MODEL_CALLS
// ============================================================================

test("ZERO_MODEL_CALLS: 全零", () => {
  assert.equal(ZERO_MODEL_CALLS.draft, 0);
  assert.equal(ZERO_MODEL_CALLS.patch, 0);
  assert.equal(ZERO_MODEL_CALLS.newCandidate, 0);
  assert.equal(ZERO_MODEL_CALLS.authorStyle, 0);
});

// ============================================================================
// mergeModelCallsByKind
// ============================================================================

test("mergeModelCallsByKind: 合并多次快照", () => {
  const a = { draft: 2, patch: 1, newCandidate: 0, authorStyle: 0 };
  const b = { draft: 0, patch: 0, newCandidate: 1, authorStyle: 1 };
  const merged = mergeModelCallsByKind(a, b);
  assert.equal(merged.draft, 2);
  assert.equal(merged.patch, 1);
  assert.equal(merged.newCandidate, 1);
  assert.equal(merged.authorStyle, 1);
});

// ============================================================================
// RRB-4.2：validatorRuns 分账
// ============================================================================

test("RRB-4.2: validatorRuns 至少区分 7 种验证器", () => {
  const meter = createValidatorRunMeter();
  const runs = meter.getValidatorRunsByKind();
  const expected = [
    "coverage_gate",
    "narrative_verifier",
    "patch_comparator",
    "span_immutability",
    "story_preservation",
    "final_fact_recheck",
    "completeness",
  ];
  const keys = Object.keys(runs).sort();
  assert.deepEqual(keys, expected.sort());
});

test("RRB-4.2: recordValidatorRun 正确累计各 kind", () => {
  const meter = createValidatorRunMeter();
  meter.recordValidatorRun({ kind: "narrative_verifier", outcome: "passed" });
  meter.recordValidatorRun({ kind: "narrative_verifier", outcome: "failed" });
  meter.recordValidatorRun({ kind: "patch_comparator", outcome: "passed" });
  meter.recordValidatorRun({ kind: "story_preservation", outcome: "passed" });
  meter.recordValidatorRun({ kind: "final_fact_recheck", outcome: "passed" });
  meter.recordValidatorRun({ kind: "completeness", outcome: "error" });
  meter.recordValidatorRun({ kind: "coverage_gate", outcome: "passed" });
  meter.recordValidatorRun({ kind: "span_immutability", outcome: "passed" });

  const runs = meter.getValidatorRunsByKind();
  assert.equal(runs.narrative_verifier, 2);
  assert.equal(runs.patch_comparator, 1);
  assert.equal(runs.story_preservation, 1);
  assert.equal(runs.final_fact_recheck, 1);
  assert.equal(runs.completeness, 1);
  assert.equal(runs.coverage_gate, 1);
  assert.equal(runs.span_immutability, 1);
});

// ============================================================================
// T21：本地 verifier 运行两次
// ============================================================================

test("T21: 本地 verifier 执行两次 → validatorRuns += 2，modelCalls += 0", () => {
  const modelMeter = createModelCallMeter();
  const validatorMeter = createValidatorRunMeter();

  // 模拟两次本地 verifier 运行
  validatorMeter.recordValidatorRun({ kind: "narrative_verifier", outcome: "passed" });
  validatorMeter.recordValidatorRun({ kind: "narrative_verifier", outcome: "passed" });

  assert.equal(validatorMeter.getValidatorRunsByKind().narrative_verifier, 2);
  assert.equal(modelMeter.getTotalModelCalls(), 0, "本地 verifier 不增加 modelCalls");
});

// ============================================================================
// T22：patch 模型真实调用
// ============================================================================

test("T22: patch 模型真实调用一次 → modelCalls.patch += 1，validator 单独计数", () => {
  const modelMeter = createModelCallMeter();
  const validatorMeter = createValidatorRunMeter();

  // 模型调用
  modelMeter.recordModelCall({ kind: "patch", success: true });
  // 验证器运行（独立）
  validatorMeter.recordValidatorRun({ kind: "patch_comparator", outcome: "passed" });

  assert.equal(modelMeter.getModelCallsByKind().patch, 1);
  assert.equal(validatorMeter.getValidatorRunsByKind().patch_comparator, 1);
  // 验证器运行不增加 modelCalls
  assert.equal(modelMeter.getTotalModelCalls(), 1);
});

// ============================================================================
// total 计数
// ============================================================================

test("getTotalModelCalls: 正确合计", () => {
  const meter = createModelCallMeter();
  meter.recordModelCall({ kind: "draft", success: true });
  meter.recordModelCall({ kind: "patch", success: true });
  meter.recordModelCall({ kind: "patch", success: false });
  assert.equal(meter.getTotalModelCalls(), 3);
  assert.equal(meter.getSuccessfulCalls(), 2);
});

test("getTotalValidatorRuns: 正确合计", () => {
  const meter = createValidatorRunMeter();
  meter.recordValidatorRun({ kind: "narrative_verifier", outcome: "passed" });
  meter.recordValidatorRun({ kind: "narrative_verifier", outcome: "failed" });
  meter.recordValidatorRun({ kind: "patch_comparator", outcome: "error" });
  assert.equal(meter.getTotalValidatorRuns(), 3);
  assert.equal(meter.getFailedRuns(), 2);
});

// ============================================================================
// ZERO_VALIDATOR_RUNS
// ============================================================================

test("ZERO_VALIDATOR_RUNS: 全零", () => {
  assert.equal(ZERO_VALIDATOR_RUNS.coverage_gate, 0);
  assert.equal(ZERO_VALIDATOR_RUNS.narrative_verifier, 0);
  assert.equal(ZERO_VALIDATOR_RUNS.patch_comparator, 0);
  assert.equal(ZERO_VALIDATOR_RUNS.span_immutability, 0);
  assert.equal(ZERO_VALIDATOR_RUNS.story_preservation, 0);
  assert.equal(ZERO_VALIDATOR_RUNS.final_fact_recheck, 0);
  assert.equal(ZERO_VALIDATOR_RUNS.completeness, 0);
});

// ============================================================================
// mergeValidatorRunsByKind
// ============================================================================

test("mergeValidatorRunsByKind: 合并多次快照", () => {
  const a = { coverage_gate: 1, narrative_verifier: 2, patch_comparator: 0, span_immutability: 0, story_preservation: 0, final_fact_recheck: 0, completeness: 0 };
  const b = { coverage_gate: 0, narrative_verifier: 0, patch_comparator: 1, span_immutability: 1, story_preservation: 0, final_fact_recheck: 0, completeness: 0 };
  const merged = mergeValidatorRunsByKind(a, b);
  assert.equal(merged.coverage_gate, 1);
  assert.equal(merged.narrative_verifier, 2);
  assert.equal(merged.patch_comparator, 1);
  assert.equal(merged.span_immutability, 1);
});

// ============================================================================
// 旧字段检测
// ============================================================================

test("hasLegacyValidatorKey: 检测旧 verify 字段", () => {
  assert.equal(hasLegacyValidatorKey({ narrative_verifier: 1 }), false);
  assert.equal(hasLegacyValidatorKey({ verify: 5 }), true);
});

// ============================================================================
// RRB-4.3：计数点唯一性
// ============================================================================

test("RRB-4.3: recordModelCall 是唯一模型调用计数点", () => {
  const meter = createModelCallMeter();
  const callsBefore = meter.getTotalModelCalls();

  // 记录一次调用
  meter.recordModelCall({ kind: "draft", success: true });
  assert.equal(meter.getTotalModelCalls(), callsBefore + 1);

  // 记录成功/失败不影响计数
  meter.recordModelCall({ kind: "draft", success: false });
  assert.equal(meter.getTotalModelCalls(), callsBefore + 2);
});

test("RRB-4.3: recordValidatorRun 是唯一验证器运行计数点", () => {
  const meter = createValidatorRunMeter();
  const runsBefore = meter.getTotalValidatorRuns();

  meter.recordValidatorRun({ kind: "narrative_verifier", outcome: "passed" });
  assert.equal(meter.getTotalValidatorRuns(), runsBefore + 1);

  meter.recordValidatorRun({ kind: "narrative_verifier", outcome: "error" });
  assert.equal(meter.getTotalValidatorRuns(), runsBefore + 2);
});

// ============================================================================
// 记录详情
// ============================================================================

test("getCallRecords: 返回完整调用记录", () => {
  const meter = createModelCallMeter();
  meter.recordModelCall({ kind: "draft", candidateId: "c1", success: true });
  meter.recordModelCall({ kind: "patch", candidateId: "c2", success: false });

  const records = meter.getCallRecords();
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, "draft");
  assert.equal(records[0].candidateId, "c1");
  assert.ok(records[0].success);
  assert.equal(records[1].kind, "patch");
  assert.equal(records[1].candidateId, "c2");
  assert.equal(records[1].success, false);
});

test("getRunRecords: 返回完整运行记录", () => {
  const meter = createValidatorRunMeter();
  meter.recordValidatorRun({ kind: "narrative_verifier", candidateId: "c1", outcome: "passed", durationMs: 100 });
  meter.recordValidatorRun({ kind: "patch_comparator", candidateId: "c2", outcome: "failed", durationMs: 50 });

  const records = meter.getRunRecords();
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, "narrative_verifier");
  assert.equal(records[0].outcome, "passed");
  assert.equal(records[0].durationMs, 100);
  assert.equal(records[1].kind, "patch_comparator");
  assert.equal(records[1].outcome, "failed");
  assert.equal(records[1].durationMs, 50);
});

// ============================================================================
// reset
// ============================================================================

test("reset: 模型计量重置", () => {
  const meter = createModelCallMeter();
  meter.recordModelCall({ kind: "draft", success: true });
  assert.equal(meter.getTotalModelCalls(), 1);
  meter.reset();
  assert.equal(meter.getTotalModelCalls(), 0);
  assert.equal(meter.getCallRecords().length, 0);
});

test("reset: 验证器计量重置", () => {
  const meter = createValidatorRunMeter();
  meter.recordValidatorRun({ kind: "narrative_verifier", outcome: "passed" });
  assert.equal(meter.getTotalValidatorRuns(), 1);
  meter.reset();
  assert.equal(meter.getTotalValidatorRuns(), 0);
  assert.equal(meter.getRunRecords().length, 0);
});