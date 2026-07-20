/**
 * EVOLUTION-RELEASE-GOVERNANCE P0 审批 artifact 真实性绑定修复测试（RED → GREEN）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §4 / §6.4 / §11
 *
 * 用户复现的第二层 P0 绕过：
 *
 * P0-3（production-release-gate.ts:306 evaluateProductionReleaseGate）
 *   "门禁只检查 approvalRef 非空，没有加载 artifact、验证 verdict、releaseId 和 manifest hash。
 *    已复现 approvalRef='fake-does-not-exist' 仍可通过生产门禁。必须加载对应
 *    ReleaseProxyApproval artifact，并验证 approvalId、releaseId、APPROVE_DEV/canPromote、
 *    manifest hash 与当前 manifest 一致。"
 *
 * P0-4（evolution-release-registry.ts:297 transitionStatus）
 *   "transitionStatus 只验证 approvalRef 字符串和 actor 标签，调用者仍可传入伪造引用。
 *    生产晋级应通过受控 promote 命令，验证真实审批 artifact 和不可伪造的用户确认记录后
 *    再原子迁移状态与 pointer。"
 *
 * 计划 §6.4 / §11 真相源约束：
 *   - approved_dev 必须绑定有效的 gpt5.6-sol 代理审批 artifact（不仅是非空字符串）
 *   - artifact.releaseId 必须等于 manifest.releaseId（防止 artifact 复用到不同 release）
 *   - artifact.finalVerdict 必须为 APPROVE_DEV（HOLD/REJECT/QUARANTINE 不得晋级）
 *   - artifact.releaseManifestHash 必须等于 computeReleasePayloadHash(manifest)（双向绑定）
 *   - approvalId 必须等于 manifest.approvalRef（防止字符串拼接伪造）
 *
 * 本测试覆盖：
 *   【门禁层 P0-3】
 *   1. approvalRef="fake-does-not-exist"（artifact 不存在）→ blocked
 *   2. artifact.approvalId !== approvalRef → blocked
 *   3. artifact.releaseId !== manifest.releaseId → blocked
 *   4. artifact.finalVerdict === "HOLD" → blocked
 *   5. artifact.releaseManifestHash !== computeReleasePayloadHash(manifest) → blocked
 *   6. artifact.finalVerdict === "REJECT" → blocked
 *   7. 合法 artifact（全匹配 + APPROVE_DEV）→ ok（回归保护）
 *
 *   【transitionStatus 层 P0-4】
 *   8. resolver + approvalRef="fake"（resolver 返回 null）→ throws
 *   9. resolver + artifact.releaseId 不匹配 → throws
 *   10. resolver + artifact.finalVerdict=HOLD → throws
 *   11. resolver + manifest hash 不匹配 → throws
 *   12. resolver + 合法 artifact → succeeds（回归保护）
 *   13. 无 resolver + 任意 approvalRef 字符串 → succeeds（向后兼容回归保护）
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型
 * - 不修改用户真实治理数据（独立临时目录）
 * - 不切换 active pointer（gate 测试用 setActiveProduction 辅助）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import { createReleasePointerStore } from "../dist-test/v2/governance/release-pointer-store.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import {
  computeReleasePayloadHash,
} from "../dist-test/v2/governance/evolution-release-schema.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import {
  PROXY_APPROVAL_SCHEMA_ID,
  PROXY_APPROVAL_SCHEMA_VERSION,
  PROXY_APPROVAL_REVIEWER_MODEL,
} from "../dist-test/v2/governance/release-proxy-approval-types.js";
import {
  evaluateProductionReleaseGate,
} from "../dist-test/v2/governance/production-release-gate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

// ============================================================================
// helpers
// ============================================================================

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "evolution-p0-artifact-"));
}

function makeManifest(releaseId, status, fingerprintHash, approvalRef = null) {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status,
    parentReleaseId: "rel-000",
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass: "R1",
    claims: ["p0-artifact-test-claim"],
    environmentFingerprint: fingerprintHash,
    artifactRefs: [],
    approvalRef,
    createdAt: "2026-07-16T00:00:00.000Z",
    activatedAt: status === "active_prod" ? "2026-07-16T00:00:00.000Z" : null,
  };
}

function setupReleaseInRoot(root, manifest) {
  const releasesDir = join(root, "releases");
  const registry = createEvolutionReleaseRegistry({ releasesDir });
  mkdirSync(join(releasesDir, manifest.releaseId), { recursive: true });
  writeFileSync(
    join(releasesDir, manifest.releaseId, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
  return registry;
}

function setActiveProduction(root, releaseId, actor = "user", reason = "p0 artifact test") {
  const store = createReleasePointerStore({ configDir: root });
  store.switchActive("production", releaseId, { actor, reason });
}

function clearDevMode() {
  const prev = process.env.PINOVEL_DEV_MODE;
  delete process.env.PINOVEL_DEV_MODE;
  return prev;
}

function restoreDevMode(prev) {
  if (prev === undefined) {
    delete process.env.PINOVEL_DEV_MODE;
  } else {
    process.env.PINOVEL_DEV_MODE = prev;
  }
}

/**
 * 构造合法 ReleaseProxyApprovalArtifact。
 * 默认所有字段与 manifest 双向绑定（approvalId/releaseId/releaseManifestHash 一致）。
 * overrides 用于破坏单个字段以复现 P0 绕过。
 */
