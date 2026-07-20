/**
 * EVOLUTION-RELEASE-GOVERNANCE-G7 — 章节代理审批定稿操作测试（Slice B）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §12.2
 *
 * G7 Finalization 切片要求（计划 §12.2）：
 * - 用户定稿操作：accept_proxy_draft / accept_with_edits / reject_and_regenerate /
 *   inspect_alternatives / rollback_committed_chapter
 * - 用户修改后必须基于用户稿重新运行 FinalFactRecheck（accept_with_edits 重跑 FactGuard）
 * - 用户最终确认前，FinalStateCommit 和正式章节原子保存均不得执行
 * - 只有用户最终确认的版本才能执行 FinalStateCommit、原子保存并成为下一章 frontier
 *
 * 本测试覆盖：
 * 1. acceptProxyDraft：clear pending + canCommit=true（用户原样接受代理审批稿）
 * 2. acceptProxyDraftWithEdits：FactGuard 通过 → clear pending + canCommit=true + editedText
 * 3. acceptProxyDraftWithEdits：FactGuard 不通过 → 不 clear pending + canCommit=false + errors
 * 4. rejectAndRegenerate：clear pending + canCommit=false（不 commitAndSave）
 * 5. inspectAlternatives：只读，返回候选摘要，不修改 pending
 * 6. rollbackCommittedChapter：章节已提交 → 备份 + 删除 + narrativeStateRestoreRequired=true
 * 7. rollbackCommittedChapter：章节未提交 → rolledBack=false
 * 8. 定稿操作不直接调用 commitAndSave（由调用方根据 canCommit 决定）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  saveProxyApprovedDraft,
  hasPendingProxyDraft,
} from "../dist/v2/governance/chapter-proxy-approval-draft-checkpoint.js";
import {
  acceptProxyDraft,
  acceptProxyDraftWithEdits,
  rejectAndRegenerate,
  inspectAlternatives,
  rollbackCommittedChapter,
} from "../dist-test/v2/governance/chapter-proxy-approval-finalization.js";

// ============================================================================
// helpers
// ============================================================================

function makeTempWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "g7-finalization-"));
  const workspaceId = "ws-test";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  return { projectRoot, workspaceId, workspacePath };
}

function makeDraftOptions(overrides = {}) {
  return {
    workspacePath: "",
    approvalId: "cpa-final-001",
    chapterId: "1",
    candidateId: "cand-raw-001",
    selectedSource: "raw",
    finalText: "代理审批稿正文。",
    savedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

function makeApproval(overrides = {}) {
  return {
    schemaId: "pinovel.chapter-proxy-approval",
    schemaVersion: 1,
    approvalId: "cpa-final-001",
    releaseId: "release-001",
    workspaceId: "ws-test",
    chapterId: "1",
    candidateIds: ["cand-raw-001", "cand-ed-001"],
    anonymousMapping: {
      forward: { A: "cand-raw-001", B: "cand-ed-001" },
      reverse: { A: "cand-ed-001", B: "cand-raw-001" },
      seed: 12345,
    },
    forwardVerdict: "PROXY_APPROVED",
    reverseVerdict: "PROXY_APPROVED",
    finalStatus: "PROXY_APPROVED",
    recommendedCandidateId: "cand-raw-001",
    recommendedSource: "raw",
    winningSpans: ["span-A-0-10"],
    losingSpans: ["span-B-0-8"],
    risks: ["editorial 对白密度偏高"],
    rationale: "raw 叙事推进更稳。",
    reviewerType: "validated_human_proxy",
    reviewerModel: "gpt5.6-sol",
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    promptHash: "hash-prompt-001",
    inputArtifactHash: "hash-input-001",
    decidedAt: "2026-07-16T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 60000 },
    ...overrides,
  };
}

function setupPendingDraft(workspacePath, approvalId = "cpa-final-001") {
  saveProxyApprovedDraft(
    makeDraftOptions({ workspacePath, approvalId, finalText: "代理审批稿正文。" }),
  );
  assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
}

// ============================================================================
// 1. acceptProxyDraft
// ============================================================================

test("acceptProxyDraft: clear pending + canCommit=true（用户原样接受）", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const result = acceptProxyDraft({ workspacePath, chapterId: "1", approvalId: "cpa-final-001" });

    assert.equal(result.action, "accept");
    assert.equal(result.clearedPending, true);
    assert.equal(result.canCommit, true);
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. acceptProxyDraftWithEdits：FactGuard 通过
// ============================================================================

test("acceptProxyDraftWithEdits: FactGuard 通过 → clear pending + canCommit=true + editedText", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const editedText = "用户修改后的正文。";
    const result = acceptProxyDraftWithEdits({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-final-001",
      editedText,
      rerunFactGuard: () => ({ ok: true, errors: [] }),
    });

    assert.equal(result.action, "accept_with_edits");
    assert.equal(result.canCommit, true);
    assert.equal(result.clearedPending, true);
    assert.equal(result.factGuardPassed, true);
    assert.equal(result.editedText, editedText);
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. acceptProxyDraftWithEdits：FactGuard 不通过
// ============================================================================

test("acceptProxyDraftWithEdits: FactGuard 不通过 → 不 clear pending + canCommit=false + errors", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const result = acceptProxyDraftWithEdits({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-final-001",
      editedText: "用户修改后引入事实硬伤的正文。",
      rerunFactGuard: () => ({ ok: false, errors: ["entity_inconsistency: 角色A未在第2章出场"] }),
    });

    assert.equal(result.action, "accept_with_edits");
    assert.equal(result.canCommit, false);
    assert.equal(result.clearedPending, false);
    assert.equal(result.factGuardPassed, false);
    assert.deepEqual(result.factGuardErrors, ["entity_inconsistency: 角色A未在第2章出场"]);
    assert.equal(result.blockReason, "factguard_failed");
    // pending 未清除（用户可继续修改）
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. rejectAndRegenerate
// ============================================================================

test("rejectAndRegenerate: clear pending + canCommit=false（不 commitAndSave）", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const result = rejectAndRegenerate({ workspacePath, chapterId: "1", approvalId: "cpa-final-001" });

    assert.equal(result.action, "reject");
    assert.equal(result.clearedPending, true);
    assert.equal(result.canCommit, false);
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. inspectAlternatives（只读）
// ============================================================================

test("inspectAlternatives: 只读，返回候选摘要，不修改 pending", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const approval = makeApproval();
    const result = inspectAlternatives(approval);

    assert.equal(result.action, "inspect");
    assert.equal(result.clearedPending, false);
    assert.equal(result.canCommit, false);
    // 返回候选摘要
    assert.ok(result.inspectSummary);
    assert.equal(result.inspectSummary.approvalId, "cpa-final-001");
    assert.equal(result.inspectSummary.chapterId, "1");
    assert.deepEqual(result.inspectSummary.candidateIds, ["cand-raw-001", "cand-ed-001"]);
    assert.equal(result.inspectSummary.recommendedCandidateId, "cand-raw-001");
    assert.equal(result.inspectSummary.recommendedSource, "raw");
    assert.equal(result.inspectSummary.finalStatus, "PROXY_APPROVED");
    assert.deepEqual(result.inspectSummary.winningSpans, ["span-A-0-10"]);
    assert.deepEqual(result.inspectSummary.losingSpans, ["span-B-0-8"]);
    assert.deepEqual(result.inspectSummary.risks, ["editorial 对白密度偏高"]);
    assert.equal(result.inspectSummary.rationale, "raw 叙事推进更稳。");
    // pending 未修改（只读）
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. rollbackCommittedChapter：章节已提交 → 备份 + 删除
// ============================================================================

test("rollbackCommittedChapter: 章节已提交 → 备份到 chapter-approvals + 删除 chapters/ + narrativeStateRestoreRequired=true", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    // 模拟已提交章节
    const chaptersDir = join(workspacePath, "chapters");
    const chapterPath = join(chaptersDir, "1.md");
    mkdirSync(chaptersDir, { recursive: true });
    writeFileSync(chapterPath, "已提交的章节正文。", "utf-8");
    assert.equal(existsSync(chapterPath), true);

    const result = rollbackCommittedChapter({ workspacePath, chapterId: "1" });

    assert.equal(result.action, "rollback");
    assert.equal(result.rollbackResult.rolledBack, true);
    assert.equal(result.rollbackResult.chapterFilePath, chapterPath);
    assert.ok(result.rollbackResult.backupPath, "应返回备份路径");
    assert.match(result.rollbackResult.backupPath, /chapter-approvals.*1\.rollback-backup/);
    assert.equal(result.rollbackResult.narrativeStateRestoreRequired, true);
    // chapters/ 已删除
    assert.equal(existsSync(chapterPath), false);
    // 备份文件存在且内容正确
    assert.equal(existsSync(result.rollbackResult.backupPath), true);
    assert.equal(readFileSync(result.rollbackResult.backupPath, "utf-8"), "已提交的章节正文。");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. rollbackCommittedChapter：章节未提交
// ============================================================================

test("rollbackCommittedChapter: 章节未提交 → rolledBack=false + reason=chapter_not_committed", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    const result = rollbackCommittedChapter({ workspacePath, chapterId: "99" });

    assert.equal(result.action, "rollback");
    assert.equal(result.rollbackResult.rolledBack, false);
    assert.equal(result.rollbackResult.narrativeStateRestoreRequired, false);
    assert.match(result.rollbackResult.reason || "", /not_committed/);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. 定稿操作不直接调用 commitAndSave（canCommit 标志由调用方消费）
// ============================================================================

test("定稿操作返回 canCommit 标志，不直接调用 commitAndSave（由调用方决定）", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);

    // accept → canCommit=true（调用方负责 commitAndSave）
    const acceptResult = acceptProxyDraft({ workspacePath, chapterId: "1", approvalId: "cpa-final-001" });
    assert.equal(acceptResult.canCommit, true);
    assert.equal(acceptResult.clearedPending, true);

    // reject → canCommit=false（用新 approvalId 避免 append-only 冲突）
    setupPendingDraft(workspacePath, "cpa-final-002");
    const rejectResult = rejectAndRegenerate({ workspacePath, chapterId: "1", approvalId: "cpa-final-002" });
    assert.equal(rejectResult.canCommit, false);

    // inspect → canCommit=false
    const inspectResult = inspectAlternatives(makeApproval());
    assert.equal(inspectResult.canCommit, false);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// 9. rollback 备份文件不覆盖 chapters/ 目录（隔离）
// ============================================================================

test("rollbackCommittedChapter: 备份文件落盘到 chapter-approvals/，不污染 chapters/", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    const chapterPath = join(workspacePath, "chapters", "1.md");
    mkdirSync(join(workspacePath, "chapters"), { recursive: true });
    writeFileSync(chapterPath, "正文。", "utf-8");

    rollbackCommittedChapter({ workspacePath, chapterId: "1" });

    // chapters/ 目录只剩（应为空或不存在 1.md）
    const chaptersDir = join(workspacePath, "chapters");
    if (existsSync(chaptersDir)) {
      const files = readdirSync(chaptersDir);
      assert.equal(files.includes("1.md"), false, "chapters/ 不应再包含 1.md");
    }
    // 备份在 chapter-approvals/
    const approvalsDir = join(workspacePath, "chapter-approvals");
    assert.equal(existsSync(approvalsDir), true);
    const backupFiles = readdirSync(approvalsDir).filter((f) => f.startsWith("1.rollback-backup"));
    assert.equal(backupFiles.length, 1, "应有一个 rollback 备份文件");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// P0: approvalId 双重绑定校验（防越权确认/拒绝他人 pending）
//
// 安全约束：accept/accept_with_edits/reject 必须验证传入 approvalId 与
// pending sentinel 记录的 approvalId 一致，方可清除 pending。
// 错误 approvalId 不得清除他人 pending（防越权提交入口）。
// 无 pending 时也不得返回 canCommit=true（防空确认）。
// ============================================================================

test("P0 acceptProxyDraft: 错误 approvalId 拒绝，不清除 pending（防越权确认）", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath, "cpa-real-001");
    const result = acceptProxyDraft({ workspacePath, chapterId: "1", approvalId: "cpa-wrong-001" });

    assert.equal(result.action, "accept");
    assert.equal(result.clearedPending, false, "错误 approvalId 不得清除 pending");
    assert.equal(result.canCommit, false, "错误 approvalId 不得允许 commit");
    assert.equal(result.blockReason, "approval_id_mismatch");
    // pending 仍然存在（未被错误 approvalId 清除）
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("P0 acceptProxyDraft: 无 pending 时拒绝（no_pending_draft），不得空确认", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    const result = acceptProxyDraft({ workspacePath, chapterId: "1", approvalId: "cpa-001" });

    assert.equal(result.clearedPending, false);
    assert.equal(result.canCommit, false);
    assert.equal(result.blockReason, "no_pending_draft");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("P0 acceptProxyDraft: 正确 approvalId 通过，清除 pending + canCommit=true", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath, "cpa-real-001");
    const result = acceptProxyDraft({ workspacePath, chapterId: "1", approvalId: "cpa-real-001" });

    assert.equal(result.clearedPending, true);
    assert.equal(result.canCommit, true);
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("P0 acceptProxyDraftWithEdits: 错误 approvalId 拒绝（即使 FactGuard 通过），不清除 pending", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath, "cpa-real-001");
    const result = acceptProxyDraftWithEdits({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-wrong-001",
      editedText: "用户修改正文。",
      rerunFactGuard: () => ({ ok: true, errors: [] }),
    });

    assert.equal(result.clearedPending, false, "错误 approvalId 不得清除 pending");
    assert.equal(result.canCommit, false, "错误 approvalId 不得允许 commit");
    assert.equal(result.blockReason, "approval_id_mismatch");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("P0 acceptProxyDraftWithEdits: 无 pending 时拒绝（不运行 FactGuard）", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    let factGuardCalled = false;
    const result = acceptProxyDraftWithEdits({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-001",
      editedText: "用户修改正文。",
      rerunFactGuard: () => {
        factGuardCalled = true;
        return { ok: true, errors: [] };
      },
    });

    assert.equal(result.clearedPending, false);
    assert.equal(result.canCommit, false);
    assert.equal(result.blockReason, "no_pending_draft");
    assert.equal(factGuardCalled, false, "无 pending 时不应运行 FactGuard（短路）");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("P0 rejectAndRegenerate: 错误 approvalId 拒绝，不清除 pending（防越权拒绝）", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath, "cpa-real-001");
    const result = rejectAndRegenerate({ workspacePath, chapterId: "1", approvalId: "cpa-wrong-001" });

    assert.equal(result.action, "reject");
    assert.equal(result.clearedPending, false, "错误 approvalId 不得清除 pending");
    assert.equal(result.canCommit, false);
    assert.equal(result.blockReason, "approval_id_mismatch");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("P0 rejectAndRegenerate: 无 pending 时拒绝（no_pending_draft）", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    const result = rejectAndRegenerate({ workspacePath, chapterId: "1", approvalId: "cpa-001" });

    assert.equal(result.clearedPending, false);
    assert.equal(result.canCommit, false);
    assert.equal(result.blockReason, "no_pending_draft");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("P0 rejectAndRegenerate: 正确 approvalId 通过，清除 pending + canCommit=false", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath, "cpa-real-001");
    const result = rejectAndRegenerate({ workspacePath, chapterId: "1", approvalId: "cpa-real-001" });

    assert.equal(result.clearedPending, true);
    assert.equal(result.canCommit, false);
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// P1: rollbackCommittedChapter 恢复叙事状态（正文与状态一起回退闭环）
//
// commitAndSave 在状态提交前备份 narrative-state-store.json 到
// chapter-approvals/{chapterId}.pre-commit-state-{timestamp}.json。
// rollbackCommittedChapter 从最新备份恢复，实现"正文与状态一起回退"。
// ============================================================================

test("P1 rollbackCommittedChapter: 有 pre-commit-state 备份 -> 恢复叙事状态，narrativeStateRestoreRequired=false", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    // 模拟已提交章节
    const chaptersDir = join(workspacePath, "chapters");
    const chapterPath = join(chaptersDir, "1.md");
    mkdirSync(chaptersDir, { recursive: true });
    writeFileSync(chapterPath, "已提交的章节正文。", "utf-8");

    // 模拟 commitAndSave 创建的 pre-commit 状态备份（章节前状态）
    const approvalsDir = join(workspacePath, "chapter-approvals");
    mkdirSync(approvalsDir, { recursive: true });
    const preCommitState = JSON.stringify({
      schemaVersion: 1,
      workspaceId: "ws-test",
      canon: [{ id: "canon:pre:1", kind: "canon", fact: "章节前事实", sourceChapter: "ch0", sourceRef: "ch0#seed", confidence: 0.7, lastUpdated: "2026-07-15T00:00:00.000Z" }],
      character: [],
      promise: [],
      pattern: [],
      expectation: [],
      updatedAt: "2026-07-15T00:00:00.000Z",
    }, null, 2);
    const stateBackupPath = join(approvalsDir, "1.pre-commit-state-1752960000000.json");
    writeFileSync(stateBackupPath, preCommitState, "utf-8");

    // 模拟提交后状态被章节污染（追加了一个新 canon）
    const stateStorePath = join(workspacePath, "narrative-state-store.json");
    const postCommitState = JSON.stringify({
      schemaVersion: 1,
      workspaceId: "ws-test",
      canon: [
        { id: "canon:pre:1", kind: "canon", fact: "章节前事实", sourceChapter: "ch0", sourceRef: "ch0#seed", confidence: 0.7, lastUpdated: "2026-07-15T00:00:00.000Z" },
        { id: "canon:ch1:new", kind: "canon", fact: "本章新增事实", sourceChapter: "ch1", sourceRef: "ch1#finalText:abc:0-10", confidence: 0.7, lastUpdated: "2026-07-16T00:00:00.000Z" },
      ],
      character: [],
      promise: [],
      pattern: [],
      expectation: [],
      updatedAt: "2026-07-16T00:00:00.000Z",
    }, null, 2);
    writeFileSync(stateStorePath, postCommitState, "utf-8");

    const result = rollbackCommittedChapter({ workspacePath, chapterId: "1" });

    assert.equal(result.rollbackResult.rolledBack, true);
    assert.equal(result.rollbackResult.stateRestored, true, "应从 pre-commit 备份恢复状态");
    assert.equal(result.rollbackResult.narrativeStateRestoreRequired, false, "恢复成功后不需要调用方再恢复");
    assert.equal(result.rollbackResult.stateBackupPath, stateBackupPath);
    assert.equal(result.rollbackResult.stateRestoreError, undefined);

    // narrative-state-store.json 应恢复为 pre-commit 状态（不含本章新增 canon）
    const restoredState = JSON.parse(readFileSync(stateStorePath, "utf-8"));
    assert.equal(restoredState.canon.length, 1, "恢复后应只有章节前的 1 条 canon");
    assert.equal(restoredState.canon[0].id, "canon:pre:1");
    assert.equal(
      restoredState.canon.some((c) => c.id === "canon:ch1:new"),
      false,
      "本章新增的 canon 应被回滚清除",
    );
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("P1 rollbackCommittedChapter: 多个 pre-commit 备份 -> 从最新的恢复", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    const chaptersDir = join(workspacePath, "chapters");
    mkdirSync(chaptersDir, { recursive: true });
    writeFileSync(join(chaptersDir, "1.md"), "正文。", "utf-8");

    const approvalsDir = join(workspacePath, "chapter-approvals");
    mkdirSync(approvalsDir, { recursive: true });
    // 旧备份（timestamp 较小）
    writeFileSync(
      join(approvalsDir, "1.pre-commit-state-1000.json"),
      JSON.stringify({ canon: [{ id: "old" }] }),
      "utf-8",
    );
    // 新备份（timestamp 较大）-> 应恢复这个
    writeFileSync(
      join(approvalsDir, "1.pre-commit-state-2000.json"),
      JSON.stringify({ canon: [{ id: "new" }] }),
      "utf-8",
    );

    const result = rollbackCommittedChapter({ workspacePath, chapterId: "1" });
    assert.equal(result.rollbackResult.stateRestored, true);
    assert.match(result.rollbackResult.stateBackupPath, /pre-commit-state-2000\.json$/);

    const restoredState = JSON.parse(readFileSync(join(workspacePath, "narrative-state-store.json"), "utf-8"));
    assert.equal(restoredState.canon[0].id, "new", "应恢复最新备份");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("P1 rollbackCommittedChapter: 无 pre-commit 备份 -> narrativeStateRestoreRequired=true（正文仍回滚）", () => {
  const { workspacePath } = makeTempWorkspace();
  try {
    const chaptersDir = join(workspacePath, "chapters");
    const chapterPath = join(chaptersDir, "1.md");
    mkdirSync(chaptersDir, { recursive: true });
    writeFileSync(chapterPath, "已提交的章节正文。", "utf-8");

    const result = rollbackCommittedChapter({ workspacePath, chapterId: "1" });

    assert.equal(result.rollbackResult.rolledBack, true, "正文仍应回滚");
    assert.equal(result.rollbackResult.stateRestored, false, "无备份时状态未恢复");
    assert.equal(result.rollbackResult.narrativeStateRestoreRequired, true, "需要调用方单独恢复");
    assert.equal(result.rollbackResult.stateRestoreError, "no_pre_commit_state_backup");
    // 正文已删除
    assert.equal(existsSync(chapterPath), false);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
