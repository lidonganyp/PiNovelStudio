/**
 * EVOLUTION-RELEASE-GOVERNANCE-1A — Pointer Store: 原子切换、双 active 拒绝、回滚 (RED)
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §3-§4
 * 任务卡：EVOLUTION-RELEASE-GOVERNANCE-1A 第一批
 *
 * 验收点（任务卡“必须测试”）：
 * - 禁止同时存在两个 active pointer
 * - eval/test 不得修改生产 pointer
 * - pointer 原子切换
 * - 完成一次 active pointer → rollback 的本地演练
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不保存章节、不提交长期状态
 * - 只写 config/evolution-release/ 目录
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReleasePointerStore } from "../dist-test/v2/governance/release-pointer-store.js";

// ============================================================================
// Fixture
// ============================================================================

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "evo-rel-ptr-"));
}

// ============================================================================
// 1. 基础读写
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: 初始无 active pointer 返回 null", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    assert.equal(store.readActive("development"), null);
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: 写入 development active pointer 后可读取", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    store.switchActive("development", "rel-001", { reason: "initial promote", actor: "system" });
    const ptr = store.readActive("development");
    assert.ok(ptr !== null);
    assert.equal(ptr.releaseId, "rel-001");
    assert.equal(ptr.kind, "development");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: development 与 production pointer 独立", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    store.switchActive("development", "rel-001", { reason: "dev promote", actor: "system" });
    store.switchActive("production", "rel-000", { reason: "prod stable", actor: "user" });

    assert.equal(store.readActive("development").releaseId, "rel-001");
    assert.equal(store.readActive("production").releaseId, "rel-000");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. 原子切换 + 备份旧 pointer
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: switchActive 返回旧 pointer 摘要", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    store.switchActive("development", "rel-001", { reason: "first", actor: "system" });
    const prev = store.switchActive("development", "rel-002", {
      reason: "second",
      actor: "system",
    });
    assert.ok(prev !== null);
    assert.equal(prev.releaseId, "rel-001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: 首次 switchActive 返回 null（无旧 pointer）", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    const prev = store.switchActive("development", "rel-001", {
      reason: "first",
      actor: "system",
    });
    assert.equal(prev, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: rollback 恢复到备份 pointer", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    store.switchActive("development", "rel-001", { reason: "first", actor: "system" });
    store.switchActive("development", "rel-002", { reason: "second", actor: "system" });

    // rollback 到上一个
    const restored = store.rollback("development", { reason: "regression", actor: "user" });
    assert.ok(restored !== null);
    assert.equal(restored.releaseId, "rel-001");

    // 当前 active 已回到 rel-001
    assert.equal(store.readActive("development").releaseId, "rel-001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: rollback 无历史记录时抛错", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    assert.throws(
      () => store.rollback("development", { reason: "no history", actor: "user" }),
      /rollback|history|无历史/i,
      "无历史可回滚时必须明确失败",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. append-only rollback 历史
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: rollback-history 是 append-only", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    store.switchActive("development", "rel-001", { reason: "first", actor: "system" });
    store.switchActive("development", "rel-002", { reason: "second", actor: "system" });
    store.rollback("development", { reason: "rollback 1", actor: "user" });
    store.switchActive("development", "rel-003", { reason: "third", actor: "system" });
    store.rollback("development", { reason: "rollback 2", actor: "user" });

    const history = store.loadRollbackHistory("development");
    assert.equal(history.length, 2);
    assert.equal(history[0].reason, "rollback 1");
    assert.equal(history[1].reason, "rollback 2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. eval/test 不得修改生产 pointer
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: evaluation 角色禁止切换 production pointer", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    assert.throws(
      () =>
        store.switchActive("production", "rel-001", {
          reason: "eval attempt",
          actor: "evaluation",
        }),
      /production|forbidden|禁止|actor/i,
      "evaluation 角色不得修改 production pointer",
    );
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: test 角色禁止切换 production pointer", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    assert.throws(
      () =>
        store.switchActive("production", "rel-001", {
          reason: "test attempt",
          actor: "test",
        }),
      /production|forbidden|禁止|actor/i,
      "test 角色不得修改 production pointer",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: evaluation 角色禁止 rollback production pointer", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    // 先由 user 设置 production pointer
    store.switchActive("production", "rel-001", { reason: "user init", actor: "user" });
    store.switchActive("production", "rel-002", { reason: "user update", actor: "user" });

    assert.throws(
      () =>
        store.rollback("production", { reason: "eval attempt", actor: "evaluation" }),
      /production|forbidden|禁止|actor/i,
      "evaluation 角色不得 rollback production pointer",
    );

    // 当前 production pointer 未变
    assert.equal(store.readActive("production").releaseId, "rel-002");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: evaluation 角色可写 development pointer（开发期）", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    // development pointer 允许 evaluation/system 写
    store.switchActive("development", "rel-001", { reason: "dev", actor: "evaluation" });
    assert.equal(store.readActive("development").releaseId, "rel-001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. 原子写入（不残留 .tmp）
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: switchActive 原子写入", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    store.switchActive("development", "rel-001", { reason: "first", actor: "system" });

    const activeDev = join(dir, "active-development.json");
    assert.ok(existsSync(activeDev), "应存在 active-development.json");
    const content = readFileSync(activeDev, "utf-8");
    assert.ok(!content.includes(".tmp"));
    // 不应残留 .tmp
    const files = readdirSync(dir);
    assert.ok(!files.some((f) => f.endsWith(".tmp")), "不应残留 .tmp 文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. 损坏 pointer 文件拒绝
// ============================================================================

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: 损坏 active-development.json 抛错", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "active-development.json"), "{ broken json", "utf-8");
    const store = createReleasePointerStore({ configDir: dir });
    assert.throws(
      () => store.readActive("development"),
      /JSON|parse|损坏/i,
      "损坏 pointer 文件必须明确失败",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: 未知 schemaId 的 pointer 抛错", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(
      join(dir, "active-development.json"),
      JSON.stringify({
        schemaId: "pinovel.unknown",
        schemaVersion: 1,
        kind: "development",
        releaseId: "rel-001",
        switchedAt: "2026-07-16T00:00:00Z",
      }),
      "utf-8",
    );
    const store = createReleasePointerStore({ configDir: dir });
    assert.throws(
      () => store.readActive("development"),
      /schema|未知/i,
      "未知 schema 必须明确失败",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: revokeActive 删除 production pointer 且不切后继", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    store.switchActive("production", "rel-held-120", { reason: "P6 approved", actor: "user" });
    assert.equal(store.readActive("production").releaseId, "rel-held-120");

    const previous = store.revokeActive("production", {
      actor: "user",
      reason: "P6 ARM_GRADER_FAILED; held release must not remain production",
    });
    assert.equal(previous.releaseId, "rel-held-120");
    assert.equal(store.readActive("production"), null);
    assert.equal(existsSync(join(dir, "active-production.json")), false);

    const history = readFileSync(join(dir, "rollback-history-production.jsonl"), "utf-8");
    assert.match(history, /"operation":"revoke"/);
    assert.doesNotMatch(history, /rel-prod-115/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVOLUTION-RELEASE-GOVERNANCE-1A pointer: system 不得 revoke production pointer", () => {
  const dir = makeTempDir();
  try {
    const store = createReleasePointerStore({ configDir: dir });
    store.switchActive("production", "rel-001", { reason: "user init", actor: "user" });
    assert.throws(
      () => store.revokeActive("production", { actor: "system", reason: "auto" }),
      /production|禁止|actor/i,
    );
    assert.equal(store.readActive("production").releaseId, "rel-001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
