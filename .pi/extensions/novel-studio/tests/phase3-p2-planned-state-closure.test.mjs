/**
 * Phase 3 P2：PlannedState 闭环验收探针
 *
 * 验收口径（用户原话）：
 *  - "store.planned 仍只有写入、没有 ContextCompiler 消费"
 *  - "同章空计划重生成不会清除旧 planned entry"
 *
 * 覆盖场景：
 *  1. FinalStateCommit：带 plannedUpdate 的 commit 写入 store.planned
 *  2. FinalStateCommit：同章重生成（空 plannedUpdate）清除旧 planned entry
 *  3. FinalStateCommit：undefined plannedUpdate 也清除同章旧 planned entry
 *  4. FinalStateCommit：清除同章条目时保留其他章节的 planned entry
 *  5. ContextCompiler：deriveLongTermState 消费 store.planned → longTermState.planned
 *  6. ContextCompiler：仅有 planned 条目（无权威状态）时仍返回非 null 快照
 *
 * 真相源：docs/top-tier-chinese-novel-system-development-plan.md §3D（PlannedState）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  loadStateStore,
  createFinalStateCommit,
  computeFinalTextHash,
} from "../dist/v2/core/final-state-commit.js";
import { createContextCompiler } from "../dist/v2/core/context-compiler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

// ============================================================================
// 辅助
// ============================================================================

function makeTempProject() {
  const dir = mkdtempSync(join(tmpdir(), "p2-planned-state-"));
  const workspaceId = "p2-test-ws";
  const wsDir = join(dir, "workspaces", workspaceId);
  mkdirSync(wsDir, { recursive: true });
  return { dir, workspaceId, wsDir };
}

const now = () => new Date().toISOString();

const FINAL_TEXT = "林墨推开门，走了进去。房间里很暗，他摸索着前进。";

function makePlannedUpdate(sourceChapter, additions) {
  return {
    additions,
    invalidations: [],
    sourceChapter,
    finalCandidateId: "amp-1",
  };
}

function makeCharacterPlannedEntry(characterId, field, value, sourceChapter) {
  return {
    kind: "character",
    id: `character:${characterId}:${field}`,
    sourceChapter,
    sourceRef: `seed:character:${field}`,
    confidence: 0.6,
    lastUpdated: now(),
    characterId,
    field,
    value,
  };
}

function makeStageUpdate(sourceChapter, candidateId) {
  return {
    additions: [],
    invalidations: [],
    sourceChapter,
    finalCandidateId: candidateId,
  };
}

// ============================================================================
// 1-4: FinalStateCommit planned entry 清除测试
// ============================================================================

test("P2-1: 带 plannedUpdate 的 commit 写入 store.planned", () => {
  const { dir, workspaceId } = makeTempProject();
  try {
    const store = loadStateStore(workspaceId, dir);
    const commit = createFinalStateCommit();
    commit.stage(makeStageUpdate("ch1", "amp-1"));

    const plannedUpdate = makePlannedUpdate("ch1", [
      makeCharacterPlannedEntry("林墨", "realm", "筑基期", "ch1"),
    ]);

    const result = commit.commit(store, "amp-1", FINAL_TEXT, workspaceId, dir, plannedUpdate);
    assert.equal(result.plannedPersisted, 1, "应持久化 1 条 planned entry");

    const loaded = loadStateStore(workspaceId, dir);
    assert.ok(Array.isArray(loaded.planned), "store.planned 应为数组");
    assert.equal(loaded.planned.length, 1, "应有 1 条 planned entry");
    assert.equal(loaded.planned[0].plannedKind, "character");
    assert.equal(loaded.planned[0].plannedContent, "筑基期");
    assert.equal(loaded.planned[0].sourceChapter, "ch1");
    assert.equal(loaded.planned[0].plannedField, "realm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2-2: 同章重生成（空 plannedUpdate additions）清除旧 planned entry", () => {
  const { dir, workspaceId } = makeTempProject();
  try {
    // 第一次 commit：写入 planned entry
    let store = loadStateStore(workspaceId, dir);
    let commit = createFinalStateCommit();
    commit.stage(makeStageUpdate("ch1", "amp-1"));
    const plannedUpdate = makePlannedUpdate("ch1", [
      makeCharacterPlannedEntry("林墨", "realm", "筑基期", "ch1"),
    ]);
    commit.commit(store, "amp-1", FINAL_TEXT, workspaceId, dir, plannedUpdate);

    let loaded = loadStateStore(workspaceId, dir);
    assert.equal(loaded.planned.length, 1, "第一次 commit 后应有 1 条 planned entry");

    // 第二次 commit（同章重生成）：plannedUpdate.additions 为空
    store = loadStateStore(workspaceId, dir);
    commit = createFinalStateCommit();
    commit.stage(makeStageUpdate("ch1", "amp-2"));
    const emptyPlannedUpdate = makePlannedUpdate("ch1", []);
    const result = commit.commit(store, "amp-2", FINAL_TEXT, workspaceId, dir, emptyPlannedUpdate);
    assert.equal(result.plannedPersisted, 0, "空计划应持久化 0 条");

    loaded = loadStateStore(workspaceId, dir);
    assert.equal(
      loaded.planned.length,
      0,
      "同章空计划重生成后应清除旧 planned entry（P2 核心修复）",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2-3: undefined plannedUpdate 也清除同章旧 planned entry", () => {
  const { dir, workspaceId } = makeTempProject();
  try {
    // 第一次 commit：写入 planned entry
    let store = loadStateStore(workspaceId, dir);
    let commit = createFinalStateCommit();
    commit.stage(makeStageUpdate("ch1", "amp-1"));
    const plannedUpdate = makePlannedUpdate("ch1", [
      makeCharacterPlannedEntry("林墨", "realm", "筑基期", "ch1"),
    ]);
    commit.commit(store, "amp-1", FINAL_TEXT, workspaceId, dir, plannedUpdate);

    let loaded = loadStateStore(workspaceId, dir);
    assert.equal(loaded.planned.length, 1, "第一次 commit 后应有 1 条 planned entry");

    // 第二次 commit（同章重生成）：plannedUpdate 为 undefined
    store = loadStateStore(workspaceId, dir);
    commit = createFinalStateCommit();
    commit.stage(makeStageUpdate("ch1", "amp-2"));
    // 不传 plannedUpdate 参数（undefined）
    commit.commit(store, "amp-2", FINAL_TEXT, workspaceId, dir);

    loaded = loadStateStore(workspaceId, dir);
    assert.equal(
      loaded.planned.length,
      0,
      "undefined plannedUpdate 也应清除同章旧 planned entry",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2-4: 清除同章条目时保留其他章节的 planned entry", () => {
  const { dir, workspaceId } = makeTempProject();
  try {
    // 第 1 章 commit：写入 ch1 planned entry
    let store = loadStateStore(workspaceId, dir);
    let commit1 = createFinalStateCommit();
    commit1.stage(makeStageUpdate("ch1", "amp-1"));
    commit1.commit(
      store,
      "amp-1",
      FINAL_TEXT,
      workspaceId,
      dir,
      makePlannedUpdate("ch1", [
        makeCharacterPlannedEntry("林墨", "realm", "筑基期", "ch1"),
      ]),
    );

    // 第 2 章 commit：写入 ch2 planned entry
    store = loadStateStore(workspaceId, dir);
    let commit2 = createFinalStateCommit();
    commit2.stage(makeStageUpdate("ch2", "amp-2"));
    commit2.commit(
      store,
      "amp-2",
      FINAL_TEXT,
      workspaceId,
      dir,
      makePlannedUpdate("ch2", [
        makeCharacterPlannedEntry("苏婉", "realm", "炼气期", "ch2"),
      ]),
    );

    let loaded = loadStateStore(workspaceId, dir);
    assert.equal(loaded.planned.length, 2, "应有 ch1 + ch2 共 2 条 planned entry");

    // 同章重生成 ch1：空计划清除 ch1 旧条目，保留 ch2 条目
    store = loadStateStore(workspaceId, dir);
    const commit1Regen = createFinalStateCommit();
    commit1Regen.stage(makeStageUpdate("ch1", "amp-3"));
    commit1Regen.commit(
      store,
      "amp-3",
      FINAL_TEXT,
      workspaceId,
      dir,
      makePlannedUpdate("ch1", []),
    );

    loaded = loadStateStore(workspaceId, dir);
    assert.equal(loaded.planned.length, 1, "应仅剩 ch2 的 1 条 planned entry");
    assert.equal(loaded.planned[0].sourceChapter, "ch2", "保留的应为 ch2 条目");
    assert.equal(loaded.planned[0].plannedContent, "炼气期", "ch2 内容应正确");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 5-6: ContextCompiler 消费 store.planned 测试
// ============================================================================

/**
 * 构建最小测试 workspace，包含 narrative-state-store.json（带 planned 条目）。
 * compile() 需要 config.json + characters + styles 才能到达 deriveLongTermState。
 */
