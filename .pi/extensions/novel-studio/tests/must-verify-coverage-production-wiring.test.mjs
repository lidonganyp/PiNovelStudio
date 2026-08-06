/**
 * MUST-VERIFY-COVERAGE-GATE-4: production source wiring contract.
 *
 * The runtime loop behavior is covered by the eval tests. These checks keep
 * the production boundary explicit: normal generation gets the real gate,
 * while preview and offline capability ablations opt out intentionally.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sourcePath = join(
  process.cwd(),
  "novelos",
  "agent",
  "agentic-raw-candidate-source.ts",
);
const source = readFileSync(sourcePath, "utf8");

test("production source imports and injects the real must-verify gate", () => {
  assert.match(source, /createMustVerifyCoverageGate/);
  assert.match(source, /coverageGate:\s*createMustVerifyCoverageGate\(\)/);
});

test("preview and offline ablations explicitly disable the production gate", () => {
  assert.match(source, /enableCoverageGate\?:\s*boolean/);
  assert.match(source, /fullPipelinePreview\s*!==\s*true/);
  assert.match(source, /enableCoverageGate\s*=\s*capabilities\?\.enableCoverageGate\s*\?\?/);
});
