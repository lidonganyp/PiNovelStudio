/** Fixed scene-solution admission is retired from production. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  generatePositiveGainCandidates,
  POSITIVE_GAIN_PRODUCTION_ADMISSION,
} from "../dist-test/v2/core/positive-gain-candidate-generator.js";
import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";

const baseInput = {
  workspaceId: "xinmo",
  chapterId: "ch18",
  chapterNumber: 18,
  projectRoot: process.cwd(),
  intent: {
    chapterFunction: "推进当前冲突",
    readerExperience: [],
    currentPressure: [],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["李一凡"],
    inviolableFacts: ["门锁只能从室内打开"],
    sourceRefs: ["seed:ch18"],
  },
  context: {
    facts: [{ id: "fact:door", content: "门锁只能从室内打开", sourceIds: ["seed:ch18"], kind: "fact" }],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
  },
  constitution: null,
  characterNames: ["李一凡"],
};

test("fixed scene admission metadata is historical only", () => {
  assert.equal(POSITIVE_GAIN_PRODUCTION_ADMISSION.strictAdmissionStatus, "retired_from_production");
  assert.equal(POSITIVE_GAIN_PRODUCTION_ADMISSION.deploymentPolicy, "historical_evidence_only_no_global_extrapolation");
});

test("retired scene generator performs no model calls and preserves raw", async () => {
  let calls = 0;
  const result = await generatePositiveGainCandidates({
    input: {
      ...baseInput,
      modelGenerate: async () => {
        calls += 1;
        return { text: "unexpected", model: "stub", route: "stub", durationMs: 1 };
      },
    },
    promptPatternResolution: { promptBlock: "", patternIds: [], trace: { libraryStatus: "missing", mode: "production", discovered: [], selected: [], dropped: [], errors: [] } },
    candidateLimit: 2,
  });

  assert.equal(calls, 0);
  assert.equal(result.status, "fallback_raw");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.trace.failureReason, "global_scene_candidate_admission_retired");
  assert.equal(result.trace.rawBaselineMutated, false);
});

test("orchestrator preserves raw when the chapter has no span-supported opportunity", async () => {
  const orchestrator = createUnifiedOrchestrator();
  const result = await orchestrator.orchestrate({
    ...baseInput,
    allowAutomaticLiterarySelection: false,
    modelGenerate: async (request) => {
      if (request.kind === "raw_chapter") {
        return { text: "完整 raw 正文。", model: "stub", route: request.route, durationMs: 1 };
      }
      return { text: JSON.stringify({ hypotheses: [], noOpReason: "无 span 机会" }), model: "stub", route: request.route, durationMs: 1 };
    },
  });

  assert.equal(result.selectedSource, "raw");
  assert.equal(result.text, "完整 raw 正文。");
  assert.equal(result.stageResults.positiveGainCandidates.status, "retired_from_production");
});
