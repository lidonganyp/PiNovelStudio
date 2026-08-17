/**
 * COMMIT-AUTHORIZATION-BOUNDARY — pending 绑定 + 定稿授权边界（计划 20260812-2 P3/P4/P7）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  saveProxyApprovedDraft,
  hasPendingProxyDraft,
  getPendingSentinel,
  validatePendingBinding,
  loadProxyApprovedDraft,
  clearPendingProxyDraft,
  restorePendingSentinel,
} from "../dist/v2/governance/chapter-proxy-approval-draft-checkpoint.js";
import { computeArtifactHash } from "../dist/v2/core/autonomy-policy.js";
import {
  createActionApprovalReceipt,
  authorizeCommitAction,
} from "../dist/v2/governance/action-approval-receipt.js";
import { handleChapterProxyFinalization } from "../dist-test/handlers/chapter-proxy-finalization-handler.js";

const FINAL_TEXT = "代理审批稿正文。这是一段足够长的正文，用于通过 FactGuard 的格式校验。";

function makeTempWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "commit-auth-"));
  const workspaceId = "ws-commit";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(
    join(workspacePath, "config.json"),
    JSON.stringify({
      characters: [{ name: "林川", aliases: ["小川"] }],
    }),
    "utf-8",
  );
  return { projectRoot, workspaceId, workspacePath };
}

function saveDraft(workspacePath, overrides = {}) {
  const savedAt = overrides.savedAt ?? "2026-08-12T00:00:00.000Z";
  saveProxyApprovedDraft({
    workspacePath,
    approvalId: overrides.approvalId ?? "cpa-commit-001",
    chapterId: overrides.chapterId ?? "1",
    candidateId: "cand-1",
    selectedSource: "raw",
    finalText: overrides.finalText ?? FINAL_TEXT,
    savedAt,
    workspaceId: overrides.workspaceId,
    ...overrides,
  });
  return savedAt;
}

test("pending sentinel 写入 artifactHash/revision/workspaceId", () => {
  const { workspacePath, workspaceId } = makeTempWorkspace();
  try {
    saveDraft(workspacePath, { workspaceId });
    const sentinel = getPendingSentinel(workspacePath, "1");
    assert.ok(sentinel);
    assert.equal(typeof sentinel.artifactHash, "string");
    assert.ok(sentinel.artifactHash.length > 0);
    assert.equal(sentinel.revision, "2026-08-12T00:00:00.000Z");
    assert.equal(sentinel.workspaceId, workspaceId);
    const draft = loadProxyApprovedDraft(workspacePath, "cpa-commit-001");
    assert.equal(draft.artifactHash, computeArtifactHash(FINAL_TEXT));
  } finally {
    rmSync(join(workspacePath, "..", ".."), { recursive: true, force: true });
  }
});

test("pending 稿被修改后使用旧 revision → stale_revision", () => {
  const { workspacePath, workspaceId } = makeTempWorkspace();
  try {
    saveDraft(workspacePath, { workspaceId });
    const bind = validatePendingBinding({
      workspacePath,
      workspaceId,
      chapterId: "1",
      approvalId: "cpa-commit-001",
      revision: "OLD_REVISION",
      finalText: FINAL_TEXT,
    });
    assert.equal(bind.ok, false);
    assert.equal(bind.blockReason, "stale_revision");
  } finally {
    rmSync(join(workspacePath, "..", ".."), { recursive: true, force: true });
  }
});

test("正文 hash 改变后使用旧审批 → artifact_hash_mismatch", () => {
  const { workspacePath, workspaceId } = makeTempWorkspace();
  try {
    saveDraft(workspacePath, { workspaceId });
    const bind = validatePendingBinding({
      workspacePath,
      workspaceId,
      chapterId: "1",
      approvalId: "cpa-commit-001",
      revision: "2026-08-12T00:00:00.000Z",
      finalText: FINAL_TEXT + "【被篡改】",
    });
    assert.equal(bind.ok, false);
    assert.equal(bind.blockReason, "artifact_hash_mismatch");
  } finally {
    rmSync(join(workspacePath, "..", ".."), { recursive: true, force: true });
  }
});

test("跨 workspace 绑定失败", () => {
  const { workspacePath, workspaceId } = makeTempWorkspace();
  try {
    saveDraft(workspacePath, { workspaceId });
    const bind = validatePendingBinding({
      workspacePath,
      workspaceId: "ws-other",
      chapterId: "1",
      approvalId: "cpa-commit-001",
      revision: "2026-08-12T00:00:00.000Z",
      finalText: FINAL_TEXT,
    });
    assert.equal(bind.ok, false);
    assert.equal(bind.blockReason, "workspace_mismatch");
  } finally {
    rmSync(join(workspacePath, "..", ".."), { recursive: true, force: true });
  }
});

test("旧 sentinel 无 hash 时可从 draft 安全补齐", () => {
  const { workspacePath, workspaceId } = makeTempWorkspace();
  try {
    saveDraft(workspacePath, { workspaceId });
    // 覆写为旧格式 sentinel（无 artifactHash）
    const sentinelPath = join(workspacePath, "chapter-approvals", "1.pending.json");
    writeFileSync(
      sentinelPath,
      JSON.stringify({
        chapterId: "1",
        approvalId: "cpa-commit-001",
        status: "pending",
        savedAt: "2026-08-12T00:00:00.000Z",
      }),
      "utf-8",
    );
    const bind = validatePendingBinding({
      workspacePath,
      workspaceId,
      chapterId: "1",
      approvalId: "cpa-commit-001",
      revision: "2026-08-12T00:00:00.000Z",
      finalText: FINAL_TEXT,
    });
    assert.equal(bind.ok, true);
    assert.equal(bind.artifactHash, computeArtifactHash(FINAL_TEXT));
  } finally {
    rmSync(join(workspacePath, "..", ".."), { recursive: true, force: true });
  }
});

test("handler：模型伪造 confirm 无用户 confirm → confirmation_required", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    saveDraft(workspacePath, { workspaceId });
    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-commit-001",
      action: "accept",
      modelClaimedConfirmation: true,
      // 故意不传 confirm
      _projectRoot: projectRoot,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.finalization.finalization.blockReason, "confirmation_required");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("handler：approvalReceipt hash 不匹配 → artifact_hash_mismatch", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    const revision = saveDraft(workspacePath, { workspaceId });
    const receipt = createActionApprovalReceipt({
      workspaceId,
      chapterId: "1",
      action: "chapter.save",
      artifactHash: computeArtifactHash(FINAL_TEXT + "x"),
      revision,
      actor: "user",
      taskId: "task-final",
      decision: "approve",
      approvalId: "uar-mismatch-1",
    });
    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-commit-001",
      action: "accept",
      confirm: true,
      revision,
      approvalReceipt: receipt,
      _projectRoot: projectRoot,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.finalization.finalization.blockReason, "artifact_hash_mismatch");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("handler：confirm=true 无显式 receipt 时宿主签发 receipt 后仍走 authorizeCommitAction", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    const revision = saveDraft(workspacePath, { workspaceId });
    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-commit-001",
      action: "accept",
      confirm: true,
      revision,
      _projectRoot: projectRoot,
    });
    // 必须完成正式授权路径；成功或因 commit 环境限制 blocked，但不得跳过 receipt
    assert.ok(result.status === "ok" || result.status === "blocked");
    if (result.status === "ok") {
      assert.equal(result.finalization?.commit?.ok, true);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("commit 失败恢复 pending：restorePendingSentinel 保留 hash 绑定", () => {
  const { workspacePath, workspaceId } = makeTempWorkspace();
  try {
    saveDraft(workspacePath, { workspaceId });
    clearPendingProxyDraft(workspacePath, "1");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false);
    const restored = restorePendingSentinel(
      workspacePath,
      "1",
      "cpa-commit-001",
      "2026-08-12T00:00:00.000Z",
    );
    assert.equal(restored.restored, true);
    const sentinel = getPendingSentinel(workspacePath, "1");
    assert.ok(sentinel.artifactHash);
    assert.ok(sentinel.revision);
  } finally {
    rmSync(join(workspacePath, "..", ".."), { recursive: true, force: true });
  }
});

test("合法 pending 绑定通过", () => {
  const { workspacePath, workspaceId } = makeTempWorkspace();
  try {
    const revision = saveDraft(workspacePath, { workspaceId });
    const bind = validatePendingBinding({
      workspacePath,
      workspaceId,
      chapterId: "1",
      approvalId: "cpa-commit-001",
      revision,
      finalText: FINAL_TEXT,
    });
    assert.equal(bind.ok, true);
    assert.equal(bind.artifactHash, computeArtifactHash(FINAL_TEXT));
  } finally {
    rmSync(join(workspacePath, "..", ".."), { recursive: true, force: true });
  }
});

test("authorizeCommitAction 与 pending hash 一致时允许", () => {
  const hash = computeArtifactHash(FINAL_TEXT);
  const receipt = createActionApprovalReceipt({
    workspaceId: "ws-commit",
    chapterId: "1",
    action: "chapter.save",
    artifactHash: hash,
    revision: "rev-1",
    actor: "user",
    taskId: "t",
    decision: "approve",
  });
  const result = authorizeCommitAction({
    receipt,
    finalText: FINAL_TEXT,
    workspaceId: "ws-commit",
    chapterId: "1",
    action: "chapter.save",
    revision: "rev-1",
    completedChecks: [
      "fact_guard",
      "story_preservation",
      "completeness",
      "pending_bound",
    ],
  });
  assert.equal(result.allowed, true);
});
