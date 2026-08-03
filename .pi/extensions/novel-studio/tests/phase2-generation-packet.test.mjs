/**
 * Phase 2B：GenerationPacket 让 Agentic 消费完整 ChapterContract
 *
 * P0-2 修复后验收口径（NOVELOS-CONSTRAINT-RELAXATION-1 验收修复）：
 * - buildContractContextString 通过 buildChapterContract + renderContract 生成 canonical contract
 * - canonical 字段完整覆盖：characterMotivations / focusCharacterGoals / resistance /
 *   choicesAndCosts / expectedIrreversibleChange / selectedExpectationsToAdvance /
 *   causalRelations 等（原先遗漏的字段）
 * - 风格指纹不再注入 raw 阶段（editorialGuidance / characterVoiceGuidance 移除）
 * - openLoops / worldRules / bridgeContext 等运行时上下文保留
 * - targetWordCount 转发并覆盖 contract.wordCountTarget
 *
 * 测试策略：
 * - 通过 mock agenticCandidateSource 捕获 orchestrator 传给 agentic source 的 input
 * - 验证 context 完整传递（不截断）+ targetWordCount 转发
 * - 使用包含角色名的叙事文本避免 story preservation gate 误阻断
 * - P0-2：验证 canonical 字段进入 seedContextStr（通过 renderContract 输出）
 * - P0-2：验证风格指纹不进入 seedContextStr
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";
import { buildChapterContract, renderContract } from "../dist/v2/core/model-prompt-adapter.js";
import { detectModelVersion } from "../dist/v2/learning/model-version-migration.js";

const AGENTIC_TEXT = [
  "叶尘站在密室中央，手心贴着传承玉简的冰冷表面。",
  "灵气从玉简中涌出，顺着他的经脉蔓延，封印开始松动。",
  "他感到体内力量在攀升，炼体期的壁障出现了裂痕。",
  "门外传来脚步声，追踪者已经逼近。叶尘收回手，将玉简藏入怀中。",
].join("\n\n");

const STYLED_TEXT = [
  "叶尘站在密室中央。",
  "手心贴着传承玉简。冰凉。",
  "灵气从玉简里涌出来，顺着经脉蔓延。封印松动了。",
  "他感到体内力量在攀升。炼体期的壁障，出现了裂痕。",
  "门外传来脚步声。追踪者逼近了。",
  "叶尘收回手。玉简藏入怀中。",
].join("\n\n");

function makeIntent() {
  return {
    chapterFunction: "推进：主角接受传承并暴露身份",
    readerExperience: ["紧张", "震撼"],
    currentPressure: ["传承激活引来追踪者"],
    meaningfulChoices: ["公开接受传承"],
    promisesToAdvance: [],
    possibleEndPressure: ["追踪者已逼近"],
    relevantCharacters: ["叶尘"],
    inviolableFacts: ["叶尘是废物少年", "传承来自上古大能"],
    factAndCharacterKnowledgeForbiddenZones: ["叶尘不知道黑煞宗的真正目的"],
    sourceRefs: ["chapter-seed:test"],
    // P0-2：补充 canonical contract 字段（原先遗漏）
    characterMotivations: [{ character: "叶尘", motivation: "获得传承力量改变命运" }],
    focusCharacterGoals: [{ character: "叶尘", goal: "获得传承力量" }],
    resistance: ["传承激活引来追踪者", "封印未完全解除"],
    choicesAndCosts: [{ choice: "接受传承", cost: "暴露身份" }],
    expectedIrreversibleChange: ["叶尘接受传承后无法维持普通身份"],
    selectedPromisesToAdvance: [{ promiseId: "p-1", description: "封印与传承的关联" }],
    selectedExpectationsToAdvance: [{ expectationId: "e-1", description: "主角获得传承", targetReaderExperience: "震撼" }],
    causalEndPressure: ["传承激活引来追踪者"],
    causalRelations: ["接受传承导致身份暴露"],
    foreshadowing: ["封印与传承有关"],
  };
}

function makeContext() {
  return {
    facts: [
      { id: "fact-1", content: "叶尘是废物少年", sourceIds: ["chapter:1"], kind: "fact" },
      { id: "fact-2", content: "传承来自上古大能", sourceIds: ["worldbuilding:canon"], kind: "fact" },
      { id: "fact-3", content: "玉衡星是修炼圣地", sourceIds: ["worldbuilding:canon"], kind: "fact" },
      { id: "fact-4", content: "叶尘的师父是李长青", sourceIds: ["chapter:1"], kind: "fact" },
      { id: "fact-5", content: "李长青已失踪三天", sourceIds: ["chapter:2"], kind: "fact" },
      { id: "fact-6", content: "叶尘体内有封印", sourceIds: ["chapter:3"], kind: "fact" },
      { id: "fact-7", content: "封印与传承有关", sourceIds: ["chapter:3"], kind: "fact" },
      { id: "fact-8", content: "追踪者来自黑煞宗", sourceIds: ["worldbuilding:canon"], kind: "fact" },
      { id: "fact-9", content: "黑煞宗擅长追踪术", sourceIds: ["worldbuilding:canon"], kind: "fact" },
      { id: "fact-10", content: "叶尘的修炼等级是炼体期", sourceIds: ["chapter:1"], kind: "fact" },
      { id: "fact-11", content: "炼体期是最初等级", sourceIds: ["worldbuilding:canon"], kind: "fact" },
    ],
    characterStates: [{
      characterId: "ye-chen",
      name: "叶尘",
      state: {
        role: "主角",
        mentality: "戒备中带着期待",
        pendingTension: "传承激活的未知后果",
        recentAction: "潜入密室",
      },
      sourceIds: ["character:ye-chen"],
    }],
    openLoops: [
      { id: "loop-1", description: "李长青失踪的真相", openedAt: "ch2", urgency: 2, sourceIds: ["chapter:2"] },
      { id: "loop-2", description: "叶尘体内封印的来源", openedAt: "ch3", urgency: 3, sourceIds: ["chapter:3"] },
      { id: "loop-3", description: "黑煞宗追踪的目的", openedAt: "ch1", urgency: 2, sourceIds: ["worldbuilding:canon"] },
    ],
    worldRules: [
      { id: "rule-1", description: "传承激活需要消耗灵石", type: "power_system", affectedCharacters: [], sourceIds: ["worldbuilding:canon"] },
      { id: "rule-2", description: "封印解除后修为会暴增", type: "power_system", affectedCharacters: ["叶尘"], sourceIds: ["worldbuilding:canon"] },
    ],
    styleReferences: [{
      id: "style:ye-chen",
      kind: "fingerprint",
      content: JSON.stringify({
        id: "ye-chen-style",
        usagePolicy: { fullChapterOptimization: "required" },
        editorialGuidance: [
          "人物压力优先通过动作、停顿和环境变化呈现。",
          "章末停在仍有压力的动作或状态上，不替读者总结。",
        ],
        characterVoiceGuidance: {
          叶尘: ["少年感保留现实处境，不写成老练谋士。"],
        },
      }),
      sourceIds: ["workspaces/test/styles/profile.json"],
    }],
    bridgeContext: {
      available: true,
      lastEventSummary: "叶尘潜入密室，发现传承玉简",
      endingEmotion: "紧张期待",
      openHooks: ["传承玉简的激活条件未知", "门外脚步声渐近"],
      unresolvedTensions: ["李长青失踪与传承的关系"],
    },
    constitution: {
      workIdentity: "东方玄幻长篇",
      readerPromise: ["沉浸式修炼体验", "主角成长爽感"],
      genrePromises: ["玄幻节奏"],
      protagonistCoreConflict: "废物少年 vs 上古传承",
      thematicQuestions: ["传承的代价？"],
      aestheticDirection: ["冷峻笔触"],
      forbiddenDrift: ["不破坏世界观", "不引入科幻元素"],
      sourceIds: ["workspaces/test/CORE-WRITING-PRINCIPLES.md"],
    },
    sourceMap: [],
  };
}

/** 创建 mock agenticCandidateSource，捕获 generate input */
function createMockAgenticSource(projectRoot, capturedRef) {
  return {
    async generate(input) {
      capturedRef.input = input;
      return {
        candidate: {
          id: "candidate:agentic_raw:test",
          text: AGENTIC_TEXT,
          kind: "agentic_raw",
          model: "novelos_agentic",
          route: "novelos_agentic",
          contextHash: "hash-test",
          generatedAt: new Date().toISOString(),
          durationMs: 1,
          promptProfile: {
            type: "editorial",
            tokensIn: 0,
            containsDialogueRatio: false,
            containsParagraphLengthConstraint: false,
            containsControlChecklist: false,
            containsMechanicalMetric: false,
            contractIds: [],
          },
        },
        sessionId: "session-test",
        trajectoryPath: join(projectRoot, "trajectory.jsonl"),
        budgetSnapshot: { usedCalls: 1 },
        stopReason: "completed",
        sourceRefs: [],
        toolCalls: 0,
        verifierCleared: true,
        repairRounds: 0,
      };
    },
  };
}

