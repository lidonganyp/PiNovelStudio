/**
 * Eval-only comparison of the Claude production-selected final against a
 * Gemini production-final challenger. Serialized results never retain prose.
 */

import { createHash } from "node:crypto";
import type { ModelGenerateFn } from "../v2/adapters/legacy-model-route-adapter.js";
import type { ChapterIntent } from "../v2/core/chapter-intent-builder.js";
import type { ArbitratorInput, ArbitratorResult } from "../v2/core/judge-arbitrator.js";
import { createJudgeArbitrator } from "../v2/core/judge-arbitrator.js";
import type { ChapterContract } from "../v2/core/model-prompt-adapter.js";
import type { ModelCallEntry } from "../v2/core/orchestrator-types.js";
import type { Candidate, V2Output } from "../v2/core/types.js";

export type ProductionFinalWriter = "claude" | "gemini31";

export interface ProductionFinalPreviewInput {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  writerModel: ProductionFinalWriter;
  fullPipelinePreview: true;
  seed?: number;
  candidateTimeoutMs?: number;
  previewTotalTimeoutMs?: number;
  qualityExperiment?: never;
  evalMode?: never;
}

export interface ProductionFinalCandidateMetrics {
  model: string;
  promptProfile: string | null;
  textHash: string;
  characterCount: number;
  selectedSource: "raw" | "editorial";
  candidateCount: number;
  productionCandidatePathReached: boolean;
  positiveGainStatus: string | null;
  rawFactGuardPassed: boolean;
  finalFactPassed: boolean;
  completenessPassed: boolean;
  finalGatePassed: boolean;
  requestedRoute: string;
  actualProvider: string;
  actualModel: string;
  finishReason: string | null;
  text?: never;
}

export interface ProductionFinalChallengerResult {
  schemaVersion: 1;
  comparisonMode: "production_final_challenger";
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  seed: number | null;
  winner: ProductionFinalWriter | null;
  decisionReason: string;
  incrementalGain: boolean;
  literaryIncrementalGain: boolean;
  controlled: boolean;
  contractEqual: boolean;
  contextEqual: boolean;
  reverseConsistent: boolean;
  candidates: Record<ProductionFinalWriter, ProductionFinalCandidateMetrics>;
  judge: {
    route: "v2_literary_judge";
    reverseReviewed: boolean;
    conflicted: boolean;
    degraded: boolean;
    roundCount: number;
    auditSummaryHash: string | null;
  };
}

export interface CompareProductionFinalChallengerInput {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  seed?: number;
  candidateTimeoutMs?: number;
  previewTotalTimeoutMs?: number;
  runPreview: (input: ProductionFinalPreviewInput) => Promise<V2Output>;
  judgeModelGenerate: ModelGenerateFn;
  arbitrate?: (input: ArbitratorInput) => Promise<ArbitratorResult>;
}

interface WriterSpec {
  id: ProductionFinalWriter;
  expectedRoute: string;
  expectedProvider: string;
  expectedModel: string;
}

interface ExtractedProductionFinal {
  candidate: Candidate;
  contract: ChapterContract;
  contextHash: string;
  metrics: ProductionFinalCandidateMetrics;
}

const WRITERS: Record<ProductionFinalWriter, WriterSpec> = {
  claude: {
    id: "claude",
    expectedRoute: "v2_rawstage2",
    expectedProvider: "claude",
    expectedModel: "claude-opus-4-6",
  },
  gemini31: {
    id: "gemini31",
    expectedRoute: "v2_rawstage2_gemini31",
    expectedProvider: "gemini31",
    expectedModel: "gemini-3.1-pro",
  },
};

