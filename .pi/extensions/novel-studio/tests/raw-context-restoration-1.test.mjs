/** RAW-CONTEXT-RESTORATION-1: accepted evidence and bounded craft references reach raw. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRawPrompt } from "../dist/v2/core/orchestrator-raw.js";

function makeInput() {
  return {
    workspaceId: "history",
    chapterId: "3",
    chapterNumber: 3,
    projectRoot: process.cwd(),
    intent: {
      chapterFunction: "确认旧钥匙来源",
      readerExperience: ["验证线索后的认知推进"],
      currentPressure: ["门后敲击再次出现"],
      meaningfulChoices: [],
      promisesToAdvance: [],
      possibleEndPressure: [],
      relevantCharacters: ["林川", "许岚"],
      inviolableFacts: [],
      sourceRefs: ["chapter-seed"],
      selectedPromisesToAdvance: [{ promiseId: "F-01", description: "旧钥匙来源" }],
    },
    context: {
      facts: [],
      characterStates: [],
      openLoops: [],
      worldRules: [],
      styleReferences: [],
      sourceMap: [],
      constitution: null,
      longTermState: {
        canon: [{ id: "canon:accepted:2", fact: "第2章接受稿确认许岚否认见过钥匙", category: "timeline", sourceChapter: "ch2" }],
        character: [{ id: "character:lin:2", characterId: "林川", field: "acceptedParticipation", value: "第2章在场", sourceChapter: "ch2" }],
        promise: [{ id: "promise:F-01", promiseId: "F-01", description: "旧钥匙来源", status: "open", currentHeat: 0.8, sourceChapter: "ch1" }],
        pattern: [{ id: "pattern:hook:2", patternType: "hook_type", description: "连续两章使用敲击声收尾", occurrenceCount: 2, sourceChapter: "ch2" }],
        sourceIds: ["narrative-state-store.json"],
      },
    },
    characterNames: ["林川", "许岚"],
    fewshotSelection: {
      examples: [{
        id: "accepted-ch2",
        text: "许岚否认见过钥匙。林川没有追问，只把钥匙装进口袋。",
        qualityScore: 1,
        source: "chapters/chapter-02.md",
      }],
      query: {},
      channel: "runtime",
      sources: ["chapters/chapter-02.md"],
      manifestApproved: true,
    },
  };
}

test("raw 消费接受稿参考、历史连续性和近期模式，但不把它们变成机械配额", () => {
  const output = buildRawPrompt(makeInput());
  assert.match(output.userPrompt, /许岚否认见过钥匙/);
  assert.match(output.userPrompt, /第2章接受稿确认许岚否认见过钥匙/);
  assert.match(output.userPrompt, /连续两章使用敲击声收尾/);
  assert.equal(output.knowledgeConsumption.consumedByRawPrompt, true);
  assert.ok(output.consumedFields.includes("knowledgeConsumption"));
  assert.ok(output.consumedFields.includes("historicalContinuity"));
  assert.ok(output.consumedFields.includes("recentPatternMemory"));
  assert.doesNotMatch(output.userPrompt, /对白比例|每段|固定句式|必须模仿/);
  assert.doesNotMatch(output.promptAdapter.userPrompt, /manifest|token|advisory|分数：|匹配：/iu);
});

test("未提供接受稿参考时保持空通道，不伪造工艺上下文", () => {
  const input = makeInput();
  delete input.fewshotSelection;
  input.context.longTermState = null;
  const output = buildRawPrompt(input);
  assert.equal(output.knowledgeConsumption.consumedByRawPrompt, false);
  assert.equal(output.consumedFields.includes("knowledgeConsumption"), false);
  assert.equal(output.consumedFields.includes("historicalContinuity"), false);
});
