/**
 * workspace-manager proxy_finalization round-trip 测试
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §12.2 / §12.3
 *         docs/remaining-development-dispatch-plan-20260715.md §0.2
 *
 * 用户架构决策（2026-07-17 第二轮核验）：
 * - 移除第 7 个公开工具，通过 novel_workspace_manager action="proxy_finalization" 暴露定稿子操作
 * - novel_workspace_manager 内部委托 handleChapterProxyFinalization
 * - 保持 production-tool-registration.test.mjs 的 6 工具断言
 *
 * 本测试验证 workspace_manager action="proxy_finalization" round-trip：
 * 1. accept: workspace_manager 委托 handler -> commitAndSave 写入正文 + feedback 记录
 * 2. accept_with_edits: 委托 handler -> 写入 editedText
 * 3. reject: 委托 handler -> 不 commitAndSave
 * 4. rollback: 委托 handler -> 回滚已提交章节
 * 5. inspect: 委托 handler -> 只读查看
 * 6. 无 confirm: workspace_manager 委托 handler -> blocked (confirmation_required)
 * 7. 未知 proxyAction: 返回 status=error
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  saveProxyApprovedDraft,
  hasPendingProxyDraft,
} from "../dist/v2/governance/chapter-proxy-approval-draft-checkpoint.js";
import { loadProxyApprovalFeedback } from "../dist/v2/governance/chapter-proxy-approval-feedback-recorder.js";
import { createChapterProxyApprovalRegistry } from "../dist/v2/governance/chapter-proxy-approval-registry.js";
import { handleWorkspaceManager } from "../dist/tools/workspace-manager-handler.js";

// ============================================================================
// helpers
// ============================================================================

function makeTempWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "g7-wsm-"));
  const workspaceId = "ws-test";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(workspacePath, { recursive: true });
  return { projectRoot, workspaceId, workspacePath };
}

function makeDraftOptions(overrides = {}) {
  return {
    workspacePath: "",
    approvalId: "cpa-wsm-001",
    chapterId: "1",
    candidateId: "cand-raw-001",
    selectedSource: "raw",
    finalText: "代理审批稿正文。这是一段足够长的正文，用于通过 FactGuard 的格式校验。",
    savedAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function setupPendingDraft(workspacePath, approvalId = "cpa-wsm-001") {
  saveProxyApprovedDraft(makeDraftOptions({ workspacePath, approvalId }));
  assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
}

function writeWorkspaceConfig(workspacePath, characters = []) {
  const config = {
    workspaceId: "ws-test",
    novelName: "测试小说",
    genre: "都市异能",
    subGenres: [],
    styleProfile: "default",
    styleOverrides: {},
    brainholePreferences: {
      enabledPatterns: [],
      aggressiveness: 0.3,
      autoApplyThreshold: 0.7,
      maxInjectionsPerChapter: 1,
    },
    qualityGates: {
      antiAiThreshold: 0.2,
      emotionMetronome: "strict",
      dependencyCheck: "strict",
      minSatisfactionDensity: 0.00015,
      maxOppressionLength: 4000,
    },
    targetWordCount: {
      perChapter: { min: 2500, max: 4500 },
      total: 600000,
    },
    chapterProgress: { completed: 0, current: 1 },
    characters,
  };
  writeFileSync(join(workspacePath, "config.json"), JSON.stringify(config, null, 2), "utf-8");
}

const TEST_CHARACTERS = [
  { id: "li-yifan", name: "李一凡", role: "protagonist", aliases: ["一凡"] },
];

// ============================================================================
// 1. accept: workspace_manager 委托 handler -> commitAndSave 写入正文
// ============================================================================

test("workspace_manager proxy_finalization accept: 委托 handler 写入 draftText + feedback", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    const result = await handleWorkspaceManager({
      action: "proxy_finalization",
      workspaceId,
      proxyAction: "accept",
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-wsm-001",
      confirm: true,
      _projectRoot: projectRoot,
    });

    // workspace_manager 委托 handler 返回结果
    assert.equal(result.status, "ok");
    assert.equal(result.workspaceId, workspaceId);
    assert.equal(result.chapterId, "1");
    assert.equal(result.approvalId, "cpa-wsm-001");
    assert.equal(result.action, "accept");

    // chapters/1.md 写入 draftText
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), true);
    const savedText = readFileSync(chapterPath, "utf-8");
    assert.equal(savedText, makeDraftOptions().finalText);

    // pending 已清除
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false);

    // feedback 记录
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, "accept");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. accept_with_edits: 委托 handler 写入 editedText
// ============================================================================

test("workspace_manager proxy_finalization accept_with_edits: 委托 handler 写入 editedText", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);
    const editedText = "用户修改后的正文。这是一段足够长的修改正文，用于通过 FactGuard 的格式校验。";

    const result = await handleWorkspaceManager({
      action: "proxy_finalization",
      workspaceId,
      proxyAction: "accept_with_edits",
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-wsm-001",
      editedText,
      confirm: true,
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.finalization.finalization.action, "accept_with_edits");
    assert.equal(result.finalization.finalization.canCommit, true);

    // chapters/1.md 写入 editedText
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), true);
    const savedText = readFileSync(chapterPath, "utf-8");
    assert.equal(savedText, editedText);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. reject: 委托 handler 不 commitAndSave
// ============================================================================

test("workspace_manager proxy_finalization reject: 委托 handler 不 commitAndSave", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    const result = await handleWorkspaceManager({
      action: "proxy_finalization",
      workspaceId,
      proxyAction: "reject",
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-wsm-001",
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.finalization.finalization.action, "reject");
    assert.equal(result.finalization.commit, undefined, "reject 不应调用 commitAndSave");

    // chapters/ 不应被写入
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), false);

    // feedback 记录 action=reject
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, "reject");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. rollback: 委托 handler 回滚已提交章节
// ============================================================================

test("workspace_manager proxy_finalization rollback: 委托 handler 回滚已提交章节", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);

    // 模拟已提交章节
    const chaptersDir = join(workspacePath, "chapters");
    const chapterPath = join(chaptersDir, "1.md");
    mkdirSync(chaptersDir, { recursive: true });
    writeFileSync(chapterPath, "已提交的章节正文。", "utf-8");

    setupPendingDraft(workspacePath);

    const result = await handleWorkspaceManager({
      action: "proxy_finalization",
      workspaceId,
      proxyAction: "rollback",
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-wsm-001",
      confirm: true,
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.finalization.finalization.action, "rollback");
    assert.equal(result.finalization.finalization.rollbackResult.rolledBack, true);

    // chapters/1.md 已删除
    assert.equal(existsSync(chapterPath), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. inspect: 委托 handler 只读查看
// ============================================================================

test("workspace_manager proxy_finalization inspect: 委托 handler 只读查看", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    // 写入 approval artifact 到 registry
    const registry = createChapterProxyApprovalRegistry({
      approvalsDir: join(workspacePath, "chapter-approvals"),
    });
    const artifact = {
      schemaId: "pinovel.chapter-proxy-approval",
      schemaVersion: 1,
      approvalId: "cpa-wsm-001",
      releaseId: "release-001",
      workspaceId,
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
      decidedAt: "2026-07-17T00:00:00.000Z",
      budgetUsed: { calls: 2, timeoutMs: 60000 },
    };
    registry.writeArtifact(artifact);

    const result = await handleWorkspaceManager({
      action: "proxy_finalization",
      workspaceId,
      proxyAction: "inspect",
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-wsm-001",
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.finalization.finalization.action, "inspect");
    assert.equal(result.finalization.commit, undefined, "inspect 不应调用 commitAndSave");

    // pending 保留（inspect 只读）
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. 无 confirm: workspace_manager 委托 handler -> blocked (confirmation_required)
// ============================================================================

test("workspace_manager proxy_finalization accept 无 confirm: blocked (confirmation_required)", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    const result = await handleWorkspaceManager({
      action: "proxy_finalization",
      workspaceId,
      proxyAction: "accept",
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-wsm-001",
      // 故意不传 confirm: true
      _projectRoot: projectRoot,
    });

    // accept 必须显式确认，否则 blocked
    assert.equal(result.status, "blocked");
    assert.equal(result.finalization.finalization.blockReason, "confirmation_required");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true, "未确认时 pending 保留");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. 未知 proxyAction: 返回 status=error
// ============================================================================

test("workspace_manager proxy_finalization 未知 proxyAction: 返回 status=error", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    const result = await handleWorkspaceManager({
      action: "proxy_finalization",
      workspaceId,
      proxyAction: "unknown_action",
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-wsm-001",
      confirm: true,
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "error");
    assert.ok(result.error, "应返回错误信息");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
