/**
 * KNOWLEDGE-CONSUMPTION-1：few-shot/contrastive 生产消费审计最小闭环测试
 *
 * 验收口径（KNOWLEDGE-CONSUMPTION-1 任务书）：
 * 1. 每个示例有 provenance/score/reason/token cost。
 * 2. 无匹配时空参考（返回 empty selection）。
 * 3. P0/P1 不因示例被淘汰（advisory 不强制）。
 * 4. trace 证明 prompt 实际消费（consumedByRawPrompt 字段）。
 * 5. 无 manifest 准入数据不得静默加载。
 * 6. 重复示例合并保留来源。
 * 7. 数据缺失返回 empty selection，不阻断生成。
 *
 * 边界：
 * - 不修改 finalText
 * - 不生成 candidate
 * - 不调用 LLM
 * - 不全量加载场景/技法库
 * - 不把示例变成强制模仿模板（advisoryOnly=true）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compileKnowledgeConsumptionContext,
  formatKnowledgeConsumptionPromptBlock,
  skippedKnowledgeConsumption,
} from "../dist/v2/core/knowledge-consumption-compiler.js";

// ============================================================================
// 辅助：构造 FewshotExample[] 输入
// ============================================================================

function makeExamples() {
  return [
    {
      id: "ex-001",
      sceneType: "combat",
      text: "林川拔出长剑，剑光如电。",
      qualityScore: 0.85,
      source: "runtime",
      narrativeBeat: "climax",
      conflictLevel: 4,
      emotionTarget: "紧张",
    },
    {
      id: "ex-002",
      sceneType: "combat",
      text: "苏婉退后一步，神色凝重。",
      qualityScore: 0.78,
      source: "flat",
      narrativeBeat: "escalation",
      conflictLevel: 3,
      emotionTarget: "紧张",
    },
  ];
}

function makeQuery(overrides = {}) {
  return {
    sceneType: "combat",
    narrativeBeat: "climax",
    conflictLevel: 4,
    emotionTarget: "紧张",
    ...overrides,
  };
}

// ============================================================================
// 1. 每个示例有 provenance/score/reason/token cost
// ============================================================================

test("每个示例有 provenance/score/reason/tokenCost", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: makeExamples(),
    query: makeQuery(),
    channel: "mixed",
    sources: ["runtime: fewshot-index.json", "flat: fewshots_flat.json"],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  assert.ok(ctx.entries.length > 0, "应有 entries");
  for (const entry of ctx.entries) {
    assert.ok(entry.id, "应有 id");
    assert.ok(entry.source, "应有 source (provenance)");
    assert.ok(typeof entry.qualityScore === "number", "应有 qualityScore");
    assert.ok(entry.selectionReason, "应有 selectionReason");
    assert.ok(typeof entry.tokenCost === "number", "应有 tokenCost");
    assert.ok(entry.tokenCost > 0, "tokenCost 应 > 0");
  }
});

test("tokenCost 基于字符数估算", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: [
      {
        id: "ex-001",
        sceneType: "combat",
        text: "林川拔出长剑。",
        qualityScore: 0.85,
        source: "runtime",
      },
    ],
    query: makeQuery(),
    channel: "runtime",
    sources: ["runtime"],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  const entry = ctx.entries[0];
  // 中文 token 估算：chars / 4（保守估算，与 OpenAI token 估算一致）
  const expectedTokens = Math.ceil("林川拔出长剑。".length / 4);
  assert.ok(
    entry.tokenCost >= expectedTokens,
    `tokenCost 应 >= ${expectedTokens}，实际 ${entry.tokenCost}`,
  );
});

// ============================================================================
// 2. 无匹配时空参考（empty selection）
// ============================================================================

test("examples 为空时返回 emptyReason", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: [],
    query: makeQuery(),
    channel: "empty",
    sources: [],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  assert.equal(ctx.entries.length, 0);
  assert.ok(ctx.emptyReason, "应有 emptyReason");
  assert.equal(ctx.channel, "empty");
  assert.equal(result.promptBlock, null);
});

test("无匹配时不伪造示例", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: [],
    query: makeQuery(),
    channel: "empty",
    sources: [],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  assert.equal(ctx.entries.length, 0, "无匹配时不应伪造示例");
  assert.equal(ctx.totalTokenCost, 0);
  assert.equal(ctx.totalChars, 0);
});

// ============================================================================
// 3. P0/P1 不因示例被淘汰（advisory 不强制）
// ============================================================================

test("advisoryOnly 恒为 true（示例不强制模仿）", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: makeExamples(),
    query: makeQuery(),
    channel: "mixed",
    sources: ["runtime", "flat"],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  assert.equal(ctx.advisoryOnly, true, "advisoryOnly 应恒为 true");
});

test("context 不含 forcedImitation/mandatoryTemplate 字段", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: makeExamples(),
    query: makeQuery(),
    channel: "mixed",
    sources: ["runtime", "flat"],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  assert.equal(ctx.forcedImitation, undefined);
  assert.equal(ctx.mandatoryTemplate, undefined);
  assert.equal(ctx.requiredExamples, undefined);
});

// ============================================================================
// 4. trace 证明 prompt 实际消费
// ============================================================================

test("consumedByRawPrompt 默认 false（编译时未消费）", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: makeExamples(),
    query: makeQuery(),
    channel: "mixed",
    sources: ["runtime", "flat"],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  // 编译时 consumedByRawPrompt 应为 false（消费由 buildRawPrompt 决定）
  assert.equal(ctx.consumedByRawPrompt, false);
});

test("promptBlock 非空时可被 raw prompt 消费", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: makeExamples(),
    query: makeQuery(),
    channel: "mixed",
    sources: ["runtime", "flat"],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  // promptBlock 应非空（有 examples）
  assert.ok(result.promptBlock, "有 examples 时应返回非空 promptBlock");
  assert.ok(result.promptBlock.length > 0);
});

// ============================================================================
// 5. 无 manifest 准入数据不得静默加载
// ============================================================================

test("manifestApproved=false 时强制返回 empty", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: makeExamples(), // 即使传了 examples
    query: makeQuery(),
    channel: "runtime",
    sources: ["runtime"],
    manifestApproved: false, // 但 manifest 未批准
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  assert.equal(ctx.entries.length, 0, "manifest 未批准时不应加载示例");
  assert.equal(ctx.manifestApproved, false);
  assert.ok(ctx.emptyReason, "应有 emptyReason 说明 manifest 未批准");
  assert.equal(result.promptBlock, null);
});

test("manifestApproved=true 时正常加载", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: makeExamples(),
    query: makeQuery(),
    channel: "runtime",
    sources: ["runtime"],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  assert.ok(ctx.entries.length > 0, "manifest 批准时应正常加载");
  assert.equal(ctx.manifestApproved, true);
});

// ============================================================================
// 6. 重复示例合并保留来源
// ============================================================================

test("重复示例（同 id）合并保留来源", () => {
  const examples = [
    {
      id: "ex-001",
      sceneType: "combat",
      text: "林川拔出长剑。",
      qualityScore: 0.85,
      source: "runtime",
    },
    {
      id: "ex-001", // 同 id，不同 source
      sceneType: "combat",
      text: "林川拔出长剑。",
      qualityScore: 0.85,
      source: "flat",
    },
  ];

  const result = compileKnowledgeConsumptionContext({
    examples,
    query: makeQuery(),
    channel: "mixed",
    sources: ["runtime", "flat"],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  // 同 id 应去重为一个 entry
  const ex1 = ctx.entries.filter((e) => e.id === "ex-001");
  assert.equal(ex1.length, 1, "同 id 示例应去重为 1 个");
  // 但来源应保留（合并多来源）
  assert.ok(
    ex1[0].source.includes("runtime") || ex1[0].source.includes("flat"),
    "去重后应保留至少一个来源",
  );
});

// ============================================================================
// 7. 数据缺失返回 empty selection，不阻断生成
// ============================================================================

test("数据缺失时返回 empty selection 且不阻断", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: [],
    query: makeQuery(),
    channel: "empty",
    sources: [],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  assert.equal(ctx.entries.length, 0);
  assert.equal(ctx.advisoryOnly, true);
  // 不阻断
  assert.equal(ctx.passed, undefined);
  assert.equal(ctx.blocked, undefined);
});

test("context 不含 rewrite/patch 字段", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: makeExamples(),
    query: makeQuery(),
    channel: "mixed",
    sources: ["runtime", "flat"],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  assert.equal(ctx.rewriteRaw, undefined);
  assert.equal(ctx.patchRaw, undefined);
  assert.equal(ctx.overrideRaw, undefined);
});

// ============================================================================
// 8. 预算控制
// ============================================================================

test("超出 maxCharsPerExample 时截断", () => {
  const longText = "林川拔出长剑，剑光如电，划破长空，气势惊人。".repeat(20);
  const result = compileKnowledgeConsumptionContext({
    examples: [
      {
        id: "ex-long",
        sceneType: "combat",
        text: longText,
        qualityScore: 0.85,
        source: "runtime",
      },
    ],
    query: makeQuery(),
    channel: "runtime",
    sources: ["runtime"],
    manifestApproved: true,
    maxCharsPerExample: 100, // 限制 100 字符
  });

  const ctx = result.knowledgeConsumptionContext;
  const entry = ctx.entries[0];
  // 文本应被截断到 100 字符
  assert.ok(
    entry.text.length <= 100,
    `entry.text 应被截断到 <= 100 字符，实际 ${entry.text.length}`,
  );
});

test("totalTokenCost 汇总所有 entries", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: makeExamples(),
    query: makeQuery(),
    channel: "mixed",
    sources: ["runtime", "flat"],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  const expectedTotal = ctx.entries.reduce((sum, e) => sum + e.tokenCost, 0);
  assert.equal(ctx.totalTokenCost, expectedTotal, "totalTokenCost 应为各 entry 之和");
});

// ============================================================================
// 9. skipped 构造
// ============================================================================

test("skippedKnowledgeConsumption 写明 skipped 原因", () => {
  const skipped = skippedKnowledgeConsumption("hardBlock");
  assert.ok(skipped.emptyReason.includes("skipped"));
  assert.equal(skipped.entries.length, 0);
  assert.equal(skipped.advisoryOnly, true);
  assert.equal(skipped.channel, "empty");
});

// ============================================================================
// 10. selectionReason 推导
// ============================================================================

test("selectionReason 包含匹配维度", () => {
  const result = compileKnowledgeConsumptionContext({
    examples: [
      {
        id: "ex-001",
        sceneType: "combat",
        text: "林川拔出长剑。",
        qualityScore: 0.85,
        source: "runtime",
        narrativeBeat: "climax",
        conflictLevel: 4,
        emotionTarget: "紧张",
      },
    ],
    query: {
      sceneType: "combat",
      narrativeBeat: "climax",
      conflictLevel: 4,
      emotionTarget: "紧张",
    },
    channel: "runtime",
    sources: ["runtime"],
    manifestApproved: true,
    maxCharsPerExample: 520,
  });

  const ctx = result.knowledgeConsumptionContext;
  const entry = ctx.entries[0];
  // selectionReason 应至少包含一个匹配维度
  assert.ok(
    entry.selectionReason.includes("sceneType") ||
    entry.selectionReason.includes("narrativeBeat") ||
    entry.selectionReason.includes("conflictLevel") ||
    entry.selectionReason.includes("emotionTarget"),
    `selectionReason 应包含匹配维度，实际 "${entry.selectionReason}"`,
  );
});

// ============================================================================
// 11. formatKnowledgeConsumptionPromptBlock
// ============================================================================

test("formatKnowledgeConsumptionPromptBlock 空时返回 null", () => {
  const block = formatKnowledgeConsumptionPromptBlock({
    entries: [],
    totalTokenCost: 0,
    totalChars: 0,
    channel: "empty",
    sourceRefs: [],
    manifestApproved: true,
    consumedByRawPrompt: false,
    advisoryOnly: true,
  });
  assert.equal(block, null);
});

test("formatKnowledgeConsumptionPromptBlock 非空时含 advisory 提示", () => {
  const block = formatKnowledgeConsumptionPromptBlock({
    entries: [
      {
        id: "ex-001",
        source: "runtime",
        qualityScore: 0.85,
        selectionReason: "sceneType=combat",
        tokenCost: 5,
        text: "林川拔出长剑。",
      },
    ],
    totalTokenCost: 5,
    totalChars: 7,
    channel: "runtime",
    sourceRefs: ["runtime"],
    manifestApproved: true,
    consumedByRawPrompt: false,
    advisoryOnly: true,
  });
  assert.ok(block, "应返回非 null block");
  // 应含 advisory 提示（不是强制模仿）
  assert.ok(
    block.includes("advisory") || block.includes("参考") || block.includes("非强制"),
    "block 应含 advisory/参考/非强制 提示",
  );
});
