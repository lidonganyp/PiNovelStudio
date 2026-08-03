/**
 * P0 第五轮验收探针：客体替换、境界主体归属、同义动作与 Alias 规范化
 *
 * 覆盖用户验收（第五轮）发现的剩余 P0/P1 反例：
 *
 * [P0] 同主体同动作替换客体（应阻断）：
 *   1. "叶尘攻击林默" → "叶尘攻击王五，林默站在一旁"（攻击承受者被替换）
 *   2. "叶尘交给林默玉玺" → "叶尘交给王五玉玺"（交付接收者被替换）
 *
 * [P0] 境界主体绑定（应拒绝，fail-closed）：
 *   3. "林默处于筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期（"处于"状态动词）
 *   4. "筑基期的林默守在门前。叶尘仍未赶到。" + 叶尘 realm=筑基期（后置定语"的"）
 *
 * [P1] 同义动作防误阻断（应通过）：
 *   5. "拿起" → "拾起"（取物族同义改写）
 *   6. "离开" → "迈步出了"（移动离去族同义改写，action 抽取为"迈步"）
 *
 * [P1] Alias 规范化防误阻断（应通过）：
 *   7. raw "叶尘" / editorial "小尘"（别名）+ aliasToCanonical → 通过
 *   8. 对照：不传 aliasToCanonical 时同一组文本应阻断（证明规范化是修复来源）
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractEvents } from "../dist/v2/core/event-extractor.js";
import { compareEventLedgers } from "../dist/v2/core/event-ledger-comparator.js";
import {
  validateSemanticSupport,
  reanchorStagedStateToFinalText,
} from "../dist/v2/core/final-state-commit.js";

/**
 * 构建 compareEventLedgers 输入。可选传入 aliasToCanonical 规范化别名。
 */
function buildLedgerInput(rawText, editorialText, entities = [], aliasToCanonical) {
  const opts = { entityCoverage: "full_entities", aliasToCanonical };
  const rawResult = extractEvents(rawText, entities, opts);
  const editorialResult = extractEvents(editorialText, entities, opts);
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

describe("P0 第五轮：同主体同动作客体替换检测", () => {
  it("反例1: '叶尘攻击林默' → '叶尘攻击王五，林默站在一旁' 应阻断（客体被替换）", () => {
    const raw = "叶尘攻击林默。";
    const editorial = "叶尘攻击王五，林默站在一旁。";
    const entities = ["叶尘", "林默", "王五"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `同主体同动作但客体被替换应阻断，实际 preserved=true。reason: ${result.reason}`,
    );
    const objReplace = result.replacedEvents.find(
      (e) => e.critical === true && e.reason.includes("客体替换"),
    );
    assert.ok(
      objReplace,
      `应检测到客体替换（critical=true, reason 含"客体替换"），实际 replacedEvents: ${JSON.stringify(result.replacedEvents.map((e) => ({ critical: e.critical, reason: e.reason })))}`,
    );
  });

  it("反例2: '叶尘交给林默玉玺' → '叶尘交给王五玉玺' 应阻断（交付接收者被替换）", () => {
    const raw = "叶尘交给林默玉玺。";
    const editorial = "叶尘交给王五玉玺。";
    const entities = ["叶尘", "林默", "王五", "玉玺"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `交付接收者被替换应阻断，实际 preserved=true。reason: ${result.reason}`,
    );
    const objReplace = result.replacedEvents.find(
      (e) => e.critical === true && e.reason.includes("客体替换"),
    );
    assert.ok(
      objReplace,
      `应检测到客体替换，实际 replacedEvents: ${JSON.stringify(result.replacedEvents.map((e) => ({ critical: e.critical, reason: e.reason })))}`,
    );
  });

  it("对照: '叶尘攻击林默' → '叶尘攻击林默' 应通过（客体未替换）", () => {
    const raw = "叶尘攻击林默。";
    const editorial = "叶尘攻击林默。";
    const entities = ["叶尘", "林默"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      true,
      `客体未替换应通过，实际 preserved=false。reason: ${result.reason}`,
    );
  });
});

describe("P0 第五轮：境界主体归属（fail-closed）", () => {
  it("反例3: '林默处于筑基期。叶尘在门外等待。' + 叶尘 realm=筑基期 应拒绝", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默处于筑基期。叶尘在门外等待。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      false,
      `'处于' 境界句不含目标角色时应 fail-closed，实际 supported=true。reason: ${result.reason}`,
    );
    assert.ok(
      result.reason.includes("处于") || result.reason.includes("境界状态动词") || result.reason.includes("semantic-conflict"),
      `reason 应指向境界状态动词冲突，实际: ${result.reason}`,
    );
  });

  it("反例4: '筑基期的林默守在门前。叶尘仍未赶到。' + 叶尘 realm=筑基期 应拒绝（后置定语）", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "筑基期的林默守在门前。叶尘仍未赶到。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      false,
      `后置定语"筑基期的林默"修饰林默而非叶尘，应 fail-closed，实际 supported=true。reason: ${result.reason}`,
    );
    assert.ok(
      result.reason.includes("定语") || result.reason.includes("semantic-conflict"),
      `reason 应指向定语归属冲突，实际: ${result.reason}`,
    );
  });

  it("反例3 端到端: reanchor 不应以高置信提交 叶尘 realm=筑基期（处于）", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默处于筑基期。叶尘在门外等待。";
    const staged = { additions: [entry], invalidations: [], sourceChapter: "ch5" };
    const reanchored = reanchorStagedStateToFinalText(staged, finalText, 5);
    const realmEntry = reanchored.additions.find((e) => e.kind === "character" && e.field === "realm");
    assert.ok(realmEntry, "应找到 realm entry");
    assert.ok(
      realmEntry.sourceRef.includes("semantic-conflict") || realmEntry.confidence < 0.5,
      `不应以高置信度提交，实际 sourceRef: ${realmEntry.sourceRef}, confidence: ${realmEntry.confidence}`,
    );
  });

  it("反例4 端到端: reanchor 不应以高置信提交 叶尘 realm=筑基期（后置定语）", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "筑基期的林默守在门前。叶尘仍未赶到。";
    const staged = { additions: [entry], invalidations: [], sourceChapter: "ch5" };
    const reanchored = reanchorStagedStateToFinalText(staged, finalText, 5);
    const realmEntry = reanchored.additions.find((e) => e.kind === "character" && e.field === "realm");
    assert.ok(realmEntry, "应找到 realm entry");
    assert.ok(
      realmEntry.sourceRef.includes("semantic-conflict") || realmEntry.confidence < 0.5,
      `不应以高置信度提交，实际 sourceRef: ${realmEntry.sourceRef}, confidence: ${realmEntry.confidence}`,
    );
  });

  it("对照: '林默已是筑基期' + 林默 realm=筑基期 应通过（目标角色在境界句）", () => {
    const entry = makeCharacterEntry("林默", "realm", "筑基期");
    const finalText = "林默已是筑基期。叶尘在门外等待。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      true,
      `目标角色在境界句应通过，实际 supported=false。reason: ${result.reason}`,
    );
  });
});

