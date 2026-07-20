/**
 * Retired compatibility surface for the former fixed scene-solution generator.
 *
 * A three-chapter human preference was incorrectly promoted into a global
 * production treatment. Production now starts from unconstrained raw and only
 * creates span-supported editorial candidates. This module performs no model
 * calls and can never produce a production candidate.
 */

import type { Candidate } from "./types.js";
import type { UnifiedOrchestratorInput } from "./orchestrator-types.js";
import type { PromptPatternResolution } from "./prompt-pattern-library.js";
import type { SceneSolutionCard, SceneSolutionSearchResult } from "./scene-solution-search.js";

export const POSITIVE_GAIN_PRODUCTION_ADMISSION = {
  strategyId: "scene-solution-search-b",
  candidateArm: "B",
  evidenceRef: "reports/model-comparison/gemini-continuous-ceiling/gemini-limit-continuous-20260720/human-review/human-review-template.json",
  evidenceCaseCount: 3,
  continuousSequenceCount: 2,
  humanDecisionCount: 1,
  humanWinner: "sequence_b",
  strictAdmissionStatus: "retired_from_production",
  deploymentPolicy: "historical_evidence_only_no_global_extrapolation",
} as const;

export interface PositiveGainCandidateTrace {
  status: "generated" | "fallback_raw";
  admission: typeof POSITIVE_GAIN_PRODUCTION_ADMISSION;
  referenceUsed: false;
  rawBaselineMutated: false;
  sceneRetryCount: number;
  sceneCandidateCount: number;
  selectedSceneId: string | null;
  selectedSceneIds: string[];
  promptPatternIds: string[];
  generatedCandidateIds: string[];
  candidateFailures: Array<{ sceneId: string; mode: SceneSolutionCard["mode"]; reason: string }>;
  failureReason: string | null;
}

export interface PositiveGainCandidateResult {
  status: "generated" | "fallback_raw";
  candidates: Candidate[];
  sceneSearch: SceneSolutionSearchResult | null;
  trace: PositiveGainCandidateTrace;
}

export interface GeneratePositiveGainCandidatesInput {
  input: UnifiedOrchestratorInput;
  promptPatternResolution: PromptPatternResolution;
  candidateLimit?: 1 | 2;
}

export async function generatePositiveGainCandidates(
  request: GeneratePositiveGainCandidatesInput,
): Promise<PositiveGainCandidateResult> {
  void request;
  return {
    status: "fallback_raw",
    candidates: [],
    sceneSearch: null,
    trace: {
      status: "fallback_raw",
      admission: POSITIVE_GAIN_PRODUCTION_ADMISSION,
      referenceUsed: false,
      rawBaselineMutated: false,
      sceneRetryCount: 0,
      sceneCandidateCount: 0,
      selectedSceneId: null,
      selectedSceneIds: [],
      promptPatternIds: [],
      generatedCandidateIds: [],
      candidateFailures: [],
      failureReason: "global_scene_candidate_admission_retired",
    },
  };
}
