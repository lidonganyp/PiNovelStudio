/** Editorial candidate routing must follow the chapter's writer family. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveEditorialCandidateRoute,
} from "../dist/v2/core/editorial-candidate-generator.js";

test("default Gemini writer profiles keep editorial generation on the Gemini route", () => {
  // GEMINI38-FLASH-PRODUCTION-RESTORE-1：Gemini 3.8 Flash 复任生产主写；
  // editorial 候选生成使用 v2_amplified_gemini31，与 raw 路由同 family。
  assert.equal(resolveEditorialCandidateRoute("gemini_writer_v1"), "v2_amplified_gemini31");
  assert.equal(resolveEditorialCandidateRoute("gemini_writer_v2"), "v2_amplified_gemini31");
});

test("explicit Claude and non-Gemini writer profiles keep the isolated Claude editorial route", () => {
  assert.equal(resolveEditorialCandidateRoute("claude_writer_v1"), "v2_amplified");
  assert.equal(resolveEditorialCandidateRoute("generic_writer_v1"), "v2_amplified");
});

test("retired gpt-6-astra writer profile no longer maps to any production editorial route", () => {
  // GPT6-ASTRA-PRODUCTION-SWITCH-1 的 gpt_writer_v1 生产分支已随 v4.35.0 删除；
  // 剩余 gpt_writer_v1 profile（eval 路由 nb4_generate_gpt56 等）回落 Claude 隔离路由。
  assert.equal(resolveEditorialCandidateRoute("gpt_writer_v1"), "v2_amplified");
});
