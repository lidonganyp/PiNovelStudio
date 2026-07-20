/** GEMINI-CONTINUOUS-CEILING-1: continuous A/B frontier harness contracts. */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  buildAnonymousSequenceMapping,
  buildHumanReviewTemplate,
  installSharedChapterSeeds,
  normalizeSceneSolutionStateAliases,
  parseContinuousCeilingArgs,
  parseSeedPlannerResponse,
  resolveCanonicalChapterPath,
  shouldRecoverBlockedRaw,
} from "../../../../scripts/novelbench/gemini-continuous-ceiling-lib.mjs";

const seedPayload = JSON.stringify({
  chapters: [18, 19, 20].map((chapterNumber) => ({
    chapterNumber,
    choicesAndCosts: [{ choice: `第${chapterNumber}章选择`, cost: `第${chapterNumber}章代价` }],
    expectedIrreversibleChange: [`第${chapterNumber}章不可逆变化`],
    causalEndPressure: [`第${chapterNumber}章章末压力`],
  })),
});

test("continuous ceiling arguments require a 3-5 chapter Gemini run", () => {
  assert.deepEqual(parseContinuousCeilingArgs([
    "--source=xinmo",
    "--through=17",
    "--chapters=3",
    "--run-id=gemini-limit-1",
  ]), {
    sourceWorkspaceId: "xinmo",
    throughChapter: 17,
    chapterCount: 3,
    runId: "gemini-limit-1",
    resume: false,
  });
  assert.throws(() => parseContinuousCeilingArgs(["--chapters=2"]), /3 and 5/i);
  assert.throws(() => parseContinuousCeilingArgs(["--chapters=6"]), /3 and 5/i);
});

test("seed planner accepts only complete sequential ChapterSeed decisions", () => {
  const seeds = parseSeedPlannerResponse(seedPayload, { startChapter: 18, chapterCount: 3 });
  assert.equal(seeds.length, 3);
  assert.deepEqual(seeds.map((seed) => seed.chapterNumber), [18, 19, 20]);
  assert.equal(seeds[0].choicesAndCosts[0].choice, "第18章选择");

  const incomplete = JSON.stringify({ chapters: [{
    chapterNumber: 18,
    choicesAndCosts: [],
    expectedIrreversibleChange: [],
    causalEndPressure: [],
  }] });
  assert.throws(
    () => parseSeedPlannerResponse(incomplete, { startChapter: 18, chapterCount: 3 }),
    /exactly 3|choicesAndCosts/i,
  );
});

test("seed planner normalizes preregistered Chinese field aliases", () => {
  const payload = JSON.stringify({
    章节列表: [18, 19, 20].map((chapterNumber) => ({
      章节号: chapterNumber,
      选择与代价: [{ 选择: `选择${chapterNumber}`, 代价: `代价${chapterNumber}` }],
      不可逆变化: [`变化${chapterNumber}`],
      章末因果压力: [`压力${chapterNumber}`],
    })),
  });
  const seeds = parseSeedPlannerResponse(payload, { startChapter: 18, chapterCount: 3 });
  assert.deepEqual(seeds.map((seed) => seed.chapterNumber), [18, 19, 20]);
  assert.equal(seeds[2].choicesAndCosts[0].cost, "代价20");
});

test("seed planner recovers provider-garbled keys only from an unambiguous value shape", () => {
  const payload = JSON.stringify({
    丙辛甲巳酉戊未申: [18, 19, 20].map((chapterNumber) => ({
      乱码事件字段: [`事件${chapterNumber}-1`, `事件${chapterNumber}-2`],
      乱码选择字段: [{ 乱码选择: `选择${chapterNumber}`, 乱码代价: `代价${chapterNumber}` }],
      乱码变化字段: [`变化${chapterNumber}`],
      乱码压力字段: [`压力${chapterNumber}`],
    })),
  });
  const seeds = parseSeedPlannerResponse(payload, { startChapter: 18, chapterCount: 3 });
  assert.equal(seeds[0].choicesAndCosts[0].choice, "选择18");
  assert.deepEqual(seeds[1].expectedIrreversibleChange, ["变化19"]);
  assert.deepEqual(seeds[2].causalEndPressure, ["压力20"]);
});

test("shared seeds are installed identically without changing isolated workspace identity", () => {
  const root = mkdtempSync(join(tmpdir(), "pinovel-gemini-continuous-"));
  const aPath = join(root, "a-config.json");
  const bPath = join(root, "b-config.json");
  writeFileSync(aPath, JSON.stringify({ workspaceId: "frontier-a", chapterSeeds: {} }), "utf8");
  writeFileSync(bPath, JSON.stringify({ workspaceId: "frontier-b", chapterSeeds: {} }), "utf8");
  const seeds = parseSeedPlannerResponse(seedPayload, { startChapter: 18, chapterCount: 3 });

  installSharedChapterSeeds([aPath, bPath], seeds);

  const a = JSON.parse(readFileSync(aPath, "utf8"));
  const b = JSON.parse(readFileSync(bPath, "utf8"));
  assert.equal(a.workspaceId, "frontier-a");
  assert.equal(b.workspaceId, "frontier-b");
  assert.deepEqual(a.chapterSeeds, b.chapterSeeds);
  assert.deepEqual(Object.keys(a.chapterSeeds), ["18", "19", "20"]);
  for (const chapterSeed of Object.values(a.chapterSeeds)) {
    assert.ok(chapterSeed.candidateAnchors.length >= 2);
    assert.ok(chapterSeed.candidateAnchors.every((anchor) => anchor.description.includes("主动选择")));
  }
});