function makeApprovalArtifact(manifest, overrides = {}) {
  const approvalId = manifest.approvalRef ?? "default-approval-id";
  return {
    schemaId: PROXY_APPROVAL_SCHEMA_ID,
    schemaVersion: PROXY_APPROVAL_SCHEMA_VERSION,
    approvalId,
    releaseId: manifest.releaseId,
    releaseManifestHash: computeReleasePayloadHash(manifest),
    reviewerType: "validated_human_proxy",
    reviewerModel: PROXY_APPROVAL_REVIEWER_MODEL,
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    reviewTransport: "network",
    promptHash: "sha256:prompt-p0-artifact-test",
    inputArtifactHash: "sha256:input-p0-artifact-test",
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
    finalVerdict: "APPROVE_DEV",
    winningSpans: ["span-win-1"],
    losingSpans: ["span-lose-1"],
    risks: [],
    rationale: "p0 artifact binding test approval",
    decidedAt: "2026-07-16T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 60000 },
    changeClass: manifest.changeClass,
    r3SelfApproval: false,
    ...overrides,
  };
}

/**
 * 将审批 artifact 写入 {root}/releases/{releaseId}/approvals/{approvalId}.json
 * 这是 G6 门禁默认 fs resolver 查找的路径。
 */
function writeApprovalArtifact(root, manifest, overrides = {}) {
  const approvalsDir = join(root, "releases", manifest.releaseId, "approvals");
  mkdirSync(approvalsDir, { recursive: true });
  const registry = createProxyApprovalRegistry({ approvalsDir });
  const artifact = makeApprovalArtifact(manifest, overrides);
  registry.writeArtifact(artifact);
  return artifact;
}

// ============================================================================
// P0-3: 门禁未加载审批 artifact（fake approvalRef 字符串绕过）
// ============================================================================

