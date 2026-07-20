/**
 * Eval-only controlled comparison for production-eligible chapter writers.
 * Both candidates must come from fullPipelinePreview runs of the unified pipeline.
 */

import { createHash } from "node:crypto";
import type { ChapterIntent } from "../v2/core/chapter-intent-builder.js";
import type { ArbitratorInput, ArbitratorResult } from "../v2/core/judge-arbitrator.js";
import { createJudgeArbitrator } from "../v2/core/judge-arbitrator.js";
import type { ChapterContract } from "../v2/core/model-prompt-adapter.js";
import type { ModelGenerateFn } from "../v2/adapters/legacy-model-route-adapter.js";
import type { Candidate, V2Output } from "../v2/core/types.js";
import type { ModelCallEntry } from "../v2/core/orchestrator-types.js";
import type { SceneSolutionCard } from "../v2/core/scene-solution-search.js";

export type ComparedWriterModel = "claude" | "gemini31" | "claude48";

export interface WriterPreviewInput {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  writerModel?: "claude" | "gemini31";
  modelTestRoute?: "claude48";
  fullPipelinePreview: true;
  seed?: number;
  candidateTimeoutMs?: number;
  previewTotalTimeoutMs?: number;
  sceneSolution?: SceneSolutionCard | null;
  qualityExperiment: {
    arm: "raw" | "scene" | "oracle_scene";
    sampleIndex: number;
  };
}

export interface WriterCandidateMetrics {
  model: string;
  route: string;
  promptProfile: string | null;
  textHash: string;
  characterCount: number;
  durationMs: number;
  factGuardPassed: boolean;
  factGuardErrorCount: number;
  factGuardErrorHashes: string[];
  requestedRoute: string;
  actualProvider: string;
  actualModel: string;
  finishReason: string | null;
  text?: never;
}

export interface WriterModelComparisonResult {
  schemaVersion: 1;
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  seed: number | null;
  strategy: "raw" | "scene" | "oracle_scene";
  sampleIndex: number;
  winner: ComparedWriterModel | null;
  decisionReason: string;
  contractEqual: boolean;
  contextEqual: boolean;
  reverseConsistent: boolean;
  candidates: Record<string, WriterCandidateMetrics>;
  judge: {
    route: "v2_literary_judge";
    reverseReviewed: boolean;
    conflicted: boolean;
    degraded: boolean;
    roundCount: number;
    auditSummaryHash: string | null;
  };
  admission: {
    sampleCount: 1;
    requiredSampleCount: 3;
    requiredWinRate: 0.55;
    defaultSwitchEligible: false;
  };
}

export interface CompareWriterModelsInput {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  seed?: number;
  candidateTimeoutMs?: number;
  previewTotalTimeoutMs?: number;
  sceneSolution?: SceneSolutionCard | null;
  strategy?: "raw" | "scene" | "oracle_scene";
  sampleIndex?: number;
  runPreview: (input: WriterPreviewInput) => Promise<V2Output>;
  judgeModelGenerate: ModelGenerateFn;
  arbitrate?: (input: ArbitratorInput) => Promise<ArbitratorResult>;
}

interface WriterComparisonSpec {
  id: ComparedWriterModel;
  invocation: Pick<WriterPreviewInput, "writerModel" | "modelTestRoute">;
  expectedRoute: string;
  expectedProvider: string;
  expectedModel: string;
}

const WRITER_SPECS: Record<ComparedWriterModel, WriterComparisonSpec> = {
  claude: {
    id: "claude",
    invocation: { writerModel: "claude" },
    expectedRoute: "v2_rawstage2",
    expectedProvider: "claude",
    expectedModel: "claude-opus-4-6",
  },
  gemini31: {
    id: "gemini31",
    invocation: { writerModel: "gemini31" },
    expectedRoute: "v2_rawstage2_gemini31",
    expectedProvider: "gemini31",
    expectedModel: "gemini-3.1-pro-preview",
  },
  claude48: {
    id: "claude48",
    invocation: { modelTestRoute: "claude48" },
    expectedRoute: "nb4_generate_claude48",
    expectedProvider: "claude",
    expectedModel: "claude-opus-4-8",
  },
};

