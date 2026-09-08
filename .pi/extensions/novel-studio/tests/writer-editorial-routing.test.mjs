/** Editorial candidate routing must follow the chapter's writer family. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveEditorialCandidateRoute,
} from "../dist/v2/core/editorial-candidate-generator.js";

test("default gpt writer profile keeps editorial generation on the gpt-6-astra route", () => {
  assert.equal(resolveEditorialCandidateRoute("gpt_writer_v1"), "v2_amplified_gpt6astra");
});

test("explicit Claude and non-gpt writer profiles keep the isolated Claude editorial route", () => {
  assert.equal(resolveEditorialCandidateRoute("claude_writer_v1"), "v2_amplified");
  assert.equal(resolveEditorialCandidateRoute("generic_writer_v1"), "v2_amplified");
});

test("retired Gemini writer profiles stay on the retained eval Gemini route (never Claude)", () => {
  // GPT6-ASTRA-PRODUCTION-SWITCH-1：生产 Gemini 写路由已删除；gemini profile 仅出现在
  // modelTestRoute=gemini31 等 lab 路径（实际调用被 lock wrapper 覆盖）。返回保留的
  // eval 路由以维持 family 隔离，绝不静默切到 Claude。
  assert.equal(resolveEditorialCandidateRoute("gemini_writer_v1"), "nb4_generate_gemini31");
  assert.equal(resolveEditorialCandidateRoute("gemini_writer_v2"), "nb4_generate_gemini31");
});
