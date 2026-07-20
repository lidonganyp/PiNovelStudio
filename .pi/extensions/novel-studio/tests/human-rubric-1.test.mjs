/** HUMAN-RUBRIC-1 acceptance tests. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HUMAN_RUBRIC_DIMENSIONS,
  chooseAuthoritativeHumanReview,
  createHumanRubric,
} from "../dist-test/v2/core/human-rubric.js";

function makeReview(overrides = {}) {
  return {
    reviewId: "review-1",
    workspaceId: "xinmo",
    chapterId: "ch17",
    reviewerType: "human",
    reviewerId: "user",
    anonymousCandidates: {
      A: { textHash: "a".repeat(64), textLength: 120 },
      B: { textHash: "b".repeat(64), textLength: 130 },
    },
    dimensions: HUMAN_RUBRIC_DIMENSIONS.map((dimension) => ({
      dimensionId: dimension.id,
      preference: "tie",
      evidenceSpans: [],
      rationale: "两稿在该维度没有明确差异",
    })),
    overallPreference: "tie",
    confidence: "uncertain",
    rationale: "没有明确胜出者，保留 raw。",
    createdAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

test("HUMAN-RUBRIC-1 定义任务卡要求的 10 个维度", () => {
  assert.equal(HUMAN_RUBRIC_DIMENSIONS.length, 10);
  assert.deepEqual(
    HUMAN_RUBRIC_DIMENSIONS.map((dimension) => dimension.id),
    [
      "native_chinese",
      "character_credibility",
      "goal_obstacle_choice_result",
      "emotional_progression",
      "information_release",
      "scene_immersion",
      "causal_end_pressure",
      "world_continuity",
      "anti_template_ai_trace",
      "worth_replacing_raw",
    ],
  );
});

test("HUMAN-RUBRIC-1 接受匿名 A/B 的 tie 与 uncertain", () => {
  const rubric = createHumanRubric();
  const result = rubric.validate(makeReview());
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("HUMAN-RUBRIC-1 不产生 aggregate score 或自动 winner", () => {
  const rubric = createHumanRubric();
  const artifact = rubric.create(makeReview());
  assert.equal("totalScore" in artifact, false);
  assert.equal("aggregateScore" in artifact, false);
  assert.equal("autoWinner" in artifact, false);
  assert.equal(artifact.overallPreference, "tie");
});

test("HUMAN-RUBRIC-1 明确维度胜负时要求正文 span", () => {
  const review = makeReview();
  review.dimensions[0] = {
    ...review.dimensions[0],
    preference: "A",
    rationale: "A 的中文语感更自然",
  };
  const result = createHumanRubric().validate(review);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("evidenceSpans")));
});

test("HUMAN-RUBRIC-1 校验 span 候选标签与边界", () => {
  const review = makeReview();
  review.dimensions[0] = {
    ...review.dimensions[0],
    preference: "A",
    evidenceSpans: [{ candidate: "A", start: 4, end: 18, excerpt: "自然表达" }],
  };
  assert.equal(createHumanRubric().validate(review).ok, true);

  review.dimensions[0].evidenceSpans[0].end = 999;
  const invalid = createHumanRubric().validate(review);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.includes("越界")));
});

test("HUMAN-RUBRIC-1 用户最终选择优先于代理或模型评价", () => {
  const proxy = createHumanRubric().create(makeReview({
    reviewId: "proxy",
    reviewerType: "validated_human_proxy",
    overallPreference: "A",
    confidence: "clear",
  }));
  const user = createHumanRubric().create(makeReview({
    reviewId: "user",
    reviewerType: "user_final",
    overallPreference: "B",
    confidence: "clear",
  }));
  assert.equal(chooseAuthoritativeHumanReview([proxy, user]).reviewId, "user");
});

