/**
 * EVOLUTION-RELEASE-GOVERNANCE-G7 - 定稿真实调用链入口测试（Finalization Entry）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §12.2 / §12 line 585
 *
 * 本测试覆盖 finalization-entry 的真实接线（prod-binding 缺失的"实际调用"环节）：
 * - accept -> acceptProxyDraft -> commitAndSave(draftText) -> feedback
 * - accept_with_edits -> checkCandidateFactGuard 真实重跑 -> commitAndSave(editedText) -> feedback(diff)
 * - reject -> rejectAndRegenerate -> feedback（不 commitAndSave）
 * - rollback -> rollbackCommittedChapter -> feedback（不 commitAndSave）
 * - inspect -> inspectAlternatives（只读，不 commitAndSave / 不 feedback / 不 clear pending）
 * - 错误 approvalId -> 阻断，不 commitAndSave
 *
 * 验证点：
 * 1. accept: chapters/{chapterId}.md 写入 draftText + pending 清除 + feedback.jsonl 记录
 * 2. accept_with_edits: chapters/{chapterId}.md 写入 editedText + feedback 含 editedTextDiff
 * 3. reject: chapters/ 不写入 + pending 清除 + feedback action=reject
 * 4. rollback: chapters/ 回滚 + feedback 含 rollbackResult
 * 5. 错误 approvalId: 不 commitAndSave + feedback 不记录（pending draft 加载失败时不记录）
 * 6. accept 无 stagedStateUpdate: commitAndSave 保存正文 + 注入空 stagedStateUpdate 派生 pattern entries
 * 7-8. commitAndSave 失败 -> 恢复 pending（验收 2）
 * 9-10. restorePendingSentinel 单元测试
 * 11. inspect: 返回候选摘要 + 不 commitAndSave + 不记录 feedback + pending 保留（缺口一）
 * 12. accept_with_edits 无 stagedStateUpdate: 注入非空 stagedStateUpdate 给 commitAndSave（缺口二）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  saveProxyApprovedDraft,
  hasPendingProxyDraft,
} from "../dist/v2/governance/chapter-proxy-approval-draft-checkpoint.js";
import { loadProxyApprovalFeedback } from "../dist/v2/governance/chapter-proxy-approval-feedback-recorder.js";
import { runFinalization } from "../dist-test/v2/governance/chapter-proxy-approval-finalization-entry.js";
import { loadUserRevisionDelta } from "../dist-test/v2/core/user-revision-delta.js";

// ============================================================================
// helpers
// ============================================================================

function makeTempWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "g7-final-entry-"));
  const workspaceId = "ws-test";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(workspacePath, { recursive: true });
  return { projectRoot, workspaceId, workspacePath };
}

function makeDraftOptions(overrides = {}) {
  return {
    workspacePath: "",
    approvalId: "cpa-entry-001",
    chapterId: "1",
    candidateId: "cand-raw-001",
    selectedSource: "raw",
    finalText: "代理审批稿正文。这是一段足够长的正文，用于通过 FactGuard 的格式校验。",
    savedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

function makeMinimalOrchestratorInput(projectRoot, workspaceId, chapterId = "1") {
  // 最小化 UnifiedOrchestratorInput：含 checkCandidateFactGuard 实际使用的字段
  // CompiledContext 需要 facts/characterStates/openLoops/worldRules/styleReferences/sourceMap
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
    characterNames: ["李明"],
    stagedStateUpdate: null,
  };
}

function setupPendingDraft(workspacePath, approvalId = "cpa-entry-001", overrides = {}) {
  saveProxyApprovedDraft(
    makeDraftOptions({ workspacePath, approvalId, ...overrides }),
  );
  assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
}

/**
 * 构造 ChapterProxyApprovalArtifact fixture（用于 inspect 入口测试）。
 * 字段对齐 v2/governance/chapter-proxy-approval-types.ts ChapterProxyApprovalArtifact。
 */
