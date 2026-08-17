/**
 * RepairAuthorizationLedger — 一次性 reservation + 执行时 hash/snapshot 校验
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRepairAuthorizationLedger } from "../dist/v2/core/repair-authorization-ledger.js";
import { evaluateRepairAuthorization } from "../dist/v2/core/repair-authorization-policy.js";

function makeAuth(overrides = {}) {
  return {
    authorizationId: "auth-1",
    orchestratorDecisionId: "decision-1",
    candidateId: "cand-1",
    candidateTextHash: "hash-aaa",
    findingIds: ["f1"],
    evidenceIds: ["ev1"],
    snapshotId: "snap-1",
    evidenceExcerptHashes: ["ex1"],
    action: "span_patch",
    authorizedRanges: [{ start: 0, end: 2 }],
    budgetReservationId: "resv-auth-1",
    issuedBy: "system",
    reasonCode: "authorized",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

test("register 写入 budgetReservationId，consume 一次后拒绝重放", () => {
  const ledger = createRepairAuthorizationLedger();
  const auth = ledger.register(makeAuth({ budgetReservationId: null }));
  assert.equal(auth.budgetReservationId, "resv-auth-1");

  const first = ledger.consume(auth, "hash-aaa", "snap-1");
  assert.equal(first.ok, true);

  const second = ledger.consume(auth, "hash-aaa", "snap-1");
  assert.equal(second.ok, false);
  assert.equal(second.reasonCode, "deny_reservation_consumed");
});

test("整章 range 的 knowledge_boundary 授权 new_candidate，不签发 span_patch", () => {
  const decision = evaluateRepairAuthorization({
    finding: {
      id: "f-full",
      source: "knowledge_boundary_checker",
      failureType: "knowledge_boundary",
      severity: "hard",
      span: { start: 0, end: 10, excerpt: "abcdefghij" },
      conflictFact: "full",
      sourceRef: "character:x:forbiddenKnowledge",
      evidenceId: "ev-full",
      confidence: 1,
      allowedRepairRange: { start: 0, end: 10, excerpt: "abcdefghij" },
      description: "full",
      certainty: "corroborated",
      coverageStatus: "missing",
    },
    evidenceRecords: [{
      evidenceId: "ev-full",
      statement: "full",
      authorityClass: "author_declaration",
      epistemicStatus: "confirmed",
      sourceRef: "character:x:forbiddenKnowledge",
      sourceContentHash: "src",
      evidenceExcerptHash: "ex",
      validFrom: null,
      validUntil: null,
      matchedBecause: ["AUTHOR_CONTRACT"],
      retrievalQueryId: null,
      snapshotId: "snap-1",
      traceable: true,
    }],
    candidateId: "c1",
    candidateTextHash: "h1",
    candidateTextLength: 10,
    snapshotId: "snap-1",
    budgetAvailable: true,
  });
  assert.equal(decision.decision, "authorized");
  assert.equal(decision.action, "new_candidate");
  assert.deepEqual(decision.authorization?.authorizedRanges, []);
  assert.ok(decision.authorization?.budgetReservationId);
});

test("consume 时 hash 或 snapshot 不一致 → stale_authorization", () => {
  const ledger = createRepairAuthorizationLedger();
  const auth = ledger.register(makeAuth());
  const hashMismatch = ledger.consume(auth, "hash-bbb", "snap-1");
  assert.equal(hashMismatch.ok, false);
  assert.equal(hashMismatch.reasonCode, "stale_authorization");

  const snapMismatch = ledger.consume(auth, "hash-aaa", "snap-other");
  assert.equal(snapMismatch.ok, false);
  assert.equal(snapMismatch.reasonCode, "stale_authorization");
});

test("consume 校验 expiresAt：过期或缺失均拒绝，且不标记已消费", () => {
  const ledger = createRepairAuthorizationLedger();
  const expired = ledger.register(makeAuth({
    authorizationId: "auth-expired",
    budgetReservationId: "resv-auth-expired",
    expiresAt: new Date(Date.now() - 1).toISOString(),
  }));
  const expiredResult = ledger.consume(expired, "hash-aaa", "snap-1");
  assert.equal(expiredResult.ok, false);
  assert.equal(expiredResult.reasonCode, "deny_reservation_expired");
  const replayExpired = ledger.consume(expired, "hash-aaa", "snap-1");
  assert.equal(replayExpired.reasonCode, "deny_reservation_expired");

  const missingExpiry = ledger.register(makeAuth({
    authorizationId: "auth-missing-expiry",
    budgetReservationId: "resv-auth-missing-expiry",
    expiresAt: "",
  }));
  const missingResult = ledger.consume(missingExpiry, "hash-aaa", "snap-1");
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.reasonCode, "deny_reservation_expired");

  const future = ledger.register(makeAuth({
    authorizationId: "auth-future",
    budgetReservationId: "resv-auth-future",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  const atExpiry = ledger.consume(
    future,
    "hash-aaa",
    "snap-1",
    Date.parse(future.expiresAt),
  );
  assert.equal(atExpiry.ok, false);
  assert.equal(atExpiry.reasonCode, "deny_reservation_expired");
  const beforeExpiry = ledger.consume(
    future,
    "hash-aaa",
    "snap-1",
    Date.parse(future.expiresAt) - 1,
  );
  assert.equal(beforeExpiry.ok, true);
});
