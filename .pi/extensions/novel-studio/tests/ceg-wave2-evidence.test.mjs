/**
 * CEG-2.1 / CEG-2.2 / CEG-4.1 / CEG-4.2 — 证据记录、资格闸门、RetrievalOutcome、ledger。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateEvidenceEligibility, authorityTier } from "../dist-test/v2/core/evidence-eligibility-gate.js";
import { canonToEvidenceRecord } from "../dist-test/v2/core/evidence-record-adapter.js";
import { buildRetrievalOutcome } from "../dist-test/v2/core/evidence-governance-contracts.js";
import { createContextDeliveryLedger } from "../dist-test/v2/core/context-delivery-ledger.js";

test("CEG-2.2: 未来章 / 缺 sourceRef / 过期生命周期不得进入合格集", () => {
  assert.equal(
    evaluateEvidenceEligibility({
      sourceChapter: "ch20",
      currentChapterNumber: 10,
      sourceRef: "ch20#x",
    }).decision,
    "reject",
  );
  assert.equal(
    evaluateEvidenceEligibility({
      sourceChapter: "ch3",
      currentChapterNumber: 10,
      sourceRef: "",
    }).reason,
    "missing_source_ref",
  );
  assert.equal(
    evaluateEvidenceEligibility({
      sourceChapter: "ch3",
      currentChapterNumber: 10,
      sourceRef: "ch3#ok",
      lifecycleStatus: "expired",
    }).decision,
    "reject",
  );
  assert.equal(
    evaluateEvidenceEligibility({
      sourceChapter: "ch3",
      currentChapterNumber: 10,
      sourceRef: "ch3#ok",
    }).reason,
    "missing_snapshot",
  );
  assert.equal(
    evaluateEvidenceEligibility({
      sourceChapter: "ch3",
      currentChapterNumber: 10,
      sourceRef: "ch3#ok",
      snapshotId: "snap:test",
    }).reason,
    "missing_source_content_hash",
  );
  assert.equal(
    evaluateEvidenceEligibility({
      sourceChapter: "ch3",
      currentChapterNumber: 10,
      sourceRef: "ch3#ok",
      snapshotId: "snap:test",
      sourceContentHash: "src-hash",
      evidenceExcerptHash: "excerpt-hash",
    }).decision,
    "eligible",
  );
});

test("CEG-2.1: canon adapter 拒绝未来事实，接受可回源正式事实", () => {
  const rejected = canonToEvidenceRecord(
    {
      id: "canon:future",
      kind: "canon",
      fact: "未来事实",
      category: "entity",
      sourceChapter: "ch99",
      sourceRef: "ch99#x",
      confidence: 1,
      lastUpdated: "2026-08-15T00:00:00.000Z",
    },
    "snap:test",
    10,
  );
  assert.equal(rejected, null);
  const accepted = canonToEvidenceRecord(
    {
      id: "canon:old",
      kind: "canon",
      fact: "碎星剑在叶尘手里",
      category: "entity",
      sourceChapter: "ch3",
      sourceRef: "ch3#canon:old",
      confidence: 1,
      lastUpdated: "2026-08-15T00:00:00.000Z",
    },
    "snap:test",
    10,
  );
  assert.ok(accepted);
  assert.equal(accepted.snapshotId, "snap:test");
  assert.equal(accepted.epistemicStatus, "derived");
});

test("CEG-2.3: 权威分层 author_declaration > system_derived", () => {
  assert.ok(authorityTier("author_declaration") > authorityTier("system_derived"));
});

test("CEG-4.1: no_match / retrieval_error / truncated / match 互不混淆", () => {
  assert.equal(buildRetrievalOutcome({
    queryId: "q1", evidence: [], usedCalls: 1, remainingCalls: 3,
  }).status, "no_match");
  assert.equal(buildRetrievalOutcome({
    queryId: "q2", evidence: [], error: "hash_mismatch", usedCalls: 1, remainingCalls: 3,
  }).status, "retrieval_error");
  assert.equal(buildRetrievalOutcome({
    queryId: "q3", evidence: [{
      evidenceId: "e1",
      statement: "x",
      authorityClass: "committed_state",
      epistemicStatus: "confirmed",
      sourceRef: "ch1#e1",
      sourceContentHash: "a",
      validFrom: null,
      validUntil: null,
      matchedBecause: [],
      retrievalQueryId: "q3",
      snapshotId: "s",
      traceable: true,
    }],
    truncated: true,
    usedCalls: 1,
    remainingCalls: 2,
  }).status, "truncated");
});

test("CEG-4.2: ledger 只记录传递动作", () => {
  const ledger = createContextDeliveryLedger();
  ledger.append({
    evidenceId: "e1",
    snapshotId: "s1",
    queryId: null,
    modelTurnId: null,
    action: "dropped",
    reason: "renderer_entry_budget",
    sourceRef: "ch1#e1",
    contentHash: "abc",
    contextPackageHash: null,
    modelInputHash: null,
    tokenEstimate: 12,
  });
  assert.equal(ledger.events().length, 1);
  assert.equal(ledger.events()[0].action, "dropped");
});
