/** CEILING-BASELINE-MATRIX-1 / CEILING-CONTINUOUS-CHAPTERS-1 evaluator helpers. */

import { CEILING_DIMENSION_IDS, type CeilingDimensionId } from "../novelos/eval/ceiling-judge-schema.js";

export type CeilingExperimentArm = "C1" | "C2" | "best_of_3" | "raw_control" | "solution_search_raw";
export type CeilingWriterModel = "claude" | "gemini31";
export type CeilingStrategy = "raw" | "scene" | "oracle_scene";

export interface CeilingRunPlanEntry {
  runId: string;
  model: CeilingWriterModel;
  strategy: CeilingStrategy;
  sampleIndex: number;
}

export interface BestOfKSummary {
  sampleCount: number;
  passAt1Average: number | null;
  bestOfKAverage: number | null;
  qualityLift: number | null;
  hasAbsolutePass: boolean;
}

export interface AbsoluteQualitySummary {
  levels: Record<CeilingDimensionId, number>;
  average: number;
  coreMinimum: number;
  hardRegression: boolean;
}

export interface BaselineArmSummary {
  arm: CeilingExperimentArm;
  sampleCount: number;
  passAt1: number;
  meanAverage: number;
  medianAverage: number;
  bestOf3Average: number | null;
  absolutePassRate: number;
}

export interface BaselineMatrixResult {
  caseId: string;
  arms: BaselineArmSummary[];
  status: "no_positive_evidence" | "relative_gain_only" | "absolute_quality_gain";
}

export interface ChapterFrontierObservation {
  chapterId: string;
  accepted: boolean;
  activeProtagonist: number;
  stateDelta: number;
  hookType: string;
  continuityHardFailure: boolean;
  userReworkCount: number;
}

export interface ContinuousChapterResult {
  valid: boolean;
  status: "pass" | "degraded" | "invalid";
  errors: string[];
  metrics: { chapterCount: number; acceptedRate: number; meanRework: number; hookRepeatCount: number };
}

export function summarizeAbsoluteQuality(input: {
  levels: Record<CeilingDimensionId, number>;
  hardRegression?: boolean;
}): AbsoluteQualitySummary {
  const values = CEILING_DIMENSION_IDS.map((id) => input.levels[id]);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const core = ["active_protagonist", "rule_information_gain", "scene_state_delta", "chapter_end_causal_pressure"] as const;
  return {
    levels: input.levels,
    average,
    coreMinimum: Math.min(...core.map((id) => input.levels[id])),
    hardRegression: input.hardRegression ?? false,
  };
}

export function aggregateBaselineArm(arm: CeilingExperimentArm, summaries: AbsoluteQualitySummary[]): BaselineArmSummary {
  const scores = summaries.map((summary) => summary.average).sort((a, b) => a - b);
  const medianAverage = scores.length === 0 ? 0 : scores[Math.floor((scores.length - 1) / 2)];
  const absolutePassRate = summaries.length === 0 ? 0 : summaries.filter((summary) => summary.average >= 4 && summary.coreMinimum >= 3 && !summary.hardRegression).length / summaries.length;
  const best = summaries.length >= 3 ? Math.max(...summaries.slice(0, 3).map((summary) => summary.average)) : null;
  return {
    arm,
    sampleCount: summaries.length,
    passAt1: absolutePassRate,
    meanAverage: scores.length === 0 ? 0 : scores.reduce((sum, value) => sum + value, 0) / scores.length,
    medianAverage,
    bestOf3Average: best,
    absolutePassRate,
  };
}

/** Build independent pass@k trials without mixing models or generation strategies. */
export function buildCeilingRunPlan(input: {
  models: CeilingWriterModel[];
  strategies: CeilingStrategy[];
  samplesPerStrategy: number;
}): CeilingRunPlanEntry[] {
  if (!Number.isInteger(input.samplesPerStrategy) || input.samplesPerStrategy < 1 || input.samplesPerStrategy > 10) {
    throw new Error("samplesPerStrategy must be an integer between 1 and 10");
  }
  const entries: CeilingRunPlanEntry[] = [];
  for (const model of input.models) {
    for (const strategy of input.strategies) {
      for (let sampleIndex = 1; sampleIndex <= input.samplesPerStrategy; sampleIndex += 1) {
        entries.push({
          runId: `${model}:${strategy}:${sampleIndex}`,
          model,
          strategy,
          sampleIndex,
        });
      }
    }
  }
  return entries;
}

/** Summarize actual pass@k: first sample is pass@1, maximum valid sample is best-of-k. */
export function summarizeBestOfK(summaries: AbsoluteQualitySummary[]): BestOfKSummary {
  if (summaries.length === 0) {
    return {
      sampleCount: 0,
      passAt1Average: null,
      bestOfKAverage: null,
      qualityLift: null,
      hasAbsolutePass: false,
    };
  }
  const passAt1Average = summaries[0].average;
  const best = summaries.reduce((winner, candidate) =>
    candidate.average > winner.average ? candidate : winner,
  );
  return {
    sampleCount: summaries.length,
    passAt1Average,
    bestOfKAverage: best.average,
    qualityLift: best.average - passAt1Average,
    hasAbsolutePass: best.average >= 4 && best.coreMinimum >= 3 && !best.hardRegression,
  };
}

export function compareBaselineMatrix(caseId: string, arms: Array<{ arm: CeilingExperimentArm; summaries: AbsoluteQualitySummary[] }>): BaselineMatrixResult {
  const results = arms.map(({ arm, summaries }) => aggregateBaselineArm(arm, summaries));
  const control = results.find((result) => result.arm === "raw_control" || result.arm === "C1");
  const solution = results.find((result) => result.arm === "solution_search_raw" || result.arm === "C2");
  const relative = control && solution && solution.meanAverage > control.meanAverage && solution.absolutePassRate >= control.absolutePassRate;
  const absolute = solution?.absolutePassRate !== undefined && solution.absolutePassRate > 0;
  return { caseId, arms: results, status: relative && absolute ? "absolute_quality_gain" : relative ? "relative_gain_only" : "no_positive_evidence" };
}

export function validateContinuousChapters(observations: ChapterFrontierObservation[]): ContinuousChapterResult {
  const errors: string[] = [];
  if (observations.length < 3) errors.push("continuous_run_requires_at_least_3_chapters");
  const acceptedRate = observations.length === 0 ? 0 : observations.filter((item) => item.accepted).length / observations.length;
  const meanRework = observations.length === 0 ? 0 : observations.reduce((sum, item) => sum + item.userReworkCount, 0) / observations.length;
  const hookTypes = observations.map((item) => item.hookType).filter(Boolean);
  const hookRepeatCount = hookTypes.length - new Set(hookTypes).size;
  if (observations.some((item) => item.continuityHardFailure)) errors.push("continuity_hard_failure");
  if (observations.some((item) => item.activeProtagonist < 3 || item.stateDelta < 1)) errors.push("core_state_quality_regressed");
  if (hookRepeatCount > 0) errors.push("hook_type_repeated");
  const status = errors.length === 0 ? "pass" : observations.length < 3 ? "invalid" : "degraded";
  return { valid: status !== "invalid", status, errors, metrics: { chapterCount: observations.length, acceptedRate, meanRework, hookRepeatCount } };
}
