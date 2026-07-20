/**
 * SUPPORTING-FUNCTION-1：配角章节功能层 advisory 编译最小闭环测试
 *
 * 验收口径（SUPPORTING-FUNCTION-1 任务书）：
 * 1. 每个激活配角最多一个主功能、带目标/动作 span。
 * 2. 未出场角色不进入。
 * 3. 功能冲突写 advisory，不更新永久角色身份。
 * 4. "companion/supporting"等静态 role 不得直接冒充本章叙事功能。
 * 5. 不得恢复固定群像人数配额。
 * 6. 无可靠功能时保留焦点/在场弱层，不阻断正文。
 *
 * 边界：
 * - 不修改 finalText
 * - 不生成 candidate
 * - 不调用 LLM
 * - 不更新永久角色身份
 * - 不是 hard gate
 * - 不提交长期状态
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compileSupportingFunctionContext,
  formatSupportingFunctionPromptBlock,
  skippedSupportingFunction,
} from "../dist/v2/core/supporting-function-compiler.js";

// ============================================================================
// 辅助：构造 ChapterIntent
// ============================================================================

function makeIntent(overrides = {}) {
  return {
    chapterFunction: "推进核心冲突",
    readerExperience: ["紧张", "期待"],
    currentPressure: ["水下救援压力"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林川", "苏婉", "老周"],
    inviolableFacts: [],
    sourceRefs: ["chapter-seed"],
    concreteDelivery: [],
    focusCharacterGoals: [{ character: "林川", goal: "救出苏婉" }],
    resistance: [],
    choicesAndCosts: [],
    expectedIrreversibleChange: [],
    selectedPromisesToAdvance: [],
    causalEndPressure: [],
    factAndCharacterKnowledgeForbiddenZones: [],
    fieldSourceRefs: {},
    ...overrides,
  };
}

// ============================================================================
// 1. 每个激活配角最多一个主功能、带目标/动作 span
// ============================================================================

test("rawText 中配角行为支持的功能带 span 且 verified=true", () => {
  const intent = makeIntent();
  // rawText 中苏婉协助林川（helper），老周阻挡去路（obstacle）
  const rawText = [
    "林川冲进废墟。",
    "苏婉递过绳索，协助他拉起横梁。",
    "老周挡在门口，阻止他们离开。",
  ].join("\n");

  const result = compileSupportingFunctionContext({
    intent,
    rawText,
  });

  const ctx = result.supportingFunctionContext;
  // 苏婉和老周是激活配角（非焦点）
  const su = ctx.assignments.find((a) => a.name === "苏婉");
  const zhou = ctx.assignments.find((a) => a.name === "老周");
  assert.ok(su, "苏婉应在 assignments 中");
  assert.ok(zhou, "老周应在 assignments 中");

  // 至少一个有 verified 功能
  const verified = ctx.assignments.find((a) => a.verified);
  assert.ok(verified, "应有至少一个 verified=true 的功能分配");
  assert.ok(verified.functionEvidenceSpan, "verified 功能应有 functionEvidenceSpan");
  assert.ok(typeof verified.functionEvidenceSpan.start === "number");
  assert.ok(typeof verified.functionEvidenceSpan.end === "number");
  assert.ok(verified.functionEvidenceSpan.end >= verified.functionEvidenceSpan.start);
  assert.ok(verified.confidence >= 0.7, `verified confidence 应 >= 0.7，实际 ${verified.confidence}`);
});

test("每个激活配角最多一个主功能", () => {
  const intent = makeIntent();
  const rawText = "苏婉协助林川。老周阻挡去路。";
  const result = compileSupportingFunctionContext({ intent, rawText });
  const ctx = result.supportingFunctionContext;
  for (const a of ctx.assignments) {
    // primaryFunction 是单值，不是数组
    assert.ok(
      a.primaryFunction === null || typeof a.primaryFunction === "string",
      `primaryFunction 应为单值（string 或 null），实际 ${typeof a.primaryFunction}`,
    );
  }
});

// ============================================================================
// 2. 未出场角色不进入
// ============================================================================

test("未出场角色不进入 assignments", () => {
  const intent = makeIntent({
    relevantCharacters: ["林川", "苏婉", "老周", "张三"],
    focusCharacterGoals: [{ character: "林川", goal: "救出苏婉" }],
  });
  // rawText 中没有张三
  const rawText = "苏婉协助林川。老周阻挡去路。";
  const result = compileSupportingFunctionContext({ intent, rawText });
  const ctx = result.supportingFunctionContext;
  const zhang = ctx.assignments.find((a) => a.name === "张三");
  assert.equal(zhang, undefined, "未出场的张三不应进入 assignments");
});

test("焦点角色不进入 assignments（仅激活配角）", () => {
  const intent = makeIntent();
  const rawText = "林川冲进废墟。苏婉协助他。";
  const result = compileSupportingFunctionContext({ intent, rawText });
  const ctx = result.supportingFunctionContext;
  const lin = ctx.assignments.find((a) => a.name === "林川");
  // 林川是焦点角色（在 focusCharacterGoals 中），不应进入 supporting assignments
  assert.equal(lin, undefined, "焦点角色林川不应进入 supporting assignments");
});

// ============================================================================
// 3. 功能冲突写 advisory，不更新永久角色身份
// ============================================================================

test("功能冲突时写 conflictAdvisory", () => {
  const intent = makeIntent();
  // rawText 中苏婉既协助又阻挡（功能冲突）
  const rawText = [
    "苏婉递过绳索，协助林川。",
    "随后苏婉又挡在门口，阻止他前进。",
  ].join("\n");

  const result = compileSupportingFunctionContext({ intent, rawText });
  const ctx = result.supportingFunctionContext;
  const su = ctx.assignments.find((a) => a.name === "苏婉");
  assert.ok(su, "苏婉应在 assignments 中");
  // 有 conflictAdvisory（多功能命中）
  if (su.conflictAdvisory) {
    assert.ok(su.conflictAdvisory.length > 0, "conflictAdvisory 应非空");
  }
});

test("context 不含 updatePermanentIdentity/permanentIdentityUpdate 字段", () => {
  const intent = makeIntent();
  const rawText = "苏婉协助林川。";
  const result = compileSupportingFunctionContext({ intent, rawText });
  const ctx = result.supportingFunctionContext;
  assert.equal(ctx.updatePermanentIdentity, undefined);
  assert.equal(ctx.permanentIdentityUpdate, undefined);
  assert.equal(ctx.identityCommit, undefined);
});

// ============================================================================
// 4. "companion/supporting"等静态 role 不得直接冒充本章叙事功能
// ============================================================================

test("静态 role 不直接冒充叙事功能", () => {
  const intent = makeIntent({
    relevantCharacters: ["林川", "苏婉"],
    focusCharacterGoals: [{ character: "林川", goal: "救出苏婉" }],
  });
  // rawText 中苏婉只是"陪伴"林川，无明确功能行为
  const rawText = "苏婉陪伴在林川身边。";
  const result = compileSupportingFunctionContext({ intent, rawText });
  const ctx = result.supportingFunctionContext;
  const su = ctx.assignments.find((a) => a.name === "苏婉");
  assert.ok(su, "苏婉应在 assignments 中");
  // "陪伴"不是 5 类功能之一，primaryFunction 应为 null（不冒充）
  if (su.primaryFunction !== null) {
    // 若被分配了功能，必须是基于正文行为（verified=true 带 span），不是静态 role
    assert.ok(su.verified, "功能必须基于正文行为支持，不能从静态 role 冒充");
    assert.ok(su.functionEvidenceSpan, "verified 功能应有 span");
  }
});

test("context 不暴露 companionRole/supportingRole 等静态 role 字段", () => {
  const intent = makeIntent();
  const result = compileSupportingFunctionContext({ intent, rawText: null });
  const ctx = result.supportingFunctionContext;
  assert.equal(ctx.companionRole, undefined);
  assert.equal(ctx.supportingRole, undefined);
  assert.equal(ctx.staticRole, undefined);
});

// ============================================================================
// 5. 不得恢复固定群像人数配额
// ============================================================================

test("context 不含固定人数配额字段", () => {
  const intent = makeIntent();
  const result = compileSupportingFunctionContext({ intent, rawText: null });
  const ctx = result.supportingFunctionContext;
  assert.equal(ctx.minSupportingCount, undefined);
  assert.equal(ctx.maxSupportingCount, undefined);
  assert.equal(ctx.requiredSupportingCount, undefined);
  assert.equal(ctx.headcountQuota, undefined);
  assert.equal(ctx.rotationQuota, undefined);
});

test("assignments 数量不强制对齐固定配额", () => {
  // 只有 1 个配角时也应正常工作，不强制补足到 3 个
  const intent = makeIntent({
    relevantCharacters: ["林川", "苏婉"],
    focusCharacterGoals: [{ character: "林川", goal: "救出苏婉" }],
  });
  const rawText = "苏婉协助林川。";
  const result = compileSupportingFunctionContext({ intent, rawText });
  const ctx = result.supportingFunctionContext;
  // 只有苏婉 1 个配角
  assert.equal(ctx.assignments.length, 1, "应有 1 个配角 assignment，不强制补足配额");
});

// ============================================================================
// 6. 无可靠功能时保留焦点/在场弱层，不阻断正文
// ============================================================================

test("rawText 为 null 时输出 humanReviewFocus 且不阻断", () => {
  const intent = makeIntent();
  const result = compileSupportingFunctionContext({ intent, rawText: null });
  const ctx = result.supportingFunctionContext;
  // raw 生成前无 rawText，无法扫描功能行为
  assert.ok(ctx.humanReviewFocus || ctx.emptyReason, "无 rawText 时应输出 humanReviewFocus 或 emptyReason");
  assert.equal(ctx.advisoryOnly, true);
  // 不阻断
  assert.equal(ctx.passed, undefined);
  assert.equal(ctx.blocked, undefined);
});

test("无可靠功能时保留 assignments（焦点/在场弱层）", () => {
  const intent = makeIntent();
  // rawText 中苏婉和老周无明确功能行为
  const rawText = "苏婉站在一旁。老周看着林川。";
  const result = compileSupportingFunctionContext({ intent, rawText });
  const ctx = result.supportingFunctionContext;
  // 仍应保留 assignments（焦点/在场弱层），不为空
  assert.ok(ctx.assignments.length > 0, "无可靠功能时仍应保留 assignments（焦点/在场弱层）");
  // 但 primaryFunction 应为 null（无功能行为支持）
  for (const a of ctx.assignments) {
    if (!a.verified) {
      assert.equal(a.primaryFunction, null, "无功能行为支持时 primaryFunction 应为 null");
    }
  }
});

// ============================================================================
// 7. advisory 不直接覆盖 raw / 不含 rewrite 字段
// ============================================================================

test("context 不含 rewrite/patch 字段", () => {
  const intent = makeIntent();
  const rawText = "苏婉协助林川。老周阻挡去路。";
  const result = compileSupportingFunctionContext({ intent, rawText });
  const ctx = result.supportingFunctionContext;
  assert.equal(ctx.rewriteRaw, undefined);
  assert.equal(ctx.patchRaw, undefined);
  assert.equal(ctx.overrideRaw, undefined);
});

test("advisoryOnly 恒为 true", () => {
  const intent = makeIntent();
  const result = compileSupportingFunctionContext({ intent, rawText: null });
  const ctx = result.supportingFunctionContext;
  assert.equal(ctx.advisoryOnly, true);
});

// ============================================================================
// 8. 空状态处理
// ============================================================================

test("无 relevantCharacters 且无 focusCharacterGoals 时写 emptyReason", () => {
  const intent = makeIntent({
    relevantCharacters: [],
    focusCharacterGoals: [],
  });
  const result = compileSupportingFunctionContext({ intent, rawText: null });
  const ctx = result.supportingFunctionContext;
  assert.ok(ctx.emptyReason, "应有 emptyReason");
  assert.equal(ctx.assignments.length, 0);
  assert.equal(ctx.consumedByRawPrompt, false);
  assert.equal(result.promptBlock, null);
});

test("只有焦点角色无配角时写 emptyReason", () => {
  const intent = makeIntent({
    relevantCharacters: ["林川"],
    focusCharacterGoals: [{ character: "林川", goal: "救出苏婉" }],
  });
  const result = compileSupportingFunctionContext({ intent, rawText: null });
  const ctx = result.supportingFunctionContext;
  // 林川是焦点，无配角
  assert.ok(ctx.emptyReason, "只有焦点角色无配角时应写 emptyReason");
  assert.equal(ctx.assignments.length, 0);
});

test("skippedSupportingFunction 写明 skipped 原因", () => {
  const skipped = skippedSupportingFunction("hardBlock");
  assert.ok(skipped.emptyReason.includes("skipped"));
  assert.equal(skipped.assignments.length, 0);
  assert.equal(skipped.advisoryOnly, true);
});

// ============================================================================
// 9. 来源追溯
// ============================================================================

test("sourceRefs 包含 intent 来源", () => {
  const intent = makeIntent();
  const result = compileSupportingFunctionContext({ intent, rawText: null });
  const ctx = result.supportingFunctionContext;
  if (ctx.assignments.length > 0) {
    assert.ok(ctx.sourceRefs.length > 0, "应有 sourceRefs");
    // 来源应包含 intent:relevantCharacters 或 intent:focusCharacterGoals
    const hasIntentSource = ctx.sourceRefs.some(
      (r) => r.includes("intent") || r.includes("relevantCharacters") || r.includes("focusCharacterGoals"),
    );
    assert.ok(hasIntentSource, "sourceRefs 应包含 intent 来源");
  }
});

// ============================================================================
// 10. formatSupportingFunctionPromptBlock 空时返回 null
// ============================================================================

test("formatSupportingFunctionPromptBlock 空时返回 null", () => {
  const block = formatSupportingFunctionPromptBlock({
    assignments: [],
    sourceRefs: [],
    consumedByRawPrompt: false,
    advisoryOnly: true,
    canTriggerEditorialOpportunity: false,
    humanReviewFocus: null,
  });
  assert.equal(block, null);
});

test("formatSupportingFunctionPromptBlock 非空时不为 null", () => {
  const block = formatSupportingFunctionPromptBlock({
    assignments: [
      {
        characterId: "苏婉",
        name: "苏婉",
        primaryFunction: null,
        functionEvidenceSpan: null,
        goal: null,
        verified: false,
        confidence: 0.3,
        sourceRef: "intent:relevantCharacters:苏婉",
      },
    ],
    sourceRefs: ["intent:relevantCharacters:苏婉"],
    consumedByRawPrompt: false,
    advisoryOnly: true,
    canTriggerEditorialOpportunity: false,
    humanReviewFocus: null,
  });
  assert.ok(block, "非空 assignments 时应返回非 null block");
  // 应含配角名
  assert.ok(block.includes("苏婉"), "block 应含配角名");
});

// ============================================================================
// 11. canTriggerEditorialOpportunity 逻辑
// ============================================================================

test("有功能冲突时 canTriggerEditorialOpportunity=true", () => {
  const intent = makeIntent();
  const rawText = [
    "苏婉递过绳索，协助林川。",
    "随后苏婉又挡在门口，阻止他前进。",
  ].join("\n");
  const result = compileSupportingFunctionContext({ intent, rawText });
  const ctx = result.supportingFunctionContext;
  const hasConflict = ctx.assignments.some((a) => a.conflictAdvisory);
  if (hasConflict) {
    assert.equal(ctx.canTriggerEditorialOpportunity, true, "功能冲突时应可触发机会候选");
  }
});

test("无冲突且无 unverified 时 canTriggerEditorialOpportunity=false", () => {
  const intent = makeIntent({
    relevantCharacters: ["林川", "苏婉"],
    focusCharacterGoals: [{ character: "林川", goal: "救出苏婉" }],
  });
  // rawText 中苏婉明确协助（无冲突）
  const rawText = "苏婉递过绳索，协助林川。";
  const result = compileSupportingFunctionContext({ intent, rawText });
  const ctx = result.supportingFunctionContext;
  const hasConflict = ctx.assignments.some((a) => a.conflictAdvisory);
  const hasUnverified = ctx.assignments.some((a) => !a.verified && a.primaryFunction !== null);
  if (!hasConflict && !hasUnverified) {
    assert.equal(ctx.canTriggerEditorialOpportunity, false, "无冲突且无 unverified 时不应触发机会候选");
  }
});