function makeApproval(overrides = {}) {
  return {
    schemaId: "pinovel.chapter-proxy-approval",
    schemaVersion: 1,
    approvalId: "cpa-entry-001",
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

// ============================================================================
// 1. accept -> commitAndSave(draftText) -> feedback
// ============================================================================

test("entry accept: clear pending + commitAndSave 写入 draftText + feedback 记录", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");

    const result = runFinalization({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-entry-001",
      action: "accept",
      orchestratorInput,
    });

    // 定稿成功
    assert.equal(result.finalization.action, "accept");
    assert.equal(result.finalization.canCommit, true);
    assert.equal(result.finalization.clearedPending, true);

    // commitAndSave 被调用：chapters/1.md 写入 draftText
    assert.ok(result.commit, "应有 commit 结果");
    assert.equal(result.commit.ok, true);
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), true, "chapters/1.md 应被写入");
    const savedText = readFileSync(chapterPath, "utf-8");
    assert.equal(savedText, makeDraftOptions().finalText, "写入的正文应为 draftText");

    // pending 已清除
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false);

    // feedback 记录
    assert.ok(result.feedbackRecorded, "应有 feedback 记录");
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, "accept");
    assert.equal(records[0].approvalId, "cpa-entry-001");
    assert.equal(records[0].proxyJudgmentBias.aligned, true, "accept 时代理推荐与用户决策一致");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. accept_with_edits -> checkCandidateFactGuard -> commitAndSave(editedText) -> feedback(diff)
// ============================================================================

test("entry accept_with_edits: 真实 FactGuard 通过 -> commitAndSave 写入 editedText + feedback 含 diff", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    const editedText = "用户修改后的正文。这是一段足够长的修改正文，用于通过 FactGuard 的格式校验。";

    const result = runFinalization({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-entry-001",
      action: "accept_with_edits",
      editedText,
      orchestratorInput,
    });

    // 定稿成功（FactGuard 通过）
    assert.equal(result.finalization.action, "accept_with_edits");
    assert.equal(result.finalization.canCommit, true);
    assert.equal(result.finalization.factGuardPassed, true, "真实 checkCandidateFactGuard 应通过");

    // commitAndSave 写入 editedText（不是原稿）
    assert.ok(result.commit, "应有 commit 结果");
    assert.equal(result.commit.ok, true);
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), true);
    const savedText = readFileSync(chapterPath, "utf-8");
    assert.equal(savedText, editedText, "写入的正文应为 editedText");

    // feedback 含 editedTextDiff
    assert.ok(result.feedbackRecorded);
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, "accept_with_edits");
    assert.equal(records[0].factGuardPassed, true);
    assert.ok(records[0].editedTextDiff, "应有 editedTextDiff");
    assert.equal(records[0].editedTextDiff.same, false, "原稿与用户稿应不同");
    assert.equal(records[0].proxyJudgmentBias.userAcceptedSource, "user_edited");
    assert.equal(records[0].proxyJudgmentBias.aligned, false, "用户修改视为与代理推荐不一致");

    assert.ok(result.revisionDeltaPath, "accept_with_edits 成功后应保存 revision delta");
    assert.equal(existsSync(result.revisionDeltaPath), true);
    const revisionDelta = loadUserRevisionDelta(result.revisionDeltaPath);
    assert.equal(revisionDelta.selectedCandidateId, "cand-raw-001");
    assert.equal(revisionDelta.systemSelectedText, makeDraftOptions().finalText);
    assert.equal(revisionDelta.userFinalText, editedText);
    assert.ok(revisionDelta.modifiedSpans.length > 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. reject -> 不 commitAndSave + feedback action=reject
// ============================================================================

test("entry reject: clear pending + 不 commitAndSave + feedback action=reject", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");

    const result = runFinalization({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-entry-001",
      action: "reject",
      orchestratorInput,
    });

    assert.equal(result.finalization.action, "reject");
    assert.equal(result.finalization.clearedPending, true);
    assert.equal(result.finalization.canCommit, false);
    assert.equal(result.commit, undefined, "reject 不应调用 commitAndSave");

    // chapters/ 不应被写入
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), false, "reject 不应写 chapters/");

    // pending 已清除
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false);

    // feedback 记录
    assert.ok(result.feedbackRecorded);
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, "reject");
    assert.equal(records[0].proxyJudgmentBias.aligned, false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. rollback -> 不 commitAndSave + feedback 含 rollbackResult
// ============================================================================

test("entry rollback: 回滚已提交章节 + 不 commitAndSave + feedback 含 rollbackResult", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // 模拟已提交章节
    const chaptersDir = join(workspacePath, "chapters");
    const chapterPath = join(chaptersDir, "1.md");
    mkdirSync(chaptersDir, { recursive: true });
    writeFileSync(chapterPath, "已提交的章节正文。", "utf-8");

    // 设置 pending draft（用于 feedback 记录）
    setupPendingDraft(workspacePath);

    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");

    const result = runFinalization({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-entry-001",
      action: "rollback",
      orchestratorInput,
    });

    assert.equal(result.finalization.action, "rollback");
    assert.equal(result.finalization.rollbackResult.rolledBack, true);
    assert.equal(result.commit, undefined, "rollback 不应调用 commitAndSave");

    // chapters/1.md 已删除
    assert.equal(existsSync(chapterPath), false, "rollback 后 chapters/1.md 应被删除");

    // feedback 含 rollbackResult
    assert.ok(result.feedbackRecorded);
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, "rollback");
    assert.ok(records[0].rollbackResult, "应有 rollbackResult");
    assert.equal(records[0].rollbackResult.rolledBack, true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. 错误 approvalId -> 阻断，不 commitAndSave
// ============================================================================

test("entry accept 错误 approvalId: 阻断 + 不 commitAndSave + pending 保留", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath, "cpa-real-001");
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");

    const result = runFinalization({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-wrong-001",
      action: "accept",
      orchestratorInput,
    });

    // 定稿被阻断
    assert.equal(result.finalization.canCommit, false);
    assert.equal(result.finalization.clearedPending, false);
    assert.equal(result.finalization.blockReason, "approval_id_mismatch");

    // 不调用 commitAndSave
    assert.equal(result.commit, undefined, "错误 approvalId 不应调用 commitAndSave");
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), false, "不应写 chapters/");

    // pending 保留（未被错误 approvalId 清除）
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. accept 无 stagedStateUpdate -> commitAndSave 仍保存正文（state 派生见 test 12）
//    缺口二修复后：stagedStateUpdate 为 null 时注入空 update，使 commitAndSave
//    进入 stagedStateUpdate 分支并从 finalText 提取 pattern entries（不再 skipped）。
// ============================================================================

