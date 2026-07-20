/**
 * PROMPT-PATTERN-ADMISSION-1: source-backed prompt patterns remain bounded,
 * reference-free, and inactive until production admission.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { buildRawPrompt } from "../dist/v2/core/orchestrator-raw.js";
import {
  loadPromptPatternLibrary,
  resolvePromptPatternLibrary,
  validatePromptPatternLibrary,
} from "../dist-test/v2/core/prompt-pattern-library.js";

const source = {
  sourceId: "github:example",
  url: "https://github.com/example/novel-prompts",
  accessedAt: "2026-07-19",
  sourceType: "repository_prompt",
  license: "MIT",
  evidenceConfidence: "high",
};

const experimentSource = {
  sourceId: "experiment:validation-xinmo-15",
  url: "reports/novel-quality-ceiling-20260719/validation-xinmo-15/final-admission.json",
  accessedAt: "2026-07-19",
  sourceType: "experiment_report",
  license: "project internal evaluation artifact",
  evidenceConfidence: "high",
};

function pattern(overrides = {}) {
  return {
    id: "decision_evidence_cost_delta",
    status: "candidate",
    title: "选择、验证、代价与状态变化",
    guidance: "让主角基于可观察证据作出选择，并让验证结果改变后续行动。",
    requiredMoves: ["行动产生新证据", "选择带来代价", "场景结束时至少一种叙事状态改变"],
    avoidPatterns: ["用身体反应代替异常证据", "异常出现后立即解释完整机制"],
    sources: [source],
    admission: {
      sampleSize: 1,
      validatedWinRate: null,
      reason: "单章 A/B/C 正收益，只能进入 candidate。",
    },
    ...overrides,
  };
}

function library(patterns) {
  return {
    schemaVersion: "1.0.0",
    updatedAt: "2026-07-19",
    patterns,
  };
}

const baseInput = {
  workspaceId: "xinmo",
  chapterId: "18",
  chapterNumber: 18,
  projectRoot: process.cwd(),
  intent: {
    chapterFunction: "推进原创项目现有冲突",
    readerExperience: ["规则型恐怖"],
    currentPressure: ["前章承诺必须兑现"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["李一凡"],
    inviolableFacts: [],
    sourceRefs: ["chapter-seed"],
  },
  context: {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
  },
  characterNames: ["李一凡"],
};

test("PROMPT-PATTERN-ADMISSION-1 production discovers candidate patterns without consuming them", () => {
  const resolution = resolvePromptPatternLibrary({
    library: library([pattern()]),
    mode: "production",
  });

  assert.equal(resolution.promptBlock, "");
  assert.deepEqual(resolution.patternIds, []);
  assert.deepEqual(resolution.trace.discovered.map((entry) => entry.id), ["decision_evidence_cost_delta"]);
  assert.deepEqual(resolution.trace.selected, []);
  assert.equal(resolution.trace.dropped[0].reason, "status_not_active");

  const ordinary = buildRawPrompt(baseInput);
  const withCandidates = buildRawPrompt({ ...baseInput, promptPatternResolution: resolution });
  assert.equal(withCandidates.userPrompt, ordinary.userPrompt);
  assert.equal(withCandidates.consumedFields.includes("promptPatterns"), false);
});

test("PROMPT-PATTERN-ADMISSION-1 production records active patterns without injecting raw", () => {
  const resolution = resolvePromptPatternLibrary({
    library: library([
      pattern({ id: "candidate_only" }),
      pattern({
        id: "active_information_ownership",
        status: "active",
        guidance: "明确各角色掌握、误判和仍不知道的信息，让信息变化影响选择。",
        sources: [source, experimentSource],
        admission: { sampleSize: 15, validatedWinRate: 0.6, reason: "冻结验证集与人工盲评通过。" },
      }),
    ]),
    mode: "production",
  });

  assert.deepEqual(resolution.patternIds, ["active_information_ownership"]);
  assert.match(resolution.promptBlock, /信息变化影响选择/);
  assert.doesNotMatch(resolution.promptBlock, /github\.com/);

  const output = buildRawPrompt({ ...baseInput, promptPatternResolution: resolution });
  assert.equal(output.consumedFields.includes("promptPatterns"), false);
  assert.doesNotMatch(output.userPrompt, /经生产准入的叙事决策/);
  assert.doesNotMatch(output.userPrompt, /信息变化影响选择/);
  assert.doesNotMatch(output.userPrompt, /active_information_ownership/);
});

test("PROMPT-PATTERN-ADMISSION-1 active status requires minimum validation evidence", () => {
  const underverified = validatePromptPatternLibrary(library([
    pattern({
      status: "active",
      admission: { sampleSize: 1, validatedWinRate: null, reason: "single pilot only" },
    }),
  ]));
  assert.equal(underverified.valid, false);
  assert.ok(underverified.errors.some((error) => error.includes("active_without_admission_evidence")));

  const tooFewCases = validatePromptPatternLibrary(library([pattern({
    status: "active",
    admission: { sampleSize: 7, validatedWinRate: 0.9, reason: "high win rate but too few complete cases" },
  })]));
  assert.equal(tooFewCases.valid, false);
  assert.ok(tooFewCases.errors.some((error) => error.includes("active_without_admission_evidence")));

  const noExperimentProvenance = validatePromptPatternLibrary(library([pattern({
    status: "active",
    sources: [source],
    admission: { sampleSize: 8, validatedWinRate: 0.875, reason: "manual active flag without experiment provenance" },
  })]));
  assert.equal(noExperimentProvenance.valid, false);
  assert.ok(noExperimentProvenance.errors.some((error) => error.includes("active_without_experiment_provenance")));
});

test("PROMPT-PATTERN-ADMISSION-1 controlled evaluation may explicitly activate candidates", () => {
  const resolution = resolvePromptPatternLibrary({
    library: library([pattern(), pattern({ id: "unselected_candidate" })]),
    mode: "evaluation",
    explicitPatternIds: ["decision_evidence_cost_delta"],
  });

  assert.deepEqual(resolution.patternIds, ["decision_evidence_cost_delta"]);
  assert.equal(resolution.trace.selected[0].reason, "explicit_evaluation_activation");
  assert.equal(resolution.trace.dropped[0].reason, "not_explicitly_selected_for_evaluation");
});

test("PROMPT-PATTERN-ADMISSION-1 rejects imitation, reference leakage, and mechanical quotas", () => {
  const invalid = library([
    pattern({ id: "imitate_author", guidance: "模仿《神秘复苏》和作者佛前献花的句式。" }),
    pattern({ id: "fixed_quota", requiredMoves: ["每章必须三次反转", "对白比例达到 40%"] }),
  ]);
  const validation = validatePromptPatternLibrary(invalid);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("reference_or_imitation")));
  assert.ok(validation.errors.some((error) => error.includes("mechanical_quota")));
});

test("PROMPT-PATTERN-ADMISSION-1 invalid or missing library safely falls back to ordinary raw", () => {
  const missing = resolvePromptPatternLibrary({ library: null, mode: "production" });
  assert.equal(missing.trace.libraryStatus, "missing");
  assert.equal(missing.promptBlock, "");

  const invalid = resolvePromptPatternLibrary({
    library: library([pattern({ guidance: "模仿杨间的鬼眼叙事。" })]),
    mode: "production",
  });
  assert.equal(invalid.trace.libraryStatus, "invalid");
  assert.equal(invalid.promptBlock, "");

  const ordinary = buildRawPrompt(baseInput);
  assert.equal(buildRawPrompt({ ...baseInput, promptPatternResolution: missing }).userPrompt, ordinary.userPrompt);
  assert.equal(buildRawPrompt({ ...baseInput, promptPatternResolution: invalid }).userPrompt, ordinary.userPrompt);
});

test("PROMPT-PATTERN-ADMISSION-1 missing project root safely falls back for legacy callers", () => {
  const resolution = loadPromptPatternLibrary(undefined, { mode: "production" });
  assert.equal(resolution.trace.libraryStatus, "missing");
  assert.equal(resolution.promptBlock, "");
  assert.deepEqual(resolution.patternIds, []);
});

test("PROMPT-PATTERN-ADMISSION-1 keeps the non-incremental C bundle dormant", () => {
  const filePath = resolve(process.cwd(), "../../..", "data/runtime/prompt-pattern-library.json");
  const checkedIn = JSON.parse(readFileSync(filePath, "utf8"));
  const validation = validatePromptPatternLibrary(checkedIn);
  const production = resolvePromptPatternLibrary({ library: checkedIn, mode: "production" });

  assert.deepEqual(validation, { valid: true, errors: [] });
  assert.ok(checkedIn.patterns.length >= 6);
  assert.deepEqual(production.patternIds, []);
  assert.equal(checkedIn.patterns.filter((entry) => entry.status === "active").length, 0);
  assert.equal(checkedIn.patterns.filter((entry) => [
    "scene_decision_evidence_cost_delta",
    "information_ownership_and_unknowns",
    "preserve_explanatory_gap",
    "causal_ending_pressure",
  ].includes(entry.id)).every((entry) => entry.status === "dormant"), true);
});

test("PROMPT-PATTERN-ADMISSION-1 orchestrator records selection as trace-only before raw failure", async () => {
  const { UnifiedOrchestrator } = await import("../dist/v2/core/unified-orchestrator.js");
  const resolution = resolvePromptPatternLibrary({
    library: library([pattern({ status: "active", sources: [source, experimentSource], admission: {
      sampleSize: 15,
      validatedWinRate: 0.6,
      reason: "test fixture admission",
    } })]),
    mode: "production",
  });
  const orchestrator = new UnifiedOrchestrator();
  const result = await orchestrator.orchestrate({
    ...baseInput,
    projectRoot: resolve(process.cwd(), "../../.."),
    modelGenerate: async () => {
      throw new Error("intentional raw failure");
    },
    promptPatternResolution: resolution,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.failureEnvelope?.stage, "raw_generation");
  assert.deepEqual(result.stageResults.promptPatterns.patternIds, ["decision_evidence_cost_delta"]);
  assert.equal(result.stageResults.promptPatterns.consumedByRawPrompt, false);
  assert.equal(result.stageResults.promptPatterns.selected[0].reason, "status_active");
});
