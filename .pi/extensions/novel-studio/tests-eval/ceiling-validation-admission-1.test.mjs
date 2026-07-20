/** CEILING-VALIDATION-ADMISSION-1 preregistered batch decision tests. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateCeilingValidationAdmission,
} from "../dist-eval/novelbench/ceiling-validation-admission.js";

function observation(index, overrides = {}) {
  return {
    caseId: `xinmo-ch${index}`,
    generatorSuccess: true,
    judgeSchemaValid: true,
    provenanceValid: true,
    referenceIsolationValid: true,
    needsHumanReview: false,
    control: {
      average: 3.5,
      coreMinimum: 3,
      referenceAdjustedGap: -0.5,
      hardRegression: false,
    },
    treatment: {
      average: 4.25,
      coreMinimum: 4,
      referenceAdjustedGap: 0.25,
      hardRegression: false,
    },
    coreThreeDelta: 0.75,
    ...overrides,
  };
}

const passingValidation = Array.from({ length: 15 }, (_, index) => observation(index + 3));

test("15-case quantitative evidence can advance to frozen but cannot bypass human/user/continuity gates", () => {
  const result = evaluateCeilingValidationAdmission({ observations: passingValidation });
  assert.equal(result.status, "advance_to_frozen");
  assert.equal(result.canAdvanceToFrozen, true);
  assert.equal(result.canEnterProduction, false);
  assert.ok(result.reasons.includes("continuous_validation_missing"));
  assert.ok(result.reasons.includes("human_alignment_missing"));
  assert.ok(result.reasons.includes("user_utility_missing"));
});

test("production requires validation, frozen, continuity, human alignment, and user utility together", () => {
  const result = evaluateCeilingValidationAdmission({
    observations: passingValidation,
    frozenPassed: true,
    continuousPassed: true,
    humanAligned: true,
    userUtilityImproved: true,
  });
  assert.equal(result.status, "production_eligible");
  assert.equal(result.canEnterProduction, true);
});

test("fewer than 15 distinct cases never advances", () => {
  const result = evaluateCeilingValidationAdmission({ observations: passingValidation.slice(0, 14) });
  assert.equal(result.status, "no_positive_evidence");
  assert.equal(result.canAdvanceToFrozen, false);
  assert.ok(result.reasons.includes("insufficient_distinct_cases"));
});

test("one invalid judge schema or isolation failure blocks the run", () => {
  const invalidSchema = [...passingValidation];
  invalidSchema[4] = observation(7, { judgeSchemaValid: false });
  assert.equal(evaluateCeilingValidationAdmission({ observations: invalidSchema }).status, "blocked");

  const leaked = [...passingValidation];
  leaked[8] = observation(11, { referenceIsolationValid: false });
  assert.equal(evaluateCeilingValidationAdmission({ observations: leaked }).status, "blocked");
});

test("relative wins without the preregistered core delta remain diagnostic only", () => {
  const weak = passingValidation.map((item) => ({ ...item, coreThreeDelta: 0.2 }));
  const result = evaluateCeilingValidationAdmission({ observations: weak });
  assert.equal(result.status, "no_positive_evidence");
  assert.equal(result.canAdvanceToFrozen, false);
  assert.ok(result.reasons.includes("core_three_delta_below_0.5"));
});

test("duplicate chapter cases do not inflate the admission sample size", () => {
  const duplicates = Array.from({ length: 15 }, () => observation(3));
  const result = evaluateCeilingValidationAdmission({ observations: duplicates });
  assert.equal(result.metrics.distinctCaseCount, 1);
  assert.equal(result.canAdvanceToFrozen, false);
});