export async function compareProductionFinalChallenger(
  input: CompareProductionFinalChallengerInput,
): Promise<ProductionFinalChallengerResult> {
  const common = {
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    fullPipelinePreview: true as const,
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.candidateTimeoutMs === undefined ? {} : { candidateTimeoutMs: input.candidateTimeoutMs }),
    ...(input.previewTotalTimeoutMs === undefined ? {} : { previewTotalTimeoutMs: input.previewTotalTimeoutMs }),
  };
  const claudeOutput = await input.runPreview({ ...common, writerModel: "claude" });
  const geminiOutput = await input.runPreview({ ...common, writerModel: "gemini31" });
  const claude = extractProductionFinal(WRITERS.claude, claudeOutput);
  const gemini = extractProductionFinal(WRITERS.gemini31, geminiOutput);

  const contractEqual = stableJson(claude.contract) === stableJson(gemini.contract);
  if (!contractEqual) throw new Error("ChapterContract mismatch between Claude and Gemini production-final previews");
  const contextEqual = claude.contextHash === gemini.contextHash;
  if (!contextEqual) throw new Error("compiled context mismatch between Claude and Gemini production-final previews");

  const base = buildBase(input, claude, gemini);
  if (!claude.metrics.finalGatePassed && !gemini.metrics.finalGatePassed) {
    return { ...base, winner: null, decisionReason: "both_final_gate_veto" };
  }
  if (!claude.metrics.finalGatePassed) {
    return {
      ...base,
      winner: "gemini31",
      decisionReason: "claude_final_gate_veto",
      incrementalGain: true,
    };
  }
  if (!gemini.metrics.finalGatePassed) {
    return { ...base, winner: "claude", decisionReason: "gemini_final_gate_veto" };
  }

  const arbitrate = input.arbitrate ?? ((judgeInput: ArbitratorInput) =>
    createJudgeArbitrator().arbitrate(judgeInput));
  const left = anonymize(claude.candidate, "candidate-1");
  const right = anonymize(gemini.candidate, "candidate-2");
  const previousClearSkip = process.env.PINOVEL_JUDGE_CLEAR_SKIP;
  let judged: ArbitratorResult;
  try {
    process.env.PINOVEL_JUDGE_CLEAR_SKIP = "0";
    judged = await arbitrate({
      rawCandidate: left,
      editorialCandidate: right,
      intent: contractToIntent(claude.contract),
      constitution: null,
      modelGenerate: input.judgeModelGenerate,
      seed: input.seed,
      route: "v2_literary_judge",
      timeoutMs: input.candidateTimeoutMs,
    });
  } finally {
    if (previousClearSkip === undefined) delete process.env.PINOVEL_JUDGE_CLEAR_SKIP;
    else process.env.PINOVEL_JUDGE_CLEAR_SKIP = previousClearSkip;
  }

  const degraded = judged.firstRound.degraded || judged.reverseRound?.degraded === true;
  const reverseConsistent = judged.reverseReviewed && !judged.conflicted && !degraded;
  const winner = reverseConsistent
    ? judged.finalSelectedCandidateId === left.id
      ? "claude"
      : judged.finalSelectedCandidateId === right.id
        ? "gemini31"
        : null
    : null;
  return {
    ...base,
    winner,
    decisionReason: winner ? "reverse_consistent_judge_winner" : "no_clear_reverse_consistent_winner",
    incrementalGain: winner === "gemini31",
    literaryIncrementalGain: winner === "gemini31",
    reverseConsistent,
    judge: {
      route: "v2_literary_judge",
      reverseReviewed: judged.reverseReviewed,
      conflicted: judged.conflicted,
      degraded,
      roundCount: judged.rounds.length,
      auditSummaryHash: hashOptionalText(judged.auditSummary),
    },
  };
}

