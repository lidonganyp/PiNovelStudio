/** Editorial hypotheses are selected by cited evidence and bounded cost, not confidence ranking. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { selectHypothesesForCandidates } from "../dist/v2/core/editorial-hypothesis.js";
import * as editorialHypothesisModule from "../dist/v2/core/editorial-hypothesis.js";
import { createEditorialOpportunityJudge } from "../dist/v2/core/editorial-opportunity-judge.js";

const RAW_TEXT = "这是一段正文，主角走进房间，看到桌上有一封信。信上没有署名。他犹豫了片刻。";

function makeHypothesis(overrides = {}) {
  const excerpt = overrides._excerpt ?? "主角走进房间";
  const start = RAW_TEXT.indexOf(excerpt);
  const { _excerpt, ...rest } = overrides;
  return {
    id: "h1",
    opportunityType: "reader_payoff",
    diagnosis: "测试诊断",
    evidenceSpans: [{ start, end: start + excerpt.length, excerpt }],
    expectedReaderGain: "测试增益",
    damageRisks: ["测试风险"],
    rewriteScope: "span_candidate",
    confidence: 0.5,
    ...rest,
  };
}

test("maxCandidates remains a bounded model-cost limit", () => {
  const result = selectHypothesesForCandidates([
    makeHypothesis({ id: "h1", confidence: 0.1, _excerpt: "主角走进房间" }),
    makeHypothesis({ id: "h2", opportunityType: "character_choice", confidence: 0.9, _excerpt: "看到桌上有一封信" }),
  ], RAW_TEXT, 1);
  assert.deepEqual(result.selected.map((entry) => entry.id), ["h1"]);
  assert.ok(result.reasons.some((reason) => reason.includes("已达最多 1 候选上限")));
});

test("valid hypotheses preserve judge order instead of confidence sorting", () => {
  const result = selectHypothesesForCandidates([
    makeHypothesis({ id: "first", confidence: 0.1, _excerpt: "主角走进房间" }),
    makeHypothesis({ id: "second", opportunityType: "character_choice", confidence: 0.9, _excerpt: "看到桌上有一封信" }),
  ], RAW_TEXT, 2);
  assert.deepEqual(result.selected.map((entry) => entry.id), ["first", "second"]);
});

test("second candidate is not rejected by a confidence threshold or environment variable", () => {
  process.env.PINOVEL_SECOND_CANDIDATE_CONFIDENCE = "0.99";
  try {
    const result = selectHypothesesForCandidates([
      makeHypothesis({ id: "h1", confidence: 0.2, _excerpt: "主角走进房间" }),
      makeHypothesis({ id: "h2", opportunityType: "character_choice", confidence: 0.01, _excerpt: "看到桌上有一封信" }),
    ], RAW_TEXT, 2);
    assert.deepEqual(result.selected.map((entry) => entry.id), ["h1", "h2"]);
    assert.equal(result.reasons.some((reason) => reason.includes("置信度")), false);
  } finally {
    delete process.env.PINOVEL_SECOND_CANDIDATE_CONFIDENCE;
  }
});

test("invalid evidence span is still rejected", () => {
  const result = selectHypothesesForCandidates([
    makeHypothesis({ id: "bad", evidenceSpans: [{ start: -1, end: 2, excerpt: "不存在" }] }),
  ], RAW_TEXT, 2);
  assert.deepEqual(result.selected, []);
  assert.ok(result.reasons.some((reason) => reason.includes("越界")));
});

test("confidence threshold admission exports are physically absent", () => {
  assert.equal("DEFAULT_CONFIDENCE_THRESHOLD" in editorialHypothesisModule, false);
  assert.equal("shouldGenerateCandidate" in editorialHypothesisModule, false);
});

test("local mechanical signals are diagnostic only and cannot authorize candidates", async () => {
  const rawText = [
    "林川感到水下有东西。",
    "他意识到危险正在逼近，注意到远处有黑影。",
    "他感到无力，仿佛预感到了什么。",
    "过了一会儿，他回到了岸上，这一天就这样平淡地结束了。",
  ].join("\n");
  const result = await createEditorialOpportunityJudge().judge({
    rawText,
    intent: {
      chapterFunction: "推进调查",
      readerExperience: [],
      currentPressure: [],
      meaningfulChoices: [],
      promisesToAdvance: [],
      possibleEndPressure: [],
      relevantCharacters: ["林川"],
      inviolableFacts: [],
      sourceRefs: ["test"],
    },
    longTermState: null,
    constitution: null,
    characterNames: ["林川"],
  });

  assert.equal(result.scannedSignals.some((signal) => signal.triggered), true);
  assert.deepEqual(result.hypotheses, []);
  assert.match(result.noOpReason ?? "", /诊断信号不能独立授权候选/);
});
