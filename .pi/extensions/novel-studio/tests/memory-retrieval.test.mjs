/**
 * MEMORY-6 权威感知检索层测试
 *
 * 验收口径（任务文档 §十/§十二）：
 * - 默认优先返回 confirmed、author-declared 和 final-text evidence
 * - planned/hypothesis 默认不可作为事实证据
 * - 同一事实存在多个版本时返回当前有效版本
 * - 冲突状态被明确标识，模型不能静默选边
 * - 模型可以从摘要继续追踪到原章节
 * - 不因长期记忆增加而无限扩大上下文（maxItems / maxChars 预算）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rankMemoryRecords,
  toLightweightResults,
  annotateConflicts,
} from "../dist-test/v2/core/memory/memory-retrieval.js";

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

test("MEMORY-6: 默认排除 planned/hypothesis（不可作为事实证据）", () => {
  const now = Date.now();
  const records = [
    makeRecord({ memoryId: "r-confirmed" }),
    makeRecord({ memoryId: "r-planned", epistemicStatus: "planned", authorityClass: "model_planned" }),
    makeRecord({ memoryId: "r-hypo", epistemicStatus: "hypothesis", authorityClass: "diagnostic_hypothesis" }),
  ];
  const { ranked, excluded } = rankMemoryRecords(records, now, { maxItems: 10, maxChars: 100000 });
  const rankedIds = ranked.map((r) => r.record.memoryId);
  assert.ok(rankedIds.includes("r-confirmed"));
  assert.ok(!rankedIds.includes("r-planned"));
  assert.ok(!rankedIds.includes("r-hypo"));
  assert.ok(excluded.some((e) => e.memoryId === "r-planned"));
  assert.ok(excluded.some((e) => e.memoryId === "r-hypo"));
});

test("MEMORY-6: 权威排序：author_declaration > final_text > committed_state > system_derived", () => {
  const now = Date.now();
  const records = [
    makeRecord({ memoryId: "r-final", authorityClass: "final_text_explicit" }),
    makeRecord({ memoryId: "r-author", authorityClass: "author_declaration" }),
    makeRecord({ memoryId: "r-derived", authorityClass: "system_derived", epistemicStatus: "derived" }),
  ];
  const { ranked } = rankMemoryRecords(records, now, { maxItems: 10, maxChars: 100000 });
  assert.equal(ranked[0].record.memoryId, "r-author");
  assert.equal(ranked[1].record.memoryId, "r-final");
  assert.equal(ranked[2].record.memoryId, "r-derived");
});

test("MEMORY-6: 冲突记录被排除且明确标识（不静默选边）", () => {
  const now = Date.now();
  const conflicted = makeRecord({
    memoryId: "r-conflict",
    lifecycleStatus: "conflicted",
  });
  const { ranked, excluded } = rankMemoryRecords([conflicted], now, { maxItems: 10, maxChars: 100000 });
  assert.equal(ranked.length, 0);
  assert.ok(excluded.some((e) => e.memoryId === "r-conflict"));
});

test("MEMORY-6: 过期/归档记录不参与默认检索", () => {
  const now = Date.now();
  const expired = makeRecord({ memoryId: "r-expired", lifecycleStatus: "expired" });
  const archived = makeRecord({ memoryId: "r-archived", lifecycleStatus: "archived" });
  const { ranked, excluded } = rankMemoryRecords([expired, archived], now, { maxItems: 10, maxChars: 100000 });
  assert.equal(ranked.length, 0);
  assert.ok(excluded.some((e) => e.memoryId === "r-expired"));
  assert.ok(excluded.some((e) => e.memoryId === "r-archived"));
});

test("MEMORY-6: maxItems 预算防止无限扩大上下文", () => {
  const now = Date.now();
  const records = Array.from({ length: 50 }, (_, i) =>
    makeRecord({ memoryId: `r-${i}`, sourceRef: [`ch3#finalText:abc123def456:${i}-${i + 5}`] })
  );
  const { ranked } = rankMemoryRecords(records, now, { maxItems: 5, maxChars: 100000 });
  assert.equal(ranked.length, 5);
});

test("MEMORY-6: maxChars 预算控制总字符", () => {
  const now = Date.now();
  const big = makeRecord({
    memoryId: "r-big",
    payload: {
      memoryType: "canon",
      data: { value: "很长".repeat(500), category: "genre", key: "canon:world:genre" },
    },
  });
  const small = makeRecord({ memoryId: "r-small" });
  // maxChars 只够放一个小记录
  const { ranked } = rankMemoryRecords([big, small], now, { maxItems: 10, maxChars: 100 });
  const ids = ranked.map((r) => r.record.memoryId);
  assert.ok(!ids.includes("r-big"));
  assert.ok(ids.includes("r-small"));
});

test("MEMORY-6: 轻量结果可继续追踪到原章节（traceable + sourceRef）", () => {
  const now = Date.now();
  const records = [makeRecord()];
  const { ranked } = rankMemoryRecords(records, now, { maxItems: 10, maxChars: 100000 });
  const light = toLightweightResults(ranked);
  assert.equal(light[0].traceable, true);
  assert.ok(light[0].sourceRef.length > 0);
  assert.ok(light[0].textHash.length > 0);
  assert.ok(light[0].sourceRef[0].startsWith("ch3#finalText:"));
  // 轻量结果不包含完整正文
  assert.equal(light[0].summary, "仙侠世界");
});

test("MEMORY-6: annotateConflicts 明确标识冲突状态", () => {
  const now = Date.now();
  const records = [makeRecord({ memoryId: "r-a" }), makeRecord({ memoryId: "r-b" })];
  const { ranked } = rankMemoryRecords(records, now, { maxItems: 10, maxChars: 100000 });
  const light = toLightweightResults(ranked);
  const annotated = annotateConflicts(light, new Set(["r-b"]));
  const b = annotated.find((r) => r.memoryId === "r-b");
  assert.equal(b.hasConflict, true);
  assert.equal(b.lifecycleStatus, "conflicted");
});