function extractProductionFinal(spec: WriterSpec, output: V2Output): ExtractedProductionFinal {
  const stage = output.stageResults ?? {};
  if (stage.qualityExperiment !== undefined || stage.evalMode === true) {
    throw new Error(`${spec.id} preview is not production-final: qualityExperiment/evalMode was active`);
  }
  if (output.isPreviewRun !== true) throw new Error(`${spec.id} production-final preview was not read-only`);

  const rawFact = stage.rawFactGuard as { ok?: unknown; errors?: unknown } | undefined;
  if (typeof rawFact?.ok !== "boolean") throw new Error(`${spec.id} raw FactGuard result is missing`);
  const rawBlocked = output.status === "blocked" && rawFact.ok === false;
  const finalFact = stage.finalFactRecheck as { passed?: unknown; errors?: unknown } | undefined;
  const completeness = stage.finalTextCompleteness as { passed?: unknown; findings?: unknown } | undefined;
  if (!rawBlocked && typeof completeness?.passed !== "boolean") {
    throw new Error(`${spec.id} final completeness result is missing`);
  }

  const candidates = output.candidates ?? [];
  const blockedMetadata = stage.productionFinalPreviewBlockedCandidate as {
    id?: unknown;
    textHash?: unknown;
    characterCount?: unknown;
    contextHash?: unknown;
    route?: unknown;
    candidateCount?: unknown;
  } | undefined;
  const hasBlockedMetadata = rawBlocked
    && typeof blockedMetadata?.id === "string"
    && typeof blockedMetadata.textHash === "string"
    && /^[a-f0-9]{64}$/.test(blockedMetadata.textHash)
    && typeof blockedMetadata.characterCount === "number"
    && typeof blockedMetadata.contextHash === "string"
    && typeof blockedMetadata.route === "string"
    && blockedMetadata.candidateCount === 1;
  if (rawBlocked && !hasBlockedMetadata) {
    throw new Error(`${spec.id} blocked production-final candidate metadata is missing`);
  }
  const effectiveCandidateCount = hasBlockedMetadata ? 1 : candidates.length;
  if (effectiveCandidateCount < 1 || effectiveCandidateCount > 3) {
    throw new Error(`${spec.id} production candidate count must stay between 1 and 3; received ${effectiveCandidateCount}`);
  }
  const selected = hasBlockedMetadata
    ? blockedCandidateFromMetadata(blockedMetadata)
    : candidates.find((candidate) => candidate.id === output.selectedCandidateId);
  if (!selected) throw new Error(`${spec.id} selected production candidate is missing`);
  if (!rawBlocked && (typeof output.text !== "string" || output.text.length === 0)) {
    throw new Error(`${spec.id} production-final text is missing`);
  }
  const selectedSource = rawBlocked ? "raw" : output.selectedSource;
  if (selectedSource !== "raw" && selectedSource !== "editorial") {
    throw new Error(`${spec.id} selectedSource is missing`);
  }

  const contract = stage.chapterContract as ChapterContract | undefined;
  if (!contract) throw new Error(`${spec.id} ChapterContract is missing`);
  const modelCall = validateRawModelCall(spec, stage.modelCalls as ModelCallEntry[] | undefined);
  const positiveGain = stage.positiveGainCandidates as { status?: unknown } | undefined;
  const productionCandidatePathReached = positiveGain !== undefined;
  if (rawFact.ok && !productionCandidatePathReached) {
    throw new Error(`${spec.id} production-final preview did not reach the production candidate path`);
  }
  const commit = stage.commitAndSave as { skipped?: unknown } | undefined;
  if (output.status === "ok" && commit?.skipped !== true) {
    throw new Error(`${spec.id} production-final preview did not skip commitAndSave`);
  }

  const finalFactPassed = selectedSource === "raw"
    ? rawFact.ok
    : finalFact?.passed === true;
  const completenessPassed = rawBlocked ? false : completeness!.passed as boolean;
  const finalGatePassed = output.status === "ok"
    && rawFact.ok
    && finalFactPassed
    && completenessPassed;
  const actualModel = modelCall.actualModel ?? modelCall.model ?? "unknown";
  const finalText = rawBlocked ? "" : output.text!;
  const finalCandidate: Candidate = { ...selected, text: finalText };
  return {
    candidate: finalCandidate,
    contract,
    contextHash: selected.contextHash,
    metrics: {
      model: actualModel,
      promptProfile: typeof (stage.promptAdapter as { profile?: unknown } | undefined)?.profile === "string"
        ? (stage.promptAdapter as { profile: string }).profile
        : null,
      textHash: hasBlockedMetadata ? blockedMetadata.textHash as string : hashText(finalText),
      characterCount: hasBlockedMetadata ? blockedMetadata.characterCount as number : finalText.length,
      selectedSource,
      candidateCount: effectiveCandidateCount,
      productionCandidatePathReached,
      positiveGainStatus: typeof positiveGain?.status === "string" ? positiveGain.status : null,
      rawFactGuardPassed: rawFact.ok,
      finalFactPassed,
      completenessPassed,
      finalGatePassed,
      requestedRoute: modelCall.requestedRoute ?? modelCall.route,
      actualProvider: modelCall.actualProvider ?? modelCall.provider ?? "unknown",
      actualModel,
      finishReason: selected.finishReason ?? modelCall.finishReason ?? null,
    },
  };
}

