/**
 * DATA-VERSION-RELEASE-GOVERNANCE DG-6 — 单一生产基线迁移与旧可执行逻辑收敛
 *
 * 真相源：docs/data-version-release-governance-development-plan-20260813.md §5 DG-6
 * 任务卡：DG-6「单一生产基线迁移」
 *
 * 验收点（任务卡“必须测试”）：
 * - 可执行生产基线只有一套（active_prod 单例，通过 transitionStatus 注入 resolveAllManifests 强制）
 * - 新旧生产逻辑并行存在为 0（双 active 直接失败；无 resolver 时向后兼容，不误伤既有流程）
 * - 旧 release 仅能审计读取（退役后为终态，不可原地再晋级；只有新 release 是 active_prod）
 * - 前向修复发布流程可演练（旧基线退役 → 新 release 晋级 active_prod 的单一基线收敛）
 *
 * 边界（READY_LOCAL）：
 * - 仅 registry / schema 纯函数，无模型 / 无真实 pointer 切换 / 无网络
 * - 复用 DG-5 release-lifecycle-permissions 的 assertActiveProdSingleton（经 registry 注入）
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

// ============================================================================
// helpers
// ============================================================================

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "dg6-single-baseline-"));
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

/** 把 release 从 candidate 全生命周期走到 active_prod（不含最终 active_prod 单例校验注入）。 */
function walkToActiveProd(registry, releaseId, approvalRef, { listAll } = {}) {
  registry.transitionStatus(releaseId, "frozen", { actor: "system" });
  registry.transitionStatus(releaseId, "evaluated", { actor: "system" });
  registry.transitionStatus(releaseId, "approved_dev", { actor: "system", approvalRef });
  registry.transitionStatus(releaseId, "active_dev", { actor: "system", approvalRef });
  registry.transitionStatus(releaseId, "candidate_prod", { actor: "user", approvalRef });
  registry.transitionStatus(releaseId, "active_prod", {
    actor: "user",
    approvalRef,
    resolveAllManifests: listAll ?? (() => registry.listManifests()),
  });
}

// ============================================================================
// 1. active_prod 单例（单一生产基线）
// ============================================================================

