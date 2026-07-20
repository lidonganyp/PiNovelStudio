/**
 * EVOLUTION-RELEASE-GOVERNANCE-1C 授权卡（AuthorizationCard）测试 — schema / 有效期 / releaseId 覆盖
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6 / Phase G4 / 1C 任务卡
 *
 * 1C 授权边界：无授权卡不得调用真实 gpt5.6-sol 模型。
 * - stub provider 不需要授权卡（本地端到端测试）
 * - real provider 必须提供有效授权卡（未过期 + 覆盖目标 releaseId + 预算充足）
 * - 卡片 schema / 字段类型 / 枚举值校验
 * - 过期卡片 / 未覆盖 releaseId / 预算不足 一律拒绝
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTHORIZATION_CARD_SCHEMA_ID,
  AUTHORIZATION_CARD_SCHEMA_VERSION,
  validateAuthorizationCard,
  isCardExpired,
  isCardValidForRelease,
  assertCardAuthorizes,
  loadAuthorizationCardFromFile,
} from "../dist-test/v2/governance/authorization-card.js";

// ============================================================================
// helpers
// ============================================================================

function makeValidCard(overrides = {}) {
  return {
    schemaId: AUTHORIZATION_CARD_SCHEMA_ID,
    schemaVersion: AUTHORIZATION_CARD_SCHEMA_VERSION,
    cardId: "card-test-001",
    cardType: "real_gpt56sol",
    model: "gpt5.6-sol",
    allowedReleaseIds: ["rel-001"],
    budget: { maxCalls: 6, timeoutMs: 300000 },
    modelVersion: "gpt5.6-sol-2026-07",
    issuedAt: "2026-07-16T00:00:00.000Z",
    expiresAt: "2026-12-31T23:59:59.000Z",
    issuer: "test-issuer",
    authorizationProof: "test-proof",
    ...overrides,
  };
}

// ============================================================================
// validateAuthorizationCard
// ============================================================================

test("authCard: 合法卡片通过校验", () => {
  const card = makeValidCard();
  const result = validateAuthorizationCard(card);
  assert.equal(result.ok, true);
  assert.equal(result.card.cardId, "card-test-001");
});

test("authCard: schemaId 未知拒绝", () => {
  const card = makeValidCard({ schemaId: "unknown.schema" });
  const result = validateAuthorizationCard(card);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unknown_schema");
});

test("authCard: schemaVersion 不匹配拒绝", () => {
  const card = makeValidCard({ schemaVersion: 99 });
  const result = validateAuthorizationCard(card);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "schema_version_mismatch");
});

test("authCard: cardType 必须为 stub 或 real_gpt56sol", () => {
  const r1 = validateAuthorizationCard(makeValidCard({ cardType: "stub" }));
  assert.equal(r1.ok, true);
  const r2 = validateAuthorizationCard(makeValidCard({ cardType: "real_gpt56sol" }));
  assert.equal(r2.ok, true);
  const r3 = validateAuthorizationCard(makeValidCard({ cardType: "natural_person" }));
  assert.equal(r3.ok, false);
  assert.equal(r3.error.code, "invalid_field_value");
});

test("authCard: model 必须为 gpt5.6-sol", () => {
  const r = validateAuthorizationCard(makeValidCard({ model: "gpt-4" }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "invalid_field_value");
});

test("authCard: allowedReleaseIds 必须为非空字符串数组", () => {
  const r1 = validateAuthorizationCard(makeValidCard({ allowedReleaseIds: [] }));
  assert.equal(r1.ok, false);
  const r2 = validateAuthorizationCard(makeValidCard({ allowedReleaseIds: ["rel-001", "rel-002"] }));
  assert.equal(r2.ok, true);
  const r3 = validateAuthorizationCard(makeValidCard({ allowedReleaseIds: ["*"] }));
  assert.equal(r3.ok, true);
});

test("authCard: budget 必须包含 maxCalls 和 timeoutMs", () => {
  const r1 = validateAuthorizationCard(makeValidCard({ budget: { maxCalls: 6 } }));
  assert.equal(r1.ok, false);
  const r2 = validateAuthorizationCard(makeValidCard({ budget: { maxCalls: 6, timeoutMs: 300000 } }));
  assert.equal(r2.ok, true);
});

test("authCard: modelVersion 不得为空", () => {
  const r = validateAuthorizationCard(makeValidCard({ modelVersion: "" }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "empty_field");
});

test("authCard: 非对象输入拒绝", () => {
  assert.equal(validateAuthorizationCard(null).ok, false);
  assert.equal(validateAuthorizationCard("string").ok, false);
  assert.equal(validateAuthorizationCard([]).ok, false);
});

// ============================================================================
// isCardExpired
// ============================================================================

test("authCard: isCardExpired 过期卡片返回 true", () => {
  const card = makeValidCard({ expiresAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(isCardExpired(card), true);
});

test("authCard: isCardExpired 未过期卡片返回 false", () => {
  const card = makeValidCard({ expiresAt: "2099-12-31T23:59:59.000Z" });
  assert.equal(isCardExpired(card), false);
});

test("authCard: isCardExpired 边界：刚好过期", () => {
  const pastDate = new Date(Date.now() - 1000).toISOString();
  const card = makeValidCard({ expiresAt: pastDate });
  assert.equal(isCardExpired(card), true);
});

// ============================================================================
// isCardValidForRelease
// ============================================================================

test("authCard: isCardValidForRelease 通配 * 覆盖所有 releaseId", () => {
  const card = makeValidCard({ allowedReleaseIds: ["*"] });
  assert.equal(isCardValidForRelease(card, "rel-001"), true);
  assert.equal(isCardValidForRelease(card, "rel-999"), true);
});

test("authCard: isCardValidForRelease 精确匹配 releaseId", () => {
  const card = makeValidCard({ allowedReleaseIds: ["rel-001", "rel-002"] });
  assert.equal(isCardValidForRelease(card, "rel-001"), true);
  assert.equal(isCardValidForRelease(card, "rel-002"), true);
  assert.equal(isCardValidForRelease(card, "rel-003"), false);
});

// ============================================================================
// assertCardAuthorizes
// ============================================================================

test("authCard: assertCardAuthorizes 合法卡片不抛错", () => {
  const card = makeValidCard({ allowedReleaseIds: ["rel-001"] });
  assert.doesNotThrow(() => assertCardAuthorizes(card, "rel-001"));
});

test("authCard: assertCardAuthorizes 过期卡片抛错", () => {
  const card = makeValidCard({ expiresAt: "2020-01-01T00:00:00.000Z" });
  assert.throws(
    () => assertCardAuthorizes(card, "rel-001"),
    /REQUIRES_AUTH.*过期/,
  );
});

test("authCard: assertCardAuthorizes 未覆盖 releaseId 抛错", () => {
  const card = makeValidCard({ allowedReleaseIds: ["rel-001"] });
  assert.throws(
    () => assertCardAuthorizes(card, "rel-999"),
    /REQUIRES_AUTH.*不覆盖/,
  );
});

test("authCard: assertCardAuthorizes 预算不足抛错", () => {
  const card = makeValidCard({ budget: { maxCalls: 1, timeoutMs: 300000 } });
  assert.throws(
    () => assertCardAuthorizes(card, "rel-001"),
    /REQUIRES_AUTH.*预算/,
  );
});

// ============================================================================
// loadAuthorizationCardFromFile
// ============================================================================

test("authCard: loadAuthorizationCardFromFile 合法文件加载成功", () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-card-"));
  try {
    const cardPath = join(dir, "card.json");
    writeFileSync(cardPath, JSON.stringify(makeValidCard(), null, 2));
    const loaded = loadAuthorizationCardFromFile(cardPath);
    assert.equal(loaded.cardId, "card-test-001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authCard: loadAuthorizationCardFromFile 损坏 JSON 抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-card-"));
  try {
    const cardPath = join(dir, "card.json");
    writeFileSync(cardPath, "{ not valid json");
    assert.throws(
      () => loadAuthorizationCardFromFile(cardPath),
      /JSON/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authCard: loadAuthorizationCardFromFile schema 校验失败抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-card-"));
  try {
    const cardPath = join(dir, "card.json");
    writeFileSync(cardPath, JSON.stringify({ schemaId: "wrong" }));
    assert.throws(
      () => loadAuthorizationCardFromFile(cardPath),
      /授权卡校验失败/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
