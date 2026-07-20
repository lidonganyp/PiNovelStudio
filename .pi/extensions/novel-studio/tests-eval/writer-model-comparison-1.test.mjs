/** Controlled Claude/Gemini writer comparison. All model and pipeline calls are stubbed. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { compareWriterModels } from "../dist-eval/novelbench/writer-model-comparison.js";

const contract = {
  overallPlotDirection: ["失踪案逐步指向城内组织"],
  chapterFunction: ["迫使主角验证门后的异常"],
  previousState: ["安全门从内部反锁"],
  relevantCharacters: ["主角", "同伴"],
  characterMotivations: ["主角:确认门后身份"],
  eventSummaries: ["主角验证门后的声音"],
  mustInclude: ["安全门从内部反锁"],
  stateChanges: ["双方确认彼此敌意"],
  foreshadowing: ["失踪与旧案有关"],
  causalRelations: ["错误记忆暴露模仿者"],
  endingTarget: ["真正的同伴从楼梯口出现"],
  inviolableFacts: ["安全门从内部反锁"],
  stateConstraints: ["主角不知道门后的声音来自谁"],
  forbidReferenceLeakage: true,
  preserveEstablishedState: true,
};

function candidate(text, model, profile) {
  return {
    id: `raw-${model}`, kind: "context_enhanced", text, model, route: "v2_rawstage2",
    contextHash: "same-context", generatedAt: "2026-07-19T00:00:00.000Z",
    durationMs: model.startsWith("claude") ? 100 : 80,
    promptProfile: { type: "editorial", tokensIn: 100, containsDialogueRatio: false,
      containsParagraphLengthConstraint: false, containsControlChecklist: false,
      containsMechanicalMetric: false, contractIds: [] },
    promptAdapterProfile: profile,
  };
}

function preview(writerModel, options = {}) {
  const isClaude = writerModel === "claude";
  const requestedRoute = isClaude ? "v2_rawstage2" : "v2_rawstage2_gemini31";
  const actualProvider = isClaude ? "claude" : "gemini31";
  const actualModel = isClaude ? "claude-opus-4-6" : "gemini-3.1-pro-preview";
  const raw = candidate(
    isClaude ? "他抬手敲门，门后的呼吸停了。" : "他没有退，指节落在门上。门后忽然安静。",
    isClaude ? "claude-opus-4-6" : "gemini-3.1-pro-preview",
    isClaude ? "claude_writer_v1" : "gemini_writer_v1",
  );
  raw.model = "unified";
  raw.durationMs = 0;
  return { status: "ok", isPreviewRun: true, candidates: [raw], stageResults: {
    chapterContract: options.contract ?? contract,
    rawFactGuard: { ok: options.factGuardOk ?? true, errors: options.errors ?? [] },
    promptAdapter: { profile: raw.promptAdapterProfile },
    modelCalls: [{
      route: "v2_rawstage2",
      requestedRoute,
      kind: "raw_chapter",
      actualProvider,
      actualModel,
      finishReason: "stop",
      durationMs: isClaude ? 100 : 80,
      ts: Date.now(),
    }],
    commitAndSave: { skipped: true, reason: "fullPipelinePreview" },
  } };
}

function arbitration(winnerId, overrides = {}) {
  const round = (winnerCandidateId, degraded = false) => ({ winnerCandidateId, degraded });
  return { firstRound: round(winnerId, overrides.firstDegraded),
    reverseRound: round(winnerId, overrides.reverseDegraded),
    reverseReviewed: overrides.reverseReviewed ?? true, conflicted: overrides.conflicted ?? false,
    arbitrationTriggered: false, finalSelectedCandidateId: winnerId, rounds: [],
    selection: { selectedCandidateId: winnerId, reason: "stub", needsReverseReview: false },
    auditSummary: "stub", arbitrationRound: null };
}

test("runs both writers through full read-only preview and declares only a reverse-consistent winner", async () => {
  const calls = [];
  const sceneSolution = { id: "shared-scene", unknowns: ["门后身份"] };
  const result = await compareWriterModels({
    workspaceId: "comparison", chapterId: "1", chapterNumber: 1, seed: 17,
    sceneSolution,
    runPreview: async (input) => { calls.push(input); return preview(input.writerModel); },
    judgeModelGenerate: async () => { throw new Error("unused stub"); },
    arbitrate: async ({ editorialCandidate }) => arbitration(editorialCandidate.id),
  });
  assert.deepEqual(calls.map((call) => [call.writerModel, call.fullPipelinePreview]), [["claude", true], ["gemini31", true]]);
  assert.deepEqual(calls.map((call) => call.qualityExperiment), [
    { arm: "scene", sampleIndex: 1 },
    { arm: "scene", sampleIndex: 1 },
  ]);
  assert.deepEqual(calls.map((call) => call.sceneSolution), [sceneSolution, sceneSolution]);
  assert.equal(result.winner, "gemini31");
  assert.equal(result.strategy, "scene");
  assert.equal(result.sampleIndex, 1);
  assert.equal(result.reverseConsistent, true);
  assert.equal(result.contractEqual, true);
  assert.equal(result.contextEqual, true);
  assert.equal(result.candidates.claude.text, undefined, "report must not duplicate chapter prose");
  assert.equal(result.candidates.gemini31.promptProfile, "gemini_writer_v1");
  assert.equal(result.candidates.gemini31.requestedRoute, "v2_rawstage2_gemini31");
  assert.equal(result.candidates.gemini31.actualProvider, "gemini31");
  assert.equal(result.candidates.gemini31.actualModel, "gemini-3.1-pro-preview");
  assert.equal(result.candidates.gemini31.model, "gemini-3.1-pro-preview");
  assert.equal(result.candidates.gemini31.durationMs, 80);
  assert.equal(result.candidates.gemini31.finishReason, "stop");
});

test("FactGuard vetoes an invalid candidate without spending a judge call", async () => {
  let judgeCalls = 0;
  const result = await compareWriterModels({
    workspaceId: "comparison", chapterId: "2", chapterNumber: 2,
    runPreview: async ({ writerModel }) => preview(writerModel, writerModel === "gemini31" ? { factGuardOk: false, errors: ["unauthorized fact"] } : {}),
    judgeModelGenerate: async () => { judgeCalls += 1; throw new Error("must not run"); },
    arbitrate: async () => { judgeCalls += 1; throw new Error("must not run"); },
  });
  assert.equal(result.winner, "claude");
  assert.equal(result.decisionReason, "gemini_fact_guard_veto");
  assert.equal(judgeCalls, 0);
});

test("a blocked raw FactGuard preview remains a decisive model veto", async () => {
  let judgeCalls = 0;
  const result = await compareWriterModels({
    workspaceId: "comparison", chapterId: "2-blocked", chapterNumber: 1,
    runPreview: async ({ writerModel }) => {
      const output = preview(writerModel, writerModel === "gemini31"
        ? { factGuardOk: false, errors: ["fact guard veto"] }
        : {});
      if (writerModel === "gemini31") output.status = "blocked";
      if (writerModel === "gemini31") {
        const [raw] = output.candidates;
        output.isPreviewRun = false;
        delete output.stageResults.commitAndSave;
        output.stageResults.qualityExperimentRawCandidate = {
          id: raw.id,
          textHash: "f".repeat(64),
          characterCount: raw.text.length,
          contextHash: raw.contextHash,
          route: "v2_rawstage2",
        };
        output.candidates = [];
      }
      return output;
    },
    judgeModelGenerate: async () => { judgeCalls += 1; throw new Error("must not run"); },
    arbitrate: async () => { judgeCalls += 1; throw new Error("must not run"); },
  });
  assert.equal(result.winner, "claude");
  assert.equal(result.decisionReason, "gemini_fact_guard_veto");
  assert.equal(judgeCalls, 0);
});

test("the second writer still runs when the first writer is FactGuard-blocked", async () => {
  const calls = [];
  const result = await compareWriterModels({
    workspaceId: "comparison", chapterId: "2-first-blocked", chapterNumber: 1,
    runPreview: async ({ writerModel }) => {
      calls.push(writerModel);
      const output = preview(writerModel, writerModel === "claude"
        ? { factGuardOk: false, errors: ["fact guard veto"] }
        : {});
      if (writerModel === "claude") {
        const [raw] = output.candidates;
        output.status = "blocked";
        output.isPreviewRun = false;
        delete output.stageResults.commitAndSave;
        output.stageResults.qualityExperimentRawCandidate = {
          id: raw.id,
          textHash: "e".repeat(64),
          characterCount: raw.text.length,
          contextHash: raw.contextHash,
          route: "v2_rawstage2",
        };
        output.candidates = [];
      }
      return output;
    },
    judgeModelGenerate: async () => { throw new Error("must not run"); },
    arbitrate: async () => { throw new Error("must not run"); },
  });
  assert.deepEqual(calls, ["claude", "gemini31"]);
  assert.equal(result.winner, "gemini31");
  assert.equal(result.decisionReason, "claude_fact_guard_veto");
  assert.equal(result.candidates.claude.textHash, "e".repeat(64));
});

test("degraded, missing reverse, or conflicted adjudication never declares a model winner", async () => {
  for (const arb of [arbitration("candidate-gemini31", { firstDegraded: true }), arbitration("candidate-gemini31", { reverseReviewed: false }), arbitration("candidate-gemini31", { conflicted: true })]) {
    const result = await compareWriterModels({ workspaceId: "comparison", chapterId: "3", chapterNumber: 3,
      runPreview: async ({ writerModel }) => preview(writerModel),
      judgeModelGenerate: async () => { throw new Error("unused stub"); }, arbitrate: async () => arb });
    assert.equal(result.winner, null);
    assert.equal(result.reverseConsistent, false);
  }
});

test("mismatched ChapterContract fails closed before judging", async () => {
  await assert.rejects(compareWriterModels({ workspaceId: "comparison", chapterId: "4", chapterNumber: 4,
    runPreview: async ({ writerModel }) => preview(writerModel, writerModel === "gemini31" ? { contract: { ...contract, chapterFunction: ["different"] } } : {}),
    judgeModelGenerate: async () => { throw new Error("must not run"); }, arbitrate: async () => { throw new Error("must not run"); } }), /ChapterContract mismatch/);
});

test("missing or wrong production route telemetry fails closed", async () => {
  await assert.rejects(compareWriterModels({
    workspaceId: "comparison", chapterId: "5", chapterNumber: 5,
    runPreview: async ({ writerModel }) => {
      const output = preview(writerModel);
      if (writerModel === "gemini31") output.stageResults.modelCalls = [];
      return output;
    },
    judgeModelGenerate: async () => { throw new Error("must not run"); },
    arbitrate: async () => { throw new Error("must not run"); },
  }), /Gemini.*telemetry|gemini31.*telemetry/i);

  await assert.rejects(compareWriterModels({
    workspaceId: "comparison", chapterId: "6", chapterNumber: 6,
    runPreview: async ({ writerModel }) => {
      const output = preview(writerModel);
      if (writerModel === "gemini31") {
        output.stageResults.modelCalls[0].actualProvider = "claude";
      }
      return output;
    },
    judgeModelGenerate: async () => { throw new Error("must not run"); },
    arbitrate: async () => { throw new Error("must not run"); },
  }), /provider mismatch/i);
});

test("serialized comparison report contains hashes, never prose-bearing diagnostics", async () => {
  const leakedSpan = "LEAKED_PROSE_SPAN_7f2b";
  const result = await compareWriterModels({
    workspaceId: "comparison", chapterId: "7", chapterNumber: 7,
    runPreview: async ({ writerModel }) => preview(writerModel, writerModel === "gemini31"
      ? { factGuardOk: false, errors: [`unauthorized fact: ${leakedSpan}`] }
      : {}),
    judgeModelGenerate: async () => { throw new Error("must not run"); },
    arbitrate: async () => { throw new Error("must not run"); },
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(leakedSpan), false);
  assert.equal(result.candidates.gemini31.factGuardErrorCount, 1);
  assert.equal(Array.isArray(result.candidates.gemini31.factGuardErrorHashes), true);
  assert.equal(result.candidates.gemini31.factGuardErrors, undefined);
});
