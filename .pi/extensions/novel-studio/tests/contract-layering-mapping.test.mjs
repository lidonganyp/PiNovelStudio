/**
 * CONTRACT-LAYERING-MAPPING: 四层映射修正验证
 *
 * 修正内容（CONTRACT-LAYERING-ABLATION-1）：
 * 1. eventSummaries / mustInclude / stateChanges / foreshadowing / causalRelations
 *    从层3（表达决策）移到层2（章节义务）——它们是作者明确要求必须包含的结构性义务，
 *    不是模型可自由决定的表达方式。
 * 2. 层3和层4顺序调换：新层3=历史证据（原层4），新层4=表达决策（原层3去掉已移走字段）。
 *    权威性递减：硬事实 > 章节义务 > 历史证据 > 表达决策。
 *
 * 验收口径：
 * - eventSummaries/mustInclude/stateChanges/foreshadowing/causalRelations 出现在层2区块
 * - historicalContinuity/historicalCharacterState/recentPatternMemory 出现在层3区块
 * - currentPressure/characterMotivations 等创作指引出现在层4区块
 * - 层顺序：层1硬约束 → 层2叙事目标 → 层3历史证据 → 层4模型决策空间
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderLayeredContract } from "../dist/v2/core/model-prompt-adapter.js";

/** 构造包含所有字段的 ChapterContract */
function makeFullContract() {
  return {
    workIdentity: ["都市异能调查"],
    readerPromises: ["每次验证带来新规则"],
    genrePromises: ["恐惧来自可验证的规则"],
    protagonistCoreConflict: ["信任与验证的矛盾"],
    thematicQuestions: ["记忆能否证明身份"],
    forbiddenDrift: ["不把异常写成无规则幻觉"],
    overallPlotDirection: ["调查指向记忆伪造者"],
    chapterFunction: ["逼迫林默验证门后异常"],
    readerExperience: ["紧张", "好奇"],
    currentPressure: ["走廊脚步声接近"],
    previousState: ["林默听见门后声音"],
    relevantCharacters: ["林默", "许岚"],
    relevantCharacterStates: ["林默保持怀疑"],
    historicalContinuity: ["上一章林默在旧仓库发现假钥匙"],
    historicalCharacterState: ["许岚上次出现时情绪正常"],
    recentPatternMemory: ["近三章每章都有一次验证"],
    characterMotivations: ["林默想确认许岚可信"],
    focusCharacterGoals: ["林默要确认门后身份"],
    resistance: ["声音会利用记忆误导"],
    choicesAndCosts: ["敲门试探代价是暴露识破"],
    expectedIrreversibleChange: ["林默失去伪装机会"],
    selectedPromisesToAdvance: ["许岚失踪与旧案有关"],
    selectedExpectationsToAdvance: ["确认门后身份"],
    causalEndPressure: ["声音说出只有许岚知道的秘密"],
    eventSummaries: ["林默依据门锁确认门后声音在模仿许岚"],
    mustInclude: ["安全门从内部反锁"],
    stateChanges: ["林默从怀疑转为确认模仿者存在"],
    foreshadowing: ["许岚失踪与旧案有关"],
    causalRelations: ["门锁事实与错误记忆共同暴露模仿者"],
    endingTarget: ["真正的许岚从楼梯口出现"],
    inviolableFacts: ["林默不知道门后人身份"],
    stateConstraints: ["许岚不知道林默昨夜见过谁"],
    wordCountTarget: { min: 2000, max: 3000 },
    forbidReferenceLeakage: true,
    preserveEstablishedState: true,
  };
}

/** 按"【层 N"分割渲染结果，返回每层的文本块 */
function splitByLayer(rendered) {
  const parts = rendered.split(/(?=【层 \d)/);
  const layers = {};
  for (const part of parts) {
    const match = part.match(/【层 (\d)/);
    if (match) {
      layers[match[1]] = part;
    }
  }
  return layers;
}

describe("CONTRACT-LAYERING-MAPPING 四层映射修正", () => {
  const rendered = renderLayeredContract(makeFullContract());
  const layers = splitByLayer(rendered);

  test("层2（叙事目标/章节义务）包含 eventSummaries", () => {
    assert.ok(layers["2"], "层2应存在");
    assert.match(layers["2"], /林默依据门锁确认门后声音在模仿许岚/);
  });

  test("层2包含 mustInclude", () => {
    assert.ok(layers["2"]);
    assert.match(layers["2"], /安全门从内部反锁/);
  });

  test("层2包含 stateChanges", () => {
    assert.ok(layers["2"]);
    assert.match(layers["2"], /林默从怀疑转为确认模仿者存在/);
  });

  test("层2包含 foreshadowing", () => {
    assert.ok(layers["2"]);
    assert.match(layers["2"], /许岚失踪与旧案有关/);
  });

  test("层2包含 causalRelations", () => {
    assert.ok(layers["2"]);
    assert.match(layers["2"], /门锁事实与错误记忆共同暴露模仿者/);
  });

  test("层3是历史证据，包含 historicalContinuity", () => {
    assert.ok(layers["3"], "层3应存在");
    assert.match(layers["3"], /上一章林默在旧仓库发现假钥匙/);
    assert.match(layers["3"], /历史证据|历史连续性/);
  });

  test("层3包含 historicalCharacterState", () => {
    assert.ok(layers["3"]);
    assert.match(layers["3"], /许岚上次出现时情绪正常/);
  });

  test("层3包含 recentPatternMemory", () => {
    assert.ok(layers["3"]);
    assert.match(layers["3"], /近三章每章都有一次验证/);
  });

  test("层4是模型决策空间（表达决策），包含 currentPressure", () => {
    assert.ok(layers["4"], "层4应存在");
    assert.match(layers["4"], /走廊脚步声接近/);
    assert.match(layers["4"], /模型决策空间|创作指引|表达/);
  });

  test("层4包含 characterMotivations", () => {
    assert.ok(layers["4"]);
    assert.match(layers["4"], /林默想确认许岚可信/);
  });

  test("eventSummaries 不出现在层4（表达决策）中", () => {
    assert.ok(layers["4"]);
    assert.doesNotMatch(layers["4"], /林默依据门锁确认门后声音在模仿许岚/);
  });

  test("historicalContinuity 不出现在层4中", () => {
    assert.ok(layers["4"]);
    assert.doesNotMatch(layers["4"], /上一章林默在旧仓库发现假钥匙/);
  });

  test("currentPressure 不出现在层3（历史证据）中", () => {
    assert.ok(layers["3"]);
    assert.doesNotMatch(layers["3"], /走廊脚步声接近/);
  });

  test("层顺序为：层1硬约束 → 层2叙事目标 → 层3历史证据 → 层4模型决策空间", () => {
    const layerOrder = rendered
      .match(/【层 \d[^】]*】/g)
      ?.map((s) => s.replace(/【层 (\d)[^】]*】/, "$1"));
    assert.deepEqual(layerOrder, ["1", "2", "3", "4"]);
    // 层3标题含"历史证据"，层4标题含"模型决策"或"表达"
    assert.match(layers["3"], /历史证据/);
    assert.match(layers["4"], /模型决策|表达决策|创作指引/);
  });
});
