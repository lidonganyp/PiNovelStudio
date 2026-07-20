/**
 * AUTHORITATIVE-GENERATION-CONTRACT-1
 *
 * Author-owned narrative information must reach the writer, while prose
 * execution choices and experiment-wide strategy admissions stay out of the
 * production generation contract.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildChapterSeed } from "../dist-test/craft/chapter-seed-builder.js";
import { createSeedReadinessChecker } from "../dist-test/craft/seed-readiness-checker.js";
import { preflightWorkspace } from "../dist-test/craft/workspace-preflight-checker.js";
import { createChapterIntentBuilder } from "../dist/v2/core/chapter-intent-builder.js";
import { buildRawPrompt } from "../dist/v2/core/orchestrator-raw.js";
import {
  adaptWriterPrompt,
  buildChapterContract,
} from "../dist/v2/core/model-prompt-adapter.js";
import * as unifiedEntry from "../dist/v2/core/unified-entry.js";
import { searchSceneSolutions } from "../dist-test/v2/core/scene-solution-search.js";

function createWorkspace(chapterNumber = 1) {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-author-contract-"));
  const workspaceId = "author-contract";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(join(workspacePath, "characters"), { recursive: true });
  mkdirSync(join(workspacePath, "series"), { recursive: true });
  mkdirSync(join(workspacePath, "chapters"), { recursive: true });
  writeFileSync(join(workspacePath, "characters", "hero.md"), "# 林川\n", "utf8");
  writeFileSync(join(workspacePath, "config.json"), JSON.stringify({
    novelName: "测试作品",
    genre: "悬疑",
    subGenres: ["都市"],
    characters: [
      { id: "hero", name: "林川", role: "protagonist" },
      { id: "ally", name: "许岚", role: "supporting" },
      { id: "unused", name: "未出场者", role: "supporting" },
    ],
  }), "utf8");
  const explicitOutline = `# 第${chapterNumber}章\n\n## 章节定位\n- **承接**：前章末林川在门外听见许岚的声音\n- **本章功能**：确认门后身份并推进失踪案\n- **章末目标**：真正的许岚从楼梯口出现\n\n### 事件 1：门外试探\n- **参与角色**：林川、许岚\n- **人物动机**：林川要确认许岚是否可信\n- **内容摘要**：林川依据门锁事实确认门后的声音在冒充许岚。\n- **感知锚点**：冷空气、脚步声、门缝霉味\n- **必须包含**：门锁只能从室内打开、声音说出不该知道的信息\n- **状态变化**：林川从怀疑转为确认冒充者存在\n- **因果关系**：门锁事实与错误记忆共同暴露冒充者\n- **伏笔埋设**：许岚失踪与旧案有关\n\n## 风格基调强约束\n- 短句，段落极短\n- 强制使用听觉与嗅觉\n- 对白不带说话标签\n+`;
  writeFileSync(
    join(workspacePath, "series", `ch${chapterNumber}-outline-explicit.md`),
    explicitOutline,
    "utf8",
  );
  return { projectRoot, workspaceId, workspacePath };
}

function minimalRawInput() {
  return {
    workspaceId: "w",
    chapterId: "ch2",
    chapterNumber: 2,
    projectRoot: process.cwd(),
    intent: {
      chapterFunction: "确认门后身份并推进失踪案",
      overallPlotDirection: ["失踪案逐步指向城内组织"],
      previousState: ["前章末林川在门外听见许岚的声音"],
      characterMotivations: [{ character: "林川", motivation: "确认许岚是否可信" }],
      foreshadowing: ["许岚失踪与旧案有关"],
      causalRelations: ["门锁事实与错误记忆共同暴露冒充者"],
      endingTarget: ["真正的许岚从楼梯口出现"],
      authorEventSummaries: ["林川确认门后的声音在冒充许岚"],
      authorMustInclude: ["门锁只能从室内打开"],
      readerExperience: ["紧张"],
      currentPressure: ["脚步声接近"],
      meaningfulChoices: [],
      promisesToAdvance: [],
      possibleEndPressure: [],
      relevantCharacters: ["林川", "许岚"],
      inviolableFacts: ["门锁只能从室内打开"],
      sourceRefs: ["series/ch2-outline-explicit.md"],
      concreteDelivery: [],
      focusCharacterGoals: [],
      resistance: [],
      choicesAndCosts: [],
      expectedIrreversibleChange: [],
      selectedPromisesToAdvance: [],
      selectedExpectationsToAdvance: [],
      causalEndPressure: ["真正的许岚从楼梯口出现"],
      factAndCharacterKnowledgeForbiddenZones: ["林川不知道许岚当前所在位置"],
      fieldSourceRefs: {},
      underSpecifiedFields: [],
    },
    context: {
      facts: [{ id: "fact:door", content: "门锁只能从室内打开", sourceIds: ["outline"], kind: "fact" }],
      characterStates: [
        { characterId: "hero", name: "林川", state: { role: "protagonist" }, sourceIds: ["character"] },
      ],
      openLoops: [{ id: "hook:missing", description: "许岚失踪与旧案有关", openedAt: "ch1", urgency: 0.8, sourceIds: ["ledger"] }],
      worldRules: [{ id: "world:door", description: "异常不能隔门读取未说出的记忆", type: "immutable_fact", affectedCharacters: [], sourceIds: ["world"] }],
      styleReferences: [{ id: "style:1", kind: "fingerprint", content: "每段一到三句，偏好短句", sourceIds: ["style"] }],
      sourceMap: [],
      constitution: null,
      longTermState: null,
    },
    constitution: {
      workIdentity: "都市失踪案",
      readerPromise: ["每章提供新线索"],
      genrePromises: ["线索可回溯"],
      protagonistCoreConflict: "林川必须在不信任中依赖同伴",
      thematicQuestions: ["记忆能否证明身份"],
      aestheticDirection: ["短句", "冷峻"],
      forbiddenDrift: ["不把异常写成无规则幻觉"],
      sourceIds: ["constitution"],
    },
    characterNames: ["林川", "许岚"],
    sceneSolution: {
      id: "scene-1",
      mode: "evidence_investigation",
      surfaceGoal: "确认门后身份",
      trueDanger: "回应会暴露位置",
      knownFacts: ["门锁只能从室内打开"],
      unknowns: ["门后身份"],
      activeTestAction: "用假记忆试探",
      alternatives: ["不开门", "绕行"],
      choice: "继续试探",
      cost: "暴露怀疑",
      newRuleOrInformation: "声音只能复述听过的信息",
      irreversibleChange: "双方确认敌意",
      stateKind: "knowledge",
      endingPressure: "真正的许岚出现",
      causalSource: "错误回答暴露身份",
      nextChoice: "判断谁是真的",
      templateAvoidance: ["不用冷汗和脚步声"],
      sourceFactIds: ["fact:door"],
      openPromiseIds: [],
    },
    craftGenes: [{
      geneId: "forced_probe",
      generationGuidance: "先写感知异常，再让主角主动试探。",
      requiredMoves: ["主动试探"],
      avoidPatterns: ["长段落"],
    }],
    promptPatternResolution: {
      promptBlock: "【经生产准入的叙事决策】必须把信息改成对白冲突。",
      patternIds: ["dialogue_conflict"],
      trace: { libraryStatus: "loaded", mode: "production", discovered: [], selected: [], dropped: [], errors: [] },
    },
    modelGenerate: async () => ({ text: "stub", model: "stub", route: "stub", durationMs: 0 }),
  };
}

test("显式章纲内容契约进入 ChapterSeed，但感知锚点和风格强约束不进入", () => {
  const workspace = createWorkspace(1);
  try {
    const result = buildChapterSeed({
      workspacePath: workspace.workspacePath,
      workspaceId: workspace.workspaceId,
      chapterId: "1",
      chapterNumber: 1,
    });
    const contract = result.seed.authorChapterContract;
    assert.equal(contract?.chapterFunction, "确认门后身份并推进失踪案");
    assert.deepEqual(contract?.eventSummaries, ["林川依据门锁事实确认门后的声音在冒充许岚。​".replace("\u200b", "")]);
    assert.ok(contract?.mustInclude.includes("门锁只能从室内打开"));
    assert.ok(contract?.stateChanges.includes("林川从怀疑转为确认冒充者存在"));
    assert.ok(contract?.foreshadowing.includes("许岚失踪与旧案有关"));
    assert.ok(contract?.causalRelations.includes("门锁事实与错误记忆共同暴露冒充者"));
    assert.equal(contract?.endingTarget, "真正的许岚从楼梯口出现");
    assert.deepEqual(contract?.relevantCharacters, ["林川", "许岚"]);
    assert.equal(result.seed.candidateAnchors.some((entry) => /冷空气|脚步声|霉味/.test(entry.description)), false);
    assert.equal(JSON.stringify(contract).includes("短句"), false);
    assert.equal(JSON.stringify(contract).includes("嗅觉"), false);
  } finally {
    rmSync(workspace.projectRoot, { recursive: true, force: true });
  }
});

test("感知锚点不再是 SeedReadiness 或显式章纲 Preflight 的阻断条件", () => {
  const workspace = createWorkspace(1);
  try {
    const seed = buildChapterSeed({
      workspacePath: workspace.workspacePath,
      workspaceId: workspace.workspaceId,
      chapterId: "1",
      chapterNumber: 1,
    }).seed;
    seed.candidateAnchors = [];
    const readiness = createSeedReadinessChecker().check(seed);
    assert.equal(readiness.shouldBlockGeneration, false);
    assert.equal(readiness.dimensions.some((dimension) => dimension.dimension === "candidateAnchors"), false);

    const preflight = preflightWorkspace({
      ...workspace,
      chapterId: "1",
      chapterNumber: 1,
    });
    assert.equal(preflight.blockingItems.some((item) => /感知锚点/.test(item.reason)), false);
  } finally {
    rmSync(workspace.projectRoot, { recursive: true, force: true });
  }
});

test("损坏或空壳 skeleton 不得压过真实前章正文", () => {
  const workspace = createWorkspace(2);
  try {
    writeFileSync(join(workspace.workspacePath, "series", "skeleton.json"), JSON.stringify({
      chapterSkeletons: { "1": { facts: [], stateChanges: [], activeDilemmas: [] } },
    }), "utf8");
    writeFileSync(join(workspace.workspacePath, "chapters", "1.md"), "前章真实结尾：林川推门走进雨里。", "utf8");
    const result = buildChapterSeed({
      workspacePath: workspace.workspacePath,
      workspaceId: workspace.workspaceId,
      chapterId: "2",
      chapterNumber: 2,
    });
    assert.match(result.seed.previousChapterContinuation.lastEventSummary ?? "", /前章真实结尾/);
    assert.deepEqual(result.seed.previousChapterContinuation.sourceIds, ["chapters/1.md"]);
  } finally {
    rmSync(workspace.projectRoot, { recursive: true, force: true });
  }
});

test("章节钩子台账中的开放项进入本章伏笔上下文", () => {
  const workspace = createWorkspace(1);
  try {
    writeFileSync(join(workspace.workspacePath, "chapter-hooks-ledger.md"), `| 编号 | 名称 | 当前状态 | 备注 |\n|---|---|---|---|\n| F-01 | 旧手表来历 | opened | 后续揭晓 |\n| F-02 | 已兑现线索 | resolved | 已结束 |`, "utf8");
    const seed = buildChapterSeed({
      workspacePath: workspace.workspacePath,
      workspaceId: workspace.workspaceId,
      chapterId: "1",
      chapterNumber: 1,
    }).seed;
    assert.ok(seed.currentPressure.pendingForeshadowing.some((item) => item.id === "F-01" && item.description.includes("旧手表")));
    assert.equal(seed.currentPressure.pendingForeshadowing.some((item) => item.id === "F-02"), false);
  } finally {
    rmSync(workspace.projectRoot, { recursive: true, force: true });
  }
});

test("ChapterIntent 只选择章纲实际相关角色并保留作者动机与因果", () => {
  const builder = createChapterIntentBuilder();
  const result = builder.build({
    chapterNumber: 17,
    intentPrimary: "legacy-category",
    chapterTheme: "legacy-theme",
    targetEmotions: [],
    characters: [
      { name: "林川", role: "protagonist" },
      { name: "许岚", role: "supporting" },
      { name: "未出场者", role: "supporting" },
    ],
    immutableFacts: ["门锁只能从室内打开"],
    openPromises: [{ id: "F-01", description: "许岚失踪与旧案有关" }],
    openArcs: [],
    currentPressureSummary: [],
    prevContinuationAvailable: true,
    authorChapterContract: {
      chapterFunction: "确认门后身份并推进失踪案",
      eventSummaries: ["林川确认门后的声音在冒充许岚"],
      mustInclude: ["门锁只能从室内打开"],
      stateChanges: ["林川确认冒充者存在"],
      foreshadowing: ["F-01 许岚失踪与旧案有关"],
      causalRelations: ["错误记忆暴露冒充者"],
      endingTarget: "真正的许岚从楼梯口出现",
      relevantCharacters: ["林川", "许岚"],
      characterMotivations: [{ character: "林川", motivation: "确认许岚是否可信" }],
      sourceIds: ["series/ch17-outline-explicit.md"],
    },
    overallPlotDirection: ["失踪案逐步指向城内组织"],
    previousState: ["前章末林川在门外听见许岚的声音"],
  }, null, null);
  assert.deepEqual(result.intent.relevantCharacters, ["林川", "许岚"]);
  assert.deepEqual(result.intent.characterMotivations, [{ character: "林川", motivation: "确认许岚是否可信" }]);
  assert.deepEqual(result.intent.causalRelations, ["错误记忆暴露冒充者"]);
  assert.deepEqual(result.intent.endingTarget, ["真正的许岚从楼梯口出现"]);
});

test("无章纲角色表时只选择叙事信号命中的角色并保留主角", () => {
  const builder = createChapterIntentBuilder();
  const result = builder.build({
    chapterNumber: 18,
    intentPrimary: "承接失踪线索",
    chapterTheme: "身份疑云",
    targetEmotions: [],
    characters: [
      { name: "林川", role: "protagonist" },
      { name: "许岚", role: "supporting" },
      { name: "未出场者", role: "supporting" },
    ],
    immutableFacts: [],
    openPromises: [{ id: "F-01", description: "许岚失踪与旧案有关" }],
    openArcs: [],
    currentPressureSummary: ["许岚留下的录音出现矛盾"],
    prevContinuationAvailable: true,
    overallPlotDirection: ["林川继续追查失踪案"],
    previousState: ["林川收到许岚留下的录音"],
  }, null, null);

  assert.deepEqual(result.intent.relevantCharacters, ["林川", "许岚"]);
  assert.equal(result.intent.relevantCharacters.includes("未出场者"), false);
});

test("raw prompt 只消费叙事内容契约，不消费正文执行方式", () => {
  const input = minimalRawInput();
  const result = buildRawPrompt(input);
  const forbiddenConsumed = [
    "sceneSolution", "craftGenes", "promptPatterns", "dialogueCraft", "emotionRhythm",
    "supportingFunction", "knowledgeConsumption", "characterVoiceContext",
    "worldPresentationContext", "ensembleLayeringContext",
  ];
  for (const field of forbiddenConsumed) assert.equal(result.consumedFields.includes(field), false, field);
  assert.match(result.userPrompt, /失踪案逐步指向城内组织/);
  assert.match(result.userPrompt, /确认门后身份并推进失踪案/);
  assert.match(result.userPrompt, /前章末林川在门外听见许岚的声音/);
  assert.match(result.userPrompt, /确认许岚是否可信/);
  assert.match(result.userPrompt, /许岚失踪与旧案有关/);
  assert.match(result.userPrompt, /门锁事实与错误记忆共同暴露冒充者/);
  assert.match(result.userPrompt, /真正的许岚从楼梯口出现/);
  assert.match(result.userPrompt, /门锁只能从室内打开/);
  assert.match(result.userPrompt, /都市失踪案/);
  assert.match(result.userPrompt, /林川必须在不信任中依赖同伴/);
  assert.match(result.userPrompt, /记忆能否证明身份/);
  assert.match(result.userPrompt, /不把异常写成无规则幻觉/);
  assert.doesNotMatch(result.userPrompt, /短句|冷峻/);
  assert.doesNotMatch(result.userPrompt, /感官|听觉|嗅觉|潜台词|对白要|句法|长短句|段落|翻译腔|模板化|主动试探|经生产准入的叙事决策/);
  assert.equal(result.promptConstraintAudit.type, "editorial");
  assert.deepEqual(result.methodologyPolicy.violations, []);
  assert.equal(
    result.methodologyPolicy.rules.find((rule) => rule.id === "author_story_contract")?.consumedByRawPrompt,
    true,
  );
  assert.equal(
    result.methodologyPolicy.rules.find((rule) => rule.id === "scene_solution_strategy")?.consumedByRawPrompt,
    false,
  );
  assert.equal(
    result.methodologyPolicy.rules.find((rule) => rule.id === "prose_execution_heuristics")?.consumedByRawPrompt,
    false,
  );
});

test("所有 writer profile 共享表达自由边界，不再各自指挥写法", () => {
  const input = minimalRawInput();
  const contract = buildChapterContract(input);
  for (const profile of ["generic_writer_v1", "claude_writer_v1", "gpt_writer_v1", "chinese_writer_v1", "gemini_writer_v1", "gemini_writer_v2"]) {
    const prompt = adaptWriterPrompt({ profile, chapterNumber: 2, contract, sharedContext: "" });
    const full = `${prompt.systemPrompt}\n${prompt.userPrompt}`;
    assert.doesNotMatch(full, /感官|听觉|嗅觉|潜台词|对白要|句法|长短句|段落节奏|翻译腔|报告腔|模板化惊吓|如何开头/);
    assert.match(full, /自行决定具体表达/);
  }
});

test("一次序列偏好的全局生产准入接口已物理删除", () => {
  assert.equal("shouldApplyHumanAdmittedSceneSolution" in unifiedEntry, false);
});

test("多个场景方案没有本章明确选择时不得按数组顺序取第一张", () => {
  const card = (id) => ({
    id,
    mode: "evidence_investigation",
    surfaceGoal: "确认身份",
    trueDanger: "错误判断",
    knownFacts: [],
    unknowns: [],
    activeTestAction: "自由方案",
    alternatives: [],
    choice: "自由选择",
    cost: "",
    newRuleOrInformation: "",
    irreversibleChange: "",
    stateKind: "knowledge",
    endingPressure: "身份揭晓",
    causalSource: "证据冲突",
    nextChoice: "继续调查",
    templateAvoidance: [],
    sourceFactIds: [],
    openPromiseIds: [],
  });
  const result = searchSceneSolutions({
    sceneId: "scene",
    existingFactIds: [],
    openPromiseIds: [],
    cards: [card("first"), card("second")],
  });
  assert.equal(result.status, "fallback_raw");
  assert.equal(result.selected, null);
  assert.equal(result.fallbackReason, "multiple_solutions_require_chapter_specific_selection");
});
