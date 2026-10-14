/**
 * MODEL-PROMPT-ADAPTER-1: unified chapter contract with model-specific writer prompts.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  adaptWriterPrompt,
  buildChapterContract,
  resolveWriterPromptProfile,
} from "../dist/v2/core/model-prompt-adapter.js";
import { buildRawPrompt, generateRaw } from "../dist/v2/core/orchestrator-raw.js";

function makeInput(rawPromptProfile) {
  return {
    workspaceId: "prompt-adapter-workspace",
    chapterId: "chapter-7",
    chapterNumber: 7,
    projectRoot: process.cwd(),
    rawPromptProfile,
    intent: {
      chapterFunction: "逼迫林默验证门后的异常",
      overallPlotDirection: ["异常调查逐步指向记忆伪造者"],
      previousState: ["林默听见门后传来许岚的声音"],
      characterMotivations: [{ character: "林默", motivation: "确认许岚是否可信" }],
      foreshadowing: ["许岚失踪与旧案有关"],
      causalRelations: ["门锁事实与错误记忆共同暴露模仿者"],
      endingTarget: ["真正的许岚从楼梯口出现"],
      authorEventSummaries: ["林默依据门锁事实确认门后声音在模仿许岚"],
      authorMustInclude: ["安全门从内部反锁"],
      authorStateChanges: ["林默从怀疑转为确认模仿者存在"],
      readerExperience: ["紧张", "好奇"],
      currentPressure: ["走廊尽头的脚步声正在接近"],
      meaningfulChoices: [],
      promisesToAdvance: [],
      possibleEndPressure: [],
      relevantCharacters: ["林默", "许岚"],
      inviolableFacts: ["林默尚不知道门后人的身份", "不把异常写成无规则幻觉"],
      sourceRefs: ["seed:chapter-7"],
      concreteDelivery: ["确认门后的声音会模仿熟人"],
      focusCharacterGoals: [{ character: "林默", goal: "确认许岚是否可信" }],
      resistance: ["声音会利用林默的记忆误导判断"],
      choicesAndCosts: [{ choice: "主动敲门试探", cost: "暴露自己已经识破模仿" }],
      expectedIrreversibleChange: ["林默失去继续伪装不知情的机会"],
      selectedPromisesToAdvance: [{ promiseId: "p-1", description: "许岚失踪与旧案有关" }],
      selectedExpectationsToAdvance: [{ expectationId: "e-1", description: "确认门后身份", targetReaderExperience: "认知反转" }],
      causalEndPressure: ["门内的声音准确说出只有许岚知道的秘密"],
      factAndCharacterKnowledgeForbiddenZones: ["许岚不知道林默昨夜见过谁"],
      fieldSourceRefs: {},
      underSpecifiedFields: [],
    },
    sceneSolution: {
      id: "solution-1",
      mode: "active_probe",
      surfaceGoal: "确认门后是谁",
      trueDanger: "回应会暴露林默的位置",
      knownFacts: ["门后的声音与许岚相同"],
      unknowns: ["声音来自许岚本人还是模仿者"],
      activeTestAction: "故意问一个答案相反的问题",
      alternatives: ["不开门", "从消防通道绕行"],
      choice: "用假记忆试探门后的声音",
      cost: "模仿者会知道林默已起疑",
      newRuleOrInformation: "声音只能复述它听过的记忆",
      irreversibleChange: "双方从隐藏变成彼此确认敌意",
      stateKind: "knowledge",
      endingPressure: "真正的许岚此时从楼梯口出现",
      causalSource: "试探暴露了模仿限制",
      nextChoice: "林默必须判断两名许岚谁是真的",
      templateAvoidance: ["不用突然黑影制造惊吓"],
      sourceFactIds: ["fact-1"],
      openPromiseIds: [],
    },
    context: {
      facts: [{ id: "fact-1", content: "安全门从内部反锁", sourceIds: ["chapter-6"], kind: "fact" }],
      characterStates: [
        {
          characterId: "lin-mo",
          name: "林默",
          state: {
            role: "protagonist",
            mentality: "保持怀疑，先验证再行动",
            narrativeProfile: {
              personality: ["冷静理性，但涉及同伴安危时会承担风险"],
              decisionLogic: ["先验证信息，再决定是否信任"],
              voice: ["表达克制直接，压力越大越少解释"],
              relationships: ["许岚：互不完全信任，但必须合作"],
              establishedHistory: ["曾在旧仓库发现许岚留下的假钥匙"],
              boundaries: [],
              sourceId: "characters/lin-mo.md",
            },
          },
          sourceIds: ["character:lin-mo"],
        },
        { characterId: "xu-lan", name: "许岚", state: { role: "supporting" }, sourceIds: ["character:xu-lan"] },
      ],
      openLoops: [],
      worldRules: [{ id: "world-1", description: "异常不能凭空知道未被说出的记忆", type: "immutable_fact", affectedCharacters: [], sourceIds: ["world"] }],
      styleReferences: [],
      sourceMap: [],
      constitution: null,
      longTermState: null,
      bridgeContext: {
        available: true,
        lastEventSummary: "林默听见门后传来许岚的声音",
        endingEmotion: "戒备",
        openHooks: ["许岚是否在门后"],
        unresolvedTensions: ["声音来源不明"],
        introducedCharacters: ["许岚"],
      },
    },
    constitution: {
      workIdentity: "现代都市异常调查",
      readerPromise: ["每次验证都带来可用的新规则"],
      genrePromises: ["恐惧来自可验证但代价高昂的规则"],
      protagonistCoreConflict: "林默必须在不信任他人的同时依赖他人",
      thematicQuestions: ["记忆能否证明身份"],
      aestheticDirection: ["冷峻美学", "霓虹感"],
      forbiddenDrift: ["不把异常写成无规则幻觉"],
      sourceIds: ["constitution"],
    },
    characterNames: ["林默", "许岚"],
    modelGenerate: async () => ({ text: "stub", model: "stub", route: "stub", durationMs: 0 }),
  };
}

describe("MODEL-PROMPT-ADAPTER-1", () => {
  test("同一叙事输入在所有模型 profile 下共享完全相同的 ChapterContract", () => {
    const input = makeInput();
    const contract = buildChapterContract(input);
    const profiles = ["generic_writer_v1", "claude_writer_v1", "gpt_writer_v1", "chinese_writer_v1", "gemini_writer_v1", "gemini_writer_v2"];

    const rendered = profiles.map((profile) => adaptWriterPrompt({
      profile,
      chapterNumber: input.chapterNumber,
      contract,
      sharedContext: "共享上下文",
    }));

    for (const result of rendered) {
      assert.deepEqual(result.chapterContract, contract);
      assert.match(result.userPrompt, /现代都市异常调查/);
      assert.match(result.userPrompt, /林默必须在不信任他人的同时依赖他人/);
      assert.match(result.userPrompt, /林默尚不知道门后人的身份/);
      assert.match(result.userPrompt, /门锁事实与错误记忆共同暴露模仿者/);
      assert.match(result.userPrompt, /真正的许岚从楼梯口出现/);
      assert.match(result.userPrompt, /当前压力/);
      assert.match(result.userPrompt, /声音会利用林默的记忆误导判断/);
      assert.match(result.userPrompt, /主动敲门试探/);
      assert.match(result.userPrompt, /林默失去继续伪装不知情的机会/);
      assert.match(result.userPrompt, /许岚失踪与旧案有关/);
      assert.match(result.userPrompt, /先验证信息，再决定是否信任/);
      assert.match(result.userPrompt, /互不完全信任，但必须合作/);
      assert.doesNotMatch(result.userPrompt, /主动试探|替代方案|选择代价|模板化惊吓/);
      assert.doesNotMatch(result.userPrompt, /冷峻美学|霓虹感/);
    }
  });

  test("Claude、GPT、中文模型和 Gemini 共享同一表达自由边界", () => {
    const input = makeInput();
    const contract = buildChapterContract(input);
    const claude = adaptWriterPrompt({ profile: "claude_writer_v1", chapterNumber: 7, contract, sharedContext: "共享上下文" });
    const gpt = adaptWriterPrompt({ profile: "gpt_writer_v1", chapterNumber: 7, contract, sharedContext: "共享上下文" });
    const chinese = adaptWriterPrompt({ profile: "chinese_writer_v1", chapterNumber: 7, contract, sharedContext: "共享上下文" });
    const gemini = adaptWriterPrompt({ profile: "gemini_writer_v2", chapterNumber: 7, contract, sharedContext: "共享上下文" });

    assert.equal(claude.systemPrompt, gpt.systemPrompt);
    assert.equal(gpt.systemPrompt, chinese.systemPrompt);
    assert.equal(chinese.systemPrompt, gemini.systemPrompt);
    assert.equal(claude.userPrompt, gpt.userPrompt);
    assert.equal(gpt.userPrompt, chinese.userPrompt);
    assert.equal(chinese.userPrompt, gemini.userPrompt);
    assert.match(gemini.userPrompt, /自行决定具体表达/);
    assert.doesNotMatch(gemini.userPrompt, /感官|对白|句法|段落|潜台词|翻译腔|模板化惊吓/);
    assert.equal(claude.runtimePolicy.samplingSource, "model-routing");
    assert.equal(gpt.runtimePolicy.structuredOutput, false);
    assert.equal(chinese.runtimePolicy.editScope, "chapter");
    assert.equal(gemini.runtimePolicy.samplingSource, "model-routing");
    assert.doesNotMatch(gemini.userPrompt, /段落.{0,4}\d+|对白比例|每段/);
  });

  test("profile 解析优先使用实际 provider/model，并覆盖生产与实验路由", () => {
    assert.equal(resolveWriterPromptProfile({ route: "v2_rawstage2", provider: "claude", model: "claude-opus-4-6" }), "claude_writer_v1");
    assert.equal(resolveWriterPromptProfile({ route: "nb4_generate_gpt56", provider: "gpt", model: "gpt-5.6-sol" }), "gpt_writer_v1");
    assert.equal(resolveWriterPromptProfile({ route: "nb4_generate_doubao", provider: "doubao", model: "doubao-seed" }), "chinese_writer_v1");
    assert.equal(resolveWriterPromptProfile({ route: "nb4_generate_gemini31", provider: "gemini31", model: "gemini-3.1-pro" }), "gemini_writer_v2");
    assert.equal(resolveWriterPromptProfile({ route: "v2_rawstage2" }), "claude_writer_v1");
    assert.throws(
      () => resolveWriterPromptProfile({ route: "unknown_generation_route" }),
      /无法为生成模型解析 prompt profile/,
    );
  });

  test("空的可选叙事字段保持为空且不渲染噪音", () => {
    const input = makeInput();
    input.sceneSolution = null;
    input.intent = {
      ...input.intent,
      chapterFunction: "",
      overallPlotDirection: [],
      previousState: [],
      characterMotivations: [],
      foreshadowing: [],
      causalRelations: [],
      endingTarget: [],
      authorEventSummaries: [],
      authorMustInclude: [],
      authorStateChanges: [],
      concreteDelivery: [],
      focusCharacterGoals: [],
      choicesAndCosts: [],
      expectedIrreversibleChange: [],
      causalEndPressure: [],
      factAndCharacterKnowledgeForbiddenZones: [],
      inviolableFacts: [],
    };
    input.context = { ...input.context, facts: [] };

    const contract = buildChapterContract(input);
    const adapted = adaptWriterPrompt({
      profile: "generic_writer_v1",
      chapterNumber: 7,
      contract,
      sharedContext: "最小共享上下文",
    });

    assert.deepEqual(contract.chapterFunction, []);
    assert.deepEqual(contract.endingTarget, []);
    assert.doesNotMatch(adapted.userPrompt, /本章未声明/);
  });

  test("作品宪法只注入叙事承诺，不注入工具术语和机械写法", () => {
    const input = makeInput();
    input.constitution = {
      ...input.constitution,
      readerPromise: [...input.constitution.readerPromise, "爽点使用蓄水→爆发→余韵三段式"],
      genrePromises: [...input.constitution.genrePromises, "多写短句，限制长句"],
      forbiddenDrift: [
        ...input.constitution.forbiddenDrift,
        "用感知锚点替代作者总结",
        "显式章纲是 AI 生成时的 CONTRACT",
        "禁止凭空知道未获知的信息",
      ],
    };
    input.intent = {
      ...input.intent,
      inviolableFacts: [...input.intent.inviolableFacts, "用感知锚点替代作者总结"],
      factAndCharacterKnowledgeForbiddenZones: [
        ...input.intent.factAndCharacterKnowledgeForbiddenZones,
        "显式章纲是 AI 生成时的 CONTRACT",
      ],
    };
    const adapted = adaptWriterPrompt({
      profile: "gemini_writer_v2",
      chapterNumber: input.chapterNumber,
      contract: buildChapterContract(input),
      sharedContext: "共享上下文",
    });
    assert.match(adapted.userPrompt, /禁止凭空知道未获知的信息/);
    assert.doesNotMatch(adapted.userPrompt, /蓄水|感知锚点|CONTRACT|多写短句|限制长句/);
  });

  test("buildRawPrompt 默认 Gemini v2，显式 profile 可消融且记录适配元数据", () => {
    const defaultPrompt = buildRawPrompt(makeInput());
    const genericPrompt = buildRawPrompt(makeInput("generic_writer_v1"));
    const gptPrompt = buildRawPrompt(makeInput("gpt_writer_v1"));
    const chinesePrompt = buildRawPrompt(makeInput("chinese_writer_v1"));
    const geminiPrompt = buildRawPrompt(makeInput("gemini_writer_v2"));

    assert.equal(defaultPrompt.promptAdapter.profile, "gemini_writer_v2");
    assert.equal(genericPrompt.promptAdapter.profile, "generic_writer_v1");
    assert.equal(gptPrompt.promptAdapter.profile, "gpt_writer_v1");
    assert.equal(chinesePrompt.promptAdapter.profile, "chinese_writer_v1");
    assert.equal(geminiPrompt.promptAdapter.profile, "gemini_writer_v2");
    assert.deepEqual(defaultPrompt.chapterContract, gptPrompt.chapterContract);
    assert.deepEqual(genericPrompt.chapterContract, defaultPrompt.chapterContract);
    assert.deepEqual(gptPrompt.chapterContract, chinesePrompt.chapterContract);
    assert.deepEqual(geminiPrompt.chapterContract, defaultPrompt.chapterContract);
    assert.equal(defaultPrompt.systemPrompt, gptPrompt.systemPrompt);
    assert.equal(chinesePrompt.userPrompt, geminiPrompt.userPrompt);
    assert.doesNotMatch(chinesePrompt.userPrompt, /中文表达要求/);
    assert.doesNotMatch(geminiPrompt.userPrompt, /完整上下文/);
    assert.equal(gptPrompt.userPrompt.split("主动敲门试探").length - 1, 1, "作者章卡中的选择与代价必须进入统一内容契约");
    assert.equal(gptPrompt.userPrompt.split("故意问一个答案相反的问题").length - 1, 0, "场景执行方案不得进入统一内容契约");
    assert.equal(gptPrompt.userPrompt.split("林默尚不知道门后人的身份").length - 1, 1, "硬事实只由 ChapterContract 渲染一次");
    assert.equal(gptPrompt.userPrompt.split("不把异常写成无规则幻觉").length - 1, 1, "宪法禁止偏离不得在契约中重复");
    assert.deepEqual(defaultPrompt.constitutionConsumedFields, [
      "constitution.workIdentity",
      "constitution.readerPromise",
      "constitution.genrePromises",
      "constitution.protagonistCoreConflict",
      "constitution.thematicQuestions",
      "constitution.forbiddenDrift",
    ]);
    assert.equal(defaultPrompt.constitutionConsumedFields.includes("constitution.aestheticDirection"), false);
  });

  test("raw 模型调用携带 promptProfile，供 trace 和消融统计", async () => {
    let captured;
    const input = makeInput("gpt_writer_v1");
    input.modelGenerate = async (modelInput) => {
      captured = modelInput;
      return { text: "非空 stub 正文", model: "gpt-stub", route: modelInput.route, durationMs: 1 };
    };

    await generateRaw(input, buildRawPrompt(input));

    assert.equal(captured.promptProfile, "gpt_writer_v1");
    assert.equal(captured.route, "v2_rawstage2");
  });

  test("机械约束审计检查任务契约但不把前文正文中的引语误判为系统指令", () => {
    const quotedInput = makeInput();
    quotedInput.evalPrefix = "墙上的旧合同写着：每段不超过300字。林默看完便把纸折了起来。";
    assert.doesNotThrow(() => buildRawPrompt(quotedInput));

    const leakedConstraintInput = makeInput();
    leakedConstraintInput.intent.authorMustInclude = ["每段不超过300字"];
    assert.throws(
      () => buildRawPrompt(leakedConstraintInput),
      /raw_prompt_prose_freedom_violation/,
    );
  });
});
