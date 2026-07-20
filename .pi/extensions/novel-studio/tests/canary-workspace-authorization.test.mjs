/** G5 P1 workspace-scoped canary authorization tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CANARY_AUTHORIZATION_SCHEMA_ID,
  CANARY_AUTHORIZATION_SCHEMA_VERSION,
  validateCanaryAuthorization,
  isCanaryAuthExpired,
  isCanaryAuthValidForRelease,
  assertCanaryAuthorizes,
  loadCanaryAuthorizationFromFile,
} from "../dist-test/v2/governance/canary-workspace-authorization.js";

function validAuthorization(overrides = {}) {
  return {
    schemaId: CANARY_AUTHORIZATION_SCHEMA_ID,
    schemaVersion: CANARY_AUTHORIZATION_SCHEMA_VERSION,
    authorizationId: "canary-auth-001",
    workspaceId: "workspace-001",
    allowedReleaseIds: ["rel-001"],
    budget: { maxChapters: 2, maxCalls: 12 },
    issuedAt: "2026-07-17T00:00:00.000Z",
    expiresAt: "2026-07-18T00:00:00.000Z",
    issuer: "user",
    ...overrides,
  };
}

test("valid authorization passes schema validation", () => {
  const result = validateCanaryAuthorization(validAuthorization());
  assert.equal(result.ok, true);
});

for (const [field, value] of [
  ["schemaId", "wrong"],
  ["schemaVersion", 2],
  ["authorizationId", ""],
  ["workspaceId", ""],
  ["allowedReleaseIds", []],
  ["budget", { maxChapters: 0, maxCalls: 1 }],
]) {
  test(`invalid ${field} is rejected`, () => {
    const result = validateCanaryAuthorization(validAuthorization({ [field]: value }));
    assert.equal(result.ok, false);
  });
}

test("expiration boundary is expired", () => {
  const authorization = validAuthorization();
  assert.equal(isCanaryAuthExpired(authorization, authorization.expiresAt), true);
});

test("release wildcard and exact match are supported", () => {
  assert.equal(isCanaryAuthValidForRelease(validAuthorization(), "rel-001"), true);
  assert.equal(
    isCanaryAuthValidForRelease(validAuthorization({ allowedReleaseIds: ["*"] }), "rel-other"),
    true,
  );
  assert.equal(isCanaryAuthValidForRelease(validAuthorization(), "rel-other"), false);
});

test("assertCanaryAuthorizes rejects release, expiry, and insufficient budgets", () => {
  const authorization = validAuthorization();
  assert.throws(
    () => assertCanaryAuthorizes(authorization, "rel-other", { now: "2026-07-17T01:00:00.000Z" }),
    /REQUIRES_AUTH/,
  );
  assert.throws(
    () => assertCanaryAuthorizes(authorization, "rel-001", { now: authorization.expiresAt }),
    /REQUIRES_AUTH/,
  );
  assert.throws(
    () => assertCanaryAuthorizes(authorization, "rel-001", {
      now: "2026-07-17T01:00:00.000Z",
      requiredChapters: 3,
    }),
    /REQUIRES_AUTH/,
  );
  assert.throws(
    () => assertCanaryAuthorizes(authorization, "rel-001", {
      now: "2026-07-17T01:00:00.000Z",
      requiredCalls: 13,
    }),
    /REQUIRES_AUTH/,
  );
});

test("file loader accepts valid JSON and rejects missing or damaged files", () => {
  const root = mkdtempSync(join(tmpdir(), "canary-auth-"));
  try {
    const validPath = join(root, "valid.json");
    writeFileSync(validPath, JSON.stringify(validAuthorization()), "utf-8");
    assert.equal(loadCanaryAuthorizationFromFile(validPath).authorizationId, "canary-auth-001");
    assert.throws(() => loadCanaryAuthorizationFromFile(join(root, "missing.json")), /REQUIRES_AUTH/);
    const damagedPath = join(root, "damaged.json");
    writeFileSync(damagedPath, "{", "utf-8");
    assert.throws(() => loadCanaryAuthorizationFromFile(damagedPath), /REQUIRES_AUTH/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
