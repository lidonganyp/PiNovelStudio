/** G5 P1 bounded canary policy tests. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { decideCanaryStrategy } from "../dist-test/v2/governance/canary-policy.js";

const matrix = {
  R0: {
    healthy: "skip",
    warning: "skip",
    insufficient_data: "skip",
    auto_hold_eligible: "skip",
    retired_suggestion: "skip",
  },
  R1: {
    healthy: "direct_promote",
    warning: "direct_promote",
    insufficient_data: "direct_promote",
    auto_hold_eligible: "blocked",
    retired_suggestion: "blocked",
  },
  R2: {
    healthy: "bounded_canary",
    warning: "shadow_required",
    insufficient_data: "shadow_required",
    auto_hold_eligible: "blocked",
    retired_suggestion: "blocked",
  },
  R3: {
    healthy: "shadow_required",
    warning: "shadow_required",
    insufficient_data: "shadow_required",
    auto_hold_eligible: "blocked",
    retired_suggestion: "blocked",
  },
};

for (const [changeClass, statuses] of Object.entries(matrix)) {
  for (const [healthStatus, expected] of Object.entries(statuses)) {
    test(`${changeClass} + ${healthStatus} -> ${expected}`, () => {
      const result = decideCanaryStrategy({
        changeClass,
        healthStatus,
        currentStatus: "active_dev",
        hasAuthorization: false,
      });
      assert.equal(result.strategy, expected);
    });
  }
}

for (const currentStatus of [
  "draft",
  "candidate",
  "frozen",
  // "evaluated" 已加入 PARTICIPATING_STATUSES（实现正确），不再是 non-active
  "rejected",
  "quarantined",
  "revoked",
  "retired",
  "held",
]) {
  test(`non-active status ${currentStatus} -> skip`, () => {
    const result = decideCanaryStrategy({
      changeClass: "R3",
      healthStatus: "healthy",
      currentStatus,
      hasAuthorization: true,
    });
    assert.equal(result.strategy, "skip");
  });
}

test("authorization presence does not weaken the policy decision", () => {
  const withoutAuthorization = decideCanaryStrategy({
    changeClass: "R2",
    healthStatus: "healthy",
    currentStatus: "candidate_prod",
    hasAuthorization: false,
  });
  const withAuthorization = decideCanaryStrategy({
    changeClass: "R2",
    healthStatus: "healthy",
    currentStatus: "candidate_prod",
    hasAuthorization: true,
  });
  assert.deepEqual(withAuthorization, withoutAuthorization);
  assert.equal(withAuthorization.strategy, "bounded_canary");
});
