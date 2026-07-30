/**
 * P0 第七轮验收探针：跨句代词指代解析 + 角色 alias 规范化
 *
 * 覆盖用户验收（第七轮）点名的剩余 P0/P1 反例：
 *
 * [P0] 境界主体跨句代词指代（应拒绝，fail-closed）：
 *   1. "林默抬起头。他已是筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期（代词"他"）
 *   2. "林默站在门前。此人已达筑基期。叶尘仍未赶到。" + 叶尘 realm=筑基期（代词"此人"）
 *   3. "林默看向远方。其修为已至筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期（代词"其"）
 *
 * [P0] 代词指代正向用例（应通过，代词解析到目标角色）：
 *   4. "叶尘抬起头。他已是筑基期。" + 叶尘 realm=筑基期（代词"他"→叶尘）
 *
 * [P0] 多角色无代词歧义场景（应拒绝，归属无法确认）：
 *   5. "林默站在门前。筑基期的气息弥漫。叶尘在门外等待。" + 叶尘 realm=筑基期
 *      （境界句无角色名、无代词，多角色场景 → fail-closed）
 *
 * [P1] 境界状态角色 alias 规范化（应通过）：
 *   6. "小尘已是筑基期" + 叶尘 realm=筑基期 + aliasToCanonical{小尘→叶尘} → 通过
 *   7. 对照：同文本不传 aliasToCanonical → 拒绝（证明规范化是修复来源）
 *
 * [P1] 端到端 reanchor（代词误归属不应高置信提交）：
 *   8. "林默抬起头。他已是筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期
 *      → reanchor 后 sourceRef 含 semantic-conflict 或 confidence < 0.5
 *
 * [回归] 第六轮反例仍被正确拦截：
 *   9. "林默的境界是筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期 → 拒绝
 *  10. 单角色场景 "淬腑境，初期。" + 李一凡 realm=淬腑境初期 → 通过
 *
 * 不调用真实模型，纯规则测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractEvents } from "../dist/v2/core/event-extractor.js";
import { compareEventLedgers } from "../dist/v2/core/event-ledger-comparator.js";
import {
  validateSemanticSupport,
  reanchorStagedStateToFinalText,
} from "../dist/v2/core/final-state-commit.js";

// ============================================================================
// 辅助函数
// ============================================================================

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

function buildAliasMap(entries) {
  const map = new Map();
  for (const [alias, canonical] of entries) {
    map.set(alias, canonical);
  }
  return map;
}

function buildLedgerInput(rawText, editorialText, entities = []) {
  const opts = { entityCoverage: "full_entities" };
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

// ============================================================================
// P0: 跨句代词指代解析
// ============================================================================
describe("P0 第七轮 P0-1：境界主体跨句代词指代解析", () => {
  const characterNames = ["林默", "叶尘"];

  it("反例1: '林默抬起头。他已是筑基期。叶尘在门外等待。' + 叶尘 realm=筑基期 应拒绝（代词他）", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默抬起头。他已是筑基期。叶尘在门外等待。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, characterNames);
    assert.equal(
      result.supported,
      false,
      `代词"他"指向前句角色"林默"，非目标角色"叶尘"，应 fail-closed。实际 supported=true。reason: ${result.reason}`,
    );
    assert.ok(
      result.reason.includes("代词") || result.reason.includes("跨句"),
      `reason 应提及代词/跨句解析，实际: ${result.reason}`,
    );
  });

  it("反例2: '林默站在门前。此人已达筑基期。叶尘仍未赶到。' + 叶尘 realm=筑基期 应拒绝（代词此人）", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默站在门前。此人已达筑基期。叶尘仍未赶到。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, characterNames);
    assert.equal(
      result.supported,
      false,
      `代词"此人"指向前句角色"林默"，非目标角色"叶尘"，应 fail-closed。实际 supported=true。reason: ${result.reason}`,
    );
  });

  it("反例3: '林默看向远方。其修为已至筑基期。叶尘在门外等待。' + 叶尘 realm=筑基期 应拒绝（代词其）", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默看向远方。其修为已至筑基期。叶尘在门外等待。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, characterNames);
    assert.equal(
      result.supported,
      false,
      `代词"其"指向前句角色"林默"，非目标角色"叶尘"，应 fail-closed。实际 supported=true。reason: ${result.reason}`,
    );
  });

  it("正向4: '叶尘抬起头。他已是筑基期。' + 叶尘 realm=筑基期 应通过（代词他→叶尘）", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "叶尘抬起头。他已是筑基期。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, characterNames);
    assert.equal(
      result.supported,
      true,
      `代词"他"指向前句角色"叶尘"（目标角色），应通过。实际 supported=false。reason: ${result.reason}`,
    );
    assert.ok(
      result.reason.includes("代词") || result.reason.includes("跨句"),
      `reason 应提及代词解析，实际: ${result.reason}`,
    );
  });

  it("反例5: 多角色无代词歧义 '筑基期的气息弥漫' + 叶尘 realm=筑基期 应拒绝", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默站在门前。筑基期的气息弥漫。叶尘在门外等待。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, characterNames);
    assert.equal(
      result.supported,
      false,
      `多角色场景，境界句无角色名且无代词，归属无法确认，应 fail-closed。实际 supported=true。reason: ${result.reason}`,
    );
  });
});

// ============================================================================
// P1: 境界状态角色 alias 规范化
// ============================================================================
describe("P0 第七轮 P1-1：境界状态角色 alias 规范化", () => {
  const characterNames = ["叶尘", "小尘"]; // 含别名
  const aliasToCanonical = buildAliasMap([["叶尘", "叶尘"], ["小尘", "叶尘"]]);

  it("反例6: '小尘已是筑基期' + 叶尘 realm=筑基期 + aliasToCanonical 应通过", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "小尘已是筑基期。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(
      entry,
      finalText,
      nameSpan,
      characterNames,
      aliasToCanonical,
    );
    assert.equal(
      result.supported,
      true,
      `别名"小尘"规范化为 canonical"叶尘"后应通过。实际 supported=false。reason: ${result.reason}`,
    );
  });

  it("对照7: '小尘已是筑基期' + 叶尘 realm=筑基期 不传 aliasToCanonical 应拒绝", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "小尘已是筑基期。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    // 不传 aliasToCanonical：characterNames 含"小尘"但不是 canonical，被当成其他角色
    const result = validateSemanticSupport(
      entry,
      finalText,
      nameSpan,
      characterNames,
      // 不传 aliasToCanonical
    );
    assert.equal(
      result.supported,
      false,
      `不传 aliasToCanonical 时"小尘"被当成其他角色，应 fail-closed。实际 supported=true。reason: ${result.reason}`,
    );
    assert.ok(
      result.reason.includes("其他角色") || result.reason.includes("fail-closed"),
      `reason 应提及其他角色/fail-closed，实际: ${result.reason}`,
    );
  });

  it("反例6 端到端: reanchor（传 aliasToCanonical）应以高置信提交 叶尘 realm=筑基期", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "小尘已是筑基期。";
    const staged = { additions: [entry], invalidations: [], sourceChapter: "ch5" };

    const reanchored = reanchorStagedStateToFinalText(
      staged,
      finalText,
      5,
      characterNames,
      aliasToCanonical,
    );
    const realmEntry = reanchored.additions.find(
      (e) => e.kind === "character" && e.field === "realm",
    );
    assert.ok(realmEntry, "应找到 realm entry");
    assert.ok(
      !realmEntry.sourceRef.includes("semantic-conflict") && realmEntry.confidence >= 0.5,
      `别名规范化后应以高置信提交，实际 sourceRef: ${realmEntry.sourceRef}, confidence: ${realmEntry.confidence}`,
    );
  });
});

// ============================================================================
// P0: 端到端 reanchor（代词误归属不应高置信提交）
// ============================================================================
describe("P0 第七轮 P0-2：代词误归属端到端 reanchor", () => {
  const characterNames = ["林默", "叶尘"];

  it("反例8: '他已是筑基期' 代词指代林默 + 叶尘 realm=筑基期 → reanchor 不高置信提交", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默抬起头。他已是筑基期。叶尘在门外等待。";
    const staged = { additions: [entry], invalidations: [], sourceChapter: "ch5" };

    const reanchored = reanchorStagedStateToFinalText(staged, finalText, 5, characterNames);
    const realmEntry = reanchored.additions.find(
      (e) => e.kind === "character" && e.field === "realm",
    );
    assert.ok(realmEntry, "应找到 realm entry");
    assert.ok(
      realmEntry.sourceRef.includes("semantic-conflict") || realmEntry.confidence < 0.5,
      `代词误归属不应以高置信提交，实际 sourceRef: ${realmEntry.sourceRef}, confidence: ${realmEntry.confidence}`,
    );
  });
});

// ============================================================================
// P0: 关键事件被无关事件替换后阻断（用户第七轮 P0 反例）
// ============================================================================
describe("P0 第七轮 P0-3：关键事件被无关事件替换后阻断", () => {
  it("反例12: '叶尘杀死林默' → '叶尘端起茶杯。林默站在一旁' 应阻断", () => {
    const raw = "叶尘杀死林默。";
    const editorial = "叶尘端起茶杯。林默站在一旁。";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, ["叶尘", "林默"]));
    assert.equal(
      result.preserved,
      false,
      `关键动作"杀"在 editorial 全文未出现（被替换为"端起茶杯"），应阻断。实际 preserved=true。reason: ${result.reason}`,
    );
    assert.equal(result.unverifiable, false, "不应为 unverifiable");
  });

  it("反例13: '叶尘攻击林默' → '叶尘转身离开。林默站在一旁' 应阻断", () => {
    const raw = "叶尘攻击林默。";
    const editorial = "叶尘转身离开。林默站在一旁。";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, ["叶尘", "林默"]));
    assert.equal(
      result.preserved,
      false,
      `关键动作"攻击"在 editorial 全文未出现（被替换为"离开"），应阻断。实际 preserved=true。reason: ${result.reason}`,
    );
    assert.equal(result.unverifiable, false, "不应为 unverifiable");
  });

  it("反例14: '叶尘封印魔物' → '叶尘走出洞穴。魔物仍在洞中' 应阻断", () => {
    const raw = "叶尘封印魔物。";
    const editorial = "叶尘走出洞穴。魔物仍在洞中。";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, ["叶尘", "魔物"]));
    assert.equal(
      result.preserved,
      false,
      `关键动作"封印"在 editorial 全文未出现（被替换为"走出"），应阻断。实际 preserved=true。reason: ${result.reason}`,
    );
    assert.equal(result.unverifiable, false, "不应为 unverifiable");
  });

  it("对照15: 同角色不同事件 '李一凡拿起筷子' → '李一凡吃了' 不应阻断（canary 回归）", () => {
    // 筷子不是已知实体 → 关键事件缺失阻断不触发 → 同角色不同事件 advisory
    const raw = "李一凡拿起筷子。";
    const editorial = "李一凡吃了。";
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, ["李一凡"]));
    assert.equal(
      result.preserved,
      true,
      `同角色不同事件（拿起 vs 吃，筷子非已知实体）不应阻断。实际 preserved=false。reason: ${result.reason}`,
    );
  });
});

// ============================================================================
// 回归：第六轮反例仍被正确拦截
// ============================================================================
describe("P0 第七轮回归：第六轮反例仍正确拦截", () => {
  const characterNames = ["林默", "叶尘"];

  it("回归9: '林默的境界是筑基期' + 叶尘 realm=筑基期 应拒绝（第六轮反例1）", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默的境界是筑基期。叶尘在门外等待。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, characterNames);
    assert.equal(
      result.supported,
      false,
      `第六轮反例1仍应被结构化绑定拦截。实际 supported=true。reason: ${result.reason}`,
    );
  });

  it("回归10: 单角色场景 '淬腑境，初期。' + 李一凡 realm=淬腑境初期 应通过", () => {
    const entry = makeCharacterEntry("李一凡", "realm", "淬腑境初期");
    const finalText = "李一凡缓缓睁开眼。淬腑境，初期。力量终于沉入脏腑。";
    const realmIdx = finalText.indexOf("淬腑境");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "淬腑境" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, ["李一凡"]);
    assert.equal(
      result.supported,
      true,
      `单角色场景（境界单独成句，无其他角色竞争）应通过。实际 supported=false。reason: ${result.reason}`,
    );
  });

  it("回归11: '林默已是筑基期' + 林默 realm=筑基期（目标角色在境界句）应通过", () => {
    const entry = makeCharacterEntry("林默", "realm", "筑基期");
    const finalText = "林默已是筑基期。叶尘在门外等待。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, characterNames);
    assert.equal(
      result.supported,
      true,
      `目标角色在境界句应通过。实际 supported=false。reason: ${result.reason}`,
    );
  });
});
