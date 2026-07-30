/**
 * P0 第六轮验收探针：结构化主体/客体绑定与 canonical 事件匹配
 *
 * 覆盖用户验收（第六轮）点名的剩余 P0/P1 反例：
 *
 * [P0] 境界主体绑定结构化（应拒绝，fail-closed，传入 characterNames）：
 *   1. "林默的境界是筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期（"境界是" 不在动词正则）
 *   2. "林默境界为筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期（"境界为"）
 *   3. "林默处在筑基期。叶尘在门外等待。" + 叶尘 realm=筑基期（"处在"，非"处于"）
 *   4. "林默是筑基期修士。叶尘在门外等待。" + 叶尘 realm=筑基期（"是修士"）
 *   5. 端到端 reanchor（传 characterNames）不应以高置信提交
 *   6. 回归：单角色场景 "淬腑境，初期。" + 李一凡 realm=淬腑境初期（传 characterNames）应通过
 *
 * [P0] 客体删除/未知实体替换（应阻断）：
 *   7. "叶尘攻击林默" → "叶尘攻击。林默站在一旁"（客体被删除）
 *   8. "叶尘攻击林默" → "叶尘攻击赵六"（赵六不在实体表，未知替换）
 *   9. 对照："叶尘攻击林默" → "叶尘向林默发起攻击"（承受者仍在事件中）应通过
 *
 * [P1] 多事件 alias 改写防误阻断（应通过）：
 *  10. raw "叶尘" / editorial "小尘"（别名）× 2 事件 + aliasToCanonical → 通过
 *  11. 对照：不传 aliasToCanonical 时同文本应阻断（证明规范化是修复来源）
 *
 * [P1] 否定反转动作一致性校验（防误阻断）：
 *  12. raw "叶尘没有说话" / editorial "叶尘看着远方"（动作不同，仅 negated 差异）
 *      → 不应判为"否定语义反转"
 *  13. 真否定反转："叶尘没有攻击" → "叶尘攻击林默"（同动作）应阻断
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
    aliasToCanonical,
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

// ============================================================================
// P0-1: 境界主体绑定结构化（传入 characterNames）
// ============================================================================
describe("P0 第六轮 P0-1：境界主体结构化绑定（characterNames）", () => {
  const characterNames = ["林默", "叶尘"];

  it("反例1: '林默的境界是筑基期' + 叶尘 realm=筑基期 应拒绝（境界是）", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默的境界是筑基期。叶尘在门外等待。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, characterNames);
    assert.equal(
      result.supported,
      false,
      `'境界是' 等价表达应被结构化绑定拦截，实际 supported=true。reason: ${result.reason}`,
    );
    assert.ok(
      result.reason.includes("结构化绑定") || result.reason.includes("semantic-conflict"),
      `reason 应指向结构化绑定冲突，实际: ${result.reason}`,
    );
  });

  it("反例2: '林默境界为筑基期' + 叶尘 realm=筑基期 应拒绝（境界为）", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默境界为筑基期。叶尘在门外等待。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, characterNames);
    assert.equal(
      result.supported,
      false,
      `'境界为' 等价表达应被结构化绑定拦截，实际 supported=true。reason: ${result.reason}`,
    );
  });

  it("反例3: '林默处在筑基期' + 叶尘 realm=筑基期 应拒绝（处在）", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默处在筑基期。叶尘在门外等待。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, characterNames);
    assert.equal(
      result.supported,
      false,
      `'处在' 等价表达应被结构化绑定拦截，实际 supported=true。reason: ${result.reason}`,
    );
  });

  it("反例4: '林默是筑基期修士' + 叶尘 realm=筑基期 应拒绝（是修士）", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默是筑基期修士。叶尘在门外等待。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, characterNames);
    assert.equal(
      result.supported,
      false,
      `'是修士' 等价表达应被结构化绑定拦截，实际 supported=true。reason: ${result.reason}`,
    );
  });

  it("反例1 端到端: reanchor（传 characterNames）不应以高置信提交 叶尘 realm=筑基期", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默的境界是筑基期。叶尘在门外等待。";
    const staged = { additions: [entry], invalidations: [], sourceChapter: "ch5" };
    const reanchored = reanchorStagedStateToFinalText(staged, finalText, 5, characterNames);
    const realmEntry = reanchored.additions.find((e) => e.kind === "character" && e.field === "realm");
    assert.ok(realmEntry, "应找到 realm entry");
    assert.ok(
      realmEntry.sourceRef.includes("semantic-conflict") || realmEntry.confidence < 0.5,
      `不应以高置信度提交，实际 sourceRef: ${realmEntry.sourceRef}, confidence: ${realmEntry.confidence}`,
    );
  });

  it("回归6: 单角色场景 '淬腑境，初期。' + 李一凡 realm=淬腑境初期（传 characterNames）应通过", () => {
    const entry = makeCharacterEntry("李一凡", "realm", "淬腑境初期");
    const finalText = "李一凡缓缓睁开眼。淬腑境，初期。力量终于沉入脏腑。";
    // 淬腑境 在正文中的位置
    const realmIdx = finalText.indexOf("淬腑境");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "淬腑境" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, ["李一凡"]);
    assert.equal(
      result.supported,
      true,
      `单角色场景（境界单独成句，无其他角色竞争）应通过，实际 supported=false。reason: ${result.reason}`,
    );
  });

  it("对照: '林默已是筑基期' + 林默 realm=筑基期（传 characterNames）应通过（目标角色在境界句）", () => {
    const entry = makeCharacterEntry("林默", "realm", "筑基期");
    const finalText = "林默已是筑基期。叶尘在门外等待。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan, characterNames);
    assert.equal(
      result.supported,
      true,
      `目标角色在境界句应通过，实际 supported=false。reason: ${result.reason}`,
    );
  });
});

// ============================================================================
// P0-2: 客体删除/未知实体替换检测
// ============================================================================
describe("P0 第六轮 P0-2：客体删除/未知实体替换检测", () => {
  it("反例7: '叶尘攻击林默' → '叶尘攻击。林默站在一旁' 应阻断（客体删除）", () => {
    const raw = "叶尘攻击林默。";
    const editorial = "叶尘攻击。林默站在一旁。";
    const entities = ["叶尘", "林默"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `客体被删除应阻断，实际 preserved=true。reason: ${result.reason}`,
    );
    const objLoss = result.replacedEvents.find(
      (e) => e.critical === true && (e.reason.includes("客体删除") || e.reason.includes("客体替换为未知实体")),
    );
    assert.ok(
      objLoss,
      `应检测到客体删除/未知替换（critical=true），实际 replacedEvents: ${JSON.stringify(result.replacedEvents.map((e) => ({ critical: e.critical, reason: e.reason })))}`,
    );
  });

  it("反例8: '叶尘攻击林默' → '叶尘攻击赵六'（赵六不在实体表）应阻断（未知替换）", () => {
    const raw = "叶尘攻击林默。";
    const editorial = "叶尘攻击赵六。林默站在一旁。";
    // 赵六 不在实体表
    const entities = ["叶尘", "林默"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `客体被替换为未知实体应阻断，实际 preserved=true。reason: ${result.reason}`,
    );
    const objLoss = result.replacedEvents.find(
      (e) => e.critical === true && (e.reason.includes("客体删除") || e.reason.includes("客体替换为未知实体")),
    );
    assert.ok(
      objLoss,
      `应检测到未知实体替换（critical=true），实际 replacedEvents: ${JSON.stringify(result.replacedEvents.map((e) => ({ critical: e.critical, reason: e.reason })))}`,
    );
  });

  it("对照9: '叶尘攻击林默' → '叶尘向林默发起攻击' 应通过（承受者仍在事件中）", () => {
    const raw = "叶尘攻击林默。";
    const editorial = "叶尘向林默发起攻击。";
    const entities = ["叶尘", "林默"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      true,
      `承受者仍在事件中（同义改写）应通过，实际 preserved=false。reason: ${result.reason}`,
    );
  });
});

// ============================================================================
// P1-1: 多事件 alias 改写防误阻断
// ============================================================================
describe("P0 第六轮 P1-1：多事件 alias 改写防误阻断", () => {
  it("反例10: raw '叶尘' / editorial '小尘' × 2 事件 + aliasToCanonical 应通过", () => {
    const raw = "叶尘离开密室。叶尘拿起古籍。";
    const editorial = "小尘走出密室。小尘拾起古籍。";
    const entities = ["叶尘", "小尘", "密室", "古籍"];
    const aliasToCanonical = new Map([
      ["叶尘", "叶尘"],
      ["小尘", "叶尘"],
    ]);
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities, aliasToCanonical));
    assert.equal(
      result.preserved,
      true,
      `多事件 alias 改写（叶尘/小尘→叶尘）经规范化后应通过，实际 preserved=false。reason: ${result.reason}`,
    );
    // 关键：不应累计 missing_event
    assert.equal(
      result.rejectionType,
      null,
      `alias 规范化后不应有 rejectionType，实际: ${result.rejectionType}。missingEvents: ${result.missingEvents.length}`,
    );
  });

  it("对照11: 不传 aliasToCanonical 时 '叶尘'→'小尘' × 2 事件应阻断（证明规范化是修复来源）", () => {
    const raw = "叶尘离开密室。叶尘拿起古籍。";
    const editorial = "小尘走出密室。小尘拾起古籍。";
    const entities = ["叶尘", "小尘", "密室", "古籍"];
    // 不传 aliasToCanonical：subject "叶尘" vs "小尘" 不匹配，事件无法匹配 → 阻断
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `未规范化别名时多事件应阻断（证明 alias 修复是必要的），实际 preserved=true。reason: ${result.reason}`,
    );
  });
});

// ============================================================================
// P1-2: 否定反转动作一致性校验
// ============================================================================
describe("P0 第六轮 P1-2：否定反转动作一致性校验", () => {
  it("反例12: raw '叶尘没有说话' / editorial '叶尘看着远方'（动作不同）不应判为否定语义反转", () => {
    const raw = "叶尘没有说话。";
    const editorial = "叶尘看着远方。";
    const entities = ["叶尘"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    const negationReversal = result.replacedEvents.find((e) =>
      e.reason.includes("否定语义反转"),
    );
    assert.equal(
      negationReversal,
      undefined,
      `动作不同（说 vs 看）不应判为否定语义反转，实际 found: ${JSON.stringify(negationReversal)}`,
    );
  });

  it("反例13: 真否定反转 '叶尘没有攻击林默' → '叶尘攻击林默'（同动作）应阻断", () => {
    const raw = "叶尘没有攻击林默。";
    const editorial = "叶尘攻击林默。";
    const entities = ["叶尘", "林默"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `真否定反转（同动作，否定→肯定）应阻断，实际 preserved=true。reason: ${result.reason}`,
    );
    const negationReversal = result.replacedEvents.find((e) =>
      e.reason.includes("否定语义反转"),
    );
    assert.ok(
      negationReversal,
      `应检测到否定语义反转，实际 replacedEvents: ${JSON.stringify(result.replacedEvents.map((e) => e.reason))}`,
    );
  });
});

// ============================================================================
// P0 第六轮 P1-3：同角色不同事件防误阻断（canary 真实误阻断治理）
//
// canary 实测反例（reports/chapter-canary/canary-2026-07-29T2156）：
//   raw "陈锋摇了摇头" → editorial "陈锋看了他一会儿"（同角色不同动作，不共享实体名
//   以外的显著双字片段）被旧逻辑记为低相似度替换事件，累计到阈值(3)误阻断。
//
// 新规则：同 subject + 完全不同 action/object + 不共享显著内容 → advisory（不阻断），
// 只有共享显著内容时才视为"同一事件被改写"记为低相似度替换。
// ============================================================================
describe("P0 第六轮 P1-3：同角色不同事件防误阻断（canary 场景）", () => {
  it("反例14: raw '陈锋摇了摇头' → editorial '陈锋看了他一会儿'（同角色不同事件）不应阻断", () => {
    const raw = "陈锋摇了摇头。";
    const editorial = "陈锋看了他一会儿。";
    const entities = ["陈锋"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      true,
      `同角色不同事件（摇头 vs 看，不共享显著内容）不应阻断，实际 preserved=false。reason: ${result.reason}`,
    );
  });

  it("反例15: raw '没有再说多余的话' → editorial '肩站在天台上'（无关事件）不应阻断", () => {
    const raw = "陈锋没有再说多余的话。";
    const editorial = "陈锋肩站在天台上。";
    const entities = ["陈锋"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    // 无关事件配对：动作不同（说 vs 站），否定状态不同但动作不一致→不判否定反转；
    // 不共享显著内容→不记低相似度替换。应通过。
    assert.equal(
      result.preserved,
      true,
      `无关事件配对不应阻断，实际 preserved=false。reason: ${result.reason}`,
    );
  });

  it("反例16: 多个同角色不同事件累计不应触发低相似度阈值阻断", () => {
    // 模拟 canary 场景：3 个同角色不同事件对，旧逻辑累计 3 ≥ 阈值 3 误阻断
    const raw = "陈锋摇了摇头。陈锋看了他一会儿。陈锋没有再说多余的话。";
    const editorial = "陈锋看了他一会儿。风穿过栏杆。肩站在天台上。";
    const entities = ["陈锋"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      true,
      `3 个同角色不同事件累计不应阻断（阈值 3），实际 preserved=false。reason: ${result.reason}`,
    );
  });

  it("对照17: 真正的事件改写（共享显著内容但 action 不同）应记为低相似度替换", () => {
    // 共享 "玉玺" 这一显著片段，但 action 不同 → 同一事件被改写 → 应记为替换
    const raw = "陈锋交出玉玺。";
    const editorial = "陈锋查看玉玺。";
    const entities = ["陈锋", "玉玺"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    // "交出" 是关键动作 → critical replacement 单个即阻断
    assert.equal(
      result.preserved,
      false,
      `关键动作（交出→查看）+ 共享玉玺应阻断，实际 preserved=true。reason: ${result.reason}`,
    );
  });
});

// ============================================================================
// P0 第六轮 P1-4：关键动作替换防误阻断（canary 真实误阻断治理）
//
// canary 实测反例（reports/chapter-canary/canary-2026-07-30T0114）：
//   raw "李强回来" → editorial "李强看"：因 "回来" 在 CRITICAL_ACTIONS 中被误判为
//   关键动作替换，单个即阻断。实际是同角色不同事件（不共享实体名以外的显著片段）。
//   raw "李一凡拿起筷子" → editorial "李一凡吃" 同理误阻断。
//
// 新规则：action/object 均不匹配时，关键替换也要求共享显著内容；
// 不共享 = 同角色不同事件 → advisory，不阻断。
// 真正的关键替换（同 object 不同 action）走 objectMatch=true 路径仍阻断。
// ============================================================================
describe("P0 第六轮 P1-4：关键动作替换防误阻断（canary 场景）", () => {
  it("反例18: raw '李强回来' → editorial '李强看'（同角色不同事件，回来是关键动作）不应阻断", () => {
    const raw = "李强回来。";
    const editorial = "李强看了。";
    const entities = ["李强"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      true,
      `同角色不同事件（回来 vs 看，不共享显著内容）不应阻断，实际 preserved=false。reason: ${result.reason}`,
    );
  });

  it("反例19: raw '李一凡拿起筷子' → editorial '李一凡吃'（拿起是关键动作）不应阻断", () => {
    const raw = "李一凡拿起筷子。";
    const editorial = "李一凡吃了。";
    const entities = ["李一凡"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      true,
      `同角色不同事件（拿起 vs 吃，不共享显著内容）不应阻断，实际 preserved=false。reason: ${result.reason}`,
    );
  });

  it("对照20: 真正的关键替换 '叶尘攻击林默' → '叶尘防御林默'（同 object 不同 action）应阻断", () => {
    // 同 object（林默）→ objectMatch=true → 走 isReplaced 路径 → critical replacement 阻断
    const raw = "叶尘攻击林默。";
    const editorial = "叶尘防御林默。";
    const entities = ["叶尘", "林默"];
    const result = compareEventLedgers(buildLedgerInput(raw, editorial, entities));
    assert.equal(
      result.preserved,
      false,
      `真正的关键替换（同 object 林默，攻击→防御）应阻断，实际 preserved=true。reason: ${result.reason}`,
    );
  });
});
