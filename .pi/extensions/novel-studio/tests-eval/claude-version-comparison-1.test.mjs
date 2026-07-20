/** Controlled Claude Opus 4.6 vs 4.8 comparison contract. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { compareClaudeVersions } from "../dist-eval/novelbench/writer-model-comparison.js";

const contract = {
  overallPlotDirection: ["trace the voice behind the locked door"],
  chapterFunction: ["advance the investigation"],
  previousState: ["the door is locked"],
  relevantCharacters: ["the investigator"],
  characterMotivations: ["the investigator: identify the speaker"],
  eventSummaries: ["the voice repeats heard memories"],
  mustInclude: ["test whether the voice can hear them"],
  stateChanges: ["both sides know they are detected"],
  foreshadowing: ["a second voice may exist"],
  causalRelations: ["testing the voice reveals awareness"],
  endingTarget: ["a second voice answers"],
  inviolableFacts: ["the door is locked"],
  stateConstraints: ["the speaker's identity remains unknown"],
  forbidReferenceLeakage: true,
  preserveEstablishedState: true,
};

function preview(version, options = {}) {
  const is48 = version === "claude48";
  const text = is48 ? "Claude 4.8 candidate text。" : "Claude 4.6 candidate text。";
  const requestedRoute = is48 ? "nb4_generate_claude48" : "v2_rawstage2";
  return {
    status: "ok",
    isPreviewRun: true,
    candidates: [{
      id: `candidate-${version}`,
      kind: "context_enhanced",
      text,
      route: "v2_rawstage2",
      model: is48 ? "claude-opus-4-8" : "claude-opus-4-6",
      contextHash: "same-context",
      metadata: {},
    }],
    stageResults: {
      commitAndSave: { skipped: true },
      rawFactGuard: { ok: options.factGuardOk ?? true, errors: options.errors ?? [] },
      chapterContract: contract,
      promptAdapter: { profile: "claude_writer_v1" },
      modelCalls: [{
        kind: "raw_chapter",
        route: "v2_rawstage2",
        requestedRoute,
        provider: "claude",
        actualProvider: "claude",
        model: is48 ? "claude-opus-4-8" : "claude-opus-4-6",
        actualModel: is48 ? "claude-opus-4-8" : "claude-opus-4-6",
        durationMs: is48 ? 40 : 70,
        finishReason: "stop",
      }],
    },
  };
}

function arbitration(selectedId) {
  const round = { degraded: false };
  return {
    firstRound: round,
    reverseRound: round,
    reverseReviewed: true,
    conflicted: false,
    finalSelectedCandidateId: selectedId,
    rounds: [round, round],
    auditSummary: "consistent",
  };
}

test("compares Claude 4.6 and 4.8 through isolated full previews", async () => {
  const calls = [];
  const result = await compareClaudeVersions({
    workspaceId: "claude-versions",
    chapterId: "1",
    chapterNumber: 1,
    runPreview: async (input) => {
      calls.push(input);
      return preview(input.modelTestRoute === "claude48" ? "claude48" : "claude");
    },
    judgeModelGenerate: async () => { throw new Error("unused"); },
    arbitrate: async () => arbitration("candidate-2"),
  });

  assert.equal(calls[0].writerModel, "claude");
  assert.equal(calls[0].modelTestRoute, undefined);
  assert.equal(calls[1].writerModel, undefined);
  assert.equal(calls[1].modelTestRoute, "claude48");
  assert.equal(result.winner, "claude48");
  assert.equal(result.candidates.claude.actualModel, "claude-opus-4-6");
  assert.equal(result.candidates.claude48.actualModel, "claude-opus-4-8");
  assert.equal(result.contractEqual, true);
  assert.equal(result.contextEqual, true);
  assert.equal(result.reverseConsistent, true);
});

test("FactGuard veto remains decisive without a judge call", async () => {
  let judgeCalls = 0;
  const result = await compareClaudeVersions({
    workspaceId: "claude-versions",
    chapterId: "2",
    chapterNumber: 2,
    runPreview: async (input) => preview(
      input.modelTestRoute === "claude48" ? "claude48" : "claude",
      input.modelTestRoute === "claude48" ? { factGuardOk: false, errors: ["bad fact"] } : {},
    ),
    judgeModelGenerate: async () => { judgeCalls += 1; throw new Error("must not run"); },
    arbitrate: async () => { judgeCalls += 1; throw new Error("must not run"); },
  });
  assert.equal(result.winner, "claude");
  assert.equal(result.decisionReason, "claude48_fact_guard_veto");
  assert.equal(judgeCalls, 0);
});

test("rejects Claude 4.8 telemetry that silently used 4.6", async () => {
  await assert.rejects(() => compareClaudeVersions({
    workspaceId: "claude-versions",
    chapterId: "3",
    chapterNumber: 3,
    runPreview: async (input) => {
      const output = preview(input.modelTestRoute === "claude48" ? "claude48" : "claude");
      if (input.modelTestRoute === "claude48") {
        output.stageResults.modelCalls[0].actualModel = "claude-opus-4-6";
      }
      return output;
    },
    judgeModelGenerate: async () => { throw new Error("must not run"); },
  }), /claude48.*model mismatch/i);
});