test("entry accept 无 stagedStateUpdate: commitAndSave 保存正文 + 注入空 stagedStateUpdate 派生 pattern entries", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    // stagedStateUpdate = null（无状态派生）

    const result = runFinalization({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-entry-001",
      action: "accept",
      orchestratorInput,
    });

    assert.equal(result.commit.ok, true, "commitAndSave 应成功");
    // 正文已保存
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. accept commitAndSave 失败 -> 恢复 pending（用户可重试）
//    验收 2：commitAndSave 失败时不得丢失 pending checkpoint
// ============================================================================

test("entry accept commitAndSave 失败: 恢复 pending + hasPendingProxyDraft=true + pendingRestored=true", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");

    // 注入失败的 commitAndSaveFn（模拟 atomicSave 失败或状态提交异常）
    const failingCommitAndSave = () => ({
      ok: false,
      error: "mock_atomic_save_failure",
      stateCommit: null,
    });

    const result = runFinalization({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-entry-001",
      action: "accept",
      orchestratorInput,
      commitAndSaveFn: failingCommitAndSave,
    });

    // 定稿操作本身成功（clear pending 已执行）
    assert.equal(result.finalization.action, "accept");
    assert.equal(result.finalization.canCommit, true);

    // commitAndSave 失败
    assert.ok(result.commit, "应有 commit 结果");
    assert.equal(result.commit.ok, false, "commitAndSave 应失败");
    assert.equal(result.commit.error, "mock_atomic_save_failure");

    // 关键验收：pending 已恢复（用户可重试）
    assert.equal(result.pendingRestored, true, "commitAndSave 失败后必须恢复 pending");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true, "pending sentinel 应被恢复");

    // chapters/ 不应被写入
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), false, "失败时不应写 chapters/");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. accept_with_edits commitAndSave 失败 -> 恢复 pending
// ============================================================================

