#!/usr/bin/env node
/**
 * Read-only 15-chapter A/B/C validation for the Xinmo workspace.
 *
 * A: ordinary raw
 * B: scene-solution search then raw
 * C: B plus explicitly selected candidate prompt patterns
 *
 * Reference bodies are resolved only after all generator arms for a case have
 * completed. Eval mode prevents chapter save, trace save, and state commit.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const EXT_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const DIST = join(EXT_ROOT, "dist-eval");
const WORKSPACE_ID = "xinmo";
const WORKSPACE_ROOT = join(PROJECT_ROOT, "workspaces", WORKSPACE_ID);
const OUTPUT_DIR = join(PROJECT_ROOT, "reports", "novel-quality-ceiling-20260719", "validation-xinmo-15");
const REGISTRY_PATH = join(PROJECT_ROOT, "reports", "novel-quality-ceiling-20260719", "reference", "reference-registry.json");
const SPLIT_PATH = join(PROJECT_ROOT, "reports", "novel-quality-ceiling-20260719", "holdout", "split-manifest.json");
const TIMEOUT_MS = 600_000;
const cliArgs = process.argv.slice(2);
const requestedRange = parseRange(cliArgs);
const ALL_TARGET_CHAPTERS = Array.from({ length: 15 }, (_, index) => index + 3);
const TARGET_CASES = ALL_TARGET_CHAPTERS
  .map((chapterNumber, referenceIndex) => ({ chapterNumber, referenceIndex }))
  .slice(requestedRange.startIndex, requestedRange.startIndex + requestedRange.limit);
const TARGET_CHAPTERS = TARGET_CASES.map((item) => item.chapterNumber);
const PROMPT_PATTERN_IDS = [
  "scene_decision_evidence_cost_delta",
  "information_ownership_and_unknowns",
  "preserve_explanatory_gap",
  "causal_ending_pressure",
];
const FORBIDDEN_GENERATOR_TERMS = ["smsf:", "神秘复苏", "杨间", "鬼眼", "鬼域", "人皮纸", "敲门鬼"];
const DIMENSION_GUIDES = {
  active_protagonist: "主角是否主动观察、试探、判断、选择并承担代价",
  rule_information_gain: "是否产生可验证且改变选择的新规则或信息",
  scene_state_delta: "位置、关系、资源、认知、危险或承诺是否发生不可逆变化",
  terror_escalation: "恐怖是否沿异常证据、解释失败、规则缺口、试探代价递进",
  dialogue_function: "对白是否承担人物、关系、信息、误导、试探或决策功能",
  information_asymmetry: "读者、主角、配角的信息差是否制造判断压力",
  chapter_end_causal_pressure: "章末压力是否由本章因果推出并改变下一步选择",
  native_chinese: "中文叙述与对白是否自然、具体、无翻译腔和生成模板",
};
const LONG_JUDGE_INPUT_THRESHOLD = 16_000;

process.env.PROJECT_ROOT = PROJECT_ROOT;
process.env.PINOVEL_DISABLE_FALLBACK = "1";
process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS = String(TIMEOUT_MS);
process.env.PINOVEL_GENERATION_MAX_TOKENS = "16384";

mkdirSync(OUTPUT_DIR, { recursive: true });

const importDist = async (relativePath) => import(pathToFileURL(join(DIST, relativePath)).href);
const { ReferenceRegistry } = await importDist(join("novelbench", "index.js"));
const { evaluateCeilingValidationAdmission } = await importDist(join("novelbench", "ceiling-validation-admission.js"));
const {
  prepareIsolatedCeilingCase,
  parseCeilingArmIds,
  runBoundedCeilingOperation,
} = await importDist(join("novelbench", "ceiling-validation-runtime.js"));
const ACTIVE_ARM_IDS = parseCeilingArmIds(cliArgs);
const { runUnifiedPipeline } = await importDist(join("v2", "core", "unified-entry.js"));
const { createLegacyModelGenerateFn } = await importDist(join("v2", "adapters", "legacy-model-route-adapter.js"));
const { resolveWriterPromptProfile } = await importDist(join("v2", "core", "model-prompt-adapter.js"));
const { buildRawPrompt } = await importDist(join("v2", "core", "orchestrator-raw.js"));
const { searchSceneSolutions } = await importDist(join("v2", "core", "scene-solution-search.js"));
const { loadPromptPatternLibrary } = await importDist(join("v2", "core", "prompt-pattern-library.js"));
const { loadCreativeConstitution } = await importDist(join("v2", "core", "creative-constitution.js"));
const { loadModelRoutingSync } = await importDist(join("utils", "config.js"));
const {
  loadJudgeModelConfigFromEnv,
  callJudgeModel,
  describeJudgeConfig,
} = await importDist(join("novelos", "eval", "judge-model-adapter.js"));
const {
  aggregateCeilingDimensionVerdicts,
  buildCeilingDimensionJudgeSchema,
  buildCeilingJudgeSchema,
  buildCeilingJudgeRepairSchema,
  parseAndValidateCeilingDimension,
  parseAndValidateCeilingVerdict,
  runCeilingJudgeWithRepair,
} = await importDist(join("novelos", "eval", "ceiling-judge-schema.js"));
const {
  auditCeilingPilotIsolation,
  buildCeilingJudgeMessages,
  normalizeChineseSceneSolutionPayload,
  runBoundedJsonRequest,
} = await importDist(join("novelos", "eval", "ceiling-abc-pilot.js"));

loadModelRoutingSync();
const judgeConfig = loadJudgeModelConfigFromEnv();
const modelGenerate = createLegacyModelGenerateFn();
const promptProfile = resolveWriterPromptProfile({
  route: "v2_rawstage2",
  provider: "claude",
  model: "claude-opus-4-6",
});

if (!existsSync(REGISTRY_PATH)) throw new Error(`reference registry missing: ${REGISTRY_PATH}`);
if (!existsSync(SPLIT_PATH)) throw new Error(`holdout split missing: ${SPLIT_PATH}`);
const registry = new ReferenceRegistry(REGISTRY_PATH);
registry.load();
const split = readJson(SPLIT_PATH);
if (split.validationSet?.length !== 15) throw new Error("validation split must contain exactly 15 entries");
if ((split.frozenTestSet ?? []).some((entry) => entry.sealed !== true)) throw new Error("frozen split is not sealed");
const referenceRecords = new Map(registry.list().map((record) => [record.referenceId, record]));
const config = readJson(join(WORKSPACE_ROOT, "config.json"));
const skeleton = readJson(join(WORKSPACE_ROOT, "series", "skeleton.json"));
const constitution = loadCreativeConstitution(WORKSPACE_ID, PROJECT_ROOT);

process.stderr.write(`[ceiling-validation] ${describeJudgeConfig(judgeConfig)}\n`);
process.stderr.write(`[ceiling-validation] split=${split.splitHash}, cases=${TARGET_CHAPTERS.length}, arms=${ACTIVE_ARM_IDS.join(",")}, output=${OUTPUT_DIR}\n`);

const observations = [];
for (const [localIndex, targetCase] of TARGET_CASES.entries()) {
  const { chapterNumber, referenceIndex } = targetCase;
  const referenceEntry = split.validationSet[referenceIndex];
  const caseId = `xinmo-ch${chapterNumber}`;
  const caseDir = join(OUTPUT_DIR, caseId);
  mkdirSync(caseDir, { recursive: true });
  process.stderr.write(`[ceiling-validation] case ${referenceIndex + 1}/15 ${caseId} reference=${referenceEntry.referenceId}\n`);
  try {
    prepareIsolatedCeilingCase();
    const caseInput = buildHistoricalCase(chapterNumber, config, skeleton, constitution);
    writeJson(join(caseDir, "case-input-audit.json"), caseInput.audit);
    const sceneSearch = await loadOrGenerateSceneSearch(caseDir, caseInput, modelGenerate);
    if (sceneSearch.result.status !== "selected" || !sceneSearch.result.selected) {
      throw new Error(`scene search failed: ${sceneSearch.result.fallbackReason ?? "no selection"}`);
    }
    const arms = [
      { id: "A", label: "ordinary_raw" },
      { id: "B", label: "scene_solution_raw", sceneSolution: sceneSearch.result.selected },
      {
        id: "C",
        label: "scene_solution_plus_prompt_patterns",
        sceneSolution: sceneSearch.result.selected,
        promptPatternIds: PROMPT_PATTERN_IDS,
      },
    ].filter((arm) => ACTIVE_ARM_IDS.includes(arm.id));
    const generated = {};
    const generatorPayloads = [];
    for (const arm of arms) {
      const patternResolution = loadPromptPatternLibrary(PROJECT_ROOT, {
        mode: "evaluation",
        ...(arm.promptPatternIds ? { explicitPatternIds: arm.promptPatternIds } : {}),
      });
      const rawInput = buildRawInput(caseId, chapterNumber, caseInput, arm, patternResolution);
      const prompt = buildRawPrompt(rawInput);
      generatorPayloads.push(`${prompt.systemPrompt}\n${prompt.userPrompt}`);
      generated[arm.id] = await loadOrGenerateArm(caseDir, arm, rawInput);
    }
    const isolation = auditCeilingPilotIsolation({
      targetReferenceId: referenceEntry.referenceId,
      distillationReferenceIds: [],
      generatorPayloads,
      forbiddenGeneratorTerms: FORBIDDEN_GENERATOR_TERMS,
    });
    writeJson(join(caseDir, "generator-isolation-audit.json"), {
      ...isolation,
      targetReferenceId: referenceEntry.referenceId,
      promptHashes: generatorPayloads.map(sha256),
      futureStateExcluded: caseInput.audit.futureStateExcluded,
      targetChapterBodyExcluded: caseInput.audit.targetChapterBodyExcluded,
    });
    if (!isolation.valid) throw new Error(`generator isolation failed: ${isolation.errors.join(";")}`);

    // The evaluator-only body is deliberately resolved after all generator arms.
    const reference = registry.resolve(referenceEntry.referenceId);
    const record = referenceRecords.get(referenceEntry.referenceId);
    if (!reference || !record || record.bodyHash !== referenceEntry.bodyHash) {
      throw new Error(`reference resolve/hash failed: ${referenceEntry.referenceId}`);
    }
    const verdicts = {};
    for (const arm of arms) {
      verdicts[arm.id] = await loadOrJudgeArm(caseDir, arm.id, generated[arm.id], reference, record);
    }
    const observation = buildObservation(caseId, generated, verdicts, isolation);
    observations.push(observation);
    if (existsSync(join(caseDir, "failure.json"))) {
      writeJson(join(caseDir, "failure.json"), {
        schemaVersion: "ceiling-validation-failure.v1",
        caseId,
        resolved: true,
        resolvedAt: new Date().toISOString(),
      });
    }
    writeJson(join(caseDir, "result.json"), {
      schemaVersion: "ceiling-validation-case.v1",
      caseId,
      chapterNumber,
      referenceId: referenceEntry.referenceId,
      coverageGuess: referenceEntry.coverageGuess,
      generated: summarizeGenerated(generated),
      verdicts,
      observation,
    });
  } catch (error) {
    const failure = {
      schemaVersion: "ceiling-validation-failure.v1",
      caseId,
      chapterNumber,
      referenceId: referenceEntry.referenceId,
      error: error instanceof Error ? error.message : String(error),
    };
    writeJson(join(caseDir, "failure.json"), failure);
    observations.push({
      caseId,
      generatorSuccess: false,
      judgeSchemaValid: false,
      provenanceValid: false,
      referenceIsolationValid: true,
      needsHumanReview: true,
      control: emptyArmObservation(),
      treatment: emptyArmObservation(),
      coreThreeDelta: 0,
    });
    process.stderr.write(`[ceiling-validation] FAILED ${caseId}: ${failure.error}\n`);
  }
}

const decisionB = evaluateCeilingValidationAdmission({
  observations: observations.map((item) => selectTreatment(item, "B")),
});
const decisionC = ACTIVE_ARM_IDS.includes("C")
  ? evaluateCeilingValidationAdmission({ observations })
  : null;
const result = {
  schemaVersion: "ceiling-validation-batch.v1",
  generatedAt: new Date().toISOString(),
  scope: {
    workspaceId: WORKSPACE_ID,
    chapterNumbers: TARGET_CHAPTERS,
    caseCount: TARGET_CHAPTERS.length,
    splitHash: split.splitHash,
    validationReferenceIds: TARGET_CASES.map((item) => split.validationSet[item.referenceIndex].referenceId),
    frozenAccessed: false,
    generatorModel: "claude-opus-4-6",
    judgeModel: judgeConfig.model,
    promptPatternIds: ACTIVE_ARM_IDS.includes("C") ? PROMPT_PATTERN_IDS : [],
    armIds: ACTIVE_ARM_IDS,
  },
  decisions: { sceneSearch: decisionB, sceneSearchPlusPromptPatterns: decisionC },
  observations,
  productionMutation: {
    applied: false,
    reason: decisionB.canEnterProduction
      ? "eligible_but_requires_explicit_activation_step"
      : "production_gates_not_satisfied",
  },
};
const isCompleteRun = requestedRange.startIndex === 0 && requestedRange.limit === 15;
const rangeLabel = `${requestedRange.startIndex + 1}-${requestedRange.startIndex + TARGET_CASES.length}`;
const armSuffix = ACTIVE_ARM_IDS.includes("C") ? "" : "-ab";
const resultName = isCompleteRun ? `result${armSuffix}.json` : `result${armSuffix}-chunk-${rangeLabel}.json`;
const reportName = isCompleteRun ? `verification-report${armSuffix}.md` : `verification-report${armSuffix}-chunk-${rangeLabel}.md`;
writeJson(join(OUTPUT_DIR, resultName), result);
writeFileSync(join(OUTPUT_DIR, reportName), renderReport(result), "utf8");
process.stdout.write(JSON.stringify({ outputDir: OUTPUT_DIR, decisions: result.decisions }, null, 2) + "\n");

function buildHistoricalCase(chapterNumber, workspaceConfig, workspaceSkeleton, creativeConstitution) {
  const previousNumbers = [chapterNumber - 2, chapterNumber - 1].filter((number) => number >= 1);
  const prefixParts = previousNumbers.map((number) => {
    const path = chapterPath(number);
    if (!path) throw new Error(`chapter prefix missing: ${number}`);
    return { number, path, text: readFileSync(path, "utf8") };
  });
  const previous = workspaceSkeleton.chapterSkeletons?.[String(chapterNumber - 1)];
  if (!previous) throw new Error(`previous skeleton missing: ${chapterNumber - 1}`);
  const facts = (previous.facts ?? []).map((content, index) => ({
    id: `fact:previous:${chapterNumber - 1}:${index}`,
    content,
    sourceIds: [`series/skeleton.json#${chapterNumber - 1}`],
    kind: "fact",
  }));
  const dilemmas = (previous.activeDilemmas ?? []).map(String);
  const stateChanges = Array.isArray(previous.stateChanges) ? previous.stateChanges : [];
  const prefix = prefixParts.map((item) => item.text).join("\n\n");
  const visibleCharacters = (workspaceConfig.characters ?? [])
    .filter((character) => character.role !== "deceased")
    .filter((character) => character.role === "protagonist" || [character.name, ...(character.aliases ?? [])].some((name) => prefix.includes(name)))
    .slice(0, 8);
  const primaryPressure = dilemmas[0] ?? facts.at(-1)?.content ?? "承接前章选择造成的新压力";
  const irreversible = stateChanges.at(-1)?.after ?? "主角对当前危险的认知与下一步选择发生变化";
  const protagonist = visibleCharacters.find((character) => character.role === "protagonist")?.name ?? "李一凡";
  const contextConstitution = creativeConstitution ? {
    workIdentity: creativeConstitution.workIdentity,
    readerPromise: creativeConstitution.readerPromise ?? [],
    genrePromises: creativeConstitution.genrePromises ?? [],
    protagonistCoreConflict: creativeConstitution.protagonistCoreConflict,
    thematicQuestions: creativeConstitution.thematicQuestions ?? [],
    aestheticDirection: creativeConstitution.aestheticDirection ?? [],
    forbiddenDrift: creativeConstitution.forbiddenDrift ?? [],
    sourceIds: ["creative-constitution.json"],
  } : null;
  const context = {
    facts,
    characterStates: visibleCharacters.map((character) => ({
      characterId: character.id,
      name: character.name,
      state: { role: character.role, aliases: character.aliases ?? [] },
      sourceIds: ["config.json"],
    })),
    openLoops: dilemmas.map((description, index) => ({
      id: `loop:previous:${chapterNumber - 1}:${index}`,
      description,
      openedAt: `ch${chapterNumber - 1}`,
      urgency: 0.7,
      sourceIds: [`series/skeleton.json#${chapterNumber - 1}`],
    })),
    worldRules: [
      {
        id: "world:genre",
        description: `${workspaceConfig.genre} / ${(workspaceConfig.subGenres ?? []).join("/")}`,
        type: "genre",
        affectedCharacters: [],
        sourceIds: ["config.json"],
      },
    ],
    styleReferences: [],
    sourceMap: [
      { sourceId: "config.json", sourceType: "config", path: `workspaces/${WORKSPACE_ID}/config.json` },
      { sourceId: `series/skeleton.json#${chapterNumber - 1}`, sourceType: "state", path: `workspaces/${WORKSPACE_ID}/series/skeleton.json` },
    ],
    constitution: contextConstitution,
    longTermState: null,
    bridgeContext: {
      available: true,
      lastEventSummary: facts.at(-1)?.content ?? previous.title,
      endingEmotion: stateChanges.at(-1)?.after,
      openHooks: [],
      unresolvedTensions: dilemmas,
      introducedCharacters: stateChanges.map((change) => change.subject).filter(Boolean),
      sourceIds: [`series/skeleton.json#${chapterNumber - 1}`],
    },
  };
  const intent = {
    chapterFunction: `承接前章并推进：${primaryPressure}`,
    readerExperience: creativeConstitution?.readerPromise?.slice(0, 4) ?? ["人物选择推动压力升级"],
    currentPressure: dilemmas.length > 0 ? dilemmas : [primaryPressure],
    meaningfulChoices: dilemmas.length > 0 ? dilemmas : [primaryPressure],
    promisesToAdvance: dilemmas,
    possibleEndPressure: [primaryPressure],
    relevantCharacters: visibleCharacters.map((character) => character.name),
    inviolableFacts: creativeConstitution?.forbiddenDrift ?? [],
    concreteDelivery: [`承接前章未结压力：${primaryPressure}`],
    focusCharacterGoals: [{ character: protagonist, goal: `主动确认并处理：${primaryPressure}` }],
    resistance: [primaryPressure],
    choicesAndCosts: [{ choice: "在信息不完整时主动验证后再选择", cost: "验证会暴露意图、消耗窗口或改变关系" }],
    expectedIrreversibleChange: [irreversible],
    selectedPromisesToAdvance: dilemmas.slice(0, 3).map((description, index) => ({
      promiseId: `previous-${chapterNumber - 1}-${index}`,
      description,
    })),
    causalEndPressure: [`本章选择的后果必须改变下一步行动：${primaryPressure}`],
    factAndCharacterKnowledgeForbiddenZones: ["角色不得知道前文未建立的信息；不得新增无来源的高影响设定"],
    fieldSourceRefs: {
      concreteDelivery: [`series/skeleton.json#${chapterNumber - 1}`],
      focusCharacterGoals: ["config.json", `series/skeleton.json#${chapterNumber - 1}`],
      resistance: [`series/skeleton.json#${chapterNumber - 1}`],
      choicesAndCosts: [`series/skeleton.json#${chapterNumber - 1}`],
      expectedIrreversibleChange: [`series/skeleton.json#${chapterNumber - 1}`],
      selectedPromisesToAdvance: [`series/skeleton.json#${chapterNumber - 1}`],
      causalEndPressure: [`series/skeleton.json#${chapterNumber - 1}`],
      factAndCharacterKnowledgeForbiddenZones: ["creative-constitution.json"],
    },
    sourceRefs: ["config.json", "creative-constitution.json", `series/skeleton.json#${chapterNumber - 1}`],
    underSpecifiedFields: [],
  };
  return {
    prefix,
    context,
    intent,
    characterNames: visibleCharacters.map((character) => character.name),
    audit: {
      schemaVersion: "ceiling-historical-case-audit.v1",
      chapterNumber,
      prefixChapters: prefixParts.map((item) => ({ chapterNumber: item.number, path: relativePath(item.path), hash: sha256(item.text) })),
      previousSkeletonChapter: chapterNumber - 1,
      targetChapterBodyExcluded: !prefixParts.some((item) => item.number === chapterNumber),
      futureStateExcluded: context.longTermState === null,
      generatorSourceMaximumChapter: chapterNumber - 1,
    },
  };
}

function buildRawInput(caseId, chapterNumber, caseInput, arm, patternResolution) {
  return {
    workspaceId: `eval-${WORKSPACE_ID}`,
    chapterId: `${caseId}-${arm.id}`,
    chapterNumber,
    projectRoot: PROJECT_ROOT,
    intent: caseInput.intent,
    context: caseInput.context,
    constitution: caseInput.context.constitution,
    characterNames: caseInput.characterNames,
    modelGenerate,
    timeoutMs: TIMEOUT_MS,
    evalMode: "B1",
    evalPrefix: caseInput.prefix,
    rawPromptProfile: promptProfile,
    promptPatternResolution: patternResolution,
    ...(arm.sceneSolution ? { sceneSolution: arm.sceneSolution } : {}),
  };
}

async function loadOrGenerateArm(caseDir, arm, rawInput) {
  const prosePath = join(caseDir, `arm-${arm.id}.md`);
  const metadataPath = join(caseDir, `arm-${arm.id}-metadata.json`);
  if (existsSync(prosePath) && existsSync(metadataPath)) {
    const text = readFileSync(prosePath, "utf8");
    const metadata = readJson(metadataPath);
    if (metadata.status === "ok" && metadata.candidateHash === sha256(text)) return { ...metadata, text };
  }
  const startMs = Date.now();
  let operationAttempts = 0;
  const result = await runBoundedCeilingOperation({
    maxAttempts: 2,
    operation: async (attempt) => {
      operationAttempts = attempt;
      const output = await runUnifiedPipeline({
        workspaceId: rawInput.workspaceId,
        chapterId: rawInput.chapterId,
        chapterNumber: rawInput.chapterNumber,
        projectRoot: PROJECT_ROOT,
        candidateTimeoutMs: TIMEOUT_MS,
        evalMode: "B1",
        evalPrefix: rawInput.evalPrefix,
        evalIntent: rawInput.intent,
        evalContext: rawInput.context,
        evalModelGenerate: modelGenerate,
        evalPromptProfile: promptProfile,
        evalCharacterNames: rawInput.characterNames,
        ...(arm.sceneSolution ? { sceneSolution: arm.sceneSolution } : {}),
        ...(arm.promptPatternIds ? { promptPatternIds: arm.promptPatternIds } : {}),
      });
      const outputText = output.text ?? "";
      if (output.status !== "ok" || outputText.trim().length === 0) {
        writeJson(join(caseDir, `arm-${arm.id}-failure.json`), {
          attempt,
          status: output.status,
          failureEnvelope: output.failureEnvelope ?? null,
          warnings: output.warnings ?? [],
          stageResults: output.stageResults ?? {},
          textLength: outputText.length,
        });
        throw new Error(`arm ${arm.id} generation failed: ${output.failureEnvelope?.reason ?? output.status}`);
      }
      return output;
    },
  });
  const text = result.text ?? "";
  writeFileSync(prosePath, text, "utf8");
  const metadata = {
    armId: arm.id,
    label: arm.label,
    status: "ok",
    candidateHash: sha256(text),
    textLength: text.length,
    durationMs: Date.now() - startMs,
    operationAttempts,
    modelCalls: result.stageResults?.modelCalls ?? [],
    selectedSource: result.selectedSource ?? "raw",
    promptPatternIds: result.stageResults?.promptPatterns?.patternIds ?? [],
    chapterFilePath: result.chapterFilePath ?? null,
  };
  if (metadata.chapterFilePath !== null) throw new Error(`eval arm attempted persistence: ${metadata.chapterFilePath}`);
  writeJson(metadataPath, metadata);
  return { ...metadata, text };
}

async function loadOrGenerateSceneSearch(caseDir, caseInput, generate) {
  const artifactPath = join(caseDir, "scene-solution-search.json");
  if (existsSync(artifactPath)) return readJson(artifactPath);
  const existingFactIds = caseInput.context.facts.map((fact) => fact.id);
  const openPromiseIds = caseInput.context.openLoops.map((loop) => loop.id);
  const safeContext = {
    本章功能: caseInput.intent.chapterFunction,
    当前压力: caseInput.intent.currentPressure,
    相关角色: caseInput.intent.relevantCharacters,
    既定事实: caseInput.context.facts.map((fact) => fact.content),
    开放悬念: caseInput.context.openLoops.map((loop) => loop.description),
    前章悬置: caseInput.context.bridgeContext,
  };
  const attempts = [];
  const request = async (feedback, invalidResponse) => {
    const response = await generate({
      route: "v2_rawstage2",
      kind: "scene_solution_search",
      timeoutMs: TIMEOUT_MS,
      systemPrompt: feedback
        ? [
            "你是原创长篇小说的场景方案设计器，不写正文。",
            "重新生成恰好三张实质不同的方案卡，模式依次为证据调查、主动试探、关系代价。",
            "根对象键必须是“方案列表”。",
            "每张只使用：编号、模式、表层目标、真实危险、已知事实、未知事项、主动试探、替代方案、选择、代价、新规则或信息、不可逆变化、状态类型、章末因果压力、因果来源、下一步选择、避免模板。",
            "模式只能是证据调查、主动试探、关系代价；状态类型只能是位置、关系、资源、认知、危险、承诺、能力边界。",
            "已知事实、未知事项、替代方案、避免模板必须是字符串数组，不得使用对象数组。",
            "",
            "你是结构化场景方案修复器，不写正文。",
            "上次响应可能被截断；不要续写或修补截断文本，必须依据原始上下文重新生成完整的三张方案卡。",
            "保持字段精简，每个文本字段不超过80个汉字，只输出合法 JSON。",
          ].join("\n")
        : [
            "你是原创长篇小说的场景方案设计器，不写正文。",
            "基于原创上下文提出恰好三张实质不同的方案卡，模式依次为证据调查、主动试探、关系代价。",
            "每张必须包含主动试探、两个替代方案、真实代价、新信息、不可逆状态变化和因果章末压力。",
            "不得新增高影响设定。根对象键必须是“方案列表”。",
            "每张只使用：编号、模式、表层目标、真实危险、已知事实、未知事项、主动试探、替代方案、选择、代价、新规则或信息、不可逆变化、状态类型、章末因果压力、因果来源、下一步选择、避免模板。",
            "模式只能是证据调查、主动试探、关系代价；状态类型只能是位置、关系、资源、认知、危险、承诺、能力边界。",
            "每个文本字段不超过80个汉字；已知事实、未知事项、替代方案、避免模板各不超过3项。",
          ].join("\n"),
      userPrompt: feedback
        ? JSON.stringify({ validationError: feedback, originalContext: safeContext })
        : JSON.stringify(safeContext),
      maxTokens: 4096,
    });
    attempts.push({
      model: response.model,
      provider: response.provider ?? null,
      route: response.route,
      durationMs: response.durationMs,
      responseHash: sha256(response.text),
      rawResponse: response.text,
    });
    return stripFence(response.text);
  };
  let bounded;
  let operationAttempts = 0;
  try {
    bounded = await runBoundedCeilingOperation({
      maxAttempts: 2,
      operation: async (attempt) => {
        operationAttempts = attempt;
        return runBoundedJsonRequest({
          request: () => request(null, null),
          repair: (feedback, invalidResponse) => request(feedback, invalidResponse),
          parse: (raw) => normalizeChineseSceneSolutionPayload(JSON.parse(raw)),
        });
      },
    });
  } catch (error) {
    writeJson(join(caseDir, "scene-solution-search-failure.json"), {
      schemaVersion: "scene-solution-validation-failure.v1",
      error: error instanceof Error ? error.message : String(error),
      attempts,
    });
    throw error;
  }
  const result = searchSceneSolutions({
    sceneId: `xinmo:${caseInput.audit.chapterNumber}`,
    existingFactIds,
    openPromiseIds,
    cards: bounded.value,
    maxCards: 3,
  });
  const artifact = {
    schemaVersion: "scene-solution-validation.v1",
    operationAttempts,
    retryCount: bounded.retryCount,
    attempts,
    result,
  };
  writeJson(artifactPath, artifact);
  return artifact;
}

async function loadOrJudgeArm(caseDir, armId, generated, reference, record) {
  const path = join(caseDir, `judge-${armId}.json`);
  if (existsSync(path)) {
    const artifact = readJson(path);
    if (artifact.status === "valid" && artifact.candidateHash === generated.candidateHash && artifact.referenceBodyHash === record.bodyHash) {
      return artifact.verdict;
    }
  }
  const messages = buildCeilingJudgeMessages(generated.text, reference);
  const verifiedCandidateSpans = buildVerifiedSpanHints(generated.text);
  const verifiedReferenceSpans = buildVerifiedSpanHints(reference);
  const responses = [];
  const runAndStoreDimensionSplit = async (trigger) => {
    const splitRun = await runDimensionSplitJudge({
      armId,
      candidate: generated.text,
      reference,
      verifiedCandidateSpans,
      verifiedReferenceSpans,
      responses,
    });
    writeJson(path, {
      armId,
      status: "valid",
      verdict: splitRun.verdict,
      errors: [],
      inputMode: "dimension_split_full_text",
      splitTrigger: trigger,
      operationAttempts: splitRun.operationAttempts,
      retryCount: splitRun.retryCount,
      provenance: splitRun.provenance,
      candidateHash: generated.candidateHash,
      referenceBodyHash: record.bodyHash,
      responses,
    });
    return splitRun.verdict;
  };
  if (generated.text.length + reference.length > LONG_JUDGE_INPUT_THRESHOLD) {
    return runAndStoreDimensionSplit("combined_input_length");
  }
  const invoke = async (feedback) => {
    const result = await callJudgeModel(judgeConfig, feedback ? [...messages, {
      role: "user",
      content: [
        `上次输出未通过严格 schema/span 校验：${feedback}。`,
        "只修复失败字段，但必须返回完整 JSON。excerpt 必须逐字复制，禁止改写、纠错、简繁转换、翻译或把 BB 等拉丁字符转成中文。",
        "优先使用下面经程序确认存在于原文的短 span；也可从全文复制其他 15-80 字连续片段。",
        `【候选章已验证 span】\n${verifiedCandidateSpans.map((span) => `- ${span}`).join("\n")}`,
        `【参考章已验证 span】\n${verifiedReferenceSpans.map((span) => `- ${span}`).join("\n")}`,
        "重新检查全部 8 维，只输出完整合法 JSON。",
      ].join("\n\n"),
    }] : messages, {
      responseFormat: "json_schema",
      schema: feedback
        ? buildCeilingJudgeRepairSchema({
            candidateSpans: verifiedCandidateSpans,
            referenceSpans: verifiedReferenceSpans,
          })
        : buildCeilingJudgeSchema(),
      schemaName: "ceiling_quality_verdict_v2",
      temperature: 0.1,
      maxTokens: 4096,
    });
    responses.push({ model: result.model, durationMs: result.durationMs, responseHash: sha256(result.text), text: result.text });
    return result.text;
  };
  let operationAttempts = 0;
  let lastRun = null;
  let run;
  try {
    run = await runBoundedCeilingOperation({
      maxAttempts: 2,
      operation: async (attempt) => {
        operationAttempts = attempt;
        const output = await runCeilingJudgeWithRepair({
          candidate: generated.text,
          reference,
          request: () => invoke(null),
          repair: (feedback) => invoke(feedback),
          provenance: { requestId: `ceiling-validation-${armId}-${randomUUID()}`, model: judgeConfig.model, route: "v2_literary_judge" },
        });
        lastRun = output;
        if (output.status !== "valid" || !output.verdict) {
          throw new Error(`judge ${armId} invalid: ${output.errors.join(";")}`);
        }
        return output;
      },
    });
  } catch (error) {
    const errorText = `${error instanceof Error ? error.message : String(error)};${lastRun?.errors?.join(";") ?? ""}`;
    if (/HTTP 50[24]|timeout|timed out/iu.test(errorText)) {
      return runAndStoreDimensionSplit("full_verdict_transport_failure");
    }
    writeJson(path, {
      armId,
      status: "invalid",
      verdict: lastRun?.verdict ?? null,
      errors: lastRun?.errors ?? [error instanceof Error ? error.message : String(error)],
      operationAttempts,
      retryCount: lastRun?.retryCount ?? 0,
      provenance: lastRun?.provenance ?? null,
      candidateHash: generated.candidateHash,
      referenceBodyHash: record.bodyHash,
      responses,
    });
    throw error;
  }
  const artifact = {
    armId,
    status: run.status,
    verdict: run.verdict,
    errors: run.errors,
    operationAttempts,
    retryCount: run.retryCount,
    provenance: run.provenance,
    candidateHash: generated.candidateHash,
    referenceBodyHash: record.bodyHash,
    responses,
  };
  writeJson(path, artifact);
  return run.verdict;
}

async function runDimensionSplitJudge(input) {
  const dimensions = [];
  const operationAttempts = {};
  let retryCount = 0;
  for (const [id, guide] of Object.entries(DIMENSION_GUIDES)) {
    const invoke = async (feedback) => {
      const messages = [
        {
          role: "system",
          content: [
            "你是中文商业小说绝对质量裁判。参考章只用于 evaluator，不是正确答案。",
            `本次只判断 ${id}: ${guide}。独立给候选与参考评 1-5 级。`,
            "双方各引用恰好一个连续原文 span，reason 不超过120个汉字。不得按题材、角色或剧情相似度评分。",
            "只输出符合 JSON schema 的对象。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "【原创候选章】",
            input.candidate,
            "【evaluator-only 参考章】",
            input.reference,
            ...(feedback ? [
              `【修复要求】上次输出无效：${feedback}`,
              `候选 excerpt 必须从以下已验证 span 选择：\n${input.verifiedCandidateSpans.map((span) => `- ${span}`).join("\n")}`,
              `参考 excerpt 必须从以下已验证 span 选择：\n${input.verifiedReferenceSpans.map((span) => `- ${span}`).join("\n")}`,
            ] : []),
          ].join("\n\n"),
        },
      ];
      const result = await callJudgeModel(judgeConfig, messages, {
        responseFormat: "json_schema",
        schema: buildCeilingDimensionJudgeSchema(id, feedback ? {
          candidateSpans: input.verifiedCandidateSpans,
          referenceSpans: input.verifiedReferenceSpans,
        } : undefined),
        schemaName: `ceiling_dimension_${id}_v1`,
        temperature: 0.1,
        maxTokens: 1024,
      });
      input.responses.push({
        mode: "dimension_split_full_text",
        dimensionId: id,
        model: result.model,
        durationMs: result.durationMs,
        responseHash: sha256(result.text),
        text: result.text,
      });
      return result.text;
    };
    const bounded = await runBoundedCeilingOperation({
      maxAttempts: 2,
      operation: async (attempt) => {
        operationAttempts[id] = attempt;
        return runBoundedJsonRequest({
          request: () => invoke(null),
          repair: (feedback) => invoke(feedback),
          parse: (raw) => {
            const parsed = parseAndValidateCeilingDimension(raw, id, {
              candidate: input.candidate,
              reference: input.reference,
            });
            if (!parsed.valid || !parsed.dimension) throw new Error(parsed.errors.join(";"));
            return parsed.dimension;
          },
        });
      },
    });
    retryCount += bounded.retryCount;
    dimensions.push(bounded.value);
  }
  const verdict = aggregateCeilingDimensionVerdicts(dimensions);
  return {
    verdict,
    operationAttempts,
    retryCount,
    provenance: {
      requestId: `ceiling-validation-${input.armId}-dimension-split-${randomUUID()}`,
      model: judgeConfig.model,
      route: "v2_literary_judge",
      schemaVersion: "ceiling-judge.dimension-split.v1",
      responseHash: sha256(input.responses.map((response) => response.responseHash).join(":")),
    },
  };
}

function buildObservation(caseId, generated, verdicts, isolation) {
  const armA = armObservation(verdicts.A);
  const armB = armObservation(verdicts.B);
  const armC = verdicts.C ? armObservation(verdicts.C) : null;
  const coreIds = new Set(["active_protagonist", "rule_information_gain", "scene_state_delta"]);
  const sceneSearchCoreThreeDelta = mean(verdicts.B.dimensions.filter((item) => coreIds.has(item.id)).map((item) => {
    const control = verdicts.A.dimensions.find((candidate) => candidate.id === item.id);
    return item.candidate_level - (control?.candidate_level ?? 0);
  }));
  const coreThreeDelta = verdicts.C
    ? mean(verdicts.C.dimensions.filter((item) => coreIds.has(item.id)).map((item) => {
        const control = verdicts.A.dimensions.find((candidate) => candidate.id === item.id);
        return item.candidate_level - (control?.candidate_level ?? 0);
      }))
    : sceneSearchCoreThreeDelta;
  return {
    caseId,
    generatorSuccess: Object.values(generated).every((item) => item.status === "ok"),
    judgeSchemaValid: true,
    provenanceValid: true,
    referenceIsolationValid: isolation.valid,
    needsHumanReview: Object.values(verdicts).some((item) => item.needs_human_review),
    control: armA,
    sceneSearch: armB,
    sceneSearchCoreThreeDelta,
    treatment: armC ?? armB,
    coreThreeDelta,
  };
}

function selectTreatment(observation, arm) {
  if (!observation.sceneSearch) return observation;
  const treatment = arm === "B" ? observation.sceneSearch : observation.treatment;
  return {
    ...observation,
    treatment,
    coreThreeDelta: arm === "B" ? observation.sceneSearchCoreThreeDelta : observation.coreThreeDelta,
  };
}

function armObservation(verdict) {
  const levels = verdict.dimensions.map((item) => item.candidate_level);
  const referenceLevels = verdict.dimensions.map((item) => item.reference_level);
  const coreIds = new Set(["active_protagonist", "rule_information_gain", "scene_state_delta", "chapter_end_causal_pressure"]);
  return {
    average: mean(levels),
    coreMinimum: Math.min(...verdict.dimensions.filter((item) => coreIds.has(item.id)).map((item) => item.candidate_level)),
    referenceAdjustedGap: mean(levels) - mean(referenceLevels),
    hardRegression: false,
  };
}

function emptyArmObservation() {
  return { average: 0, coreMinimum: 0, referenceAdjustedGap: 0, hardRegression: true };
}

function summarizeGenerated(generated) {
  return Object.fromEntries(Object.entries(generated).map(([id, item]) => [id, {
    candidateHash: item.candidateHash,
    textLength: item.textLength,
    durationMs: item.durationMs,
    modelCalls: item.modelCalls,
    promptPatternIds: item.promptPatternIds,
  }]));
}

function chapterPath(number) {
  const candidates = [
    join(WORKSPACE_ROOT, "chapters", `chapter-${String(number).padStart(2, "0")}.md`),
    join(WORKSPACE_ROOT, "chapters", `chapter-${number}.md`),
    join(WORKSPACE_ROOT, "chapters", `${number}.md`),
  ];
  return candidates.find(existsSync) ?? null;
}

function renderReport(result) {
  const includesC = result.scope.armIds.includes("C");
  const rows = result.observations.map((item) => includesC
    ? `| ${item.caseId} | ${item.control.average.toFixed(3)} | ${(item.sceneSearch?.average ?? 0).toFixed(3)} | ${item.treatment.average.toFixed(3)} | ${item.coreThreeDelta.toFixed(3)} | ${item.needsHumanReview} |`
    : `| ${item.caseId} | ${item.control.average.toFixed(3)} | ${(item.sceneSearch?.average ?? 0).toFixed(3)} | ${item.coreThreeDelta.toFixed(3)} | ${item.needsHumanReview} |`);
  return [
    "# 心魔界 15 章 A/B/C 真实验证",
    "",
    `- 正文模型：${result.scope.generatorModel}`,
    `- evaluator：${result.scope.judgeModel}`,
    `- validation split：${result.scope.splitHash}`,
    `- frozen reference 是否访问：${result.scope.frozenAccessed}`,
    `- 场景搜索决策：${result.decisions.sceneSearch.status}`,
    `- 场景搜索 + 提示模式决策：${result.decisions.sceneSearchPlusPromptPatterns?.status ?? "not_run"}`,
    `- 是否进入生产：${result.decisions.sceneSearch.canEnterProduction}`,
    "",
    includesC
      ? "| case | A 普通 raw | B 场景搜索 | C 场景+提示模式 | C 核心三项增量 | 人工复核 |"
      : "| case | A 普通 raw | B 场景搜索 | B 核心三项增量 | 人工复核 |",
    includesC ? "|---|---:|---:|---:|---:|---|" : "|---|---:|---:|---:|---|",
    ...rows,
    "",
    "## 准入边界",
    "",
    "- validation 量化通过只允许进入 frozen/连续性验证。",
    "- frozen、连续 3-5 章、人工盲评、用户接受率/返工量任一缺失，不激活生产模式。",
    "- reference 仅进入 evaluator；生成 payload 隔离审计逐 case 保存。",
    "",
  ].join("\n");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function stripFence(value) {
  return value.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
}

function buildVerifiedSpanHints(source) {
  const normalized = source.replace(/\r\n/gu, "\n");
  const paragraphs = normalized
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length >= 20);
  const spans = [];
  for (const paragraph of paragraphs) {
    const compact = paragraph.replace(/\n/gu, "\n");
    const span = compact.length <= 80 ? compact : compact.slice(0, 72);
    if (span.length >= 15 && normalized.includes(span)) spans.push(span);
    if (spans.length >= 16) break;
  }
  return spans;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function relativePath(path) {
  return path.replace(`${PROJECT_ROOT}\\`, "").replaceAll("\\", "/");
}

function parseRange(args) {
  const startFlag = args.indexOf("--start");
  const limitFlag = args.indexOf("--limit");
  const start = startFlag === -1 ? 1 : Number(args[startFlag + 1]);
  const defaultLimit = 16 - start;
  const limit = limitFlag === -1 ? defaultLimit : Number(args[limitFlag + 1]);
  if (!Number.isInteger(start) || start < 1 || start > 15) {
    throw new Error("--start must be an integer from 1 to 15");
  }
  if (!Number.isInteger(limit) || limit < 1 || start + limit - 1 > 15) {
    throw new Error("--limit must keep the selected range within cases 1 to 15");
  }
  return { startIndex: start - 1, limit };
}
