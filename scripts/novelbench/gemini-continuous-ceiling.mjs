#!/usr/bin/env node
/** Gemini raw versus scene-solution continuous frontier experiment. */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  buildAnonymousSequenceMapping,
  buildHumanReviewTemplate,
  installSharedChapterSeeds,
  normalizeSceneSolutionStateAliases,
  parseContinuousCeilingArgs,
  parseSeedPlannerResponse,
  resolveCanonicalChapterPath,
  sha256,
  shouldRecoverBlockedRaw,
  writeJsonAtomic,
} from "./gemini-continuous-ceiling-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "../..");
const options = parseContinuousCeilingArgs(process.argv.slice(2));
const extensionRoot = join(projectRoot, ".pi", "extensions", "novel-studio");
const reportDir = join(projectRoot, "reports", "model-comparison", "gemini-continuous-ceiling", options.runId);
const workspaceIds = {
  raw: `__gemini-continuous-${options.runId}-raw`,
  scene_solution: `__gemini-continuous-${options.runId}-scene`,
};
const workspacePaths = Object.fromEntries(Object.entries(workspaceIds).map(([key, id]) => [key, join(projectRoot, "workspaces", id)]));
const checkpointPath = join(reportDir, "checkpoint.json");
const startChapter = options.throughChapter + 1;
const chapters = Array.from({ length: options.chapterCount }, (_, index) => startChapter + index);

process.env.PROJECT_ROOT = projectRoot;
process.env.PINOVEL_DISABLE_FALLBACK = "1";
process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS ??= "600000";
process.env.PINOVEL_GENERATION_MAX_TOKENS ??= "16384";
mkdirSync(reportDir, { recursive: true });

for (const path of [
  join(extensionRoot, "dist", "index.js"),
  join(extensionRoot, "dist-eval", "v2", "core", "frontier-snapshot.js"),
  join(extensionRoot, "dist-eval", "craft", "chapter-seed-builder.js"),
]) {
  if (!existsSync(path)) throw new Error(`missing compiled artifact: ${path}; run npm run build`);
}

const importBuilt = (root, relativePath) => import(pathToFileURL(join(root, relativePath)).href);
const extension = await importBuilt(join(extensionRoot, "dist"), "index.js");
const { createFrontierSnapshot } = await importBuilt(join(extensionRoot, "dist-eval"), join("v2", "core", "frontier-snapshot.js"));
const { buildChapterSeed } = await importBuilt(join(extensionRoot, "dist-eval"), join("craft", "chapter-seed-builder.js"));
const { normalizeChineseSceneSolutionPayload } = await importBuilt(join(extensionRoot, "dist-eval"), join("novelos", "eval", "ceiling-abc-pilot.js"));
const { searchSceneSolutions } = await importBuilt(join(extensionRoot, "dist-eval"), join("v2", "core", "scene-solution-search.js"));
const { createLegacyModelGenerateFn } = await importBuilt(join(extensionRoot, "dist"), join("v2", "adapters", "legacy-model-route-adapter.js"));
const { loadModelRoutingSync } = await importBuilt(join(extensionRoot, "dist"), join("utils", "config.js"));

loadModelRoutingSync();
const modelGenerate = createLegacyModelGenerateFn();
const registered = new Map();
extension.default({
  registerTool(tool) { registered.set(tool.name, tool); },
  registerCommand() {},
  on() {},
});
const chapterTool = requiredTool("novel_generate_chapter");
const preflightTool = requiredTool("novel_preflight_workspace");

let checkpoint = existsSync(checkpointPath)
  ? JSON.parse(readFileSync(checkpointPath, "utf8"))
  : { schemaVersion: 1, runId: options.runId, chapters: {}, failures: [], status: "initializing" };
if (checkpoint.runId !== options.runId) throw new Error("checkpoint runId mismatch");

if (!options.resume || !Object.values(workspacePaths).every(existsSync)) {
  for (const [arm, workspacePath] of Object.entries(workspacePaths)) {
    const snapshot = await createFrontierSnapshot({
      workspaceId: options.sourceWorkspaceId,
      throughChapter: options.throughChapter,
      projectRoot,
      outputDir: workspacePath,
    });
    if (snapshot.blocked) throw new Error(`frontier snapshot blocked for ${arm}: ${snapshot.blockReason}`);
  }
}

const seedArtifactPath = join(reportDir, "shared-chapter-seeds.json");
let seeds;
if (existsSync(seedArtifactPath)) {
  seeds = JSON.parse(readFileSync(seedArtifactPath, "utf8")).seeds;
} else {
  const seedPlan = await requestSharedSeeds();
  seeds = seedPlan.seeds;
  writeJsonAtomic(seedArtifactPath, {
    schemaVersion: 1,
    sourceWorkspaceId: options.sourceWorkspaceId,
    throughChapter: options.throughChapter,
    attempts: seedPlan.attempts,
    seeds,
  });
}
installSharedChapterSeeds(Object.values(workspacePaths).map((path) => join(path, "config.json")), seeds);

