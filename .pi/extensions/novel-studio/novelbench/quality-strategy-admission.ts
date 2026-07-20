/** QUALITY-STRATEGY-ADMISSION-1 evaluator-only strategy gate. */

export type QualityStrategyStatus = "candidate" | "dormant" | "retired" | "blocked" | "production_eligible";

export interface QualityStrategyEvidence {
  strategyId: string;
  modelVersion: string;
  sceneType: string;
  relativeGain: boolean;
  absoluteQualityPass: boolean;
  continuousPass: boolean;
  humanAligned: boolean;
  userUtilityImproved: boolean;
  judgeSchemaValid: boolean;
  provenanceValid: boolean;
  negativeRuns: number;
  crossWorkNegativeRuns: number;
}

export interface QualityStrategyDecision {
  status: QualityStrategyStatus;
  reasons: string[];
  canEnterProduction: boolean;
}

export function evaluateQualityStrategyAdmission(evidence: QualityStrategyEvidence): QualityStrategyDecision {
  const reasons: string[] = [];
  if (!evidence.judgeSchemaValid) return { status: "blocked", reasons: ["judge_schema_invalid"], canEnterProduction: false };
  if (!evidence.provenanceValid) return { status: "blocked", reasons: ["provenance_invalid"], canEnterProduction: false };
  if (evidence.crossWorkNegativeRuns >= 2) return { status: "retired", reasons: ["cross_work_negative_evidence"], canEnterProduction: false };
  if (evidence.negativeRuns >= 2) return { status: "dormant", reasons: ["two_consecutive_negative_runs"], canEnterProduction: false };
  const missing: string[] = [];
  if (!evidence.relativeGain) missing.push("relative_gain_missing");
  if (!evidence.absoluteQualityPass) missing.push("absolute_quality_line_missing");
  if (!evidence.continuousPass) missing.push("continuous_chapter_validation_missing");
  if (!evidence.humanAligned) missing.push("human_alignment_missing");
  if (!evidence.userUtilityImproved) missing.push("user_utility_missing");
  if (missing.length > 0) return { status: "candidate", reasons: missing, canEnterProduction: false };
  return { status: "production_eligible", reasons: ["all_three_gates_passed"], canEnterProduction: true };
}
