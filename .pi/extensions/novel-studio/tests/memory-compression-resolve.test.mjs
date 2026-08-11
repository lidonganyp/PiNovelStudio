/**
 * MEMORY-3 压缩策略与可回源机制测试
 *
 * 验收口径（任务文档 §六/§十/§十二）：
 * - 不同记忆类型使用不同压缩策略（禁止统一压成自由文本摘要）
 * - 所有正式摘要 100% 可回源
 * - 原文修改或 hash 不匹配时检索 fail-closed（不返回模糊片段）
 * - 精确事实查询能回到原文，而不是只返回二次摘要
 * - 检测并禁止无来源的摘要套摘要（§3.3）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compressionStrategy,
  isCompressionAllowed,
  resolveMemorySource,
  parseSourceRef,
  detectSummaryOfSummary,
} from "../dist-test/v2/core/memory/memory-compression.js";
import { computeSha12 } from "../dist-test/v2/core/memory/memory-hash.js";

function makeRecord(overrides = {}) {
  return {
    memoryId: "canon:world:genre",
    memoryType: "canon",
    authorityClass: "final_text_explicit",
    epistemicStatus: "confirmed",
    lifecycleStatus: "active",
    sourceChapter: 3,
    sourceRef: ["ch3#finalText:abc123def456:10-20"],
    textHash: ["abc123def456"],
    sourceRunId: "run-ch3",
    sourceFinalTextHash: "abc123def456",
    createdAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:00Z",
    expiresAt: null,
    confidence: 0.8,
    derivedFromMemoryIds: [],
    supersedesMemoryIds: [],
    payload: {
      memoryType: "canon",
      data: { value: "仙侠世界", category: "genre", key: "canon:world:genre" },
    },
    ...overrides,
  };
}

test("MEMORY-3: canon/chapter_fact 禁止自由语义压缩", () => {
  assert.equal(compressionStrategy("canon").level, "none");
  assert.equal(compressionStrategy("chapter_fact").level, "none");
  assert.equal(compressionStrategy("canon").mustKeepStructure, true);
  assert.equal(compressionStrategy("chapter_fact").mustKeepReference, true);
  assert.equal(isCompressionAllowed("canon"), false);
});

test("MEMORY-3: character 允许摘要但必须保留结构化字段与引用", () => {
  const s = compressionStrategy("character");
  assert.equal(s.level, "summary_with_ref");
  assert.equal(s.allowSummary, true);
  assert.equal(s.mustKeepStructure, true);
  assert.equal(s.mustKeepReference, true);
});

test("MEMORY-3: promise 不压缩生命周期与兑现条件", () => {
  const s = compressionStrategy("promise");
  assert.equal(s.level, "none");
  assert.equal(s.mustKeepLifecycle, true);
});

test("MEMORY-3: pattern 允许高度抽象", () => {
  const s = compressionStrategy("pattern");
  assert.equal(s.level, "high_abstract");
  assert.equal(isCompressionAllowed("pattern"), true);
});

test("MEMORY-3: chapter_summary 可摘要但必须保留引用", () => {
  const s = compressionStrategy("chapter_summary");
  assert.equal(s.level, "summary_with_ref");
  assert.equal(s.mustKeepReference, true);
});

test("MEMORY-3: diagnostic 应衰减", () => {
  assert.equal(compressionStrategy("diagnostic").level, "decay");
});

test("MEMORY-3: parseSourceRef 解析 chN#finalText:hash 与 span", () => {
  const full = parseSourceRef("ch3#finalText:abc123def456:10-20");
  assert.deepEqual(full, { chapter: 3, hash: "abc123def456", start: 10, end: 20 });

  const noSpan = parseSourceRef("ch3#finalText:abc123def456");
  assert.deepEqual(noSpan, { chapter: 3, hash: "abc123def456" });

  const invalid = parseSourceRef("candidate:amp-1");
  assert.equal(invalid, null);
});

test("MEMORY-3: 按 memoryId 回源最终正文片段", () => {
  const chapterText = "这是一段用于回源测试的最终正文内容。";
  const hash = computeSha12(chapterText);
  const record = makeRecord({
    sourceRef: [`ch3#finalText:${hash}:2-10`],
    sourceFinalTextHash: hash,
    textHash: [hash],
  });
  const result = resolveMemorySource(record, (n) => (n === 3 ? chapterText : null));
  assert.equal(result.ok, true);
  assert.equal(result.excerpt, chapterText.slice(2, 10));
  assert.ok(result.reason.includes("回源成功 ch3"));
});

test("MEMORY-3: 正文 hash 不匹配时 fail-closed（不返回模糊片段）", () => {
  const original = "原始最终正文内容。";
  const hash = computeSha12(original);
  // 正文被修改：hash 不匹配
  const modifiedText = "修改后的最终正文内容！！";
  const record = makeRecord({
    sourceRef: [`ch3#finalText:${hash}:0-5`],
  });
  const result = resolveMemorySource(record, () => modifiedText);
  assert.equal(result.ok, false);
  assert.equal(result.excerpt, null);
  assert.ok(result.reason.includes("hash 不匹配"));
});

test("MEMORY-3: 章节正文不可用时 fail-closed", () => {
  const hash = "abc123def456";
  const record = makeRecord({ sourceRef: [`ch5#finalText:${hash}:0-5`] });
  const result = resolveMemorySource(record, () => null);
  assert.equal(result.ok, false);
  assert.equal(result.excerpt, null);
  assert.ok(result.reason.includes("正文不可用"));
});

test("MEMORY-3: span 越界时 fail-closed", () => {
  const chapterText = "短正文";
  const hash = computeSha12(chapterText);
  const record = makeRecord({ sourceRef: [`ch3#finalText:${hash}:0-99`] });
  const result = resolveMemorySource(record, () => chapterText);
  assert.equal(result.ok, false);
  assert.equal(result.excerpt, null);
  assert.ok(result.reason.includes("越界"));
});

test("MEMORY-3: 精确事实查询回原文而非二次摘要", () => {
  // 摘要记录指向最终正文 span，回源得到的是原文片段而非摘要文本
  const chapterText = "主角在青石镇觉醒血脉，踏入炼气期，成为宗门新星。";
  const hash = computeSha12(chapterText);
  const record = makeRecord({
    memoryType: "character",
    payload: {
      memoryType: "character",
      data: { value: "叶尘炼气期", category: "realm", key: "character:叶尘:realm" },
    },
    sourceRef: [`ch3#finalText:${hash}:8-12`],
  });
  const result = resolveMemorySource(record, () => chapterText);
  assert.equal(result.ok, true);
  assert.equal(result.excerpt, chapterText.slice(8, 12)); // 原文片段，不是摘要
  assert.notEqual(result.excerpt, "叶尘炼气期"); // 不是二次摘要
});

test("MEMORY-3: 无来源的摘要套摘要被拒绝", () => {
  const record = makeRecord({
    memoryType: "chapter_summary",
    payload: {
      memoryType: "chapter_summary",
      data: { sceneFlow: "经过", emotionChange: "变化", sourceExcerpts: [] },
    },
    sourceRef: [], // 无直接 sourceRef
    derivedFromMemoryIds: ["summary:old"], // 仅派生自其他摘要
  });
  const r = detectSummaryOfSummary(record);
  assert.equal(r.isSummaryOfSummary, true);
  assert.ok(r.reason.includes("摘要套摘要"));
});

test("MEMORY-3: 有直接 sourceRef 的摘要不算摘要套摘要", () => {
  const record = makeRecord({
    memoryType: "chapter_summary",
    payload: {
      memoryType: "chapter_summary",
      data: { sceneFlow: "经过", emotionChange: "变化", sourceExcerpts: [] },
    },
    sourceRef: ["ch3#finalText:abc123def456:0-50"],
  });
  const r = detectSummaryOfSummary(record);
  assert.equal(r.isSummaryOfSummary, false);
});

test("MEMORY-3: 结构化事实（非摘要）不触发摘要套摘要", () => {
  const record = makeRecord();
  const r = detectSummaryOfSummary(record);
  assert.equal(r.isSummaryOfSummary, false);
});
