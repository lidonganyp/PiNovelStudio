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
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadStateStore,
  createFinalStateCommit,
  computeFinalTextHash,
} from "../dist/v2/core/final-state-commit.js";
import { MemoryHardConflictError } from "../dist/v2/core/memory/memory-lifecycle.js";
import { commitAndSave, chapterFilePath } from "../dist/v2/core/orchestrator-commit-save.js";
import { detectMemoryConflicts } from "../dist/v2/core/memory/memory-transaction.js";
import { isMemoryRetrievable } from "../dist/v2/core/memory/memory-record.js";
import { retrieveNarrativeContext } from "../dist/v2/core/context-retrieval.js";

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

// ============================================================================
// 生产路径：commitAndSave() 完整回滚（正文先写 → 状态硬冲突 → 回滚 → 无 receipt）
// ============================================================================

function makeOrchestratorInputWithStagedState(dir, workspaceId, chapterId, chapterNumber, fact, category) {
  const sourceChapter = `ch${chapterNumber}`;
  return {
    workspaceId,
    chapterId,
    chapterNumber,
    projectRoot: dir,
    intent: {},
    context: { facts: [], longTermState: null },
    constitution: null,
    characterNames: [],
    stagedStateUpdate: {
      additions: [
        {
          kind: "canon",
          id: "canon:world:genre",
          sourceChapter,
          sourceRef: "seed:canon:world:genre",
          confidence: 0.9,
          lastUpdated: new Date().toISOString(),
          fact,
          category,
        },
      ],
      invalidations: [],
      sourceChapter,
    },
  };
}

