/**
 * MEMORY-4 事务化状态提交 + MEMORY-5 冲突/版本化/遗忘测试
 *
 * 验收口径（任务文档 §八/§九/§十二）：
 * - MEMORY-4: StagedMemoryUpdate 校验、finalTextHash 绑定、MemoryCommitReceipt
 * - MEMORY-4: 被阻断稿/失败稿对长期状态零污染（finalTextHash 未冻结拒绝）
 * - MEMORY-5: 硬冲突不静默覆盖（hard_conflict_blocked）
 * - MEMORY-5: 新正文可合法更新旧人物状态（new_text_wins）
 * - MEMORY-5: 覆盖保留历史版本（versionizeMemory + supersedes）
 * - MEMORY-5: TTL 到期诊断不进入后续章节（shouldDefaultRetrieve）
 * - MEMORY-5: 分层 permanent/active/archived/expired
 * - MEMORY-5: 硬冲突生成 FailureEnvelope（buildMemoryHardConflictEnvelope）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateStagedMemoryUpdate,
  detectMemoryConflicts,
  buildMemoryCommitReceipt,
} from "../dist-test/v2/core/memory/memory-transaction.js";
import {
  tierForMemory,
  shouldDefaultRetrieve,
  evaluateTtl,
  versionizeMemory,
  buildMemoryHardConflictEnvelope,
} from "../dist-test/v2/core/memory/memory-lifecycle.js";

function makeRecord(overrides = {}) {
  return {
    memoryId: "canon:world:genre",
    memoryType: "canon",
    authorityClass: "final_text_explicit",
    epistemicStatus: "confirmed",
    lifecycleStatus: "active",
    sourceChapter: 3,
    sourceRef: ["ch3#finalText:abc123def456:10-20"],
    textHash: ["abc123def456"],
    sourceRunId: "run-ch3",
    sourceFinalTextHash: "abc123def456",
    createdAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:00Z",
    expiresAt: null,
    confidence: 0.8,
    derivedFromMemoryIds: [],
    supersedesMemoryIds: [],
    payload: {
      memoryType: "canon",
      data: { value: "仙侠世界", category: "genre", key: "canon:world:genre" },
    },
    ...overrides,
  };
}

// ============================================================================
// MEMORY-4 事务
// ============================================================================

test("MEMORY-4: 合法 StagedMemoryUpdate 通过校验", () => {
  const update = {
    records: [makeRecord()],
    invalidations: [],
    sourceChapter: 3,
    sourceRunId: "run-ch3",
    finalTextHash: "abc123def456",
  };
  const v = validateStagedMemoryUpdate(update);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.valid.length, 1);
});

test("MEMORY-4: finalTextHash 未冻结时拒绝（防止状态先于正文保存提交）", () => {
  const update = {
    records: [makeRecord()],
    invalidations: [],
    sourceChapter: 3,
    sourceRunId: "run-ch3",
    finalTextHash: null,
  };
  const v = validateStagedMemoryUpdate(update);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("finalTextHash 未冻结")));
});

test("MEMORY-4: 缺少 sourceRunId 拒绝", () => {
  const update = {
    records: [makeRecord()],
    invalidations: [],
    sourceChapter: 3,
    sourceRunId: "",
    finalTextHash: "abc123def456",
  };
  const v = validateStagedMemoryUpdate(update);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("sourceRunId")));
});

test("MEMORY-4: 非法记录被隔离到 invalid，不进入 valid", () => {
  const update = {
    records: [
      makeRecord(), // 合法
      makeRecord({ authorityClass: "model_planned" }), // 非法（正式事实不允许 plan 权威）
    ],
    invalidations: [],
    sourceChapter: 3,
    sourceRunId: "run-ch3",
    finalTextHash: "abc123def456",
  };
  const v = validateStagedMemoryUpdate(update);
  assert.equal(v.ok, false);
  assert.equal(v.valid.length, 1);
  assert.equal(v.invalid.length, 1);
  assert.ok(v.invalid[0].errors.some((e) => e.includes("正式事实只允许")));
});

test("MEMORY-4: MemoryCommitReceipt 记录正文 hash/状态版本/变更/冲突/时间", () => {
  const receipt = buildMemoryCommitReceipt({
    workspaceId: "xinmo",
    sourceChapter: 3,
    finalTextHash: "abc123def456",
    sourceRunId: "run-ch3",
    stateVersion: "ch3-2026-08-11",
    committed: [makeRecord()],
    rejected: [{ memoryId: "bad", errors: ["x"] }],
    invalidatedIds: ["canon:old"],
    conflicts: [],
  });
  assert.equal(receipt.finalTextHash, "abc123def456");
  assert.equal(receipt.sourceRunId, "run-ch3");
  assert.equal(receipt.committed, 1);
  assert.ok(receipt.committedIds.includes("canon:world:genre"));
  assert.equal(receipt.rejected.length, 1);
  assert.ok(receipt.invalidatedIds.includes("canon:old"));
  assert.ok(receipt.receiptId.startsWith("receipt-3-"));
  assert.ok(receipt.committedAt);
});

// ============================================================================
// MEMORY-5 冲突检测
// ============================================================================

test("MEMORY-5: 新正文与旧 Canon 硬冲突 → hard_conflict_blocked（不静默覆盖）", () => {
  const existing = [
    makeRecord({
      memoryId: "canon:world:genre",
      payload: {
        memoryType: "canon",
        data: { value: "仙侠世界", category: "genre", key: "canon:world:genre" },
      },
    }),
  ];
  const incoming = [
    makeRecord({
      memoryId: "canon:world:genre-v2",
      payload: {
        memoryType: "canon",
        data: { value: "玄幻世界", category: "genre", key: "canon:world:genre" },
      },
    }),
  ];
  const conflicts = detectMemoryConflicts(incoming, existing);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].resolution, "hard_conflict_blocked");
  assert.ok(conflicts[0].reason.includes("硬冲突"));
});

test("MEMORY-5: 新正文显式 supersedes 旧 Canon → superseded", () => {
  const existing = [
    makeRecord({
      memoryId: "canon:world:genre",
      payload: {
        memoryType: "canon",
        data: { value: "仙侠世界", category: "genre", key: "canon:world:genre" },
      },
    }),
  ];
  const incoming = [
    makeRecord({
      memoryId: "canon:world:genre-v2",
      supersedesMemoryIds: ["canon:world:genre"],
      payload: {
        memoryType: "canon",
        data: { value: "玄幻世界", category: "genre", key: "canon:world:genre" },
      },
    }),
  ];
  const conflicts = detectMemoryConflicts(incoming, existing);
  assert.equal(conflicts[0].resolution, "superseded");
});

test("MEMORY-5: 新正文合法更新旧人物状态 → new_text_wins", () => {
  const existing = [
    makeRecord({
      memoryId: "character:叶尘:realm",
      memoryType: "character",
      payload: {
        memoryType: "character",
        data: { value: "练气期", category: "realm", key: "character:叶尘:realm" },
      },
    }),
  ];
  const incoming = [
    makeRecord({
      memoryId: "character:叶尘:realm-v2",
      memoryType: "character",
      payload: {
        memoryType: "character",
        data: { value: "筑基期", category: "realm", key: "character:叶尘:realm" },
      },
    }),
  ];
  const conflicts = detectMemoryConflicts(incoming, existing);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].resolution, "new_text_wins");
});

test("MEMORY-5: 相同记忆自身更新不算冲突", () => {
  const existing = [makeRecord()];
  const incoming = [makeRecord()]; // 同 memoryId
  const conflicts = detectMemoryConflicts(incoming, existing);
  assert.equal(conflicts.length, 0);
});

// ============================================================================
// MEMORY-5 版本化 + supersede
// ============================================================================

test("MEMORY-5: versionizeMemory 保留历史版本并标记 supersedes", () => {
  const existing = makeRecord({ memoryId: "character:叶尘:realm", updatedAt: "2026-08-01T00:00:00Z" });
  const incoming = makeRecord({
    memoryId: "character:叶尘:realm-v2",
    updatedAt: "2026-08-11T00:00:00Z",
  });
  const v = versionizeMemory(incoming, existing);
  assert.equal(v.supersedesMemoryId, "character:叶尘:realm");
  assert.ok(v.record.supersedesMemoryIds.includes("character:叶尘:realm"));
});

// ============================================================================
// MEMORY-5 分层 + TTL
// ============================================================================

test("MEMORY-5: canon/promise/source_text 永久保留", () => {
  const now = Date.now();
  assert.equal(tierForMemory(makeRecord({ memoryType: "canon" }), now), "permanent");
  assert.equal(tierForMemory(makeRecord({ memoryType: "promise" }), now), "permanent");
  assert.equal(tierForMemory(makeRecord({ memoryType: "source_text" }), now), "permanent");
});

test("MEMORY-5: 过期诊断不进入后续章节事实上下文", () => {
  const now = Date.now();
  const expiredDiag = makeRecord({
    memoryType: "diagnostic",
    authorityClass: "diagnostic_hypothesis",
    epistemicStatus: "hypothesis",
    lifecycleStatus: "active",
    expiresAt: new Date(now - 1000).toISOString(), // 已过期
    payload: { memoryType: "diagnostic", data: { kind: "risk", detail: "x", ttlSeconds: 1 } },
  });
  assert.equal(tierForMemory(expiredDiag, now), "expired");
  assert.equal(shouldDefaultRetrieve(expiredDiag, now), false);
});

test("MEMORY-5: 未过期诊断可参与（但仍不得作为正式事实）", () => {
  const now = Date.now();
  const liveDiag = makeRecord({
    memoryType: "diagnostic",
    authorityClass: "diagnostic_hypothesis",
    epistemicStatus: "hypothesis",
    lifecycleStatus: "active",
    expiresAt: new Date(now + 10000).toISOString(),
    payload: { memoryType: "diagnostic", data: { kind: "risk", detail: "x", ttlSeconds: 10 } },
  });
  // 分层上是 active，但 shouldDefaultRetrieve 对 conflict 排除；诊断默认不参与正式事实（isFormalFactEvidence 把关）
  assert.equal(tierForMemory(liveDiag, now), "active");
});

test("MEMORY-5: superseded/archived 记录转入归档层", () => {
  const now = Date.now();
  assert.equal(
    tierForMemory(makeRecord({ lifecycleStatus: "superseded" }), now),
    "archived"
  );
  assert.equal(
    tierForMemory(makeRecord({ lifecycleStatus: "archived" }), now),
    "archived"
  );
});

test("MEMORY-5: evaluateTtl 判定诊断到期", () => {
  const now = Date.now();
  const diag = makeRecord({
    memoryType: "diagnostic",
    authorityClass: "diagnostic_hypothesis",
    epistemicStatus: "hypothesis",
    expiresAt: new Date(now - 1000).toISOString(),
    payload: { memoryType: "diagnostic", data: { kind: "risk", detail: "x", ttlSeconds: 1 } },
  });
  assert.equal(evaluateTtl(diag, now).expired, true);
  assert.equal(evaluateTtl(makeRecord(), now).expired, false);
});

// ============================================================================
// MEMORY-5 硬冲突 FailureEnvelope
// ============================================================================

test("MEMORY-5: 硬冲突生成不可恢复 FailureEnvelope（禁止静默覆盖）", () => {
  const env = buildMemoryHardConflictEnvelope({
    memoryType: "canon",
    key: "canon:world:genre",
    existingMemoryId: "canon:world:genre",
    incomingMemoryId: "canon:world:genre-v2",
  });
  assert.equal(env.gate, "memory_hard_conflict");
  assert.equal(env.severity, "hard");
  assert.equal(env.recoverable, false);
  assert.equal(env.userActionRequired, true);
  assert.ok(env.reason.includes("禁止静默覆盖"));
});