test("P0-3a: 门禁 approvalRef='fake-does-not-exist'（artifact 不存在）→ blocked", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const fpHash = "matched-hash-p0-3a";
    // active_prod + fingerprint 匹配 + approvalRef 是伪造字符串（artifact 不存在）
    setupReleaseInRoot(
      root,
      makeManifest("rel-p0-3a", "active_prod", fpHash, "fake-does-not-exist"),
    );
    setActiveProduction(root, "rel-p0-3a");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });
    assert.equal(result.ok, false, "伪造 approvalRef（artifact 不存在）必须被门禁阻断");
    assert.equal(result.failureEnvelope.stage, "g6_release_gate");
    assert.equal(result.failureEnvelope.severity, "preflight");
    assert.equal(result.failureEnvelope.degradedTo, "hard_block");
    assert.match(
      result.failureEnvelope.reason,
      /approvalRef|artifact|审批|不存在|未找到|fake/i,
      `reason 应说明 artifact 不存在，实际: ${result.failureEnvelope.reason}`,
    );
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-3b: 门禁 artifact.approvalId !== manifest.approvalRef → blocked（ID 不匹配）", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const fpHash = "matched-hash-p0-3b";
    const manifest = makeManifest("rel-p0-3b", "active_prod", fpHash, "approval-ref-p0-3b");
    setupReleaseInRoot(root, manifest);
    // 写入 artifact 但 approvalId 与 manifest.approvalRef 不匹配
    writeApprovalArtifact(root, manifest, { approvalId: "different-approval-id" });
    setActiveProduction(root, "rel-p0-3b");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });
    assert.equal(result.ok, false, "artifact.approvalId 与 approvalRef 不匹配必须阻断");
    assert.match(
      result.failureEnvelope.reason,
      /approvalId|approvalRef|不匹配|一致|artifact/i,
      `reason 应说明 approvalId 不匹配，实际: ${result.failureEnvelope.reason}`,
    );
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-3c: 门禁 artifact.releaseId !== manifest.releaseId → blocked（跨 release 复用）", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const fpHash = "matched-hash-p0-3c";
    const manifest = makeManifest("rel-p0-3c", "active_prod", fpHash, "approval-p0-3c");
    setupReleaseInRoot(root, manifest);
    // artifact 引用不同的 releaseId（复用其他 release 的审批）
    writeApprovalArtifact(root, manifest, { releaseId: "rel-other-release" });
    setActiveProduction(root, "rel-p0-3c");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });
    assert.equal(result.ok, false, "artifact.releaseId 与 manifest 不匹配必须阻断（防跨 release 复用）");
    assert.match(
      result.failureEnvelope.reason,
      /releaseId|不匹配|一致|复用|artifact/i,
      `reason 应说明 releaseId 不匹配，实际: ${result.failureEnvelope.reason}`,
    );
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-3d: 门禁 artifact.finalVerdict === 'HOLD' → blocked（未批准 verdict）", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const fpHash = "matched-hash-p0-3d";
    const manifest = makeManifest("rel-p0-3d", "active_prod", fpHash, "approval-p0-3d");
    setupReleaseInRoot(root, manifest);
    // artifact 存在且 ID/releaseId 匹配，但 verdict=HOLD（未批准）
    writeApprovalArtifact(root, manifest, {
      forwardVerdict: "HOLD",
      reverseVerdict: "HOLD",
      finalVerdict: "HOLD",
    });
    setActiveProduction(root, "rel-p0-3d");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });
    assert.equal(result.ok, false, "finalVerdict=HOLD 的 artifact 不得通过生产门禁");
    assert.match(
      result.failureEnvelope.reason,
      /verdict|APPROVE_DEV|HOLD|未批准|未通过/i,
      `reason 应说明 verdict 不是 APPROVE_DEV，实际: ${result.failureEnvelope.reason}`,
    );
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-3e: 门禁 artifact.releaseManifestHash 不匹配 → blocked（manifest 篡改）", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const fpHash = "matched-hash-p0-3e";
    const manifest = makeManifest("rel-p0-3e", "active_prod", fpHash, "approval-p0-3e");
    setupReleaseInRoot(root, manifest);
    // artifact 的 releaseManifestHash 与当前 manifest 不匹配（manifest 被篡改或 artifact 复用）
    writeApprovalArtifact(root, manifest, {
      releaseManifestHash: "sha256:completely-different-hash",
    });
    setActiveProduction(root, "rel-p0-3e");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });
    assert.equal(result.ok, false, "releaseManifestHash 不匹配必须阻断（防 manifest 篡改）");
    assert.match(
      result.failureEnvelope.reason,
      /manifestHash|hash|不匹配|一致|篡改|绑定/i,
      `reason 应说明 manifest hash 不匹配，实际: ${result.failureEnvelope.reason}`,
    );
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-3f: 门禁 artifact.finalVerdict === 'REJECT' → blocked（明确拒绝）", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const fpHash = "matched-hash-p0-3f";
    const manifest = makeManifest("rel-p0-3f", "active_prod", fpHash, "approval-p0-3f");
    setupReleaseInRoot(root, manifest);
    writeApprovalArtifact(root, manifest, {
      forwardVerdict: "REJECT",
      reverseVerdict: "REJECT",
      finalVerdict: "REJECT",
    });
    setActiveProduction(root, "rel-p0-3f");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });
    assert.equal(result.ok, false, "finalVerdict=REJECT 的 artifact 不得通过生产门禁");
    assert.match(
      result.failureEnvelope.reason,
      /verdict|APPROVE_DEV|REJECT|未批准|未通过/i,
      `reason 应说明 verdict 不是 APPROVE_DEV，实际: ${result.failureEnvelope.reason}`,
    );
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-3g: 门禁 + 合法 artifact（全匹配 + APPROVE_DEV）→ ok（回归保护）", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const fpHash = "matched-hash-p0-3g";
    const manifest = makeManifest("rel-p0-3g", "active_prod", fpHash, "approval-p0-3g-legit");
    setupReleaseInRoot(root, manifest);
    // 写入完全合法的 artifact：approvalId/releaseId/releaseManifestHash/verdict 全匹配
    writeApprovalArtifact(root, manifest);
    setActiveProduction(root, "rel-p0-3g");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });
    assert.equal(result.ok, true, "合法 artifact（全匹配 + APPROVE_DEV）应通过门禁");
    assert.equal(result.releaseId, "rel-p0-3g");
    assert.equal(result.approvalRef, "approval-p0-3g-legit");
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// P0-4: transitionStatus 未验证审批 artifact（resolver 注入路径）
// ============================================================================

