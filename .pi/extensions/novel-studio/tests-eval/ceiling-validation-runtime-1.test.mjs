/** CEILING-VALIDATION-RUNTIME-1: isolate provider health between cases. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isProviderUnhealthy,
  markProviderUnhealthy,
} from "../dist-eval/api/fallback-manager.js";
import { prepareIsolatedCeilingCase } from "../dist-eval/novelbench/ceiling-validation-runtime.js";
import {
  parseCeilingArmIds,
  runBoundedCeilingOperation,
} from "../dist-eval/novelbench/ceiling-validation-runtime.js";

test("each ceiling case clears module-level provider health before generation", () => {
  markProviderUnhealthy("claude");
  assert.equal(isProviderUnhealthy("claude"), true);

  prepareIsolatedCeilingCase();

  assert.equal(isProviderUnhealthy("claude"), false);
});

test("bounded ceiling operation retries one transient same-model failure", async () => {
  const attempts = [];
  const value = await runBoundedCeilingOperation({
    maxAttempts: 2,
    operation: async (attempt) => {
      attempts.push(attempt);
      if (attempt === 1) throw new Error("transient 502");
      return "valid-artifact";
    },
  });

  assert.equal(value, "valid-artifact");
  assert.deepEqual(attempts, [1, 2]);
});

test("bounded ceiling operation hard-fails after its declared limit", async () => {
  let calls = 0;
  await assert.rejects(() => runBoundedCeilingOperation({
    maxAttempts: 2,
    operation: async () => {
      calls += 1;
      throw new Error(`failure-${calls}`);
    },
  }), /failure-2/);
  assert.equal(calls, 2);
});

test("ceiling arm parser supports an independent A/B validation artifact", () => {
  assert.deepEqual(parseCeilingArmIds([]), ["A", "B", "C"]);
  assert.deepEqual(parseCeilingArmIds(["--arms", "A,B"]), ["A", "B"]);
  assert.throws(() => parseCeilingArmIds(["--arms", "A,C"]), /must include A and B/);
  assert.throws(() => parseCeilingArmIds(["--arms", "A,B,D"]), /A,B,C/);
});
