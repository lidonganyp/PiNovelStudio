/**
 * Production selection policy regression tests.
 *
 * A valid pairwise decision selects the quality winner. Raw remains the
 * baseline and the safe fallback only when comparison is inconclusive or the
 * judge is unavailable.
 */

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createJudgeArbitrator } from "../dist/v2/core/judge-arbitrator.js";

const RAW_TEXT = "林川推开门。屋里没有异常，他确认门窗后坐下休息。";
const EDITORIAL_TEXT = "林川推开门。桌角压着半张带血的车票，背面只有一句：别回头。";

function makeCandidate(id, text, kind) {
  return {
    id,
    text,
    kind,
    model: "stub-model",
    route: kind === "raw" ? "v2_rawstage2" : "v2_amplified",
    contextHash: `hash-${id}`,
    generatedAt: "2026-07-21T00:00:00Z",
    promptProfile: {
      type: kind === "raw" ? "raw" : "editorial",
      containsDialogueRatio: false,
      containsParagraphLengthConstraint: false,
    },
  };
}

function makeIntent() {
  return {
    chapterFunction: "推进核心冲突",
    readerExperience: ["紧张", "期待"],
    currentPressure: ["追查匿名威胁"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林川"],
    inviolableFacts: [],
    sourceRefs: ["chapter-seed"],
  };
}

function extractCandidates(prompt) {
  const a = prompt.match(/【候选甲】\n+([\s\S]*?)\n+（候选甲总字符数/);
  const b = prompt.match(/【候选乙】\n+([\s\S]*?)\n+（候选乙总字符数/);
  return { A: a?.[1] ?? "", B: b?.[1] ?? "" };
}

function evidenceFor(winner, candidates) {
  const loser = winner === "A" ? "B" : "A";
  const loserText = candidates[loser];
  const span = {
    start: 0,
    end: Math.min(8, loserText.length),
    excerpt: loserText.slice(0, Math.min(8, loserText.length)),
  };
  return {
    dimension: "推进效果",
    betterCandidate: winner,
    evidenceA: loser === "A" ? [span] : [],
    evidenceB: loser === "B" ? [span] : [],
    explanation: `${winner} 的有效推进更强`,
  };
}

function makeWinnerStub(marker) {
  return async (input) => {
    const candidates = extractCandidates(input.userPrompt);
    const winner = candidates.A.includes(marker) ? "A" : "B";
    return {
      text: JSON.stringify({
        winner,
        confidence: "clear",
        decisiveReasons: [evidenceFor(winner, candidates)],
        factualRisks: [],
        regressionRisks: [],
        constitutionAlignment: "两者均未违反作品约束",
      }),
      model: "stub-judge",
      route: input.route,
      durationMs: 1,
    };
  };
}

function makeTieStub() {
  return async (input) => ({
    text: JSON.stringify({
      winner: "tie",
      confidence: "uncertain",
      decisiveReasons: [{
        dimension: "整体质量",
        betterCandidate: "neither",
        evidenceA: [],
        evidenceB: [],
        explanation: "没有形成可审计的明确胜差",
      }],
      factualRisks: [],
      regressionRisks: [],
      constitutionAlignment: "两者均未违反作品约束",
    }),
    model: "stub-judge",
    route: input.route,
    durationMs: 1,
  });
}

function makeInput(modelGenerate) {
  return {
    rawCandidate: makeCandidate("raw-1", RAW_TEXT, "raw"),
    editorialCandidate: makeCandidate("editorial-1", EDITORIAL_TEXT, "editorial_amplified"),
    intent: makeIntent(),
    constitution: null,
    modelGenerate,
    seed: 42,
  };
}

test("production entry enables automatic quality-winner selection", () => {
  const source = readFileSync(
    new URL("../v2/core/unified-entry.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /allowAutomaticLiterarySelection:\s*true/);
  assert.doesNotMatch(source, /allowAutomaticLiterarySelection:\s*false/);
});

test("default policy selects editorial when valid evidence says editorial is better", async () => {
  const result = await createJudgeArbitrator().arbitrate(
    makeInput(makeWinnerStub("带血的车票")),
  );
  assert.equal(result.finalSelectedCandidateId, "editorial-1");
  assert.equal(result.selectionStatus, "decisive_winner");
});

test("default policy selects raw when valid evidence says raw is better", async () => {
  const result = await createJudgeArbitrator().arbitrate(
    makeInput(makeWinnerStub("确认门窗")),
  );
  assert.equal(result.finalSelectedCandidateId, "raw-1");
  assert.equal(result.selectionStatus, "decisive_winner");
});

test("tie preserves raw but reports an inconclusive comparison", async () => {
  const result = await createJudgeArbitrator().arbitrate(makeInput(makeTieStub()));
  assert.equal(result.finalSelectedCandidateId, "raw-1");
  assert.equal(result.selectionStatus, "comparison_inconclusive");
  assert.doesNotMatch(result.auditSummary, /raw 更好|raw 胜出/);
});

test("judge failure preserves raw but reports comparison unavailable", async () => {
  const result = await createJudgeArbitrator().arbitrate(makeInput(async () => {
    throw new Error("HTTP 504 Gateway Timeout");
  }));
  assert.equal(result.finalSelectedCandidateId, "raw-1");
  assert.equal(result.selectionStatus, "judge_unavailable");
  assert.match(result.auditSummary, /504|不可用|降级/);
  assert.doesNotMatch(result.auditSummary, /raw 更好|raw 胜出/);
});