function blockedCandidateFromMetadata(metadata: {
  id?: unknown;
  contextHash?: unknown;
  route?: unknown;
}): Candidate {
  return {
    id: metadata.id as string,
    kind: "context_enhanced",
    text: "",
    model: "blocked-preview",
    route: metadata.route as string,
    promptProfile: {
      type: "editorial",
      tokensIn: 0,
      containsDialogueRatio: false,
      containsParagraphLengthConstraint: false,
      containsControlChecklist: false,
      containsMechanicalMetric: false,
      contractIds: [],
    },
    contextHash: metadata.contextHash as string,
    generatedAt: "",
    durationMs: 0,
  };
}

function validateRawModelCall(spec: WriterSpec, calls: ModelCallEntry[] | undefined): ModelCallEntry {
  const call = calls?.find((entry) =>
    entry.kind === "raw_chapter" && entry.route === "v2_rawstage2" && entry.failed !== true);
  if (!call) throw new Error(`${spec.id} raw production route telemetry is missing`);
  const requestedRoute = call.requestedRoute ?? call.route;
  const actualProvider = call.actualProvider ?? call.provider;
  const actualModel = call.actualModel ?? call.model;
  if (requestedRoute !== spec.expectedRoute) {
    throw new Error(`${spec.id} route mismatch: expected ${spec.expectedRoute}, received ${requestedRoute}`);
  }
  if (actualProvider !== spec.expectedProvider) {
    throw new Error(`${spec.id} provider mismatch: expected ${spec.expectedProvider}, received ${actualProvider ?? "missing"}`);
  }
  if (actualModel !== spec.expectedModel) {
    throw new Error(`${spec.id} model mismatch: expected ${spec.expectedModel}, received ${actualModel ?? "missing"}`);
  }
  return call;
}

function buildBase(
  input: CompareProductionFinalChallengerInput,
  claude: ExtractedProductionFinal,
  gemini: ExtractedProductionFinal,
): ProductionFinalChallengerResult {
  return {
    schemaVersion: 1,
    comparisonMode: "production_final_challenger",
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    seed: input.seed ?? null,
    winner: null,
    decisionReason: "pending",
    incrementalGain: false,
    literaryIncrementalGain: false,
    controlled: true,
    contractEqual: true,
    contextEqual: true,
    reverseConsistent: false,
    candidates: { claude: claude.metrics, gemini31: gemini.metrics },
    judge: {
      route: "v2_literary_judge",
      reverseReviewed: false,
      conflicted: false,
      degraded: false,
      roundCount: 0,
      auditSummaryHash: null,
    },
  };
}

export interface ProductionFinalAggregateInput {
  sceneId: string;
  winner: ProductionFinalWriter | null;
  decisionReason: string;
  controlled: boolean;
  reverseConsistent: boolean;
  candidates: Record<ProductionFinalWriter, { finalGatePassed: boolean }>;
}

export interface SceneChallengerAdmission {
  controlledComparisons: number;
  claudeWins: number;
  geminiWins: number;
  geminiLiteraryWins: number;
  geminiRecoveryWins: number;
  inconclusive: number;
  geminiFinalVetoes: number;
  admitted: boolean;
  reason: string;
}

