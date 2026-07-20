/**
 * CEILING-VALIDATION-ADMISSION-1 batch quality admission.
 *
 * This module deliberately separates quantitative validation from production
 * admission. A 15-case model/judge run may advance a strategy to frozen
 * verification, but it cannot synthesize continuity, human, or user evidence.
 */

export interface CeilingArmObservation {
  average: number;
  coreMinimum: number;
  referenceAdjustedGap: number;
  hardRegression: boolean;
}

export interface CeilingValidationObservation {
  caseId: string;
  generatorSuccess: boolean;
  judgeSchemaValid: boolean;
  provenanceValid: boolean;
  referenceIsolationValid: boolean;
  needsHumanReview: boolean;
  control: CeilingArmObservation;
  treatment: CeilingArmObservation;
  /** Mean delta for active protagonist, rule information, and state delta. */
  coreThreeDelta: number;
}

export interface CeilingValidationAdmissionInput {
  observations: CeilingValidationObservation[];
  frozenPassed?: boolean;
  continuousPassed?: boolean;
  humanAligned?: boolean;
  userUtilityImproved?: boolean;
}

export type CeilingValidationAdmissionStatus =
  | "blocked"
  | "no_positive_evidence"
  | "advance_to_frozen"
  | "production_eligible";

export interface CeilingValidationAdmissionMetrics {
  observationCount: number;
  distinctCaseCount: number;
  generatorSuccessRate: number;
  schemaValidRate: number;
  provenanceValidRate: number;
  isolationValidRate: number;
  treatmentWinRate: number;
  treatmentAbsolutePassRate: number;
  meanControlAverage: number;
  meanTreatmentAverage: number;
  meanReferenceAdjustedDelta: number;
  meanCoreThreeDelta: number;
}

export interface CeilingValidationAdmissionDecision {
  status: CeilingValidationAdmissionStatus;
  canAdvanceToFrozen: boolean;
  canEnterProduction: boolean;
  reasons: string[];
  metrics: CeilingValidationAdmissionMetrics;
}

const MIN_DISTINCT_CASES = 15;
const MIN_GENERATOR_SUCCESS_RATE = 0.9;
const MIN_TREATMENT_WIN_RATE = 0.55;
const MIN_ABSOLUTE_PASS_RATE = 0.55;
const MIN_CORE_THREE_DELTA = 0.5;

export function evaluateCeilingValidationAdmission(
  input: CeilingValidationAdmissionInput,
): CeilingValidationAdmissionDecision {
  const metrics = summarize(input.observations);
  const reasons: string[] = [];

  if (metrics.schemaValidRate < 1) reasons.push("judge_schema_invalid");
  if (metrics.provenanceValidRate < 1) reasons.push("provenance_invalid");
  if (metrics.isolationValidRate < 1) reasons.push("reference_isolation_invalid");
  if (reasons.length > 0) {
    return decision("blocked", false, false, reasons, metrics);
  }

  if (metrics.distinctCaseCount < MIN_DISTINCT_CASES) reasons.push("insufficient_distinct_cases");
  if (metrics.generatorSuccessRate < MIN_GENERATOR_SUCCESS_RATE) reasons.push("generator_success_rate_below_0.9");
  if (metrics.treatmentWinRate < MIN_TREATMENT_WIN_RATE) reasons.push("treatment_win_rate_below_0.55");
  if (metrics.treatmentAbsolutePassRate < MIN_ABSOLUTE_PASS_RATE) reasons.push("absolute_pass_rate_below_0.55");
  if (metrics.meanCoreThreeDelta < MIN_CORE_THREE_DELTA) reasons.push("core_three_delta_below_0.5");
  if (metrics.meanReferenceAdjustedDelta <= 0) reasons.push("reference_adjusted_gain_missing");
  if (reasons.length > 0) {
    return decision("no_positive_evidence", false, false, reasons, metrics);
  }

  const productionMissing: string[] = [];
  if (!input.frozenPassed) productionMissing.push("frozen_validation_missing");
  if (!input.continuousPassed) productionMissing.push("continuous_validation_missing");
  if (!input.humanAligned) productionMissing.push("human_alignment_missing");
  if (!input.userUtilityImproved) productionMissing.push("user_utility_missing");
  if (productionMissing.length > 0) {
    return decision("advance_to_frozen", true, false, productionMissing, metrics);
  }

  return decision("production_eligible", true, true, ["all_production_gates_passed"], metrics);
}

function summarize(observations: CeilingValidationObservation[]): CeilingValidationAdmissionMetrics {
  const total = observations.length;
  const successful = observations.filter((item) => item.generatorSuccess);
  const validComparisons = successful.filter((item) => (
    item.judgeSchemaValid && item.provenanceValid && item.referenceIsolationValid
  ));
  const wins = validComparisons.filter((item) => (
    item.treatment.referenceAdjustedGap > item.control.referenceAdjustedGap
    && !item.treatment.hardRegression
  ));
  const absolutePasses = validComparisons.filter((item) => (
    item.treatment.average >= 4
    && item.treatment.coreMinimum >= 3
    && !item.treatment.hardRegression
  ));
  return {
    observationCount: total,
    distinctCaseCount: new Set(observations.map((item) => item.caseId)).size,
    generatorSuccessRate: ratio(successful.length, total),
    schemaValidRate: ratio(observations.filter((item) => item.judgeSchemaValid).length, total),
    provenanceValidRate: ratio(observations.filter((item) => item.provenanceValid).length, total),
    isolationValidRate: ratio(observations.filter((item) => item.referenceIsolationValid).length, total),
    treatmentWinRate: ratio(wins.length, validComparisons.length),
    treatmentAbsolutePassRate: ratio(absolutePasses.length, validComparisons.length),
    meanControlAverage: mean(validComparisons.map((item) => item.control.average)),
    meanTreatmentAverage: mean(validComparisons.map((item) => item.treatment.average)),
    meanReferenceAdjustedDelta: mean(validComparisons.map((item) => (
      item.treatment.referenceAdjustedGap - item.control.referenceAdjustedGap
    ))),
    meanCoreThreeDelta: mean(validComparisons.map((item) => item.coreThreeDelta)),
  };
}

function decision(
  status: CeilingValidationAdmissionStatus,
  canAdvanceToFrozen: boolean,
  canEnterProduction: boolean,
  reasons: string[],
  metrics: CeilingValidationAdmissionMetrics,
): CeilingValidationAdmissionDecision {
  return { status, canAdvanceToFrozen, canEnterProduction, reasons, metrics };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