test("entry accept_with_edits commitAndSave 失败: 恢复 pending + FactGuard 已通过", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    const editedText = "用户修改后的正文。这是一段足够长的修改正文，用于通过 FactGuard 的格式校验。";

    const failingCommitAndSave = () => ({
      ok: false,
      error: "mock_state_commit_failure",
      stateCommit: null,
    });

    const result = runFinalization({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-entry-001",
      action: "accept_with_edits",
      editedText,
      orchestratorInput,
      commitAndSaveFn: failingCommitAndSave,
    });

    // FactGuard 已通过（真实 checkCandidateFactGuard 运行）
    assert.equal(result.finalization.action, "accept_with_edits");
    assert.equal(result.finalization.canCommit, true);
    assert.equal(result.finalization.factGuardPassed, true);

    // commitAndSave 失败
    assert.equal(result.commit.ok, false);

    // 关键验收：pending 已恢复
    assert.equal(result.pendingRestored, true, "commitAndSave 失败后必须恢复 pending");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 9. restorePendingSentinel 单元测试：draft 不存在时不恢复
// ============================================================================

test("restorePendingSentinel: draft 不存在 -> restored=false + reason=draft_not_found", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // 不设置 pending draft（draft 文件不存在）
    const { restorePendingSentinel } = await import(
      "../dist/v2/governance/chapter-proxy-approval-draft-checkpoint.js"
    );

    const result = restorePendingSentinel(workspacePath, "1", "cpa-nonexistent-001", "2026-07-17T00:00:00.000Z");
    assert.equal(result.restored, false, "draft 不存在时不应恢复");
    assert.equal(result.reason, "draft_not_found");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false, "不应写入 sentinel");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 10. restorePendingSentinel 单元测试：draft 存在 -> 恢复 sentinel
// ============================================================================

test("restorePendingSentinel: draft 存在 -> restored=true + hasPendingProxyDraft=true", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    // 模拟 finalization 已 clear pending（但 draft 文件仍在）
    const { clearPendingProxyDraft, restorePendingSentinel } = await import(
      "../dist/v2/governance/chapter-proxy-approval-draft-checkpoint.js"
    );
    clearPendingProxyDraft(workspacePath, "1");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false, "clear 后应无 pending");

    // 恢复 pending
    const result = restorePendingSentinel(workspacePath, "1", "cpa-entry-001", "2026-07-17T00:00:00.000Z");
    assert.equal(result.restored, true, "draft 存在时应恢复");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true, "恢复后应有 pending");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 11. inspect 入口：返回候选摘要 + 不 commitAndSave + 不记录 feedback + pending 保留
//     缺口一修复：finalization-entry 缺 inspect_alternatives 入口，与 finalization 模块
//     的 inspectAlternatives 对齐（计划 §12.2 五种定稿操作）。
// ============================================================================

test("entry inspect: 返回候选摘要 + 不 commitAndSave + 不记录 feedback + pending 保留", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    const approvalArtifact = makeApproval({ approvalId: "cpa-entry-001", chapterId: "1" });

    let commitCalled = false;
    const trackingCommitAndSave = () => {
      commitCalled = true;
      return { ok: true, stateCommit: { committed: 0, rejected: 0 } };
    };

    const result = runFinalization({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-entry-001",
      action: "inspect",
      orchestratorInput,
      approvalArtifact,
      commitAndSaveFn: trackingCommitAndSave,
    });

    // 返回 inspect 摘要
    assert.equal(result.finalization.action, "inspect");
    assert.equal(result.finalization.clearedPending, false);
    assert.equal(result.finalization.canCommit, false);
    assert.ok(result.finalization.inspectSummary, "应返回候选摘要");
    assert.equal(result.finalization.inspectSummary.approvalId, "cpa-entry-001");
    assert.equal(result.finalization.inspectSummary.chapterId, "1");
    assert.deepEqual(result.finalization.inspectSummary.candidateIds, ["cand-raw-001", "cand-ed-001"]);
    assert.equal(result.finalization.inspectSummary.recommendedSource, "raw");
    assert.equal(result.finalization.inspectSummary.finalStatus, "PROXY_APPROVED");

    // 不 commitAndSave
    assert.equal(result.commit, undefined, "inspect 不应调用 commitAndSave");
    assert.equal(commitCalled, false, "commitAndSave 不应被调用");

    // 不记录 feedback（inspect 是只读查看，不是定稿决策）
    assert.equal(result.feedbackRecorded, undefined, "inspect 不应记录 feedback");
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 0, "feedback.jsonl 不应有记录");

    // pending 保留（只读操作不清除 pending）
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true, "pending 应保留");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 12. accept_with_edits 无 stagedStateUpdate -> 注入非空 stagedStateUpdate 给 commitAndSave
//     缺口二修复：用户编辑后没有重新派生状态，stagedStateUpdate 为 null 时状态提交直接跳过。
//     修复后：runFinalization 在 stagedStateUpdate 为 null 时注入空 StagedStateUpdate
//     （additions/invalidations 为空，sourceChapter=ch{N}），使 commitAndSave 进入
//     stagedStateUpdate 分支并从 finalText 提取 pattern entries（基于最终稿重新派生）。
// ============================================================================

