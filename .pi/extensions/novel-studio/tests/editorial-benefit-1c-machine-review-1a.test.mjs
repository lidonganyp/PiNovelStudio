/**
 * EDITORIAL-BENEFIT-1C-MACHINE-REVIEW-1A contract tests.
 *
 * This layer is local-only. It freezes an anonymous A/B packet and a separate
 * three-slot machine review protocol without creating human review evidence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ANONYMOUS_REVIEW_PACKET_SCHEMA_FULL_ID,
  ANONYMOUS_REVIEW_PACKET_SCHEMA_ID,
  ANONYMOUS_REVIEW_PACKET_SCHEMA_VERSION,
  validateAnonymousReviewPacket,
  MACHINE_REVIEW_SCHEMA_FULL_ID,
  MACHINE_REVIEW_SCHEMA_ID,
  MACHINE_REVIEW_SCHEMA_VERSION,
  aggregateMachineReviews,
  validateMachineReview,
} from "../dist-eval/v2/core/machine-review-schema.js";

const packetSource = readFileSync(
  fileURLToPath(new URL("../v2/core/machine-review-schema.ts", import.meta.url)),
  "utf8",
);
const reviewSource = readFileSync(
  fileURLToPath(new URL("../v2/core/machine-review-schema.ts", import.meta.url)),
  "utf8",
);

function packet(overrides = {}) {
  return {
    schemaId: ANONYMOUS_REVIEW_PACKET_SCHEMA_ID,
    schemaVersion: ANONYMOUS_REVIEW_PACKET_SCHEMA_VERSION,
    packetId: "packet-001",
    options: [
      { label: "A", text: "The door opened slowly." },
      { label: "B", text: "The lock clicked. The door moved." },
    ],
    ...overrides,
  };
}

function review(slot, preference, overrides = {}) {
  const quote = preference === "B" ? "lock clicked" : "door opened";
  const start = preference === "B" ? 4 : 4;
  const option = preference === "B" ? "B" : "A";
  return {
    schemaId: MACHINE_REVIEW_SCHEMA_ID,
    schemaVersion: MACHINE_REVIEW_SCHEMA_VERSION,
    packetId: "packet-001",
    slot,
    preference,
    rationale: "The cited passage is more concrete.",
    spans: preference === "ABSTAIN"
      ? []
      : [{ option, start, end: start + quote.length, quote }],
    ...overrides,
  };
}

function errorCodes(result) {
  return result.ok ? [] : result.errors.map((error) => error.code);
}

test("anonymous packet schema id and version are fixed", () => {
  assert.equal(ANONYMOUS_REVIEW_PACKET_SCHEMA_ID, "pinovel.anonymous-review-packet");
  assert.equal(ANONYMOUS_REVIEW_PACKET_SCHEMA_VERSION, "v1");
  assert.equal(ANONYMOUS_REVIEW_PACKET_SCHEMA_FULL_ID, "pinovel.anonymous-review-packet/v1");
});

test("a minimal A/B packet validates without an origin mapping", () => {
  const result = validateAnonymousReviewPacket(packet());
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.options.map((option) => option.label), ["A", "B"]);
});

test("anonymous packet rejects forbidden disclosure keys", () => {
  for (const key of ["raw", "editorial", "judge", "model", "provenance", "mapping", "humanVerdict"]) {
    const result = validateAnonymousReviewPacket(packet({ [key]: "not allowed" }));
    assert.equal(result.ok, false, key);
    assert.ok(errorCodes(result).includes("unknown_key"), key);
  }
});

test("anonymous packet rejects unknown keys at every object level", () => {
  const top = validateAnonymousReviewPacket(packet({ extra: true }));
  assert.ok(errorCodes(top).includes("unknown_key"));

  const nested = validateAnonymousReviewPacket(packet({
    options: [
      { label: "A", text: "a", source: "hidden" },
      { label: "B", text: "b" },
    ],
  }));
  assert.ok(errorCodes(nested).includes("unknown_key"));
});

test("anonymous packet requires exactly one A and one B option", () => {
  for (const options of [
    [{ label: "A", text: "a" }],
    [{ label: "A", text: "a" }, { label: "A", text: "b" }],
    [{ label: "B", text: "b" }, { label: "A", text: "a" }],
    [{ label: "A", text: "a" }, { label: "B", text: "b" }, { label: "C", text: "c" }],
  ]) {
    const result = validateAnonymousReviewPacket(packet({ options }));
    assert.equal(result.ok, false, JSON.stringify(options));
    assert.ok(errorCodes(result).includes("invalid_options"), JSON.stringify(options));
  }
});

test("anonymous packet rejects empty identifiers and option text", () => {
  assert.ok(errorCodes(validateAnonymousReviewPacket(packet({ packetId: "" }))).includes("invalid_string"));
  assert.ok(errorCodes(validateAnonymousReviewPacket(packet({
    options: [{ label: "A", text: "" }, { label: "B", text: "b" }],
  }))).includes("invalid_string"));
});

test("machine review schema id and version are fixed", () => {
  assert.equal(MACHINE_REVIEW_SCHEMA_ID, "pinovel.machine-review");
  assert.equal(MACHINE_REVIEW_SCHEMA_VERSION, "v1");
  assert.equal(MACHINE_REVIEW_SCHEMA_FULL_ID, "pinovel.machine-review/v1");
});

test("a cited machine preference validates against its anonymous packet", () => {
  const result = validateMachineReview(review(1, "A"), packet());
  assert.equal(result.ok, true);
  assert.equal(result.value.preference, "A");
  assert.equal(result.value.slot, 1);
});

test("machine review rejects schema drift", () => {
  const wrongId = validateMachineReview(review(1, "A", { schemaId: "pinovel.other" }), packet());
  assert.ok(errorCodes(wrongId).includes("schema_mismatch"));

  const wrongVersion = validateMachineReview(review(1, "A", { schemaVersion: "v2" }), packet());
  assert.ok(errorCodes(wrongVersion).includes("schema_mismatch"));
});

test("machine review rejects forbidden disclosure and verdict keys", () => {
  for (const key of ["raw", "editorial", "judge", "model", "provenance", "mapping", "humanVerdict"]) {
    const result = validateMachineReview(review(1, "A", { [key]: "not allowed" }), packet());
    assert.equal(result.ok, false, key);
    assert.ok(errorCodes(result).includes("unknown_key"), key);
  }
});

test("machine review rejects unknown nested span keys", () => {
  const result = validateMachineReview(review(1, "A", {
    spans: [{ option: "A", start: 4, end: 15, quote: "door opened", note: "hidden" }],
  }), packet());
  assert.ok(errorCodes(result).includes("unknown_key"));
});

test("review slots are finite integers from one through three", () => {
  for (const slot of [0, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
    const result = validateMachineReview(review(slot, "A"), packet());
    assert.equal(result.ok, false, String(slot));
    assert.ok(errorCodes(result).includes("invalid_slot"), String(slot));
  }
});

test("machine review packetId must match the packet being reviewed", () => {
  const result = validateMachineReview(review(1, "A", { packetId: "other-packet" }), packet());
  assert.ok(errorCodes(result).includes("packet_mismatch"));
});

test("span offsets must be finite integers", () => {
  for (const start of [0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = validateMachineReview(review(1, "A", {
      spans: [{ option: "A", start, end: 15, quote: "door opened" }],
    }), packet());
    assert.ok(errorCodes(result).includes("invalid_span"), String(start));
  }
});

test("span offsets must be non-empty and within option boundaries", () => {
  const invalidSpans = [
    { option: "A", start: -1, end: 2, quote: "Th" },
    { option: "A", start: 4, end: 4, quote: "" },
    { option: "A", start: 15, end: 4, quote: "door opened" },
    { option: "A", start: 4, end: 999, quote: "door opened" },
  ];
  for (const span of invalidSpans) {
    const result = validateMachineReview(review(1, "A", { spans: [span] }), packet());
    assert.ok(errorCodes(result).includes("invalid_span"), JSON.stringify(span));
  }
});

test("span quote must exactly equal the packet text slice", () => {
  const result = validateMachineReview(review(1, "A", {
    spans: [{ option: "A", start: 4, end: 15, quote: "door CLOSED" }],
  }), packet());
  assert.ok(errorCodes(result).includes("quote_mismatch"));
});

test("non-abstaining reviews require evidence while ABSTAIN carries none", () => {
  const missing = validateMachineReview(review(1, "A", { spans: [] }), packet());
  assert.ok(errorCodes(missing).includes("missing_evidence"));

  const abstain = validateMachineReview(review(1, "ABSTAIN"), packet());
  assert.equal(abstain.ok, true);

  const citedAbstain = validateMachineReview(review(1, "ABSTAIN", {
    spans: [{ option: "A", start: 4, end: 15, quote: "door opened" }],
  }), packet());
  assert.ok(errorCodes(citedAbstain).includes("unexpected_evidence"));
});

test("aggregate requires exactly three protocol slots", () => {
  for (const reviews of [
    [],
    [review(1, "A")],
    [review(1, "A"), review(2, "A")],
    [review(1, "A"), review(2, "A"), review(3, "A"), review(3, "A")],
  ]) {
    const result = aggregateMachineReviews(packet(), reviews);
    assert.equal(result.status, "TRIAGE_ONLY");
    assert.ok(result.errors.some((error) => error.code === "review_count"));
  }
});

test("two or more aligned reviews hold for confirmation, never create a human verdict", () => {
  const result = aggregateMachineReviews(packet(), [
    review(1, "A"),
    review(2, "B"),
    review(3, "A"),
  ]);
  assert.equal(result.status, "HOLD_FOR_HUMAN_CONFIRMATION");
  assert.equal(result.suggestedPreference, "A");
  assert.deepEqual(result.counts, { A: 2, B: 1, TIE: 0, ABSTAIN: 0 });
  assert.equal("humanVerdict" in result, false);
  assert.equal("winner" in result, false);
});

test("three distinct preferences remain TRIAGE_ONLY", () => {
  const result = aggregateMachineReviews(packet(), [
    review(1, "A"),
    review(2, "B"),
    review(3, "TIE", {
      spans: [{ option: "A", start: 4, end: 15, quote: "door opened" }],
    }),
  ]);
  assert.equal(result.status, "TRIAGE_ONLY");
  assert.equal(result.suggestedPreference, null);
});

test("duplicate or missing slots remain TRIAGE_ONLY instead of filling or retrying", () => {
  const result = aggregateMachineReviews(packet(), [
    review(1, "A"),
    review(1, "A"),
    review(3, "A"),
  ]);
  assert.equal(result.status, "TRIAGE_ONLY");
  assert.ok(result.errors.some((error) => error.code === "invalid_slot_set"));
});

test("ABSTAIN or invalid review data remains TRIAGE_ONLY", () => {
  const abstain = aggregateMachineReviews(packet(), [
    review(1, "A"),
    review(2, "ABSTAIN"),
    review(3, "A"),
  ]);
  assert.equal(abstain.status, "TRIAGE_ONLY");

  const invalid = aggregateMachineReviews(packet(), [
    review(1, "A"),
    review(2, "A", { spans: [{ option: "A", start: 4, end: 15, quote: "wrong quote" }] }),
    review(3, "A"),
  ]);
  assert.equal(invalid.status, "TRIAGE_ONLY");
  assert.ok(invalid.errors.some((error) => error.code === "quote_mismatch"));
});

test("aggregate status is restricted to the two non-human evidence states", () => {
  const cases = [
    aggregateMachineReviews(packet(), [review(1, "A"), review(2, "A"), review(3, "A")]),
    aggregateMachineReviews(packet(), [review(1, "A")]),
  ];
  for (const result of cases) {
    assert.ok(["TRIAGE_ONLY", "HOLD_FOR_HUMAN_CONFIRMATION"].includes(result.status));
  }
});

test("local schemas do not call external review, export, save, or state APIs", () => {
  const source = `${packetSource}\n${reviewSource}`;
  assert.doesNotMatch(source, /exportReviewResponse\s*\(/);
  assert.doesNotMatch(source, /callModel\s*\(|invokeModel\s*\(|modelGenerate\s*\(/);
  assert.doesNotMatch(source, /writeFile\s*\(|saveChapter\s*\(|commitState\s*\(/);
  assert.doesNotMatch(source, /humanVerdict\s*:/);
});