test("DG-6: active_prod 单例——第二个 active_prod 直接失败（resolveAllManifests 注入）", () => {
  const root = makeTempRoot();
  try {
    const registry = makeRegistry(root);
    registry.writeManifest(makeManifest("rel-a", "active_prod", { approvalRef: "apr-a" }));
    registry.writeManifest(makeManifest("rel-b", "candidate_prod", { approvalRef: "apr-b" }));

    assert.throws(
      () =>
        registry.transitionStatus("rel-b", "active_prod", {
          actor: "user",
          approvalRef: "apr-b",
          resolveAllManifests: () => registry.listManifests(),
        }),
      /单例|active_prod/,
    );

    // 双 active 直接失败：rel-a 仍 active_prod，rel-b 未晋级（不可产生第二个可执行基线）
    assert.equal(registry.loadManifest("rel-a").status, "active_prod");
    assert.equal(registry.loadManifest("rel-b").status, "candidate_prod");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DG-6: 无 resolveAllManifests 注入时保持向后兼容（不误伤既有流程）", () => {
  const root = makeTempRoot();
  try {
    const registry = makeRegistry(root);
    registry.writeManifest(makeManifest("rel-a", "active_prod", { approvalRef: "apr-a" }));
    registry.writeManifest(makeManifest("rel-b", "candidate_prod", { approvalRef: "apr-b" }));

    // 未注入 resolver → 单例校验跳过（开发期/既有 CLI 测试兼容）
    const updated = registry.transitionStatus("rel-b", "active_prod", {
      actor: "user",
      approvalRef: "apr-b",
    });
    assert.equal(updated.status, "active_prod");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DG-6: 首个 active_prod 无冲突，单例校验放行", () => {
  const root = makeTempRoot();
  try {
    const registry = makeRegistry(root);
    registry.writeManifest(makeManifest("rel-v1", "candidate_prod", { approvalRef: "apr-v1" }));

    const updated = registry.transitionStatus("rel-v1", "active_prod", {
      actor: "user",
      approvalRef: "apr-v1",
      resolveAllManifests: () => registry.listManifests(),
    });
    assert.equal(updated.status, "active_prod");

    const active = registry.listManifests().filter((m) => m.status === "active_prod");
    assert.deepEqual(active.map((m) => m.releaseId), ["rel-v1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. 前向修复发布演练（单一基线收敛）
// ============================================================================

test("DG-6: 前向修复发布演练——旧基线退役后新 release 晋级 active_prod", () => {
  const root = makeTempRoot();
  try {
    const registry = makeRegistry(root);
    const listAll = () => registry.listManifests();

    // rel-v1 走完全生命周期 → active_prod
    registry.writeManifest(makeManifest("rel-v1", "candidate"));
    walkToActiveProd(registry, "rel-v1", "apr-v1", { listAll });
    assert.equal(registry.loadManifest("rel-v1").status, "active_prod");

    // 前向修复：新 release rel-v2（单一基线迁移前，旧基线保持 active_prod）
    registry.writeManifest(makeManifest("rel-v2", "candidate", { parentReleaseId: "rel-v1" }));
    registry.transitionStatus("rel-v2", "frozen", { actor: "system" });
    registry.transitionStatus("rel-v2", "evaluated", { actor: "system" });
    registry.transitionStatus("rel-v2", "approved_dev", { actor: "system", approvalRef: "apr-v2" });
    registry.transitionStatus("rel-v2", "active_dev", { actor: "system", approvalRef: "apr-v2" });
    registry.transitionStatus("rel-v2", "candidate_prod", { actor: "user", approvalRef: "apr-v2" });

    // 若此时直接晋级 rel-v2 → active_prod，双 active 直接失败
    assert.throws(
      () =>
        registry.transitionStatus("rel-v2", "active_prod", {
          actor: "user",
          approvalRef: "apr-v2",
          resolveAllManifests: listAll,
        }),
      /单例|active_prod/,
    );

    // 单一基线收敛：先退役旧基线 rel-v1（active_prod → retired）
    registry.transitionStatus("rel-v1", "retired", { actor: "user" });
    assert.equal(registry.loadManifest("rel-v1").status, "retired");

    // 再晋级 rel-v2 → active_prod，单例不冲突
    registry.transitionStatus("rel-v2", "active_prod", {
      actor: "user",
      approvalRef: "apr-v2",
      resolveAllManifests: listAll,
    });
    assert.equal(registry.loadManifest("rel-v2").status, "active_prod");

    // 可执行生产基线只有一套
    const active = registry.listManifests().filter((m) => m.status === "active_prod");
    assert.deepEqual(active.map((m) => m.releaseId), ["rel-v2"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. 旧 release 仅能审计读取（退役终态）
// ============================================================================

test("DG-6: 旧 release 退役后为终态，仅能审计读取（不可原地再晋级）", () => {
  // retired 是终态：不可再迁移回任何 active 状态
  assert.equal(isTerminalStatus("retired"), true);
  assert.deepEqual(getValidTransitions("retired"), []);
  assert.deepEqual(getValidTransitions("revoked"), []);
  assert.deepEqual(getValidTransitions("quarantined"), []);
});

test("DG-6: R3 无用户批准不能晋级（生产晋级 actor 守护）", () => {
  const root = makeTempRoot();
  try {
    const registry = makeRegistry(root);
    registry.writeManifest(
      makeManifest("rel-r3", "candidate_prod", { approvalRef: "apr-r3", changeClass: "R3" }),
    );

    assert.throws(
      () =>
        registry.transitionStatus("rel-r3", "active_prod", {
          actor: "system",
          approvalRef: "apr-r3",
        }),
      /actor|user/,
    );
    assert.equal(registry.loadManifest("rel-r3").status, "candidate_prod");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
