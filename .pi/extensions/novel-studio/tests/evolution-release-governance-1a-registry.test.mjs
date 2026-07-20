/**
 * EVOLUTION-RELEASE-GOVERNANCE-1A — Registry: append-only 状态变更、链校验、损坏拒绝 (RED)
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §3-§4
 * 任务卡：EVOLUTION-RELEASE-GOVERNANCE-1A 第一批
 *
 * 验收点（任务卡“必须测试”）：
 * - append-only 状态变更记录
 * - 未知 schema 和损坏 artifact 必须明确失败
 * - 不得修改或覆盖用户当前未提交代码
 * - parent/supersedes/rollback 链
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不保存章节、不提交长期状态
 * - 只写 reports/evolution-releases/ 与 config/evolution-release/，不碰用户 WIP
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-schema.js";
import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";

// ============================================================================
// Fixture builders
// ============================================================================

function makeManifest(overrides = {}) {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId: "rel-001",
    status: "draft",
    parentReleaseId: null,
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass: "R1",
    claims: ["improve reader payoff"],
    environmentFingerprint: "sha256:abc",
    artifactRefs: [],
    approvalRef: null,
    createdAt: "2026-07-16T00:00:00Z",
    activatedAt: null,
    ...overrides,
  };
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "evo-rel-reg-"));
}

// ============================================================================
// 1. 基础 CRUD
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: 写入并读取 manifest", () => {
  const dir = makeTempDir();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    const m = makeManifest({ releaseId: "rel-001" });
    registry.writeManifest(m);
    const loaded = registry.loadManifest("rel-001");
    assert.ok(loaded !== null);
    assert.equal(loaded.releaseId, "rel-001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: 读取不存在的 manifest 返回 null", () => {
  const dir = makeTempDir();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    const loaded = registry.loadManifest("rel-missing");
    assert.equal(loaded, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: listManifests 返回全部已写入 manifest", () => {
  const dir = makeTempDir();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    registry.writeManifest(makeManifest({ releaseId: "rel-001" }));
    registry.writeManifest(makeManifest({ releaseId: "rel-002" }));
    const list = registry.listManifests();
    assert.equal(list.length, 2);
    const ids = list.map((m) => m.releaseId).sort();
    assert.deepEqual(ids, ["rel-001", "rel-002"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. Frozen 不可变（写入侧）
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: frozen manifest 写入后不可覆盖（相同 releaseId + 字段变更）", () => {
  const dir = makeTempDir();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    const m = makeManifest({ releaseId: "rel-001", status: "frozen", claims: ["a"] });
    registry.writeManifest(m);

    // 尝试用相同 releaseId 但不同 claims 覆盖
    const mutated = makeManifest({ releaseId: "rel-001", status: "frozen", claims: ["a", "b"] });
    assert.throws(
      () => registry.writeManifest(mutated),
      /frozen|immutable|不可变/i,
      "覆盖 frozen manifest 必须抛错",
    );

    // 原文件未变
    const loaded = registry.loadManifest("rel-001");
    assert.deepEqual(loaded.claims, ["a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: draft manifest 允许覆盖（相同 releaseId + 字段变更）", () => {
  const dir = makeTempDir();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    const m = makeManifest({ releaseId: "rel-001", status: "draft", claims: ["a"] });
    registry.writeManifest(m);

    const updated = makeManifest({ releaseId: "rel-001", status: "draft", claims: ["a", "b"] });
    registry.writeManifest(updated);

    const loaded = registry.loadManifest("rel-001");
    assert.deepEqual(loaded.claims, ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: candidate→frozen 升级允许（相同 releaseId + status 变更 + 其他字段不变）", () => {
  const dir = makeTempDir();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    const m = makeManifest({ releaseId: "rel-001", status: "candidate", claims: ["a"] });
    registry.writeManifest(m);

    const frozen = makeManifest({ releaseId: "rel-001", status: "frozen", claims: ["a"] });
    registry.writeManifest(frozen);

    const loaded = registry.loadManifest("rel-001");
    assert.equal(loaded.status, "frozen");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. Append-only 状态变更记录
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: recordStateEvent 追加状态事件", () => {
  const dir = makeTempDir();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    registry.writeManifest(makeManifest({ releaseId: "rel-001", status: "draft" }));

    registry.recordStateEvent({
      eventId: "evt-001",
      releaseId: "rel-001",
      fromStatus: "draft",
      toStatus: "candidate",
      reason: "ready for freeze",
      actor: "system",
      timestamp: "2026-07-16T01:00:00Z",
    });

    const events = registry.loadStateEvents("rel-001");
    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, "evt-001");
    assert.equal(events[0].toStatus, "candidate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: 状态事件 append-only，不可覆盖", () => {
  const dir = makeTempDir();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    registry.writeManifest(makeManifest({ releaseId: "rel-001", status: "draft" }));

    registry.recordStateEvent({
      eventId: "evt-001",
      releaseId: "rel-001",
      fromStatus: "draft",
      toStatus: "candidate",
      reason: "first",
      actor: "system",
      timestamp: "2026-07-16T01:00:00Z",
    });

    // 再次追加不同事件
    registry.recordStateEvent({
      eventId: "evt-002",
      releaseId: "rel-001",
      fromStatus: "candidate",
      toStatus: "frozen",
      reason: "second",
      actor: "system",
      timestamp: "2026-07-16T02:00:00Z",
    });

    const events = registry.loadStateEvents("rel-001");
    assert.equal(events.length, 2);
    assert.equal(events[0].eventId, "evt-001");
    assert.equal(events[1].eventId, "evt-002");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: 重复 eventId 拒绝", () => {
  const dir = makeTempDir();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    registry.writeManifest(makeManifest({ releaseId: "rel-001", status: "draft" }));

    registry.recordStateEvent({
      eventId: "evt-001",
      releaseId: "rel-001",
      fromStatus: "draft",
      toStatus: "candidate",
      reason: "first",
      actor: "system",
      timestamp: "2026-07-16T01:00:00Z",
    });

    assert.throws(
      () =>
        registry.recordStateEvent({
          eventId: "evt-001",
          releaseId: "rel-001",
          fromStatus: "candidate",
          toStatus: "frozen",
          reason: "duplicate id",
          actor: "system",
          timestamp: "2026-07-16T02:00:00Z",
        }),
      /eventId|duplicate/i,
      "重复 eventId 必须拒绝",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: 非法状态迁移拒绝", () => {
  const dir = makeTempDir();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    registry.writeManifest(makeManifest({ releaseId: "rel-001", status: "draft" }));

    assert.throws(
      () =>
        registry.recordStateEvent({
          eventId: "evt-001",
          releaseId: "rel-001",
          fromStatus: "draft",
          toStatus: "frozen", // 非法跳转
          reason: "illegal jump",
          actor: "system",
          timestamp: "2026-07-16T01:00:00Z",
        }),
      /transition|非法|invalid/i,
      "非法状态迁移必须拒绝",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: loadStateEvents 不存在 releaseId 返回空数组", () => {
  const dir = makeTempDir();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    const events = registry.loadStateEvents("rel-missing");
    assert.deepEqual(events, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. 损坏 artifact 拒绝
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: 损坏 manifest.json 抛错", () => {
  const dir = makeTempDir();
  try {
    const releaseDir = join(dir, "rel-001");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "manifest.json"), "{ not valid json", "utf-8");

    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    assert.throws(
      () => registry.loadManifest("rel-001"),
      /JSON|parse|损坏/i,
      "损坏 JSON 必须明确失败",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: 未知 schemaId 的 manifest 抛错", () => {
  const dir = makeTempDir();
  try {
    const releaseDir = join(dir, "rel-001");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(
      join(releaseDir, "manifest.json"),
      JSON.stringify({
        schemaId: "pinovel.unknown-schema",
        schemaVersion: 1,
        releaseId: "rel-001",
        status: "draft",
      }),
      "utf-8",
    );

    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    assert.throws(
      () => registry.loadManifest("rel-001"),
      /schema|未知/i,
      "未知 schema 必须明确失败",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: 损坏 state-events.jsonl 抛错", () => {
  const dir = makeTempDir();
  try {
    const releaseDir = join(dir, "rel-001");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "state-events.jsonl"), "not a json line\n", "utf-8");

    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    assert.throws(
      () => registry.loadStateEvents("rel-001"),
      /JSON|parse|损坏/i,
      "损坏 jsonl 必须明确失败",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. 原子写入（不残留 partial 文件）
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: writeManifest 原子写入（无 .tmp 残留）", () => {
  const dir = makeTempDir();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    registry.writeManifest(makeManifest({ releaseId: "rel-001" }));

    const releaseDir = join(dir, "rel-001");
    const files = readdirSync(releaseDir);
    assert.ok(!files.some((f) => f.endsWith(".tmp")), "不应残留 .tmp 文件");
    assert.ok(files.includes("manifest.json"), "应含 manifest.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. 不触碰用户 WIP（只写指定目录）
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A registry: 只写 releasesDir，不触碰外部文件", () => {
  const dir = makeTempDir();
  const foreignDir = makeTempDir();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: dir });
    registry.writeManifest(makeManifest({ releaseId: "rel-001" }));
    registry.recordStateEvent({
      eventId: "evt-001",
      releaseId: "rel-001",
      fromStatus: null,
      toStatus: "draft",
      reason: "create",
      actor: "system",
      timestamp: "2026-07-16T00:00:00Z",
    });

    // foreignDir 应保持空
    const foreignFiles = readdirSync(foreignDir);
    assert.deepEqual(foreignFiles, [], "registry 不得写 releasesDir 之外的目录");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(foreignDir, { recursive: true, force: true });
  }
});
