/** Narrative focus and spatial staging remain span-backed, candidate-only methodology. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCraftPhenomenonReport,
  CRAFT_PHENOMENON_DOMAINS,
} from "../dist/v2/core/craft-phenomenon-report.js";
import { createEditorialCandidateGenerator } from "../dist/v2/core/editorial-candidate-generator.js";
import {
  buildOpportunityPrompt,
  parseOpportunityVerdict,
} from "../dist/v2/core/editorial-opportunity-contract.js";
import { createEditorialStrategyRegistry } from "../dist/v2/core/editorial-strategy-registry.js";

const RAW = [
  "父子隔着三盘菜相对而坐。",
  "热气一层层升起来，父亲的脸始终藏在后面。",
  "门外的脚步声停住了。",
].join("\n");

function makeIntent() {
  return {
    chapterFunction: "让父子关系发生一次可感知的变化",
    readerExperience: ["克制", "关系张力"],
    currentPressure: ["门外有人等待答复"],
    meaningfulChoices: ["儿子决定是否当面追问"],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["父亲", "儿子"],
    inviolableFacts: ["父子仍在同一张餐桌旁"],
    sourceRefs: ["test"],
  };
}

function makeContext() {
  return {
    facts: [{
      id: "fact-1",
      content: "父子仍在同一张餐桌旁",
      sourceIds: ["chapter-4"],
      kind: "fact",
    }],
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

test("post-raw report accepts span-backed narrative focus and spatial staging evidence", () => {
  assert.ok(CRAFT_PHENOMENON_DOMAINS.includes("narrative_focus_and_spatial_staging"));

  const excerpt = "父亲的脸始终藏在后面";
  const report = buildCraftPhenomenonReport({
    rawText: RAW,
    rawCandidateId: "candidate:raw:5",
    observations: [{
      domain: "narrative_focus_and_spatial_staging",
      status: "observed",
      phenomenon: "遮挡关系承载了父子之间尚未说开的隔阂",
      evidenceExcerpt: excerpt,
      readerImpact: "空间关系让沉默具有戏剧含义",
      confidence: 0.82,
    }],
  });

  assert.equal(report.observations.length, 1);
  assert.equal(report.observations[0].sourceSpans[0].excerpt, excerpt);
  assert.equal(report.advisoryOnly, true);
  assert.equal(report.canTriggerEditorialOpportunity, false);
});

test("opportunity contract exposes three candidate-only strategies and parses the spatial strategy", () => {
  const prompt = buildOpportunityPrompt({
    rawText: RAW,
    intent: makeIntent(),
    scannedSignals: [],
    longTermState: null,
    constitution: null,
  });

  assert.match(prompt.systemPrompt, /叙事聚焦与空间调度/);
  assert.match(prompt.systemPrompt, /过渡压缩/);
  assert.match(prompt.systemPrompt, /空间关系调度/);
  assert.match(prompt.systemPrompt, /焦点转移/);
  assert.match(prompt.systemPrompt, /不得使用景别清单|不得要求远景.*特写/s);

  const parsed = parseOpportunityVerdict(JSON.stringify({
    craftPhenomena: [{
      domain: "叙事聚焦与空间调度",
      status: "已观察",
      phenomenon: "餐桌与热气形成关系遮挡",
      evidenceExcerpt: "热气一层层升起来，父亲的脸始终藏在后面",
      readerImpact: "读者能从空间关系感到隔阂",
      confidence: 0.82,
    }],
    opportunities: [{
      opportunityType: "relationship_progress",
      craftDomain: "叙事聚焦与空间调度",
      candidateStrategy: "空间关系调度",
      diagnosis: "人物位置已经呈现隔阂，但关系变化尚未通过空间行动落地",
      evidenceExcerpt: "父子隔着三盘菜相对而坐",
      expectedReaderGain: "让距离和物件承担关系变化",
      damageRisks: ["可能把留白解释得过满"],
      confidence: 0.78,
    }],
    noOpReason: null,
  }));

  assert.ok(parsed);
  assert.equal(parsed.opportunities[0].craftDomain, "narrative_focus_and_spatial_staging");
  assert.equal(parsed.opportunities[0].candidateStrategyId, "spatial_relationship_staging");
});

test("strategy registry selects a requested compatible narrative strategy and rejects incompatible use", () => {
  const registry = createEditorialStrategyRegistry();
  assert.equal(registry.listStrategies().length, 11);

  const base = {
    id: "hypothesis:spatial",
    opportunityType: "relationship_progress",
    craftDomain: "narrative_focus_and_spatial_staging",
    diagnosis: "人物空间关系没有承担关系变化",
    evidenceSpans: [{ start: 0, end: 12, excerpt: "父子隔着三盘菜相对而坐" }],
    expectedReaderGain: "让空间动作承载关系变化",
    damageRisks: ["可能损伤留白"],
    rewriteScope: "event_candidate",
    confidence: 0.75,
  };

  const selected = registry.pickStrategyForHypothesis({
    ...base,
    candidateStrategyId: "spatial_relationship_staging",
  });
  assert.equal(selected?.strategyId, "spatial_relationship_staging");

  const incompatible = registry.pickStrategyForHypothesis({
    ...base,
    candidateStrategyId: "transition_compression",
  });
  assert.equal(incompatible, null);
});

test("editorial candidate receives the selected strategy without a cinematic checklist", async () => {
  let sentPrompt = "";
  const excerpt = "父子隔着三盘菜相对而坐";
  const start = RAW.indexOf(excerpt);
  const result = await createEditorialCandidateGenerator().generate({
    rawText: RAW,
    rawCandidateId: "candidate:raw:5",
    hypotheses: [{
      id: "hypothesis:spatial",
      opportunityType: "relationship_progress",
      craftDomain: "narrative_focus_and_spatial_staging",
      candidateStrategyId: "spatial_relationship_staging",
      diagnosis: "人物位置已经呈现隔阂，但关系变化尚未通过空间行动落地",
      evidenceSpans: [{ start, end: start + excerpt.length, excerpt }],
      expectedReaderGain: "让距离和物件承担关系变化",
      damageRisks: ["不得新增人物或改变既有关系"],
      rewriteScope: "event_candidate",
      confidence: 0.78,
    }],
    intent: makeIntent(),
    context: makeContext(),
    contextHash: "context-5",
    chapterNumber: 5,
    writerPromptProfile: "gemini_writer_v2",
    strategyRegistry: createEditorialStrategyRegistry(),
    modelGenerate: async (input) => {
      sentPrompt = input.userPrompt;
      return {
        text: RAW,
        model: "gemini-3.1-pro-preview",
        route: input.route,
        durationMs: 1,
      };
    },
  });

  assert.equal(result.candidates.length, 1);
  assert.match(result.candidates[0].id, /spatial_relationship_staging/);
  assert.match(sentPrompt, /候选策略：空间关系调度/);
  assert.match(sentPrompt, /距离、遮挡、进出路径或物件位置/);
  assert.doesNotMatch(sentPrompt, /远景.*中景.*特写/s);
  assert.doesNotMatch(sentPrompt, /必须使用.*镜头/);
});

