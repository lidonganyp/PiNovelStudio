/**
 * EVOLUTION-RELEASE-GOVERNANCE P0 审批绕过漏洞修复测试（RED → GREEN）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §4 / §11
 *
 * 用户复现的两个 P0 绕过：
 *
 * P0-1（evolution-release-registry.ts:254 transitionStatus）
 *   "transitionStatus 仅验证状态机边，不验证 actor、审批 artifact 或 approvalRef；
 *    调用者可沿合法状态边直接推进至 active_prod。应把生产晋级收敛到受权命令，
 *    并强制验证审批绑定。"
 *
 * P0-2（production-release-gate.ts:288 evaluateProductionReleaseGate）
 *   "门禁只检查 active_prod 和环境指纹，未要求 approvalRef 非空且对应有效审批 artifact。
 *    结合无 actor/审批约束的 transitionStatus，已复现 gateOk=true、approvalRef=null，
 *    未审批 release 可进入生产。"
 *
 * 计划 §4 审批约束（真相源）：
 *   - approved_dev 必须绑定有效的 gpt5.6-sol 代理审批 artifact（approvalRef 非空）
 *   - active_prod 在正式使用阶段必须由用户明确批准系统版本（actor="user" + approvalRef 非空）
 *   - §11：未审批 candidate 无法进入开发或正式生产默认
 *
 * 本测试覆盖：
 *   1. transitionStatus → approval-required 状态（approved_dev/active_dev/candidate_prod/active_prod）
 *      缺 approvalRef → 必须抛错
 *   2. transitionStatus → production-promotion 状态（candidate_prod/active_prod）
 *      actor≠user → 必须抛错
 *   3. transitionStatus → active_prod 合法路径（approvalRef + actor=user）→ 成功
 *   4. 门禁：active_prod 但 approvalRef=null → blocked
 *   5. 门禁：active_prod 但 approvalRef="" → blocked
 *   6. 门禁：active_prod + 合法 approvalRef → ok（回归保护）
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
  return mkdtempSync(join(tmpdir(), "evolution-p0-"));
}

/**
 * 构造 manifest。approvalRef 默认 null（用于复现 P0 绕过）。
 * 写入时直接落盘（绕过 frozen 检查），与 G6 测试 setupReleaseInRoot 一致。
 */
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
    claims: ["p0-test-claim"],
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

/**
 * 写入合法审批 artifact 到 {root}/releases/{releaseId}/approvals/{approvalId}.json。
 * 第二层 P0 修复后，门禁会加载并验证真实 artifact；P0-2c 回归测试必须写入合法 artifact。
 */
function writeLegitApprovalArtifact(root, manifest) {
  const approvalsDir = join(root, "releases", manifest.releaseId, "approvals");
  mkdirSync(approvalsDir, { recursive: true });
  const registry = createProxyApprovalRegistry({ approvalsDir });
  const approvalId = manifest.approvalRef;
  registry.writeArtifact({
    schemaId: PROXY_APPROVAL_SCHEMA_ID,
    schemaVersion: PROXY_APPROVAL_SCHEMA_VERSION,
    approvalId,
    releaseId: manifest.releaseId,
    releaseManifestHash: computeReleasePayloadHash(manifest),
    reviewerType: "validated_human_proxy",
    reviewerModel: PROXY_APPROVAL_REVIEWER_MODEL,
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    reviewTransport: "network",
    promptHash: "sha256:prompt-p0-2c-regression",
    inputArtifactHash: "sha256:input-p0-2c-regression",
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
    finalVerdict: "APPROVE_DEV",
    winningSpans: ["span-win-p0-2c"],
    losingSpans: ["span-lose-p0-2c"],
    risks: [],
    rationale: "p0-2c regression test legit approval",
    decidedAt: "2026-07-16T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 60000 },
    changeClass: manifest.changeClass,
    r3SelfApproval: false,
  });
}

