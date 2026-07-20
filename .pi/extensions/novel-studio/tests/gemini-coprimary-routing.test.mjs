/**
 * GEMINI-DEFAULT-WRITER-1: Gemini 3.1 Pro is the production default writer.
 *
 * All runtime checks use stubs. No network request is allowed from this file.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  resolveWriterModelRouteLock,
  wrapModelGenerateForWriterLock,
} from "../dist/v2/core/unified-entry.js";
import { registerTools } from "../dist/tools/register-tools.js";
import { toTypeBoxSchema } from "../dist/tools/legacy-tool-wrapper.js";
import { normalizeProviderBaseUrl } from "../dist/api/fallback-manager.js";
import { getBaseUrl, getModelOverride } from "../dist/utils/config.js";

const routing = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../../config/model-routing.json"), "utf8"),
);

test("routing records the Gemini human-alignment and search-depth evidence", () => {
  assert.equal(routing._version, "4.29.0");
  assert.deepEqual(routing.model_strategy.literary_judge_admission.evidence_paths, [
    "reports/model-comparison/human-review/gemini31-vs-claude46-human-review-2026-07-20T07-53-43-068Z/judge-detail-reader-priority.json",
    "reports/model-comparison/human-review/gemini31-vs-claude46-human-review-2026-07-20T07-53-43-068Z/judge-detail-reader-priority-gemini31-reader.json",
  ]);
  assert.match(
    routing.agent_routing.v2_literary_judge.note,
    /advisory only.*cannot decide the winner/i,
  );
});

test("Gemini is the production default writer while Claude remains an explicit option", () => {
  assert.equal(routing.model_strategy.writer_admission.default_writer, "gemini31");
  assert.equal(routing.model_strategy.narrator_primary, "gemini-3.1-pro-preview");
  assert.equal(routing.stage_routing.stage2_narrator.provider, "gemini31");
  assert.equal(routing.stage_routing.stage2_narrator.model, "gemini-3.1-pro-preview");
  assert.equal(routing.agent_routing.narrator_primary.provider, "gemini31");
  assert.equal(routing.agent_routing.narrator_primary.model, "gemini-3.1-pro-preview");
  assert.deepEqual(resolveWriterModelRouteLock(undefined), {
    rawRoute: "v2_rawstage2_gemini31",
    amplifiedRoute: "v2_amplified_gemini31",
    judgeRoute: "v2_opportunity_judge",
    provider: "gemini31",
    model: "gemini-3.1-pro-preview",
    promptProfile: "gemini_writer_v2",
  });

  const handlers = new Proxy({}, { get: () => async () => ({}) });
  const chapterTool = registerTools(handlers).find((tool) => tool.name === "novel_generate_chapter");
  assert.match(chapterTool.parameters.properties.writerModel.description, /Gemini 3\.1 Pro（默认）/);
});

test("routing declares Claude and Gemini as isolated explicit writer models", () => {
  assert.equal(routing.model_strategy.narrator_coprimary_models, undefined);
  assert.deepEqual(routing.model_strategy.explicit_writer_models, [
    "gemini-3.1-pro-preview",
    "claude-opus-4-6",
  ]);
  assert.deepEqual(routing.best_of_n_config.models, [
    "gemini-3.1-pro-preview",
    "claude-opus-4-6",
  ]);
  assert.deepEqual(routing.agent_routing.v2_rawstage2_gemini31.fallback, []);
  assert.deepEqual(routing.agent_routing.v2_amplified_gemini31.fallback, []);
  assert.equal(routing.agent_routing.v2_rawstage2.fallback.length, 0);
  assert.deepEqual(routing.best_of_n_config.judge, {
    provider: routing.agent_routing.v2_literary_judge.provider,
    model: routing.agent_routing.v2_literary_judge.model,
    fallback: [],
  });
});

test("writer admission keeps human model preference but retires cross-chapter scene extrapolation", () => {
  assert.equal(routing.model_strategy.writer_admission.default_writer, "gemini31");
  assert.deepEqual(routing.model_strategy.writer_admission.explicit_writer_options, ["gemini31", "claude"]);
  assert.equal(routing.model_strategy.writer_admission.human_override.winner, "gemini31");
  assert.equal(routing.model_strategy.writer_admission.scene_solution_admission.status, "retired_from_production");
  assert.equal(routing.model_strategy.writer_admission.scene_solution_admission.policy, "historical_evidence_only_no_global_extrapolation");
  assert.deepEqual(routing.model_strategy.writer_admission.scene_solution_admission.raw_fallback_on, ["always_without_chapter_specific_human_authority"]);
  assert.equal(routing.best_of_n_config.enabled, false);
  assert.equal(routing.best_of_n_config.runtime_status, "not_wired");
  assert.equal(routing.best_of_n_config.automatic_dual_writer, false);
});

test("same-model fixed scene search is historical evidence only", () => {
  assert.equal(routing.best_of_n_config.same_model_scene_search.runtime_status, "retired_from_production");
  assert.equal(routing.best_of_n_config.same_model_scene_search.enabled_by_default, false);
  assert.equal(routing.best_of_n_config.same_model_scene_search.latest_controlled_comparison.decision, "historical_evidence_only");
  assert.equal(routing.best_of_n_config.same_model_scene_search.aggregate_evidence.decision, "historical_evidence_only");
  assert.equal(routing.best_of_n_config.same_model_scene_search.current_default_writer_evidence.decision, "historical_evidence_only");
  assert.equal(routing.best_of_n_config.enabled, false);
  assert.equal(routing.best_of_n_config.runtime_status, "not_wired");
  assert.equal(routing.best_of_n_config.automatic_dual_writer, false);
});

test("Gemini production routes consume the configured GOOGLE_GEMINI/GEMINI env names", () => {
  assert.equal(routing.providers.gemini31.api_key_env, "GEMINI_API_KEY");
  const rawRoute = routing.agent_routing.v2_rawstage2_gemini31;
  const amplifiedRoute = routing.agent_routing.v2_amplified_gemini31;
  for (const route of [rawRoute, amplifiedRoute]) {
    assert.equal(route.provider, "gemini31");
    assert.equal(route.model, "gemini-3.1-pro-preview");
    assert.equal(route.base_url_env, "GOOGLE_GEMINI_BASE_URL");
    assert.equal(route.api_key_env, "GEMINI_API_KEY");
    assert.equal(route.model_env, "GEMINI_MODEL");
    assert.equal(route.lab_testing, undefined);
  }
});

test("Gemini reader-experience judge is isolated from prose routes and has no fallback", () => {
  assert.deepEqual(routing.agent_routing.v2_reader_experience_judge_gemini31, {
    provider: "gemini31",
    model: "gemini-3.1-pro-preview",
    base_url_env: "GOOGLE_GEMINI_BASE_URL",
    api_key_env: "GEMINI_API_KEY",
    model_env: "GEMINI_MODEL",
    fallback: [],
    evaluation_only: true,
    note: "GEMINI-READER-JUDGE-1: Anonymous reader-experience calibration route; never generates or replaces chapter prose.",
  });
});

test("Gemini provider defaults use the production environment names outside route-specific calls", () => {
  const savedBaseUrl = process.env.GOOGLE_GEMINI_BASE_URL;
  const savedModel = process.env.GEMINI_MODEL;
  try {
    process.env.GOOGLE_GEMINI_BASE_URL = "https://gemini.example.test";
    process.env.GEMINI_MODEL = "gemini-test-model";
    assert.equal(
      getBaseUrl("gemini31", "https://generativelanguage.googleapis.com/v1beta/openai/"),
      "https://gemini.example.test",
    );
    assert.equal(getModelOverride("gemini31", "gemini-3.1-pro-preview"), "gemini-test-model");
  } finally {
    if (savedBaseUrl === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
    else process.env.GOOGLE_GEMINI_BASE_URL = savedBaseUrl;
    if (savedModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = savedModel;
  }
});

test("Gemini OpenAI-compatible root URLs are normalized to the v1 API path", () => {
  assert.equal(normalizeProviderBaseUrl("gemini31", "https://api.solov.cc"), "https://api.solov.cc/v1");
  assert.equal(normalizeProviderBaseUrl("gemini31", "https://api.solov.cc/"), "https://api.solov.cc/v1");
  assert.equal(normalizeProviderBaseUrl("gemini31", "https://api.solov.cc/v1"), "https://api.solov.cc/v1");
  assert.equal(normalizeProviderBaseUrl("gemini31", "https://proxy.example/custom/v1"), "https://proxy.example/custom/v1");
  assert.equal(normalizeProviderBaseUrl("gpt", "https://api.example.com"), "https://api.example.com");
});

test("writerModel route lock keeps generation and heterogeneous GPT judge separate", () => {
  assert.deepEqual(resolveWriterModelRouteLock("claude"), {
    rawRoute: "v2_rawstage2",
    amplifiedRoute: "v2_amplified",
    judgeRoute: "v2_opportunity_judge",
    provider: "claude",
    model: "claude-opus-4-6",
    promptProfile: "claude_writer_v1",
  });
  assert.deepEqual(resolveWriterModelRouteLock("gemini31"), {
    rawRoute: "v2_rawstage2_gemini31",
    amplifiedRoute: "v2_amplified_gemini31",
    judgeRoute: "v2_opportunity_judge",
    provider: "gemini31",
    model: "gemini-3.1-pro-preview",
    promptProfile: "gemini_writer_v2",
  });
  assert.deepEqual(resolveWriterModelRouteLock(undefined), resolveWriterModelRouteLock("gemini31"));
});

test("writer route wrapper preserves semantic candidate routes while selecting raw and amplified endpoints", async () => {
  const requested = [];
  const baseGenerate = async (input) => {
    requested.push(input.route);
    return {
      text: "stub",
      route: input.route,
      model: "gemini-3.1-pro-preview",
      provider: "gemini31",
      durationMs: 1,
    };
  };
  const wrapped = wrapModelGenerateForWriterLock(
    baseGenerate,
    resolveWriterModelRouteLock("gemini31"),
  );

  const raw = await wrapped({ route: "v2_rawstage2", kind: "raw", systemPrompt: "", userPrompt: "" });
  const amplified = await wrapped({ route: "v2_amplified", kind: "editorial", systemPrompt: "", userPrompt: "" });

  assert.deepEqual(requested, ["v2_rawstage2_gemini31", "v2_amplified_gemini31"]);
  assert.equal(raw.route, "v2_rawstage2");
  assert.equal(raw.requestedRoute, "v2_rawstage2_gemini31");
  assert.equal(amplified.route, "v2_amplified");
  assert.equal(amplified.requestedRoute, "v2_amplified_gemini31");
});

test("public chapter tool exposes writerModel without widening modelTestRoute", () => {
  const handlers = new Proxy({}, { get: () => async () => ({}) });
  const chapterTool = registerTools(handlers).find((tool) => tool.name === "novel_generate_chapter");
  assert.ok(chapterTool);
  const writerSchema = chapterTool.parameters.properties.writerModel;
  assert.deepEqual(writerSchema.enum, ["claude", "gemini31"]);
  assert.equal(chapterTool.parameters.properties.boundedBestOf3.type, "boolean");
  assert.match(chapterTool.parameters.properties.boundedBestOf3.description, /退出生产主链路/);
  assert.match(writerSchema.description, /Gemini 3\.1 Pro/);
  assert.match(writerSchema.description, /fallback=\[\]/);
  assert.equal(chapterTool.parameters.properties.candidateTimeoutMs.type, "number");
  assert.equal(chapterTool.parameters.properties.sceneSolution.type, undefined, "object fields use the public Type.Any bridge");
});

test("public chapter tool forwards an explicit scene solution into the unified pipeline handler", async () => {
  let captured;
  const handlers = new Proxy({}, {
    get: (_target, key) => key === "handleGenerateChapter"
      ? async (input) => { captured = input; return { status: "ok" }; }
      : async () => ({}),
  });
  const chapterTool = registerTools(handlers).find((tool) => tool.name === "novel_generate_chapter");
  const sceneSolution = { id: "scene-1", unknowns: ["门后身份"], newRuleOrInformation: "声音只能复述听过的记忆" };
  await chapterTool.execute("call-1", {
    workspaceId: "w", chapterId: "1", chapterNumber: 1, fullPipelinePreview: true, sceneSolution,
  }, undefined, undefined, { cwd: process.cwd() });
  assert.deepEqual(captured.sceneSolution, sceneSolution);
});

test("read-only full pipeline previews do not retry an entire chapter after model timeout", async () => {
  let calls = 0;
  const handlers = new Proxy({}, {
    get: (_target, key) => key === "handleGenerateChapter"
      ? async () => {
          calls += 1;
          return {
            status: "blocked",
            failureEnvelope: { gate: "model_timeout", recoverable: true, severity: "recoverable" },
          };
        }
      : async () => ({}),
  });
  const chapterTool = registerTools(handlers).find((tool) => tool.name === "novel_generate_chapter");
  await chapterTool.execute("preview-timeout", {
    workspaceId: "w", chapterId: "1", chapterNumber: 1, fullPipelinePreview: true,
  }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(calls, 1);
});

test("public schema adapter preserves required and optional string enums", () => {
  const schema = toTypeBoxSchema({
    type: "object",
    properties: {
      requiredMode: { type: "string", enum: ["a", "b"] },
      optionalMode: { type: "string", enum: ["x", "y"] },
    },
    required: ["requiredMode"],
  });
  assert.deepEqual(schema.properties.requiredMode.enum, ["a", "b"]);
  assert.deepEqual(schema.properties.optionalMode.enum, ["x", "y"]);
});