function setupMinimalWorkspace(wsDir, storeData) {
  mkdirSync(join(wsDir, "characters"), { recursive: true });
  mkdirSync(join(wsDir, "styles"), { recursive: true });
  mkdirSync(join(wsDir, "chapters"), { recursive: true });
  mkdirSync(join(wsDir, "series"), { recursive: true });
  mkdirSync(join(wsDir, "traces"), { recursive: true });

  const configData = {
    name: "PlannedState 闭环测试小说",
    genre: "玄幻",
    subGenres: ["重生"],
    characters: [
      { id: "protagonist", name: "林墨", role: "主角" },
    ],
    totalChapters: 20,
    targetWordCount: { perChapter: { min: 2000, max: 3000 } },
  };
  writeFileSync(join(wsDir, "config.json"), JSON.stringify(configData, null, 2), "utf-8");
  writeFileSync(join(wsDir, "characters", "protagonist.md"), "# 林墨\n\n主角。\n", "utf-8");
  writeFileSync(
    join(wsDir, "styles", "profile.json"),
    JSON.stringify({
      id: "planned-state-test-style",
      usagePolicy: { fullChapterOptimization: "required" },
      editorialGuidance: ["人物压力通过动作呈现。"],
      characterVoiceGuidance: { 林墨: ["少年感。"] },
    }, null, 2),
    "utf-8",
  );

  // 写入 narrative-state-store.json
  writeFileSync(
    join(wsDir, "narrative-state-store.json"),
    JSON.stringify(storeData, null, 2),
    "utf-8",
  );
}

