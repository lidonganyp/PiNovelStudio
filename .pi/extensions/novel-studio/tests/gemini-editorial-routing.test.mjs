/** Gemini must remain the default writer for ordinary editorial candidates. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveEditorialCandidateRoute,
} from "../dist/v2/core/editorial-candidate-generator.js";

test("Gemini writer profiles keep ordinary editorial generation on Gemini", () => {
  assert.equal(resolveEditorialCandidateRoute("gemini_writer_v1"), "v2_amplified_gemini31");
  assert.equal(resolveEditorialCandidateRoute("gemini_writer_v2"), "v2_amplified_gemini31");
});

test("explicit Claude and non-Gemini writer profiles keep the isolated Claude editorial route", () => {
  assert.equal(resolveEditorialCandidateRoute("claude_writer_v1"), "v2_amplified");
  assert.equal(resolveEditorialCandidateRoute("generic_writer_v1"), "v2_amplified");
});

