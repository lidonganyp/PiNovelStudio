/** Production-final Gemini challenger eval. Pipeline and judge calls are stubbed. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateProductionFinalChallenger,
  compareProductionFinalChallenger,
} from "../dist-eval/novelbench/production-final-challenger.js";

const contract = {
  overallPlotDirection: ["direction"],
  chapterFunction: ["goal"],
  previousState: ["previous"],
  relevantCharacters: ["character"],
  characterMotivations: ["character:motive"],
  eventSummaries: ["event"],
  mustInclude: ["known"],
  stateChanges: ["change"],
  foreshadowing: ["promise"],
  causalRelations: ["cause"],
  endingTarget: ["pressure"],
  inviolableFacts: ["known"],
  stateConstraints: ["unknown"],
  forbidReferenceLeakage: true,
  preserveEstablishedState: true,
};

function candidate(id, text, route = "v2_rawstage2", kind = "context_enhanced") {
  return {
    id,
    kind,
    text,
    model: "unified",
    route,
    contextHash: "same-context",
    generatedAt: "2026-07-20T00:00:00.000Z",
    durationMs: 1,
    promptProfile: {
      type: "editorial",
      tokensIn: 1,
      containsDialogueRatio: false,
      containsParagraphLengthConstraint: false,
      containsControlChecklist: false,
      containsMechanicalMetric: false,
      contractIds: [],
    },
  };
}

function preview(writerModel, options = {}) {
  const claude = writerModel === "claude";
  const raw = candidate(`${writerModel}-raw`, `${writerModel.toUpperCase()}_RAW`);
  const selected = options.selectedSource === "raw"
    ? raw
    : candidate(`${writerModel}-final`, `${writerModel.toUpperCase()}_FINAL`, "v2_amplified", "editorial_amplified");
  const candidates = options.candidates ?? (selected === raw ? [raw] : [raw, selected]);
  const finalFactPassed = options.finalFactPassed ?? true;
  const completenessPassed = options.completenessPassed ?? true;
  return {
    status: options.status ?? "ok",
    isPreviewRun: true,
    text: selected.text,
    selectedSource: selected === raw ? "raw" : "editorial",
    selectedCandidateId: selected.id,
    candidates,
    stageResults: {
      chapterContract: options.contract ?? contract,
      rawFactGuard: { ok: options.rawFactPassed ?? true, errors: options.rawErrors ?? [] },
      finalFactRecheck: { passed: finalFactPassed, errors: finalFactPassed ? [] : ["final fact"] },
      finalTextCompleteness: { passed: completenessPassed, findings: completenessPassed ? [] : [{ reason: "truncated" }] },
      positiveGainCandidates: options.positiveGainCandidates ?? { status: "generated", candidateCount: 1 },
      promptAdapter: { profile: claude ? "claude_writer_v1" : "gemini_writer_v1" },
      modelCalls: [{
        route: "v2_rawstage2",
        requestedRoute: claude ? "v2_rawstage2" : "v2_rawstage2_gemini31",
        kind: "raw_chapter",
        actualProvider: claude ? "claude" : "gemini31",
        actualModel: claude ? "claude-opus-4-6" : "gemini-3.1-pro-preview",
        finishReason: "stop",
        durationMs: claude ? 100 : 80,
        ts: 1,
      }],
      commitAndSave: { skipped: true, reason: "fullPipelinePreview" },
      ...(options.qualityExperiment ? { qualityExperiment: options.qualityExperiment } : {}),
    },
  };
}

function arbitration(winnerId, overrides = {}) {
  const round = (winnerCandidateId, degraded = false) => ({ winnerCandidateId, degraded });
  return {
    firstRound: round(winnerId, overrides.firstDegraded),
    reverseRound: round(winnerId, overrides.reverseDegraded),
    reverseReviewed: overrides.reverseReviewed ?? true,
    conflicted: overrides.conflicted ?? false,
    arbitrationTriggered: false,
    finalSelectedCandidateId: winnerId,
    rounds: [],
    selection: { selectedCandidateId: winnerId, reason: "stub", needsReverseReview: false },
    auditSummary: "stub",
    arbitrationRound: null,
  };
}

test("compares production-selected finals without activating raw-isolated qualityExperiment", async () => {
  const calls = [];
  const result = await compareProductionFinalChallenger({
    workspaceId: "comparison",
    chapterId: "1",
    chapterNumber: 1,
    seed: 17,
    runPreview: async (input) => {
      calls.push(input);
      return preview(input.writerModel);
    },
    judgeModelGenerate: async () => { throw new Error("unused stub"); },
    arbitrate: async ({ editorialCandidate }) => arbitration(editorialCandidate.id),
  });

  assert.deepEqual(calls.map((call) => call.writerModel), ["claude", "gemini31"]);
  assert.ok(calls.every((call) => call.fullPipelinePreview === true));
  assert.ok(calls.every((call) => call.qualityExperiment === undefined));
  assert.ok(calls.every((call) => call.evalMode === undefined));
  assert.equal(result.comparisonMode, "production_final_challenger");
  assert.equal(result.winner, "gemini31");
  assert.equal(result.incrementalGain, true);
  assert.equal(result.candidates.claude.selectedSource, "editorial");
  assert.equal(result.candidates.gemini31.selectedSource, "editorial");
});

test("fails closed when a preview did not reach the production candidate path", async () => {
  await assert.rejects(compareProductionFinalChallenger({
    workspaceId: "comparison",
    chapterId: "2",
    chapterNumber: 2,
    runPreview: async ({ writerModel }) => preview(writerModel, writerModel === "gemini31"
      ? { positiveGainCandidates: undefined, qualityExperiment: { arm: "raw", sampleIndex: 1 } }
      : {}),
    judgeModelGenerate: async () => { throw new Error("must not run"); },
    arbitrate: async () => { throw new Error("must not run"); },
  }), /production-final|qualityExperiment/i);
});

test("final FactGuard or completeness veto is decisive and spends no judge call", async () => {
  let judgeCalls = 0;
  const factVeto = await compareProductionFinalChallenger({
    workspaceId: "comparison",
    chapterId: "3",
    chapterNumber: 3,
    runPreview: async ({ writerModel }) => preview(writerModel, writerModel === "gemini31" ? { finalFactPassed: false } : {}),
    judgeModelGenerate: async () => { judgeCalls += 1; throw new Error("must not run"); },
    arbitrate: async () => { judgeCalls += 1; throw new Error("must not run"); },
  });
  assert.equal(factVeto.winner, "claude");
  assert.equal(factVeto.decisionReason, "gemini_final_gate_veto");

  const completenessVeto = await compareProductionFinalChallenger({
    workspaceId: "comparison",
    chapterId: "4",
    chapterNumber: 4,
    runPreview: async ({ writerModel }) => preview(writerModel, writerModel === "claude" ? { completenessPassed: false } : {}),
    judgeModelGenerate: async () => { judgeCalls += 1; throw new Error("must not run"); },
    arbitrate: async () => { judgeCalls += 1; throw new Error("must not run"); },
  });
  assert.equal(completenessVeto.winner, "gemini31");
  assert.equal(completenessVeto.decisionReason, "claude_final_gate_veto");
  assert.equal(completenessVeto.incrementalGain, true);
  assert.equal(judgeCalls, 0);
});

test("a raw FactGuard-blocked production preview is a decisive veto without downstream traces", async () => {
  let judgeCalls = 0;
  const result = await compareProductionFinalChallenger({
    workspaceId: "comparison",
    chapterId: "raw-blocked",
    chapterNumber: 1,
    runPreview: async ({ writerModel }) => {
      const output = preview(writerModel);
      if (writerModel === "gemini31") {
        const [raw] = output.candidates;
        output.status = "blocked";
        output.text = "";
        output.selectedSource = "raw";
        output.selectedCandidateId = "";
        output.candidates = [];
        output.stageResults.rawFactGuard = { ok: false, errors: ["raw fact"] };
        output.stageResults.productionFinalPreviewBlockedCandidate = {
          id: raw.id,
          textHash: "f".repeat(64),
          characterCount: raw.text.length,
          contextHash: raw.contextHash,
          route: raw.route,
          candidateCount: 1,
        };
        delete output.stageResults.finalFactRecheck;
        delete output.stageResults.finalTextCompleteness;
        delete output.stageResults.positiveGainCandidates;
        delete output.stageResults.commitAndSave;
      }
      return output;
    },
    judgeModelGenerate: async () => { judgeCalls += 1; throw new Error("must not run"); },
    arbitrate: async () => { judgeCalls += 1; throw new Error("must not run"); },
  });

  assert.equal(result.winner, "claude");
  assert.equal(result.decisionReason, "gemini_final_gate_veto");
  assert.equal(result.candidates.gemini31.rawFactGuardPassed, false);
  assert.equal(result.candidates.gemini31.finalGatePassed, false);
  assert.equal(result.candidates.gemini31.productionCandidatePathReached, false);
  assert.equal(judgeCalls, 0);
});

test("rejects contract drift, candidate overflow, and model-route provenance mismatch", async () => {
  await assert.rejects(compareProductionFinalChallenger({
    workspaceId: "comparison", chapterId: "5", chapterNumber: 5,
    runPreview: async ({ writerModel }) => preview(writerModel, writerModel === "gemini31"
      ? { contract: { ...contract, chapterFunction: ["different"] } }
      : {}),
    judgeModelGenerate: async () => { throw new Error("unused"); },
  }), /ChapterContract mismatch/);

  await assert.rejects(compareProductionFinalChallenger({
    workspaceId: "comparison", chapterId: "6", chapterNumber: 6,
    runPreview: async ({ writerModel }) => preview(writerModel, writerModel === "gemini31"
      ? { candidates: [candidate("1", "1"), candidate("2", "2"), candidate("3", "3"), candidate("4", "4")] }
      : {}),
    judgeModelGenerate: async () => { throw new Error("unused"); },
  }), /candidate count/i);

  await assert.rejects(compareProductionFinalChallenger({
    workspaceId: "comparison", chapterId: "7", chapterNumber: 7,
    runPreview: async ({ writerModel }) => {
      const output = preview(writerModel);
      if (writerModel === "gemini31") output.stageResults.modelCalls[0].actualProvider = "claude";
      return output;
    },
    judgeModelGenerate: async () => { throw new Error("unused"); },
  }), /provider mismatch/i);
});

test("scoped admission requires two literary Gemini wins in three controlled comparisons", () => {
  const result = (winner, decisionReason = "reverse_consistent_judge_winner") => ({
    winner,
    decisionReason,
    controlled: true,
    reverseConsistent: decisionReason === "reverse_consistent_judge_winner",
    candidates: {
      claude: { finalGatePassed: true },
      gemini31: { finalGatePassed: true },
    },
  });
  const admitted = aggregateProductionFinalChallenger([
    { sceneId: "suspense", ...result("gemini31") },
    { sceneId: "suspense", ...result("gemini31") },
    { sceneId: "suspense", ...result("claude") },
  ]);
  assert.equal(admitted.scenes.suspense.admitted, true);
  assert.equal(admitted.scenes.suspense.geminiLiteraryWins, 2);

  const recoveryOnly = aggregateProductionFinalChallenger([
    { sceneId: "suspense", ...result("gemini31", "claude_final_gate_veto") },
    { sceneId: "suspense", ...result("gemini31", "claude_final_gate_veto") },
    { sceneId: "suspense", ...result("claude") },
  ]);
  assert.equal(recoveryOnly.scenes.suspense.admitted, false);
  assert.match(recoveryOnly.scenes.suspense.reason, /literary/i);
});

test("serialized result contains hashes and metrics but no final prose", async () => {
  const marker = "PROSE_MARKER_MUST_NOT_LEAK";
  const result = await compareProductionFinalChallenger({
    workspaceId: "comparison", chapterId: "8", chapterNumber: 8,
    runPreview: async ({ writerModel }) => {
      const output = preview(writerModel);
      output.text = marker;
      output.candidates.find((item) => item.id === output.selectedCandidateId).text = marker;
      return output;
    },
    judgeModelGenerate: async () => { throw new Error("unused"); },
    arbitrate: async ({ rawCandidate }) => arbitration(rawCandidate.id),
  });
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.match(result.candidates.claude.textHash, /^[a-f0-9]{64}$/);
  assert.equal(result.candidates.claude.text, undefined);
});
