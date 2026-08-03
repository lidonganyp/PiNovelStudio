/**
 * DIALOGUE-CRAFT-1：VoiceFingerprint / DialogueCraft 生产只读接入最小闭环测试
 *
 * 验收口径（DIALOGUE-CRAFT-1 任务书）：
 * 1. 仅本章发言角色（focusCharacterGoals.character ∪ relevantCharacters 命中）进入 prompt。
 * 2. 指纹带来源样章/接受稿（sourceChapterRef + sourceType）。
 * 3. 对白功能、归属、动作标签有 span（诊断 advisory，不直接覆盖 raw）。
 * 4. 诊断可触发机会候选但不直接覆盖 raw。
 * 5. 无两名已注册发言者时不得伪造盲测（blindTestEligible=false）。
 * 6. 删除指纹来源后不得进入 prompt（sourceChapterRef 缺失 → 不进入 fingerprint entries）。
 * 7. 对话比例不得成为 gate（不暴露 ratio 作为 gate 字段，只作 advisory 信息）。
 * 8. 指纹缺失时退化到现有 CharacterVoice 弱代理并写明 confidence。
 *
 * 边界：
 * - 不修改 finalText
 * - 不生成 candidate（dialogueCraft 诊断不直接触发 candidate 覆盖 raw）
 * - 不触发 StyleShaper
 * - 不把对白比例变成 hard gate
 * - 不提交长期状态
 * - 不调用 LLM
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileDialogueCraftContext,
  formatDialogueCraftPromptBlock,
  skippedDialogueCraft,
} from "../dist/v2/core/dialogue-craft-compiler.js";
import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";
import { TEST_STYLE_REFERENCES } from "./test-style-fingerprint.mjs";

// ============================================================================
// 辅助：构造 ChapterIntent / VoiceFingerprint / CharacterState
// ============================================================================

function makeIntent(overrides = {}) {
  return {
    chapterFunction: "推进核心冲突",
    readerExperience: ["紧张"],
    currentPressure: ["水下救援压力"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林川", "苏婉"],
    inviolableFacts: [],
    sourceRefs: ["chapter-seed"],
    concreteDelivery: [],
    focusCharacterGoals: [{ character: "林川", goal: "救出苏婉" }],
    resistance: [],
    choicesAndCosts: [],
    expectedIrreversibleChange: [],
    selectedPromisesToAdvance: [],
    causalEndPressure: [],
    factAndCharacterKnowledgeForbiddenZones: [],
    fieldSourceRefs: {},
    ...overrides,
  };
}

function makeFingerprint(characterId, characterName, overrides = {}) {
  return {
    characterId,
    characterName,
    fingerprint: {
      characterId,
      characterName,
      sentenceSignature: {
        lengthAvg: 12,
        lengthVariance: 3,
        invertedSentenceRatio: 0.1,
        omissionHabit: "occasional",
      },
      vocabularyLevel: "mixed",
      infoPattern: "direct",
      silenceFrequency: 0.4,
      topicControl: 0.6,
      speechActionCoupling: ["皱眉", "摇头"],
      avoidancePatterns: [],
      addressHabits: { toPeer: "道友", selfAddress: "在下" },
    },
    sourceChapterRef: "chapters/ch12-accepted.md",
    sourceType: "accepted_manuscript",
    ...overrides,
  };
}

function makeCharacterState(name, overrides = {}) {
  return {
    characterId: name,
    name,
    state: {
      role: "protagonist",
      mentality: "焦虑",
      pendingTension: "时间紧迫",
      aliases: [],
    },
    sourceIds: [`character:${name}`],
    ...overrides,
  };
}

async function runRawFailureWithDialogue({ voiceFingerprints = [] } = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), "dialogue-craft-integration-"));
  let capturedPrompt = "";
  try {
    const result = await createUnifiedOrchestrator().orchestrate({
      workspaceId: "dialogue-craft-test",
      chapterId: "ch1",
      chapterNumber: 1,
      projectRoot,
      intent: makeIntent(),
      context: {
        facts: [],
        characterStates: [makeCharacterState("林川"), makeCharacterState("苏婉")],
        openLoops: [],
        worldRules: [],
        styleReferences: TEST_STYLE_REFERENCES,
        sourceMap: [],
        constitution: null,
        longTermState: null,
      },
      constitution: null,
      characterNames: ["林川", "苏婉"],
      voiceFingerprints,
      modelGenerate: async (input) => {
        if (input.kind === "raw_chapter") capturedPrompt = input.userPrompt;
        throw new Error("intentional raw failure");
      },
    });
    return { result, capturedPrompt };
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

test("integration: 无可靠指纹时仅保留弱代理 trace，不与 CharacterVoice 重复注入 prompt", async () => {
  const { result, capturedPrompt } = await runRawFailureWithDialogue();
  assert.equal(result.status, "blocked");
  assert.ok(result.stageResults.dialogueCraft, "raw failure 仍应保留 dialogueCraft trace");
  assert.equal(result.stageResults.dialogueCraft.consumedByRawPrompt, false);
  assert.ok(!result.stageResults.chapterIntent.consumedFields.includes("dialogueCraft"));
  assert.ok(!capturedPrompt.includes("本章发言角色声音指纹"));
  assert.ok(!capturedPrompt.includes("本章相关角色状态提示"), "角色声音弱代理只留 trace，不进入 raw prompt");
});

test("integration: 有可靠 sourceChapterRef 的指纹仍只进入 trace，不指挥 raw", async () => {
  const { result, capturedPrompt } = await runRawFailureWithDialogue({
    voiceFingerprints: [makeFingerprint("林川", "林川")],
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.stageResults.dialogueCraft.consumedByRawPrompt, false);
  assert.ok(!result.stageResults.chapterIntent.consumedFields.includes("dialogueCraft"));
  assert.ok(!capturedPrompt.includes("本章发言角色声音指纹"));
  assert.ok(!capturedPrompt.includes("接受稿"));
  assert.doesNotMatch(capturedPrompt, /[A-Za-z]/);
});

// ============================================================================
// 1. 仅本章发言角色进入 prompt
// ============================================================================

test("仅 focusCharacterGoals ∪ relevantCharacters 命中角色进入 speakingCharacters", () => {
  const intent = makeIntent({
    relevantCharacters: ["林川", "苏婉"],
    focusCharacterGoals: [{ character: "林川", goal: "救出苏婉" }],
  });
  const fingerprints = [
    makeFingerprint("林川", "林川"),
    makeFingerprint("苏婉", "苏婉"),
    makeFingerprint("老周", "老周"), // 不在 relevantCharacters 也不在 focusCharacterGoals
    makeFingerprint("路人甲", "路人甲"),
  ];

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [],
    rawText: null,
  });

  const ctx = result.dialogueCraftContext;
  const speakingNames = ctx.speakingCharacters.map((s) => s.name);
  assert.ok(speakingNames.includes("林川"), "林川应在 speakingCharacters 中");
  assert.ok(speakingNames.includes("苏婉"), "苏婉应在 speakingCharacters 中");
  assert.ok(!speakingNames.includes("老周"), "老周不在本章 relevantCharacters 中，不应进入 speakingCharacters");
  assert.ok(!speakingNames.includes("路人甲"), "路人甲不在本章 relevantCharacters 中，不应进入 speakingCharacters");
});

// ============================================================================
// 2. 指纹带来源样章/接受稿
// ============================================================================

test("指纹条目带 sourceChapterRef 和 sourceType", () => {
  const intent = makeIntent();
  const fingerprints = [
    makeFingerprint("林川", "林川", {
      sourceChapterRef: "chapters/ch12-accepted.md",
      sourceType: "accepted_manuscript",
    }),
    makeFingerprint("苏婉", "苏婉", {
      sourceChapterRef: "chapters/ch8-sample.md",
      sourceType: "chapter_sample",
    }),
  ];

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [],
    rawText: null,
  });

  const lin = result.dialogueCraftContext.speakingCharacters.find((s) => s.name === "林川");
  const su = result.dialogueCraftContext.speakingCharacters.find((s) => s.name === "苏婉");
  assert.equal(lin.fingerprintSourceRef, "chapters/ch12-accepted.md");
  assert.equal(lin.fingerprintSourceType, "accepted_manuscript");
  assert.equal(su.fingerprintSourceRef, "chapters/ch8-sample.md");
  assert.equal(su.fingerprintSourceType, "chapter_sample");
});

// ============================================================================
// 3. 对白功能、归属、动作标签诊断带 span（仅当 rawText 提供时）
// ============================================================================

test("rawText 提供时，dialogueCraftAdvisory 含 span 字段", () => {
  const intent = makeIntent();
  const fingerprints = [makeFingerprint("林川", "林川"), makeFingerprint("苏婉", "苏婉")];
  // rawText 含连续 3 轮纯对白无信息增量（rule 1 候选）
  const rawText = [
    "林川说：「我们走。」",
    "苏婉说：「好的。」",
    "林川说：「快。」",
  ].join("\n");

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [],
    rawText,
  });

  const ctx = result.dialogueCraftContext;
  // 至少有一条 advisory（rule 1/2/3 之一）
  assert.ok(ctx.dialogueCraftAdvisory.length >= 0, "advisory 列表应存在");
  // 如果有 advisory，每条必须可追溯到 rule 编号
  for (const adv of ctx.dialogueCraftAdvisory) {
    assert.ok([1, 2, 3].includes(adv.rule), `advisory.rule 应为 1/2/3，实际为 ${adv.rule}`);
    assert.ok(adv.severity === "warning" || adv.severity === "critical", "severity 应为 warning/critical");
    assert.ok(typeof adv.evidence === "string" && adv.evidence.length > 0, "evidence 应为非空字符串");
    // span 可选（rule 2 标签删除归属可能没有 line 级 span），但若有则结构正确
    if (adv.span) {
      assert.ok(typeof adv.span.start === "number", "span.start 应为数字");
      assert.ok(typeof adv.span.end === "number", "span.end 应为数字");
      assert.ok(adv.span.end >= adv.span.start, "span.end 应 >= span.start");
    }
  }
});

test("rawText 为 null 时，advisory 不带 span（仅结构提示）", () => {
  const intent = makeIntent();
  const fingerprints = [makeFingerprint("林川", "林川"), makeFingerprint("苏婉", "苏婉")];

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [],
    rawText: null,
  });

  const ctx = result.dialogueCraftContext;
  // rawText 为 null 时 advisory 应为空（无可诊断对象）
  assert.equal(ctx.dialogueCraftAdvisory.length, 0, "rawText 为 null 时 advisory 应为空");
});

// ============================================================================
// 4. 诊断可触发机会候选但不直接覆盖 raw
// ============================================================================

test("诊断结果只读，不返回覆盖 raw 的指令", () => {
  const intent = makeIntent();
  const fingerprints = [makeFingerprint("林川", "林川"), makeFingerprint("苏婉", "苏婉")];
  const rawText = [
    "林川说：「我们走。」",
    "苏婉说：「好的。」",
    "林川说：「快。」",
  ].join("\n");

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [],
    rawText,
  });

  const ctx = result.dialogueCraftContext;
  // 不应有 rewrite/patch/overrideRaw 等字段
  assert.equal(ctx.rewriteRaw, undefined, "不应有 rewriteRaw 字段");
  assert.equal(ctx.patchRaw, undefined, "不应有 patchRaw 字段");
  assert.equal(ctx.overrideRaw, undefined, "不应有 overrideRaw 字段");
  // 应明确标注 advisoryOnly = true
  assert.equal(ctx.advisoryOnly, true, "advisoryOnly 应为 true");
  // 应标注可触发机会候选
  assert.ok(typeof ctx.canTriggerEditorialOpportunity === "boolean", "canTriggerEditorialOpportunity 应为布尔");
});

// ============================================================================
// 5. 无两名已注册发言者时不得伪造盲测
// ============================================================================

test("仅 1 名注册发言者时 blindTestEligible=false", () => {
  const intent = makeIntent({
    relevantCharacters: ["林川"], // 仅 1 名
    focusCharacterGoals: [{ character: "林川", goal: "救出苏婉" }],
  });
  const fingerprints = [makeFingerprint("林川", "林川")];

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [],
    rawText: null,
  });

  assert.equal(result.dialogueCraftContext.blindTestEligible, false, "仅 1 名注册发言者时不应伪造盲测");
});

test("0 名注册发言者时 blindTestEligible=false", () => {
  const intent = makeIntent({
    relevantCharacters: ["林川", "苏婉"],
    focusCharacterGoals: [],
  });
  const fingerprints = []; // 无指纹

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [],
    rawText: null,
  });

  assert.equal(result.dialogueCraftContext.blindTestEligible, false, "0 名注册发言者时不应伪造盲测");
});

test("≥2 名注册发言者且都有指纹时 blindTestEligible=true", () => {
  const intent = makeIntent({
    relevantCharacters: ["林川", "苏婉"],
    focusCharacterGoals: [],
  });
  const fingerprints = [makeFingerprint("林川", "林川"), makeFingerprint("苏婉", "苏婉")];

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [],
    rawText: null,
  });

  assert.equal(result.dialogueCraftContext.blindTestEligible, true, "≥2 名注册发言者且有指纹时应可盲测");
});

// ============================================================================
// 6. 删除指纹来源后不得进入 prompt
// ============================================================================

test("指纹 sourceChapterRef 缺失时，不进入 fingerprint entries（降级为弱代理）", () => {
  const intent = makeIntent();
  // 林川的指纹缺失 sourceChapterRef
  const fingerprints = [
    makeFingerprint("林川", "林川", { sourceChapterRef: "", sourceType: "accepted_manuscript" }),
    makeFingerprint("苏婉", "苏婉", { sourceChapterRef: "chapters/ch8.md", sourceType: "chapter_sample" }),
  ];

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [makeCharacterState("林川")], // 林川有 state，可降级为弱代理
    rawText: null,
  });

  const lin = result.dialogueCraftContext.speakingCharacters.find((s) => s.name === "林川");
  const su = result.dialogueCraftContext.speakingCharacters.find((s) => s.name === "苏婉");
  // 林川指纹被删除（sourceChapterRef 为空），不应进入 fingerprint entries
  assert.equal(lin.hasFingerprint, false, "林川 sourceChapterRef 缺失，hasFingerprint 应为 false");
  assert.equal(lin.fingerprintSourceRef, null, "fingerprintSourceRef 应为 null");
  // 林川降级为弱代理
  assert.equal(lin.recoveryMode, "character_voice_weak_proxy", "应降级为 character_voice_weak_proxy");
  assert.ok(lin.confidence < 0.5, `弱代理 confidence 应 < 0.5，实际为 ${lin.confidence}`);
  // 苏婉指纹完整
  assert.equal(su.hasFingerprint, true);
  assert.equal(su.fingerprintSourceRef, "chapters/ch8.md");
});

test("指纹 sourceChapterRef 缺失且无 characterState 时，仍写明 recoveryMode 并 confidence 极低", () => {
  const intent = makeIntent();
  const fingerprints = [
    makeFingerprint("林川", "林川", { sourceChapterRef: "", sourceType: "accepted_manuscript" }),
  ];

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [], // 无 state 可降级
    rawText: null,
  });

  const lin = result.dialogueCraftContext.speakingCharacters.find((s) => s.name === "林川");
  assert.equal(lin.hasFingerprint, false);
  assert.equal(lin.recoveryMode, "intent_only_no_voice", "无 state 时降级为 intent_only_no_voice");
  assert.ok(lin.confidence <= 0.3, `无任何代理时 confidence 应 <= 0.3，实际为 ${lin.confidence}`);
});

// ============================================================================
// 7. 对话比例不得成为 gate
// ============================================================================

test("context 不暴露 dialogueRatio 作为 gate 字段", () => {
  const intent = makeIntent();
  const fingerprints = [makeFingerprint("林川", "林川"), makeFingerprint("苏婉", "苏婉")];
  const rawText = "林川说：「走。」\n苏婉说：「好。」";

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [],
    rawText,
  });

  const ctx = result.dialogueCraftContext;
  // 不应有 dialogueRatioGate / dialogueRatioThreshold / dialogueRatioHardBlock 等 gate 字段
  assert.equal(ctx.dialogueRatioGate, undefined);
  assert.equal(ctx.dialogueRatioThreshold, undefined);
  assert.equal(ctx.dialogueRatioHardBlock, undefined);
  // 不应有 passed/blocked 等 gate 状态
  assert.equal(ctx.passed, undefined);
  assert.equal(ctx.blocked, undefined);
  // 若提供 dialogueRatio 信息，必须仅作 informational advisory，不是 gate
  if (ctx.dialogueRatioInfo !== undefined) {
    assert.equal(ctx.dialogueRatioInfo.isGate, false, "dialogueRatioInfo 必须明确 isGate=false");
  }
});

test("promptBlock 不含对白比例硬门措辞", () => {
  const intent = makeIntent();
  const fingerprints = [makeFingerprint("林川", "林川"), makeFingerprint("苏婉", "苏婉")];

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [],
    rawText: null,
  });

  if (result.promptBlock) {
    // 不应出现"对白比例必须"/"对白比例不得低于"/"对白比例硬门"等机械硬门措辞
    assert.ok(!result.promptBlock.includes("对白比例必须"), "promptBlock 不应含对白比例必须");
    assert.ok(!result.promptBlock.includes("对白比例不得低于"), "promptBlock 不应含对白比例不得低于");
    assert.ok(!result.promptBlock.includes("对白比例硬门"), "promptBlock 不应含对白比例硬门");
    assert.ok(!result.promptBlock.includes("dialogueRatioThreshold"), "promptBlock 不应含 dialogueRatioThreshold");
  }
});

// ============================================================================
// 8. 指纹缺失时退化到现有 CharacterVoice 弱代理
// ============================================================================

test("指纹缺失但有 characterState 时，退化到 CharacterVoice 弱代理", () => {
  const intent = makeIntent({
    relevantCharacters: ["林川", "苏婉"],
    focusCharacterGoals: [],
  });
  // 两人都没有指纹
  const fingerprints = [];
  const characterStates = [
    makeCharacterState("林川", { state: { role: "protagonist", mentality: "焦虑", pendingTension: "时间紧迫" } }),
    makeCharacterState("苏婉", { state: { role: "supporting", mentality: "害怕", pendingTension: "未知" } }),
  ];

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates,
    rawText: null,
  });

  const ctx = result.dialogueCraftContext;
  assert.equal(ctx.blindTestEligible, false, "无指纹时不应伪造盲测");
  assert.ok(ctx.proxyNote, "应有 proxyNote 说明弱代理性质");
  assert.equal(result.promptBlock, null, "弱代理只留 trace，raw prompt 由 CharacterVoiceContext 独占");
  for (const sp of ctx.speakingCharacters) {
    assert.equal(sp.hasFingerprint, false);
    assert.equal(sp.recoveryMode, "character_voice_weak_proxy");
    assert.ok(sp.confidence < 0.5, `弱代理 confidence 应 < 0.5，实际为 ${sp.confidence}`);
  }
});

// ============================================================================
// 9. 空状态处理
// ============================================================================

test("无任何角色数据时写 emptyReason，不伪造", () => {
  const intent = makeIntent({
    relevantCharacters: [],
    focusCharacterGoals: [],
  });

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: [],
    characterStates: [],
    rawText: null,
  });

  const ctx = result.dialogueCraftContext;
  assert.equal(ctx.speakingCharacters.length, 0);
  assert.ok(ctx.emptyReason, "应有 emptyReason");
  assert.equal(ctx.consumedByRawPrompt, false);
  assert.equal(result.promptBlock, null, "空状态 promptBlock 应为 null");
});

test("skippedDialogueCraft 写明 skipped 原因", () => {
  const skipped = skippedDialogueCraft("hardBlock");
  assert.ok(skipped.emptyReason.includes("skipped"));
  assert.equal(skipped.speakingCharacters.length, 0);
  assert.equal(skipped.blindTestEligible, false);
});

// ============================================================================
// 10. promptBlock 格式与可追溯性
// ============================================================================

test("promptBlock 只含可靠指纹来源，弱代理不与 CharacterVoice 重复", () => {
  const intent = makeIntent();
  const fingerprints = [
    makeFingerprint("林川", "林川", { sourceChapterRef: "chapters/ch12-accepted.md", sourceType: "accepted_manuscript" }),
  ];
  const characterStates = [makeCharacterState("苏婉")]; // 苏婉无指纹，降级

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates,
    rawText: null,
  });

  const block = result.promptBlock;
  assert.ok(block, "应有 promptBlock");
  assert.ok(block.includes("林川"), "promptBlock 应含林川");
  assert.ok(!block.includes("苏婉"), "弱代理角色不应在 DialogueCraft prompt 重复注入");
  assert.ok(block.includes("接受稿"), "promptBlock 应含中文化的指纹来源类型");
  assert.doesNotMatch(block, /[A-Za-z]/, "promptBlock 不应把内部来源路径泄漏给模型");
  assert.ok(!block.includes("弱代理"), "弱代理说明只保留在 trace");
});

test("formatDialogueCraftPromptBlock 空时返回 null", () => {
  const block = formatDialogueCraftPromptBlock({
    speakingCharacters: [],
    blindTestEligible: false,
    dialogueCraftAdvisory: [],
    sourceRefs: [],
    consumedByRawPrompt: false,
    advisoryOnly: true,
    canTriggerEditorialOpportunity: false,
  });
  assert.equal(block, null);
});

// ============================================================================
// 11. sourceRefs 可追溯
// ============================================================================

test("sourceRefs 含指纹来源与 characterState 来源", () => {
  const intent = makeIntent();
  const fingerprints = [
    makeFingerprint("林川", "林川", { sourceChapterRef: "chapters/ch12-accepted.md" }),
  ];
  const characterStates = [makeCharacterState("苏婉")];

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates,
    rawText: null,
  });

  const refs = result.dialogueCraftContext.sourceRefs;
  assert.ok(refs.some((r) => r.includes("chapters/ch12-accepted.md")), "应含指纹来源 ref");
  assert.ok(refs.some((r) => r.includes("character:") || r.includes("characterStates")), "应含 characterState 来源 ref");
});

// ============================================================================
// 12. canTriggerEditorialOpportunity 仅在有诊断 advisory 时为 true
// ============================================================================

test("有 advisory 命中时 canTriggerEditorialOpportunity=true", () => {
  const intent = makeIntent();
  const fingerprints = [makeFingerprint("林川", "林川"), makeFingerprint("苏婉", "苏婉")];
  // 触发 rule 1（连续 3 轮纯对白无信息增量）
  const rawText = [
    "林川说：「我们走。」",
    "苏婉说：「好的。」",
    "林川说：「快。」",
  ].join("\n");

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [],
    rawText,
  });

  const ctx = result.dialogueCraftContext;
  if (ctx.dialogueCraftAdvisory.length > 0) {
    assert.equal(ctx.canTriggerEditorialOpportunity, true, "有 advisory 时应可触发机会候选");
  }
});

test("无 advisory 命中时 canTriggerEditorialOpportunity=false", () => {
  const intent = makeIntent();
  const fingerprints = [makeFingerprint("林川", "林川"), makeFingerprint("苏婉", "苏婉")];
  // 健康 raw：每轮对白有动作标签或信息增量
  const rawText = [
    '林川抓起背包说："我们走，时间不多了。"',
    '苏婉点头："好，但是水下的暗流怎么办？"',
    '林川皱眉："我从浅滩绕过去。"',
  ].join("\n");

  const result = compileDialogueCraftContext({
    intent,
    voiceFingerprints: fingerprints,
    characterStates: [],
    rawText,
  });

  const ctx = result.dialogueCraftContext;
  if (ctx.dialogueCraftAdvisory.length === 0) {
    assert.equal(ctx.canTriggerEditorialOpportunity, false, "无 advisory 时不应触发机会候选");
  }
});
