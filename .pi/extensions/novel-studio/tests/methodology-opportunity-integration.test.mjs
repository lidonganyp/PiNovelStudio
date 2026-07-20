/** Post-raw methodology diagnosis and Gemini editorial generation integration. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEditorialCandidateGenerator } from "../dist/v2/core/editorial-candidate-generator.js";
import { createEditorialOpportunityJudge } from "../dist/v2/core/editorial-opportunity-judge.js";
import { createEditorialStrategyRegistry } from "../dist/v2/core/editorial-strategy-registry.js";

const RAW = [
  "林默问：你看见门里的人了吗？",
  "许岚没有回答。她把沾血的钥匙推到他面前。",
  "林默拿起钥匙，门后随即响起了第二个许岚的声音。",
].join("\n");

function makeIntent() {
  return {
    chapterFunction: "验证门后异常并改变双方的信息位置",
    readerExperience: ["紧张", "认知变化"],
    currentPressure: ["门后的模仿者正在监听"],
    meaningfulChoices: ["林默决定用钥匙试探门后的声音"],
    promisesToAdvance: ["门后的声音是否能读取记忆"],
    possibleEndPressure: ["第二个许岚的声音出现"],
    relevantCharacters: ["林默", "许岚"],
    inviolableFacts: ["许岚没有进入门内"],
    sourceRefs: ["test"],
  };
}

function makeContext() {
  return {
    facts: [{ id: "fact-1", content: "许岚没有进入门内", sourceIds: ["chapter-16"], kind: "fact" }],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
    bridgeContext: null,
  };
}

test("schema repair preserves diagnosis and produces a span-backed methodology report", async () => {
  const calls = [];
  const modelGenerate = async (input) => {
    calls.push(input);
    if (calls.length === 1) {
      return { text: "不是 JSON", model: "judge", route: input.route, durationMs: 1 };
    }
    return {
      text: JSON.stringify({
        craftPhenomena: [{
          domain: "对话工艺",
          status: "已观察",
          phenomenon: "动作回应改变了信息和权力位置",
          evidenceExcerpt: "她把沾血的钥匙推到他面前",
          readerImpact: "对话成为事件，而不是平直问答",
          confidence: 0.88,
        }],
        opportunities: [{
          opportunityType: "relationship_progress",
          craftDomain: "对话工艺",
          diagnosis: "钥匙动作之后的关系变化还可以更清楚地被人物承担",
          evidenceExcerpt: "她把沾血的钥匙推到他面前",
          expectedReaderGain: "让沉默和交付钥匙真正改变双方关系",
          damageRisks: ["可能解释过度，损伤留白"],
          confidence: 0.72,
        }],
        noOpReason: null,
      }),
      model: "judge",
      route: input.route,
      durationMs: 1,
    };
  };

  const result = await createEditorialOpportunityJudge().judge({
    rawText: RAW,
    rawCandidateId: "candidate:raw:17",
    intent: makeIntent(),
    context: makeContext(),
    longTermState: null,
    constitution: null,
    characterNames: ["林默", "许岚"],
    modelGenerate,
  });

  assert.equal(calls.length, 2);
  assert.equal(result.schemaRepairAttempts, 1);
  assert.equal(result.llmJudged, true);
  assert.equal(result.hypotheses[0].craftDomain, "dialogue");
  assert.equal(result.craftPhenomenonReport.observations.length, 1);
  assert.equal(result.craftPhenomenonReport.observations[0].sourceSpans[0].excerpt, "她把沾血的钥匙推到他面前");
  assert.equal(result.craftPhenomenonReport.canDirectlyRewrite, false);
  assert.match(calls[1].systemPrompt, /修复结构化输出/);
});

test("methodology observations with invented excerpts are rejected without blocking valid opportunities", async () => {
  const result = await createEditorialOpportunityJudge().judge({
    rawText: RAW,
    rawCandidateId: "candidate:raw:17",
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林默", "许岚"],
    modelGenerate: async (input) => ({
      text: JSON.stringify({
        craftPhenomena: [{
          domain: "rhythm_and_climax",
          status: "uncertain",
          phenomenon: "可能缺少余震",
          evidenceExcerpt: "原文里不存在的高潮",
          readerImpact: "可能让后果过轻",
          confidence: 0.5,
        }],
        opportunities: [],
        noOpReason: "没有足够证据生成候选",
      }),
      model: "judge",
      route: input.route,
      durationMs: 1,
    }),
  });

  assert.equal(result.hypotheses.length, 0);
  assert.equal(result.craftPhenomenonReport.observations.length, 0);
  assert.match(result.craftPhenomenonReport.rejectedObservations[0].reason, /原文中定位失败/);
});

test("ordinary editorial generation sends Gemini profiles to the Gemini route", async () => {
  let requestedRoute = null;
  const excerpt = "她把沾血的钥匙推到他面前";
  const start = RAW.indexOf(excerpt);
  const result = await createEditorialCandidateGenerator().generate({
    rawText: RAW,
    rawCandidateId: "candidate:raw:17",
    hypotheses: [{
      id: "hypothesis:dialogue",
      opportunityType: "relationship_progress",
      craftDomain: "dialogue",
      diagnosis: "动作后的关系变化未被人物承担",
      evidenceSpans: [{ start, end: start + excerpt.length, excerpt }],
      expectedReaderGain: "让关系变化更清楚",
      damageRisks: ["可能损伤留白"],
      rewriteScope: "event_candidate",
      confidence: 0.7,
    }],
    intent: makeIntent(),
    context: makeContext(),
    contextHash: "context-17",
    chapterNumber: 17,
    writerPromptProfile: "gemini_writer_v2",
    strategyRegistry: createEditorialStrategyRegistry(),
    modelGenerate: async (input) => {
      requestedRoute = input.route;
      return { text: RAW, model: "gemini-3.1-pro-preview", route: input.route, durationMs: 1 };
    },
  });

  assert.equal(requestedRoute, "v2_amplified_gemini31");
  assert.equal(result.candidates.length, 1);
});
