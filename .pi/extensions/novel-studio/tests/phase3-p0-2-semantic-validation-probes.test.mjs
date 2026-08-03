/**
 * Phase 3 P0-2 生产探针：语义支持校验
 *
 * 验证 validateSemanticSupport 的 P0 修复：
 * - P0-2: participation 否定语义 — "不在场" 不应提交 present
 * - P0-2b: realm 证据绑定角色主体 — 多角色句中其他角色的境界不应误锚定
 * - P0-2c: 错误主体 canon 提交 — "林默死亡" 不应提交 "叶尘死亡"
 *
 * 不调用真实模型，纯规则测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
    sourceRef: "seed:ch5",
    confidence: 0.5,
    lastUpdated: new Date().toISOString(),
  };
}

function makeCanonEntry(fact) {
  return {
    id: `canon:${fact}`,
    kind: "canon",
    fact,
    sourceChapter: "ch5",
    sourceRef: "seed:ch5",
    confidence: 0.5,
    lastUpdated: new Date().toISOString(),
  };
}

// ============================================================================
// P0-2: participation 否定语义
// ============================================================================

describe("P0-2: participation 否定语义生产探针", () => {
  it("P0-2: '叶尘不在场，他今天不会来' → participation=present 应被拒绝", () => {
    const entry = makeCharacterEntry("叶尘", "participation", "present");
    const finalText = "叶尘不在场，他今天不会来。";
    // 模拟 reanchor 中的 nameSpan 查找
    const charIdx = finalText.indexOf("叶尘");
    const nameSpan = { start: charIdx, end: charIdx + 2, excerpt: "叶尘" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      false,
      `participation=present 在 "不在场" 语境下应被拒绝，实际 supported=${result.supported}, reason: ${result.reason}`,
    );
    assert.ok(
      result.reason.includes("semantic-conflict") || result.reason.includes("否定"),
      `原因应提及语义冲突或否定，实际: ${result.reason}`,
    );
  });

  it("P0-2: '叶尘在场，他正在战斗' → participation=present 应通过", () => {
    const entry = makeCharacterEntry("叶尘", "participation", "present");
    const finalText = "叶尘在场，他正在战斗。";
    const charIdx = finalText.indexOf("叶尘");
    const nameSpan = { start: charIdx, end: charIdx + 2, excerpt: "叶尘" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      true,
      `participation=present 在 "在场+战斗" 语境下应通过，实际 supported=${result.supported}, reason: ${result.reason}`,
    );
  });

  it("P0-2: '叶尘未到场，叶尘缺席了' → participation=present 应被拒绝", () => {
    const entry = makeCharacterEntry("叶尘", "participation", "present");
    const finalText = "叶尘未到场，叶尘缺席了。";
    const charIdx = finalText.indexOf("叶尘");
    const nameSpan = { start: charIdx, end: charIdx + 2, excerpt: "叶尘" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      false,
      `participation=present 在 "未到场/缺席" 语境下应被拒绝，实际 supported=${result.supported}, reason: ${result.reason}`,
    );
  });
});

// ============================================================================
// P0-2b: realm 证据绑定角色主体
// ============================================================================

describe("P0-2b: realm 证据绑定角色主体生产探针", () => {
  it("P0-2b: '林默踏入筑基期，叶尘在门外等待' → 叶尘 realm=筑基期 应被拒绝", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默踏入筑基期，叶尘在门外等待。";
    // reanchor 中对 realm 使用 findPromiseSpanInText(value, finalText)
    // "筑基期" 在 finalText 中找到
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      false,
      `叶尘 realm=筑基期 在 "林默踏入筑基期" 语境下应被拒绝，实际 supported=${result.supported}, reason: ${result.reason}`,
    );
    assert.ok(
      result.reason.includes("semantic-conflict") || result.reason.includes("不同子句"),
      `原因应提及语义冲突或不同子句，实际: ${result.reason}`,
    );
  });

  it("P0-2b: '叶尘踏入筑基期' → 叶尘 realm=筑基期 应通过", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "叶尘踏入筑基期。";
    const realmIdx = finalText.indexOf("筑基期");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "筑基期" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      true,
      `叶尘 realm=筑基期 在 "叶尘踏入筑基期" 语境下应通过，实际 supported=${result.supported}, reason: ${result.reason}`,
    );
  });

  it("P0-2b: 单角色场景 '淬腑境，初期' → realm 应通过（无其他角色干扰）", () => {
    const entry = makeCharacterEntry("李一凡", "realm", "淬腑境初期");
    const finalText = "李一凡缓缓睁开眼。淬腑境，初期。力量终于沉入脏腑。";
    // reanchor 中 findPromiseSpanInText("淬腑境初期", finalText) 会找到 "淬腑境"
    const realmIdx = finalText.indexOf("淬腑境");
    const nameSpan = { start: realmIdx, end: realmIdx + 3, excerpt: "淬腑境" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      true,
      `单角色场景中 realm 应通过（境界值单独成句，无其他角色干扰），实际 supported=${result.supported}, reason: ${result.reason}`,
    );
  });

  it("P0-2b: reanchor 端到端 — '林默踏入筑基期，叶尘在门外等待' 不应提交 叶尘 realm=筑基期", () => {
    const entry = makeCharacterEntry("叶尘", "realm", "筑基期");
    const finalText = "林默踏入筑基期，叶尘在门外等待。";
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
      `不应以高置信度提交（应被 semantic-conflict 拒绝或低置信度），实际 sourceRef: ${realmEntry.sourceRef}, confidence: ${realmEntry.confidence}`,
    );
  });
});

// ============================================================================
// P0-2c: 错误主体 canon 提交
// ============================================================================

describe("P0-2c: 错误主体 canon 提交生产探针", () => {
  it("P0-2c: '林默已经死亡，叶尘在门外等待' → canon '叶尘已经死亡' 应被拒绝", () => {
    const entry = makeCanonEntry("叶尘已经死亡");
    const finalText = "林默已经死亡，叶尘在门外等待。";
    // reanchor 中 findPromiseSpanInText("叶尘已经死亡", finalText) 会找到 "叶尘"
    const charIdx = finalText.indexOf("叶尘");
    const nameSpan = { start: charIdx, end: charIdx + 2, excerpt: "叶尘" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      false,
      `canon "叶尘已经死亡" 在 "林默已经死亡，叶尘在门外等待" 语境下应被拒绝，实际 supported=${result.supported}, reason: ${result.reason}`,
    );
  });

  it("P0-2c: '叶尘已经死亡' → canon '叶尘已经死亡' 应通过", () => {
    const entry = makeCanonEntry("叶尘已经死亡");
    const finalText = "叶尘已经死亡，他的身体冰冷。";
    const charIdx = finalText.indexOf("叶尘");
    const nameSpan = { start: charIdx, end: charIdx + 2, excerpt: "叶尘" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      true,
      `canon "叶尘已经死亡" 在 "叶尘已经死亡" 语境下应通过，实际 supported=${result.supported}, reason: ${result.reason}`,
    );
  });

  it("P0-2c: character kind — '林默已经死亡，叶尘在门外等待' → 叶尘 status=dead 应被拒绝", () => {
    const entry = makeCharacterEntry("叶尘", "status", "dead");
    const finalText = "林默已经死亡，叶尘在门外等待。";
    // 对于 character kind 非 realm，nameSpan 是 characterId 的 span
    const charIdx = finalText.indexOf("叶尘");
    const nameSpan = { start: charIdx, end: charIdx + 2, excerpt: "叶尘" };

    const result = validateSemanticSupport(entry, finalText, nameSpan);
    assert.equal(
      result.supported,
      false,
      `叶尘 status=dead 在 "林默已经死亡，叶尘在门外等待" 语境下应被拒绝，实际 supported=${result.supported}, reason: ${result.reason}`,
    );
  });

  it("P0-2c: reanchor 端到端 — '林默已经死亡，叶尘在门外等待' 不应提交 canon '叶尘已经死亡'", () => {
    const entry = makeCanonEntry("叶尘已经死亡");
    const finalText = "林默已经死亡，叶尘在门外等待。";
    const staged = {
      additions: [entry],
      invalidations: [],
      sourceChapter: "ch5",
    };
    const reanchored = reanchorStagedStateToFinalText(staged, finalText, 5);
    const canonEntry = reanchored.additions.find((e) => e.kind === "canon");
    assert.ok(canonEntry, "应找到 canon entry");
    assert.ok(
      canonEntry.sourceRef.includes("semantic-conflict") || canonEntry.confidence < 0.5,
      `不应以高置信度提交（应被 semantic-conflict 拒绝或低置信度），实际 sourceRef: ${canonEntry.sourceRef}, confidence: ${canonEntry.confidence}`,
    );
  });
});
