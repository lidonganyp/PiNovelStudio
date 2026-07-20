#!/usr/bin/env node
/**
 * One-case A/B/C ceiling pilot for an original PiNovelStudio workspace.
 * Reference text is resolved only inside evaluator/distillation phases and is
 * never passed to runUnifiedPipeline or raw prompt construction.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const EXT_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const DIST = join(EXT_ROOT, "dist-eval");
const OUTPUT_DIR = join(PROJECT_ROOT, "reports", "novel-quality-ceiling-20260719", "pilot-xinmo-ch18");
const REGISTRY_PATH = join(PROJECT_ROOT, "reports", "novel-quality-ceiling-20260719", "reference", "reference-registry.json");
const WORKSPACE_ID = "xinmo";
const CHAPTER_ID = "18-ceiling-pilot";
const CHAPTER_NUMBER = 18;
const TARGET_REFERENCE_ID = "smsf:physical:1";
const DISTILLATION_REFERENCE_IDS = ["smsf:physical:5", "smsf:physical:12", "smsf:physical:20"];
const FORBIDDEN_GENERATOR_TERMS = [
  "smsf:", "神秘复苏", "杨间", "鬼眼", "鬼域", "人皮纸", "敲门鬼",
];
const TIMEOUT_MS = 600_000;

process.env.PROJECT_ROOT = PROJECT_ROOT;
process.env.PINOVEL_DISABLE_FALLBACK = "1";
process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS = String(TIMEOUT_MS);
process.env.PINOVEL_GENERATION_MAX_TOKENS = "16384";

mkdirSync(OUTPUT_DIR, { recursive: true });

const importDist = async (relativePath) => import(pathToFileURL(join(DIST, relativePath)).href);
const {
  ReferenceRegistry,
} = await importDist(join("novelbench", "index.js"));
const {
  runUnifiedPipeline,
} = await importDist(join("v2", "core", "unified-entry.js"));
const {
  createContextCompiler,
} = await importDist(join("v2", "core", "context-compiler.js"));
const {
  createChapterIntentBuilder,
} = await importDist(join("v2", "core", "chapter-intent-builder.js"));
const {
  loadCreativeConstitution,
} = await importDist(join("v2", "core", "creative-constitution.js"));
const {
  loadStateStore,
} = await importDist(join("v2", "core", "final-state-commit.js"));
const {
  createLegacyModelGenerateFn,
} = await importDist(join("v2", "adapters", "legacy-model-route-adapter.js"));
const {
  resolveWriterPromptProfile,
} = await importDist(join("v2", "core", "model-prompt-adapter.js"));
const {
  buildRawPrompt,
} = await importDist(join("v2", "core", "orchestrator-raw.js"));
const {
  searchSceneSolutions,
} = await importDist(join("v2", "core", "scene-solution-search.js"));
const {
  validatePortableCraftGenes,
} = await importDist(join("v2", "core", "portable-craft-gene.js"));
const {
  loadModelRoutingSync,
} = await importDist(join("utils", "config.js"));
const {
  loadJudgeModelConfigFromEnv,
  callJudgeModel,
  describeJudgeConfig,
} = await importDist(join("novelos", "eval", "judge-model-adapter.js"));
const {
  buildCeilingJudgeSchema,
  parseAndValidateCeilingVerdict,
  runCeilingJudgeWithRepair,
} = await importDist(join("novelos", "eval", "ceiling-judge-schema.js"));
const {
  auditCeilingPilotIsolation,
  buildCeilingExperimentArms,
  buildCeilingJudgeMessages,
  normalizeChineseSceneSolutionPayload,
  runBoundedJsonRequest,
  summarizeCeilingPilot,
} = await importDist(join("novelos", "eval", "ceiling-abc-pilot.js"));

loadModelRoutingSync();
const judgeConfig = loadJudgeModelConfigFromEnv();
const modelGenerate = createLegacyModelGenerateFn();

if (!existsSync(REGISTRY_PATH)) throw new Error(`reference registry missing: ${REGISTRY_PATH}`);
const registry = new ReferenceRegistry(REGISTRY_PATH);
registry.load();
const targetReference = requireReference(registry, TARGET_REFERENCE_ID);
const targetRecord = registry.list().find((record) => record.referenceId === TARGET_REFERENCE_ID);
if (!targetRecord) throw new Error(`target registry record missing: ${TARGET_REFERENCE_ID}`);

const compiled = createContextCompiler().compile({
  workspaceId: WORKSPACE_ID,
  chapterId: CHAPTER_ID,
  chapterNumber: CHAPTER_NUMBER,
  projectRoot: PROJECT_ROOT,
});
const context = compiled.context;
const seed = compiled.sourceSeed;
const constitution = loadCreativeConstitution(WORKSPACE_ID, PROJECT_ROOT);
const stateStore = loadStateStore(WORKSPACE_ID, PROJECT_ROOT);
const intentInput = buildIntentInput(seed, CHAPTER_NUMBER);
const { intent, warnings: intentWarnings } = createChapterIntentBuilder().build(
  intentInput,
  constitution,
  stateStore,
);
const prefix = loadOriginalPrefix();
const characterNames = [...new Set((seed.characters ?? []).map((character) => character.name).filter(Boolean))];
const promptProfile = resolveWriterPromptProfile({
  route: "v2_rawstage2",
  provider: "claude",
  model: "claude-opus-4-6",
});

process.stderr.write(`[ceiling-pilot] judge=${describeJudgeConfig(judgeConfig)}\n`);
process.stderr.write(`[ceiling-pilot] workspace=${WORKSPACE_ID}, chapter=${CHAPTER_NUMBER}, target=${TARGET_REFERENCE_ID}\n`);

const craftDistillationPath = join(OUTPUT_DIR, "craft-distillation.json");
const craftDistillation = existsSync(craftDistillationPath)
  ? (() => {
      const artifact = JSON.parse(readFileSync(craftDistillationPath, "utf8"));
      return { artifact, genes: artifact.genes };
    })()
  : await distillPortableCraftGenes(registry, judgeConfig, callJudgeModel);
if (!existsSync(craftDistillationPath)) writeJson(craftDistillationPath, craftDistillation.artifact);
const craftValidation = validatePortableCraftGenes(craftDistillation.genes);
if (!craftValidation.valid) {
  throw new Error(`distilled craft genes invalid: ${craftValidation.errors.join(";")}`);
}

const sceneFailurePath = join(OUTPUT_DIR, "scene-solution-search-failure.json");
const cachedSceneAttempt = existsSync(sceneFailurePath)
  ? JSON.parse(readFileSync(sceneFailurePath, "utf8")).attempts?.[0]
  : null;
const sceneSearch = await generateSceneSolutions({
  modelGenerate,
  intent,
  context,
  seed,
  cachedAttempt: cachedSceneAttempt,
});
writeJson(join(OUTPUT_DIR, "scene-solution-search.json"), sceneSearch.artifact);
if (sceneSearch.result.status !== "selected" || !sceneSearch.result.selected) {
  throw new Error(`scene solution search failed: ${sceneSearch.result.fallbackReason ?? "no selected card"}`);
}

const arms = buildCeilingExperimentArms(sceneSearch.result.selected, craftDistillation.genes);
const generated = {};
const generatorPromptPayloads = [];
for (const arm of arms) {
  const rawInput = {
    workspaceId: `eval-${WORKSPACE_ID}`,
    chapterId: `${CHAPTER_ID}-${arm.id}`,
    chapterNumber: CHAPTER_NUMBER,
    projectRoot: PROJECT_ROOT,
    intent,
    context,
    constitution: context.constitution ?? null,
    characterNames,
    modelGenerate,
    timeoutMs: TIMEOUT_MS,
    evalMode: "B1",
    evalPrefix: prefix,
    rawPromptProfile: promptProfile,
    ...(arm.sceneSolution ? { sceneSolution: arm.sceneSolution } : {}),
    ...(arm.craftGenes ? { craftGenes: arm.craftGenes } : {}),
  };
  const prompt = buildRawPrompt(rawInput);
  generatorPromptPayloads.push(`${prompt.systemPrompt}\n${prompt.userPrompt}`);
}

const isolation = auditCeilingPilotIsolation({
  targetReferenceId: TARGET_REFERENCE_ID,
  distillationReferenceIds: DISTILLATION_REFERENCE_IDS,
  generatorPayloads: generatorPromptPayloads,
  forbiddenGeneratorTerms: FORBIDDEN_GENERATOR_TERMS,
});
writeJson(join(OUTPUT_DIR, "generator-isolation-audit.json"), {
  ...isolation,
  targetReferenceId: TARGET_REFERENCE_ID,
  distillationReferenceIds: DISTILLATION_REFERENCE_IDS,
  promptHashes: generatorPromptPayloads.map(sha256),
  forbiddenGeneratorTerms: FORBIDDEN_GENERATOR_TERMS,
});
if (!isolation.valid) throw new Error(`generator isolation failed: ${isolation.errors.join(";")}`);

for (const arm of arms) {
  const prosePath = join(OUTPUT_DIR, `arm-${arm.id}.md`);
  const metadataPath = join(OUTPUT_DIR, `arm-${arm.id}-metadata.json`);
  if (existsSync(prosePath) && existsSync(metadataPath)) {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    const text = readFileSync(prosePath, "utf8");
    if (metadata.status === "ok" && metadata.candidateHash === sha256(text)) {
      generated[arm.id] = { ...metadata, arm, text };
      process.stderr.write(`[ceiling-pilot] reusing completed arm ${arm.id}: ${metadata.candidateHash}\n`);
      continue;
    }
  }
  process.stderr.write(`[ceiling-pilot] generating arm ${arm.id}: ${arm.label}\n`);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const result = await runUnifiedPipeline({
    workspaceId: `eval-${WORKSPACE_ID}`,
    chapterId: `${CHAPTER_ID}-${arm.id}`,
    chapterNumber: CHAPTER_NUMBER,
    projectRoot: PROJECT_ROOT,
    candidateTimeoutMs: TIMEOUT_MS,
    evalMode: "B1",
    evalPrefix: prefix,
    evalIntent: intent,
    evalContext: context,
    evalModelGenerate: modelGenerate,
    evalPromptProfile: promptProfile,
    evalCharacterNames: characterNames,
    ...(arm.sceneSolution ? { sceneSolution: arm.sceneSolution } : {}),
    ...(arm.craftGenes ? { craftGenes: arm.craftGenes } : {}),
  });
  const text = result.text ?? "";
  if (result.status !== "ok" || text.trim().length === 0) {
    writeJson(join(OUTPUT_DIR, `arm-${arm.id}-failure.json`), result);
    throw new Error(`arm ${arm.id} generation failed: ${JSON.stringify(result.failureEnvelope ?? result.status)}`);
  }
  writeFileSync(prosePath, text, "utf8");
  generated[arm.id] = {
    arm,
    text,
    candidateHash: sha256(text),
    textLength: text.length,
    startedAt,
    durationMs: Date.now() - startMs,
    modelCalls: result.stageResults?.modelCalls ?? [],
    status: result.status,
    selectedSource: result.selectedSource ?? "raw",
  };
  writeJson(metadataPath, {
    ...generated[arm.id],
    text: undefined,
  });
}

const verdicts = {};
for (const armId of ["A", "B", "C"]) {
  const judgeArtifactPath = join(OUTPUT_DIR, `judge-${armId}.json`);
  if (existsSync(judgeArtifactPath)) {
    const existing = JSON.parse(readFileSync(judgeArtifactPath, "utf8"));
    const hashesMatch = existing.candidateHash === generated[armId].candidateHash
      && existing.referenceBodyHash === targetRecord.bodyHash;
    if (hashesMatch) {
      if (existing.status === "valid" && existing.verdict) {
        verdicts[armId] = existing.verdict;
        process.stderr.write(`[ceiling-pilot] reusing valid judge ${armId}: ${existing.provenance.responseHash}\n`);
        continue;
      }
      const cachedResponses = Array.isArray(existing.responses) ? [...existing.responses].reverse() : [];
      const recovered = cachedResponses.find((response) => (
        typeof response?.text === "string"
        && parseAndValidateCeilingVerdict(response.text, {
          candidate: generated[armId].text,
          reference: targetReference,
        }).valid
      ));
      if (recovered) {
        const parsed = parseAndValidateCeilingVerdict(recovered.text, {
          candidate: generated[armId].text,
          reference: targetReference,
        });
        const recoveredArtifact = {
          ...existing,
          status: "valid",
          verdict: parsed.verdict,
          errors: [],
          provenance: {
            ...existing.provenance,
            responseHash: recovered.responseHash ?? sha256(recovered.text),
          },
        };
        writeJson(judgeArtifactPath, recoveredArtifact);
        verdicts[armId] = parsed.verdict;
        process.stderr.write(`[ceiling-pilot] recovered cached judge ${armId}: ${recoveredArtifact.provenance.responseHash}\n`);
        continue;
      }
    }
  }
  process.stderr.write(`[ceiling-pilot] judging arm ${armId}\n`);
  const candidate = generated[armId].text;
  const responses = [];
  const judgeMessages = buildCeilingJudgeMessages(candidate, targetReference);
  const invokeJudge = async (repairFeedback) => {
    const messages = repairFeedback
      ? [...judgeMessages, {
          role: "user",
          content: `上次输出未通过严格 schema/span 校验：${repairFeedback}。重新阅读两篇正文，只输出完整合法 JSON。`,
        }]
      : judgeMessages;
    const result = await callJudgeModel(judgeConfig, messages, {
      responseFormat: "json_schema",
      schema: buildCeilingJudgeSchema(),
      schemaName: "ceiling_quality_verdict_v2",
      temperature: 0.1,
      maxTokens: 8192,
    });
    responses.push({
      text: result.text,
      model: result.model,
      durationMs: result.durationMs,
      responseHash: sha256(result.text),
    });
    return result.text;
  };
  const requestId = `ceiling-${armId}-${randomUUID()}`;
  const run = await runCeilingJudgeWithRepair({
    candidate,
    reference: targetReference,
    request: async () => invokeJudge(null),
    repair: async (feedback) => invokeJudge(feedback),
    provenance: {
      requestId,
      model: judgeConfig.model,
      route: "v2_literary_judge",
    },
  });
  const artifact = {
    armId,
    status: run.status,
    verdict: run.verdict,
    errors: run.errors,
    retryCount: run.retryCount,
    provenance: run.provenance,
    candidateHash: generated[armId].candidateHash,
    referenceId: TARGET_REFERENCE_ID,
    referenceBodyHash: targetRecord.bodyHash,
    responses,
  };
  writeJson(judgeArtifactPath, artifact);
  if (run.status !== "valid" || !run.verdict) {
    throw new Error(`judge ${armId} invalid after bounded repair: ${run.errors.join(";")}`);
  }
  verdicts[armId] = run.verdict;
}

const summary = summarizeCeilingPilot(verdicts);
const result = {
  schemaVersion: "ceiling-abc-pilot.v1",
  generatedAt: new Date().toISOString(),
  scope: {
    workspaceId: WORKSPACE_ID,
    chapterNumber: CHAPTER_NUMBER,
    targetReferenceId: TARGET_REFERENCE_ID,
    distillationReferenceIds: DISTILLATION_REFERENCE_IDS,
    generatorModel: "claude-opus-4-6",
    judgeModel: judgeConfig.model,
    nominalCalls: { craftDistillation: 1, sceneSearch: 1, sceneSearchRepairMax: 1, generation: 3, judge: 3 },
  },
  isolation,
  intentWarnings,
  arms: Object.fromEntries(Object.entries(generated).map(([id, arm]) => [id, {
    candidateHash: arm.candidateHash,
    textLength: arm.textLength,
    durationMs: arm.durationMs,
    modelCalls: arm.modelCalls,
  }])),
  verdicts,
  summary,
  limitations: [
    "单章、单 seed 只能形成诊断证据，不能证明长期或普遍质量提升。",
    "同档判定仍需人工盲评确认，不能自动准入生产。",
    "reference-derived craft genes 只在 C 臂使用，目标 reference 未参与蒸馏。",
    `独立 judge 对同一 reference 的八维均值存在漂移（A=${summary.referenceAverages.A}, B=${summary.referenceAverages.B}, C=${summary.referenceAverages.C}）；策略判断使用 reference-adjusted gap。`,
  ],
};
writeJson(join(OUTPUT_DIR, "result.json"), result);
writeFileSync(join(OUTPUT_DIR, "verification-report.md"), renderReport(result), "utf8");
process.stdout.write(JSON.stringify({ outputDir: OUTPUT_DIR, summary, verdicts }, null, 2) + "\n");

function requireReference(referenceRegistry, referenceId) {
  const body = referenceRegistry.resolve(referenceId);
  if (!body) throw new Error(`reference resolve/hash verification failed: ${referenceId}`);
  return body;
}

function buildIntentInput(chapterSeed, chapterNumber) {
  return {
    chapterNumber,
    intentPrimary: chapterSeed.intent?.primary,
    chapterTheme: chapterSeed.intent?.chapterTheme,
    targetEmotions: chapterSeed.intent?.targetEmotions ?? [],
    characters: (chapterSeed.characters ?? []).map((character) => ({
      name: character.name,
      role: character.role,
      mentality: character.mentality,
      recentAction: character.recentAction,
      pendingTension: character.pendingTension,
    })),
    immutableFacts: [
      ...(chapterSeed.worldConstraint?.immutableFacts ?? []),
      ...(chapterSeed.highLevelDirection?.immutableFacts ?? []),
    ],
    openPromises: (chapterSeed.currentPressure?.pendingForeshadowing ?? []).map((item) => ({
      id: item.id,
      description: item.description,
    })),
    openArcs: (chapterSeed.currentPressure?.openArcs ?? []).map((item) => ({
      arcId: item.arcId,
      name: item.name,
      coreQuestion: item.coreQuestion,
    })),
    currentPressureSummary: [
      ...(chapterSeed.currentPressure?.pendingForeshadowing ?? []).map((item) => item.description),
      ...(chapterSeed.currentPressure?.openArcs ?? []).map((item) => item.name),
      ...(chapterSeed.previousChapterContinuation?.unresolvedTensions ?? []),
      ...(chapterSeed.previousChapterContinuation?.openHooks ?? []),
    ],
    prevContinuationAvailable: chapterSeed.previousChapterContinuation?.available ?? false,
    pendingCosts: chapterSeed.currentPressure?.pendingCosts ?? [],
  };
}

function loadOriginalPrefix() {
  const chapterDir = join(PROJECT_ROOT, "workspaces", WORKSPACE_ID, "chapters");
  return [16, 17].map((number) => {
    const path = join(chapterDir, `chapter-${number}.md`);
    if (!existsSync(path)) throw new Error(`original prefix chapter missing: ${path}`);
    return readFileSync(path, "utf8");
  }).join("\n\n");
}

async function distillPortableCraftGenes(referenceRegistry, config, callModel) {
  const bodies = DISTILLATION_REFERENCE_IDS.map((id) => ({
    id,
    body: requireReference(referenceRegistry, id).slice(0, 7000),
  }));
  const schema = {
    type: "object",
    properties: {
      genes: {
        type: "array",
        minItems: 3,
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            geneId: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" },
            generationGuidance: { type: "string", minLength: 1, maxLength: 240 },
            requiredMoves: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", maxLength: 80 } },
            avoidPatterns: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", maxLength: 80 } },
          },
          required: ["geneId", "generationGuidance", "requiredMoves", "avoidPatterns"],
          additionalProperties: false,
        },
      },
    },
    required: ["genes"],
    additionalProperties: false,
  };
  const result = await callModel(config, [
    {
      role: "system",
      content: [
        "从分析章节提炼可迁移叙事工艺，不还原作者思维链，不模仿作者身份。",
        "只输出抽象写作决策；禁止作品名、角色名、专有设定、剧情事件、原句或长摘录。",
        "覆盖词汇语域、句式节奏、结构、信息释放、恐怖递进、主动选择、对白功能、章末压力中的至少三类。",
        "只输出符合 schema 的 JSON。",
      ].join("\n"),
    },
    {
      role: "user",
      content: bodies.map((item, index) => `【分析样本 ${index + 1}】\n${item.body}`).join("\n\n"),
    },
  ], {
    responseFormat: "json_schema",
    schema,
    schemaName: "portable_craft_gene_distillation",
    temperature: 0.1,
    maxTokens: 4096,
  });
  const parsed = JSON.parse(result.text);
  return {
    genes: parsed.genes,
    artifact: {
      schemaVersion: "portable-craft-distillation.v1",
      sourceReferenceIds: DISTILLATION_REFERENCE_IDS,
      targetReferenceExcluded: !DISTILLATION_REFERENCE_IDS.includes(TARGET_REFERENCE_ID),
      model: result.model,
      durationMs: result.durationMs,
      responseHash: sha256(result.text),
      rawResponse: result.text,
      genes: parsed.genes,
    },
  };
}

async function generateSceneSolutions({ modelGenerate: generate, intent: chapterIntent, context: compiledContext, seed: chapterSeed, cachedAttempt }) {
  const existingFactIds = compiledContext.facts.map((fact) => fact.id);
  const openPromiseIds = compiledContext.openLoops.map((loop) => loop.id);
  const safeContext = {
    本章功能: chapterIntent.chapterFunction,
    当前压力: chapterIntent.currentPressure,
    相关角色: chapterIntent.relevantCharacters,
    既定事实: compiledContext.facts.slice(0, 12).map((fact) => fact.content),
    开放悬念: compiledContext.openLoops.slice(0, 8).map((loop) => loop.description),
    世界规则: compiledContext.worldRules.slice(0, 10).map((rule) => rule.description),
    前章悬置: chapterSeed.previousChapterContinuation ?? null,
  };
  const systemPrompt = [
      "你是原创长篇小说的场景方案设计器，不写正文。",
      "基于给定原创项目上下文提出恰好三张实质不同的方案卡，模式分别使用：证据调查、主动试探、关系代价。",
      "每张必须包含主动试探、两个替代方案、真实代价、新信息、不可逆状态变化和因果章末压力。",
      "不得新增高影响设定。",
      "只输出合法结构化数据，不输出解释。根对象键必须是“方案列表”。",
      "每张方案只使用这些中文键：编号、模式、表层目标、真实危险、已知事实、未知事项、主动试探、替代方案、选择、代价、新规则或信息、不可逆变化、状态类型、章末因果压力、因果来源、下一步选择、避免模板。",
      "模式只能是证据调查、主动试探、关系代价；状态类型只能是位置、关系、资源、认知、危险、承诺、能力边界。",
    ].join("\n");
  const attempts = cachedAttempt ? [{ ...cachedAttempt, reused: true }] : [];
  const callSceneModel = async (repairFeedback, invalidResponse) => {
    const response = await generate({
      route: "v2_rawstage2",
      kind: "scene_solution_search",
      timeoutMs: TIMEOUT_MS,
      systemPrompt: repairFeedback
        ? [
            "你是结构化数据修复器，只修复语法和缺失键，不改变任何方案的叙事内容。",
            "所有字符串内部引号必须转义。只输出一个合法 JSON 对象，不输出代码围栏或解释。",
          ].join("\n")
        : systemPrompt,
      userPrompt: repairFeedback
        ? `解析错误：${repairFeedback}\n\n待修复内容：\n${invalidResponse}`
        : JSON.stringify(safeContext),
    });
    attempts.push({
      model: response.model,
      provider: response.provider ?? null,
      route: response.route,
      durationMs: response.durationMs,
      responseHash: sha256(response.text),
      rawResponse: response.text,
    });
    return response.text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  };
  let bounded;
  try {
    bounded = await runBoundedJsonRequest({
      request: async () => cachedAttempt
        ? cachedAttempt.rawResponse.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
        : callSceneModel(null, null),
      repair: async (feedback, invalidResponse) => callSceneModel(feedback, invalidResponse),
      parse: (raw) => normalizeChineseSceneSolutionPayload(JSON.parse(raw)),
    });
  } catch (error) {
    writeJson(join(OUTPUT_DIR, "scene-solution-search-failure.json"), {
      schemaVersion: "scene-solution-search-pilot.v1",
      error: error instanceof Error ? error.message : String(error),
      attempts,
    });
    throw error;
  }
  const cards = bounded.value;
  const result = searchSceneSolutions({
    sceneId: `${WORKSPACE_ID}:${CHAPTER_NUMBER}`,
    existingFactIds,
    openPromiseIds,
    cards,
    maxCards: 3,
  });
  return {
    result,
    artifact: {
      schemaVersion: "scene-solution-search-pilot.v1",
      retryCount: bounded.retryCount,
      attempts,
      result,
    },
  };
}

function renderReport(result) {
  const rows = ["A", "B", "C"].map((id) => {
    const verdict = result.verdicts[id];
    const average = result.summary.armAverages[id].toFixed(3);
    const referenceAverage = result.summary.referenceAverages[id].toFixed(3);
    const gap = result.summary.armGaps[id].toFixed(3);
    return `| ${id} | ${average} | ${referenceAverage} | ${gap} | ${verdict.overall_candidate_level} | ${verdict.overall_reference_level} | ${verdict.tier_relationship} | ${verdict.needs_human_review} |`;
  });
  return [
    "# 原创灵异章节 A/B/C 质量上限诊断",
    "",
    `- 原创项目：${result.scope.workspaceId} 第 ${result.scope.chapterNumber} 章只读评测`,
    `- 正文模型：${result.scope.generatorModel}`,
    `- evaluator：${result.scope.judgeModel}`,
    `- evaluator-only reference：${result.scope.targetReferenceId}`,
    `- 隔离审计：${result.isolation.valid ? "PASS" : "FAIL"}`,
    "",
    "| 实验臂 | 候选八维均值 | 参考八维均值 | 相对参考 gap | 候选总体等级 | 参考总体等级 | 同档关系 | 需人工复核 |",
    "|---|---:|---:|---:|---:|---:|---|---|",
    ...rows,
    "",
    `- 最佳实验臂：${result.summary.bestArm}`,
    `- 场景搜索原始增量 B-A：${result.summary.sceneSearchDelta}`,
    `- 工艺基因原始增量 C-B：${result.summary.craftGeneDelta}`,
    `- 场景搜索 reference-adjusted 增量 B-A：${result.summary.referenceAdjustedSceneSearchDelta}`,
    `- 工艺基因 reference-adjusted 增量 C-B：${result.summary.referenceAdjustedCraftGeneDelta}`,
    `- 诊断决策：${result.summary.decision}`,
    `- 是否存在同档证据：${result.summary.anySameTier}`,
    "",
    "## 限制",
    "",
    ...result.limitations.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