interface ExtractedPreview {
  candidate: Candidate | null;
  candidateId: string;
  route: string;
  contextHash: string;
  textHash: string;
  characterCount: number;
  contract: ChapterContract;
  factGuardPassed: boolean;
  factGuardErrors: string[];
  promptProfile: string | null;
  rawModelCall: ModelCallEntry;
}

export async function compareWriterModels(
  input: CompareWriterModelsInput,
): Promise<WriterModelComparisonResult> {
  return compareWriterPair(input, WRITER_SPECS.claude, WRITER_SPECS.gemini31);
}

/** Compare production Claude 4.6 with the isolated Claude 4.8 lab route. */
export async function compareClaudeVersions(
  input: CompareWriterModelsInput,
): Promise<WriterModelComparisonResult> {
  return compareWriterPair(input, WRITER_SPECS.claude, WRITER_SPECS.claude48);
}

async function compareWriterPair(
  input: CompareWriterModelsInput,
  leftSpec: WriterComparisonSpec,
  rightSpec: WriterComparisonSpec,
): Promise<WriterModelComparisonResult> {
  const strategy = input.strategy ?? (input.sceneSolution ? "scene" : "raw");
  if (strategy !== "raw" && !input.sceneSolution) {
    throw new Error(`${strategy} comparison requires a sceneSolution`);
  }
  const common = {
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    fullPipelinePreview: true as const,
    qualityExperiment: {
      arm: strategy,
      sampleIndex: input.sampleIndex ?? 1,
    },
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.candidateTimeoutMs === undefined ? {} : { candidateTimeoutMs: input.candidateTimeoutMs }),
    ...(input.previewTotalTimeoutMs === undefined ? {} : { previewTotalTimeoutMs: input.previewTotalTimeoutMs }),
    ...(input.sceneSolution === undefined ? {} : { sceneSolution: input.sceneSolution }),
  };
  const leftOutput = await input.runPreview({ ...common, ...leftSpec.invocation });
  const rightOutput = await input.runPreview({ ...common, ...rightSpec.invocation });
  const left = extractPreview(leftSpec, leftOutput);
  const right = extractPreview(rightSpec, rightOutput);
  const contractEqual = stableJson(left.contract) === stableJson(right.contract);
  if (!contractEqual) throw new Error(`ChapterContract mismatch between ${leftSpec.id} and ${rightSpec.id} preview runs`);
  const contextEqual = left.contextHash === right.contextHash;
  if (!contextEqual) throw new Error(`Compiled context mismatch between ${leftSpec.id} and ${rightSpec.id} preview runs`);

  const base = buildBaseResult(input, leftSpec, left, rightSpec, right);
  if (!left.factGuardPassed && !right.factGuardPassed) {
    return { ...base, winner: null, decisionReason: "both_fact_guard_veto" };
  }
  if (!left.factGuardPassed) {
    return { ...base, winner: rightSpec.id, decisionReason: `${reasonId(leftSpec.id)}_fact_guard_veto` };
  }
  if (!right.factGuardPassed) {
    return { ...base, winner: leftSpec.id, decisionReason: `${reasonId(rightSpec.id)}_fact_guard_veto` };
  }

  if (!left.candidate || !right.candidate) {
    throw new Error("FactGuard-passing preview did not retain a raw candidate");
  }
  const neutralLeft = neutralCandidate(left.candidate, "candidate-1");
  const neutralRight = neutralCandidate(right.candidate, "candidate-2");
  const arbitrate = input.arbitrate ?? ((judgeInput: ArbitratorInput) =>
    createJudgeArbitrator().arbitrate(judgeInput));
  const previousClearSkip = process.env.PINOVEL_JUDGE_CLEAR_SKIP;
  let result: ArbitratorResult;
  try {
    process.env.PINOVEL_JUDGE_CLEAR_SKIP = "0";
    result = await arbitrate({
      rawCandidate: neutralLeft,
      editorialCandidate: neutralRight,
      intent: contractToIntent(left.contract),
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

  const degraded = result.firstRound.degraded || result.reverseRound?.degraded === true;
  const reverseConsistent = result.reverseReviewed && !result.conflicted && !degraded;
  const winner = reverseConsistent
    ? result.finalSelectedCandidateId === neutralLeft.id
      ? leftSpec.id
      : result.finalSelectedCandidateId === neutralRight.id
        ? rightSpec.id
        : null
    : null;
  return {
    ...base,
    winner,
    decisionReason: winner ? "reverse_consistent_judge_winner" : "no_clear_reverse_consistent_winner",
    reverseConsistent,
    judge: {
      route: "v2_literary_judge",
      reverseReviewed: result.reverseReviewed,
      conflicted: result.conflicted,
      degraded,
      roundCount: result.rounds.length,
      auditSummaryHash: hashOptionalText(result.auditSummary),
    },
  };
}

function reasonId(writer: ComparedWriterModel): string {
  return writer === "gemini31" ? "gemini" : writer;
}

function extractPreview(spec: WriterComparisonSpec, output: V2Output): ExtractedPreview {
  const writer = spec.id;
  const factGuard = output.stageResults?.rawFactGuard as { ok?: boolean; errors?: unknown } | undefined;
  const blockedWithFactGuardEvidence = output.status === "blocked"
    && factGuard?.ok === false;
  if ((output.status !== "ok" && !blockedWithFactGuardEvidence)
    || (!blockedWithFactGuardEvidence && output.isPreviewRun !== true)) {
    throw new Error(`${writer} preview failed or was not read-only`);
  }
  const commit = output.stageResults?.commitAndSave as { skipped?: boolean } | undefined;
  if (!blockedWithFactGuardEvidence && commit?.skipped !== true) {
    throw new Error(`${writer} preview did not skip commitAndSave`);
  }
  const candidate = output.candidates?.find((item) => item.kind === "context_enhanced")
    ?? output.candidates?.find((item) => item.route === "v2_rawstage2");
  const blockedMetadata = output.stageResults?.qualityExperimentRawCandidate as {
    id?: unknown;
    textHash?: unknown;
    characterCount?: unknown;
    contextHash?: unknown;
    route?: unknown;
  } | undefined;
  const hasBlockedMetadata = blockedWithFactGuardEvidence
    && typeof blockedMetadata?.id === "string"
    && typeof blockedMetadata.textHash === "string"
    && /^[a-f0-9]{64}$/.test(blockedMetadata.textHash)
    && typeof blockedMetadata.characterCount === "number"
    && typeof blockedMetadata.contextHash === "string"
    && typeof blockedMetadata.route === "string";
  if (!candidate?.text && !hasBlockedMetadata) {
    throw new Error(`${writer} preview did not return raw candidate metadata`);
  }
  const contract = output.stageResults?.chapterContract as ChapterContract | undefined;
  if (!contract) throw new Error(`${writer} preview did not expose ChapterContract`);
  if (typeof factGuard?.ok !== "boolean") throw new Error(`${writer} preview did not expose raw FactGuard`);
  const adapter = output.stageResults?.promptAdapter as { profile?: unknown } | undefined;
  const modelCalls = output.stageResults?.modelCalls as ModelCallEntry[] | undefined;
  const rawModelCall = validateRawModelCall(spec, modelCalls);
  return {
    candidate: candidate ?? null,
    candidateId: candidate?.id ?? blockedMetadata!.id as string,
    route: candidate?.route ?? blockedMetadata!.route as string,
    contextHash: candidate?.contextHash ?? blockedMetadata!.contextHash as string,
    textHash: candidate?.text
      ? createHash("sha256").update(candidate.text).digest("hex")
      : blockedMetadata!.textHash as string,
    characterCount: candidate?.text.length ?? blockedMetadata!.characterCount as number,
    contract,
    factGuardPassed: factGuard.ok,
    factGuardErrors: Array.isArray(factGuard.errors)
      ? factGuard.errors.filter((item): item is string => typeof item === "string")
      : [],
    promptProfile: typeof adapter?.profile === "string" ? adapter.profile : null,
    rawModelCall,
  };
}

function buildBaseResult(
  input: CompareWriterModelsInput,
  leftSpec: WriterComparisonSpec,
  left: ExtractedPreview,
  rightSpec: WriterComparisonSpec,
  right: ExtractedPreview,
): WriterModelComparisonResult {
  return {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    seed: input.seed ?? null,
    strategy: input.strategy ?? (input.sceneSolution ? "scene" : "raw"),
    sampleIndex: input.sampleIndex ?? 1,
    winner: null,
    decisionReason: "pending",
    contractEqual: true,
    contextEqual: true,
    reverseConsistent: false,
    candidates: {
      [leftSpec.id]: candidateMetrics(left),
      [rightSpec.id]: candidateMetrics(right),
    },
    judge: {
      route: "v2_literary_judge",
      reverseReviewed: false,
      conflicted: false,
      degraded: false,
      roundCount: 0,
      auditSummaryHash: null,
    },
    admission: {
      sampleCount: 1,
      requiredSampleCount: 3,
      requiredWinRate: 0.55,
      defaultSwitchEligible: false,
    },
  };
}

function candidateMetrics(preview: ExtractedPreview): WriterCandidateMetrics {
  const actualModel = preview.rawModelCall.actualModel ?? preview.rawModelCall.model ?? "unknown";
  return {
    model: actualModel,
    route: preview.route,
    promptProfile: preview.promptProfile,
    textHash: preview.textHash,
    characterCount: preview.characterCount,
    durationMs: preview.rawModelCall.durationMs,
    factGuardPassed: preview.factGuardPassed,
    factGuardErrorCount: preview.factGuardErrors.length,
    factGuardErrorHashes: preview.factGuardErrors.map(hashText),
    requestedRoute: preview.rawModelCall.requestedRoute ?? preview.rawModelCall.route,
    actualProvider: preview.rawModelCall.actualProvider ?? preview.rawModelCall.provider ?? "unknown",
    actualModel,
    finishReason: preview.rawModelCall.finishReason ?? null,
  };
}

function validateRawModelCall(
  spec: WriterComparisonSpec,
  modelCalls: ModelCallEntry[] | undefined,
): ModelCallEntry {
  const writer = spec.id;
  const call = modelCalls?.find((entry) =>
    entry.kind === "raw_chapter" && entry.route === "v2_rawstage2" && entry.failed !== true);
  if (!call) throw new Error(`${writer} raw production route telemetry is missing`);
  const requestedRoute = call.requestedRoute ?? call.route;
  const actualProvider = call.actualProvider ?? call.provider;
  const actualModel = call.actualModel ?? call.model;
  if (requestedRoute !== spec.expectedRoute) {
    throw new Error(`${writer} raw route mismatch: expected ${spec.expectedRoute}, received ${requestedRoute}`);
  }
  if (actualProvider !== spec.expectedProvider) {
    throw new Error(`${writer} raw provider mismatch: expected ${spec.expectedProvider}, received ${actualProvider ?? "missing"}`);
  }
  if (actualModel !== spec.expectedModel) {
    throw new Error(`${writer} raw model mismatch: expected ${spec.expectedModel}, received ${actualModel ?? "missing"}`);
  }
  return call;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashOptionalText(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? hashText(value) : null;
}

function neutralCandidate(candidate: Candidate, id: string): Candidate {
  return { ...candidate, id, model: "anonymous-writer", route: "anonymous-writer" };
}

function contractToIntent(contract: ChapterContract): ChapterIntent {
  return {
    chapterFunction: contract.chapterFunction.join("；"),
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
    sourceRefs: ["chapter-contract:model-comparison"],
    concreteDelivery: [...contract.eventSummaries, ...contract.mustInclude, ...contract.stateChanges],
    choicesAndCosts: [],
    expectedIrreversibleChange: [],
    causalEndPressure: [],
    factAndCharacterKnowledgeForbiddenZones: [...contract.stateConstraints],
    underSpecifiedFields: [],
  };
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
