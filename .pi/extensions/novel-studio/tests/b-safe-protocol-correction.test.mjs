/**
 * B-safe Phase 5.3.3 协议纠正 — 策略3 inferIntentFromArgs 单元测试
 *
 * 覆盖策略3（工具名合法但 intent 非法时从 args 字段推断 intent）的推断优先级与边界：
 *   1. 唯一判别字段（status/patternType/category）→ 高置信映射
 *   2. query + maxChapters → chapter_span；query（无 maxChapters）→ evidence
 *   3. characterId（无其他判别字段）→ character_state（三义性中优先级最高）
 *   4. 无任何判别字段 → null（推断失败，保留非法 intent）
 *
 * 依赖边界：导入 dist-eval（eval-only 模块），不依赖生产闭包。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { inferIntentFromArgs } from "../dist-eval/novelos/eval/tool-ab-real-runner.js";

// ============================================================================
// 策略3 推断优先级测试
// ============================================================================

describe("B-safe 策略3 inferIntentFromArgs — 推断优先级", () => {
  // ── 1. 唯一判别字段（高置信）───────────────────────────────────────────

  it("status 字段 → promise（唯一判别，仅 promise_ledger 使用）", () => {
    assert.equal(inferIntentFromArgs({ status: "open" }), "promise");
    assert.equal(inferIntentFromArgs({ status: "fulfilled" }), "promise");
    assert.equal(inferIntentFromArgs({ status: "broken", query: "某查询" }), "promise");
  });

  it("patternType 字段 → pattern（唯一判别，仅 pattern_memory 使用）", () => {
    assert.equal(inferIntentFromArgs({ patternType: "trope" }), "pattern");
    assert.equal(inferIntentFromArgs({ patternType: "hook_type", query: "某查询" }), "pattern");
  });

  it("category 字段 → canon（唯一判别，仅 canon 使用）", () => {
    assert.equal(inferIntentFromArgs({ category: "timeline" }), "canon");
    assert.equal(inferIntentFromArgs({ category: "location", query: "某查询" }), "canon");
  });

  it("唯一判别字段优先级高于 query：status+query → promise（非 evidence）", () => {
    // 即使有 query，status 仍优先（promise_ledger 不需要 query，但模型可能误填）
    assert.equal(inferIntentFromArgs({ status: "open", query: "承诺查询" }), "promise");
  });

  // ── 2. query + maxChapters 组合（高置信）──────────────────────────────

  it("query + maxChapters → chapter_span（maxChapters 仅 chapter_span 暴露）", () => {
    assert.equal(inferIntentFromArgs({ query: "林默", maxChapters: 5 }), "chapter_span");
    assert.equal(inferIntentFromArgs({ query: "某查询", maxChapters: 10, maxResults: 5 }), "chapter_span");
  });

  it("query（无 maxChapters）→ evidence（默认首选，事实核验优先）", () => {
    assert.equal(inferIntentFromArgs({ query: "林默" }), "evidence");
    assert.equal(inferIntentFromArgs({ query: "某查询", maxResults: 5 }), "evidence");
  });

  // ── 3. characterId（低置信，三义性）───────────────────────────────────

  it("characterId（无其他判别字段）→ character_state（三义性中优先级最高）", () => {
    assert.equal(inferIntentFromArgs({ characterId: "林默" }), "character_state");
    assert.equal(inferIntentFromArgs({ characterId: "苏婉" }), "character_state");
  });

  it("characterId + query → evidence（query 优先级高于 characterId）", () => {
    // query 是中置信，characterId 是低置信；query 优先
    assert.equal(inferIntentFromArgs({ characterId: "林默", query: "苏婉" }), "evidence");
  });

  // ── 4. 无任何判别字段 → null（推断失败）────────────────────────────────

  it("空 args → null（推断失败，保留非法 intent）", () => {
    assert.equal(inferIntentFromArgs({}), null);
  });

  it("仅含无关字段 → null（无判别信号）", () => {
    assert.equal(inferIntentFromArgs({ maxResults: 5 }), null);
    assert.equal(inferIntentFromArgs({ foo: "bar" }), null);
    assert.equal(inferIntentFromArgs({ unknownField: 123 }), null);
  });
});

// ============================================================================
// 策略3 边界与健壮性测试
// ============================================================================

describe("B-safe 策略3 inferIntentFromArgs — 边界与健壮性", () => {
  it("空字符串字段不触发推断（避免空 status/query 误判）", () => {
    // 空字符串 status 不应推断为 promise
    assert.equal(inferIntentFromArgs({ status: "" }), null);
    // 空字符串 query 不应推断为 evidence
    assert.equal(inferIntentFromArgs({ query: "" }), null);
    // 空字符串 characterId 不应推断为 character_state
    assert.equal(inferIntentFromArgs({ characterId: "" }), null);
  });

  it("非字符串字段不触发推断（类型安全）", () => {
    // 数字 status 不应推断为 promise
    assert.equal(inferIntentFromArgs({ status: 123 }), null);
    // 数字 query 不应推断为 evidence
    assert.equal(inferIntentFromArgs({ query: 123 }), null);
  });

  it("maxChapters 非数字时不触发 chapter_span 推断（回退 evidence）", () => {
    // maxChapters 是字符串（非法类型）→ 不触发 chapter_span，但 query 仍存在 → evidence
    assert.equal(inferIntentFromArgs({ query: "林默", maxChapters: "5" }), "evidence");
  });

  it("多字段组合优先级：status + patternType + category + query → status 优先（promise）", () => {
    // 三个唯一判别字段同时存在，status 在优先级首位
    const result = inferIntentFromArgs({
      status: "open",
      patternType: "trope",
      category: "timeline",
      query: "某查询",
    });
    assert.equal(result, "promise");
  });

  it("多字段组合优先级：patternType + category + query → patternType 优先（pattern）", () => {
    // status 缺失，patternType 在剩余中优先
    const result = inferIntentFromArgs({
      patternType: "trope",
      category: "timeline",
      query: "某查询",
    });
    assert.equal(result, "pattern");
  });

  it("多字段组合优先级：category + query → category 优先（canon）", () => {
    // status/patternType 缺失，category 优先于 query
    const result = inferIntentFromArgs({
      category: "timeline",
      query: "某查询",
    });
    assert.equal(result, "canon");
  });
});