test("MEMORY-4/5 生产边界: commitAndSave 硬冲突回滚完整流程（正文先写→状态阻断→回滚→无receipt）", () => {
  const { dir, workspaceId } = makeTempProject();
  try {
    // 1. ch1 成功提交正文 + 状态（仙侠世界）
    const input1 = makeOrchestratorInputWithStagedState(dir, workspaceId, "1", 1, "仙侠世界", "genre");
    const finalText1 = "仙侠世界灵气浓郁。";
    const stage1 = {};
    const out1 = commitAndSave(input1, "cand-ch1", finalText1, stage1);
    assert.equal(out1.ok, true, "ch1 应成功提交");
    assert.ok(existsSync(chapterFilePath(input1)), "ch1 正文应先成功写入");

    // 2. ch2 尝试把同一 Canon（canon:world:genre）改写为 玄幻世界 → 硬冲突
    const input2 = makeOrchestratorInputWithStagedState(dir, workspaceId, "2", 2, "玄幻世界", "genre");
    const finalText2 = "玄幻世界灵气稀薄。";
    const stage2 = {};
    const out2 = commitAndSave(input2, "cand-ch2", finalText2, stage2);

    // 3. 断言回滚结果
    assert.equal(out2.ok, false, "硬冲突应返回 ok=false");
    assert.equal(stage2.stateCommit.blocked, "memory_hard_conflict", "stateCommit 应标记 blocked=memory_hard_conflict");
    assert.equal(stage2.stateCommit.gate, "memory_hard_conflict", "gate 应正确");
    assert.equal(stage2.stateCommit.severity, "hard", "severity 应为 hard");
    assert.ok(stage2.stateCommit.evidence, "应携带结构化 evidence");
    assert.equal(stage2.stateCommit.evidence.key, "canon:canonworldgenre", "evidence.key 应正确");
    assert.equal(stage2.stateCommit.evidence.existingValue, "仙侠世界", "evidence.existingValue 应为旧值");
    assert.equal(stage2.stateCommit.evidence.incomingValue, "玄幻世界", "evidence.incomingValue 应为新值");
    assert.equal(stage2.stateCommit.receipt, undefined, "失败路径不产生 MemoryCommitReceipt");
    assert.equal(stage2.atomicSave.rolledBack, true, "正文应被回滚");
    assert.equal(stage2.atomicSave.rollbackAction, "removed_new", "ch2 为新建文件应删除");
    assert.ok(!existsSync(chapterFilePath(input2)), "冲突后 ch2 正文应被删除");
    assert.ok(existsSync(chapterFilePath(input1)), "ch1 正文应保留不受影响");
    // 状态保持原值
    const loaded = loadStateStore(workspaceId, dir);
    assert.equal(loaded.canon.length, 1, "硬冲突后不应新增 canon");
    assert.equal(loaded.canon[0].fact, "仙侠世界", "StateStore 应保持 ch1 原值");
    assert.equal(loaded.canon[0].sourceChapter, "ch1", "StateStore 来源仍为 ch1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Canon 不同值更新语义（方案 A：Canon ID 不可变）——detectMemoryConflicts 单测
// ============================================================================

function makeCanonRecord(memoryId, key, value, supersedes = []) {
  return {
    memoryId,
    memoryType: "canon",
    authorityClass: "final_text_explicit",
    epistemicStatus: "confirmed",
    lifecycleStatus: "active",
    sourceChapter: 1,
    sourceRef: ["ch1#finalText:abc:0-4"],
    textHash: ["abc"],
    sourceRunId: "run-1",
    sourceFinalTextHash: "abc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    confidence: 0.9,
    derivedFromMemoryIds: [],
    supersedesMemoryIds: supersedes,
    payload: { memoryType: "canon", data: { value, category: "genre", key } },
  };
}

test("MEMORY-5 Canon 语义: 合法版本演进通过（新 memoryId + 显式 supersedes 旧 id → superseded）", () => {
  const existing = [makeCanonRecord("canon:world:genre", "canon:world:genre", "仙侠世界")];
  const incoming = [
    makeCanonRecord("canon:world:genre-v2", "canon:world:genre", "玄幻世界", ["canon:world:genre"]),
  ];
  const conflicts = detectMemoryConflicts(incoming, existing);
  assert.equal(conflicts.length, 1, "应产生一条冲突记录");
  assert.equal(conflicts[0].resolution, "superseded", "新 ID + 显式 supersedes 旧 ID = 合法版本演进");
  assert.equal(conflicts[0].incomingMemoryId, "canon:world:genre-v2", "应使用新 memoryId");
});

test("MEMORY-5 Canon 语义: 未声明替代关系的不同值改写被阻断（hard_conflict_blocked）", () => {
  const existing = [makeCanonRecord("canon:world:genre", "canon:world:genre", "仙侠世界")];
  const incoming = [
    makeCanonRecord("canon:world:genre-v2b", "canon:world:genre", "玄幻世界"), // 未提供 supersedes
  ];
  const conflicts = detectMemoryConflicts(incoming, existing);
  assert.equal(conflicts.length, 1, "应产生一条冲突记录");
  assert.equal(conflicts[0].resolution, "hard_conflict_blocked", "未声明替代关系的不同值改写应阻断");
});

test("MEMORY-5 Canon 语义[方案A]: 同 ID 不同值即使携带替代声明也应阻断，并给出'必须创建新 ID'提示", () => {
  const existing = [makeCanonRecord("canon:world:genre", "canon:world:genre", "仙侠世界")];
  // 同 memoryId，却携带 supersedes 指向自身 —— 方案 A 下仍必须阻断（ID 不可变）
  const incoming = [
    makeCanonRecord("canon:world:genre", "canon:world:genre", "玄幻世界", ["canon:world:genre"]),
  ];
  const conflicts = detectMemoryConflicts(incoming, existing);
  assert.equal(conflicts.length, 1, "应产生一条冲突记录");
  assert.equal(conflicts[0].resolution, "hard_conflict_blocked", "同 ID 不同值即使携带替代声明也应阻断");
  assert.match(conflicts[0].reason, /必须创建新 memoryId/, "应给出'必须创建新 ID'结构化提示");
});

// ============================================================================
// P0（legacy 兼容）：旧工作区无 memory 信封的 Canon 也要参与冲突检测
// ============================================================================

test("P0 生产边界: 旧工作区(无memory信封)Canon不被同ID新值静默覆盖", () => {
  const { dir, workspaceId } = makeTempProject();
  try {
    // 旧工作区 store：canon 条目无 memory 信封（legacy 格式）
    const statePath = join(dir, "workspaces", workspaceId, "narrative-state-store.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        workspaceId,
        canon: [
          {
            id: "canon:world:genre",
            sourceChapter: "ch1",
            sourceRef: "seed:canon:world:genre",
            confidence: 0.9,
            lastUpdated: "2026-01-01T00:00:00.000Z",
            fact: "仙侠世界",
            category: "genre",
          },
        ],
        character: [],
        promise: [],
        pattern: [],
        expectation: [],
      }),
      "utf-8",
    );

    // 新正文提交同 ID 不同值（legacy 未带信封也必须被冲突检测拦住）
    const input = makeOrchestratorInputWithStagedState(dir, workspaceId, "2", 2, "玄幻世界", "genre");
    const finalText = "玄幻世界灵气稀薄。";
    const stage = {};
    const out = commitAndSave(input, "cand-ch2", finalText, stage);

    assert.equal(out.ok, false, "旧 Canon 被同 ID 新值改写应阻断");
    assert.equal(stage.stateCommit.blocked, "memory_hard_conflict", "应触发 memory_hard_conflict");
    assert.equal(stage.stateCommit.evidence.existingValue, "仙侠世界", "existingValue 应为旧值");
    assert.equal(stage.stateCommit.evidence.incomingValue, "玄幻世界", "incomingValue 应为新值");
    assert.equal(stage.atomicSave.rolledBack, true, "正文应回滚");
    assert.ok(!existsSync(chapterFilePath(input)), "冲突后正文应被删除");
    const loaded = loadStateStore(workspaceId, dir);
    assert.equal(loaded.canon.length, 1, "不应新增冲突 canon");
    assert.equal(loaded.canon[0].fact, "仙侠世界", "旧 Canon 不得被覆盖");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// PEA-1：PatternMemory 分层检索——作为 advisory 注入，不作为硬事实排除
// ============================================================================

function makePatternRecord(memoryId, overrides = {}) {
  return {
    memoryId,
    memoryType: "pattern",
    authorityClass: "system_derived",
    epistemicStatus: "derived",
    lifecycleStatus: "active",
    sourceChapter: 14,
    sourceRef: ["ch14#finalText:abc123def456"],
    textHash: ["abc123def456"],
    sourceRunId: "run-ch14",
    sourceFinalTextHash: "abc123def456",
    createdAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:00Z",
    expiresAt: null,
    confidence: 0.8,
    derivedFromMemoryIds: [],
    supersedesMemoryIds: [],
    payload: { memoryType: "pattern", data: { patternType: "sentence_risk", description: "AI 腔风险", occurrenceCount: 3 } },
    ...overrides,
  };
}

test("PEA-1: PatternMemory(带信封)作为低权重 advisory 进入检索，不被排除", () => {
  const r = makePatternRecord("pattern:x");
  const check = isMemoryRetrievable(r);
  assert.equal(check.usable, true, "active pattern 应可检索");
  assert.equal(check.advisory, true, "pattern 应标记为 advisory（非硬事实）");
});

test("PEA-1: 过期/计划的 PatternMemory 被排除且 reason 标记 advisory", () => {
  const expired = isMemoryRetrievable(makePatternRecord("expired", { lifecycleStatus: "expired" }));
  assert.equal(expired.usable, false, "过期 pattern 应排除");
  assert.equal(expired.advisory, true);

  const planned = isMemoryRetrievable(
    makePatternRecord("planned", { epistemicStatus: "planned", authorityClass: "model_planned" }),
  );
  assert.equal(planned.usable, false, "计划 pattern 应排除");
  assert.equal(planned.advisory, true);
});

// PEA-1 集成：真正调用生产检索 retrieveNarrativeContext，断言 PatternMemory 通过
// advisory 专用召回通道进入 workingSet.pattern（而不是只测 isMemoryRetrievable 纯函数）。
test("PEA-1 集成: PatternMemory 经生产检索进入 workingSet，advisory 通道注入", () => {
  const state = {
    canon: [],
    character: [],
    promise: [],
    pattern: [
      {
        id: "pattern:x",
        kind: "pattern",
        sourceChapter: "ch14",
        sourceRef: "ch14#finalText:abc123def456",
        confidence: 0.8,
        lastUpdated: "2026-08-11T00:00:00Z",
        patternType: "sentence_risk",
        description: "AI 腔风险",
        occurrenceCount: 3,
        memory: makePatternRecord("pattern:x"),
      },
    ],
  };
  // 无关键词命中时 pattern 评分 = system_derived(-20) + derived(-10) + recency(<=20) < 10，
  // 常规 passingScore 通道无法进入，必须靠 advisory 专用召回通道。
  const result = retrieveNarrativeContext({
    chapterNumber: 17,
    relevantCharacters: [],
    selectedPromiseIds: [],
    keywords: [],
    state,
    maxItems: 24,
  });
  assert.equal(result.workingSet.pattern.length, 1, "PatternMemory 应进入 workingSet.pattern");
  assert.equal(result.workingSet.pattern[0].id, "pattern:x");
  assert.ok(result.report.advisoryInjected.includes("pattern:x"), "应记录 advisoryInjected");
  const item = result.promptItems.find((i) => i.kind === "pattern");
  assert.ok(item, "promptItems 应包含 pattern 条目");
  assert.ok(result.report.futureStateExcluded.length === 0, "advisory 可检索时不应被排除");
});