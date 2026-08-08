/**
 * Regression coverage for structured Agentic failure classification.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(
  join(__dirname, "..", "dist-eval", "novelos", "agent", "agentic-raw-candidate-source.js"),
).href;

test("coverage gate failure keeps its structured failure kind", async () => {
  const mod = await import(moduleUrl);
  assert.equal(
    mod.classifyFailureKind(
      "agent loop fallback: must_verify_coverage_failed",
      "must_verify_coverage_failed",
      "empty_draft",
    ),
    "must_verify_coverage_failed",
  );
});
