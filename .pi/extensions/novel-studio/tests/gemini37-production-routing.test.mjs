/**
 * Production Gemini model switch contract.
 *
 * This test intentionally starts RED while the live writer identity is still
 * Gemini 3.1 Pro. It protects the full production route, not eval-only routes.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { resolveWriterModelRouteLock } from "../dist/v2/core/unified-entry.js";

const routing = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../../config/model-routing.json"), "utf8"),
);

const routingRaw = readFileSync(
  resolve(process.cwd(), "../../../config/model-routing.json"),
  "utf8",
);

test("routing config carries no stale Gemini 3.1 Pro writer identity", () => {
  assert.ok(
    !routingRaw.includes("gemini-3.1-pro"),
    "config/model-routing.json must not reference gemini-3.1-pro after the 3.7 Flash switch",
  );
});

test("production Gemini writer identity is Gemini 3.7 Flash across config and runtime lock", () => {
  const expectedModel = "gemini-3.7-flash";
  assert.equal(routing.model_strategy.narrator_primary, expectedModel);
  assert.equal(routing.stage_routing.stage2_narrator.model, expectedModel);
  assert.equal(routing.agent_routing.narrator_primary.model, expectedModel);
  assert.equal(routing.agent_routing.v2_rawstage2_gemini31.model, expectedModel);
  assert.equal(routing.agent_routing.v2_amplified_gemini31.model, expectedModel);
  assert.equal(routing.providers.gemini31.model, expectedModel);
  assert.equal(resolveWriterModelRouteLock(undefined)?.model, expectedModel);
});