describe("P1 第五轮：同义动作族防误阻断", () => {
  it("对照5: '拿起' → '拾起' 应通过（取物族同义改写）", () => {
    const raw = "叶尘拿起古籍。";
    const editorial = "叶尘拾起古籍。";
    const entities = ["叶尘", "古籍"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      true,
      `同义改写（拿起→拾起）应通过，实际 preserved=false。reason: ${result.reason}`,
    );
  });

  it("对照6: '离开' → '迈步出了' 应通过（移动离去族，action 抽取为 迈步）", () => {
    const raw = "叶尘离开密室。";
    const editorial = "叶尘迈步出了密室。";
    const entities = ["叶尘", "密室"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      true,
      `同义改写（离开→迈步出了）应通过，实际 preserved=false。reason: ${result.reason}`,
    );
  });
});

describe("P1 第五轮：Alias 规范化防误阻断", () => {
  it("对照7: raw '叶尘' / editorial '小尘' + aliasToCanonical 应通过", () => {
    const raw = "叶尘离开密室。";
    const editorial = "小尘走出密室。";
    const entities = ["叶尘", "小尘", "密室"];
    const aliasToCanonical = new Map([
      ["叶尘", "叶尘"],
      ["小尘", "叶尘"],
    ]);
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities, aliasToCanonical));
    assert.equal(
      result.preserved,
      true,
      `别名规范化后（叶尘/小尘→叶尘）同义改写应通过，实际 preserved=false。reason: ${result.reason}`,
    );
  });

  it("对照8: 不传 aliasToCanonical 时 '叶尘'→'小尘' 应阻断（证明规范化是修复来源）", () => {
    const raw = "叶尘离开密室。";
    const editorial = "小尘走出密室。";
    const entities = ["叶尘", "小尘", "密室"];
    // 不传 aliasToCanonical：subject "叶尘" vs "小尘" 不匹配 → 事件无法匹配 → 阻断
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `未规范化别名时主体不同应阻断（证明 alias 修复是必要的），实际 preserved=true。reason: ${result.reason}`,
    );
  });

  it("对照9: '叶尘攻击林默' → '小尘攻击林默' + aliasToCanonical 应通过（同主体同客体）", () => {
    const raw = "叶尘攻击林默。";
    const editorial = "小尘攻击林默。";
    const entities = ["叶尘", "小尘", "林默"];
    const aliasToCanonical = new Map([
      ["叶尘", "叶尘"],
      ["小尘", "叶尘"],
    ]);
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities, aliasToCanonical));
    assert.equal(
      result.preserved,
      true,
      `别名规范化后同主体同客体应通过，实际 preserved=false。reason: ${result.reason}`,
    );
  });
});