function makeStoreWithPlanned(plannedEntries, options = {}) {
  return {
    schemaVersion: 1,
    workspaceId: options.workspaceId ?? "p2-ctx-ws",
    canon: options.canon ?? [],
    character: options.character ?? [],
    promise: options.promise ?? [],
    pattern: options.pattern ?? [],
    expectation: options.expectation ?? [],
    eventLog: options.eventLog ?? [],
    quarantine: [],
    planned: plannedEntries,
    updatedAt: now(),
    ...(options.lastCommittedChapter ? { lastCommittedChapter: options.lastCommittedChapter } : {}),
  };
}

function makePlannedStateEntry(overrides) {
  return {
    id: "planned:character:林墨:realm",
    sourceChapter: "ch1",
    sourceRef: "seed:character:realm",
    confidence: 0.6,
    lastUpdated: now(),
    plannedKind: "character",
    plannedContent: "筑基期",
    plannedSource: "chapter_seed",
    plannedField: "realm",
    verified: true,
    verificationOutcome: "hit",
    ...overrides,
  };
}

test("P2-5: ContextCompiler 消费 store.planned → longTermState.planned", () => {
  const dir = mkdtempSync(join(tmpdir(), "p2-ctx-"));
  const workspaceId = "p2-ctx-ws";
  const wsDir = join(dir, "workspaces", workspaceId);
  try {
    // 同时写入 1 条 canon（确保 store 非空）+ 1 条 planned
    const store = makeStoreWithPlanned(
      [makePlannedStateEntry({
        id: "planned:character:林墨:realm",
        plannedContent: "筑基期",
        plannedField: "realm",
        verified: true,
        verificationOutcome: "hit",
        sourceChapter: "ch1",
      })],
      {
        workspaceId,
        canon: [
          {
            kind: "canon",
            id: "canon:world:lingqi",
            sourceChapter: "ch1",
            sourceRef: `ch1#finalText:abc123456789:0-3`,
            confidence: 0.7,
            lastUpdated: now(),
            fact: "世界存在灵气",
            category: "ability_rule",
          },
        ],
      },
    );
    setupMinimalWorkspace(wsDir, store);

    const compiler = createContextCompiler();
    const { context } = compiler.compile({
      workspaceId,
      chapterId: "2",
      chapterNumber: 2,
      projectRoot: dir,
    });

    assert.ok(context.longTermState, "longTermState 应非 null（store 有 canon + planned）");
    assert.ok(
      Array.isArray(context.longTermState.planned),
      "longTermState.planned 应为数组（P2 核心修复：ContextCompiler 消费 store.planned）",
    );
    assert.equal(
      context.longTermState.planned.length,
      1,
      "应暴露 1 条 planned entry",
    );
    const planned = context.longTermState.planned[0];
    assert.equal(planned.plannedKind, "character");
    assert.equal(planned.plannedContent, "筑基期");
    assert.equal(planned.plannedField, "realm");
    assert.equal(planned.sourceChapter, "ch1");
    assert.equal(planned.verified, true);
    assert.equal(planned.verificationOutcome, "hit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2-6: 仅有 planned 条目（无权威状态）时仍返回非 null 快照", () => {
  const dir = mkdtempSync(join(tmpdir(), "p2-ctx-only-planned-"));
  const workspaceId = "p2-ctx-ws2";
  const wsDir = join(dir, "workspaces", workspaceId);
  try {
    // store 只有 planned 条目，无 canon/character/promise/pattern
    const store = makeStoreWithPlanned(
      [makePlannedStateEntry({
        sourceChapter: "ch1",
        plannedContent: "筑基期",
      })],
      { workspaceId },
    );
    setupMinimalWorkspace(wsDir, store);

    const compiler = createContextCompiler();
    const { context } = compiler.compile({
      workspaceId,
      chapterId: "2",
      chapterNumber: 2,
      projectRoot: dir,
    });

    // P2 修复：isEmpty 检查现在包含 planned 字段，仅有 planned 条目时不应返回 null
    assert.ok(
      context.longTermState,
      "longTermState 应非 null（P2 修复：isEmpty 检查包含 planned，仅有 planned 不算空）",
    );
    assert.ok(
      Array.isArray(context.longTermState.planned),
      "longTermState.planned 应为数组",
    );
    assert.equal(context.longTermState.planned.length, 1, "应暴露 1 条 planned entry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2-7: 空 store（无 planned 也无权威状态）仍返回 null 快照", () => {
  const dir = mkdtempSync(join(tmpdir(), "p2-ctx-empty-"));
  const workspaceId = "p2-ctx-ws3";
  const wsDir = join(dir, "workspaces", workspaceId);
  try {
    // 完全空的 store
    const store = makeStoreWithPlanned([], { workspaceId });
    setupMinimalWorkspace(wsDir, store);

    const compiler = createContextCompiler();
    const { context } = compiler.compile({
      workspaceId,
      chapterId: "2",
      chapterNumber: 2,
      projectRoot: dir,
    });

    // 空 store 应返回 null（避免注入空噪音）
    assert.equal(
      context.longTermState,
      null,
      "空 store（无 planned 也无权威状态）应返回 null 快照",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
