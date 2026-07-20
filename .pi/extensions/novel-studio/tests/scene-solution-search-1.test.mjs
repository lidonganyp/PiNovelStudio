/** SCENE-SOLUTION-SEARCH-1 offline contract tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderSceneSolutionPrompt,
  searchSceneSolutions,
  validateSceneSolutionCard,
} from "../dist-test/v2/core/scene-solution-search.js";
import { buildRawPrompt } from "../dist/v2/core/orchestrator-raw.js";

function card(overrides = {}) {
  return {
    id: "solution-1",
    mode: "active_probe",
    surfaceGoal: "确认门内异常是否会响应光线",
    trueDanger: "异常会利用错误判断改变出口位置",
    knownFacts: ["door-rule"],
    unknowns: ["response-window"],
    activeTestAction: "主角把手电固定在门缝，观察光线变化是否先于声音出现",
    alternatives: ["先开门", "先记录变化"],
    choice: "先记录变化，再用钥匙验证门锁",
    cost: "错过一次安全窗口，同行者会失去对他的信任",
    newRuleOrInformation: "光线变化会提前三秒改变门锁状态",
    irreversibleChange: "主角掌握了门锁规则，但同行者不再愿意替他保管钥匙",
    stateKind: "knowledge",
    endingPressure: "钥匙已经插入锁孔，下一次变化会锁死出口",
    causalSource: "手电测试引发门锁提前变化",
    nextChoice: "必须决定开门还是放弃钥匙",
    templateAvoidance: ["不用身体反应代替证据", "不用空降黑影收尾"],
    sourceFactIds: ["door-rule"],
    openPromiseIds: [],
    ...overrides,
  };
}

test("SCENE-SOLUTION-SEARCH-1 合法方案卡只渲染退休实验元数据", () => {
  const value = card();
  assert.deepEqual(validateSceneSolutionCard(value, { existingFactIds: ["door-rule"], openPromiseIds: [] }), { valid: true, errors: [] });
  const prompt = renderSceneSolutionPrompt(value);
  assert.match(prompt, /不得注入生产 raw/);
  assert.match(prompt, /door-rule/);
  assert.doesNotMatch(prompt, /主动试探|不可逆状态变化|选择代价/);
});

test("SCENE-SOLUTION-SEARCH-1 只拒绝未知事实引用，不机械要求代价或替代方案", () => {
  const result = validateSceneSolutionCard(card({ cost: "无", sourceFactIds: ["hallucinated"] }), { existingFactIds: ["door-rule"], openPromiseIds: [] });
  assert.equal(result.valid, false);
  assert.equal(result.errors.includes("choice_requires_cost"), false);
  assert.ok(result.errors.includes("unknown:sourceFactId"));
});

test("SCENE-SOLUTION-SEARCH-1 多解法缺少本章选择权威时安全回退 raw", () => {
  const result = searchSceneSolutions({
    sceneId: "scene-1",
    existingFactIds: ["door-rule"],
    openPromiseIds: [],
    cards: [card({ id: "a" }), card({ id: "b", mode: "active_probe" })],
  });
  assert.equal(result.status, "fallback_raw");
  assert.equal(result.selected, null);
  assert.equal(result.fallbackReason, "multiple_solutions_require_chapter_specific_selection");
});

test("SCENE-SOLUTION-SEARCH-1 不按固定模式顺序从多个候选中取第一张", () => {
  const result = searchSceneSolutions({
    sceneId: "scene-1",
    existingFactIds: ["door-rule"],
    openPromiseIds: [],
    cards: [
      card({ id: "a", mode: "evidence_investigation" }),
      card({ id: "b", mode: "active_probe" }),
      card({ id: "c", mode: "relationship_cost" }),
      card({ id: "d", mode: "evidence_investigation" }),
    ],
    maxCards: 3,
  });
  assert.equal(result.status, "fallback_raw");
  assert.equal(result.candidates.length, 3);
  assert.equal(result.selected, null);
  assert.equal(result.fallbackReason, "multiple_solutions_require_chapter_specific_selection");
});

test("SCENE-SOLUTION-SEARCH-1 方案卡不接入 raw prompt", () => {
  const value = card();
  const input = {
    chapterNumber: 1,
    projectRoot: ".",
    workspaceId: "w",
    chapterId: "ch1",
    intent: { chapterFunction: "推进", readerExperience: [], currentPressure: [], meaningfulChoices: [], promisesToAdvance: [], possibleEndPressure: [], relevantCharacters: [], inviolableFacts: [], sourceRefs: [] },
    context: { facts: [], characterStates: [], openLoops: [], worldRules: [], styleReferences: [], sourceMap: [] },
    constitution: null,
    characterNames: [],
    modelGenerate: async () => ({ text: "", model: "stub", route: "stub", durationMs: 0 }),
    sceneSolution: value,
  };
  const withCard = buildRawPrompt(input);
  const withoutCard = buildRawPrompt({ ...input, sceneSolution: undefined });
  assert.equal(withCard.consumedFields.includes("sceneSolution"), false);
  assert.equal(withCard.userPrompt, withoutCard.userPrompt);
  assert.equal(withoutCard.consumedFields.includes("sceneSolution"), false);
});
