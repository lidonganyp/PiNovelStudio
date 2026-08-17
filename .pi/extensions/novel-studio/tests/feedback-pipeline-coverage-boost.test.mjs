/**
 * Coverage boost for feedback pipeline edge paths.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createUserFeedbackIngestor,
} from "../dist/v2/learning/user-feedback-ingestor.js";
import {
  createStrategyPolicyStore,
  loadStrategyPolicyStore,
  saveStrategyPolicyStore,
  WEAK_PRIOR_ALPHA,
} from "../dist/v2/learning/strategy-policy-store.js";
import {
  loadFeedbackEvidenceLedger,
  appendFeedbackEvidenceEvents,
  materializePolicyFromFeedbackLedger,
  observationFromRecordedOutcome,
  feedbackEvidenceLedgerPath,
} from "../dist/v2/learning/feedback-evidence-ledger-store.js";
import {
  literaryFeedbackAllowedOnlineActions,
  assertFeedbackAffectsNextRequestOnly,
} from "../dist/v2/learning/feedback-evidence-contracts.js";
import {
  resolveFeedbackLineage,
  appendPublicFeedbackLedgerObservation,
  buildFeedbackEventId,
} from "../dist/handlers/strategy-feedback-lineage.js";

test("rating win/loss/tie + raw rating paths", () => {
  const store = createStrategyPolicyStore("ws-cov");
  const ingestor = createUserFeedbackIngestor();
  const ctx = {
    sourceChapter: "ch1",
    modelVersion: "m1",
    strategyId: "s1",
    opportunityType: "author_style",
  };
  const win = ingestor.ingestRating(store, {
    context: ctx,
    rating: 5,
    candidateSource: "editorial",
    feedbackEventId: "r-win",
  });
  assert.equal(win.outcome, "win");
  const loss = ingestor.ingestRating(store, {
    context: ctx,
    rating: 1,
    candidateSource: "editorial",
    feedbackEventId: "r-loss",
  });
  assert.equal(loss.outcome, "loss");
  const tie = ingestor.ingestRating(store, {
    context: ctx,
    rating: 3,
    candidateSource: "editorial",
    feedbackEventId: "r-tie",
  });
  assert.equal(tie.outcome, "tie");
  const raw = ingestor.ingestRating(store, {
    context: ctx,
    rating: 5,
    candidateSource: "raw",
    feedbackEventId: "r-raw",
  });
  assert.equal(raw.recorded, false);
});

test("status override + revert by missing id", () => {
  const store = createStrategyPolicyStore("ws-cov");
  const ingestor = createUserFeedbackIngestor();
  const applied = ingestor.applyStatusOverride(store, {
    strategyId: "s1",
    modelVersion: "m1",
    status: "dormant",
    reason: "pause exploration",
  });
  assert.equal(applied.newStatus, "dormant");
  const missing = ingestor.revertOutcomeByEvidenceId(store, "s1", "m1", "nope");
  assert.equal(missing.reverted, false);
});

test("ledger append idempotent + materialize from ledger", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "fb-cov-"));
  const workspaceId = "ws-cov";
  mkdirSync(join(projectRoot, "workspaces", workspaceId), { recursive: true });
  try {
    const obs = observationFromRecordedOutcome({
      evidenceId: "cov-1",
      strategyId: "s1",
      modelVersion: "m1",
      sourceChapter: "ch1",
      outcome: "win",
      weight: 3,
      decisionCount: 1,
      recorded: true,
      feedbackLevel: "explicit_direct",
      attributionConfidence: "high",
      lineage: {
        orchestratorRunId: "run-1",
        candidateId: "c1",
        strategyBundleId: "bundle:s1",
        strategyId: "s1",
        modelVersion: "m1",
        promptBundleId: "p1",
        deliveredSource: "editorial",
        exposureId: "e1",
        feedbackEventId: "cov-1",
        sourceChapter: "ch1",
      },
    });
    assert.ok(obs);
    const a = appendFeedbackEvidenceEvents(workspaceId, projectRoot, [obs]);
    assert.equal(a.appended, 1);
    const b = appendFeedbackEvidenceEvents(workspaceId, projectRoot, [obs]);
    assert.equal(b.appended, 0);
    assert.ok(feedbackEvidenceLedgerPath(workspaceId, projectRoot).includes("feedback-evidence-ledger.json"));

    const store = createStrategyPolicyStore(workspaceId);
    const n = materializePolicyFromFeedbackLedger(store, workspaceId, projectRoot);
    assert.ok(n >= 1);
    assert.ok(store.getReputation("s1", "m1").alpha > WEAK_PRIOR_ALPHA);
    saveStrategyPolicyStore(store, workspaceId, projectRoot);
    const loaded = loadStrategyPolicyStore(workspaceId, projectRoot);
    assert.equal(loaded.getReputation("s1", "m1").sampleCount, 1);
    assert.equal(loadFeedbackEvidenceLedger(workspaceId, projectRoot).events.length, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("public lineage helpers", () => {
  const incomplete = resolveFeedbackLineage({
    workspaceId: "ws",
    strategyId: "s1",
    modelVersion: "m1",
    sourceChapter: "ch1",
    feedbackEventId: "fb1",
  });
  assert.equal(incomplete.complete, false);

  const complete = resolveFeedbackLineage({
    workspaceId: "ws",
    strategyId: "s1",
    modelVersion: "m1",
    sourceChapter: "ch1",
    feedbackEventId: "fb2",
    orchestratorRunId: "run",
    candidateId: "cand",
    strategyBundleId: "bundle:s1",
    exposureId: "exp",
    promptBundleId: "prompt",
    deliveredSource: "editorial",
  });
  assert.equal(complete.complete, true);
  assert.ok(buildFeedbackEventId({
    workspaceId: "ws",
    strategyId: "s1",
    action: "choice",
    chapterId: "1",
  }).startsWith("public:"));

  const projectRoot = mkdtempSync(join(tmpdir(), "fb-cov2-"));
  try {
    const append = appendPublicFeedbackLedgerObservation({
      workspaceId: "ws",
      projectRoot,
      strategyId: "s1",
      modelVersion: "m1",
      sourceChapter: "ch1",
      outcome: "win",
      weight: 3,
      recorded: true,
      evidenceId: "pub-1",
      lineage: complete.completeLineage,
    });
    assert.equal(append.appended, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }

  assert.deepEqual(literaryFeedbackAllowedOnlineActions("loss").includes("retired"), false);
  assert.equal(assertFeedbackAffectsNextRequestOnly(["next_request_only"]).ok, true);
});