function setActiveProduction(root, releaseId, actor = "user", reason = "p0 test") {
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

// ============================================================================
// P0-1: transitionStatus 缺 actor / approvalRef 守护
// ============================================================================

test("P0-1a: transitionStatus → active_prod 无 approvalRef → 必须抛错（即使 actor=user）", () => {
  const root = makeTempRoot();
  try {
    // 起始状态 candidate_prod（合法前置），approvalRef=null（P0 绕过点）
    const registry = setupReleaseInRoot(
      root,
      makeManifest("rel-p0-1a", "candidate_prod", "fp-hash-1a", null),
    );
    assert.throws(
      () => registry.transitionStatus("rel-p0-1a", "active_prod", { actor: "user" }),
      /approvalRef|审批|approval/i,
      "active_prod 晋级缺 approvalRef 必须抛错（P0-1 绕过：当前允许无审批晋级生产）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1b: transitionStatus → active_prod 有 approvalRef 但 actor≠user → 必须抛错", () => {
  const root = makeTempRoot();
  try {
    // candidate_prod + 合法 approvalRef，但 actor=system（P0 绕过点：无角色约束）
    const registry = setupReleaseInRoot(
      root,
      makeManifest("rel-p0-1b", "candidate_prod", "fp-hash-1b", "apv-1b"),
    );
    assert.throws(
      () =>
        registry.transitionStatus("rel-p0-1b", "active_prod", {
          actor: "system",
          approvalRef: "apv-1b",
        }),
      /actor|user|角色|越权/i,
      "active_prod 晋级必须 actor=user（P0-1 绕过：当前 system 也能晋级生产）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1c: transitionStatus → approved_dev 无 approvalRef → 必须抛错", () => {
  const root = makeTempRoot();
  try {
    // evaluated → approved_dev，缺代理审批 artifact（P0 绕过点）
    const registry = setupReleaseInRoot(
      root,
      makeManifest("rel-p0-1c", "evaluated", "fp-hash-1c", null),
    );
    assert.throws(
      () =>
        registry.transitionStatus("rel-p0-1c", "approved_dev", {
          actor: "gpt5.6-sol-proxy",
        }),
      /approvalRef|审批|approval/i,
      "approved_dev 必须绑定代理审批 artifact（P0-1 绕过：当前无 approvalRef 也能进 approved_dev）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1d: transitionStatus → candidate_prod 无 approvalRef → 必须抛错", () => {
  const root = makeTempRoot();
  try {
    // active_dev → candidate_prod，缺 approvalRef（P0 绕过点）
    const registry = setupReleaseInRoot(
      root,
      makeManifest("rel-p0-1d", "active_dev", "fp-hash-1d", null),
    );
    assert.throws(
      () => registry.transitionStatus("rel-p0-1d", "candidate_prod", { actor: "user" }),
      /approvalRef|审批|approval/i,
      "candidate_prod 晋级缺 approvalRef 必须抛错",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1e: transitionStatus → candidate_prod actor≠user → 必须抛错", () => {
  const root = makeTempRoot();
  try {
    const registry = setupReleaseInRoot(
      root,
      makeManifest("rel-p0-1e", "active_dev", "fp-hash-1e", "apv-1e"),
    );
    assert.throws(
      () =>
        registry.transitionStatus("rel-p0-1e", "candidate_prod", {
          actor: "gpt5.6-sol-proxy",
          approvalRef: "apv-1e",
        }),
      /actor|user|角色|越权/i,
      "candidate_prod 晋级必须 actor=user（生产晋级收敛到用户授权）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1f: transitionStatus → active_dev 无 approvalRef → 必须抛错", () => {
  const root = makeTempRoot();
  try {
    // approved_dev → active_dev，approvalRef 应从 approved_dev 继承；
    // 若 existing.approvalRef=null（P0 绕过：approved_dev 本身就缺审批），active_dev 仍须拒绝
    const registry = setupReleaseInRoot(
      root,
      makeManifest("rel-p0-1f", "approved_dev", "fp-hash-1f", null),
    );
    assert.throws(
      () => registry.transitionStatus("rel-p0-1f", "active_dev", { actor: "system" }),
      /approvalRef|审批|approval/i,
      "active_dev 缺 approvalRef 必须抛错（审批绑定必须沿状态链继承）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1g: transitionStatus → active_prod 合法路径（approvalRef + actor=user）→ 成功", () => {
  const root = makeTempRoot();
  try {
    const registry = setupReleaseInRoot(
      root,
      makeManifest("rel-p0-1g", "candidate_prod", "fp-hash-1g", "apv-1g"),
    );
    const updated = registry.transitionStatus("rel-p0-1g", "active_prod", {
      actor: "user",
      approvalRef: "apv-1g",
    });
    assert.equal(updated.status, "active_prod");
    assert.equal(updated.approvalRef, "apv-1g");
    // 落盘后重读一致
    const reloaded = registry.loadManifest("rel-p0-1g");
    assert.equal(reloaded.status, "active_prod");
    assert.equal(reloaded.approvalRef, "apv-1g");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1h: transitionStatus → evaluated 无 approvalRef/actor 要求 → 仍可由 system 推进（非审批状态）", () => {
  const root = makeTempRoot();
  try {
    // evaluated 不是审批要求状态；actor=system + 无 approvalRef 应允许（回归保护）
    const registry = setupReleaseInRoot(
      root,
      makeManifest("rel-p0-1h", "frozen", "fp-hash-1h", null),
    );
    const updated = registry.transitionStatus("rel-p0-1h", "evaluated", {
      actor: "system",
    });
    assert.equal(updated.status, "evaluated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1i: transitionStatus 缺 actor 参数 → 必须抛错（actor 必填，禁止隐式默认绕过角色守护）", () => {
  const root = makeTempRoot();
  try {
    const registry = setupReleaseInRoot(
      root,
      makeManifest("rel-p0-1i", "frozen", "fp-hash-1i", null),
    );
    assert.throws(
      // 故意不传 actor：要求 TS 与运行时都拒绝
      () => registry.transitionStatus("rel-p0-1i", "evaluated"),
      /actor/i,
      "transitionStatus 必须要求 actor 参数（禁止隐式默认 system 绕过角色守护）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// P0-2: 门禁缺 approvalRef 非空校验
// ============================================================================

test("P0-2a: 门禁 active_prod 但 approvalRef=null → blocked（未审批 release 不得生产运行）", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const fpHash = "matched-hash-p0-2a";
    // active_prod + fingerprint 匹配，但 approvalRef=null（P0 绕过点）
    setupReleaseInRoot(
      root,
      makeManifest("rel-p0-2a", "active_prod", fpHash, null),
    );
    setActiveProduction(root, "rel-p0-2a");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });
    assert.equal(result.ok, false, "approvalRef=null 的 active_prod 必须被门禁阻断");
    assert.equal(result.failureEnvelope.stage, "g6_release_gate");
    assert.equal(result.failureEnvelope.severity, "preflight");
    assert.equal(result.failureEnvelope.degradedTo, "hard_block");
    assert.match(
      result.failureEnvelope.reason,
      /approvalRef|审批|approval/i,
      `reason 应说明 approvalRef 缺失，实际: ${result.failureEnvelope.reason}`,
    );
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-2b: 门禁 active_prod 但 approvalRef='' → blocked（空字符串视同未审批）", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const fpHash = "matched-hash-p0-2b";
    setupReleaseInRoot(
      root,
      makeManifest("rel-p0-2b", "active_prod", fpHash, ""),
    );
    setActiveProduction(root, "rel-p0-2b");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });
    assert.equal(result.ok, false, "approvalRef='' 的 active_prod 必须被门禁阻断");
    assert.equal(result.failureEnvelope.stage, "g6_release_gate");
    assert.match(
      result.failureEnvelope.reason,
      /approvalRef|审批|approval/i,
      `reason 应说明 approvalRef 缺失，实际: ${result.failureEnvelope.reason}`,
    );
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-2c: 门禁 active_prod + 合法 approvalRef + 真实 artifact → ok（回归保护）", () => {
  const root = makeTempRoot();
  const prev = clearDevMode();
  try {
    const fpHash = "matched-hash-p0-2c";
    const manifest = makeManifest("rel-p0-2c", "active_prod", fpHash, "approval-artifact-p0-2c");
    setupReleaseInRoot(root, manifest);
    // 第二层 P0 修复后门禁会加载并验证真实 artifact，必须写入合法 artifact 才能通过回归
    writeLegitApprovalArtifact(root, manifest);
    setActiveProduction(root, "rel-p0-2c");

    const result = evaluateProductionReleaseGate({
      projectRoot: PROJECT_ROOT,
      evolutionRoot: root,
      currentFingerprintHash: fpHash,
    });
    assert.equal(result.ok, true, "合法 approvalRef + 真实 artifact 的 active_prod 应通过门禁");
    assert.equal(result.devMode, false);
    assert.equal(result.releaseId, "rel-p0-2c");
    assert.equal(result.approvalRef, "approval-artifact-p0-2c");
  } finally {
    restoreDevMode(prev);
    rmSync(root, { recursive: true, force: true });
  }
});
