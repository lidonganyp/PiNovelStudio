/**
 * Phase 3 P0 第三轮验收生产探针
 *
 * 覆盖用户验收反例（5 组）：
 * - P0-1 Story Preservation 放过剧情删除和反转（4 组）：
 *   1. "交给玉玺并放行" → "看玉玺并留下"：replaced=2 但未阻断
 *   2. "攻击" → "看一眼"
 *   3. "拿起" → "放下"
 *   4. "防御攻击" → "主动攻击"
 * - P0-2 境界状态提交给错误角色（1 组）：
 *   5. 正文 "林默踏入筑基期。叶尘在门外等待。" + 计划状态 叶尘 realm=筑基期 → committed=1
 *
 * 修复目标：
 * - P0-1：严格主体绑定 + 扩充关键动作表（攻击/防御/拿起/放下）+ 按句中位置选动词
 * - P0-2：境界句不含目标角色时 fail-closed
 *
 * 不调用真实模型，纯规则测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractEvents } from "../dist/v2/core/event-extractor.js";
import { compareEventLedgers } from "../dist/v2/core/event-ledger-comparator.js";
import {
  validateSemanticSupport,
} from "../dist/v2/core/final-state-commit.js";

// ============================================================================
// 辅助函数
// ============================================================================

function buildLedgerInput(rawText, editorialText, entities = []) {
  const rawResult = extractEvents(rawText, entities, { entityCoverage: "full_entities" });
  const editorialResult = extractEvents(editorialText, entities, { entityCoverage: "full_entities" });
  return {
    rawEvents: rawResult.events,
    editorialEvents: editorialResult.events,
    rawCausalChains: rawResult.causalChains,
    editorialCausalChains: editorialResult.causalChains,
    knownEntities: entities,
    entityCoverage: "full_entities",
    rawText,
    editorialText,
  };
}

function makeCharacterEntry(characterId, field, value) {
  return {
    id: `character:${characterId}:${field}`,
    kind: "character",
    characterId,
    field,
    value,
    sourceChapter: "ch5",
    sourceRef: "seed:ch5",
    confidence: 0.5,
    lastUpdated: new Date().toISOString(),
  };
}

// ============================================================================
// P0-1: Story Preservation 剧情反转/删除检测
// ============================================================================

describe("P0-1 第三轮：Story Preservation 剧情反转/删除阻断", () => {
  it("反例1: '交给玉玺并放行' → '看玉玺并留下' 应阻断", () => {
    const raw = "交给玉玺并放行";
    const editorial = "看玉玺并留下";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, ["玉玺"]));
    assert.equal(
      result.preserved,
      false,
      `应阻断剧情反转（交出→看/放行→留下），实际 preserved=true。reason: ${result.reason}`,
    );
    assert.equal(result.unverifiable, false, "不应为 unverifiable");
  });

  it("反例2: '攻击' → '看一眼' 应阻断", () => {
    const raw = "攻击";
    const editorial = "看一眼";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, []));
    assert.equal(
      result.preserved,
      false,
      `应阻断关键动作替换（攻击→看），实际 preserved=true。reason: ${result.reason}`,
    );
    assert.equal(result.unverifiable, false, "不应为 unverifiable");
  });

  it("反例3: '拿起' → '放下' 应阻断", () => {
    const raw = "拿起";
    const editorial = "放下";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, []));
    assert.equal(
      result.preserved,
      false,
      `应阻断关键动作替换（拿起→放下），实际 preserved=true。reason: ${result.reason}`,
    );
    assert.equal(result.unverifiable, false, "不应为 unverifiable");
  });

  it("反例4: '防御攻击' → '主动攻击' 应阻断", () => {
    const raw = "防御攻击";
    const editorial = "主动攻击";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, []));
    assert.equal(
      result.preserved,
      false,
      `应阻断关键动作替换（防御→攻击），实际 preserved=true。reason: ${result.reason}`,
    );
    assert.equal(result.unverifiable, false, "不应为 unverifiable");
  });

  it("反例4 验证: '防御攻击' 抽取的 action 应为 '防御'（句中位置最早）", () => {
    const rawResult = extractEvents("防御攻击", [], { entityCoverage: "full_entities" });
    const extractable = rawResult.events.filter((e) => e.extractable);
    assert.ok(extractable.length > 0, "应至少抽取到 1 个事件");
    const action = extractable[0].action;
    assert.equal(
      action,
      "防御",
      `'防御攻击' 的主动作应为 '防御'（句中位置 0），实际为 '${action}'`,
    );
  });
});

// ============================================================================
// P0-2: 境界状态 fail-closed
// ============================================================================

describe("P0-2 第三轮：境界状态错误归属 fail-closed", () => {
  it("反例5: '林默踏入筑基期。叶尘在门外等待。' + 叶尘 realm=筑基期 应拒绝", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默踏入筑基期。叶尘在门外等待。";
    // 模拟 reanchor 中的 nameSpan 查找：查找境界值在正文中的位置
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      false,
      `境界句不含目标角色时应 fail-closed，实际 supported=true。reason: ${result.reason}`,
    );
    assert.ok(
      result.reason.includes("叶尘") || result.reason.includes("fail-closed"),
      `reason 应提及角色或 fail-closed，实际: ${result.reason}`,
    );
  });

  it("对照: '叶尘踏入筑基期' + 叶尘 realm=筑基期 应通过", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "叶尘踏入筑基期。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      true,
      `境界句含目标角色同子句时应通过，实际 supported=false。reason: ${result.reason}`,
    );
  });
});
