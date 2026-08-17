/**
 * USER-FEEDBACK-EVIDENCE-PIPELINE-1 — 证据账本与可重建信誉（场景 7/8/9/11/12）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStrategyPolicyStore,
  WEAK_PRIOR_ALPHA,
  WEAK_PRIOR_BETA,
} from "../dist/v2/learning/strategy-policy-store.js";
import {
  buildEffectiveObservations,
  recomputeStrategyReputation,
  reputationsMatch,
} from "../dist/v2/learning/strategy-reputation-recompute.js";
import { createUserFeedbackIngestor } from "../dist/v2/learning/user-feedback-ingestor.js";

function obs(partial) {
  return {
    eventType: "observation",
    evidenceId: partial.evidenceId,
    feedbackLevel: partial.feedbackLevel ?? "explicit_direct",
    outcome: partial.outcome,
    decisionCount: partial.decisionCount ?? 1,
    weightedEvidence: partial.weightedEvidence ?? 1,
    attributionConfidence: partial.attributionConfidence ?? "high",
    lineage: partial.lineage ?? {
      orchestratorRunId: "run-1",
      candidateId: "c1",
      strategyBundleId: partial.strategyBundleId ?? "bundle:s1",
      strategyId: partial.strategyId ?? "s1",
      modelVersion: partial.modelVersion ?? "m1",
      promptBundleId: "p1",
      deliveredSource: "editorial",
      exposureId: "e1",
      feedbackEventId: partial.evidenceId,
      sourceChapter: partial.sourceChapter ?? "ch1",
    },
    strategyBundleId: partial.strategyBundleId ?? "bundle:s1",
    strategyIds: partial.strategyIds ?? ["s1"],
    strategyId: partial.strategyId ?? "s1",
    modelVersion: partial.modelVersion ?? "m1",
    sourceChapter: partial.sourceChapter ?? "ch1",
    source: partial.source ?? "user",
    timestamp: partial.timestamp ?? "2026-08-12T00:00:00.000Z",
    note: partial.note,
    nonLiteraryCategory: partial.nonLiteraryCategory,
  };
}

test("账本重算：win/loss 与增量 recordOutcome 一致", () => {
  const ledger = [
    obs({
      evidenceId: "e1",
      outcome: "win",
      weightedEvidence: 3,
      timestamp: "2026-08-12T01:00:00.000Z",
    }),
    obs({
      evidenceId: "e2",
      outcome: "loss",
      weightedEvidence: 2,
      timestamp: "2026-08-12T02:00:00.000Z",
    }),
  ];

  const recomputed = recomputeStrategyReputation(ledger, "m1", "s1");
  assert.equal(recomputed.alpha, WEAK_PRIOR_ALPHA + 3);
  assert.equal(recomputed.beta, WEAK_PRIOR_BETA + 2);
  assert.equal(recomputed.sampleCount, 2); // decisionCount 累加
  assert.equal(recomputed.consecutiveLosses, 1);

  // 增量路径
  const store = createStrategyPolicyStore("ws-ledger");
  store.recordOutcome("s1", "m1", {
    sourceChapter: "ch1",
    outcome: "win",
    source: "user",
    weight: 3,
    timestamp: "2026-08-12T01:00:00.000Z",
    evidenceId: "e1",
    decisionCount: 1,
  });
  store.recordOutcome("s1", "m1", {
    sourceChapter: "ch1",
    outcome: "loss",
    source: "user",
    weight: 2,
    timestamp: "2026-08-12T02:00:00.000Z",
    evidenceId: "e2",
    decisionCount: 1,
  });
  const rep = store.getReputation("s1", "m1");
  assert.ok(reputationsMatch(rep, recomputed));
});

test("场景11: revoked evidence 不参与重算/晋级视图", () => {
  const ledger = [
    obs({ evidenceId: "e1", outcome: "win", weightedEvidence: 3 }),
    {
      eventType: "revoke",
      eventId: "rev-1",
      targetEvidenceId: "e1",
      reason: "user rollback",
      timestamp: "2026-08-12T03:00:00.000Z",
    },
  ];
  const effective = buildEffectiveObservations(ledger);
  assert.equal(effective.length, 0);
  const recomputed = recomputeStrategyReputation(ledger, "m1", "s1");
  assert.equal(recomputed.alpha, WEAK_PRIOR_ALPHA);
  assert.equal(recomputed.sampleCount, 0);
});

test("场景12: quarantined evidence 不参与重算", () => {
  const ledger = [
    obs({ evidenceId: "e1", outcome: "loss", weightedEvidence: 4 }),
    {
      eventType: "quarantine",
      eventId: "q-1",
      targetEvidenceId: "e1",
      reason: "conflict",
      timestamp: "2026-08-12T03:00:00.000Z",
    },
  ];
  const recomputed = recomputeStrategyReputation(ledger, "m1", "s1");
  assert.equal(recomputed.beta, WEAK_PRIOR_BETA);
  assert.equal(recomputed.sampleCount, 0);
});

test("乱序撤销：先记后撤中间一条，重算一致", () => {
  const store = createStrategyPolicyStore("ws-ledger");
  store.recordOutcome("s1", "m1", {
    sourceChapter: "ch1",
    outcome: "win",
    source: "user",
    weight: 1,
    timestamp: "t1",
    evidenceId: "a",
    decisionCount: 1,
  });
  store.recordOutcome("s1", "m1", {
    sourceChapter: "ch2",
    outcome: "win",
    source: "user",
    weight: 1,
    timestamp: "t2",
    evidenceId: "b",
    decisionCount: 1,
  });
  store.recordOutcome("s1", "m1", {
    sourceChapter: "ch3",
    outcome: "loss",
    source: "user",
    weight: 1,
    timestamp: "t3",
    evidenceId: "c",
    decisionCount: 1,
  });

  // 撤销中间 win(b)
  const result = store.revertOutcomeByEvidenceId("s1", "m1", "b");
  assert.equal(result.reverted, true);
  const rep = result.reputation;
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + 1); // 仅 a
  assert.equal(rep.beta, WEAK_PRIOR_BETA + 1); // c
  assert.equal(rep.sampleCount, 2); // a + c
});

test("场景8/9: 同一 evidenceId 重复摄入不增加 decision", () => {
  const store = createStrategyPolicyStore("ws-ledger");
  const evidence = {
    sourceChapter: "ch1",
    outcome: "win",
    source: "user",
    weight: 3,
    timestamp: "t1",
    evidenceId: "dup-1",
    decisionCount: 1,
  };
  store.recordOutcome("s1", "m1", evidence);
  store.recordOutcome("s1", "m1", evidence);
  store.recordOutcome("s1", "m1", { ...evidence });
  const rep = store.getReputation("s1", "m1");
  assert.equal(rep.sampleCount, 1);
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + 3);
  assert.equal(rep.evidence.filter((e) => !e.revoked).length, 1);
});

test("重度修改 weight 不虚增 sampleCount", () => {
  const store = createStrategyPolicyStore("ws-ledger");
  const ingestor = createUserFeedbackIngestor();
  ingestor.ingestEdit(store, {
    context: {
      sourceChapter: "ch1",
      modelVersion: "m1",
      strategyId: "s1",
      opportunityType: "reader_payoff",
    },
    deliveredSource: "editorial",
    modified: true,
    editDistance: 0.5,
    classification: {
      editScope: "scene",
      editType: "structure",
      attributionConfidence: "high",
      factIssue: false,
      settingCompletion: false,
      retainedCoreEffect: false,
      decisionCount: 1,
      weightedEvidence: 4,
    },
    feedbackEventId: "heavy-1",
  });
  const rep = store.getReputation("s1", "m1");
  assert.equal(rep.sampleCount, 1);
  assert.equal(rep.beta, WEAK_PRIOR_BETA + 4);
});

test("非文学 observation 不进有效视图", () => {
  const ledger = [
    obs({
      evidenceId: "fact-1",
      outcome: "loss",
      weightedEvidence: 3,
      nonLiteraryCategory: "fact",
    }),
    obs({
      evidenceId: "nl-1",
      outcome: "loss",
      feedbackLevel: "natural_language_unattributed",
      weightedEvidence: 3,
    }),
  ];
  assert.equal(buildEffectiveObservations(ledger).length, 0);
});