checkpoint.status = "running";
persistCheckpoint();
let failed = false;
for (const chapterNumber of chapters) {
  for (const arm of ["raw", "scene_solution"]) {
    const key = `${arm}:${chapterNumber}`;
    if (checkpoint.chapters[key]?.accepted === true) continue;
    let result;
    try {
      result = await runChapter(arm, chapterNumber);
    } catch (error) {
      result = {
        accepted: false,
        status: "error",
        reason: "chapter_execution_error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    checkpoint.chapters[key] = result;
    checkpoint.failures = checkpoint.failures.filter((failure) =>
      failure.arm !== arm || failure.chapterNumber !== chapterNumber);
    persistCheckpoint();
    if (!result.accepted) {
      checkpoint.failures.push({ arm, chapterNumber, reason: result.reason });
      checkpoint.status = "blocked";
      persistCheckpoint();
      failed = true;
      break;
    }
  }
  if (failed) break;
}

if (!failed) {
  buildHumanReviewPackage();
  checkpoint.status = "pending_human_review";
  persistCheckpoint();
}

process.stdout.write(JSON.stringify({
  runId: options.runId,
  status: checkpoint.status,
  completedChapters: Object.values(checkpoint.chapters).filter((item) => item.accepted).length,
  expectedChapters: options.chapterCount * 2,
  reportDir,
}, null, 2) + "\n");
if (failed) process.exitCode = 2;

function requiredTool(name) {
  const tool = registered.get(name);
  if (!tool) throw new Error(`${name} is not registered`);
  return tool;
}

async function requestSharedSeeds() {
  const sourceRoot = join(projectRoot, "workspaces", options.sourceWorkspaceId);
  const config = JSON.parse(readFileSync(join(sourceRoot, "config.json"), "utf8"));
  const previousText = readFileSync(resolveCanonicalChapterPath(sourceRoot, options.throughChapter), "utf8");
  const outline = readFileSync(join(sourceRoot, "series", "outline.md"), "utf8");
  const statePath = join(sourceRoot, "series", "narrative-state.json");
  const context = {
    作品: { 名称: config.novelName, 类型: config.genre, 子类型: config.subGenres },
    规划章节: chapters,
    前章正文末段: previousText.slice(-6000),
    当前叙事状态: existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null,
    高层大纲相关段: selectOutlineWindow(outline),
  };
  for (let attempt = 2; attempt >= 1; attempt -= 1) {
    const invalidPath = join(reportDir, `seed-planner-invalid-attempt-${attempt}.json`);
    if (!existsSync(invalidPath)) continue;
    const prior = JSON.parse(readFileSync(invalidPath, "utf8"));
    try {
      const recoveredSeeds = parseSeedPlannerResponse(prior.rawResponse, {
        startChapter,
        chapterCount: options.chapterCount,
      });
      return {
        seeds: recoveredSeeds,
        attempts: [{
          attempt,
          provider: prior.provider,
          model: prior.model,
          route: prior.route,
          durationMs: prior.durationMs,
          responseHash: prior.responseHash,
          valid: true,
          recoveredFromInvalidArtifact: true,
        }],
      };
    } catch {
      // The artifact remains useful audit evidence; continue to a fresh bounded request.
    }
  }
  const attempts = [];
  let validationError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await modelGenerate({
      route: "v2_rawstage2_gemini31",
      kind: "chapter_seed_planning",
      timeoutMs: 600000,
      maxTokens: 4096,
      systemPrompt: [
        "你是原创长篇小说的连续章节决策规划器，不写正文。",
        `为第${startChapter}章到第${startChapter + options.chapterCount - 1}章输出严格 JSON。`,
        "根对象只能有 chapters。每章只能有 chapterNumber、choicesAndCosts、expectedIrreversibleChange、causalEndPressure。",
        "choicesAndCosts 至少一项，每项只能有 choice 和 cost；另外两个字段均为非空字符串数组。",
        "三个章节必须形成连续因果链，但不得预写场景正文、对白或修辞句段。",
        "只使用原创项目事实，不得引用任何外部参考作品。",
        ...(validationError ? [
          `上次输出未通过 schema：${validationError}`,
          "不要续写上次响应；从原始上下文重新生成完整 JSON。",
        ] : []),
      ].join("\n"),
      userPrompt: JSON.stringify(context),
    });
    const audit = {
      attempt,
      provider: response.provider,
      model: response.model,
      route: response.route,
      durationMs: response.durationMs,
      responseHash: sha256(response.text),
    };
    try {
      const parsedSeeds = parseSeedPlannerResponse(response.text, {
        startChapter,
        chapterCount: options.chapterCount,
      });
      attempts.push({ ...audit, valid: true });
      return { seeds: parsedSeeds, attempts };
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
      attempts.push({ ...audit, valid: false, validationError });
      writeJsonAtomic(join(reportDir, `seed-planner-invalid-attempt-${attempt}.json`), {
        ...audit,
        validationError,
        rawResponse: response.text,
      });
    }
  }
  throw new Error(`seed planner failed strict schema after 2 attempts: ${validationError}`);
}

async function runChapter(arm, chapterNumber) {
  const workspaceId = workspaceIds[arm];
  const priorCheckpoint = checkpoint.chapters[`${arm}:${chapterNumber}`];
  const recoverBlockedRaw = shouldRecoverBlockedRaw(priorCheckpoint);
  const preflight = unwrap(await preflightTool.execute(
    `gemini-continuous-preflight-${arm}-${chapterNumber}`,
    { workspaceId, chapterId: String(chapterNumber), chapterNumber },
    undefined,
    undefined,
    toolContext(),
  ));
  if (preflight.status !== "passed") {
    return { accepted: false, status: preflight.status, reason: "preflight_blocked", blockingItems: preflight.report?.blockingItems ?? [] };
  }

  let sceneSolution;
  if (arm === "scene_solution") sceneSolution = await loadOrCreateSceneSolution(workspaceId, chapterNumber);
  const started = Date.now();
  const output = unwrap(await chapterTool.execute(
    `gemini-continuous-${arm}-${chapterNumber}`,
    {
      workspaceId,
      chapterId: String(chapterNumber),
      chapterNumber,
      writerModel: "gemini31",
      seed: chapterNumber * 100 + (arm === "raw" ? 1 : 2),
      candidateTimeoutMs: 600000,
      ...(recoverBlockedRaw ? { recoverBlockedRaw: true } : {}),
      ...(sceneSolution ? { sceneSolution } : {}),
    },
    undefined,
    undefined,
    toolContext(),
  ));
  let chapterPath = null;
  if (output.status === "ok") {
    try {
      chapterPath = resolveCanonicalChapterPath(workspacePaths[arm], chapterNumber);
    } catch {
      chapterPath = null;
    }
  }
  const accepted = chapterPath !== null;
  const text = accepted ? readFileSync(chapterPath, "utf8") : "";
  return {
    accepted,
    status: output.status ?? "unknown",
    reason: accepted ? null : output.failureEnvelope?.reason ?? "chapter_not_committed",
    selectedSource: output.selectedSource ?? null,
    chapterFilePath: chapterPath,
    textHash: accepted ? sha256(text) : null,
    textLength: text.length,
    durationMs: Date.now() - started,
    failureEnvelope: output.failureEnvelope ?? null,
    modelCalls: (output.stageResults?.modelCalls ?? []).map((call) => ({
      kind: call.kind,
      route: call.route,
      requestedRoute: call.requestedRoute,
      actualProvider: call.actualProvider,
      actualModel: call.actualModel,
      durationMs: call.durationMs,
      finishReason: call.finishReason,
    })),
  };
}

async function loadOrCreateSceneSolution(workspaceId, chapterNumber) {
  const artifactPath = join(reportDir, `scene-solution-${chapterNumber}.json`);
  if (existsSync(artifactPath)) return JSON.parse(readFileSync(artifactPath, "utf8")).selected;
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  const seedResult = buildChapterSeed({ workspacePath, workspaceId, chapterId: String(chapterNumber), chapterNumber });
  const safeContext = {
    本章意图: seedResult.seed.intent,
    前章承接: seedResult.seed.previousContinuation,
    当前压力: seedResult.seed.currentPressure,
    候选锚点: seedResult.seed.candidateAnchors,
    角色状态: seedResult.seed.characters,
  };
  for (let attempt = 2; attempt >= 1; attempt -= 1) {
    const invalidPath = join(reportDir, `scene-solution-invalid-attempt-${chapterNumber}-${attempt}.json`);
    if (!existsSync(invalidPath)) continue;
    const prior = JSON.parse(readFileSync(invalidPath, "utf8"));
    try {
      const search = parseSceneSearchResponse(prior.rawResponse, workspaceId, chapterNumber);
      writeJsonAtomic(artifactPath, {
        schemaVersion: 1,
        chapterNumber,
        attempts: [{
          attempt,
          provider: prior.provider,
          model: prior.model,
          route: prior.route,
          durationMs: prior.durationMs,
          responseHash: prior.responseHash,
          valid: true,
          recoveredFromInvalidArtifact: true,
        }],
        candidates: search.candidates,
        selected: search.selected,
        validation: search.validation,
      });
      return search.selected;
    } catch {
      // Continue to the bounded fresh requests below.
    }
  }
  const attempts = [];
  let validationError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await modelGenerate({
      route: "v2_rawstage2_gemini31",
      kind: "scene_solution_search",
      timeoutMs: 600000,
      maxTokens: 4096,
      systemPrompt: [
        "你是原创长篇小说的场景方案设计器，不写正文。",
        "输出恰好三张实质不同的方案卡，模式依次为证据调查、主动试探、关系代价。",
        "根对象键必须是方案列表。每张只使用：编号、模式、表层目标、真实危险、已知事实、未知事项、主动试探、替代方案、选择、代价、新规则或信息、不可逆变化、状态类型、章末因果压力、因果来源、下一步选择、避免模板。",
        "已知事实、未知事项、替代方案、避免模板必须是字符串数组；替代方案必须恰好包含两个非空字符串。",
        "不得新增高影响设定，不得输出对白或正文段落，只输出合法 JSON。",
        ...(validationError ? [
          `上次输出未通过 schema：${validationError}`,
          "不要续写或局部修补；依据原始上下文重新生成完整三张方案卡。",
        ] : []),
      ].join("\n"),
      userPrompt: JSON.stringify(safeContext),
    });
    const audit = {
      attempt,
      provider: response.provider,
      model: response.model,
      route: response.route,
      durationMs: response.durationMs,
      responseHash: sha256(response.text),
    };
    try {
      const search = parseSceneSearchResponse(response.text, workspaceId, chapterNumber);
      attempts.push({ ...audit, valid: true });
      writeJsonAtomic(artifactPath, {
        schemaVersion: 1,
        chapterNumber,
        attempts,
        candidates: search.candidates,
        selected: search.selected,
        validation: search.validation,
      });
      return search.selected;
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
      attempts.push({ ...audit, valid: false, validationError });
      writeJsonAtomic(join(reportDir, `scene-solution-invalid-attempt-${chapterNumber}-${attempt}.json`), {
        ...audit,
        validationError,
        rawResponse: response.text,
      });
    }
  }
  throw new Error(`scene solution search failed after 2 attempts: ${validationError}`);
}

