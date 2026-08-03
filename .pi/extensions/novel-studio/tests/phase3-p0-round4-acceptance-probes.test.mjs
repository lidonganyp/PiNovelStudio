/**
 * P0 第四轮验收探针：事件语义角色、否定/未遂、一对一匹配和境界主体绑定
 *
 * 覆盖用户验收发现的 5 组新反例 + 1 组境界反例 + 2 组同义改写对照：
 * 1. "叶尘攻击林默" → "林默攻击叶尘"（主客体反转）
 * 2. "没有攻击" → "攻击"（否定被移除）
 * 3. "差点杀死" → "杀死"（未遂→实际）
 * 4. 两次攻击删除其中一次（一对一匹配 + 重复事件删除）
 * 5. "攻击" → "沉默不语"（动作→非动作）
 * 6. "林默已是筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期（境界状态动词覆盖）
 * 7. "交给" → "递给"（同义改写，应通过）
 * 8. "离开" → "走出"（同义改写，应通过）
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractEvents } from "../dist/v2/core/event-extractor.js";
import { compareEventLedgers } from "../dist/v2/core/event-ledger-comparator.js";
import {
  validateSemanticSupport,
  reanchorStagedStateToFinalText,
} from "../dist/v2/core/final-state-commit.js";

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
    sourceRef: "ch5#seed:intent",
    confidence: 0.8,
    lastUpdated: new Date().toISOString(),
  };
}

describe("P0 第四轮：Story Preservation 事件语义检测", () => {
  it("反例1: '叶尘攻击林默' → '林默攻击叶尘' 应阻断（主客体反转）", () => {
    const raw = "叶尘攻击林默。";
    const editorial = "林默攻击叶尘。";
    const entities = ["叶尘", "林默"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `主客体反转应阻断（叶尘攻击林默→林默攻击叶尘），实际 preserved=true。reason: ${result.reason}`,
    );
    assert.ok(
      result.replacedEvents.length > 0,
      `应检测到替换事件，实际 replacedEvents=${result.replacedEvents.length}`,
    );
    const hasSwap = result.replacedEvents.some((e) => e.reversal === true);
    assert.ok(hasSwap, `应检测到主客体反转，实际: ${JSON.stringify(result.replacedEvents.map((e) => ({ reversal: e.reversal, reason: e.reason })))}`);
  });

  it("反例2: '没有攻击' → '攻击' 应阻断（否定被移除）", () => {
    const raw = "叶尘没有攻击林默。";
    const editorial = "叶尘攻击林默。";
    const entities = ["叶尘", "林默"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `否定被移除应阻断（没有攻击→攻击），实际 preserved=true。reason: ${result.reason}`,
    );
  });

  it("反例3: '差点杀死' → '杀死' 应阻断（未遂→实际）", () => {
    const raw = "叶尘差点杀死林默。";
    const editorial = "叶尘杀死林默。";
    const entities = ["叶尘", "林默"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `未遂→实际应阻断（差点杀死→杀死），实际 preserved=true。reason: ${result.reason}`,
    );
  });

  it("反例4: 两次攻击删除其中一次应阻断（一对一匹配 + 重复事件删除）", () => {
    const raw = "叶尘攻击林默。叶尘再次攻击林默。";
    const editorial = "叶尘攻击林默。";
    const entities = ["叶尘", "林默"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `删除两次攻击中的一次应阻断，实际 preserved=true。reason: ${result.reason}`,
    );
  });

  it("反例5: '攻击' → '沉默不语' 应阻断（动作→非动作）", () => {
    const raw = "叶尘攻击林默。";
    const editorial = "叶尘沉默不语。林默站在原地。";
    const entities = ["叶尘", "林默"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `动作→非动作应阻断（攻击→沉默不语），实际 preserved=true。reason: ${result.reason}`,
    );
  });
});

describe("P0 第四轮：境界状态动词覆盖", () => {
  it("反例6: '林默已是筑基期。叶尘在门外等待。' + 叶尘 realm=筑基期 应拒绝", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默已是筑基期。叶尘在门外等待。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      false,
      `'已是' 境界句不含目标角色时应 fail-closed，实际 supported=true。reason: ${result.reason}`,
    );
  });

  it("反例6 端到端: reanchor 不应提交 叶尘 realm=筑基期", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默已是筑基期。叶尘在门外等待。";
    const staged = {
      additions: [entry],
      invalidations: [],
      sourceChapter: "ch5",
    };
    const reanchored = reanchorStagedStateToFinalText(staged, finalText, 5);
    const realmEntry = reanchored.additions.find((e) => e.kind === "character" && e.field === "realm");
    assert.ok(realmEntry, "应找到 realm entry");
    assert.ok(
      realmEntry.sourceRef.includes("semantic-conflict") || realmEntry.confidence < 0.5,
      `不应以高置信度提交，实际 sourceRef: ${realmEntry.sourceRef}, confidence: ${realmEntry.confidence}`,
    );
  });

  it("对照: 单角色场景 '淬腑境，初期' → realm 应通过（无状态动词）", () => {
    const entry = makeCharacterEntry("李一凡", "realm", "淬腑境初期");
    const finalText = "李一凡缓缓睁开眼。淬腑境，初期。力量终于沉入脏腑。";
    const realmIdx = finalText.indexOf("淬腑境");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "淬腑境" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      true,
      `单角色场景无状态动词应通过，实际 supported=false。reason: ${result.reason}`,
    );
  });
});

describe("P1 第四轮：同义动作族防误阻断", () => {
  it("对照7: '交给' → '递给' 应通过（同义改写）", () => {
    const raw = "叶尘交给林默古籍。";
    const editorial = "叶尘递给林默古籍。";
    const entities = ["叶尘", "林默", "古籍"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      true,
      `同义改写（交给→递给）应通过，实际 preserved=false。reason: ${result.reason}`,
    );
  });

  it("对照8: '离开' → '走出' 应通过（同义改写）", () => {
    const raw = "叶尘离开密室。";
    const editorial = "叶尘走出密室。";
    const entities = ["叶尘", "密室"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      true,
      `同义改写（离开→走出）应通过，实际 preserved=false。reason: ${result.reason}`,
    );
  });
});
