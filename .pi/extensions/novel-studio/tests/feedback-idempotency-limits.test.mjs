/**
 * USER-FEEDBACK-EVIDENCE-PIPELINE-1 — 幂等与上限（场景 8/9）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStrategyPolicyStore,
  WEAK_PRIOR_ALPHA,
} from "../dist/v2/learning/strategy-policy-store.js";
import {
  createUserFeedbackIngestor,
} from "../dist/v2/learning/user-feedback-ingestor.js";
import {
  MAX_FEEDBACK_EVENTS_PER_CHAPTER,
} from "../dist/v2/learning/feedback-evidence-contracts.js";

test("场景8: 同一 feedbackEventId/evidenceId 重复摄入不增加 decision", () => {
  const store = createStrategyPolicyStore("ws-idem");
  const ingestor = createUserFeedbackIngestor();
  const ctx = {
    sourceChapter: "ch1",
    modelVersion: "m1",
    strategyId: "s1",
    opportunityType: "reader_payoff",
  };

  const a = ingestor.ingestChoice(store, {
    context: ctx,
    chosen: "editorial",
    feedbackEventId: "same-event",
  });
  const b = ingestor.ingestChoice(store, {
    context: ctx,
    chosen: "editorial",
    feedbackEventId: "same-event",
  });

  assert.equal(a.recorded, true);
  assert.equal(b.recorded, false);
  // 第二次：同一 evidenceId 幂等，store 不增加
  const rep = store.getReputation("s1", "m1");
  assert.equal(rep.sampleCount, 1);
  assert.equal(rep.alpha, WEAK_PRIOR_ALPHA + a.weight);
  assert.equal(rep.evidence.length, 1);
  assert.equal(b.evidence.evidenceId, a.evidence.evidenceId);
});

test("场景9: 同一 run 不同 feedbackEventId 可追加；同 event 不重复", () => {
  const store = createStrategyPolicyStore("ws-idem");
  const ingestor = createUserFeedbackIngestor();
  const ctx = {
    sourceChapter: "ch1",
    modelVersion: "m1",
    strategyId: "s1",
    opportunityType: "reader_payoff",
  };

  ingestor.ingestChoice(store, {
    context: ctx,
    chosen: "editorial",
    feedbackEventId: "run1-event-a",
  });
  ingestor.ingestChoice(store, {
    context: ctx,
    chosen: "editorial",
    feedbackEventId: "run1-event-b",
  });
  // 重复 a
  ingestor.ingestChoice(store, {
    context: ctx,
    chosen: "editorial",
    feedbackEventId: "run1-event-a",
  });

  const rep = store.getReputation("s1", "m1");
  assert.equal(rep.sampleCount, 2);
});

test("反馈上限常量存在且为正", () => {
  assert.ok(MAX_FEEDBACK_EVENTS_PER_CHAPTER >= 1);
});