test("entry accept_with_edits 无 stagedStateUpdate: 注入非空 stagedStateUpdate 给 commitAndSave（基于最终稿派生 pattern entries）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    // stagedStateUpdate = null（makeMinimalOrchestratorInput 默认）
    const editedText = "用户修改后的正文。这是一段足够长的修改正文，用于通过 FactGuard 的格式校验。";

    let capturedInput = null;
    let capturedFinalText = null;
    const capturingCommitAndSave = (input, candidateId, finalText) => {
      capturedInput = input;
      capturedFinalText = finalText;
      return { ok: true, stateCommit: { committed: 0, rejected: 0 } };
    };

    const result = runFinalization({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-entry-001",
      action: "accept_with_edits",
      editedText,
      orchestratorInput,
      commitAndSaveFn: capturingCommitAndSave,
    });

    // FactGuard 通过 + commit 成功
    assert.equal(result.finalization.action, "accept_with_edits");
    assert.equal(result.finalization.canCommit, true);
    assert.equal(result.finalization.factGuardPassed, true);
    assert.ok(result.commit, "应有 commit 结果");
    assert.equal(result.commit.ok, true);

    // 关键验收：commitAndSave 收到的 input.stagedStateUpdate 应为非空（注入后）
    assert.ok(capturedInput, "commitAndSave 应被调用");
    assert.ok(
      capturedInput.stagedStateUpdate,
      "stagedStateUpdate 应被注入为非空（基于最终稿重新派生，不再为 null）",
    );
    assert.equal(
      capturedInput.stagedStateUpdate.sourceChapter,
      "ch1",
      "注入的 sourceChapter 应为 ch{chapterNumber}",
    );
    assert.deepEqual(
      capturedInput.stagedStateUpdate.additions,
      [],
      "注入的 additions 应为空数组（pattern entries 由 commitAndSave 内部从 finalText 提取）",
    );
    assert.deepEqual(
      capturedInput.stagedStateUpdate.invalidations,
      [],
      "注入的 invalidations 应为空数组",
    );

    // finalText 应为用户编辑后的正文
    assert.equal(capturedFinalText, editedText, "commitAndSave 收到的 finalText 应为 editedText");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("entry accept_with_edits: 从 pending checkpoint 恢复 canon/character/promise 状态再提交最终稿", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    const stagedStateUpdate = {
      additions: [
        {
          kind: "canon",
          id: "canon:fact:dark-current",
          sourceChapter: "ch1",
          sourceRef: "seed:canon:dark-current",
          confidence: 0.6,
          lastUpdated: "2026-07-16T00:00:00.000Z",
          fact: "暗流不可消除",
          category: "ability_rule",
        },
        {
          kind: "character",
          id: "character:林川:ch1",
          sourceChapter: "ch1",
          sourceRef: "seed:character:林川",
          confidence: 0.6,
          lastUpdated: "2026-07-16T00:00:00.000Z",
          characterId: "林川",
          field: "participation",
          value: "present",
        },
        {
          kind: "promise",
          id: "promise:dark-current",
          sourceChapter: "ch1",
          sourceRef: "seed:promise:dark-current",
          confidence: 0.6,
          lastUpdated: "2026-07-16T00:00:00.000Z",
          promiseId: "promise:dark-current",
          description: "暗流真相",
          currentHeat: 1,
          status: "advancing",
        },
      ],
      invalidations: [],
      sourceChapter: "ch1",
    };
    setupPendingDraft(workspacePath, "cpa-entry-001", { stagedStateUpdate });
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    const editedText = "林川抓住门框，确认暗流不可消除。他意识到暗流真相仍藏在水下。";

    let capturedInput = null;
    const capturingCommitAndSave = (input) => {
      capturedInput = input;
      return { ok: true, stateCommit: { committed: 3, rejected: 0 } };
    };

    const result = runFinalization({
      workspacePath,
      chapterId: "1",
      approvalId: "cpa-entry-001",
      action: "accept_with_edits",
      editedText,
      orchestratorInput,
      commitAndSaveFn: capturingCommitAndSave,
    });

    assert.equal(result.commit?.ok, true);
    assert.ok(capturedInput?.stagedStateUpdate, "commitAndSave 应收到恢复后的 stagedStateUpdate");
    assert.deepEqual(
      capturedInput.stagedStateUpdate.additions.map((entry) => entry.kind).sort(),
      ["canon", "character", "promise"],
      "定稿路径不得只派生 PatternMemory，必须恢复 Canon/Character/Promise",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
