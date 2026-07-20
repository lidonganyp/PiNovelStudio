/** CEILING baseline / continuous evaluation tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateBaselineArm,
  buildCeilingRunPlan,
  compareBaselineMatrix,
  summarizeBestOfK,
  summarizeAbsoluteQuality,
  validateContinuousChapters,
} from "../dist-eval/novelbench/ceiling-baseline-matrix.js";

const ids = ["active_protagonist", "rule_information_gain", "scene_state_delta", "terror_escalation", "dialogue_function", "information_asymmetry", "chapter_end_causal_pressure", "native_chinese"];
const levels = (value) => Object.fromEntries(ids.map((id) => [id, value]));

test("CEILING-BASELINE-MATRIX-1 记录 pass@1、均值、中位数和 best-of-3", () => {
  const result = aggregateBaselineArm("solution_search_raw", [1, 2, 3].map(() => summarizeAbsoluteQuality({ levels: levels(4) })));
  assert.equal(result.sampleCount, 3);
  assert.equal(result.passAt1, 1);
  assert.equal(result.bestOf3Average, 4);
  assert.equal(result.medianAverage, 4);
});

test("CEILING-BASELINE-MATRIX-1 结构分数提高但未达绝对线时只能 no_positive_evidence/relative_gain_only", () => {
  const result = compareBaselineMatrix("case-1", [
    { arm: "raw_control", summaries: [summarizeAbsoluteQuality({ levels: levels(2) })] },
    { arm: "solution_search_raw", summaries: [summarizeAbsoluteQuality({ levels: levels(3) })] },
  ]);
  assert.notEqual(result.status, "absolute_quality_gain");
});

test("CEILING-CONTINUOUS-CHAPTERS-1 少于三章或状态/钩子退化不可通过", () => {
  const result = validateContinuousChapters([
    { chapterId: "ch1", accepted: true, activeProtagonist: 4, stateDelta: 1, hookType: "evidence", continuityHardFailure: false, userReworkCount: 0 },
    { chapterId: "ch2", accepted: true, activeProtagonist: 2, stateDelta: 0, hookType: "evidence", continuityHardFailure: false, userReworkCount: 2 },
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("continuous_run_requires_at_least_3_chapters"));
  assert.ok(result.errors.includes("core_state_quality_regressed"));
  assert.ok(result.errors.includes("hook_type_repeated"));
});

test("CEILING-CONTINUOUS-CHAPTERS-1 三章通过时返回 pass", () => {
  const result = validateContinuousChapters([1, 2, 3].map((n) => ({
    chapterId: `ch${n}`, accepted: true, activeProtagonist: 4, stateDelta: 1, hookType: `hook-${n}`, continuityHardFailure: false, userReworkCount: 0,
  })));
  assert.equal(result.status, "pass");
  assert.equal(result.metrics.acceptedRate, 1);
});

test("CEILING-BEST-OF-3-1 uses independent samples from the same model and strategy", () => {
  const plan = buildCeilingRunPlan({
    models: ["claude", "gemini31"],
    strategies: ["raw", "scene", "oracle_scene"],
    samplesPerStrategy: 3,
  });

  assert.equal(plan.length, 18);
  assert.deepEqual(
    plan.filter((run) => run.model === "claude" && run.strategy === "scene").map((run) => run.sampleIndex),
    [1, 2, 3],
  );
  assert.equal(new Set(plan.map((run) => run.runId)).size, plan.length);
});

test("CEILING-BEST-OF-3-1 reports pass@k from the best sample, not the mean", () => {
  const result = summarizeBestOfK([
    summarizeAbsoluteQuality({ levels: levels(2) }),
    summarizeAbsoluteQuality({ levels: levels(4) }),
    summarizeAbsoluteQuality({ levels: levels(3) }),
  ]);

  assert.equal(result.sampleCount, 3);
  assert.equal(result.passAt1Average, 2);
  assert.equal(result.bestOfKAverage, 4);
  assert.equal(result.qualityLift, 2);
  assert.equal(result.hasAbsolutePass, true);
});
