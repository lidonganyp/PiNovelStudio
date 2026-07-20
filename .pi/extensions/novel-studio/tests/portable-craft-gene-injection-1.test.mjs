/** PORTABLE-CRAFT-GENE-1: bounded abstract craft guidance without reference leakage. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRawPrompt } from "../dist/v2/core/orchestrator-raw.js";
import {
  compilePortableCraftGenes,
  validatePortableCraftGenes,
} from "../dist/v2/core/portable-craft-gene.js";

const baseInput = {
  workspaceId: "xinmo",
  chapterId: "18",
  chapterNumber: 18,
  projectRoot: process.cwd(),
  intent: {
    chapterFunction: "推进原创项目现有冲突",
    readerExperience: ["规则型恐怖"],
    currentPressure: ["前章承诺必须兑现"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["李一凡"],
    inviolableFacts: [],
    sourceRefs: ["chapter-seed"],
  },
  context: {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
  },
  characterNames: ["李一凡"],
};

const genes = [{
  geneId: "evidence_driven_escalation",
  generationGuidance: "让异常证据推翻安全解释，再由主角试探产生代价。",
  requiredMoves: ["可疑证据", "主动试探", "试探代价"],
  avoidPatterns: ["连续堆叠心跳、冷汗、脚步声"],
  sourceReferenceIds: ["smsf:physical:7"],
  sourceExcerpt: "参考作品原文不得进入生成提示词",
}];

test("PORTABLE-CRAFT-GENE-1 compiles only whitelisted abstract runtime fields", () => {
  const compiled = compilePortableCraftGenes(genes);
  assert.equal(compiled.geneIds[0], "evidence_driven_escalation");
  assert.match(compiled.promptBlock, /异常证据推翻安全解释/);
  assert.match(compiled.promptBlock, /主动试探/);
  assert.doesNotMatch(compiled.promptBlock, /smsf:physical/);
  assert.doesNotMatch(compiled.promptBlock, /参考作品原文/);
  assert.doesNotMatch(compiled.promptBlock, /神秘复苏/);
});

test("PORTABLE-CRAFT-GENE-1 preserves A/B prompt when craft genes are absent", () => {
  const absent = buildRawPrompt(baseInput);
  const explicitlyEmpty = buildRawPrompt({ ...baseInput, craftGenes: [] });
  assert.equal(absent.userPrompt, explicitlyEmpty.userPrompt);
  assert.equal(absent.consumedFields.includes("craftGenes"), false);
  assert.equal(explicitlyEmpty.consumedFields.includes("craftGenes"), false);
});

test("PORTABLE-CRAFT-GENE-1 remains trace/experiment evidence and never enters raw", () => {
  const output = buildRawPrompt({ ...baseInput, craftGenes: genes });
  assert.equal(output.consumedFields.includes("craftGenes"), false);
  assert.doesNotMatch(output.userPrompt, /可迁移叙事工艺/);
  assert.doesNotMatch(output.userPrompt, /异常证据推翻安全解释/);
  assert.doesNotMatch(output.userPrompt, /evidence_driven_escalation/);
  assert.doesNotMatch(output.userPrompt, /smsf:physical/);
  assert.doesNotMatch(output.userPrompt, /参考作品原文/);
});

test("PORTABLE-CRAFT-GENE-1 rejects unbounded, empty or explicitly reference-bearing guidance", () => {
  assert.equal(validatePortableCraftGenes([]).valid, true);
  assert.equal(validatePortableCraftGenes([{ ...genes[0], generationGuidance: "" }]).valid, false);
  assert.equal(validatePortableCraftGenes(Array.from({ length: 7 }, (_, index) => ({
    ...genes[0],
    geneId: `gene_${index}`,
  }))).valid, false);
  assert.equal(validatePortableCraftGenes([{
    ...genes[0],
    generationGuidance: "模仿《神秘复苏》的原句与杨间设定。",
  }]).valid, false);
});
