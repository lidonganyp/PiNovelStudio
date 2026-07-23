/**
 * P2 RED: G7 状态重新派生补全 — seed 重生成 fallback (H1 audit gap)
 *
 * 真相源：docs/long-form-stability-gaps-fix-plan-v2.md §P2
 *
 * H1 缺口（已通过 Phase 1 探索验证）：
 * - chapter-proxy-approval-finalization-entry.ts:246-257 当
 *   orchestratorInput.stagedStateUpdate 和 pendingDraft.stagedStateUpdate
 *   均为 undefined 时，runFinalization 退化为空 StagedStateUpdate fallback
 *   ({ additions: [], invalidations: [], sourceChapter: ... })
 * - commitAndSave 只能从 finalText 扫描 PatternMemory，
 *   ChapterSeed 派生的 Canon/Character/Promise/Expectation 全部丢失
 * - 长篇连续生成 50+ 章后，代理审批改写正文的状态将发生漂移
 *
 * P2 修复（用户已批准"修正范围：补 seed 重生成"）：
 * - FinalizationEntryOptions 新增可选 seed + ontologyLevels 字段
 * - 当 recoveredStateUpdate 为 undefined 且 options.seed 提供时，
 *   调用 buildStagedStateUpdate(seed, chapterNumber, ontologyLevels) 重生成
 * - 不提供 seed 时保留当前空 fallback（legacy 兼容）
 *
 * 本 RED 测试在 GREEN 实现前应当 FAIL：
 * - 构造无 stagedStateUpdate 的 orchestratorInput + pendingDraft
 * - 传入 options.seed（含 characters / pendingForeshadowing / immutableFacts）
 * - 断言 commitAndSave 收到的 stagedStateUpdate.additions 包含
 *   kind=canon / kind=character / kind=promise 三类（不是空数组）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  saveProxyApprovedDraft,
  hasPendingProxyDraft,
} from "../dist/v2/governance/chapter-proxy-approval-draft-checkpoint.js";
import { runFinalization } from "../dist-test/v2/governance/chapter-proxy-approval-finalization-entry.js";

// ============================================================================
// helpers
// ============================================================================

function makeTempWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "p2-staged-rederiver-"));
  const workspaceId = "ws-test";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(workspacePath, { recursive: true });
  return { projectRoot, workspaceId, workspacePath };
}

/**
 * 构造 pending draft 但不写入 stagedStateUpdate（模拟 legacy checkpoint
 * 或 caller 未传递 staged 状态的边界场景）。
 */
function setupPendingDraftWithoutStagedState(workspacePath, approvalId = "cpa-entry-001") {
  saveProxyApprovedDraft({
    workspacePath,
    approvalId,
    chapterId: "1",
    candidateId: "cand-raw-001",
    selectedSource: "raw",
    finalText: "代理审批稿正文。这是一段足够长的正文，用于通过 FactGuard 的格式校验。",
    savedAt: "2026-07-23T00:00:00.000Z",
    // 故意不传 stagedStateUpdate —— 模拟 legacy checkpoint
  });
  assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
}

function makeMinimalOrchestratorInput(projectRoot, workspaceId, chapterId = "1") {
  return {
    workspaceId,
    chapterId,
    chapterNumber: 1,
    projectRoot,
    context: {
      facts: [],
      characterStates: [],
      openLoops: [],
      worldRules: [],
      styleReferences: [],
      sourceMap: [],
      longTermState: null,
    },
    characterNames: ["李一凡"],
    stagedStateUpdate: null, // 显式 null —— 触发 fallback 路径
  };
}

/**
 * 构造 ChapterSeed fixture，包含：
 * - characters: 一个角色（用于派生 character participation entry）
 * - currentPressure.pendingForeshadowing: 一条伏笔（用于派生 promise entry）
 * - worldConstraint.immutableFacts: 一条不可破坏事实（用于派生 canon entry）
 * - intent.primary=foreshadow + chapterTheme（用于派生 expectation entry）
 *
 * 字段对齐 v2/core/unified-entry.ts:buildStagedStateUpdate 期望的 ChapterSeed 结构。
 */
function makeChapterSeedFixture() {
  return {
    chapterFunction: "setup",
    characters: [
      { name: "李一凡", aliases: ["一凡"] },
    ],
    currentPressure: {
      pendingForeshadowing: [
        { id: "p-yuheng-secret", description: "玉衡星秘密" },
      ],
      openArcs: [],
    },
    worldConstraint: {
      immutableFacts: ["修真界禁杀凡人"],
    },
    highLevelDirection: {
      available: true,
      immutableFacts: [],
    },
    intent: {
      primary: "foreshadow",
      chapterTheme: "玉衡星真相浮现",
      keywords: ["玉衡星"],
      targetEmotions: ["震撼"],
    },
  };
}

// ============================================================================
// RED 测试：seed 重生成 fallback（H1 缺口修复验收）
// ============================================================================