test("anonymous sequence mapping is stable and hides strategy labels", () => {
  const first = buildAnonymousSequenceMapping("gemini-limit-1");
  const second = buildAnonymousSequenceMapping("gemini-limit-1");
  assert.deepEqual(first, second);
  assert.deepEqual(new Set(Object.keys(first.publicToPrivate)), new Set(["序列甲", "序列乙"]));
  assert.deepEqual(Object.values(first.publicToPrivate).sort(), ["raw", "scene_solution"]);
  assert.equal(JSON.stringify(first.publicReviewLabels).includes("raw"), false);
  assert.equal(JSON.stringify(first.publicReviewLabels).includes("scene_solution"), false);
});

test("continuous CLI uses the public chapter tool and locks Gemini prose generation", () => {
  const script = readFileSync(
    resolve(process.cwd(), "../../../scripts/novelbench/gemini-continuous-ceiling.mjs"),
    "utf8",
  );
  assert.match(script, /novel_generate_chapter/);
  assert.match(script, /writerModel:\s*["']gemini31["']/);
  assert.match(script, /createFrontierSnapshot/);
  assert.match(script, /sceneSolution/);
  assert.doesNotMatch(script, /runUnifiedPipeline/);
  assert.match(script, /scene-solution-invalid-attempt-/);
  assert.match(script, /attempt <= 2/);
  assert.match(script, /chapter_execution_error/);
  assert.match(script, /评审完成前不要打开 private-mapping\.json/);
});

test("canonical chapter resolver supports N.md and chapter-N.md workspaces", () => {
  const root = mkdtempSync(join(tmpdir(), "pinovel-chapter-path-"));
  const chapters = join(root, "chapters");
  mkdirSync(chapters, { recursive: true });
  writeFileSync(join(chapters, "chapter-17.md"), "chapter 17", "utf8");
  assert.equal(resolveCanonicalChapterPath(root, 17), join(chapters, "chapter-17.md"));
  writeFileSync(join(chapters, "18.md"), "chapter 18", "utf8");
  assert.equal(resolveCanonicalChapterPath(root, 18), join(chapters, "18.md"));
  assert.throws(() => resolveCanonicalChapterPath(root, 19), /canonical chapter file missing/i);
});

test("scene solution state aliases are bounded to preregistered semantic groups", () => {
  const normalized = normalizeSceneSolutionStateAliases({
    方案列表: [
      { 状态类型: "悬疑/潜行" },
      { 状态类型: "信息调查" },
      { 状态类型: "关系" },
      { 状态类型: "高压" },
      { 状态类型: "情报确立" },
      { 状态类型: "战力转化" },
      { 状态类型: "契约敲定" },
      { 状态类型: "心理压力累积" },
      { 状态类型: "战术底牌验证" },
      { 状态类型: "情感羁绊深化与变异" },
    ],
  });
  assert.deepEqual(
    normalized.方案列表.map((card) => card.状态类型),
    ["危险", "认知", "关系", "危险", "认知", "能力边界", "承诺", "危险", "能力边界", "关系"],
  );
  assert.throws(
    () => normalizeSceneSolutionStateAliases({ 方案列表: [{ 状态类型: "抒情" }] }),
    /unsupported scene state kind/i,
  );
});

test("blocked raw recovery is enabled only for a prior raw FactGuard block", () => {
  assert.equal(shouldRecoverBlockedRaw({
    accepted: false,
    failureEnvelope: { stage: "raw_fact_guard" },
  }), true);
  assert.equal(shouldRecoverBlockedRaw({
    accepted: false,
    failureEnvelope: { stage: "final_fact_recheck" },
  }), false);
  assert.equal(shouldRecoverBlockedRaw({
    accepted: true,
    failureEnvelope: { stage: "raw_fact_guard" },
  }), false);
  assert.equal(shouldRecoverBlockedRaw(undefined), false);
});

test("human review template captures absolute quality, continuity, and production admission", () => {
  const template = buildHumanReviewTemplate("run-1", [18, 19, 20]);
  assert.equal(template.schemaVersion, 2);
  assert.equal(template.dimensions.length, 8);
  assert.deepEqual(Object.keys(template.sequences[0].chapterScores[0].scores), template.dimensions);
  assert.equal(template.sequences[0].chapterScores[0].publishable, null);
  assert.equal(template.sequences[0].chapterScores[0].estimatedRevisionRatio, null);
  assert.equal(template.sequences[0].continuity.stateDrift, null);
  assert.equal(template.sequences[0].continuity.hookOrTemplateRepetition, null);
  assert.equal(template.decision.positiveGain, null);
  assert.equal(template.decision.productionAdmission, null);
});
