/**
 * Utilities for controlled Claude/Gemini chapter-writer comparisons.
 * The public CLI owns model calls; this module owns isolated fixtures and sanitized aggregation.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const WRITER_COMPARISON_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    winner: { type: "string", enum: ["A", "B", "tie"] },
    confidence: { type: "string", enum: ["clear", "slight", "uncertain"] },
    readerExperience: {
      type: "object",
      properties: {
        preferredCandidate: { type: "string", enum: ["A", "B", "tie"] },
        nativeChinese: { type: "string", enum: ["A", "B", "tie"] },
        novelVoice: { type: "string", enum: ["A", "B", "tie"] },
        sceneImmersion: { type: "string", enum: ["A", "B", "tie"] },
        characterPresence: { type: "string", enum: ["A", "B", "tie"] },
        continuationDesire: { type: "string", enum: ["A", "B", "tie"] },
        rationale: { type: "string" },
      },
      required: [
        "preferredCandidate", "nativeChinese", "novelVoice", "sceneImmersion",
        "characterPresence", "continuationDesire", "rationale",
      ],
      additionalProperties: false,
    },
    decisiveReasons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dimension: { type: "string" },
          betterCandidate: { type: "string", enum: ["A", "B", "neither"] },
          evidenceA: { type: "array", items: spanSchema() },
          evidenceB: { type: "array", items: spanSchema() },
          explanation: { type: "string" },
        },
        required: ["dimension", "betterCandidate", "evidenceA", "evidenceB", "explanation"],
        additionalProperties: false,
      },
    },
    factualRisks: { type: "array", items: { type: "string" } },
    regressionRisks: { type: "array", items: { type: "string" } },
    constitutionAlignment: { type: "string" },
  },
  required: [
    "winner",
    "confidence",
    "readerExperience",
    "decisiveReasons",
    "factualRisks",
    "regressionRisks",
    "constitutionAlignment",
  ],
  additionalProperties: false,
};

function spanSchema() {
  return {
    type: "object",
    properties: {
      start: { type: "integer", minimum: 0 },
      end: { type: "integer", minimum: 0 },
      excerpt: { type: "string" },
    },
    required: ["start", "end", "excerpt"],
    additionalProperties: false,
  };
}

/** Build the eval-only judge transport: one provider, strict schema, bounded retries. */
export function createStrictJudgeGenerate({ config, callJudgeModel, maxRetries = 2, onAttempt }) {
  if (!config || config.model !== "gpt-5.6-sol") {
    throw new Error("writer comparison requires gpt-5.6-sol as the heterogeneous judge");
  }
  if (typeof callJudgeModel !== "function") {
    throw new Error("writer comparison requires callJudgeModel");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) {
    throw new Error("judge maxRetries must be an integer between 0 and 2");
  }
  return async (input) => {
    if (input.route !== "v2_literary_judge") {
      throw new Error(`unexpected writer comparison judge route: ${input.route}`);
    }
    const timeoutMs = Math.min(input.timeoutMs ?? config.timeoutMs ?? 120_000, 180_000);
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const started = Date.now();
      emitAttempt(onAttempt, { status: "started", attempt: attempt + 1, model: config.model });
      try {
        const result = await callJudgeModel(
          { ...config, timeoutMs },
          [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt },
          ],
          {
            responseFormat: "json_schema",
            schema: WRITER_COMPARISON_VERDICT_SCHEMA,
            schemaName: "writer_comparison_verdict",
            temperature: 0.2,
            maxTokens: 4096,
            stream: true,
          },
        );
        emitAttempt(onAttempt, {
          status: "succeeded",
          attempt: attempt + 1,
          model: result.model,
          durationMs: Date.now() - started,
        });
        return {
          text: result.text,
          model: result.model,
          route: input.route,
          provider: "gpt",
          finishReason: "stop",
          durationMs: result.durationMs,
        };
      } catch (error) {
        lastError = error;
        emitAttempt(onAttempt, {
          status: "failed",
          attempt: attempt + 1,
          model: config.model,
          durationMs: Date.now() - started,
          errorClass: error?.constructor?.name ?? typeof error,
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

function emitAttempt(listener, event) {
  if (typeof listener !== "function") return;
  try {
    listener(event);
  } catch {
    // Evaluation telemetry must never change the judge outcome.
  }
}

export function createComparisonWorkspace({ projectRoot, runId, scene, replaceExisting = false }) {
  const workspaceId = `__writer-compare-${safeId(runId)}-${safeId(scene.id)}`;
  const workspacesRoot = resolve(projectRoot, "workspaces");
  const workspacePath = resolve(workspacesRoot, workspaceId);
  assertInside(workspacesRoot, workspacePath);
  if (existsSync(workspacePath)) {
    if (!replaceExisting) throw new Error(`comparison workspace already exists: ${workspaceId}`);
    rmSync(workspacePath, { recursive: true, force: true });
  }

  mkdirSync(join(workspacePath, "characters"), { recursive: true });
  mkdirSync(join(workspacePath, "series"), { recursive: true });
  const characters = [scene.protagonist, scene.supporting].filter(Boolean);
  const config = {
    name: `Writer comparison: ${scene.title}`,
    novelName: `Writer comparison: ${scene.title}`,
    genre: scene.genre,
    subGenres: scene.subGenres,
    totalChapters: 1,
    chapterType: "standard",
    characters: characters.map(({ id, name }, index) => ({
      id,
      name,
      role: index === 0 ? "protagonist" : "supporting",
    })),
    immutableFacts: scene.immutableFacts,
    chapterSeeds: {
      "1": {
        choicesAndCosts: [{ choice: scene.choice, cost: scene.cost }],
        expectedIrreversibleChange: [scene.irreversibleChange],
        causalEndPressure: [scene.endingPressure],
      },
    },
  };
  writeJson(join(workspacePath, "config.json"), config);
  writeFileSync(
    join(workspacePath, "series", "outline.md"),
    `# ${scene.title}\n\n## Chapter 1\n\n${scene.outline}\n`,
    "utf8",
  );
  for (const character of characters) {
    writeFileSync(
      join(workspacePath, "characters", `${character.name}.md`),
      `# ${character.name}\n\n${character.profile}\n`,
      "utf8",
    );
  }
  writeJson(join(workspacePath, "creative-constitution.json"), {
    schemaVersion: 1,
    workIdentity: scene.title,
    readerPromise: scene.readerPromise ?? ["每次关键选择都产生可感知的后果"],
    genrePromises: scene.genrePromises ?? ["冲突由人物行动与既定规则推进"],
    protagonistCoreConflict: scene.protagonistCoreConflict ?? "主角必须在相互冲突的责任之间作出有代价的选择",
    thematicQuestions: scene.thematicQuestions ?? ["人在信息不完整时如何为选择负责"],
    aestheticDirection: scene.aestheticDirection ?? ["克制", "具体", "场景连续"],
    forbiddenDrift: scene.forbiddenDrift ?? ["不改变既定人物知识边界", "不靠无因果巧合解围"],
    narrativePreferences: [],
    updatedAt: "2026-07-19T00:00:00.000Z",
  });
  return { workspaceId, workspacePath };
}

export function snapshotWorkspace(workspacePath) {
  const root = resolve(workspacePath);
  const snapshot = {};
  if (!existsSync(root)) return snapshot;
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const key = relative(root, path).split(sep).join("/");
        const stat = statSync(path);
        snapshot[key] = `${stat.size}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
      }
    }
  };
  visit(root);
  return snapshot;
}

export function assertWorkspaceUnchanged(before, after) {
  if (stableJson(before) !== stableJson(after)) {
    const changedPaths = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((path) => before[path] !== after[path])
      .sort()
      .slice(0, 20);
    const error = new Error(`comparison preview mutated its temporary workspace: ${changedPaths.join(", ")}`);
    error.code = "WORKSPACE_MUTATION";
    error.changedPaths = changedPaths;
    throw error;
  }
}

export function removeComparisonWorkspace({ projectRoot, workspacePath }) {
  const workspacesRoot = resolve(projectRoot, "workspaces");
  const target = resolve(workspacePath);
  assertInside(workspacesRoot, target);
  rmSync(target, { recursive: true, force: true });
}

export function buildAggregateReport({
  runId,
  comparisons,
  connectivity = null,
  humanAlignment = null,
}) {
  const decisive = comparisons.filter((item) => item.winner === "claude" || item.winner === "gemini31");
  const geminiWins = decisive.filter((item) => item.winner === "gemini31").length;
  const claudeWins = decisive.filter((item) => item.winner === "claude").length;
  const geminiWinRate = decisive.length > 0 ? geminiWins / decisive.length : null;
  const controlledSampleCount = comparisons.filter((item) =>
    item.controlled !== false && item.contractEqual === true && item.contextEqual === true).length;
  const modelJudgeThresholdMet = controlledSampleCount >= 3
    && decisive.length >= 3
    && geminiWinRate !== null
    && geminiWinRate >= 0.55;
  const humanAlignmentSummary = summarizeHumanAlignment(humanAlignment);
  const humanAlignmentGatePassed = humanAlignmentSummary.gatePassed;
  const thresholdMet = modelJudgeThresholdMet && humanAlignmentGatePassed;
  const strategyAdmissions = Object.fromEntries(
    [...new Set(comparisons.map((item) => item.strategy ?? "unspecified"))].map((strategy) => {
      const strategyComparisons = comparisons.filter((item) => (item.strategy ?? "unspecified") === strategy);
      const controlled = strategyComparisons.filter((item) =>
        item.controlled !== false && item.contractEqual === true && item.contextEqual === true);
      const strategyDecisive = controlled.filter((item) => item.winner === "claude" || item.winner === "gemini31");
      const strategyGeminiWins = strategyDecisive.filter((item) => item.winner === "gemini31").length;
      const strategyClaudeWins = strategyDecisive.filter((item) => item.winner === "claude").length;
      const strategyGeminiWinRate = strategyDecisive.length > 0 ? strategyGeminiWins / strategyDecisive.length : null;
      const strategyModelJudgeThresholdMet = controlled.length >= 3
        && strategyDecisive.length >= 3
        && strategyGeminiWinRate !== null
        && strategyGeminiWinRate >= 0.55;
      return [strategy, {
        controlledSampleCount: controlled.length,
        decisiveSampleCount: strategyDecisive.length,
        geminiWins: strategyGeminiWins,
        claudeWins: strategyClaudeWins,
        inconclusiveCount: strategyComparisons.length - strategyDecisive.length,
        geminiWinRate: strategyGeminiWinRate,
        modelJudgeThresholdMet: strategyModelJudgeThresholdMet,
        humanAlignmentGatePassed,
        thresholdMet: strategyModelJudgeThresholdMet && humanAlignmentGatePassed,
      }];
    }),
  );
  return {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    connectivity,
    comparisons,
    strategyAdmissions,
    admission: {
      requiredSampleCount: 3,
      requiredWinRate: 0.55,
      controlledSampleCount,
      decisiveSampleCount: decisive.length,
      geminiWins,
      claudeWins,
      inconclusiveCount: comparisons.length - decisive.length,
      geminiWinRate,
      modelJudgeThresholdMet,
      humanAlignmentGatePassed,
      humanAlignment: humanAlignmentSummary,
      thresholdMet,
      recommendedDefault: thresholdMet ? "gemini31" : null,
      qualityConclusion: !humanAlignmentGatePassed
        ? "human_alignment_required"
        : thresholdMet
          ? "challenger_eligible_for_review"
          : "insufficient_combined_evidence",
      currentDefault: "claude",
      defaultSwitchApplied: false,
      decision: thresholdMet
        ? "Gemini met the initial evidence threshold; changing the default still requires an explicit reviewed configuration change."
        : !humanAlignmentGatePassed
          ? "Machine-judge results are diagnostic only; a passing natural-human alignment review is required before recommending any default model."
          : "Keep the current default; combined model-judge and human-alignment evidence is below the switching threshold.",
    },
  };
}

export function comparisonIdentity(comparison) {
  if (typeof comparison?.sceneId !== "string" || comparison.sceneId.trim().length === 0) {
    throw new Error("comparison identity requires sceneId");
  }
  if (typeof comparison.strategy !== "string" || comparison.strategy.trim().length === 0) {
    throw new Error("comparison identity requires strategy");
  }
  if (!Number.isInteger(comparison.sampleIndex) || comparison.sampleIndex < 1) {
    throw new Error("comparison identity requires a positive sampleIndex");
  }
  return `${comparison.sceneId}:${comparison.strategy}:${comparison.sampleIndex}`;
}

export function resolveWriterComparisonMode(args) {
  const raw = args.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length);
  if (raw === undefined || raw === "raw_isolated") return "raw_isolated";
  if (raw === "production_final") return "production_final";
  if (raw === "search_depth") return "search_depth";
  throw new Error("--mode must be raw_isolated, production_final, or search_depth");
}

export function resolveSearchDepthWriter(args) {
  const raw = args.find((arg) => arg.startsWith("--writer="))?.slice("--writer=".length);
  if (raw === undefined || raw === "gemini31") {
    return {
      writerModel: "gemini31",
      provider: "gemini31",
      model: "gemini-3.1-pro",
      reportGroup: "gemini-bounded-best-of3",
    };
  }
  if (raw === "claude") {
    return {
      writerModel: "claude",
      provider: "claude",
      model: "claude-opus-4-6",
      reportGroup: "claude-bounded-best-of3",
    };
  }
  throw new Error("--writer must be gemini31 or claude");
}

export function resolveReaderJudge(args) {
  const raw = args.find((arg) => arg.startsWith("--judge="))?.slice("--judge=".length);
  if (raw === undefined || raw === "gpt56") {
    return {
      id: "gpt56",
      route: "v2_literary_judge",
      provider: "gpt",
      model: "gpt-5.6-sol",
      strictSchema: true,
    };
  }
  if (raw === "gemini31") {
    return {
      id: "gemini31-reader",
      route: "v2_reader_experience_judge_gemini31",
      provider: "gemini31",
      model: "gemini-3.1-pro",
      strictSchema: false,
    };
  }
  throw new Error("--judge must be gpt56 or gemini31");
}

export function resolveComparisonPreviewTimeoutMs(mode, configuredValue) {
  const defaultTimeoutMs = mode === "production_final" || mode === "search_depth" ? 1_200_000 : 480_000;
  const timeoutMs = Number(configuredValue ?? defaultTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("writer comparison preview timeout must be positive");
  }
  return timeoutMs;
}

export function summarizeBoundedBestOf3Preview(output) {
  if (output?.isPreviewRun !== true) throw new Error("bounded best-of-3 run was not a read-only preview");
  if (output?.stageResults?.qualityExperiment !== undefined || output?.stageResults?.evalMode === true) {
    throw new Error("bounded best-of-3 preview must use the production-final path");
  }
  const candidates = Array.isArray(output.candidates) ? output.candidates : [];
  if (candidates.length < 1 || candidates.length > 3) {
    throw new Error(`bounded best-of-3 candidate count must be between 1 and 3; received ${candidates.length}`);
  }
  const selectedCandidateIndex = candidates.findIndex((candidate) => candidate.id === output.selectedCandidateId);
  if (selectedCandidateIndex < 0) throw new Error("bounded best-of-3 selected candidate is missing");
  const stage = output.stageResults ?? {};
  const rawFactGuardPassed = stage.rawFactGuard?.ok === true;
  const selectedSource = output.selectedSource;
  const finalFactPassed = selectedSource === "raw"
    ? rawFactGuardPassed
    : stage.finalFactRecheck?.passed === true;
  const completenessPassed = stage.finalTextCompleteness?.passed === true;
  const commitSkipped = stage.commitAndSave?.skipped === true;
  const finalGatePassed = output.status === "ok"
    && rawFactGuardPassed
    && finalFactPassed
    && completenessPassed
    && commitSkipped;
  const positiveGain = stage.positiveGainCandidates ?? {};
  const selectedSceneIds = Array.isArray(positiveGain.selectedSceneIds)
    ? positiveGain.selectedSceneIds.filter((value) => typeof value === "string")
    : [];
  const candidateFailures = Array.isArray(positiveGain.candidateFailures)
    ? positiveGain.candidateFailures.map((failure) => ({
        sceneId: typeof failure?.sceneId === "string" ? failure.sceneId : "unknown",
        reasonHash: hashText(String(failure?.reason ?? "unknown")),
      }))
    : [];
  const controlled = finalGatePassed
    && candidates.length === 3
    && selectedSceneIds.length === 2
    && candidateFailures.length === 0;
  const finalText = typeof output.text === "string" ? output.text : "";
  return {
    schemaVersion: 1,
    comparisonMode: "bounded_best_of_3",
    controlled,
    decisionReason: !finalGatePassed
      ? "final_gate_veto"
      : candidates.length !== 3
        ? "candidate_count_below_3"
        : selectedSceneIds.length !== 2
          ? "scene_diversity_missing"
          : candidateFailures.length > 0
            ? "candidate_generation_partial"
            : selectedCandidateIndex === 2
              ? "second_scene_candidate_selected"
              : "second_scene_candidate_not_selected",
    candidateCount: candidates.length,
    candidateKinds: candidates.map((candidate) => candidate.kind),
    candidateTextHashes: candidates.map((candidate) => hashText(candidate.text ?? "")),
    selectedCandidateIndex,
    selectedSource: selectedSource ?? null,
    selectedTextHash: hashText(finalText),
    selectedCharacterCount: finalText.length,
    selectedSceneIds,
    candidateFailures,
    secondSceneCandidateSelected: controlled && selectedCandidateIndex === 2,
    finalGatePassed,
    rawFactGuardPassed,
    finalFactPassed,
    completenessPassed,
    commitSkipped,
  };
}

export function aggregateBoundedBestOf3(comparisons) {
  const controlled = comparisons.filter((comparison) => comparison?.controlled === true);
  const secondCandidateWins = controlled.filter((comparison) => comparison.secondSceneCandidateSelected === true).length;
  const finalGateVetoes = comparisons.filter((comparison) => comparison?.finalGatePassed === false).length;
  return {
    controlledComparisons: controlled.length,
    secondCandidateWins,
    secondCandidateWinRate: controlled.length === 0 ? null : secondCandidateWins / controlled.length,
    finalGateVetoes,
    repeatedIncrementalGain: controlled.length >= 3 && secondCandidateWins >= 2 && finalGateVetoes === 0,
    productionApplied: false,
  };
}

export function comparisonErrorRequiresProcessRestart(error) {
  return error instanceof Error && /exceeded hard timeout \d+ms/i.test(error.message);
}

export function completedComparisonKeys(comparisons) {
  const keys = new Set();
  for (const comparison of comparisons) {
    const key = comparisonIdentity(comparison);
    if (keys.has(key)) throw new Error(`duplicate comparison identity: ${key}`);
    keys.add(key);
  }
  return keys;
}

export function prepareResumeComparisons(comparisons) {
  return comparisons.filter((comparison) => comparison?.retryRequired !== true);
}

export function saveComparisonCheckpoint({
  checkpointPath,
  runId,
  comparisons,
  connectivity = null,
  expectedComparisonCount,
  complete = false,
  reportBuilder = buildAggregateReport,
}) {
  assertCheckpointArguments({ checkpointPath, runId, comparisons, expectedComparisonCount });
  completedComparisonKeys(comparisons);
  if (comparisons.length > expectedComparisonCount) {
    throw new Error(`checkpoint has ${comparisons.length} comparisons, expected at most ${expectedComparisonCount}`);
  }
  if (complete && comparisons.length !== expectedComparisonCount) {
    throw new Error(`cannot complete checkpoint: ${comparisons.length}/${expectedComparisonCount} comparisons`);
  }
  const report = {
    ...reportBuilder({ runId, comparisons, connectivity }),
    lifecycle: {
      status: complete ? "complete" : "partial",
      expectedComparisonCount,
      completedComparisonCount: comparisons.length,
      remainingComparisonCount: expectedComparisonCount - comparisons.length,
    },
  };
  mkdirSync(dirname(checkpointPath), { recursive: true });
  const temporaryPath = `${checkpointPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, checkpointPath);
  return report;
}

export function loadComparisonCheckpoint({ checkpointPath, runId, expectedComparisonCount }) {
  if (!existsSync(checkpointPath)) throw new Error(`comparison checkpoint not found: ${checkpointPath}`);
  let report;
  try {
    report = JSON.parse(readFileSync(checkpointPath, "utf8"));
  } catch (error) {
    throw new Error(`comparison checkpoint unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (report?.schemaVersion !== 1) throw new Error("comparison checkpoint schemaVersion mismatch");
  if (report.runId !== runId) {
    throw new Error(`comparison checkpoint runId mismatch: expected ${runId}, received ${String(report.runId)}`);
  }
  if (!Array.isArray(report.comparisons)) throw new Error("comparison checkpoint comparisons must be an array");
  if (report.lifecycle?.expectedComparisonCount !== expectedComparisonCount) {
    throw new Error("comparison checkpoint expectedComparisonCount mismatch");
  }
  if (report.lifecycle?.completedComparisonCount !== report.comparisons.length) {
    throw new Error("comparison checkpoint completedComparisonCount mismatch");
  }
  completedComparisonKeys(report.comparisons);
  return report;
}

function assertCheckpointArguments({ checkpointPath, runId, comparisons, expectedComparisonCount }) {
  if (typeof checkpointPath !== "string" || checkpointPath.trim().length === 0) {
    throw new Error("checkpointPath is required");
  }
  if (typeof runId !== "string" || runId.trim().length === 0) throw new Error("checkpoint runId is required");
  if (!Array.isArray(comparisons)) throw new Error("checkpoint comparisons must be an array");
  if (!Number.isInteger(expectedComparisonCount) || expectedComparisonCount < 1) {
    throw new Error("expectedComparisonCount must be a positive integer");
  }
}

export function buildPairAggregateReport({
  runId,
  pairId,
  baselineId,
  challengerId,
  comparisons,
  requiredSampleCount = 3,
  requiredWinRate = 0.55,
  humanAlignment = null,
}) {
  const controlled = comparisons.filter((item) =>
    item.controlled !== false && item.contractEqual === true && item.contextEqual === true);
  const decisive = controlled.filter((item) =>
    item.winner === baselineId || item.winner === challengerId);
  const baselineWins = decisive.filter((item) => item.winner === baselineId).length;
  const challengerWins = decisive.filter((item) => item.winner === challengerId).length;
  const challengerWinRate = decisive.length > 0 ? challengerWins / decisive.length : null;
  const modelJudgeThresholdMet = controlled.length >= requiredSampleCount
    && decisive.length >= requiredSampleCount
    && challengerWinRate !== null
    && challengerWinRate >= requiredWinRate;
  const humanAlignmentSummary = summarizeHumanAlignment(humanAlignment);
  const humanAlignmentGatePassed = humanAlignmentSummary.gatePassed;
  const thresholdMet = modelJudgeThresholdMet && humanAlignmentGatePassed;
  return {
    schemaVersion: 1,
    runId,
    pairId,
    generatedAt: new Date().toISOString(),
    comparisons,
    admission: {
      baselineId,
      challengerId,
      requiredSampleCount,
      requiredWinRate,
      controlledSampleCount: controlled.length,
      decisiveSampleCount: decisive.length,
      inconclusiveCount: comparisons.length - decisive.length,
      baselineWins,
      challengerWins,
      challengerWinRate,
      modelJudgeThresholdMet,
      humanAlignmentGatePassed,
      humanAlignment: humanAlignmentSummary,
      thresholdMet,
      recommendedDefault: thresholdMet ? challengerId : null,
      qualityConclusion: !humanAlignmentGatePassed
        ? "human_alignment_required"
        : thresholdMet
          ? "challenger_eligible_for_review"
          : "insufficient_combined_evidence",
      defaultSwitchApplied: false,
    },
  };
}

function summarizeHumanAlignment(value) {
  const provided = value !== null && typeof value === "object";
  const totalEntries = provided && Number.isInteger(value.totalEntries) ? value.totalEntries : 0;
  const userChoiceAgreement = provided && Number.isFinite(value.userChoiceAgreement)
    ? value.userChoiceAgreement
    : null;
  const reverseConsistency = provided && Number.isFinite(value.reverseConsistency)
    ? value.reverseConsistency
    : null;
  const systematicReverseBias = provided ? value.systematicReverseBias === true : null;
  const gatePassed = provided
    && value.passed === true
    && totalEntries >= 3
    && userChoiceAgreement !== null
    && userChoiceAgreement >= 0.70
    && reverseConsistency !== null
    && reverseConsistency >= 0.70
    && systematicReverseBias === false;
  return {
    provided,
    totalEntries,
    userChoiceAgreement,
    reverseConsistency,
    systematicReverseBias,
    gatePassed,
  };
}

/**
 * Extract prose only for an explicit user-requested preview artifact.
 * Sanitized comparison reports must continue to use hashes and metrics only.
 */
export function extractVerifiedPreviewText(output, expected) {
  if (output?.status !== "ok" || output?.isPreviewRun !== true) {
    throw new Error("preview output is not a successful read-only run");
  }
  if (output.stageResults?.commitAndSave?.skipped !== true) {
    throw new Error("preview output did not skip commitAndSave");
  }
  if (output.stageResults?.rawFactGuard?.ok !== true) {
    throw new Error("preview output did not pass FactGuard");
  }
  const candidate = output.candidates?.find((item) => item.kind === "context_enhanced")
    ?? output.candidates?.find((item) => item.route === "v2_rawstage2");
  if (typeof candidate?.text !== "string" || candidate.text.trim().length === 0) {
    throw new Error("preview output did not retain raw candidate prose");
  }
  const call = output.stageResults?.modelCalls?.find((item) =>
    item.kind === "raw_chapter" && item.route === "v2_rawstage2" && item.failed !== true);
  if (!call) throw new Error("preview raw route telemetry is missing");
  const requestedRoute = call.requestedRoute ?? call.route;
  const provider = call.actualProvider ?? call.provider;
  const model = call.actualModel ?? call.model;
  if (requestedRoute !== expected.requestedRoute) {
    throw new Error(`preview route mismatch: expected ${expected.requestedRoute}, received ${requestedRoute}`);
  }
  if (provider !== expected.provider) {
    throw new Error(`preview provider mismatch: expected ${expected.provider}, received ${provider ?? "missing"}`);
  }
  if (model !== expected.model) {
    throw new Error(`preview model mismatch: expected ${expected.model}, received ${model ?? "missing"}`);
  }
  return {
    text: candidate.text,
    textHash: createHash("sha256").update(candidate.text).digest("hex"),
    characterCount: candidate.text.length,
    requestedRoute,
    actualProvider: provider,
    actualModel: model,
    durationMs: Number.isFinite(call.durationMs) ? call.durationMs : null,
    finishReason: call.finishReason ?? null,
    promptProfile: typeof output.stageResults?.promptAdapter?.profile === "string"
      ? output.stageResults.promptAdapter.profile
      : null,
  };
}

export function buildFailedComparison({
  sceneId,
  workspaceId,
  chapterId,
  chapterNumber,
  error,
  previewSummaries,
}) {
  const previewFailures = {};
  for (const [writer, summary] of Object.entries(previewSummaries ?? {})) {
    const calls = Array.isArray(summary?.modelCalls) ? summary.modelCalls : [];
    previewFailures[writer] = {
      status: typeof summary?.status === "string" ? summary.status : "unknown",
      stage: typeof summary?.stage === "string" ? summary.stage : null,
      gate: typeof summary?.gate === "string" ? summary.gate : null,
      reasonHash: hashOptional(summary?.reason),
      modelCalls: calls.map((call) => ({
        requestedRoute: call.requestedRoute ?? call.route ?? null,
        actualProvider: call.actualProvider ?? call.provider ?? null,
        actualModel: call.actualModel ?? call.model ?? null,
        durationMs: Number.isFinite(call.durationMs) ? call.durationMs : null,
        failed: call.failed === true,
      })),
    };
  }
  const workspaceMutationPaths = error?.code === "WORKSPACE_MUTATION" && Array.isArray(error.changedPaths)
    ? error.changedPaths.filter((path) =>
        typeof path === "string"
        && path.length > 0
        && path.length <= 240
        && !path.includes("..")
        && !/[\r\n\0]/.test(path))
    : undefined;
  return {
    schemaVersion: 1,
    sceneId,
    workspaceId,
    chapterId,
    chapterNumber,
    winner: null,
    controlled: false,
    decisionReason: "preview_failed",
    contractEqual: false,
    contextEqual: false,
    reverseConsistent: false,
    errorClass: error?.constructor?.name ?? typeof error,
    errorHash: hashOptional(error instanceof Error ? error.message : String(error)),
    ...(workspaceMutationPaths ? { workspaceMutationPaths } : {}),
    previewFailures,
  };
}

/** Enforce a CLI-level wall clock bound even when an adapter ignores its timeout option. */
export function withHardTimeout(operation, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error(`${label} hard timeout must be positive`));
  }
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} exceeded hard timeout ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([Promise.resolve(operation), timeout]).finally(() => clearTimeout(timeoutId));
}

export function buildJudgeRetryOptions(perAttemptTimeoutMs, maxRetries) {
  if (!Number.isFinite(perAttemptTimeoutMs) || perAttemptTimeoutMs <= 0) {
    throw new Error("judge per-attempt timeout must be positive");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) {
    throw new Error("judge maxRetries must be an integer between 0 and 2");
  }
  return {
    maxRetries,
    perAttemptTimeoutMs,
    totalTimeoutMs: perAttemptTimeoutMs * (maxRetries + 1) + 5_000,
  };
}

function assertInside(parent, target) {
  const rel = relative(parent, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing to remove path outside workspaces: ${target}`);
  }
}

function safeId(value) {
  const cleaned = String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) throw new Error("comparison identifier is empty after sanitization");
  return cleaned.slice(0, 72);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hashOptional(value) {
  return typeof value === "string" && value.length > 0
    ? createHash("sha256").update(value).digest("hex")
    : null;
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
