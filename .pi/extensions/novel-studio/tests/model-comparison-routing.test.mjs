/**
 * Model comparison route locks and preview-only contract.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { resolveModelTestRouteLock } from "../dist/v2/core/unified-entry.js";
import { registerTools } from "../dist/tools/register-tools.js";
import { getGeminiWriterModel } from "../dist/utils/config.js";

const routing = JSON.parse(readFileSync(resolve(process.cwd(), "../../../config/model-routing.json"), "utf8"));

test("doubao comparison locks generation to the lab Doubao route", () => {
  assert.deepEqual(resolveModelTestRouteLock("doubao"), {
    generateRoute: "nb4_generate_doubao",
    judgeRoute: "v2_opportunity_judge",
    provider: "doubao",
    model: "doubao-seed-2-1-pro-260628",
  });
});

test("gpt56 comparison locks generation to the dedicated GPT-5.6-sol route", () => {
  assert.deepEqual(resolveModelTestRouteLock("gpt56"), {
    generateRoute: "nb4_generate_gpt56",
    judgeRoute: "v2_opportunity_judge",
    provider: "gpt",
    model: "gpt-5.6-sol",
  });
});

test("claude48 comparison locks generation to Claude Opus 4.8", () => {
  assert.deepEqual(resolveModelTestRouteLock("claude48"), {
    generateRoute: "nb4_generate_claude48",
    judgeRoute: "v2_opportunity_judge",
    provider: "claude",
    model: "claude-opus-4-8",
  });
});

test("fable5 comparison locks generation to Claude Fable 5", () => {
  assert.deepEqual(resolveModelTestRouteLock("fable5"), {
    generateRoute: "nb4_generate_fable5",
    judgeRoute: "v2_opportunity_judge",
    provider: "claude",
    model: "claude-fable-5",
  });
});

test("grok45 comparison locks generation to Grok 4.5", () => {
  assert.deepEqual(resolveModelTestRouteLock("grok45"), {
    generateRoute: "nb4_generate_grok45",
    judgeRoute: "v2_opportunity_judge",
    provider: "grok45",
    model: "grok-4.5",
  });
});

test("gemini31 comparison locks generation to the .env-configured writer model", () => {
  // WRITER-ENV-UNIFY-1：gemini31 只是稳定路由标识；
  // 实际生成模型由 .env GEMINI_MODEL 解析（与其他 comparison 路由的固定模型不同）。
  assert.deepEqual(resolveModelTestRouteLock("gemini31"), {
    generateRoute: "nb4_generate_gemini31",
    judgeRoute: "v2_opportunity_judge",
    provider: "gemini31",
    model: getGeminiWriterModel(),
  });
});

test("public chapter tool no longer exposes modelTestRoute (eval-only comparison route removed from schema)", () => {
  const handlers = new Proxy({}, { get: () => async () => ({}) });
  const chapterTool = registerTools(handlers).find((tool) => tool.name === "novel_generate_chapter");
  assert.ok(chapterTool);
  // PRODUCTION-ROLLOUT-AUDIT-1 P0-1b/P0-10：modelTestRoute 已从公开 schema 移除。
  // 显式模型对比路由是 eval-only 能力，生产路径不接受；内部 handler 仍保留供评测入口直调。
  assert.equal(
    chapterTool.parameters.properties.modelTestRoute,
    undefined,
    "modelTestRoute 已从公开 schema 移除（eval-only 模型对比路由）",
  );
});

test("long-form comparison routes receive explicit model-specific output budgets", () => {
  assert.equal(routing.providers.claude.temperature.nb4_generate_claude48, 0.72);
  assert.equal(routing.providers.claude.max_tokens.nb4_generate_claude48, 16384);
  assert.equal(routing.providers.claude.temperature.nb4_generate_fable5, 0.72);
  assert.equal(routing.providers.claude.max_tokens.nb4_generate_fable5, 8192);
  assert.equal(routing.providers.grok45.protocol, "openai");
  assert.equal(routing.providers.grok45.temperature.nb4_generate_grok45, 0.72);
  assert.equal(routing.providers.grok45.max_tokens.nb4_generate_grok45, 16384);
  assert.equal(routing.providers.gemini31.protocol, "openai");
  assert.equal(routing.providers.gemini31.temperature.nb4_generate_gemini31, 0.72);
  assert.equal(routing.providers.gemini31.max_tokens.nb4_generate_gemini31, 16384);
});

test("new comparison routes use isolated model env overrides (gemini31 unified to .env writer config)", () => {
  assert.deepEqual(routing.agent_routing.nb4_generate_claude48, {
    provider: "claude",
    model: "claude-opus-4-8",
    base_url_env: "CLAUDE48_BASE_URL",
    api_key_env: "CLAUDE48_API_KEY",
    model_env: "CLAUDE48_MODEL",
    fallback: [],
    lab_testing: true,
    note: "Isolated chapter comparison route for Claude Opus 4.8.",
  });
  assert.deepEqual(routing.agent_routing.nb4_generate_fable5, {
    provider: "claude",
    model: "claude-fable-5",
    base_url_env: "FABLE5_BASE_URL",
    api_key_env: "FABLE5_API_KEY",
    model_env: "FABLE5_MODEL",
    fallback: [],
    lab_testing: true,
    note: "Isolated chapter comparison route for Claude Fable 5.",
  });
  assert.deepEqual(routing.agent_routing.nb4_generate_grok45, {
    provider: "grok45",
    model: "grok-4.5",
    base_url_env: "GROK45_BASE_URL",
    api_key_env: "GROK45_API_KEY",
    model_env: "GROK45_MODEL",
    fallback: [],
    lab_testing: true,
    note: "Isolated chapter comparison route for Grok 4.5.",
  });
  // WRITER-ENV-UNIFY-1：gemini31 不再用独立 GEMINI31_* env，
  // 与生产写路由统一读取 .env GEMINI_MODEL / GOOGLE_GEMINI_BASE_URL / GEMINI_API_KEY。
  assert.deepEqual(routing.agent_routing.nb4_generate_gemini31, {
    provider: "gemini31",
    model: "${GEMINI_MODEL}",
    base_url_env: "GOOGLE_GEMINI_BASE_URL",
    api_key_env: "GEMINI_API_KEY",
    model_env: "GEMINI_MODEL",
    fallback: [],
    lab_testing: true,
    note: "Isolated chapter comparison route for Gemini 3.8 Flash.",
  });
});

test("unknown comparison routes remain unlocked", () => {
  assert.equal(resolveModelTestRouteLock("claude"), null);
  assert.equal(resolveModelTestRouteLock(undefined), null);
});
