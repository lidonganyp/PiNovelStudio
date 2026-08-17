/**
 * USER-FEEDBACK-EVIDENCE-PIPELINE-1 — Bundle 优先归因（Phase 3）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStrategyPolicyStore,
  WEAK_PRIOR_ALPHA,
} from "../dist/v2/learning/strategy-policy-store.js";
import {
  createStrategyOutcomeRecorder,
  WEIGHT_JUDGE_SINGLE,
} from "../dist/v2/learning/strategy-outcome-recorder.js";
import {
  createContextualStrategySelector,
} from "../dist/v2/learning/contextual-strategy-selector.js";
import {
  buildStrategyBundleId,
  allowsSingleStrategyEvidence,
} from "../dist/v2/learning/feedback-evidence-contracts.js";

function makeStrategy(strategyId) {
  return {
    strategyId,
    opportunityType: "reader_payoff",
    focus: `focus-${strategyId}`,
    angle: `angle-${strategyId}`,
    promptGuidance: `guidance-${strategyId}`,
    inviolableGuardNote: `guard-${strategyId}`,
  };
}

test("多策略共同作用默认写 bundle 信誉，不拆单策略", () => {
  const store = createStrategyPolicyStore("ws-bundle");
  const recorder = createStrategyOutcomeRecorder();
  const strategyIds = ["s_voice", "s_structure"];
  const bundleId = buildStrategyBundleId(strategyIds);

  const result = recorder.record(store, {
    context: {
      sourceChapter: "ch3",
      modelVersion: "m1",
      strategyId: "s_voice",
      opportunityType: "reader_payoff",
      strategyIds,
      strategyBundleId: bundleId,
    },
    judge: {
      editorialCandidateId: "ed-1",
      rawCandidateId: "raw-1",
      selectedCandidateId: "ed-1",
      confidence: "clear",
      hadReverseReview: false,
      reverseConsensus: false,
      tie: false,
    },
    selection: {
      deliveredCandidateId: "ed-1",
      deliveredSource: "editorial",
      fellBackToRaw: false,
    },
  });

  assert.equal(result.recorded, true);
  assert.equal(result.reputationKey, bundleId);
  assert.equal(result.strategyBundleId, bundleId);

  // bundle 有信誉，单策略无增量
  const bundleRep = store.getReputation(bundleId, "m1");
  assert.equal(bundleRep.alpha, WEAK_PRIOR_ALPHA + WEIGHT_JUDGE_SINGLE);
  assert.equal(store.getReputation("s_voice", "m1").sampleCount, 0);
  assert.equal(store.getReputation("s_structure", "m1").sampleCount, 0);
});

test("单策略或授权拆分时允许写 strategyId", () => {
  assert.equal(allowsSingleStrategyEvidence({ strategyIds: ["only"] }), true);
  assert.equal(
    allowsSingleStrategyEvidence({
      strategyIds: ["a", "b"],
      ablationExperiment: true,
    }),
    true,
  );
  assert.equal(
    allowsSingleStrategyEvidence({ strategyIds: ["a", "b"] }),
    false,
  );

  const store = createStrategyPolicyStore("ws-bundle");
  const recorder = createStrategyOutcomeRecorder();
  const result = recorder.record(store, {
    context: {
      sourceChapter: "ch3",
      modelVersion: "m1",
      strategyId: "s_only",
      opportunityType: "reader_payoff",
      strategyIds: ["s_only"],
    },
    judge: {
      editorialCandidateId: "ed-1",
      rawCandidateId: "raw-1",
      selectedCandidateId: "ed-1",
      confidence: "clear",
      hadReverseReview: false,
      reverseConsensus: false,
      tie: false,
    },
    selection: {
      deliveredCandidateId: "ed-1",
      deliveredSource: "editorial",
      fellBackToRaw: false,
    },
  });
  assert.equal(result.reputationKey, "s_only");
  assert.equal(store.getReputation("s_only", "m1").sampleCount, 1);
});

test("selector 返回 exposureSnapshot（实际暴露而非仅采样）", () => {
  const store = createStrategyPolicyStore("ws-bundle");
  store.setStatus("s1", "m1", "active", "admitted");
  store.setStatus("s2", "m1", "active", "admitted");
  // 提高 s1 胜率
  store.putReputation({
    strategyId: "s1",
    modelVersion: "m1",
    alpha: 30,
    beta: 1,
    sampleCount: 29,
    consecutiveLosses: 0,
    status: "active",
    evidence: [],
    lastUpdated: new Date().toISOString(),
  });
  store.putReputation({
    strategyId: "s2",
    modelVersion: "m1",
    alpha: 30,
    beta: 1,
    sampleCount: 29,
    consecutiveLosses: 0,
    status: "active",
    evidence: [],
    lastUpdated: new Date().toISOString(),
  });

  const selector = createContextualStrategySelector();
  const result = selector.select({
    candidates: [makeStrategy("s1"), makeStrategy("s2"), makeStrategy("s3")],
    modelVersion: "m1",
    policyStore: store,
    seed: 7,
  });

  assert.ok(result.exposureSnapshot);
  assert.equal(
    result.exposureSnapshot.selectedCount,
    result.selected.length,
  );
  assert.deepEqual(
    result.exposureSnapshot.strategyIds,
    result.selected.map((s) => s.strategyId),
  );
  if (result.selected.length > 0) {
    assert.equal(
      result.exposureSnapshot.strategyBundleId,
      buildStrategyBundleId(result.exposureSnapshot.strategyIds),
    );
  }
});