function buildHumanReviewPackage() {
  const mapping = buildAnonymousSequenceMapping(options.runId);
  const reviewDir = join(reportDir, "human-review");
  mkdirSync(reviewDir, { recursive: true });
  const sections = [
    "# Gemini 连续章节匿名评审包",
    "",
    "请分别阅读两个连续序列，不要跨序列拼接章节。",
    "评审完成前不要打开 private-mapping.json。",
    "按 human-review-template.json 填写：1=明显失败，3=基本可读但需中度修改，5=达到成熟商业连载可发布线。",
    "只有人工确认 positiveGain=true 且 productionAdmission=true，场景解法才可进入生产准入流程。",
  ];
  for (const label of ["序列甲", "序列乙"]) {
    const arm = mapping.publicToPrivate[label];
    sections.push("", `## ${mapping.publicReviewLabels[label]}`);
    for (const chapterNumber of chapters) {
      sections.push("", `### 第${chapterNumber}章`, "", readFileSync(resolveCanonicalChapterPath(workspacePaths[arm], chapterNumber), "utf8"));
    }
  }
  writeFileSync(join(reviewDir, "anonymous-sequences.md"), sections.join("\n"), "utf8");
  writeJsonAtomic(join(reviewDir, "private-mapping.json"), mapping);
  writeJsonAtomic(
    join(reviewDir, "human-review-template.json"),
    buildHumanReviewTemplate(options.runId, chapters),
  );
}