test("P2 RED: runFinalization with seed regenerates Canon/Character/Promise when both stagedStateUpdate sources missing", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // Setup: pending draft WITHOUT stagedStateUpdate（模拟 legacy checkpoint）
    setupPendingDraftWithoutStagedState(workspacePath);

    // orchestratorInput.stagedStateUpdate = null（makeMinimalOrchestratorInput 默认）
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");

    // editedText 必须包含角色名 + 伏笔关键词 + 不可破坏事实关键词，
    // 以便 reanchorStagedStateToFinalText 在最终稿中能定位到 span（reanchor 是 GREEN 实现后的行为，
    // RED 阶段只需断言 additions 包含三类 kind，不要求 reanchor confidence 提升）
    const editedText = "李一凡凝视玉衡星，确认修真界禁杀凡人的铁律仍不可动摇。玉衡星秘密藏在水下。";

    // 捕获 commitAndSave 收到的 input，断言 stagedStateUpdate.additions 内容
    let capturedInput = null;
    const capturingCommitAndSave = (input) => {
      capturedInput = input;
      return { ok: true, stateCommit: { committed: 4, rejected: 0 } };
    };

    const seed = makeChapterSeedFixture();

    const result = runFinalization({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-entry-001",
      action: "accept_with_edits",
      editedText,
      orchestratorInput,
      seed, // ← P2 新字段：当 stagedStateUpdate 缺失时从此重生成
      commitAndSaveFn: capturingCommitAndSave,
    });

    // 定稿成功
    assert.equal(result.finalization.action, "accept_with_edits");
    assert.equal(result.finalization.canCommit, true);
    assert.ok(result.commit, "应有 commit 结果");
    assert.equal(result.commit.ok, true);

    // ── P2 核心断言：stagedStateUpdate 应从 seed 重生成，包含 Canon/Character/Promise ──
    assert.ok(capturedInput, "commitAndSave 应被调用");
    assert.ok(
      capturedInput.stagedStateUpdate,
      "stagedStateUpdate 应从 seed 重生成（非 null）",
    );

    const additions = capturedInput.stagedStateUpdate.additions;
    assert.ok(Array.isArray(additions), "additions 应为数组");
    assert.ok(
      additions.length > 0,
      "additions 不应为空 —— seed 派生的 Canon/Character/Promise 应被提交（H1 缺口修复）",
    );

    const kinds = additions.map((entry) => entry.kind);

    // ── Canon: 从 seed.worldConstraint.immutableFacts 派生 ──
    assert.ok(
      kinds.includes("canon"),
      `additions 应包含 kind=canon（来自 seed.worldConstraint.immutableFacts），实际 kinds: ${JSON.stringify(kinds)}`,
    );
    const canonEntry = additions.find((entry) => entry.kind === "canon");
    assert.ok(
      canonEntry.fact.includes("修真界禁杀凡人"),
      `canon entry 的 fact 应来自 seed.worldConstraint.immutableFacts，实际: ${canonEntry.fact}`,
    );

    // ── Character: 从 seed.characters 派生 participation ──
    assert.ok(
      kinds.includes("character"),
      `additions 应包含 kind=character（来自 seed.characters），实际 kinds: ${JSON.stringify(kinds)}`,
    );
    const characterEntries = additions.filter((entry) => entry.kind === "character");
    const participationEntry = characterEntries.find((entry) => entry.field === "participation");
    assert.ok(
      participationEntry,
      "character entries 应包含 field=participation（来自 seed.characters）",
    );
    assert.equal(
      participationEntry.characterId,
      "李一凡",
      "participation entry 的 characterId 应为 seed.characters[0].name",
    );

    // ── Promise: 从 seed.currentPressure.pendingForeshadowing 派生 ──
    assert.ok(
      kinds.includes("promise"),
      `additions 应包含 kind=promise（来自 seed.currentPressure.pendingForeshadowing），实际 kinds: ${JSON.stringify(kinds)}`,
    );
    const promiseEntry = additions.find((entry) => entry.kind === "promise");
    assert.equal(
      promiseEntry.promiseId,
      "p-yuheng-secret",
      "promise entry 的 promiseId 应来自 seed.currentPressure.pendingForeshadowing[0].id",
    );
    assert.equal(
      promiseEntry.description,
      "玉衡星秘密",
      "promise entry 的 description 应来自 seed.currentPressure.pendingForeshadowing[0].description",
    );

    // ── sourceChapter 应为 ch{chapterNumber} ──
    assert.equal(
      capturedInput.stagedStateUpdate.sourceChapter,
      "ch1",
      "重生成的 sourceChapter 应为 ch{chapterNumber}",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("P2 RED compat: runFinalization without seed preserves legacy empty fallback (no behavior change)", () => {
  // 验收 P2 修复的"不破坏现有行为"约束：
  // 不传 seed 时，runFinalization 应保留当前空 fallback 行为
  // （additions=[]，由 commitAndSave 从 finalText 扫描 Pattern）
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraftWithoutStagedState(workspacePath);
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    const editedText = "用户修改后的正文。这是一段足够长的修改正文，用于通过 FactGuard 的格式校验。";

    let capturedInput = null;
    const capturingCommitAndSave = (input) => {
      capturedInput = input;
      return { ok: true, stateCommit: { committed: 0, rejected: 0 } };
    };

    const result = runFinalization({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-entry-001",
      action: "accept_with_edits",
      editedText,
      orchestratorInput,
      // 故意不传 seed —— 模拟 caller 未提供 seed 的 legacy 场景
      commitAndSaveFn: capturingCommitAndSave,
    });

    assert.equal(result.commit.ok, true);
    assert.ok(capturedInput.stagedStateUpdate, "应保留空 fallback（非 null）");
    assert.deepEqual(
      capturedInput.stagedStateUpdate.additions,
      [],
      "不传 seed 时 additions 应为空数组（legacy fallback 行为不变）",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
