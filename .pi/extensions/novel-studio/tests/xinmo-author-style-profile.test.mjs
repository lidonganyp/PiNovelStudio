/**
 * XINMO-AUTHOR-STYLE-1
 *
 * The workspace-local author fingerprint is the source of truth for xinmo.
 * It may guide span-backed editorial candidates, but must never become a
 * mechanical prose quota or leak into the raw-generation prompt.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  loadStyleProfile,
  loadWorkspace,
} from "../dist/v2/adapters/legacy-workspace-adapter.js";
import { createEditorialCandidateGenerator } from "../dist/v2/core/editorial-candidate-generator.js";
import { createEditorialStrategyRegistry } from "../dist/v2/core/editorial-strategy-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");
const PROJECT_ROOT = join(__dirname, "..", "..", "..", "..");
const PROFILE_PATH = join(PROJECT_ROOT, "workspaces", "xinmo", "styles", "profile.json");

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeIntent() {
  return {
    chapterFunction: "让动作与情绪落点更自然",
    readerExperience: ["克制但可感"],
    currentPressure: [],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["李一凡"],
    inviolableFacts: ["李一凡仍站在门外"],
    factAndCharacterKnowledgeForbiddenZones: [],
    sourceRefs: ["chapter-seed"],
  };
}

function makeVoiceHypothesis(rawText) {
  const excerpt = "他感到一阵难过";
  const start = rawText.indexOf(excerpt);
  return {
    id: "hypothesis:xinmo-author-style",
    opportunityType: "voice_and_naturalness",
    diagnosis: "情绪被直接命名，缺少人物身体与动作承载",
    evidenceSpans: [{ start, end: start + excerpt.length, excerpt }],
    expectedReaderGain: "让情绪从人物当下的身体与动作自然浮现",
    damageRisks: ["不得增加新事件", "不得改变人物位置"],
    rewriteScope: "span_candidate",
    confidence: 0.9,
    source: "llm",
  };
}

test("XINMO-AUTHOR-STYLE-1 · workspace-local profile.json 优先于共享同名风格", () => {
  const root = mkdtempSync(join(tmpdir(), "pinovel-style-"));
  try {
    const workspacePath = join(root, "workspaces", "book");
    const localStylesPath = join(workspacePath, "styles");
    const sharedStylesPath = join(root, "styles", "profiles");
    mkdirSync(localStylesPath, { recursive: true });
    mkdirSync(sharedStylesPath, { recursive: true });
    writeJson(join(workspacePath, "config.json"), { styleProfile: "author" });
    writeJson(join(localStylesPath, "profile.json"), { id: "workspace-author" });
    writeJson(join(sharedStylesPath, "author.json"), { id: "shared-author" });

    const bundle = loadWorkspace("book", root);
    const loaded = loadStyleProfile(bundle, root);

    assert.ok(loaded);
    assert.equal(loaded.sourcePath, join(localStylesPath, "profile.json"));
    assert.equal(JSON.parse(loaded.content).id, "workspace-author");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("XINMO-AUTHOR-STYLE-1 · 指纹来自第1-16章与80条修正并区分统计和编辑参考", () => {
  const profile = JSON.parse(readFileSync(PROFILE_PATH, "utf8"));

  assert.equal(profile.version, "3.0");
  assert.match(profile.extractionBasis, /第1-16章/);
  assert.match(profile.extractionBasis, /33,213字/);
  assert.match(profile.extractionBasis, /80条修正记录/);
  assert.equal(profile.statistics.paragraph.medianCnChars, 12);
  assert.equal(profile.statistics.paragraph.p75CnChars, 21);
  assert.equal(profile.statistics.dialogue.observedRatio, 0.335);
  assert.ok(profile.editorialGuidance.includes("情绪优先通过身体反应、静默或动作呈现，不直接替人物命名。"));
  assert.equal(profile.usagePolicy.rawPrompt, "not_applicable");
  assert.equal(profile.usagePolicy.editorialCandidate, "full_chapter_required");
  assert.equal(profile.usagePolicy.fullChapterOptimization, "required");
  assert.equal(profile.usagePolicy.selectionAuthority, "user_feedback");

  const guidance = profile.editorialGuidance.join("\n");
  assert.doesNotMatch(guidance, /对白比例|对话比例|median_cn_chars|p75_cn_chars|\d+%/);
});

test("XINMO-AUTHOR-STYLE-1 · 历史 span 校准仍可复用精炼作者风格", async () => {
  const profile = readFileSync(PROFILE_PATH, "utf8");
  const rawText = "李一凡站在门外。他感到一阵难过。门内没有声音。";
  let capturedPrompt = "";
  const generator = createEditorialCandidateGenerator();
  const result = await generator.generate({
    rawText,
    rawCandidateId: "candidate:raw:xinmo-style",
    hypotheses: [makeVoiceHypothesis(rawText)],
    intent: makeIntent(),
    context: {
      facts: [],
      characterStates: [],
      openLoops: [],
      worldRules: [],
      styleReferences: [{
        id: "style:xinmo",
        kind: "fingerprint",
        content: profile,
        sourceIds: ["style:fingerprint"],
      }],
      sourceMap: [],
    },
    contextHash: "xinmo-style-context",
    chapterNumber: 18,
    modelGenerate: async (input) => {
      capturedPrompt = input.userPrompt;
      return {
        text: rawText.replace("他感到一阵难过", "他喉头动了动"),
        model: "doubao-test",
        route: input.route,
        durationMs: 1,
      };
    },
    strategyRegistry: createEditorialStrategyRegistry(),
  });

  assert.equal(result.candidates.length, 1, JSON.stringify(result.failures));
  assert.match(capturedPrompt, /作者风格参考（只用于当前证据 span）/);
  assert.match(capturedPrompt, /情绪优先通过身体反应、静默或动作呈现/);
  assert.match(capturedPrompt, /李一凡.*普通穷学生的生活感/);
  assert.doesNotMatch(capturedPrompt, /medianCnChars|p75CnChars|observedRatio|对白比例/);
  assert.equal(result.candidates[0].promptProfile.type, "editorial");
});
