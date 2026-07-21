/** Opportunity judge schema drift recovery and diagnostics regression tests. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseOpportunityVerdict,
} from "../dist/v2/core/editorial-opportunity-contract.js";
import {
  createEditorialOpportunityJudge,
} from "../dist/v2/core/editorial-opportunity-judge.js";

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
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林默", "许岚"],
    inviolableFacts: ["许岚没有进入门内"],
    sourceRefs: ["test"],
  };
}

test("安全 no-op 输出省略纯诊断数组时仍可归一化解析", () => {
  const parsed = parseOpportunityVerdict(JSON.stringify({
    opportunities: [],
    noOpReason: "原始正文已经完成本章任务，没有足够收益生成候选",
  }));

  assert.ok(parsed);
  assert.deepEqual(parsed.craftObservations, []);
  assert.deepEqual(parsed.opportunities, []);
  assert.match(parsed.noOpReason, /没有足够收益/);
});

test("有完整 span 机会时允许省略纯诊断数组和空 no-op 字段", () => {
  const parsed = parseOpportunityVerdict(JSON.stringify({
    opportunities: [{
      opportunityType: "relationship_progress",
      craftDomain: "dialogue",
      diagnosis: "钥匙交付后的关系变化尚未被双方承担",
      evidenceExcerpt: "她把沾血的钥匙推到他面前",
      expectedReaderGain: "让沉默和交付钥匙真正改变双方关系",
      damageRisks: ["可能解释过度，损伤留白"],
      confidence: 0.72,
    }],
  }));

  assert.ok(parsed);
  assert.equal(parsed.opportunities.length, 1);
  assert.deepEqual(parsed.craftObservations, []);
  assert.equal(parsed.noOpReason, null);
});

test("schema 修复耗尽时记录具体解析原因而不是静默降级", async () => {
  let calls = 0;
  const result = await createEditorialOpportunityJudge().judge({
    rawText: RAW,
    rawCandidateId: "candidate:raw:17",
    intent: makeIntent(),
    longTermState: null,
    constitution: null,
    characterNames: ["林默", "许岚"],
    modelGenerate: async (input) => {
      calls += 1;
      return {
        text: calls === 1
          ? JSON.stringify({ foo: 1 })
          : JSON.stringify({ craftPhenomena: [], noOpReason: "没有机会" }),
        model: "judge",
        route: input.route,
        durationMs: 1,
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.llmJudged, false);
  assert.equal(result.schemaRepairAttempts, 1);
  assert.match(result.llmFallbackReason ?? "", /missing_opportunities/);
  assert.match(result.llmFallbackReason ?? "", /输出长度=\d+/);
});