function persistCheckpoint() {
  checkpoint.updatedAt = new Date().toISOString();
  writeJsonAtomic(checkpointPath, checkpoint);
}

function toolContext() {
  return { cwd: projectRoot, ui: { notify() {} } };
}

function unwrap(result) {
  if (result?.isError && !result?.details) throw new Error(result.content?.[0]?.text ?? "public tool failed");
  return result?.details ?? result;
}

function selectOutlineWindow(outline) {
  const marker = outline.indexOf("第13-30章");
  const start = marker >= 0 ? Math.max(0, marker - 5000) : 0;
  return outline.slice(start, start + 12000);
}

function stripFence(value) {
  const trimmed = String(value ?? "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseSceneSearchResponse(rawResponse, workspaceId, chapterNumber) {
  const payload = normalizeSceneSolutionStateAliases(JSON.parse(stripFence(rawResponse)));
  const cards = normalizeChineseSceneSolutionPayload(payload);
  const search = searchSceneSolutions({
    sceneId: `${workspaceId}:${chapterNumber}`,
    existingFactIds: [],
    openPromiseIds: [],
    cards,
    maxCards: 3,
  });
  if (search.status !== "selected" || !search.selected) {
    throw new Error(`scene solution search failed: ${search.fallbackReason}`);
  }
  return search;
}
