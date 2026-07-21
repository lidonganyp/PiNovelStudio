/** Post-raw methodology diagnosis and Gemini editorial generation integration. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEditorialCandidateGenerator } from "../dist/v2/core/editorial-candidate-generator.js";
import {
  buildOpportunityPrompt,
  parseOpportunityVerdict,
} from "../dist/v2/core/editorial-opportunity-contract.js";
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

test("parseable objects must satisfy the complete opportunity verdict schema", () => {
  assert.equal(parseOpportunityVerdict(JSON.stringify({ foo: 1 })), null);
  assert.equal(parseOpportunityVerdict(JSON.stringify({
    craftPhenomena: [],
    opportunities: [{
      opportunityType: "reader_payoff",
      craftDomain: "chapter_progression",
      diagnosis: "正文问题",
      evidenceExcerpt: "原文",
      expectedReaderGain: "读者收益",
    }],
    noOpReason: null,
  })), null);
});

test("parseable schema-invalid output triggers exactly one schema-only repair", async () => {
  const calls = [];
  const result = await createEditorialOpportunityJudge().judge({
    rawText: RAW,
    rawCandidateId: "candidate:raw:17",
    intent: makeIntent(),
    context: makeContext(),
    longTermState: null,
    constitution: null,
    characterNames: ["林默", "许岚"],
    modelGenerate: async (input) => {
      calls.push(input);
      return {
        text: calls.length === 1
          ? JSON.stringify({ foo: 1 })
          : JSON.stringify({
            craftPhenomena: [],
            opportunities: [],
            noOpReason: "没有可引用正文证明的高价值编辑机会",
          }),
        model: "judge",
        route: input.route,
        durationMs: 1,
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.schemaRepairAttempts, 1);
  assert.equal(result.llmJudged, true);
  assert.equal(result.hypotheses.length, 0);
});

test("an immediate opportunity model failure records zero schema repair attempts", async () => {
  const result = await createEditorialOpportunityJudge().judge({
    rawText: RAW,
    rawCandidateId: "candidate:raw:17",
    intent: makeIntent(),
    context: makeContext(),
    longTermState: null,
    constitution: null,
    characterNames: ["林默", "许岚"],
    modelGenerate: async () => {
      throw new Error("model unavailable");
    },
  });

  assert.equal(result.llmJudged, false);
  assert.equal(result.schemaRepairAttempts, 0);
});

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

test("strict opportunity schema rejects missing methodology fields and contradictory no-op reasons", () => {
  const missingCraftPhenomena = JSON.stringify({
    opportunities: [],
    noOpReason: "没有机会",
  });
  const contradictoryReason = JSON.stringify({
    craftPhenomena: [],
    opportunities: [{
      opportunityType: "relationship_progress",
      craftDomain: "dialogue",
      diagnosis: "关系变化未被承担",
      evidenceExcerpt: "她把沾血的钥匙推到他面前",
      expectedReaderGain: "让关系变化更清楚",
      damageRisks: ["可能损伤留白"],
      confidence: 0.7,
    }],
    noOpReason: "同时又声称没有机会",
  });
  const crossChapterOpportunityWithoutState = JSON.stringify({
    craftPhenomena: [],
    opportunities: [{
      opportunityType: "promise_advancement",
      craftDomain: "cross_chapter_health",
      diagnosis: "承诺可能再次延期",
      evidenceExcerpt: "你看见门里的人了吗",
      expectedReaderGain: "恢复跨章承诺可信度",
      damageRisks: ["可能过早解释"],
      confidence: 0.65,
    }],
    noOpReason: null,
  });

  assert.equal(parseOpportunityVerdict(missingCraftPhenomena), null);
  assert.equal(parseOpportunityVerdict(contradictoryReason), null);
  assert.equal(parseOpportunityVerdict(crossChapterOpportunityWithoutState), null);
});

test("cross-chapter diagnosis keeps validated state references and exposes state only to the judge", async () => {
  const sourceRef = "narrative-state-store.json#expectation:door";
  let judgePrompt = "";
  const result = await createEditorialOpportunityJudge().judge({
    rawText: RAW,
    rawCandidateId: "candidate:raw:17",
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林默", "许岚"],
    methodologyDiagnosticState: {
      schemaVersion: "methodology-diagnostic-state-v1",
      chapterNumber: 17,
      advisoryOnly: true,
      canEnterRawPrompt: false,
      canDirectlyAuthorizeCandidate: false,
      sources: [],
      declaredGenre: { status: "unavailable", genre: null, subGenres: [], sourceRefs: [], emptyReason: "test" },
      serialState: {
        status: "available",
        expectations: [{
          expectationId: "door",
          description: "门后的身份何时揭晓",
          status: "delayed",
          targetReaderExperience: null,
          delayReason: null,
          sourceChapter: "ch3",
          sourceRefs: [sourceRef],
        }],
        promises: [],
        patterns: [],
        fatigue: {
          recentPatterns: [], consecutiveSameType: null, recentHookTypes: [], recentSceneTypes: [],
          recentEmotionPeaks: [], cooldownPeriods: {}, horrorTechniques: [],
          consecutiveSameHorrorTechnique: null, unresolvedExpectationCount: 1,
          chaptersSinceLastPeak: null, lastPayoffChapter: null, sourceRefs: [sourceRef],
        },
        sourceRefs: [sourceRef],
        emptyReason: null,
      },
      worldRevelation: { status: "unavailable", items: [], sourceRefs: [], emptyReason: "test" },
      ensemble: { status: "unavailable", relationships: [], focusHistory: [], sourceRefs: [], emptyReason: "test" },
      closure: { status: "unavailable", openArcs: [], pendingForeshadows: [], sourceRefs: [], emptyReason: "test" },
    },
    modelGenerate: async (input) => {
      if (!judgePrompt) judgePrompt = input.userPrompt;
      return {
        text: JSON.stringify({
          craftPhenomena: [{
            domain: "cross_chapter_health",
            status: "uncertain",
            phenomenon: "门后身份可能再次延期",
            evidenceExcerpt: "你看见门里的人了吗",
            contextEvidenceRefs: [sourceRef],
            readerImpact: "连续延期可能削弱承诺可信度",
            confidence: 0.62,
          }],
          opportunities: [],
          noOpReason: "证据只足以人工复核，不生成候选",
        }),
        model: "judge",
        route: input.route,
        durationMs: 1,
      };
    },
  });

  assert.match(judgePrompt, /methodology-diagnostic-state-v1/);
  assert.deepEqual(result.craftPhenomenonReport.observations[0].contextEvidenceRefs, [sourceRef]);
  assert.equal(result.hypotheses.length, 0);
});

test("opportunity prompt preserves derived methodology alerts when state details exceed the budget", () => {
  const marker = "必须保留的派生逾期警报";
  const methodologyDiagnosticState = {
    schemaVersion: "methodology-diagnostic-state-v1",
    chapterNumber: 17,
    advisoryOnly: true,
    canEnterRawPrompt: false,
    canDirectlyAuthorizeCandidate: false,
    sources: [],
    declaredGenre: {
      status: "available",
      genre: "都市悬疑",
      subGenres: [],
      sourceRefs: ["config.json#genre"],
      emptyReason: null,
    },
    serialState: {
      status: "available",
      expectations: [{
        expectationId: "large-history",
        description: "历史细节".repeat(5000),
        status: "open",
        targetReaderExperience: null,
        delayReason: null,
        sourceChapter: "ch1",
        sourceRefs: ["narrative-state-store.json#expectation:large-history"],
      }],
      promises: [],
      patterns: [],
      fatigue: {
        recentPatterns: [],
        consecutiveSameType: null,
        recentHookTypes: [],
        recentSceneTypes: [],
        recentEmotionPeaks: [],
        cooldownPeriods: {},
        horrorTechniques: [],
        consecutiveSameHorrorTechnique: null,
        unresolvedExpectationCount: 1,
        chaptersSinceLastPeak: 4,
        lastPayoffChapter: 12,
        severity: "moderate",
        severitySignals: ["consecutiveSameType:2"],
        sourceRefs: ["series/narrative-state.json#readerExpectation"],
      },
      overdueAlerts: [{
        itemId: marker,
        itemType: "expectation",
        severity: "yellow",
        description: marker,
        expectedLatest: null,
        chaptersOverdue: null,
        sourceRef: "narrative-state-store.json#expectation:large-history",
      }],
      stagnation: {
        detected: true,
        chaptersSinceLastPeak: 4,
        stagnantArcIds: [],
        sourceRefs: ["series/narrative-state.json#readerExpectation.chaptersSinceLastPeak"],
        emptyReason: null,
      },
      sourceRefs: ["narrative-state-store.json#expectation:large-history"],
      emptyReason: null,
    },
    worldRevelation: { status: "unavailable", items: [], sourceRefs: [], emptyReason: "test" },
    ensemble: {
      status: "unavailable",
      relationships: [],
      focusHistory: [],
      climaxOpportunity: {
        detected: false,
        convergentArcs: [],
        criticalRelationships: [],
        convergentExpectations: [],
        estimatedWindow: null,
        sourceRefs: [],
        emptyReason: "test",
      },
      sourceRefs: [],
      emptyReason: "test",
    },
    closure: { status: "unavailable", openArcs: [], pendingForeshadows: [], sourceRefs: [], emptyReason: "test" },
  };

  const { userPrompt } = buildOpportunityPrompt({
    rawText: RAW,
    intent: makeIntent(),
    scannedSignals: [],
    methodologyDiagnosticState,
  });

  assert.match(userPrompt, new RegExp(marker));
});
