/** CEILING-JUDGE-SCHEMA-1: one original candidate versus evaluator-only reference. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CEILING_DIMENSION_IDS,
  CEILING_JUDGE_SCHEMA_VERSION,
  aggregateCeilingDimensionVerdicts,
  buildCeilingDimensionJudgeSchema,
  buildCeilingJudgeSchema,
  buildCeilingJudgeRepairSchema,
  parseAndValidateCeilingDimension,
  parseAndValidateCeilingVerdict,
  runCeilingJudgeWithRepair,
} from "../dist-eval/novelos/eval/ceiling-judge-schema.js";

test("single-dimension schema and parser retain strict source spans", () => {
  const id = "active_protagonist";
  const schema = buildCeilingDimensionJudgeSchema(id, {
    candidateSpans: [candidate.slice(0, 10)],
    referenceSpans: [reference.slice(0, 10)],
  });
  assert.deepEqual(schema.properties.id.enum, [id]);
  const payload = {
    id,
    candidate_level: 4,
    reference_level: 5,
    gap_type: "candidate_below_reference",
    evidence_candidate: [{ excerpt: candidate.slice(0, 10) }],
    evidence_reference: [{ excerpt: reference.slice(0, 10) }],
    reason: "候选有主动试探，但代价弱于参考。",
  };
  const parsed = parseAndValidateCeilingDimension(JSON.stringify(payload), id, texts);
  assert.equal(parsed.valid, true, parsed.errors.join(";"));
  assert.deepEqual(parsed.dimension, payload);
  payload.evidence_reference[0].excerpt = "不存在的参考片段";
  assert.equal(parseAndValidateCeilingDimension(JSON.stringify(payload), id, texts).valid, false);
});

test("eight independent dimension verdicts aggregate without changing their scores", () => {
  const dimensions = CEILING_DIMENSION_IDS.map((id, index) => ({
    id,
    candidate_level: index < 4 ? 3 : 4,
    reference_level: 4,
    gap_type: index < 4 ? "candidate_below_reference" : "aligned",
    evidence_candidate: [{ excerpt: candidate.slice(0, 10) }],
    evidence_reference: [{ excerpt: reference.slice(0, 10) }],
    reason: `维度${index}判断`,
  }));
  const verdict = aggregateCeilingDimensionVerdicts(dimensions);
  assert.deepEqual(verdict.dimensions, dimensions);
  assert.equal(verdict.overall_candidate_level, 4);
  assert.equal(verdict.overall_reference_level, 4);
  assert.equal(verdict.tier_relationship, "same_tier");
  assert.equal(verdict.largest_bottlenecks.length, 3);
  assert.equal(verdict.needs_human_review, false);
});

test("repair schema restricts every evidence excerpt to program-verified spans", () => {
  const schema = buildCeilingJudgeRepairSchema({
    candidateSpans: ["候选原文片段一", "候选原文片段二"],
    referenceSpans: ["参考原文片段一", "参考原文片段二"],
  });
  const dimension = schema.properties.dimensions.items;
  assert.equal(dimension.properties.evidence_candidate.maxItems, 1);
  assert.equal(dimension.properties.evidence_reference.maxItems, 1);
  assert.equal(dimension.properties.reason.maxLength, 240);
  assert.deepEqual(dimension.properties.evidence_candidate.items.properties.excerpt.enum, [
    "候选原文片段一", "候选原文片段二",
  ]);
  assert.deepEqual(dimension.properties.evidence_reference.items.properties.excerpt.enum, [
    "参考原文片段一", "参考原文片段二",
  ]);
  assert.equal(schema.properties.largest_bottlenecks.maxItems, 3);
});

const candidate = "候选章中，主角折回门缝里的纸条，先用钥匙试探锁芯。";
const reference = "参考章中，主角盯着锁芯，发现纸条刻痕与钥匙缺口完全一致。";

function validVerdict(overrides = {}) {
  return {
    dimensions: CEILING_DIMENSION_IDS.map((id) => ({
      id,
      candidate_level: 4,
      reference_level: 4,
      gap_type: "aligned",
      evidence_candidate: [{ excerpt: candidate.slice(0, 10) }],
      evidence_reference: [{ excerpt: reference.slice(0, 10) }],
      reason: "Both chapters bind an active test to verifiable information.",
    })),
    overall_candidate_level: 4,
    overall_reference_level: 4,
    tier_relationship: "same_tier",
    largest_bottlenecks: ["The ending pressure could be more specific."],
    needs_human_review: false,
    ...overrides,
  };
}

const texts = { candidate, reference };

test("CEILING-JUDGE-SCHEMA-1 accepts 50 strict one-candidate same-tier fixtures", () => {
  const schema = buildCeilingJudgeSchema();
  assert.equal(schema.type, "object");
  assert.equal(schema.properties.best_candidate, undefined);
  assert.deepEqual(schema.properties.tier_relationship.enum, [
    "candidate_below_reference",
    "same_tier",
    "candidate_above_reference",
    "uncertain",
  ]);

  for (let i = 0; i < 50; i += 1) {
    const result = parseAndValidateCeilingVerdict(JSON.stringify(validVerdict()), texts);
    assert.equal(result.valid, true, result.errors.join("; "));
  }
});

test("CEILING-JUDGE-SCHEMA-1 rejects Chinese keys, garbled keys, missing and duplicate dimensions", () => {
  const cases = [
    { ...validVerdict(), 维度: [] },
    { ...validVerdict(), dimensions: [{ ...validVerdict().dimensions[0], id: "invalid" }] },
    { ...validVerdict(), dimensions: validVerdict().dimensions.slice(0, 7) },
    { ...validVerdict(), dimensions: [...validVerdict().dimensions.slice(0, 7), validVerdict().dimensions[0]] },
  ];
  for (const value of cases) {
    const result = parseAndValidateCeilingVerdict(JSON.stringify(value), texts);
    assert.equal(result.valid, false);
  }
});

test("CEILING-JUDGE-SCHEMA-1 rejects invalid spans, legacy winner fields and unknown fields", () => {
  const invalidSpan = validVerdict();
  invalidSpan.dimensions[0].evidence_candidate[0].excerpt = "not present in candidate";
  const legacyWinner = { ...validVerdict(), best_candidate: "candidate-1" };
  const unknownField = { ...validVerdict(), unexpected: true };
  for (const value of [invalidSpan, legacyWinner, unknownField]) {
    const result = parseAndValidateCeilingVerdict(JSON.stringify(value), texts);
    assert.equal(result.valid, false);
  }
});

test("CEILING-JUDGE-SCHEMA-1 restores uniquely located spans after punctuation and whitespace normalization", () => {
  const punctuatedCandidate = '他说:"先开门。"\n\n她点头,把钥匙递给他。';
  const punctuatedReference = "参考章写道：门后没有脚步声。";
  const verdict = validVerdict({
    dimensions: CEILING_DIMENSION_IDS.map((id) => ({
      id,
      candidate_level: 4,
      reference_level: 4,
      gap_type: "aligned",
      evidence_candidate: [{ excerpt: "他说：‘先开门。’ 她点头，把钥匙递给他。" }],
      evidence_reference: [{ excerpt: "参考章写道:门后没有脚步声" }],
      reason: "标点和空白差异不改变证据内容。",
    })),
  });

  const result = parseAndValidateCeilingVerdict(JSON.stringify(verdict), {
    candidate: punctuatedCandidate,
    reference: punctuatedReference,
  });

  assert.equal(result.valid, true, result.errors.join("; "));
  assert.equal(result.verdict?.dimensions[0].evidence_candidate[0].excerpt, punctuatedCandidate);
  assert.equal(result.verdict?.dimensions[0].evidence_reference[0].excerpt, punctuatedReference);
});

test("CEILING-JUDGE-SCHEMA-1 rejects normalized spans that are ambiguous or change words", () => {
  const repeatedCandidate = '他说:"开门。"\n他说:"开门。"';
  const ambiguous = validVerdict();
  ambiguous.dimensions[0].evidence_candidate[0].excerpt = "他说：开门";
  const ambiguousResult = parseAndValidateCeilingVerdict(JSON.stringify(ambiguous), {
    candidate: repeatedCandidate,
    reference,
  });
  assert.equal(ambiguousResult.valid, false);
  assert.ok(ambiguousResult.errors.includes("dimension_0_candidate_0_span_not_in_source"));

  const changedWords = validVerdict();
  changedWords.dimensions[0].evidence_candidate[0].excerpt = "候选章中，主角丢掉门缝里的纸条";
  const changedResult = parseAndValidateCeilingVerdict(JSON.stringify(changedWords), texts);
  assert.equal(changedResult.valid, false);
  assert.ok(changedResult.errors.includes("dimension_0_candidate_0_span_not_in_source"));
});

test("CEILING-JUDGE-SCHEMA-1 rejects tier relationships inconsistent with overall levels", () => {
  const result = parseAndValidateCeilingVerdict(JSON.stringify(validVerdict({
    overall_candidate_level: 3,
    overall_reference_level: 4,
    tier_relationship: "same_tier",
  })), texts);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("tier_relationship_mismatch"));
});

test("CEILING-JUDGE-SCHEMA-1 requires uncertain dimension evidence to remain uncertain and human-reviewed", () => {
  const dimensions = validVerdict().dimensions;
  dimensions[0] = { ...dimensions[0], gap_type: "unknown" };

  const falselyCertain = parseAndValidateCeilingVerdict(JSON.stringify(validVerdict({ dimensions })), texts);
  assert.equal(falselyCertain.valid, false);
  assert.ok(falselyCertain.errors.includes("uncertain_dimension_requires_uncertain_tier"));

  const noReview = parseAndValidateCeilingVerdict(JSON.stringify(validVerdict({
    dimensions,
    tier_relationship: "uncertain",
    needs_human_review: false,
  })), texts);
  assert.equal(noReview.valid, false);
  assert.ok(noReview.errors.includes("uncertain_tier_requires_human_review"));

  const conservative = parseAndValidateCeilingVerdict(JSON.stringify(validVerdict({
    dimensions,
    tier_relationship: "uncertain",
    needs_human_review: true,
  })), texts);
  assert.equal(conservative.valid, true, conservative.errors.join("; "));
});

test("CEILING-JUDGE-SCHEMA-1 permits only one bounded repair and keeps invalid failures invalid", async () => {
  let calls = 0;
  const result = await runCeilingJudgeWithRepair({
    ...texts,
    request: async () => {
      calls += 1;
      return JSON.stringify({ invalid_key: true });
    },
    repair: async () => JSON.stringify({ invalid_key: true }),
    provenance: { requestId: "req-1", model: "judge-test", route: "test-route" },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "invalid");
  assert.equal(result.retryCount, 1);
  assert.equal(result.provenance.schemaVersion, CEILING_JUDGE_SCHEMA_VERSION);
});

test("CEILING-JUDGE-SCHEMA-1 retains auditable provenance without production selection output", async () => {
  const result = await runCeilingJudgeWithRepair({
    ...texts,
    request: async () => JSON.stringify(validVerdict()),
    provenance: { requestId: "req-2", model: "judge-test", route: "test-route" },
  });
  assert.equal(result.status, "valid");
  assert.equal(result.verdict?.tier_relationship, "same_tier");
  assert.equal("best_candidate" in result.verdict, false);
  assert.match(result.provenance.responseHash, /^[a-f0-9]{64}$/);
  assert.equal(result.retryCount, 0);
});
