/**
 * MEMORY-6 检索层接入集成测试
 *
 * 真相源：任务文档 §十/§六（验收）
 * 覆盖：ContextRetrieval 消费已有 memory 信封，做权威感知过滤与加权。
 *
 * 关键设计约束（非破坏性）：
 * - 旧条目（无 memory 信封）行为不变，全部照常进入工作集。
 * - 带信封且不可作为正式事实（expired/archived/conflicted/plan/hypothesis）的条目
 *   被排除并记录 reason=memory_not_formal_fact。
 * - 带信封且权威更高的条目（author_declaration/final_text_explicit/confirmed）
 *   在评分中加权，优先返回。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as contextRetrievalMod from "../dist/v2/core/context-retrieval.js";

const { retrieveNarrativeContext } = contextRetrievalMod;

function makeCanonWithMemory(id, overrides = {}) {
  return {
    id,
    kind: "canon",
    sourceChapter: "ch14",
    sourceRef: "ch14#finalText:abc123def456:0-10",
    confidence: 0.9,
    lastUpdated: "2026-08-11T00:00:00Z",
    fact: `事实${id}`,
    category: "entity",
    ...overrides,
  };
}

function confirmedMemory(id) {
  return {
    memoryId: id,
    memoryType: "canon",
    authorityClass: "final_text_explicit",
    epistemicStatus: "confirmed",
    lifecycleStatus: "active",
    sourceChapter: 14,
    sourceRef: ["ch14#finalText:abc123def456:0-10"],
    textHash: ["abc123def456"],
    sourceRunId: "run-ch14",
    sourceFinalTextHash: "abc123def456",
    createdAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:00Z",
    expiresAt: null,
    confidence: 0.9,
    derivedFromMemoryIds: [],
    supersedesMemoryIds: [],
    payload: { memoryType: "canon", data: { value: "事实", category: "entity", key: "k" } },
  };
}

test("MEMORY-6 集成: 无信封的旧条目行为不变，全部进入工作集", () => {
  const state = {
    canon: [
      makeCanonWithMemory("c1"),
      makeCanonWithMemory("c2"),
      makeCanonWithMemory("c3"),
    ],
    character: [],
    promise: [],
    pattern: [],
  };
  const result = retrieveNarrativeContext({
    chapterNumber: 17,
    relevantCharacters: [],
    selectedPromiseIds: [],
    keywords: [],
    state,
    maxItems: 24,
  });
  assert.equal(result.workingSet.canon.length, 3);
  assert.equal(result.report.futureStateExcluded.length, 0);
});

test("MEMORY-6 集成: 带信封且不可作为正式事实的条目被排除并记录来源", () => {
  const state = {
    canon: [
      // 正常 confirmed 条目
      makeCanonWithMemory("normal", { memory: confirmedMemory("normal") }),
      // 过期/归档/冲突/plan/hypothesis 条目——不可作为正式事实
      makeCanonWithMemory("expired", {
        memory: {
          ...confirmedMemory("expired"),
          lifecycleStatus: "expired",
        },
      }),
      makeCanonWithMemory("archived", {
        memory: {
          ...confirmedMemory("archived"),
          lifecycleStatus: "archived",
        },
      }),
      makeCanonWithMemory("conflicted", {
        memory: {
          ...confirmedMemory("conflicted"),
          lifecycleStatus: "conflicted",
        },
      }),
      makeCanonWithMemory("planned", {
        memory: {
          ...confirmedMemory("planned"),
          authorityClass: "model_planned",
          epistemicStatus: "planned",
        },
      }),
      makeCanonWithMemory("hypo", {
        memory: {
          ...confirmedMemory("hypo"),
          authorityClass: "diagnostic_hypothesis",
          epistemicStatus: "hypothesis",
        },
      }),
    ],
    character: [],
    promise: [],
    pattern: [],
  };
  const result = retrieveNarrativeContext({
    chapterNumber: 17,
    relevantCharacters: [],
    selectedPromiseIds: [],
    keywords: [],
    state,
    maxItems: 24,
  });
  // 只有 normal 进入工作集
  assert.equal(result.workingSet.canon.length, 1);
  assert.equal(result.workingSet.canon[0].id, "normal");
  // 被排除的条目必须记录 reason=memory_not_formal_fact + sourceRef
  const excluded = result.report.futureStateExcluded;
  const excludedIds = new Set(excluded.map((e) => e.id));
  for (const id of ["expired", "archived", "conflicted", "planned", "hypo"]) {
    assert.ok(excludedIds.has(id), `应排除 ${id}`);
  }
  for (const e of excluded) {
    assert.equal(e.reason, "memory_not_formal_fact");
    assert.ok(e.sourceRef, "futureStateExcluded 必须带 sourceRef");
    assert.ok(e.sourceChapter, "futureStateExcluded 必须带 sourceChapter");
  }
});

test("MEMORY-6 集成: 权威更高条目在评分中加权，优先进入工作集", () => {
  const state = {
    canon: [
      // 无信封条目（低优先级）
      makeCanonWithMemory("legacy-high-score", { fact: "关键词甲 内容" }),
      // 有信封 confirmed 条目（权威加权）
      makeCanonWithMemory("confirmed", {
        fact: "关键词甲 内容",
        memory: confirmedMemory("confirmed"),
      }),
    ],
    character: [],
    promise: [],
    pattern: [],
  };
  const result = retrieveNarrativeContext({
    chapterNumber: 17,
    relevantCharacters: [],
    selectedPromiseIds: [],
    keywords: ["关键词甲"],
    state,
    maxItems: 24,
  });
  // 两者都进入工作集（maxItems 足够）
  const ids = result.workingSet.canon.map((c) => c.id);
  assert.ok(ids.includes("confirmed"));
  assert.ok(ids.includes("legacy-high-score"));
  // confirmed 条目应因权威加权在评分上更高（report.retrieved 含 score）
  const retrieved = result.report.retrieved;
  const confirmedItem = retrieved.find((r) => r.id === "confirmed");
  const legacyItem = retrieved.find((r) => r.id === "legacy-high-score");
  assert.ok(
    confirmedItem.score > legacyItem.score,
    `confirmed(${confirmedItem.score}) 应高于 legacy(${legacyItem.score})`
  );
  assert.ok(confirmedItem.reason.some((r) => r.includes("memory_")));
});

test("MEMORY-7 生产接线: TTL 到期(expiresAt<=now)的记忆被排除，未到期仍进入", () => {
  const now = Date.parse("2026-08-11T00:00:00Z");
  const makeDiagPattern = (id, expiresAt) => ({
    id,
    kind: "pattern",
    sourceChapter: "ch14",
    sourceRef: "ch14#finalText:abc123def456:0-10",
    confidence: 0.8,
    lastUpdated: "2026-08-11T00:00:00Z",
    patternType: "sentence_risk",
    description: `诊断${id}`,
    occurrenceCount: 1,
    memory: {
      memoryId: id,
      memoryType: "diagnostic",
      authorityClass: "system_derived",
      epistemicStatus: "derived",
      // 关键：lifecycleStatus 仍为 active，只有 expiresAt 已过——isMemoryRetrievable
      // 不会拦截（它只查 lifecycleStatus 字段），必须由 TTL 到期过滤(TierForMemory)拦截。
      lifecycleStatus: "active",
      sourceChapter: 14,
      sourceRef: ["ch14#finalText:abc123def456:0-10"],
      textHash: ["abc123def456"],
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
      expiresAt,
      confidence: 0.8,
      derivedFromMemoryIds: [],
      supersedesMemoryIds: [],
      payload: { memoryType: "diagnostic", data: { description: `诊断${id}`, ttlSeconds: 3600 } },
    },
  });
  const state = {
    canon: [],
    character: [],
    promise: [],
    pattern: [
      makeDiagPattern("expired-ttl", "2020-01-01T00:00:00Z"),
      makeDiagPattern("active-ttl", null),
    ],
  };
  const result = retrieveNarrativeContext({
    chapterNumber: 17,
    relevantCharacters: [],
    selectedPromiseIds: [],
    keywords: [],
    state,
    maxItems: 24,
    now,
  });
  // 到期条目被排除并记录 memory_expired_ttl（不静默忽略）
  const excludedIds = new Set(result.report.futureStateExcluded.map((e) => e.id));
  assert.ok(excludedIds.has("expired-ttl"), "expiresAt 已过的 diagnostic 应被 TTL 过滤排除");
  const ttlExcluded = result.report.futureStateExcluded.find((e) => e.id === "expired-ttl");
  assert.equal(ttlExcluded.reason, "memory_expired_ttl");
  // 未到期条目进入 workingSet
  const patternIds = result.workingSet.pattern.map((p) => p.id);
  assert.ok(patternIds.includes("active-ttl"), "未到期的 diagnostic 应进入 advisory 通道");
  assert.ok(!patternIds.includes("expired-ttl"), "到期条目不得进入 workingSet");
});

test("MEMORY-7 生产接线: retrieved 条目暴露 traceable 回源审计", () => {
  const state = {
    canon: [
      makeCanonWithMemory("traceable-can", { sourceRef: "ch14#finalText:abc123def456:0-10" }),
      makeCanonWithMemory("non-traceable", { sourceRef: "narrative-state-store.json#canon:k" }),
    ],
    character: [],
    promise: [],
    pattern: [],
  };
  const result = retrieveNarrativeContext({
    chapterNumber: 17,
    relevantCharacters: [],
    selectedPromiseIds: [],
    keywords: [],
    state,
    maxItems: 24,
  });
  const retrieved = result.report.retrieved;
  const traceableItem = retrieved.find((r) => r.id === "traceable-can");
  const nonTraceableItem = retrieved.find((r) => r.id === "non-traceable");
  assert.equal(typeof traceableItem.traceable, "boolean", "traceable 字段必须存在");
  assert.equal(traceableItem.traceable, true, "可解析 sourceRef 应 traceable=true");
  assert.equal(nonTraceableItem.traceable, false, "不可解析 sourceRef 应 traceable=false");
});