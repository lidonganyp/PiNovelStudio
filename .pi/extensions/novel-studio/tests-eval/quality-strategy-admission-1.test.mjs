/** QUALITY-STRATEGY-ADMISSION-1 tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateQualityStrategyAdmission } from "../dist-eval/novelbench/quality-strategy-admission.js";

const base = {
  strategyId: "solution-search",
  modelVersion: "judge-test",
  sceneType: "high_pressure",
  relativeGain: true,
  absoluteQualityPass: true,
  continuousPass: true,
  humanAligned: true,
  userUtilityImproved: true,
  judgeSchemaValid: true,
  provenanceValid: true,
  negativeRuns: 0,
  crossWorkNegativeRuns: 0,
};

test("QUALITY-STRATEGY-ADMISSION-1 三道闸门全部通过才 production_eligible", () => {
  const result = evaluateQualityStrategyAdmission(base);
  assert.equal(result.status, "production_eligible");
  assert.equal(result.canEnterProduction, true);
});

test("QUALITY-STRATEGY-ADMISSION-1 单次缺证据只能 candidate", () => {
  const result = evaluateQualityStrategyAdmission({ ...base, userUtilityImproved: false });
  assert.equal(result.status, "candidate");
  assert.equal(result.canEnterProduction, false);
});

test("QUALITY-STRATEGY-ADMISSION-1 schema/provenance 失败立即 blocked", () => {
  assert.equal(evaluateQualityStrategyAdmission({ ...base, judgeSchemaValid: false }).status, "blocked");
  assert.equal(evaluateQualityStrategyAdmission({ ...base, provenanceValid: false }).status, "blocked");
});

test("QUALITY-STRATEGY-ADMISSION-1 连续负收益 dormant，跨作品负收益 retired", () => {
  assert.equal(evaluateQualityStrategyAdmission({ ...base, negativeRuns: 2 }).status, "dormant");
  assert.equal(evaluateQualityStrategyAdmission({ ...base, crossWorkNegativeRuns: 2 }).status, "retired");
});