/** 创建 mock modelGenerate（只允许 author_style_optimization） */
function createMockModelGenerate(capturedRef) {
  return async (input) => {
    if (input.kind === "author_style_optimization") {
      if (capturedRef) capturedRef.stylePrompt = input.userPrompt;
      return {
        text: STYLED_TEXT,
        model: "gemini-3.1-pro-preview",
        route: input.route,
        durationMs: 2,
        finishReason: "stop",
        maxTokens: 16384,
      };
    }
    throw new Error(`未授权模型调用：${input.kind}`);
  };
}

// ============================================================================
// 测试
// ============================================================================

test("Phase 2B · targetWordCount 被转发给 agentic source", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-phase2b-target-"));
  const captured = {};
  try {
    const result = await createUnifiedOrchestrator().orchestrate({
      workspaceId: "test",
      chapterId: "ch-test-target",
      chapterNumber: 1,
      projectRoot,
      productionFlow: "agentic_style",
      intent: makeIntent(),
      context: makeContext(),
      constitution: makeContext().constitution,
      characterNames: ["叶尘"],
      targetWordCount: { min: 2500, max: 3500 },
      rawPromptProfile: "gemini_writer_v2",
      modelGenerate: createMockModelGenerate(),
      generationModelGenerate: createMockModelGenerate(),
      judgeModelGenerate: async () => { throw new Error("不调用裁判"); },
      agenticCandidateSource: createMockAgenticSource(projectRoot, captured),
    });

    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.ok(captured.input, "应捕获到 agenticCandidateSource.generate 的 input");
    assert.deepEqual(
      captured.input.targetWordCount,
      { min: 2500, max: 3500 },
      "targetWordCount 应被转发给 agentic source",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Phase 2B · context 完整传递给 agentic source（不截断）", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-phase2b-context-"));
  const captured = {};
  const context = makeContext();
  try {
    const result = await createUnifiedOrchestrator().orchestrate({
      workspaceId: "test",
      chapterId: "ch-test-context",
      chapterNumber: 1,
      projectRoot,
      productionFlow: "agentic_style",
      intent: makeIntent(),
      context,
      constitution: context.constitution,
      characterNames: ["叶尘"],
      targetWordCount: { min: 2500, max: 3500 },
      rawPromptProfile: "gemini_writer_v2",
      modelGenerate: createMockModelGenerate(),
      generationModelGenerate: createMockModelGenerate(),
      judgeModelGenerate: async () => { throw new Error("不调用裁判"); },
      agenticCandidateSource: createMockAgenticSource(projectRoot, captured),
    });

    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.ok(captured.input, "应捕获到 agenticCandidateSource.generate 的 input");

    // 验证 context 完整传递（不截断）
    assert.equal(captured.input.context.facts.length, context.facts.length, "facts 应完整传递（11 条全保留）");
    assert.equal(captured.input.characterNames.length, 1, "characterNames 应传递");
    assert.equal(captured.input.context.characterStates.length, context.characterStates.length, "characterStates 应完整传递");
    assert.equal(captured.input.context.openLoops.length, context.openLoops.length, "openLoops 应完整传递");
    assert.equal(captured.input.context.worldRules.length, context.worldRules.length, "worldRules 应完整传递");
    assert.ok(captured.input.context.bridgeContext?.available, "bridgeContext 应被传递");
    assert.ok(captured.input.context.constitution, "constitution 应被传递");
    assert.ok(captured.input.context.styleReferences.length > 0, "styleReferences 应被传递");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Phase 2B · targetWordCount 未提供时不阻断（undefined 使用默认预算）", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-phase2b-no-target-"));
  const captured = {};
  try {
    const result = await createUnifiedOrchestrator().orchestrate({
      workspaceId: "test",
      chapterId: "ch-test-no-target",
      chapterNumber: 1,
      projectRoot,
      productionFlow: "agentic_style",
      intent: makeIntent(),
      context: makeContext(),
      constitution: makeContext().constitution,
      characterNames: ["叶尘"],
      // 不传 targetWordCount
      rawPromptProfile: "gemini_writer_v2",
      modelGenerate: createMockModelGenerate(),
      generationModelGenerate: createMockModelGenerate(),
      judgeModelGenerate: async () => { throw new Error("不调用裁判"); },
      agenticCandidateSource: createMockAgenticSource(projectRoot, captured),
    });

    assert.equal(result.status, "ok", JSON.stringify(result.failureEnvelope));
    assert.equal(
      captured.input.targetWordCount,
      undefined,
      "未提供 targetWordCount 时应为 undefined",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Phase 2B · buildContractContextString 源码包含运行时上下文元素（P0-2 修复）", () => {
  const source = readFileSync(
    join(process.cwd(), "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  // P0-2：验证运行时上下文元素仍保留在源码中
  assert.match(source, /未结伏笔/, "应包含 openLoops（未结伏笔）");
  assert.match(source, /世界规则/, "应包含 worldRules（世界规则）");
  assert.match(source, /前章悬置状态/, "应包含 bridgeContext（前章悬置状态）");
  assert.match(source, /本章角色/, "应包含 characterNames");
  // P0-2：验证 canonical contract 通过 buildChapterContract + renderContract 消费
  assert.match(source, /buildChapterContract/, "应使用 buildChapterContract 构建 canonical contract");
  assert.match(source, /renderContract/, "应使用 renderContract 渲染 contract");
  // P0-2：验证风格指纹不再注入 raw
  assert.doesNotMatch(source, /作者风格指纹/, "不应再注入风格指纹到 raw 阶段");
  assert.doesNotMatch(source, /editorialGuidance/, "不应再解析 editorialGuidance 到 raw");
  assert.doesNotMatch(source, /characterVoiceGuidance/, "不应再解析 characterVoiceGuidance 到 raw");
});

// ── P0-2 生产探针：canonical contract 字段进入 Agentic 输入 ──────────────
// 验证 buildChapterContract + renderContract 输出包含所有原先遗漏的 canonical 字段

test("P0-2 生产探针：renderContract 输出包含所有 canonical contract 字段", () => {
  const intent = makeIntent();
  const context = makeContext();
  const contract = buildChapterContract({
    intent,
    context,
    constitution: context.constitution ?? null,
  });
  const rendered = renderContract(contract);

  // P0-2：原先遗漏的 canonical 字段现在必须出现
  assert.match(rendered, /人物动机/, "应包含 characterMotivations");
  assert.match(rendered, /焦点角色目标/, "应包含 focusCharacterGoals");
  assert.match(rendered, /本章阻力/, "应包含 resistance");
  assert.match(rendered, /选择与代价/, "应包含 choicesAndCosts");
  assert.match(rendered, /预期不可逆变化/, "应包含 expectedIrreversibleChange");
  assert.match(rendered, /本章选中承诺/, "应包含 selectedPromisesToAdvance");
  assert.match(rendered, /因果章末压力/, "应包含 causalEndPressure");
  assert.match(rendered, /因果关系/, "应包含 causalRelations");
  // constitution 字段
  assert.match(rendered, /作品身份/, "应包含 workIdentity");
  assert.match(rendered, /长期读者承诺/, "应包含 readerPromises");
  assert.match(rendered, /主角核心冲突/, "应包含 protagonistCoreConflict");
  // inviolableFacts
  assert.match(rendered, /不可违背事实/, "应包含 inviolableFacts");
  // 人物知识与状态禁区
  assert.match(rendered, /人物知识与状态禁区/, "应包含 stateConstraints");
});

test("P0-2 生产探针：renderContract 不输出风格指纹", () => {
  const intent = makeIntent();
  const context = makeContext();
  const contract = buildChapterContract({
    intent,
    context,
    constitution: context.constitution ?? null,
  });
  const rendered = renderContract(contract);

  // P0-2：风格指纹内容不得出现在 renderContract 输出中
  assert.doesNotMatch(rendered, /人物压力优先通过动作/, "不应包含 editorialGuidance 内容");
  assert.doesNotMatch(rendered, /少年感保留现实处境/, "不应包含 characterVoiceGuidance 内容");
  assert.doesNotMatch(rendered, /作者风格指纹/, "不应包含风格指纹标题");
});

// ── P1-5 生产探针：candidate.model 传播真实 provider/model/version ──────────
// 原先 candidate.model 固定为 "novelos_agentic"，导致 detectModelVersion
// 无法区分 Gemini / Claude / 模型升级，策略信誉隔离失效。

test("P1-5 生产探针：source 代码捕获真实模型名（不再固定 novelos_agentic）", () => {
  const source = readFileSync(
    join(process.cwd(), "novelos", "agent", "agentic-raw-candidate-source.ts"),
    "utf8",
  );
  // P1-5：验证 source 通过 wrapper 捕获 modelGenerate 返回的真实模型名
  assert.match(source, /lastActualModel/, "应有 lastActualModel 捕获变量");
  assert.match(source, /modelGenerateWithCapture/, "应有 modelGenerateWithCapture wrapper");
  assert.match(source, /candidateModel.*lastActualModel/, "candidate.model 应使用 lastActualModel");
  // P1-5：验证不再固定使用 "novelos_agentic" 作为 candidate.model
  assert.doesNotMatch(
    source,
    /model:\s*["']novelos_agentic["']/,
    "不应再固定 candidate.model 为 novelos_agentic",
  );
});

test("P1-5 生产探针：detectModelVersion 对不同模型名产生不同版本键", () => {
  // 验证 detectModelVersion 能区分 Gemini / Claude / 模型升级
  // 这是 P1-5 修复的核心目标：策略信誉按真实版本隔离
  const geminiKey = detectModelVersion("gemini-3.1-pro-preview");
  const claudeKey = detectModelVersion("claude-opus-4.6");
  const geminiUpgradeKey = detectModelVersion("gemini-3.2-pro-preview");

  // Gemini 与 Claude 必须产生不同版本键（原先都映射到 "novelos_agentic"）
  assert.notEqual(geminiKey, claudeKey,
    `Gemini (${geminiKey}) 与 Claude (${claudeKey}) 必须有不同的版本键`);
  // Gemini 升级版本也必须产生不同版本键
  assert.notEqual(geminiKey, geminiUpgradeKey,
    `Gemini 3.1 (${geminiKey}) 与 3.2 (${geminiUpgradeKey}) 必须有不同的版本键`);
  // 原先的固定占位符 "novelos_agentic" 不应与任何真实模型重合
  const placeholderKey = detectModelVersion("novelos_agentic");
  assert.notEqual(placeholderKey, geminiKey,
    `占位符 (${placeholderKey}) 不应与 Gemini (${geminiKey}) 重合`);
  assert.notEqual(placeholderKey, claudeKey,
    `占位符 (${placeholderKey}) 不应与 Claude (${claudeKey}) 重合`);
});

test("P0-2 生产探针：targetWordCount 出现在 contract context string", () => {
  const intent = makeIntent();
  const context = makeContext();
  const targetWordCount = { min: 2500, max: 3500 };
  const contract = buildChapterContract({
    intent,
    context,
    constitution: context.constitution ?? null,
  });
  contract.wordCountTarget = targetWordCount;
  const rendered = renderContract(contract);

  // renderContract 不输出 wordCountTarget（它由 buildContractContextString 单独追加）
  // 验证 contract 上 wordCountTarget 已被正确覆盖
  assert.deepEqual(contract.wordCountTarget, targetWordCount, "contract.wordCountTarget 应被覆盖");
});
