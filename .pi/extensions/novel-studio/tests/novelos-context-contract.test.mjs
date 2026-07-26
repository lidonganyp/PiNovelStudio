/**
 * 验证显式章纲契约进入 NovelOS Agentic 生成提示。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildChapterIntentString } from "../dist/novelos/agent/agentic-raw-candidate-source.js";
import { createEvidencePlan } from "../dist/novelos/agent/evidence-plan.js";
import { createNarrativeVerifierSuite } from "../dist/novelos/verification/narrative-verifier-suite.js";

test("NovelOS 章节意图包含作者章纲事件契约", () => {
  const prompt = buildChapterIntentString({
    chapterFunction: "主世界主线推进",
    readerExperience: ["爽"],
    currentPressure: ["氧气有限"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: ["战力定位将变"],
    relevantCharacters: ["李一凡", "小妖"],
    inviolableFacts: ["铁山已死亡"],
    authorEventSummaries: ["到达青鱼嘴并完成水样采集", "水下救援并击杀水怪"],
    authorMustInclude: ["三队首次配合", "鳞片一击斩杀水怪"],
    authorStateChanges: ["李一凡真实战力暴露"],
    endingTarget: ["墨老气息增强但仍未醒"],
  });

  assert.match(prompt, /到达青鱼嘴并完成水样采集/);
  assert.match(prompt, /鳞片一击斩杀水怪/);
  assert.match(prompt, /李一凡真实战力暴露/);
  assert.match(prompt, /墨老气息增强但仍未醒/);
});

test("NovelOS 不把一般约束里的引号示例误判成章纲必写事件", () => {
  const prompt = [
    "作者章纲必须包含：三队首次配合；鳞片一击斩杀水怪",
    "不可破坏的事实：禁止写‘万永福砸家’，禁止写‘我对她的爱，何尝比你少’",
  ].join("\n");
  const plan = createEvidencePlan({ chapterIntent: prompt, seedContext: "" });
  assert.deepEqual(plan.mustVerify, ["三队首次配合", "鳞片一击斩杀水怪"]);
});

test("NovelOS 章纲遗漏检查只检查明确必须包含项", () => {
  const report = createNarrativeVerifierSuite().verify({
    text: "三队第一次协同作战。鳞片掠过水下，水怪被一击切开。",
    context: { facts: [], characterStates: [], openLoops: [], worldRules: [], styleReferences: [], sourceMap: [] },
    chapterIntent: [
      "作者章纲必须包含：三队首次配合；鳞片一击斩杀水怪",
      "不可破坏的事实：禁止写‘万永福砸家’",
    ].join("\n"),
    knownCharacterNames: [],
    inviolableFacts: [],
  });
  assert.equal(report.hardFindings.some((finding) => finding.conflictFact.includes("万永福")), false);
});

test("NovelOS 章纲普通锚点允许自然改写但原句项仍需精确出现", () => {
  const report = createNarrativeVerifierSuite().verify({
    text: "三支队伍第一次协同作战。战狼开火，子弹连皮都没能擦破。鳞片破开水怪的鳞甲，将它当场斩杀。至少有三只水怪在浑浊中穿梭，氧气在消耗。暗金色的竖瞳一闪而过。结尾时，他知道定位要变了。原句：青鱼嘴采样箱少了一只。",
    context: { facts: [], characterStates: [], openLoops: [], worldRules: [], styleReferences: [], sourceMap: [] },
    chapterIntent: [
      "作者章纲必须包含：三队首次配合；战狼开枪无效；鳞片一击斩杀水怪；多只水怪围攻；倒计时型压力；暗金双眸一闪而过；章末预判定位将变；原句：「青鱼嘴采样箱少了一只」",
    ].join("\n"),
    knownCharacterNames: [],
    inviolableFacts: [],
  });
  const omissions = report.hardFindings.filter((finding) => finding.failureType === "intent_omission");
  assert.equal(omissions.length, 0, JSON.stringify(omissions));
});

test("NovelOS 章纲锚点识别叙事动作表达而不要求正文复述标签", () => {
  const text = [
    "赵明远眉头锁得很紧，眼神阴沉。小妖压低声音说，队长今天状态不对。",
    "战狼的机枪瞬间开火，子弹打在水怪鳞片上溅起火星，连皮都没擦破。",
    "浑浊中亮起两双猩红的眼睛。不止一只。水怪黑影从四面逼近。",
    "小妖在水中愣住了，瞪大眼睛看着李一凡，甚至忘了踩水。",
    "上岸后，小妖递给他一条毛巾，低声问：你没事吧。",
    "李一凡清楚，自己在镇夜司和战队里的定位，再也回不到从前了。",
  ].join("\n");
  const chapterIntent = "作者章纲必须包含：赵明远状态反常；战狼开枪无效；多只水怪围攻；小妖震惊；小妖关心确认；章末预判定位将变";
  const verifier = createNarrativeVerifierSuite();

  const coveredReport = verifier.verify({
    text,
    context: { facts: [], characterStates: [], openLoops: [], worldRules: [], styleReferences: [], sourceMap: [] },
    chapterIntent,
    knownCharacterNames: [],
    inviolableFacts: [],
  });
  const coveredOmissions = coveredReport.hardFindings.filter((finding) => finding.failureType === "intent_omission");
  assert.equal(coveredOmissions.length, 0, JSON.stringify(coveredOmissions));

  const missingReport = verifier.verify({
    text: text.replace("李一凡清楚，自己在镇夜司和战队里的定位，再也回不到从前了。", "汽车驶入城区，李一凡看着窗外。"),
    context: { facts: [], characterStates: [], openLoops: [], worldRules: [], styleReferences: [], sourceMap: [] },
    chapterIntent,
    knownCharacterNames: [],
    inviolableFacts: [],
  });
  const missingOmissions = missingReport.hardFindings.filter((finding) => finding.failureType === "intent_omission");
  assert.deepEqual(missingOmissions.map((finding) => finding.sourceRef), ["author-outline:章末预判定位将变"]);
});

test("NovelOS 章纲事件摘要按事件覆盖而不是整句匹配", () => {
  const report = createNarrativeVerifierSuite().verify({
    text: "三支队伍第一次协同作战，护住了研究员。水怪突然破水而出，王研究员被拖向深处，赵明远立即下令救援。",
    context: { facts: [], characterStates: [], openLoops: [], worldRules: [], styleReferences: [], sourceMap: [] },
    chapterIntent: [
      "作者章纲事件顺序：",
      "  1. 三队首次配合并完成救援",
      "  2. 水怪突袭将研究员拖入水底并下令救人",
      "  3. 回程木心微亮但墨老仍未醒",
      "作者章纲必须包含：三队首次配合",
    ].join("\n"),
    knownCharacterNames: [],
    inviolableFacts: [],
  });
  const eventOmissions = report.hardFindings.filter((finding) => finding.source === "event_intent_checker");
  assert.equal(eventOmissions.length, 1, JSON.stringify(eventOmissions));
  assert.equal(eventOmissions[0].sourceRef, "author-outline:event:3");
});

test("NovelOS 禁止性约束不会被事实遗漏检查反向要求写进正文", () => {
  const report = createNarrativeVerifierSuite().verify({
    text: "李一凡收回鳞片，水面重新安静下来。",
    context: { facts: [], characterStates: [], openLoops: [], worldRules: [], styleReferences: [], sourceMap: [] },
    chapterIntent: "作者章纲必须包含：鳞片",
    knownCharacterNames: ["李一凡"],
    inviolableFacts: [
      "禁止所有感叹号一律改句号",
      "禁止无依据空降升级",
      "青鱼嘴水域有暗流",
    ],
  });
  const factOmissions = report.hardFindings.filter((finding) => finding.failureType === "fact_omission");
  assert.deepEqual(factOmissions.map((finding) => finding.conflictFact), [
    "必需事实「青鱼嘴水域有暗流」的核心特征「暗流」在正文中遗漏",
  ]);
});
