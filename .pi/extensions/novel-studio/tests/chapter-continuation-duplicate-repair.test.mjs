import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasContinuationPrefixMismatch,
  hasCompleteChapterEcho,
  mergeChapterContinuation,
  repairAdjacentDuplicateParagraphs,
} from "../dist/v2/core/chapter-continuation.js";
import { createFactContinuityGuard } from "../dist/v2/core/fact-continuity-guard.js";
import { buildAuthorStyleUserPrompt } from "../dist/v2/core/author-style-optimizer.js";

test("continuation repair removes an immediately repeated paragraph after the protected prefix", () => {
  const prefix = "前十六章已完成的正文，必须原样保留。";
  const repeated = "李一凡身侧的暗金双眸沉了一下。随后看向那空中的虚影。";
  const suffix = `${repeated}\n\n${repeated}\n\n新的续写内容。`;
  const text = mergeChapterContinuation(prefix, suffix);

  const repaired = repairAdjacentDuplicateParagraphs(text, prefix);

  assert.equal(repaired, `${prefix}\n\n${repeated}\n\n新的续写内容。`);
  assert.ok(repaired.startsWith(prefix), "author prefix must remain an exact prefix");
});

test("continuation repair does not hide a non-adjacent true duplicate", () => {
  const prefix = "前十六章已完成的正文，必须原样保留。";
  const repeated = "李一凡身侧的暗金双眸沉了一下。随后看向那空中的虚影。";
  const text = mergeChapterContinuation(
    prefix,
    `${repeated}\n\n中间发生了新的动作。\n\n${repeated}`,
  );

  const repaired = repairAdjacentDuplicateParagraphs(text, prefix);

  assert.equal(repaired, text);
});

test("continuation prefix comparison ignores provider line-ending normalization", () => {
  const existing = "第一段已确认。\n第二段已确认。";
  const generated = "第一段已确认。\r\n第二段已确认。\r\n新增内容。";
  assert.equal(hasContinuationPrefixMismatch(existing, generated), false);
});

test("continuation prefix comparison rejects a near-identical rewritten opening", () => {
  const existing = "雨水顺着旧仓库的铁皮檐滴落下来。李一凡站在门外，没有立刻进去。";
  const rewritten = `X${existing.slice(1)}\n\n新的续写内容。`;
  assert.equal(hasContinuationPrefixMismatch(existing, rewritten), true);
});

test("complete chapter echo detects a full source followed by a substantial rewrite", () => {
  const source = "第一段已确认。第二段保留动作和结果。";
  const rewritten = "李一凡身侧的暗金色眼眸微微一沉，重新组织了这一章的叙述。".repeat(80);
  assert.equal(hasCompleteChapterEcho(source, `${source}${rewritten}`), true);
});

test("complete chapter echo allows a short legitimate extension", () => {
  const source = "第一段已确认。第二段保留动作和结果。";
  assert.equal(hasCompleteChapterEcho(source, `${source}\n新的短句。`), false);
});

test("complete chapter echo ignores CRLF normalization", () => {
  const source = "第一段已确认。\n第二段保留动作和结果。";
  const rewritten = "补充的整章改写内容。".repeat(100);
  assert.equal(hasCompleteChapterEcho(source, `${source.replace(/\n/g, "\r\n")}${rewritten}`), true);
});

test("suffix-only output is not a complete chapter echo", () => {
  const source = "第一段已确认。第二段保留动作和结果。";
  const suffix = "新的后缀内容。".repeat(100);
  assert.equal(hasCompleteChapterEcho(source, suffix), false);
});

test("merging a rewritten suffix with the source exposes a complete chapter echo", () => {
  const source = "第一段已确认。第二段保留动作和结果。";
  const rewrittenSuffix = "这是对整章内容的二次改写，但模型只返回了后缀。".repeat(100);
  assert.equal(hasCompleteChapterEcho(source, `${source}\n\n${rewrittenSuffix}`), true);
  assert.equal(hasCompleteChapterEcho(source, rewrittenSuffix), false);
});

test("continuation repair leaves an existing duplicate inside the protected author prefix untouched", () => {
  const repeated = "作者原稿中的重复句，不能被系统擅自改写。";
  const prefix = `${repeated}\n\n${repeated}`;
  const text = mergeChapterContinuation(prefix, "从这里开始的新内容。");

  const repaired = repairAdjacentDuplicateParagraphs(text, prefix);

  assert.equal(repaired, text);
});

test("continuation repair removes an immediately repeated sentence run", () => {
  const repeated = "李一凡身侧的暗金双眸沉了一下。随后看向那空中的虚影。";
  const text = `前文。\n${repeated}${repeated}\n新的内容。`;
  const repaired = repairAdjacentDuplicateParagraphs(text, "前文。");
  assert.equal(repaired, `前文。\n${repeated}\n新的内容。`);
});

test("continuation repair keeps a non-adjacent repeated sentence", () => {
  const repeated = "李一凡身侧的暗金双眸沉了一下。随后看向那空中的虚影。";
  const text = `前文。\n${repeated}\n中间动作。\n${repeated}`;
  const repaired = repairAdjacentDuplicateParagraphs(text, "前文。");
  assert.equal(repaired, text);
});

