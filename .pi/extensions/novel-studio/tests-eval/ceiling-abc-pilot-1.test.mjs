/** NOVEL-QUALITY-CEILING pilot: A/B/C isolation and decision helpers. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  auditCeilingPilotIsolation,
  buildCeilingExperimentArms,
  buildCeilingJudgeMessages,
  normalizeChineseSceneSolutionPayload,
  runBoundedJsonRequest,
  summarizeCeilingPilot,
} from "../dist-eval/novelos/eval/ceiling-abc-pilot.js";

const sceneSolution = { id: "scene-1" };
const craftGenes = [{ geneId: "evidence_escalation" }];

test("ceiling A/B/C arms expose no reference input surface", () => {
  const arms = buildCeilingExperimentArms(sceneSolution, craftGenes);
  assert.deepEqual(arms.map((arm) => arm.id), ["A", "B", "C"]);
  assert.equal(arms[0].sceneSolution, undefined);
  assert.equal(arms[0].craftGenes, undefined);
  assert.equal(arms[1].sceneSolution, sceneSolution);
  assert.equal(arms[1].craftGenes, undefined);
  assert.equal(arms[2].sceneSolution, sceneSolution);
  assert.equal(arms[2].craftGenes, craftGenes);
  assert.equal(JSON.stringify(arms).includes("reference"), false);
});

test("ceiling isolation rejects target reuse and generator reference leakage", () => {
  const clean = auditCeilingPilotIsolation({
    targetReferenceId: "smsf:physical:1",
    distillationReferenceIds: ["smsf:physical:5", "smsf:physical:12"],
    generatorPayloads: ["心魔界第18章", "主动试探与代价"],
    forbiddenGeneratorTerms: ["smsf:", "神秘复苏", "杨间"],
  });
  assert.equal(clean.valid, true, clean.errors.join("; "));

  const targetReuse = auditCeilingPilotIsolation({
    targetReferenceId: "smsf:physical:1",
    distillationReferenceIds: ["smsf:physical:1"],
    generatorPayloads: ["心魔界第18章"],
    forbiddenGeneratorTerms: ["smsf:", "神秘复苏", "杨间"],
  });
  assert.equal(targetReuse.valid, false);
  assert.ok(targetReuse.errors.includes("target_reference_used_for_distillation"));

  const leaked = auditCeilingPilotIsolation({
    targetReferenceId: "smsf:physical:1",
    distillationReferenceIds: ["smsf:physical:5"],
    generatorPayloads: ["模仿神秘复苏中的杨间"],
    forbiddenGeneratorTerms: ["smsf:", "神秘复苏", "杨间"],
  });
  assert.equal(leaked.valid, false);
  assert.ok(leaked.errors.some((error) => error.startsWith("generator_reference_leak:")));
});

test("ceiling judge is the only payload that receives candidate and reference", () => {
  const messages = buildCeilingJudgeMessages("原创候选正文", "参考章正文");
  const serialized = JSON.stringify(messages);
  assert.match(serialized, /原创候选正文/);
  assert.match(serialized, /参考章正文/);
  assert.match(serialized, /active_protagonist/);
  assert.match(serialized, /native_chinese/);
  assert.match(serialized, /same_tier/);
});

test("ceiling summary distinguishes diagnostic wins from same-tier evidence", () => {
  const verdict = (candidateLevel, referenceLevel, relationship) => ({
    dimensions: Array.from({ length: 8 }, (_, index) => ({
      id: `d${index}`,
      candidate_level: candidateLevel,
      reference_level: referenceLevel,
    })),
    overall_candidate_level: candidateLevel,
    overall_reference_level: referenceLevel,
    tier_relationship: relationship,
    needs_human_review: false,
  });
  const summary = summarizeCeilingPilot({
    A: verdict(3, 4, "candidate_below_reference"),
    B: verdict(4, 4, "same_tier"),
    C: verdict(3, 4, "candidate_below_reference"),
  });
  assert.equal(summary.bestArm, "B");
  assert.equal(summary.anySameTier, true);
  assert.equal(summary.sceneSearchDelta, 1);
  assert.equal(summary.craftGeneDelta, -1);
  assert.equal(summary.referenceAdjustedSceneSearchDelta, 1);
  assert.equal(summary.referenceAdjustedCraftGeneDelta, -1);
  assert.equal(summary.decision, "scene_search_positive_craft_genes_negative");
});

test("ceiling summary does not mistake judge reference drift for strategy gain", () => {
  const verdict = (candidateLevel, referenceLevel) => ({
    dimensions: Array.from({ length: 8 }, (_, index) => ({
      id: `d${index}`,
      candidate_level: candidateLevel,
      reference_level: referenceLevel,
    })),
    overall_candidate_level: candidateLevel,
    overall_reference_level: referenceLevel,
    tier_relationship: "same_tier",
    needs_human_review: false,
  });
  const summary = summarizeCeilingPilot({
    A: verdict(3, 3),
    B: verdict(4, 4),
    C: verdict(4, 4),
  });

  assert.equal(summary.sceneSearchDelta, 1);
  assert.equal(summary.referenceAdjustedSceneSearchDelta, 0);
  assert.equal(summary.decision, "scene_search_no_positive_evidence");
});

test("ceiling structured requests allow exactly one repair and preserve both responses", async () => {
  let requestCalls = 0;
  let repairCalls = 0;
  const result = await runBoundedJsonRequest({
    request: async () => {
      requestCalls += 1;
      return '{"cards":["unescaped "quote""]}';
    },
    repair: async () => {
      repairCalls += 1;
      return '{"cards":["repaired quote"]}';
    },
  });
  assert.deepEqual(result.value, { cards: ["repaired quote"] });
  assert.equal(result.retryCount, 1);
  assert.equal(result.responses.length, 2);
  assert.equal(requestCalls, 1);
  assert.equal(repairCalls, 1);
});

test("ceiling structured requests hard-fail after the single repair", async () => {
  let calls = 0;
  await assert.rejects(() => runBoundedJsonRequest({
    request: async () => {
      calls += 1;
      return "not-json";
    },
    repair: async () => {
      calls += 1;
      return "still-not-json";
    },
  }), /invalid_json_after_bounded_repair/);
  assert.equal(calls, 2);
});

test("ceiling structured requests include semantic schema parsing in the bounded repair", async () => {
  const result = await runBoundedJsonRequest({
    request: async () => '{"方案列表":[{}]}',
    repair: async (feedback) => {
      assert.match(feedback, /missing 编号/);
      return '{"方案列表":[{"编号":"scene-1"}]}';
    },
    parse: (raw) => {
      const value = JSON.parse(raw);
      const id = value.方案列表?.[0]?.编号;
      if (!id) throw new Error("missing 编号");
      return id;
    },
  });
  assert.equal(result.value, "scene-1");
  assert.equal(result.retryCount, 1);
});

test("ceiling scene search maps a stable Chinese JSON schema to internal card keys", () => {
  const cards = normalizeChineseSceneSolutionPayload({
    方案列表: [{
      编号: "scene-1",
      模式: "主动试探",
      表层目标: "确认通讯器来电目的",
      真实危险: "任务邀请掩盖了信息差",
      已知事实: ["主角收到紧急来电"],
      未知事项: ["对方真正目的"],
      主动试探: "主角要求对方先说出只有内部人员知道的验证信息",
      替代方案: ["立即接受", "延后并核验"],
      选择: "延后并核验",
      代价: "失去最佳行动窗口",
      新规则或信息: "来电者只能掌握公开行程，无法回答内部验证问题",
      不可逆变化: "主角确认队伍内部存在泄漏",
      状态类型: "认知",
      章末因果压力: "泄漏者会在下一次联络前修改计划",
      因果来源: "主角主动核验暴露了警觉",
      下一步选择: "追查内部泄漏或按原计划行动",
      避免模板: ["不用心跳冷汗代替证据"],
    }],
  });
  assert.equal(cards[0].mode, "active_probe");
  assert.equal(cards[0].stateKind, "knowledge");
  assert.deepEqual(cards[0].sourceFactIds, []);
  assert.deepEqual(cards[0].openPromiseIds, []);
  assert.match(cards[0].activeTestAction, /验证信息/);
});

test("ceiling scene search assigns deterministic local IDs when model metadata is absent", () => {
  const [card] = normalizeChineseSceneSolutionPayload({
    方案列表: [{
      模式: "主动试探",
      表层目标: "核验来电",
      真实危险: "信息泄漏",
      已知事实: ["收到来电"],
      未知事项: ["来电者身份"],
      主动试探: "要求内部口令",
      替代方案: ["接受", "拒绝"],
      选择: "先核验",
      代价: "错过窗口",
      新规则或信息: "对方不知道口令",
      不可逆变化: "确认存在泄漏",
      状态类型: "认知",
      章末因果压力: "泄漏者即将改换渠道",
      因果来源: "核验暴露警觉",
      下一步选择: "追查或行动",
      避免模板: ["不用生理反应代替证据"],
    }],
  });
  assert.equal(card.id, "scene-1");
});

test("ceiling scene search normalizes a bounded list of concrete costs", () => {
  const [card] = normalizeChineseSceneSolutionPayload({
    方案列表: [{
      编号: "scene-cost-list",
      模式: "主动试探",
      表层目标: "核验来电",
      真实危险: "信息泄漏",
      已知事实: ["收到来电"],
      未知事项: ["来电者身份"],
      主动试探: "要求内部口令",
      替代方案: ["接受", "拒绝"],
      选择: "先核验",
      代价: ["错过窗口", "暴露警觉"],
      新规则或信息: "对方不知道口令",
      不可逆变化: "确认存在泄漏",
      状态类型: "认知",
      章末因果压力: "泄漏者即将改换渠道",
      因果来源: "核验暴露警觉",
      下一步选择: "追查或行动",
      避免模板: ["不用生理反应代替证据"],
    }],
  });
  assert.equal(card.cost, "错过窗口；暴露警觉");
});

test("ceiling scene search accepts a bounded A/B alternative map", () => {
  const [card] = normalizeChineseSceneSolutionPayload({
    方案列表: [{
      编号: "scene-alternative-map",
      模式: "证据调查",
      表层目标: "确认失踪者路线",
      真实危险: "调查会暴露追踪者",
      已知事实: ["路线记录缺一段"],
      未知事项: ["缺失由谁造成"],
      主动试探: "投放一条只有内部联系人可见的假路线",
      替代方案: { A: "立即追查缺口", B: "先用假路线验证泄漏" },
      选择: "先验证泄漏",
      代价: "真正线索可能过期",
      新规则或信息: "假路线被外部人员使用",
      不可逆变化: "确认内部渠道泄漏",
      状态类型: "认知",
      章末因果压力: "泄漏者会清理痕迹",
      因果来源: "假路线触发了对方行动",
      下一步选择: "抓泄漏者或追真正线索",
      避免模板: ["不用黑影代替调查证据"],
    }],
  });
  assert.deepEqual(card.alternatives, ["A：立即追查缺口", "B：先用假路线验证泄漏"]);
});

test("ceiling scene search accepts only preregistered Chinese field aliases", () => {
  const [card] = normalizeChineseSceneSolutionPayload({
    方案列表: [{
      模式: "主动试探",
      目标: "核验来电",
      真正危险: "信息泄漏",
      已知信息: ["收到来电"],
      未知信息: ["来电者身份"],
      主动试探动作: "要求内部口令",
      可选方案: ["接受", "拒绝"],
      最终选择: "先核验",
      选择代价: "错过窗口",
      信息增量: "对方不知道口令",
      场景不可逆变化: "确认存在泄漏",
      状态类型: "认知",
      结尾因果压力: "泄漏者即将改换渠道",
      压力因果来源: "核验暴露警觉",
      下章选择: "追查或行动",
      模板规避: ["不用生理反应代替证据"],
    }],
  });
  assert.equal(card.cost, "错过窗口");
  assert.equal(card.newRuleOrInformation, "对方不知道口令");
  assert.equal(card.endingPressure, "泄漏者即将改换渠道");
});

test("ceiling scene search normalizes numbered IDs and explicit branch maps without inventing content", () => {
  const [card] = normalizeChineseSceneSolutionPayload({
    方案列表: [{
      编号: 1,
      模式: "证据调查",
      表层目标: "调查物证",
      真实危险: "调查会暴露位置",
      已知事实: ["已有鳞片"],
      未知事项: ["鳞片来源"],
      主动试探: "沿水痕逆向取样",
      替代方案: ["撤离", "远程求助"],
      选择: { "方案甲": "独自侦查", "方案乙": "立即撤离" },
      代价: { "选甲": "暴露感知能力", "选乙": "丢失窗口" },
      新规则或信息: "封控边界分级",
      不可逆变化: ["样本留下精神烙印", "通讯记录已生成"],
      状态类型: ["认知", "危险"],
      章末因果压力: "林中出现响应",
      因果来源: "主动取样触发异常",
      下一步选择: ["继续追查", "立即撤离"],
      避免模板: "不用模糊力量描述",
    }],
  });
  assert.equal(card.id, "scene-1");
  assert.match(card.choice, /方案甲.*独自侦查/);
  assert.match(card.cost, /选甲.*暴露感知能力/);
  assert.equal(card.stateKind, "knowledge");
  assert.deepEqual(card.templateAvoidance, ["不用模糊力量描述"]);
  assert.match(card.irreversibleChange, /样本留下精神烙印.*通讯记录已生成/);
});
