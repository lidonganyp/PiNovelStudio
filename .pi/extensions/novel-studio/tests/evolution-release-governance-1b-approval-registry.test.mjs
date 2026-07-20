/**
 * EVOLUTION-RELEASE-GOVERNANCE-1B 审批 artifact 注册表测试 — fs 持久化 / append-only / 按 releaseId 查询
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6 / Phase G4
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";
import {
  PROXY_APPROVAL_SCHEMA_ID,
  PROXY_APPROVAL_SCHEMA_VERSION,
} from "../dist-test/v2/governance/release-proxy-approval-schema.js";

// ============================================================================
// helpers
// ============================================================================

function makeManifest(releaseId, changeClass = "R2") {
  return {
    schemaId: "pinovel.evolution-release",
    schemaVersion: 1,
    releaseId,
    status: "evaluated",
    parentReleaseId: "rel-000",
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass,
    claims: ["unique-variable:test"],
    environmentFingerprint: "fp-test",
    artifactRefs: [],
    approvalRef: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    activatedAt: null,
  };
}

function makeArtifact(approvalId, releaseId, verdict = "APPROVE_DEV") {
  const manifest = makeManifest(releaseId);
  return {
    schemaId: PROXY_APPROVAL_SCHEMA_ID,
    schemaVersion: PROXY_APPROVAL_SCHEMA_VERSION,
    approvalId,
    releaseId,
    releaseManifestHash: computeReleasePayloadHash(manifest),
    reviewerType: "validated_human_proxy",
    reviewerModel: "gpt5.6-sol",
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    promptHash: "sha256:prompt-abc",
    inputArtifactHash: "sha256:input-def",
    forwardVerdict: verdict,
    reverseVerdict: verdict,
    finalVerdict: verdict,
    winningSpans: ["候选更优"],
    losingSpans: ["当前版本较弱"],
    risks: [],
    rationale: "测试用 artifact",
    decidedAt: "2026-07-16T10:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 60000 },
    changeClass: "R2",
    r3SelfApproval: false,
  };
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "proxy-approval-reg-"));
}

// ============================================================================
// writeArtifact + loadArtifact
// ============================================================================

test("registry: writeArtifact 写入 + loadArtifact 读取", () => {
  const dir = makeTempDir();
  try {
    const reg = createProxyApprovalRegistry({ approvalsDir: dir });
    const artifact = makeArtifact("ap-001", "rel-001");
    reg.writeArtifact(artifact);
    const loaded = reg.loadArtifact("ap-001");
    assert.equal(loaded.approvalId, "ap-001");
    assert.equal(loaded.releaseId, "rel-001");
    assert.equal(loaded.finalVerdict, "APPROVE_DEV");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry: loadArtifact 不存在返回 null", () => {
  const dir = makeTempDir();
  try {
    const reg = createProxyApprovalRegistry({ approvalsDir: dir });
    assert.equal(reg.loadArtifact("nonexistent"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry: writeArtifact 原子写入（无 .tmp 残留）", () => {
  const dir = makeTempDir();
  try {
    const reg = createProxyApprovalRegistry({ approvalsDir: dir });
    reg.writeArtifact(makeArtifact("ap-001", "rel-001"));
    const tmpFiles = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(tmpFiles, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// listByReleaseId
// ============================================================================

test("registry: listByReleaseId 返回该 release 的所有审批", () => {
  const dir = makeTempDir();
  try {
    const reg = createProxyApprovalRegistry({ approvalsDir: dir });
    reg.writeArtifact(makeArtifact("ap-001", "rel-001", "REJECT"));
    reg.writeArtifact(makeArtifact("ap-002", "rel-001", "APPROVE_DEV"));
    reg.writeArtifact(makeArtifact("ap-003", "rel-002", "APPROVE_DEV"));
    const rel001 = reg.listByReleaseId("rel-001");
    assert.equal(rel001.length, 2);
    assert.deepEqual(
      rel001.map((a) => a.approvalId).sort(),
      ["ap-001", "ap-002"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry: listByReleaseId 不存在返回空数组", () => {
  const dir = makeTempDir();
  try {
    const reg = createProxyApprovalRegistry({ approvalsDir: dir });
    assert.deepEqual(reg.listByReleaseId("nonexistent"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// append-only index
// ============================================================================

test("registry: append-only index 追加记录", () => {
  const dir = makeTempDir();
  try {
    const reg = createProxyApprovalRegistry({ approvalsDir: dir });
    reg.writeArtifact(makeArtifact("ap-001", "rel-001"));
    reg.writeArtifact(makeArtifact("ap-002", "rel-001"));
    const index = reg.loadAppendOnlyIndex();
    assert.equal(index.length, 2);
    assert.deepEqual(
      index.map((e) => e.approvalId),
      ["ap-001", "ap-002"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry: append-only index 不可覆盖（同 approvalId 拒绝）", () => {
  const dir = makeTempDir();
  try {
    const reg = createProxyApprovalRegistry({ approvalsDir: dir });
    reg.writeArtifact(makeArtifact("ap-001", "rel-001"));
    assert.throws(
      () => reg.writeArtifact(makeArtifact("ap-001", "rel-001", "REJECT")),
      /already exists|已存在|duplicate/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 损坏文件
// ============================================================================

test("registry: 损坏 artifact JSON 抛错", () => {
  const dir = makeTempDir();
  try {
    const reg = createProxyApprovalRegistry({ approvalsDir: dir });
    // 直接写入损坏 JSON
    writeFileSync(join(dir, "ap-bad.json"), "{ not valid json");
    assert.throws(() => reg.loadArtifact("ap-bad"), /JSON|parse/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry: 未知 schemaId 抛错", () => {
  const dir = makeTempDir();
  try {
    const reg = createProxyApprovalRegistry({ approvalsDir: dir });
    const bad = makeArtifact("ap-001", "rel-001");
    bad.schemaId = "unknown";
    assert.throws(() => reg.writeArtifact(bad), /schema/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 最新审批
// ============================================================================

test("registry: getLatestApprovalForRelease 返回最新审批", () => {
  const dir = makeTempDir();
  try {
    const reg = createProxyApprovalRegistry({ approvalsDir: dir });
    reg.writeArtifact(makeArtifact("ap-001", "rel-001", "REJECT"));
    reg.writeArtifact(makeArtifact("ap-002", "rel-001", "APPROVE_DEV"));
    const latest = reg.getLatestApprovalForRelease("rel-001");
    assert.equal(latest.approvalId, "ap-002");
    assert.equal(latest.finalVerdict, "APPROVE_DEV");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry: 可写 approvalsDir，不触碰外部文件", () => {
  const dir = makeTempDir();
  const external = mkdtempSync(join(tmpdir(), "external-"));
  try {
    const reg = createProxyApprovalRegistry({ approvalsDir: dir });
    reg.writeArtifact(makeArtifact("ap-001", "rel-001"));
    // external 目录保持空
    assert.equal(readdirSync(external).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