/**
 * 构造 resolver 回调，返回指定的 artifact（或 null 表示不存在）。
 * 用于测试 transitionStatus 在提供 resolver 时的 artifact 验证行为。
 */
function makeResolver(artifact) {
  return (_approvalRef, _releaseId, _manifestHash) => artifact;
}

test("P0-4a: transitionStatus + resolver + approvalRef='fake'（resolver 返回 null）→ throws", () => {
  const root = makeTempRoot();
  try {
    const manifest = makeManifest("rel-p0-4a", "candidate_prod", "fp-4a", "fake-approval-ref");
    const registry = setupReleaseInRoot(root, manifest);
    // resolver 返回 null（artifact 不存在）
    const resolver = makeResolver(null);

    assert.throws(
      () =>
        registry.transitionStatus("rel-p0-4a", "active_prod", {
          actor: "user",
          approvalRef: "fake-approval-ref",
          resolveApprovalArtifact: resolver,
        }),
      /artifact|不存在|未找到|approvalRef|审批/i,
      "resolver 返回 null（artifact 不存在）时 transitionStatus 必须抛错",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-4b: transitionStatus + resolver + artifact.releaseId 不匹配 → throws", () => {
  const root = makeTempRoot();
  try {
    const manifest = makeManifest("rel-p0-4b", "candidate_prod", "fp-4b", "approval-4b");
    const registry = setupReleaseInRoot(root, manifest);
    // artifact 存在但 releaseId 不匹配（复用其他 release 的审批）
    const artifact = makeApprovalArtifact(manifest, { releaseId: "rel-other" });
    const resolver = makeResolver(artifact);

    assert.throws(
      () =>
        registry.transitionStatus("rel-p0-4b", "active_prod", {
          actor: "user",
          approvalRef: "approval-4b",
          resolveApprovalArtifact: resolver,
        }),
      /releaseId|不匹配|一致|复用|artifact/i,
      "artifact.releaseId 不匹配时 transitionStatus 必须抛错",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-4c: transitionStatus + resolver + artifact.finalVerdict=HOLD → throws", () => {
  const root = makeTempRoot();
  try {
    const manifest = makeManifest("rel-p0-4c", "candidate_prod", "fp-4c", "approval-4c");
    const registry = setupReleaseInRoot(root, manifest);
    const artifact = makeApprovalArtifact(manifest, {
      forwardVerdict: "HOLD",
      reverseVerdict: "HOLD",
      finalVerdict: "HOLD",
    });
    const resolver = makeResolver(artifact);

    assert.throws(
      () =>
        registry.transitionStatus("rel-p0-4c", "active_prod", {
          actor: "user",
          approvalRef: "approval-4c",
          resolveApprovalArtifact: resolver,
        }),
      /verdict|APPROVE_DEV|HOLD|未批准|未通过/i,
      "artifact.finalVerdict=HOLD 时 transitionStatus 必须抛错",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-4d: transitionStatus + resolver + manifest hash 不匹配 → throws", () => {
  const root = makeTempRoot();
  try {
    const manifest = makeManifest("rel-p0-4d", "candidate_prod", "fp-4d", "approval-4d");
    const registry = setupReleaseInRoot(root, manifest);
    const artifact = makeApprovalArtifact(manifest, {
      releaseManifestHash: "sha256:different-hash",
    });
    const resolver = makeResolver(artifact);

    assert.throws(
      () =>
        registry.transitionStatus("rel-p0-4d", "active_prod", {
          actor: "user",
          approvalRef: "approval-4d",
          resolveApprovalArtifact: resolver,
        }),
      /manifestHash|hash|不匹配|一致|篡改|绑定/i,
      "artifact.releaseManifestHash 不匹配时 transitionStatus 必须抛错",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-4e: transitionStatus + resolver + artifact.approvalId !== approvalRef → throws", () => {
  const root = makeTempRoot();
  try {
    const manifest = makeManifest("rel-p0-4e", "candidate_prod", "fp-4e", "approval-4e-expected");
    const registry = setupReleaseInRoot(root, manifest);
    const artifact = makeApprovalArtifact(manifest, { approvalId: "approval-4e-different" });
    const resolver = makeResolver(artifact);

    assert.throws(
      () =>
        registry.transitionStatus("rel-p0-4e", "active_prod", {
          actor: "user",
          approvalRef: "approval-4e-expected",
          resolveApprovalArtifact: resolver,
        }),
      /approvalId|approvalRef|不匹配|一致|artifact/i,
      "artifact.approvalId 与 approvalRef 不匹配时 transitionStatus 必须抛错",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-4f: transitionStatus + resolver + 合法 artifact → succeeds（回归保护）", () => {
  const root = makeTempRoot();
  try {
    const manifest = makeManifest("rel-p0-4f", "candidate_prod", "fp-4f", "approval-4f-legit");
    const registry = setupReleaseInRoot(root, manifest);
    // 合法 artifact：全匹配 + APPROVE_DEV
    const artifact = makeApprovalArtifact(manifest);
    const resolver = makeResolver(artifact);

    const updated = registry.transitionStatus("rel-p0-4f", "active_prod", {
      actor: "user",
      approvalRef: "approval-4f-legit",
      resolveApprovalArtifact: resolver,
    });
    assert.equal(updated.status, "active_prod");
    assert.equal(updated.approvalRef, "approval-4f-legit");
    // 落盘后重读一致
    const reloaded = registry.loadManifest("rel-p0-4f");
    assert.equal(reloaded.status, "active_prod");
    assert.equal(reloaded.approvalRef, "approval-4f-legit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-4g: transitionStatus 无 resolver + 任意 approvalRef 字符串 → succeeds（向后兼容回归保护）", () => {
  const root = makeTempRoot();
  try {
    // 无 resolver：退化为字符串非空检查（开发期/1A 测试兼容）
    // 生产 G6 门禁会注入 resolver，但 transitionStatus 本身保持兼容
    const manifest = makeManifest("rel-p0-4g", "candidate_prod", "fp-4g", "any-string-approval");
    const registry = setupReleaseInRoot(root, manifest);

    const updated = registry.transitionStatus("rel-p0-4g", "active_prod", {
      actor: "user",
      approvalRef: "any-string-approval",
    });
    assert.equal(updated.status, "active_prod");
    assert.equal(updated.approvalRef, "any-string-approval");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
