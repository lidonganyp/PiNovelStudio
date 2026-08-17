/**
 * USER-FEEDBACK-EVIDENCE-PIPELINE-1 — 晋级治理与在线边界（场景 10/11/12/15）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStrategyPolicyStore,
  WEAK_PRIOR_ALPHA,
  WEAK_PRIOR_BETA,
} from "../dist/v2/learning/strategy-policy-store.js";
import {
  buildPromotionRecommendation,
  applyPromotionWithApproval,
  singleFeedbackCanSwitchProductionBaseline,
} from "../dist/v2/learning/strategy-promotion-governance.js";
import {
  createUserFeedbackIngestor,
} from "../dist/v2/learning/user-feedback-ingestor.js";
import {
  createModelVersionMigration,
} from "../dist/v2/learning/model-version-migration.js";

function makeRecord(partial) {
  return {
    evidenceId: partial.evidenceId,
    strategyId: partial.strategyId ?? "s1",
    modelVersion: partial.modelVersion ?? "m-new",
    orchestratorRunId: partial.orchestratorRunId ?? partial.evidenceId,
    sourceChapter: "ch1",
    outcome: partial.outcome ?? "win",
    source: "user",
    weight: 1,
    timestamp: "2026-08-12T00:00:00.000Z",
    hasHumanVerdict: partial.hasHumanVerdict ?? true,
    fromEligiblePair: partial.fromEligiblePair ?? true,
    revoked: partial.revoked,
    quarantined: partial.quarantined,
    polluted: partial.polluted,
  };
}

// 10. 新模型不能继承旧模型信誉
test("场景10: 新模型从弱先验起步，不继承旧模型 alpha/beta", () => {
  const store = createStrategyPolicyStore("ws-promo");
  store.recordOutcome("s1", "m-old", {
    sourceChapter: "ch1",
    outcome: "win",
    source: "user",
    weight: 10,
    timestamp: new Date().toISOString(),
    evidenceId: "old-1",
    decisionCount: 1,
  });
  assert.equal(
    store.getReputation("s1", "m-old").alpha,
    WEAK_PRIOR_ALPHA + 10,
  );

  const migration = createModelVersionMigration();
  migration.initializeVersion(store, "m-new", ["s1"]);
  const neu = store.getReputation("s1", "m-new");
  assert.equal(neu.alpha, WEAK_PRIOR_ALPHA);
  assert.equal(neu.beta, WEAK_PRIOR_BETA);
  assert.equal(neu.sampleCount, 0);
});

// 11/12 revoked/quarantined 不得晋级
test("场景11/12: revoked/quarantined evidence 晋级率 0", () => {
  const revokedOnly = [
    makeRecord({ evidenceId: "r1", revoked: true }),
    makeRecord({ evidenceId: "r2", revoked: true }),
    makeRecord({ evidenceId: "r3", revoked: true }),
    makeRecord({ evidenceId: "r4", revoked: true }),
    makeRecord({ evidenceId: "r5", revoked: true }),
  ];
  const rec1 = buildPromotionRecommendation(revokedOnly, "s1", "m-new");
  assert.equal(rec1.canPromote, false);
  assert.ok(rec1.blockers.length > 0);

  const quarantined = Array.from({ length: 5 }, (_, i) =>
    makeRecord({
      evidenceId: `q${i}`,
      quarantined: true,
      hasHumanVerdict: true,
      fromEligiblePair: true,
    }),
  );
  const rec2 = buildPromotionRecommendation(quarantined, "s1", "m-new");
  assert.equal(rec2.canPromote, false);
});

test("晋级需要 eval+replay+human 审批，缺一不可", () => {
  const store = createStrategyPolicyStore("ws-promo");
  const records = Array.from({ length: 5 }, (_, i) =>
    makeRecord({
      evidenceId: `e${i}`,
      orchestratorRunId: `run-${i}`,
      hasHumanVerdict: true,
      fromEligiblePair: true,
    }),
  );
  // human verdicts need >=3; all 5 have human
  const recommendation = buildPromotionRecommendation(records, "s1", "m-new");
  assert.equal(recommendation.canPromote, true);

  const denied = applyPromotionWithApproval(store, recommendation, {
    approvalId: "appr-1",
    strategyId: "s1",
    modelVersion: "m-new",
    approvedBy: "reviewer",
    approvedAt: new Date().toISOString(),
    checklist: {
      evalPassed: true,
      replayPassed: false,
      humanReviewPassed: true,
    },
  });
  assert.equal(denied.applied, false);
  assert.equal(store.getReputation("s1", "m-new").status, "candidate");

  const applied = applyPromotionWithApproval(store, recommendation, {
    approvalId: "appr-2",
    strategyId: "s1",
    modelVersion: "m-new",
    approvedBy: "reviewer",
    approvedAt: new Date().toISOString(),
    checklist: {
      evalPassed: true,
      replayPassed: true,
      humanReviewPassed: true,
    },
  });
  assert.equal(applied.applied, true);
  assert.equal(store.getReputation("s1", "m-new").status, "active");
});

// 15. 单次反馈不能自动切换生产策略
test("场景15: 单次反馈不能自动切换生产策略/基线", () => {
  assert.equal(singleFeedbackCanSwitchProductionBaseline(), false);

  const store = createStrategyPolicyStore("ws-promo");
  const ingestor = createUserFeedbackIngestor();
  // candidate 策略即使多次 loss 也不得 auto active/retired 切换生产
  for (let i = 0; i < 8; i++) {
    ingestor.ingestChoice(store, {
      context: {
        sourceChapter: `ch${i}`,
        modelVersion: "m-new",
        strategyId: "s1",
        opportunityType: "reader_payoff",
      },
      chosen: "raw",
      feedbackEventId: `fb-${i}`,
    });
  }
  const rep = store.getReputation("s1", "m-new");
  assert.equal(rep.status, "candidate");
  assert.notEqual(rep.status, "retired");
});

test("文学负反馈不得自动 retired；仅人工 setStatus", () => {
  const store = createStrategyPolicyStore("ws-promo");
  store.setStatus("s1", "m1", "active", "admitted");
  for (let i = 0; i < 10; i++) {
    store.recordOutcome("s1", "m1", {
      sourceChapter: `ch${i}`,
      outcome: "loss",
      source: "user",
      weight: 3,
      timestamp: new Date().toISOString(),
      evidenceId: `loss-${i}`,
      decisionCount: 1,
    });
    if (store.getReputation("s1", "m1").status === "dormant") {
      // 保持 active 继续压测 auto-retired 是否被禁用
      store.setStatus("s1", "m1", "active", "reset for test");
    }
  }
  assert.notEqual(store.getReputation("s1", "m1").status, "retired");

  // 人工退役仍可用
  store.setStatus("s1", "m1", "retired", "人工审批退役");
  assert.equal(store.getReputation("s1", "m1").status, "retired");
});
