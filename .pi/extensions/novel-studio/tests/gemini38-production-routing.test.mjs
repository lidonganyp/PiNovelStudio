/**
 * WRITER-ENV-UNIFY-1: the production writer identity is resolved from .env
 * (GEMINI_MODEL / GOOGLE_GEMINI_BASE_URL). gemini31 stays a stable route ID.
 *
 * All runtime checks use stubs. No network request is allowed from this file.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";

import {
  resolveWriterModelRouteLock,
  wrapModelGenerateForWriterLock,
} from "../dist/v2/core/unified-entry.js";
import { registerTools } from "../dist/tools/register-tools.js";
import { defaultAdapterRegistry } from "../dist/novelos/protocol/adapter-registry.js";
import { toTypeBoxSchema } from "../dist/tools/legacy-tool-wrapper.js";
import { normalizeProviderBaseUrl } from "../dist/api/fallback-manager.js";
import {
  clearConfigCache,
  getAgentModelConfig,
  getBaseUrl,
  getGeminiWriterModel,
  getModelOverride,
  resolveRoutingEnvironment,
} from "../dist/utils/config.js";

const routing = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../../config/model-routing.json"), "utf8"),
);

const routingRaw = readFileSync(
  resolve(process.cwd(), "../../../config/model-routing.json"),
  "utf8",
);

test("routing keeps judge calibration evidence while production authority belongs to user feedback", () => {
  assert.equal(routing._version, "4.36.0");
  assert.deepEqual(routing.model_strategy.literary_judge_admission.evidence_paths, [
    "reports/model-comparison/human-review/gemini31-vs-claude46-human-review-2026-07-20T07-53-43-068Z/judge-detail-reader-priority.json",
    "reports/model-comparison/human-review/gemini31-vs-claude46-human-review-2026-07-20T07-53-43-068Z/judge-detail-reader-priority-gemini31-reader.json",
  ]);
  assert.match(
    routing.agent_routing.v2_literary_judge.note,
    /隔离评测.*最终文学评价权归用户/,
  );
  assert.equal(
    routing.model_strategy.literary_judge_admission.automatic_literary_selection_enabled,
    false,
  );
  assert.equal(
    routing.model_strategy.literary_judge_admission.runtime_mode,
    "evaluation_only_user_feedback_authority",
  );
});

test("routing config removes retired GPT writer routes and restores Gemini production", () => {
  for (const staleRoute of ["v2_rawstage2_gpt6astra", "v2_amplified_gpt6astra"]) {
    assert.equal(routing.agent_routing[staleRoute], undefined);
  }
  assert.ok(!routingRaw.includes('"gemini-3.1-pro"'));
  assert.equal(routing.providers.gemini31.name.includes("eval"), false);
});

test("the .env-configured Gemini writer is the production default while Claude remains an explicit option", () => {
  assert.equal(routing.model_strategy.writer_admission.default_writer, "gemini31");
  // 路由 JSON 只保留稳定占位符；实际身份由 .env 解析
  assert.equal(routing.model_strategy.narrator_primary, "${GEMINI_MODEL}");
  assert.equal(routing.stage_routing.stage2_narrator.provider, "gemini31");
  assert.equal(routing.stage_routing.stage2_narrator.model, "${GEMINI_MODEL}");
  assert.equal(routing.agent_routing.narrator_primary.provider, "gemini31");
  assert.equal(routing.agent_routing.narrator_primary.model, "${GEMINI_MODEL}");
  assert.deepEqual(resolveWriterModelRouteLock(undefined), {
    rawRoute: "v2_rawstage2_gemini31",
    amplifiedRoute: "v2_amplified_gemini31",
    judgeRoute: "v2_opportunity_judge",
    provider: "gemini31",
    model: getGeminiWriterModel(),
    promptProfile: "gemini_writer_v2",
  });

  const handlers = new Proxy({}, { get: () => async () => ({}) });
  const chapterTool = registerTools(handlers).find((tool) => tool.name === "novel_generate_chapter");
  assert.match(chapterTool.parameters.properties.writerModel.description, /Gemini（默认/);
});

test("production protocol capabilities match the configured writer for every route", () => {
  const resolved = resolveRoutingEnvironment(routing);
  for (const route of defaultAdapterRegistry.listProductionRoutes()) {
    const configured = resolved.agent_routing[route.route === "gemini_writer_v2" ? "v2_rawstage2_gemini31" : route.route]
      ?? resolved.stage_routing[route.route];
    assert.equal(route.capabilityKey.provider, configured.provider === "gemini31" ? "gemini" : configured.provider, route.route);
    assert.equal(route.capabilityKey.model, configured.model, route.route);
  }
  assert.deepEqual(defaultAdapterRegistry.validateProductionIsolation(), []);
});

test("routing declares Claude and the .env Gemini writer as isolated explicit writer models", () => {
  assert.equal(routing.model_strategy.narrator_coprimary_models, undefined);
  assert.deepEqual(routing.model_strategy.explicit_writer_models, [
    "${GEMINI_MODEL}",
    "claude-opus-4-6",
  ]);
  assert.deepEqual(routing.best_of_n_config.models, [
    "${GEMINI_MODEL}",
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
  // Historical review evidence does not authorize automatic literary selection.
  assert.equal(routing.model_strategy.writer_admission.human_override.status, "active");
  assert.equal(routing.model_strategy.writer_admission.human_override.winner, "gemini31");
  assert.equal(routing.model_strategy.writer_admission.scene_solution_admission.status, "retired_from_production");
  assert.equal(routing.model_strategy.writer_admission.scene_solution_admission.policy, "historical_evidence_only_no_global_extrapolation");
  assert.deepEqual(routing.model_strategy.writer_admission.scene_solution_admission.raw_fallback_on, [
    "judge_unavailable",
    "evidence_invalid",
    "tie",
    "reverse_review_conflict",
  ]);
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

test("Gemini production routes use dedicated Gemini environment settings", () => {
  const rawRoute = routing.agent_routing.v2_rawstage2_gemini31;
  const amplifiedRoute = routing.agent_routing.v2_amplified_gemini31;
  for (const route of [rawRoute, amplifiedRoute]) {
    assert.equal(route.provider, "gemini31");
    assert.equal(route.model, "${GEMINI_MODEL}");
    assert.equal(route.base_url_env, "GOOGLE_GEMINI_BASE_URL");
    assert.equal(route.api_key_env, "GEMINI_API_KEY");
    assert.equal(route.model_env, "GEMINI_MODEL");
    assert.equal(route.lab_testing, undefined);
  }
  // model_env 隔离：结构化节点用 GPT_MODEL，写模型用 GEMINI_MODEL。
  assert.notEqual(rawRoute.model_env, "GPT_MODEL");
});

test("Gemini production provider keeps literary judge routes isolated for evaluation", () => {
  assert.equal(routing.providers.gemini31.api_key_env, "GEMINI_API_KEY");
  assert.deepEqual(routing.agent_routing.v2_reader_experience_judge_gemini31, {
    provider: "gemini31",
    model: "${GEMINI_MODEL}",
    base_url_env: "GOOGLE_GEMINI_BASE_URL",
    api_key_env: "GEMINI_API_KEY",
    model_env: "GEMINI_MODEL",
    fallback: [],
    evaluation_only: true,
    note: "GEMINI-READER-JUDGE-1: Anonymous reader-experience calibration route; never generates or replaces chapter prose.",
  });
  assert.equal(routing.agent_routing.nb4_generate_gemini31.provider, "gemini31");

});

test("Gemini provider temperature/max_tokens cover the writer routes", () => {
  assert.equal(routing.providers.gemini31.temperature["v2_rawstage2_gemini31"], 0.72);
  assert.equal(routing.providers.gemini31.temperature["v2_amplified_gemini31"], 0.6);
  assert.equal(routing.providers.gemini31.max_tokens["v2_rawstage2_gemini31"], 16384);
  assert.equal(routing.providers.gemini31.max_tokens["v2_amplified_gemini31"], 16384);
});

test("gpt provider env defaults resolve base URL and model override", () => {
  const savedBaseUrl = process.env.GPT_BASE_URL;
  const savedModel = process.env.GPT_MODEL;
  try {
    process.env.GPT_BASE_URL = "https://shunfen6.example.test";
    process.env.GPT_MODEL = "gpt-test-model";
    assert.equal(
      getBaseUrl("gpt", "https://shunfen6.win/v1"),
      "https://shunfen6.example.test",
    );
    // provider 级 override 读 GPT_MODEL；写路由另有 GEMINI_MODEL 专用 model_env 隔离（见上）。
    assert.equal(getModelOverride("gpt", "gpt-5.5"), "gpt-test-model");
  } finally {
    if (savedBaseUrl === undefined) delete process.env.GPT_BASE_URL;
    else process.env.GPT_BASE_URL = savedBaseUrl;
    if (savedModel === undefined) delete process.env.GPT_MODEL;
    else process.env.GPT_MODEL = savedModel;
  }
});

test("writer model resolution is isolated from the structured GPT_MODEL override", async () => {
  const savedModel = process.env.GPT_MODEL;
  const savedWriterModel = process.env.GEMINI_MODEL;
  try {
    process.env.GPT_MODEL = "structured-model-test";
    // 缺 GEMINI_MODEL 时 fail-closed：明确报错，不静默使用旧模型。
    // 用未解析占位符模拟缺配置（空串会被 loadProjectDotEnv 从真实 .env 回填，
    // 属合法回填行为；真缺配置场景由 writer-env-config 的临时项目根测试覆盖）。
    process.env.GEMINI_MODEL = "${GEMINI_MODEL}";
    clearConfigCache();
    for (const route of ["narrator_primary", "v2_rawstage2_gemini31", "v2_amplified_gemini31"]) {
      await assert.rejects(
        () => getAgentModelConfig(route),
        /GEMINI_MODEL is required in \.env/,
        route,
      );
    }
    process.env.GEMINI_MODEL = "writer-model-test";
    clearConfigCache();
    assert.equal((await getAgentModelConfig("v2_rawstage2_gemini31")).model, "writer-model-test");
    // 结构化节点不受 GEMINI_MODEL 影响，读 GPT_MODEL
    assert.equal((await getAgentModelConfig("architect")).model, "structured-model-test");
  } finally {
    if (savedModel === undefined) delete process.env.GPT_MODEL;
    else process.env.GPT_MODEL = savedModel;
    if (savedWriterModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = savedWriterModel;
    clearConfigCache();
  }
});

test("Gemini OpenAI-compatible root URLs are normalized to the v1 API path", () => {
  assert.equal(normalizeProviderBaseUrl("gemini31", "https://proxy.example.com"), "https://proxy.example.com/v1");
  assert.equal(normalizeProviderBaseUrl("gemini31", "https://proxy.example.com/"), "https://proxy.example.com/v1");
  assert.equal(normalizeProviderBaseUrl("gemini31", "https://proxy.example.com/v1"), "https://proxy.example.com/v1");
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
    model: getGeminiWriterModel(),
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
      model: getGeminiWriterModel(),
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
  assert.deepEqual(writerSchema.enum, ["gemini31", "claude"]);
  assert.equal(writerSchema.default, "gemini31");
  // EXPERIMENTAL-FIELDS-REJECT-1：旧 raw/judge 分支的实验字段已从公开 schema 移除。
  assert.equal(
    chapterTool.parameters.properties.boundedBestOf3,
    undefined,
    "boundedBestOf3 已从公开 schema 移除（旧固定场景多候选评测）",
  );
  assert.equal(
    chapterTool.parameters.properties.qualityExperiment,
    undefined,
    "qualityExperiment 已从公开 schema 移除（eval-only 质量天花板样本）",
  );
  assert.equal(
    chapterTool.parameters.properties.recoverBlockedRaw,
    undefined,
    "recoverBlockedRaw 已从公开 schema 移除（旧 raw 恢复分支）",
  );
  assert.equal(
    chapterTool.parameters.properties.previewOnly,
    undefined,
    "previewOnly 已从公开 schema 移除（旧字段）",
  );
  // PRODUCTION-ROLLOUT-AUDIT-1 P0-1b/P0-10：eval knobs 已从公开 schema 移除。
  assert.equal(
    chapterTool.parameters.properties.modelTestRoute,
    undefined,
    "modelTestRoute 已从公开 schema 移除（eval-only 模型对比路由）",
  );
  assert.equal(
    chapterTool.parameters.properties.fullPipelinePreview,
    undefined,
    "fullPipelinePreview 已从公开 schema 移除（只读预览为 eval/开发能力）",
  );
  assert.match(writerSchema.description, /Gemini（默认/);
  assert.match(writerSchema.description, /GEMINI_MODEL/);
  assert.match(writerSchema.description, /仅当用户明确要求 Claude/);
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
    workspaceId: "w", chapterId: "1", chapterNumber: 1, sceneSolution,
  }, undefined, undefined, { cwd: process.cwd() });
  assert.deepEqual(captured.sceneSolution, sceneSolution);
});

test("public chapter tool rejects fullPipelinePreview instead of running a preview retry path", async () => {
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
  const response = await chapterTool.execute("preview-timeout", {
    workspaceId: "w", chapterId: "1", chapterNumber: 1, fullPipelinePreview: true,
  }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(calls, 0, "生产入口必须在 handler 前拒绝 fullPipelinePreview");
  assert.equal(response.isError, true);
  assert.match(String(response.details?.error ?? response.content?.[0]?.text ?? ""), /fullPipelinePreview/);
});

test("blocked chapter generation restores the pre-call chapter file and warns PI not to write the draft", async () => {
  const workspacesRoot = resolve(process.cwd(), "../../../workspaces");
  mkdirSync(workspacesRoot, { recursive: true });
  const workspacePath = mkdtempSync(join(workspacesRoot, "tool-block-protection-"));
  const workspaceId = basename(workspacePath);
  const chaptersDir = join(workspacePath, "chapters");
  const chapterPath = join(chaptersDir, "17.md");
  mkdirSync(chaptersDir, { recursive: true });
  writeFileSync(chapterPath, "已通过门禁的旧正文", "utf8");

  try {
    const handlers = new Proxy({}, {
      get: (_target, key) => key === "handleGenerateChapter"
        ? async () => {
            writeFileSync(chapterPath, "被 FactGuard 阻断的候选稿", "utf8");
            return {
              status: "blocked",
              chapterFilePath: null,
              failureEnvelope: { stage: "raw_fact_guard", severity: "hard" },
            };
          }
        : async () => ({}),
    });
    const chapterTool = registerTools(handlers).find((tool) => tool.name === "novel_generate_chapter");
    const response = await chapterTool.execute("blocked-write", {
      workspaceId,
      chapterId: "17",
      chapterNumber: 17,
    }, undefined, undefined, { cwd: process.cwd() });

    assert.equal(readFileSync(chapterPath, "utf8"), "已通过门禁的旧正文");
    assert.match(response.content[0].text, /禁止写入章节文件/);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("blocked chapter generation removes a newly leaked chapter file", async () => {
  const workspacesRoot = resolve(process.cwd(), "../../../workspaces");
  mkdirSync(workspacesRoot, { recursive: true });
  const workspacePath = mkdtempSync(join(workspacesRoot, "tool-new-block-protection-"));
  const workspaceId = basename(workspacePath);
  const chapterPath = join(workspacePath, "chapters", "18.md");

  try {
    const handlers = new Proxy({}, {
      get: (_target, key) => key === "handleGenerateChapter"
        ? async () => {
            mkdirSync(join(workspacePath, "chapters"), { recursive: true });
            writeFileSync(chapterPath, "不应交付的阻断稿", "utf8");
            return { status: "blocked", chapterFilePath: null };
          }
        : async () => ({}),
    });
    const chapterTool = registerTools(handlers).find((tool) => tool.name === "novel_generate_chapter");
    await chapterTool.execute("blocked-new-write", {
      workspaceId,
      chapterId: "18",
      chapterNumber: 18,
    }, undefined, undefined, { cwd: process.cwd() });

    assert.equal(existsSync(chapterPath), false);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
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
