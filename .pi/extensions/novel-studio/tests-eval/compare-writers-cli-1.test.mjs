/** Gemini/Claude comparison CLI lifecycle and sanitized aggregation tests. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  assertWorkspaceUnchanged,
  buildAggregateReport,
  buildPairAggregateReport,
  buildFailedComparison,
  createComparisonWorkspace,
  removeComparisonWorkspace,
  resolveWriterComparisonMode,
  resolveSearchDepthWriter,
  resolveReaderJudge,
  snapshotWorkspace,
  buildJudgeRetryOptions,
  aggregateBoundedBestOf3,
  completedComparisonKeys,
  createStrictJudgeGenerate,
  comparisonErrorRequiresProcessRestart,
  prepareResumeComparisons,
  resolveComparisonPreviewTimeoutMs,
  summarizeBoundedBestOf3Preview,
  loadComparisonCheckpoint,
  saveComparisonCheckpoint,
  withHardTimeout,
  extractVerifiedPreviewText,
} from "../../../../scripts/novelbench/compare-writers-lib.mjs";
import { validateConstitution } from "../dist-eval/v2/core/creative-constitution.js";

const scene = {
  id: "suspense",
  title: "都市异常调查",
  genre: "悬疑",
  subGenres: ["都市异常"],
  protagonist: { id: "lin-mo", name: "林默", profile: "异常调查员，克制而警觉。" },
  supporting: { id: "xu-lan", name: "许岚", profile: "现场联络员，说话简短，隐瞒了一段经历。" },
  immutableFacts: ["安全门从内部反锁", "异常无法知道从未被说出的记忆"],
  outline: "林默在楼道里验证门后模仿许岚的声音。",
  choice: "用一段虚假记忆试探门后的声音",
  cost: "模仿者会知道林默已经识破它",
  irreversibleChange: "双方从互相隐藏变成确认敌意",
  endingPressure: "真正的许岚从楼梯口出现",
};

function fakeComparison(winner, chapterId) {
  const candidate = (model, provider) => ({
    model, route: "v2_rawstage2", promptProfile: `${provider}_writer_v1`, textHash: "a".repeat(64),
    characterCount: 3000, durationMs: 100, factGuardPassed: true, factGuardErrorCount: 0,
    factGuardErrorHashes: [], requestedRoute: provider === "gemini31" ? "v2_rawstage2_gemini31" : "v2_rawstage2",
    actualProvider: provider, actualModel: model, finishReason: "stop",
  });
  return {
    schemaVersion: 1, workspaceId: `ws-${chapterId}`, chapterId, chapterNumber: 1, seed: 17,
    winner, decisionReason: winner ? "reverse_consistent_judge_winner" : "no_clear_reverse_consistent_winner",
    contractEqual: true, contextEqual: true, reverseConsistent: winner !== null,
    candidates: {
      claude: candidate("claude-opus-4-6", "claude"),
      gemini31: candidate("gemini-3.1-pro-preview", "gemini31"),
    },
    judge: { route: "v2_literary_judge", reverseReviewed: true, conflicted: false, degraded: false, roundCount: 2, auditSummaryHash: null },
    admission: { sampleCount: 1, requiredSampleCount: 3, requiredWinRate: 0.55, defaultSwitchEligible: false },
  };
}

test("temporary comparison workspace stays inside workspaces and is safely removable", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-writer-compare-"));
  const created = createComparisonWorkspace({ projectRoot, runId: "run-1", scene });
  assert.equal(created.workspacePath.startsWith(resolve(projectRoot, "workspaces") + "\\"), true);
  assert.equal(existsSync(join(created.workspacePath, "config.json")), true);
  assert.match(readFileSync(join(created.workspacePath, "characters", "林默.md"), "utf8"), /林默/);
  const constitution = JSON.parse(readFileSync(join(created.workspacePath, "creative-constitution.json"), "utf8"));
  assert.deepEqual(validateConstitution(constitution), { ok: true, errors: [] });
  removeComparisonWorkspace({ projectRoot, workspacePath: created.workspacePath });
  assert.equal(existsSync(created.workspacePath), false);
  assert.throws(() => removeComparisonWorkspace({ projectRoot, workspacePath: projectRoot }), /outside|workspaces/i);
});

test("workspace snapshot detects any preview side effect", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-writer-compare-"));
  const created = createComparisonWorkspace({ projectRoot, runId: "run-2", scene });
  const before = snapshotWorkspace(created.workspacePath);
  assertWorkspaceUnchanged(before, snapshotWorkspace(created.workspacePath));
  writeFileSync(join(created.workspacePath, "unexpected.txt"), "mutation", "utf8");
  assert.throws(
    () => assertWorkspaceUnchanged(before, snapshotWorkspace(created.workspacePath)),
    /mutated.*unexpected\.txt/i,
  );
  removeComparisonWorkspace({ projectRoot, workspacePath: created.workspacePath });
});

test("failed comparison retains only safe workspace mutation paths", () => {
  let mutationError;
  try {
    assertWorkspaceUnchanged(
      { "config.json": "SECRET_OLD_PAYLOAD" },
      { "config.json": "SECRET_NEW_PAYLOAD", "traces/new-report.json": "SECRET_REPORT_HASH" },
    );
  } catch (error) {
    mutationError = error;
  }
  const failed = buildFailedComparison({
    sceneId: "suspense",
    workspaceId: "workspace",
    chapterId: "1",
    chapterNumber: 1,
    error: mutationError,
    previewSummaries: {},
  });
  assert.deepEqual(failed.workspaceMutationPaths, ["config.json", "traces/new-report.json"]);
  assert.equal(JSON.stringify(failed).includes("SECRET_OLD_PAYLOAD"), false);
  assert.equal(JSON.stringify(failed).includes("SECRET_NEW_PAYLOAD"), false);
});

test("machine judge threshold cannot recommend a default without a passing human-alignment gate", () => {
  const report = buildAggregateReport({
    runId: "run-3",
    comparisons: [fakeComparison("gemini31", "a"), fakeComparison("gemini31", "b"), fakeComparison("claude", "c")],
  });
  assert.equal(report.admission.controlledSampleCount, 3);
  assert.equal(report.admission.decisiveSampleCount, 3);
  assert.equal(report.admission.geminiWinRate, 2 / 3);
  assert.equal(report.admission.modelJudgeThresholdMet, true);
  assert.equal(report.admission.humanAlignmentGatePassed, false);
  assert.equal(report.admission.thresholdMet, false);
  assert.equal(report.admission.recommendedDefault, null);
  assert.equal(report.admission.qualityConclusion, "human_alignment_required");
  assert.equal(report.admission.defaultSwitchApplied, false);
  assert.equal(report.admission.currentDefault, "claude");
  assert.match(report.admission.decision, /人工|human/i);
  assert.equal(JSON.stringify(report).includes("chapter prose"), false);

  const humanAligned = buildAggregateReport({
    runId: "run-3-human-aligned",
    comparisons: [fakeComparison("gemini31", "a"), fakeComparison("gemini31", "b"), fakeComparison("claude", "c")],
    humanAlignment: {
      passed: true,
      totalEntries: 3,
      userChoiceAgreement: 0.8,
      reverseConsistency: 1,
      systematicReverseBias: false,
    },
  });
  assert.equal(humanAligned.admission.modelJudgeThresholdMet, true);
  assert.equal(humanAligned.admission.humanAlignmentGatePassed, true);
  assert.equal(humanAligned.admission.thresholdMet, true);
  assert.equal(humanAligned.admission.recommendedDefault, "gemini31");
  assert.equal(humanAligned.admission.qualityConclusion, "challenger_eligible_for_review");

  const inconclusive = buildAggregateReport({
    runId: "run-4",
    comparisons: [fakeComparison("gemini31", "a"), fakeComparison(null, "b"), fakeComparison("claude", "c")],
  });
  assert.equal(inconclusive.admission.decisiveSampleCount, 2);
  assert.equal(inconclusive.admission.thresholdMet, false);
});

test("failed preview summaries are sanitized and excluded from controlled samples", () => {
  const leakedReason = "LEAKED_CHAPTER_SPAN_f192";
  const failed = buildFailedComparison({
    sceneId: "relationship-cost",
    workspaceId: "ws-failed",
    chapterId: "1",
    chapterNumber: 1,
    error: new Error(`gemini31 preview failed: ${leakedReason}`),
    previewSummaries: {
      gemini31: {
        status: "blocked",
        stage: "raw_fact_guard",
        gate: "text_integrity",
        reason: leakedReason,
        modelCalls: [{ actualProvider: "gemini31", actualModel: "gemini-3.1-pro-preview", durationMs: 80 }],
      },
    },
  });
  const serialized = JSON.stringify(failed);
  assert.equal(serialized.includes(leakedReason), false);
  assert.equal(failed.winner, null);
  assert.equal(failed.controlled, false);
  assert.equal(failed.previewFailures.gemini31.stage, "raw_fact_guard");
  assert.match(failed.previewFailures.gemini31.reasonHash, /^[a-f0-9]{64}$/);

  const report = buildAggregateReport({ runId: "failed-run", comparisons: [failed] });
  assert.equal(report.admission.controlledSampleCount, 0);
  assert.equal(report.admission.decisiveSampleCount, 0);
});

test("aggregate report keeps model admissions isolated by strategy", () => {
  const comparisons = [
    { ...fakeComparison("gemini31", "raw-1"), strategy: "raw", sampleIndex: 1 },
    { ...fakeComparison("gemini31", "raw-2"), strategy: "raw", sampleIndex: 2 },
    { ...fakeComparison("claude", "oracle-1"), strategy: "oracle_scene", sampleIndex: 1 },
  ];
  const report = buildAggregateReport({ runId: "strategy-run", comparisons });

  assert.equal(report.strategyAdmissions.raw.geminiWins, 2);
  assert.equal(report.strategyAdmissions.raw.claudeWins, 0);
  assert.equal(report.strategyAdmissions.oracle_scene.claudeWins, 1);
  assert.equal(report.strategyAdmissions.oracle_scene.geminiWins, 0);
  assert.equal(report.admission.defaultSwitchApplied, false);
});

test("long writer comparisons checkpoint atomically and resume by stable comparison identity", () => {
  const root = mkdtempSync(join(tmpdir(), "pinovel-writer-checkpoint-"));
  const checkpointPath = join(root, "comparison-report.partial.json");
  const first = { ...fakeComparison("claude", "chapter-1"), sceneId: "suspense", strategy: "raw", sampleIndex: 1 };
  const second = { ...fakeComparison("gemini31", "chapter-2"), sceneId: "suspense", strategy: "raw", sampleIndex: 2 };

  const partial = saveComparisonCheckpoint({
    checkpointPath,
    runId: "resume-run",
    comparisons: [first],
    connectivity: { ok: true },
    expectedComparisonCount: 2,
    complete: false,
  });
  assert.equal(partial.lifecycle.status, "partial");
  assert.equal(partial.lifecycle.completedComparisonCount, 1);
  assert.equal(existsSync(checkpointPath), true);
  assert.equal(existsSync(`${checkpointPath}.tmp`), false);

  const loaded = loadComparisonCheckpoint({
    checkpointPath,
    runId: "resume-run",
    expectedComparisonCount: 2,
  });
  assert.deepEqual([...completedComparisonKeys(loaded.comparisons)], ["suspense:raw:1"]);

  const complete = saveComparisonCheckpoint({
    checkpointPath,
    runId: "resume-run",
    comparisons: [...loaded.comparisons, second],
    connectivity: loaded.connectivity,
    expectedComparisonCount: 2,
    complete: true,
  });
  assert.equal(complete.lifecycle.status, "complete");
  assert.equal(complete.lifecycle.completedComparisonCount, 2);
});

test("resume retries hard-timeout placeholders instead of treating them as completed", () => {
  const completed = {
    ...fakeComparison("claude", "chapter-1"),
    sceneId: "suspense",
    strategy: "production_final",
    sampleIndex: 1,
  };
  const retryable = {
    sceneId: "relationship-cost",
    strategy: "production_final",
    sampleIndex: 2,
    winner: null,
    controlled: false,
    decisionReason: "preview_failed",
    retryRequired: true,
  };

  assert.deepEqual(prepareResumeComparisons([completed, retryable]), [completed]);
  assert.deepEqual([...completedComparisonKeys(prepareResumeComparisons([completed, retryable]))], [
    "suspense:production_final:1",
  ]);
});

test("production-final previews receive a larger default wall-clock budget", () => {
  assert.equal(resolveComparisonPreviewTimeoutMs("raw_isolated"), 480_000);
  assert.equal(resolveComparisonPreviewTimeoutMs("production_final"), 1_200_000);
  assert.equal(resolveComparisonPreviewTimeoutMs("production_final", "900000"), 900_000);
  assert.throws(() => resolveComparisonPreviewTimeoutMs("production_final", "0"), /positive/i);
});

test("comparison checkpoint rejects wrong runs, duplicate identities, and premature completion", () => {
  const root = mkdtempSync(join(tmpdir(), "pinovel-writer-checkpoint-"));
  const checkpointPath = join(root, "comparison-report.partial.json");
  const comparison = { ...fakeComparison("claude", "chapter-1"), sceneId: "suspense", strategy: "raw", sampleIndex: 1 };
  saveComparisonCheckpoint({
    checkpointPath,
    runId: "strict-run",
    comparisons: [comparison],
    connectivity: null,
    expectedComparisonCount: 2,
    complete: false,
  });

  assert.throws(() => loadComparisonCheckpoint({
    checkpointPath,
    runId: "other-run",
    expectedComparisonCount: 2,
  }), /runId mismatch/i);
  assert.throws(() => saveComparisonCheckpoint({
    checkpointPath,
    runId: "strict-run",
    comparisons: [comparison, structuredClone(comparison)],
    connectivity: null,
    expectedComparisonCount: 2,
    complete: true,
  }), /duplicate comparison identity/i);
  assert.throws(() => saveComparisonCheckpoint({
    checkpointPath,
    runId: "strict-run",
    comparisons: [comparison],
    connectivity: null,
    expectedComparisonCount: 2,
    complete: true,
  }), /cannot complete/i);
});

test("checkpoint accepts a challenger-specific report builder without default-switch semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "pinovel-writer-checkpoint-"));
  const checkpointPath = join(root, "comparison-report.partial.json");
  const comparison = {
    ...fakeComparison("gemini31", "chapter-1"),
    sceneId: "suspense",
    strategy: "production_final",
    sampleIndex: 1,
  };
  let received;
  const report = saveComparisonCheckpoint({
    checkpointPath,
    runId: "challenger-run",
    comparisons: [comparison],
    connectivity: { ok: true },
    expectedComparisonCount: 1,
    complete: true,
    reportBuilder: (input) => {
      received = input;
      return {
        schemaVersion: 1,
        runId: input.runId,
        connectivity: input.connectivity,
        comparisons: input.comparisons,
        challengerAdmission: { anySceneAdmitted: false },
      };
    },
  });

  assert.equal(received.runId, "challenger-run");
  assert.equal(received.comparisons.length, 1);
  assert.deepEqual(report.challengerAdmission, { anySceneAdmitted: false });
  assert.equal(report.admission, undefined);
  assert.equal(report.lifecycle.status, "complete");
});

test("CLI comparison mode defaults to raw isolation and explicitly enables production-final", () => {
  assert.equal(resolveWriterComparisonMode([]), "raw_isolated");
  assert.equal(resolveWriterComparisonMode(["--mode=production_final"]), "production_final");
  assert.equal(resolveWriterComparisonMode(["--mode=search_depth"]), "search_depth");
  assert.throws(() => resolveWriterComparisonMode(["--mode=unknown"]), /mode/i);

  const script = readFileSync(resolve(process.cwd(), "../../../scripts/novelbench/compare-writers.mjs"), "utf8");
  assert.match(script, /compareProductionFinalChallenger/);
  assert.match(script, /production-final-challenger/);
  assert.match(script, /reportBuilder/);
});

test("search-depth defaults to Gemini and keeps Claude as an explicit comparison writer", () => {
  assert.deepEqual(resolveSearchDepthWriter([]), {
    writerModel: "gemini31",
    provider: "gemini31",
    model: "gemini-3.1-pro-preview",
    reportGroup: "gemini-bounded-best-of3",
  });
  assert.deepEqual(resolveSearchDepthWriter(["--writer=claude"]), {
    writerModel: "claude",
    provider: "claude",
    model: "claude-opus-4-6",
    reportGroup: "claude-bounded-best-of3",
  });
  assert.throws(() => resolveSearchDepthWriter(["--writer=unknown"]), /writer/i);
});

test("saved-pair rejudge can isolate GPT and Gemini reader judges", () => {
  assert.deepEqual(resolveReaderJudge([]), {
    id: "gpt56",
    route: "v2_literary_judge",
    provider: "gpt",
    model: "gpt-5.6-sol",
    strictSchema: true,
  });
  assert.deepEqual(resolveReaderJudge(["--judge=gemini31"]), {
    id: "gemini31-reader",
    route: "v2_reader_experience_judge_gemini31",
    provider: "gemini31",
    model: "gemini-3.1-pro-preview",
    strictSchema: false,
  });
  assert.throws(() => resolveReaderJudge(["--judge=unknown"]), /judge/i);
});

test("bounded best-of-3 preview reports when the second distinct scene candidate wins", () => {
  const candidate = (id, text, kind = "scene_contract") => ({
    id,
    kind,
    text,
    model: "claude-opus-4-6",
    route: "v2_rawstage2",
    contextHash: "same-context",
    generatedAt: "2026-07-20T00:00:00.000Z",
    durationMs: 1,
    promptProfile: { type: "editorial", tokensIn: 1, containsDialogueRatio: false, containsParagraphLengthConstraint: false, containsControlChecklist: false, containsMechanicalMetric: false, contractIds: [] },
  });
  const output = {
    status: "ok",
    isPreviewRun: true,
    text: "SECOND_SCENE_PROSE_MUST_NOT_LEAK",
    selectedSource: "editorial",
    selectedCandidateId: "scene-2",
    candidates: [
      candidate("raw", "RAW_PROSE_MUST_NOT_LEAK", "context_enhanced"),
      candidate("scene-1", "FIRST_SCENE_PROSE_MUST_NOT_LEAK"),
      candidate("scene-2", "SECOND_SCENE_PROSE_MUST_NOT_LEAK"),
    ],
    stageResults: {
      rawFactGuard: { ok: true, errors: [] },
      finalFactRecheck: { passed: true, errors: [] },
      finalTextCompleteness: { passed: true, findings: [] },
      positiveGainCandidates: { status: "generated", selectedSceneIds: ["s1", "s2"], candidateFailures: [] },
      commitAndSave: { skipped: true },
      modelCalls: [{ kind: "raw_chapter", route: "v2_rawstage2", actualProvider: "claude", actualModel: "claude-opus-4-6" }],
    },
  };

  const summary = summarizeBoundedBestOf3Preview(output);
  assert.equal(summary.controlled, true);
  assert.equal(summary.candidateCount, 3);
  assert.equal(summary.selectedCandidateIndex, 2);
  assert.equal(summary.secondSceneCandidateSelected, true);
  assert.deepEqual(summary.selectedSceneIds, ["s1", "s2"]);
  assert.equal(JSON.stringify(summary).includes("PROSE_MUST_NOT_LEAK"), false);
  assert.match(summary.selectedTextHash, /^[a-f0-9]{64}$/);
});

test("bounded best-of-3 admission remains diagnostic until repeated second-candidate wins", () => {
  const result = aggregateBoundedBestOf3([
    { controlled: true, finalGatePassed: true, secondSceneCandidateSelected: true },
    { controlled: true, finalGatePassed: true, secondSceneCandidateSelected: true },
    { controlled: true, finalGatePassed: true, secondSceneCandidateSelected: false },
  ]);
  assert.equal(result.controlledComparisons, 3);
  assert.equal(result.secondCandidateWins, 2);
  assert.equal(result.repeatedIncrementalGain, true);
  assert.equal(result.productionApplied, false);
});

test("generic pair aggregate evaluates Claude 4.8 without Gemini-specific fields", () => {
  const comparisons = [
    { ...fakeComparison("claude", "a"), winner: "claude48" },
    { ...fakeComparison("claude", "b"), winner: "claude48" },
    { ...fakeComparison("claude", "c"), winner: "claude" },
  ];
  const report = buildPairAggregateReport({
    runId: "claude-versions",
    pairId: "claude48-vs-claude46",
    baselineId: "claude",
    challengerId: "claude48",
    comparisons,
  });
  assert.equal(report.admission.controlledSampleCount, 3);
  assert.equal(report.admission.decisiveSampleCount, 3);
  assert.equal(report.admission.baselineWins, 1);
  assert.equal(report.admission.challengerWins, 2);
  assert.equal(report.admission.challengerWinRate, 2 / 3);
  assert.equal(report.admission.modelJudgeThresholdMet, true);
  assert.equal(report.admission.humanAlignmentGatePassed, false);
  assert.equal(report.admission.thresholdMet, false);
  assert.equal(report.admission.recommendedDefault, null);
  assert.equal(report.admission.qualityConclusion, "human_alignment_required");
  assert.equal(report.admission.defaultSwitchApplied, false);
  assert.equal(report.admission.geminiWins, undefined);

  const humanAligned = buildPairAggregateReport({
    runId: "claude-versions-human-aligned",
    pairId: "claude48-vs-claude46",
    baselineId: "claude",
    challengerId: "claude48",
    comparisons,
    humanAlignment: {
      passed: true,
      totalEntries: 3,
      userChoiceAgreement: 0.8,
      reverseConsistency: 1,
      systematicReverseBias: false,
    },
  });
  assert.equal(humanAligned.admission.thresholdMet, true);
  assert.equal(humanAligned.admission.recommendedDefault, "claude48");
  assert.equal(humanAligned.admission.qualityConclusion, "challenger_eligible_for_review");
});

test("user-requested prose export requires read-only FactGuard-passing route telemetry", () => {
  const output = {
    status: "ok",
    isPreviewRun: true,
    candidates: [{
      id: "raw",
      kind: "context_enhanced",
      route: "v2_rawstage2",
      text: "这是经统一主链路生成的预览正文。",
      contextHash: "ctx",
    }],
    stageResults: {
      commitAndSave: { skipped: true },
      rawFactGuard: { ok: true, errors: [] },
      promptAdapter: { profile: "gemini_writer_v1" },
      modelCalls: [{
        kind: "raw_chapter",
        route: "v2_rawstage2",
        requestedRoute: "v2_rawstage2_gemini31",
        actualProvider: "gemini31",
        actualModel: "gemini-3.1-pro-preview",
        durationMs: 123,
        finishReason: "stop",
      }],
    },
  };
  const extracted = extractVerifiedPreviewText(output, {
    requestedRoute: "v2_rawstage2_gemini31",
    provider: "gemini31",
    model: "gemini-3.1-pro-preview",
  });
  assert.equal(extracted.text, "这是经统一主链路生成的预览正文。");
  assert.equal(extracted.promptProfile, "gemini_writer_v1");
  assert.match(extracted.textHash, /^[a-f0-9]{64}$/);

  const unsafe = structuredClone(output);
  unsafe.stageResults.rawFactGuard.ok = false;
  assert.throws(() => extractVerifiedPreviewText(unsafe, {
    requestedRoute: "v2_rawstage2_gemini31",
    provider: "gemini31",
    model: "gemini-3.1-pro-preview",
  }), /FactGuard/i);
});

test("CLI hard timeout bounds an unresponsive external operation", async () => {
  await assert.rejects(
    () => withHardTimeout(new Promise(() => {}), 15, "connectivity"),
    /connectivity exceeded hard timeout 15ms/,
  );
  assert.equal(await withHardTimeout(Promise.resolve("ok"), 100, "preview"), "ok");
});

test("preview hard timeout requires a fresh process before the next sample", () => {
  assert.equal(
    comparisonErrorRequiresProcessRestart(new Error("scene:production_final:2/claude preview exceeded hard timeout 480000ms")),
    true,
  );
  assert.equal(comparisonErrorRequiresProcessRestart(new Error("provider mismatch")), false);

  const script = readFileSync(resolve(process.cwd(), "../../../scripts/novelbench/compare-writers.mjs"), "utf8");
  assert.match(script, /comparisonErrorRequiresProcessRestart/);
  assert.match(script, /resume in a fresh process/i);
});

test("judge transport retries the same provider within a bounded total budget", () => {
  assert.deepEqual(buildJudgeRetryOptions(120_000, 2), {
    maxRetries: 2,
    perAttemptTimeoutMs: 120_000,
    totalTimeoutMs: 365_000,
  });
  assert.deepEqual(buildJudgeRetryOptions(30_000, 1), {
    maxRetries: 1,
    perAttemptTimeoutMs: 30_000,
    totalTimeoutMs: 65_000,
  });
});

test("writer comparison judge uses the strict verdict schema and streaming-sized output budget", async () => {
  const calls = [];
  const attempts = [];
  const generate = createStrictJudgeGenerate({
    config: { model: "gpt-5.6-sol" },
    maxRetries: 0,
    onAttempt: (event) => attempts.push(event),
    callJudgeModel: async (config, messages, options) => {
      calls.push({ config, messages, options });
      return {
        text: JSON.stringify({
          winner: "A",
          confidence: "clear",
          readerExperience: {
            preferredCandidate: "A",
            nativeChinese: "A",
            novelVoice: "A",
            sceneImmersion: "A",
            characterPresence: "A",
            continuationDesire: "A",
            rationale: "A reads as the stronger scene",
          },
          decisiveReasons: [],
          factualRisks: [],
          regressionRisks: [],
          constitutionAlignment: "aligned",
        }),
        model: "gpt-5.6-sol",
        durationMs: 25,
      };
    },
  });

  const result = await generate({
    route: "v2_literary_judge",
    kind: "literary_judge",
    systemPrompt: "judge",
    userPrompt: "compare",
    timeoutMs: 120_000,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.responseFormat, "json_schema");
  assert.equal(calls[0].options.schemaName, "writer_comparison_verdict");
  assert.equal(calls[0].options.maxTokens, 4096);
  assert.equal(calls[0].options.stream, true);
  assert.deepEqual(calls[0].options.schema.required, [
    "winner", "confidence", "readerExperience", "decisiveReasons", "factualRisks",
    "regressionRisks", "constitutionAlignment",
  ]);
  assert.equal(calls[0].options.schema.additionalProperties, false);
  assert.equal(result.provider, "gpt");
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(result.text.includes('"winner":"A"'), true);
  assert.deepEqual(attempts.map(({ status, attempt }) => ({ status, attempt })), [
    { status: "started", attempt: 1 },
    { status: "succeeded", attempt: 1 },
  ]);
  assert.equal(attempts[1].durationMs >= 0, true);
});
