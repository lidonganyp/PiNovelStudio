/**
 * DATA-VERSION-RELEASE-GOVERNANCE DG-7 — 验收矩阵、回放与发布演练（P0 验收）
 *
 * 真相源：docs/data-version-release-governance-development-plan-20260813.md §5 DG-7
 * 任务卡：DG-7「验收矩阵、回放与发布演练」
 *
 * 验收（任务卡）：
 * - npm run build / build:prod / build:test / typecheck 与相关治理测试通过（构建侧，由 CI 与
 *   dependency-boundary 保障；本文件覆盖「演练」部分）
 * - 完成一次 candidate→freeze→evaluate→approve→active_dev→candidate_prod→active_prod 演练
 * - 完成一次收敛后前向修复演练
 *
 * 本文件用自动化测试证明治理规则（而非仅证明类型/构建通过）：
 * 1. 完整生命周期演练（状态机逐级推进 + 单例收敛）
 * 2. 收敛后前向修复演练（旧基线退役 → 新 release 晋级）
 * 3. 验收矩阵：把「必须覆盖」表中的纯函数治理不变量做表驱动断言
 *    （双 active 失败 / frozen 不可写 / R3 无批准不晋级 / 单次反馈不切 pointer / 旧 release 终态）
 *
 * 其余场景（同一环境重复 capture 一致、Prompt/工具/路由/上下文变化产生新 bundleId、candidate
 * 生产拒绝读取、旧模型 evidence 隔离拒绝、canary 越权/超时阻断、pointer 损坏 fail-closed、
 * 生产 trace 含身份、仅改 Eval 协议产生新 evalProtocolVersion）由 DG-1..DG-6 各自测试覆盖，
 * 见对应 data-version-release-governance-dg{1..6}-*.test.mjs。
 *
 * 边界（READY_LOCAL）：仅 registry / schema / 纯函数，无模型 / 无网络。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import { isTerminalStatus, getValidTransitions } from "../dist-test/v2/governance/evolution-release-schema.js";
import {
  assertActiveProdSingleton,
  assertFieldsWritable,
  evaluatePromotionPermission,
} from "../dist-test/v2/governance/release-lifecycle-permissions.js";
import { singleFeedbackCanSwitchProductionBaseline } from "../dist-test/v2/learning/strategy-promotion-governance.js";

// ============================================================================
// helpers
// ============================================================================

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "dg7-acceptance-"));
}

function makeRegistry(root) {
  return createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
}

function makeManifest(releaseId, status, opts = {}) {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status,
    parentReleaseId: opts.parentReleaseId ?? "rel-000",
    rollbackReleaseId: opts.rollbackReleaseId ?? "rel-000",
    supersedesRef: null,
    changeClass: opts.changeClass ?? "R1",
    claims: opts.claims ?? ["test-claim"],
    environmentFingerprint: "fp-test-hash",
    artifactRefs: [],
    approvalRef: opts.approvalRef ?? null,
    createdAt: "2026-07-16T00:00:00.000Z",
    activatedAt: null,
  };
}

/** 全生命周期逐级推进（candidate → active_prod），每一步都经 transitionStatus 状态机校验。 */
function walkFullLifecycle(registry, releaseId, approvalRef, listAll) {
  registry.transitionStatus(releaseId, "frozen", { actor: "system" });
  registry.transitionStatus(releaseId, "evaluated", { actor: "system" });
  registry.transitionStatus(releaseId, "approved_dev", { actor: "system", approvalRef });
  registry.transitionStatus(releaseId, "active_dev", { actor: "system", approvalRef });
  registry.transitionStatus(releaseId, "candidate_prod", { actor: "user", approvalRef });
  registry.transitionStatus(releaseId, "active_prod", {
    actor: "user",
    approvalRef,
    resolveAllManifests: listAll,
  });
}

// ============================================================================
// 1. 完整生命周期演练
// ============================================================================