export function aggregateProductionFinalChallenger(
  comparisons: ProductionFinalAggregateInput[],
): { scenes: Record<string, SceneChallengerAdmission>; anySceneAdmitted: boolean } {
  const grouped = new Map<string, ProductionFinalAggregateInput[]>();
  for (const comparison of comparisons) {
    const group = grouped.get(comparison.sceneId) ?? [];
    group.push(comparison);
    grouped.set(comparison.sceneId, group);
  }
  const scenes: Record<string, SceneChallengerAdmission> = {};
  for (const [sceneId, group] of grouped) {
    const controlled = group.filter((item) => item.controlled);
    const geminiLiteraryWins = controlled.filter((item) =>
      item.winner === "gemini31"
      && item.decisionReason === "reverse_consistent_judge_winner"
      && item.reverseConsistent).length;
    const geminiRecoveryWins = controlled.filter((item) =>
      item.winner === "gemini31" && item.decisionReason === "claude_final_gate_veto").length;
    const geminiWins = controlled.filter((item) => item.winner === "gemini31").length;
    const claudeWins = controlled.filter((item) => item.winner === "claude").length;
    const geminiFinalVetoes = controlled.filter((item) => !item.candidates.gemini31.finalGatePassed).length;
    const admitted = controlled.length >= 3
      && geminiLiteraryWins >= 2
      && geminiWins > claudeWins
      && geminiFinalVetoes === 0;
    let reason = "admitted_scoped_challenger";
    if (controlled.length < 3) reason = "insufficient_controlled_comparisons";
    else if (geminiLiteraryWins < 2) reason = "insufficient_literary_wins";
    else if (geminiWins <= claudeWins) reason = "no_net_challenger_win";
    else if (geminiFinalVetoes > 0) reason = "challenger_final_veto_detected";
    scenes[sceneId] = {
      controlledComparisons: controlled.length,
      claudeWins,
      geminiWins,
      geminiLiteraryWins,
      geminiRecoveryWins,
      inconclusive: controlled.filter((item) => item.winner === null).length,
      geminiFinalVetoes,
      admitted,
      reason,
    };
  }
  return { scenes, anySceneAdmitted: Object.values(scenes).some((scene) => scene.admitted) };
}

function anonymize(candidate: Candidate, id: string): Candidate {
  return { ...candidate, id, model: "anonymous-writer", route: "anonymous-writer" };
}

function contractToIntent(contract: ChapterContract): ChapterIntent {
  return {
    chapterFunction: contract.chapterFunction.join("; "),
    overallPlotDirection: [...contract.overallPlotDirection],
    previousState: [...contract.previousState],
    characterMotivations: contract.characterMotivations.map((motivation) => {
      const separator = motivation.search(/[:：]/);
      return separator > 0
        ? { character: motivation.slice(0, separator), motivation: motivation.slice(separator + 1) }
        : { character: "", motivation };
    }),
    foreshadowing: [...contract.foreshadowing],
    causalRelations: [...contract.causalRelations],
    endingTarget: [...contract.endingTarget],
    authorEventSummaries: [...contract.eventSummaries],
    authorMustInclude: [...contract.mustInclude],
    authorStateChanges: [...contract.stateChanges],
    readerExperience: [],
    currentPressure: [...contract.previousState],
    meaningfulChoices: [],
    promisesToAdvance: [...contract.foreshadowing],
    possibleEndPressure: [...contract.endingTarget],
    relevantCharacters: [...contract.relevantCharacters],
    inviolableFacts: [...contract.inviolableFacts],
    sourceRefs: ["chapter-contract:production-final-challenger"],
    concreteDelivery: [...contract.eventSummaries, ...contract.mustInclude, ...contract.stateChanges],
    choicesAndCosts: [],
    expectedIrreversibleChange: [],
    causalEndPressure: [],
    factAndCharacterKnowledgeForbiddenZones: [...contract.stateConstraints],
    underSpecifiedFields: [],
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashOptionalText(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? hashText(value) : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