test("continuation repair removes a long sentence echoed from the protected prefix", () => {
  const echoed = "把三颗千年木心和五颗百年木心放在身侧的一块平石上。";
  const prefix = `前文。${echoed}随后完成了资源清点。`;
  const text = mergeChapterContinuation(
    prefix,
    `新的续写开头。${echoed}真正的新事件继续发生。`,
  );

  const repaired = repairAdjacentDuplicateParagraphs(text, prefix);

  assert.equal(
    repaired,
    `${prefix}\n\n新的续写开头。真正的新事件继续发生。`,
  );
});

test("continuation repair removes a prefix echo when it is the only generated sentence", () => {
  const echoed = "把三颗千年木心和五颗百年木心放在身侧的一块平石上。";
  const prefix = `前文。${echoed}`;
  const text = mergeChapterContinuation(prefix, echoed);

  const repaired = repairAdjacentDuplicateParagraphs(text, prefix);

  assert.equal(repaired, prefix);
});

test("continuation repair removes multiple resource sentences echoed from the protected prefix", () => {
  const echoed = [
    "把三颗千年木心和五颗百年木心放在身侧的一块平石上。",
    "稍微犹豫了一下，又取出剩余的五颗百年木心一并放在平石上。",
  ];
  const prefix = `前文。${echoed.join("")}资源清点完成。`;
  const suffix = `续写开头。${echoed.join("")}真正的新事件继续发生。`;
  const repaired = repairAdjacentDuplicateParagraphs(
    mergeChapterContinuation(prefix, suffix),
    prefix,
  );

  assert.equal(repaired, `${prefix}\n\n续写开头。真正的新事件继续发生。`);
});

test("continuation repair removes an exact sentence repeated at the prefix boundary", () => {
  const repeated = "李一凡身侧的暗金双眸沉了一下。";
  const prefix = `前文结尾。${repeated}`;
  const text = mergeChapterContinuation(
    prefix,
    `${repeated}随后看向那空中的虚影。新的续写内容。`,
  );
  const repaired = repairAdjacentDuplicateParagraphs(text, prefix);
  assert.equal(
    repaired,
    `${prefix}\n\n随后看向那空中的虚影。新的续写内容。`,
  );
  assert.ok(repaired.startsWith(prefix), "author prefix must remain an exact prefix");
});

test("repaired continuation no longer trips duplicate_scan, while a true duplicate still does", () => {
  const repeated = "李一凡身侧的暗金双眸沉了一下。随后看向那空中的虚影。";
  const clean = repairAdjacentDuplicateParagraphs(
    `前文。\n\n${repeated}\n\n${repeated}\n\n后文。`,
    "前文。",
  );
  const guard = createFactContinuityGuard();
  const context = {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
  };
  const cleanReport = guard.check({ text: clean, context, knownCharacterNames: [] });
  assert.equal(cleanReport.allDiagnostics.some((d) => d.source === "duplicate_scan"), false);

  const repeatedReport = guard.check({
    text: `前文。\n\n${repeated}\n\n中间动作。\n\n${repeated}`,
    context,
    knownCharacterNames: [],
  });
  const duplicateDiagnostics = repeatedReport.allDiagnostics.filter((d) => d.source === "duplicate_scan");
  assert.equal(duplicateDiagnostics.length, 1, "one repeated region should produce one diagnostic");
});

test("repair removes adjacent resource-allocation paragraph echo", () => {
  const repeated = [
    "把三颗千年木心和五颗百年木心放在身侧的一块平石上。",
    "稍微犹豫了一下，又取出剩余的五颗百年木心一并放在平石上。",
  ].join("");
  const text = `前文。${repeated}${repeated}后文。`;
  const repaired = repairAdjacentDuplicateParagraphs(text);
  assert.equal(repaired, `前文。${repeated}后文。`);
});

test("author-style prompt explicitly protects the continuation prefix", () => {
  const prompt = buildAuthorStyleUserPrompt(
    {
      sourceCandidate: { text: "已有正文。", id: "c1" },
      chapterNumber: 17,
      continuationMode: "append",
      currentChapterDraft: "已有正文。",
      intent: {
        authorEventSummaries: [],
        authorMustInclude: [],
        authorStateChanges: [],
        causalRelations: [],
        endingTarget: [],
        relevantCharacters: [],
        inviolableFacts: [],
      },
    },
    { referenceIds: [], guidance: [] },
  );
  assert.match(prompt, /CONTINUATION MODE/);
  assert.match(prompt, /exactly once/);
});

test("author-style append prompt includes the real prefix and can force suffix-only recovery", () => {
  const prefix = "第十七章\n作者已经确认的正文，必须逐字保留。";
  const prompt = buildAuthorStyleUserPrompt(
    {
      sourceCandidate: {
        text: `${prefix}\n\n从这里开始的新内容。`,
        id: "c2",
      },
      chapterNumber: 17,
      continuationMode: "append",
      currentChapterDraft: prefix,
      continuationPrefixRecovery: true,
      intent: {
        authorEventSummaries: [],
        authorMustInclude: [],
        authorStateChanges: [],
        causalRelations: [],
        endingTarget: [],
        relevantCharacters: [],
        inviolableFacts: [],
      },
    },
    { referenceIds: [], guidance: [] },
  );
  assert.match(prompt, /EXACT AUTHOR PREFIX/);
  assert.match(prompt, new RegExp(prefix));
  assert.match(prompt, /CONTINUATION PREFIX RECOVERY/);
  assert.match(prompt, /ONLY the new suffix/);
  assert.match(prompt, /从这里开始的新内容/);
});
