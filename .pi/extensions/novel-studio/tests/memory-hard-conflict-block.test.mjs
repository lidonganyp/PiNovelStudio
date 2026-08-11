/**
 * MEMORY-TRANSACTION-1 生产边界集成测试：硬冲突阻断提交（正文/状态均不提交）
 *
 * 验收口径（审查缺口 #2 / #4）：
 * - 状态落盘前检测硬冲突（canon 同键不同值，未显式 invalidate/supersede）
 * - 命中 hard_conflict_blocked → 抛出 MemoryHardConflictError（携带
 *   MemoryConflictEnvelope：gate=memory_hard_conflict, severity=hard, recoverable=false）
 * - 抛出后 state store 未被污染（不落盘新 canon），既有 Canon 保持不变
 * - 由 commitAndSave 捕获后回滚正文并阻断（ok=false）
 *
 * 该测试走真实 FinalStateCommit 提交器（dist/ 生产闭包），不是纯函数单测。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadStateStore,
  createFinalStateCommit,
  computeFinalTextHash,
} from "../dist/v2/core/final-state-commit.js";
import { MemoryHardConflictError } from "../dist/v2/core/memory/memory-lifecycle.js";

function makeTempProject() {
  const dir = mkdtempSync(join(tmpdir(), "memory-gap-test-"));
  const workspaceId = "mem-ws";
  const wsDir = join(dir, "workspaces", workspaceId);
  mkdirSync(wsDir, { recursive: true });
  return { dir, workspaceId, wsDir };
}

function now() {
  return new Date().toISOString();
}

// 第一次提交：写入不可违背 Canon 事实（仙侠世界）
function commitCanonGenres(workspaceId, dir, chapter, finalText, fact) {
  const commit = createFinalStateCommit();
  const store = loadStateStore(workspaceId, dir);
  commit.stage({
    additions: [
      {
        kind: "canon",
        id: "canon:world:genre",
        sourceChapter: chapter,
        sourceRef: `${chapter}#finalText:${computeFinalTextHash(finalText)}:0-4`,
        confidence: 0.9,
        lastUpdated: now(),
        fact,
        category: "genre",
      },
    ],
    invalidations: [],
    sourceChapter: chapter,
    finalCandidateId: `${chapter}-cand`,
  });
  return commit.commit(store, `${chapter}-cand`, finalText, workspaceId, dir);
}

test("MEMORY-4/5 生产边界: 新正文与旧 Canon 硬冲突 → 阻断提交，正文/状态均不提交", () => {
  const { dir, workspaceId } = makeTempProject();
  try {
    const finalText1 = "仙侠世界灵气浓郁。";
    const finalText2 = "玄幻世界灵气稀薄。";

    // 第 1 章先提交不可违背 Canon：世界类型 = 仙侠世界
    const r1 = commitCanonGenres(workspaceId, dir, "ch1", finalText1, "仙侠世界");
    assert.equal(r1.committed, 1, "ch1 应成功提交 1 条 canon");

    // 第 2 章试图把同一 Canon 记录值改写成 玄幻世界（未显式 invalidate/supersede）
    const commit2 = createFinalStateCommit();
    const store2 = loadStateStore(workspaceId, dir);
    commit2.stage({
      additions: [
        {
          kind: "canon",
          id: "canon:world:genre",
          sourceChapter: "ch2",
          sourceRef: `${"ch2"}#finalText:${computeFinalTextHash(finalText2)}:0-4`,
          confidence: 0.9,
          lastUpdated: now(),
          fact: "玄幻世界",
          category: "genre",
        },
      ],
      invalidations: [],
      sourceChapter: "ch2",
      finalCandidateId: "ch2-cand",
    });

    // 硬冲突必须在状态落盘前抛出
    assert.throws(
      () =>
        commit2.commit(
          store2,
          "ch2-cand",
          finalText2,
          workspaceId,
          dir,
          undefined,
          "run-ch2",
        ),
      (err) => {
        assert.ok(
          err instanceof MemoryHardConflictError,
          `应抛 MemoryHardConflictError，实际: ${err?.constructor?.name}`,
        );
        // 结构化 FailureEnvelope 字段
        assert.equal(err.envelope.gate, "memory_hard_conflict");
        assert.equal(err.envelope.severity, "hard");
        assert.equal(err.envelope.recoverable, false);
        assert.equal(err.envelope.userActionRequired, true);
        assert.equal(err.envelope.evidence.key, "canon:canonworldgenre");
        assert.equal(err.envelope.evidence.existingValue, "仙侠世界");
        assert.equal(err.envelope.evidence.incomingValue, "玄幻世界");
        return true;
      },
      "硬冲突应阻断状态提交",
    );

    // 状态未被污染：store 仍只有 ch1 的 仙侠世界，无 ch2 的 玄幻世界
    const loaded = loadStateStore(workspaceId, dir);
    assert.equal(loaded.canon.length, 1, "硬冲突后不应新增 canon 条目");
    assert.equal(loaded.canon[0].fact, "仙侠世界", "既有 Canon 不得被覆盖");
    assert.equal(loaded.canon[0].sourceChapter, "ch1", "既有 Canon 来源仍为 ch1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MEMORY-4/5 生产边界: 同 Canon id 同值（置信度刷新）不阻断，仍 upsert", () => {
  const { dir, workspaceId } = makeTempProject();
  try {
    const finalText1 = "仙侠世界灵气浓郁。";
    const finalText2 = "仙侠世界灵力复苏。";

    const r1 = commitCanonGenres(workspaceId, dir, "ch1", finalText1, "仙侠世界");
    assert.equal(r1.committed, 1);

    // 第 4 章刷新同一 Canon 值（值不变，仅置信度提升）→ 合法 upsert，不阻断
    const commit4 = createFinalStateCommit();
    const store4 = loadStateStore(workspaceId, dir);
    commit4.stage({
      additions: [
        {
          kind: "canon",
          id: "canon:world:genre",
          sourceChapter: "ch4",
          sourceRef: `${"ch4"}#finalText:${computeFinalTextHash(finalText2)}:0-4`,
          confidence: 0.95,
          lastUpdated: now(),
          fact: "仙侠世界",
          category: "genre",
        },
      ],
      invalidations: [],
      sourceChapter: "ch4",
      finalCandidateId: "ch4-cand",
    });
    const r4 = commit4.commit(store4, "ch4-cand", finalText2, workspaceId, dir, undefined, "run-ch4");
    assert.equal(r4.committed, 1, "同值刷新应正常提交");

    const loaded = loadStateStore(workspaceId, dir);
    assert.equal(loaded.canon.length, 1, "同 id 应 upsert 不累积");
    assert.equal(loaded.canon[0].fact, "仙侠世界");
    assert.equal(loaded.canon[0].confidence, 0.95, "置信度应刷新为 ch4 值");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});