test("DG-7: 完整生命周期演练 candidate→frozen→evaluated→approved_dev→active_dev→candidate_prod→active_prod", () => {
  const root = makeTempRoot();
  try {
    const registry = makeRegistry(root);
    const listAll = () => registry.listManifests();

    registry.writeManifest(makeManifest("rel-d7", "candidate"));
    walkFullLifecycle(registry, "rel-d7", "apr-d7", listAll);

    const m = registry.loadManifest("rel-d7");
    assert.equal(m.status, "active_prod");
    assert.equal(m.approvalRef, "apr-d7");

    // 可执行生产基线只有一套
    const active = registry.listManifests().filter((x) => x.status === "active_prod");
    assert.deepEqual(active.map((x) => x.releaseId), ["rel-d7"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. 收敛后前向修复演练
// ============================================================================

test("DG-7: 收敛后前向修复演练——退役旧基线后新 release 晋级（旧基线退役为终态，仅审计读取）", () => {
  const root = makeTempRoot();
  try {
    const registry = makeRegistry(root);
    const listAll = () => registry.listManifests();

    // 旧基线 rel-v1 → active_prod
    registry.writeManifest(makeManifest("rel-v1", "candidate"));
    walkFullLifecycle(registry, "rel-v1", "apr-v1", listAll);

    // 新 release rel-v2（前向修复）走到 candidate_prod
    registry.writeManifest(makeManifest("rel-v2", "candidate", { parentReleaseId: "rel-v1" }));
    registry.transitionStatus("rel-v2", "frozen", { actor: "system" });
    registry.transitionStatus("rel-v2", "evaluated", { actor: "system" });
    registry.transitionStatus("rel-v2", "approved_dev", { actor: "system", approvalRef: "apr-v2" });
    registry.transitionStatus("rel-v2", "active_dev", { actor: "system", approvalRef: "apr-v2" });
    registry.transitionStatus("rel-v2", "candidate_prod", { actor: "user", approvalRef: "apr-v2" });

    // 收敛：旧基线退役（active_prod → retired）→ 进入终态，仅审计读取。
    // 注意：物理删除旧可执行文件/分支属生产操作，本 registry 级测试只验证状态机退役，
    // 不删除真实可执行文件（生产侧退役清理见计划 DG-6「物理删除旧可执行生产分支」，需授权执行）。
    registry.transitionStatus("rel-v1", "retired", { actor: "user" });
    assert.equal(registry.loadManifest("rel-v1").status, "retired");

    // 新 release 晋级 active_prod
    registry.transitionStatus("rel-v2", "active_prod", {
      actor: "user",
      approvalRef: "apr-v2",
      resolveAllManifests: listAll,
    });

    // 可执行生产基线只有一套（rel-v2）；rel-v1 退役为终态，仅能审计读取
    const active = registry.listManifests().filter((x) => x.status === "active_prod");
    assert.deepEqual(active.map((x) => x.releaseId), ["rel-v2"]);
    assert.equal(isTerminalStatus("retired"), true);
    assert.deepEqual(getValidTransitions("retired"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. 验收矩阵（纯函数治理不变量，表驱动）
// ============================================================================

test("DG-7: 验收矩阵——纯函数治理不变量", () => {
  // 场景：两个 active_prod → 操作失败（assertActiveProdSingleton）
  const doubleActive = assertActiveProdSingleton(
    [
      { releaseId: "rel-old", status: "active_prod" },
      { releaseId: "rel-new", status: "candidate_prod" },
    ],
    "rel-new",
  );
  assert.equal(doubleActive.ok, false);
  assert.deepEqual(doubleActive.conflictingReleaseIds, ["rel-old"]);

  // 场景：frozen manifest 原地修改 → 操作失败（assertFieldsWritable 拒绝行为字段）
  const frozenWrite = assertFieldsWritable("frozen", ["status", "bundleId"]);
  assert.equal(frozenWrite.ok, false);
  assert.deepEqual(frozenWrite.blockedFields, ["bundleId"]);

  // 场景：R3 变更无用户批准不得晋级（evaluatePromotionPermission）
  const r3NoApproval = evaluatePromotionPermission({
    changeClass: "R3",
    actor: "system",
    targetStatus: "active_prod",
    hasEvalReport: false,
    hasReplayReport: false,
    hasHumanApproval: false,
    approvalRef: null,
  });
  assert.equal(r3NoApproval.ok, false);
  assert.ok(r3NoApproval.missingEvidence.includes("actor=user"));
  assert.ok(r3NoApproval.missingEvidence.includes("humanApproval"));

  // 场景：单次用户反馈不切换 production pointer
  assert.equal(singleFeedbackCanSwitchProductionBaseline(), false);

  // 场景：旧 release 退役为终态（rejected/quarantined/revoked/retired 不可迁移）
  for (const s of ["rejected", "quarantined", "revoked", "retired"]) {
    assert.equal(isTerminalStatus(s), true, `${s} 应为终态`);
    assert.deepEqual(getValidTransitions(s), [], `${s} 不可迁移`);
  }
});
