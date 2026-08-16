/**
 * XINMO-CONSTITUTION-1 测试（RED）
 *
 * 验收口径（来自任务清单 D:\CODE\PiNovelStudio\delete\任务列表\项目优化20260718.md）：
 * 1. workspaces/xinmo/creative-constitution.json 存在并通过 validateConstitution
 * 2. LOCKED_FIELDS 全部非空（用户核心承诺只能人工修改，但必须存在）
 * 3. 不得把"单句必须少于25字"等机械配额写入宪法
 * 4. Constitution 被 raw/editorial/judge 三端消费：
 *    - judge-prompt-builder 消费 protagonistCoreConflict + readerPromise
 *    - genre-contract-compiler 消费 genrePromises
 *    - world-presentation-compiler 消费 genrePromises + forbiddenDrift
 * 5. narrativePreferences + forbiddenDrift 覆盖核心用户偏好与禁止漂移
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadCreativeConstitution,
  validateConstitution,
  LOCKED_FIELDS,
  constitutionPath,
} from "../dist-eval/v2/core/creative-constitution.js";
import { buildJudgePrompt } from "../dist-eval/v2/core/judge-prompt-builder.js";
import { createEditorialCandidateGenerator } from "../dist-eval/v2/core/editorial-candidate-generator.js";
import { createEditorialStrategyRegistry } from "../dist-eval/v2/core/editorial-strategy-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");
// tests/ at .pi/extensions/novel-studio/tests; repo root is 4 levels up:
// tests -> novel-studio -> extensions -> .pi -> PiNovelStudio
const PROJECT_ROOT = join(__dirname, "..", "..", "..", "..");
const WORKSPACE_ID = "xinmo";

function loadXinmoConstitution() {
  const livePath = constitutionPath(WORKSPACE_ID, PROJECT_ROOT);
  const fixturePath = join(__dirname, "fixtures", "xinmo-creative-constitution.json");
  const path = existsSync(livePath) ? livePath : fixturePath;
  if (!existsSync(path)) {
    return { skipped: true, path, constitution: null };
  }
  if (path === livePath) {
    return { skipped: false, path, constitution: loadCreativeConstitution(WORKSPACE_ID, PROJECT_ROOT) };
  }
  return {
    skipped: false,
    path,
    constitution: JSON.parse(readFileSync(path, "utf-8")),
  };
}

function buildSnapshot(constitution) {
  return {
    workIdentity: constitution.workIdentity,
    readerPromise: constitution.readerPromise,
    genrePromises: constitution.genrePromises,
    protagonistCoreConflict: constitution.protagonistCoreConflict,
    thematicQuestions: constitution.thematicQuestions,
    aestheticDirection: constitution.aestheticDirection,
    forbiddenDrift: constitution.forbiddenDrift,
    narrativePreferences: constitution.narrativePreferences,
  };
}

test("XINMO-CONSTITUTION-1 · 宪法文件存在并通过 schema 校验", () => {
  const { skipped, path, constitution } = loadXinmoConstitution();
  if (skipped) {
    assert.fail(`预期存在 creative-constitution.json，但未找到：${path}`);
  }
  assert.ok(constitution, "loadCreativeConstitution 应返回非 null");
  assert.equal(constitution.schemaVersion, 1);
  const validation = validateConstitution(constitution);
  assert.ok(validation.ok, `validateConstitution 失败：${validation.errors.join("; ")}`);
});

test("XINMO-CONSTITUTION-1 · LOCKED_FIELDS 核心字段全部非空", () => {
  const { skipped, constitution } = loadXinmoConstitution();
  if (skipped) assert.fail("宪法文件不存在");
  const c = constitution;

  assert.equal(typeof c.workIdentity, "string");
  assert.ok(c.workIdentity.length > 20, "workIdentity 必须有具体内容（>20 字符）");

  assert.ok(Array.isArray(c.readerPromise) && c.readerPromise.length >= 3,
    `readerPromise 至少 3 条，实际 ${c.readerPromise?.length}`);
  assert.ok(Array.isArray(c.genrePromises) && c.genrePromises.length >= 2,
    `genrePromises 至少 2 条，实际 ${c.genrePromises?.length}`);
  assert.ok(Array.isArray(c.thematicQuestions) && c.thematicQuestions.length >= 2,
    `thematicQuestions 至少 2 条，实际 ${c.thematicQuestions?.length}`);

  assert.ok(typeof c.protagonistCoreConflict === "string" && c.protagonistCoreConflict.length > 20,
    "protagonistCoreConflict 必须有具体内容");

  const expectedLocked = ["workIdentity", "readerPromise", "genrePromises",
    "protagonistCoreConflict", "thematicQuestions", "schemaVersion"];
  assert.deepEqual([...LOCKED_FIELDS].sort(), [...expectedLocked].sort());
});

test("XINMO-CONSTITUTION-1 · 不得写入机械配额", () => {
  const { skipped, constitution } = loadXinmoConstitution();
  if (skipped) assert.fail("宪法文件不存在");

  const text = JSON.stringify(constitution);
  const forbiddenMechanicalQuotas = [
    "单句必须少于",
    "必须少于25字",
    "每段必须",
    "对白比例",
    "字数不少于",
    "字数不超过",
    "段落数",
  ];
  for (const forbidden of forbiddenMechanicalQuotas) {
    assert.ok(!text.includes(forbidden),
      `宪法不得包含机械配额 "${forbidden}"`);
  }
});

test("XINMO-CONSTITUTION-1 · judge-prompt-builder 消费 protagonistCoreConflict 与 readerPromise", () => {
  const { skipped, constitution } = loadXinmoConstitution();
  if (skipped) assert.fail("宪法文件不存在");

  const snapshot = buildSnapshot(constitution);
  const intent = {
    chapterFunction: "推进主角与梦魇博弈",
    readerExperience: ["紧张", "好奇"],
    inviolableFacts: ["李一凡已加入月光战队"],
  };

  const { userPrompt } = buildJudgePrompt({
    candidateAText: "A候选正文",
    candidateBText: "B候选正文",
    intent,
    constitution: snapshot,
  });

  assert.ok(userPrompt.includes(constitution.protagonistCoreConflict),
    "judge prompt 必须消费 protagonistCoreConflict");
  const matchedPromise = constitution.readerPromise.some((p) => userPrompt.includes(p));
  assert.ok(matchedPromise, "judge prompt 必须至少消费一条 readerPromise");
});

test("XINMO-CONSTITUTION-1 · editorial prompt 消费叙事内容边界但不注入审美写法", async () => {
  const { skipped, constitution } = loadXinmoConstitution();
  if (skipped) assert.fail("宪法文件不存在");

  const rawText = "李一凡停在门前，确认同伴都已撤离，才伸手推门。门后传来一声短促的金属摩擦。";
  let capturedPrompt = "";
  const generator = createEditorialCandidateGenerator();
  const result = await generator.generate({
    rawText,
    rawCandidateId: "candidate:raw:xinmo-constitution",
    hypotheses: [{
      id: "hypothesis:reader-payoff",
      opportunityType: "reader_payoff",
      diagnosis: "同伴撤离后的代价尚未形成明确落点",
      evidenceSpans: [{ start: 0, end: 19, excerpt: rawText.slice(0, 19) }],
      expectedReaderGain: "让选择与代价形成可感知的兑现",
      damageRisks: ["不得改变同伴已经撤离的事实"],
      confidence: 0.9,
      source: "llm",
    }],
    intent: {
      chapterFunction: "推进李一凡在保护同伴与追查真相之间的选择",
      readerExperience: ["紧张", "期待"],
      currentPressure: ["门后的未知威胁"],
      meaningfulChoices: [],
      promisesToAdvance: [],
      possibleEndPressure: [],
      relevantCharacters: ["李一凡"],
      inviolableFacts: ["同伴已经撤离"],
      sourceRefs: ["chapter-seed"],
    },
    context: {
      facts: [],
      characterStates: [],
      openLoops: [],
      worldRules: [],
      styleReferences: [],
      sourceMap: [],
      constitution: buildSnapshot(constitution),
      longTermState: null,
    },
    constitution: buildSnapshot(constitution),
    contextHash: "xinmo-constitution-test",
    chapterNumber: 17,
    strategyRegistry: createEditorialStrategyRegistry(),
    modelGenerate: async (input) => {
      capturedPrompt = input.userPrompt;
      return {
        text: rawText,
        model: "stub-editorial",
        route: input.route,
        durationMs: 1,
      };
    },
  });

  assert.equal(result.candidates.length, 1, `editorial 候选生成失败：${JSON.stringify(result.failures)}`);
  assert.ok(capturedPrompt.includes(constitution.workIdentity), "editorial prompt 必须消费 workIdentity");
  assert.ok(capturedPrompt.includes(constitution.protagonistCoreConflict), "editorial prompt 必须消费 protagonistCoreConflict");
  assert.ok(constitution.readerPromise.some((item) => capturedPrompt.includes(item)), "editorial prompt 必须消费 readerPromise");
  assert.equal(constitution.aestheticDirection.some((item) => capturedPrompt.includes(item)), false, "editorial prompt 不得注入 aestheticDirection 写法");
  assert.ok(constitution.forbiddenDrift.some((item) => capturedPrompt.includes(item)), "editorial prompt 必须消费 forbiddenDrift");
  assert.deepEqual(result.constitutionConsumedFields, [
    "constitution.workIdentity",
    "constitution.protagonistCoreConflict",
    "constitution.readerPromise",
    "constitution.forbiddenDrift",
  ]);
});

test("XINMO-CONSTITUTION-1 · genre-contract-compiler 消费 genrePromises", async () => {
  const { skipped, constitution } = loadXinmoConstitution();
  if (skipped) assert.fail("宪法文件不存在");
  const { compileGenreContract } = await import("../dist-eval/v2/core/genre-contract-compiler.js");

  const snapshot = buildSnapshot(constitution);
  const intent = {
    chapterFunction: "推进主角与梦魇博弈",
    readerExperience: ["紧张"],
    inviolableFacts: [],
  };
  const worldRules = [
    {
      id: "world:genre",
      description: "都市异能 / 玄幻 / 成长爽文 / 悲剧爱情",
      type: "genre",
      affectedCharacters: [],
      sourceIds: ["config.json"],
    },
  ];

  const result = compileGenreContract({
    intent, constitution: snapshot, worldRules, driftGenre: null,
  });
  const entries = result.genreContractContext.entries;
  const constitutionSourced = entries.filter((e) => e.source === "constitution");
  assert.equal(constitutionSourced.length, constitution.genrePromises.length,
    `genre-contract 应激活所有 genrePromises（${constitution.genrePromises.length} 条），实际 ${constitutionSourced.length}`);
});

test("XINMO-CONSTITUTION-1 · world-presentation-compiler 消费 genrePromises", async () => {
  const { skipped, constitution } = loadXinmoConstitution();
  if (skipped) assert.fail("宪法文件不存在");
  const { compileWorldPresentationContext } = await import("../dist-eval/v2/core/world-presentation-compiler.js");

  const snapshot = buildSnapshot(constitution);
  const intent = {
    chapterFunction: "推进主线",
    readerExperience: ["紧张"],
    inviolableFacts: [],
  };
  const worldRules = [
    {
      id: "world:power_system",
      description: "炼体（锻骨→淬腑→易筋→洗髓→金身→法相→归一）",
      type: "power_system",
      affectedCharacters: [],
      sourceIds: ["config.json"],
    },
  ];

  const result = compileWorldPresentationContext({
    intent, constitution: snapshot, worldRules,
  });
  assert.ok(result.promptBlock && result.promptBlock.length > 0,
    "world-presentation 应输出非空 promptBlock");
  // genrePromises 至少有一条进入 promptBlock
  const matchedGenre = constitution.genrePromises.some((p) => result.promptBlock.includes(p));
  assert.ok(matchedGenre, "world-presentation promptBlock 必须至少消费一条 genrePromises");
});

test("XINMO-CONSTITUTION-1 · chapter-intent-builder 消费 protagonistCoreConflict/readerPromise/thematicQuestions", async () => {
  const { skipped, constitution } = loadXinmoConstitution();
  if (skipped) assert.fail("宪法文件不存在");
  const { ChapterIntentBuilder } = await import("../dist-eval/v2/core/chapter-intent-builder.js");

  const intentInput = {
    chapterNumber: 17,
    targetEmotions: ["紧张"],
    characters: [{ name: "李一凡", role: "protagonist" }],
    immutableFacts: ["李一凡已加入月光战队"],
    openPromises: [],
    openArcs: [],
    currentPressureSummary: [],
    prevContinuationAvailable: false,
  };

  const builder = new ChapterIntentBuilder();
  const { intent, warnings } = builder.build(intentInput, constitution, null);

  // chapterFunction 应包含 protagonistCoreConflict（当 intentPrimary 缺失时由 constitution 推断）
  assert.ok(intent.chapterFunction.includes(constitution.protagonistCoreConflict),
    `chapterFunction 应包含 protagonistCoreConflict，实际："${intent.chapterFunction}"`);

  // readerExperience 应包含 readerPromise 全部条目
  for (const p of constitution.readerPromise) {
    assert.ok(intent.readerExperience.includes(p),
      `readerExperience 应包含 readerPromise: "${p}"`);
  }

  // possibleEndPressure 应消费 thematicQuestions（前缀格式：可借章末抛回问题：{q}）
  if (constitution.thematicQuestions.length > 0) {
    assert.ok(intent.possibleEndPressure.length >= constitution.thematicQuestions.length,
      `possibleEndPressure 应至少包含 thematicQuestions 全部（${constitution.thematicQuestions.length}），实际 ${intent.possibleEndPressure.length}`);
    for (const q of constitution.thematicQuestions) {
      const matched = intent.possibleEndPressure.some((p) => p.includes(q));
      assert.ok(matched, `possibleEndPressure 应包含 thematicQuestion: "${q}"`);
    }
  }
});

test("XINMO-CONSTITUTION-1 · narrativePreferences 至少 5 条且来源标注合法", () => {
  const { skipped, constitution } = loadXinmoConstitution();
  if (skipped) assert.fail("宪法文件不存在");
  assert.ok(constitution.narrativePreferences.length >= 5,
    `narrativePreferences 至少 5 条，实际 ${constitution.narrativePreferences.length}`);
  for (const p of constitution.narrativePreferences) {
    assert.ok(p.id, `preference.id 必须存在`);
    assert.ok(p.preference && p.preference.length > 0, `preference.preference 必须非空`);
    assert.ok(["user", "accepted_revision", "imported"].includes(p.evidenceSource),
      `preference.evidenceSource 非法：${p.evidenceSource}`);
  }
});

test("XINMO-CONSTITUTION-1 · forbiddenDrift 覆盖核心禁止漂移类别", () => {
  const { skipped, constitution } = loadXinmoConstitution();
  if (skipped) assert.fail("宪法文件不存在");
  assert.ok(constitution.forbiddenDrift.length >= 5,
    `forbiddenDrift 至少 5 条，实际 ${constitution.forbiddenDrift.length}`);
  const joined = constitution.forbiddenDrift.join("\n");
  const requiredPatterns = [
    /被动失败|身体僵硬|做不到/,
    /渐进式突破|100%.*掌控|100%.*突破/,
    /作者.*总结|父爱如山|感动了/,
    /空降|无.*依据.*升级|无.*依据.*设定/,
    /群体.*惊叹|模板.*打脸|机械.*钩子/,
  ];
  for (const pattern of requiredPatterns) {
    assert.ok(pattern.test(joined),
      `forbiddenDrift 必须覆盖模式 ${pattern}`);
  }
});

test("XINMO-CONSTITUTION-1 · 宪法与 CORE-WRITING-PRINCIPLES.md 主题一致", () => {
  const { skipped, constitution } = loadXinmoConstitution();
  if (skipped) assert.fail("宪法文件不存在");

  const combined = constitution.workIdentity + " " + constitution.protagonistCoreConflict;
  assert.ok(combined.includes("李一凡") || combined.includes("主角"),
    "workIdentity/protagonistCoreConflict 必须提到主角");

  const themeText = constitution.thematicQuestions.join("\n");
  assert.ok(themeText.includes("命运") || themeText.includes("心性") || themeText.includes("觉醒"),
    `thematicQuestions 必须覆盖命运/心性/觉醒主题`);

  const expectedTheme = "命运可以改变";
  assert.ok(themeText.includes(expectedTheme),
    `thematicQuestions 必须包含核心主题 "${expectedTheme}"`);
});
