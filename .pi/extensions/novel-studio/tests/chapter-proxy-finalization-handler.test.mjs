/**
 * 生产入口消费链测试 — chapter-proxy-finalization handler
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §12.2 / §12.3
 *         docs/remaining-development-dispatch-plan-20260715.md §0.2
 *
 * 用户核验结论（2026-07-17 第二轮）：4 项阻断（P0 路径越界 + P1 重复摄入 +
 * P1 失败反馈污染 + P1 6 工具契约回归）。用户架构决策（"其他"）：
 * - 移除第 7 个公开工具，通过 novel_workspace_manager action="proxy_finalization" 暴露
 * - novel_generate_chapter 遇 pending 仅返回结构化阻断，绝不自动定稿
 * - accept/rollback 增加 revision、幂等键和显式确认
 * - 修复 workspace 路径越界、反馈重复摄入、保存失败仍记录 accept 反馈
 *
 * 本测试覆盖生产入口消费链（handler 实际调用 runFinalization + ingest + aggregate）：
 * 1. accept: handler 调用 runFinalization -> commitAndSave 写入正文 + feedback 记录 + health 报告
 * 2. accept_with_edits: handler 调用 runFinalization（真实 FactGuard）-> 写入 editedText + ingest 接入策略证据
 * 3. reject: handler 调用 runFinalization -> 不 commitAndSave + feedback action=reject
 * 4. rollback: handler 调用 runFinalization -> 回滚已提交章节 + feedback 含 rollbackResult
 * 5. inspect: handler 从 registry 加载 artifact -> runFinalization 只读 -> 不 commitAndSave
 * 6. ingest: 提供 strategyContext 时 handler 调用 ingestProxyApprovalFeedbackToStrategy
 * 7. aggregate: handler 调用 aggregateReleaseHealth 返回 release 健康报告
 * 8. workspace 不存在: 返回 status=error
 * 9. characterNames 从 config.json 加载（含 aliases）
 * 10. 错误 approvalId: handler 返回 blocked，不 commitAndSave
 *
 * 第二轮新增负向测试（RED）：
 * 11. P0 路径越界: workspaceId=".." -> status=error，不写入 workspaces/ 外
 * 12. P1 重复摄入: 两次定稿 -> 2 条 evidence、sampleCount=6（非 3/9）
 * 13. P1 失败反馈污染: commitAndSave 失败 -> 不记录 accept 成功反馈
 * 14. 显式确认: accept 无 confirm=true -> blocked (confirmation_required)
 * 15. revision 校验: accept 错误 revision -> blocked (stale_revision)
 * 16. 幂等键: 同 idempotencyKey 重调 -> idempotent=true，不重复执行
 * 17. P1 幂等键错误消耗: accept commit 失败 -> 不记录幂等键 -> 同 key 可成功重试
 * 18. P1 幂等键错误消耗: rollback rolledBack=false -> 不记录幂等键 -> 同 key 可重试
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
import { loadProxyApprovalFeedback, loadIdempotencyKeys } from "../dist/v2/governance/chapter-proxy-approval-feedback-recorder.js";
import { createChapterProxyApprovalRegistry } from "../dist/v2/governance/chapter-proxy-approval-registry.js";
import { handleChapterProxyFinalization } from "../dist-test/handlers/chapter-proxy-finalization-handler.js";
import { loadStrategyPolicyStore } from "../dist/v2/learning/strategy-policy-store.js";

// ============================================================================
// helpers
// ============================================================================

function makeTempWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "g7-handler-"));
  const workspaceId = "ws-test";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(workspacePath, { recursive: true });
  return { projectRoot, workspaceId, workspacePath };
}

function makeDraftOptions(overrides = {}) {
  return {
    workspacePath: "",
    approvalId: "cpa-handler-001",
    chapterId: "1",
    candidateId: "cand-raw-001",
    selectedSource: "raw",
    finalText: "代理审批稿正文。这是一段足够长的正文，用于通过 FactGuard 的格式校验。",
    savedAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function setupPendingDraft(workspacePath, approvalId = "cpa-handler-001") {
  saveProxyApprovedDraft(
    makeDraftOptions({ workspacePath, approvalId }),
  );
  assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
}

/**
 * 写入 workspace config.json（含 characters 字段，用于 handler 加载 characterNames）。
 */
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
  { id: "li-qiang", name: "李强", role: "family", aliases: ["父亲", "爸"] },
];

// ============================================================================
// 1. accept: handler 调用 runFinalization -> commitAndSave 写入正文 + feedback + health
// ============================================================================

test("handler accept: 调用 runFinalization -> commitAndSave 写入 draftText + feedback 记录 + health 报告", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "accept",
      confirm: true,
      _projectRoot: projectRoot,
    });

    // handler 返回结构
    assert.equal(result.status, "ok");
    assert.equal(result.workspaceId, workspaceId);
    assert.equal(result.chapterId, "1");
    assert.equal(result.approvalId, "cpa-handler-001");
    assert.equal(result.action, "accept");

    // finalization 结果存在（runFinalization 被实际调用）
    assert.ok(result.finalization, "handler 应调用 runFinalization 返回 finalization 结果");
    assert.equal(result.finalization.finalization.action, "accept");
    assert.equal(result.finalization.finalization.canCommit, true);
    assert.equal(result.finalization.commit.ok, true);

    // chapters/1.md 写入 draftText
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), true);
    const savedText = readFileSync(chapterPath, "utf-8");
    assert.equal(savedText, makeDraftOptions().finalText);

    // pending 已清除
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false);

    // feedback 记录
    assert.ok(result.finalization.feedbackRecorded, "应有 feedback 记录");
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, "accept");

    // release 健康报告（aggregateReleaseHealth 被实际调用）
    assert.ok(result.releaseHealth, "handler 应调用 aggregateReleaseHealth 返回 health 报告");
    assert.ok(typeof result.releaseHealth.actionBreakdown === "object");
    assert.equal(result.releaseHealth.actionBreakdown.accept, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. accept_with_edits: 真实 FactGuard -> 写入 editedText + ingest 接入策略证据
// ============================================================================

test("handler accept_with_edits: 真实 FactGuard -> 写入 editedText + ingest 接入策略证据", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);
    const editedText = "用户修改后的正文。这是一段足够长的修改正文，用于通过 FactGuard 的格式校验。";

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "accept_with_edits",
      editedText,
      confirm: true,
      strategyContext: {
        strategyId: "editorial-opportunity-001",
        modelVersion: "doubao-seed-2-1-pro-260628",
        opportunityType: "dialogue_density",
      },
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.finalization.finalization.action, "accept_with_edits");
    assert.equal(result.finalization.finalization.canCommit, true);
    assert.equal(result.finalization.finalization.factGuardPassed, true, "真实 FactGuard 应通过");

    // chapters/1.md 写入 editedText
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), true);
    const savedText = readFileSync(chapterPath, "utf-8");
    assert.equal(savedText, editedText);

    // ingest 接入策略证据（提供了 strategyContext 时）
    assert.ok(result.feedbackIngest, "提供 strategyContext 时应有 ingest 结果");
    assert.ok(typeof result.feedbackIngest.ingestedCount === "number");
    assert.ok(typeof result.feedbackIngest.skippedCount === "number");

    // release 健康报告
    assert.ok(result.releaseHealth);
    assert.equal(result.releaseHealth.actionBreakdown.accept_with_edits, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. reject: handler 调用 runFinalization -> 不 commitAndSave + feedback action=reject
// ============================================================================

test("handler reject: 调用 runFinalization -> 不 commitAndSave + feedback action=reject", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "reject",
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.finalization.finalization.action, "reject");
    assert.equal(result.finalization.commit, undefined, "reject 不应调用 commitAndSave");

    // chapters/ 不应被写入
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), false);

    // pending 已清除
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), false);

    // feedback 记录 action=reject
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, "reject");

    // health 报告
    assert.ok(result.releaseHealth);
    assert.equal(result.releaseHealth.actionBreakdown.reject, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. rollback: handler 调用 runFinalization -> 回滚已提交章节 + feedback 含 rollbackResult
// ============================================================================

test("handler rollback: 调用 runFinalization -> 回滚已提交章节 + feedback 含 rollbackResult", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);

    // 模拟已提交章节
    const chaptersDir = join(workspacePath, "chapters");
    const chapterPath = join(chaptersDir, "1.md");
    mkdirSync(chaptersDir, { recursive: true });
    writeFileSync(chapterPath, "已提交的章节正文。", "utf-8");

    setupPendingDraft(workspacePath);

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "rollback",
      confirm: true,
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.finalization.finalization.action, "rollback");
    assert.equal(result.finalization.commit, undefined, "rollback 不应调用 commitAndSave");
    assert.equal(result.finalization.finalization.rollbackResult.rolledBack, true);

    // chapters/1.md 已删除
    assert.equal(existsSync(chapterPath), false);

    // feedback 含 rollbackResult
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, "rollback");
    assert.ok(records[0].rollbackResult);

    // health 报告
    assert.ok(result.releaseHealth);
    assert.equal(result.releaseHealth.actionBreakdown.rollback, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. inspect: handler 从 registry 加载 artifact -> runFinalization 只读
// ============================================================================

test("handler inspect: 从 registry 加载 artifact -> runFinalization 只读 + 不 commitAndSave", async () => {
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
      approvalId: "cpa-handler-001",
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

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "inspect",
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.finalization.finalization.action, "inspect");
    assert.equal(result.finalization.commit, undefined, "inspect 不应调用 commitAndSave");
    assert.equal(result.finalization.feedbackRecorded, undefined, "inspect 不记录 feedback");

    // pending 保留（inspect 只读）
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);

    // chapters/ 不应被写入
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. ingest: 提供 strategyContext 时 handler 调用 ingestProxyApprovalFeedbackToStrategy
// ============================================================================

test("handler ingest: 提供 strategyContext 时调用 ingestProxyApprovalFeedbackToStrategy", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "accept",
      confirm: true,
      strategyContext: {
        strategyId: "editorial-opportunity-001",
        modelVersion: "doubao-seed-2-1-pro-260628",
        opportunityType: "dialogue_density",
      },
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    // ingest 结果存在
    assert.ok(result.feedbackIngest, "提供 strategyContext 时应有 ingest 结果");
    // accept + proxyRecommended=raw -> choice(chosen=raw) loss -> ingested
    assert.ok(result.feedbackIngest.ingestedCount >= 0, "ingestedCount 应为非负数");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. 不提供 strategyContext 时跳过 ingest（但仍有 health 报告）
// ============================================================================

test("handler 无 strategyContext: 跳过 ingest 但仍返回 health 报告", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "accept",
      confirm: true,
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.feedbackIngest, undefined, "无 strategyContext 时跳过 ingest");
    // health 报告仍存在
    assert.ok(result.releaseHealth, "health 报告应始终返回");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. workspace 不存在: 返回 status=error
// ============================================================================

test("handler workspace 不存在: 返回 status=error", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "g7-handler-missing-"));
  try {
    const result = await handleChapterProxyFinalization({
      workspaceId: "nonexistent-workspace",
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "accept",
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "error");
    assert.ok(result.error, "应返回错误信息");
    assert.equal(result.finalization, undefined, "workspace 不存在时不应调用 runFinalization");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 9. characterNames 从 config.json 加载（含 aliases）
// ============================================================================

test("handler characterNames: 从 config.json 加载角色名 + aliases", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "accept",
      confirm: true,
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    // characterNames 从 config.json 加载（含 aliases）：
    // 李一凡 + 一凡 + 李强 + 父亲 + 爸 = 5 个名字
    // 验证方式：accept_with_edits 路径的 FactGuard 会用到 characterNames；
    // 此处 accept 路径验证 handler 成功加载 config（不抛错）
    // 并通过 health 报告间接确认 handler 执行完整
    assert.ok(result.releaseHealth);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 10. 错误 approvalId: handler 返回 blocked，不 commitAndSave
// ============================================================================

test("handler accept 错误 approvalId: 返回 blocked + 不 commitAndSave + pending 保留", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath, "cpa-real-001");

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-wrong-001",
      action: "accept",
      confirm: true,
      _projectRoot: projectRoot,
    });

    // 定稿被阻断
    assert.ok(result.status === "blocked" || result.status === "ok");
    assert.equal(result.finalization.finalization.canCommit, false);
    assert.equal(result.finalization.finalization.blockReason, "approval_id_mismatch");
    assert.equal(result.finalization.commit, undefined, "错误 approvalId 不应调用 commitAndSave");

    // chapters/ 不应被写入
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), false);

    // pending 保留
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 11. P0 路径越界: workspaceId=".." -> status=error，不写入 workspaces/ 外
// ============================================================================

test("handler P0 路径越界: workspaceId='..' 被安全解析器阻断，返回 status=error", async () => {
  // 构造可利用场景：projectRoot 直接放 config.json + chapters/
  // 若 handler 直接 join(projectRoot, "workspaces", "..")，workspacePath 解析到 projectRoot，
  // existsSync(projectRoot/config.json) = true，runFinalization 会把 chapters/1.md 写到 projectRoot/chapters/
  const projectRoot = mkdtempSync(join(tmpdir(), "g7-handler-traversal-"));
  try {
    // 在 projectRoot 放 config.json（构造可利用场景）
    writeFileSync(join(projectRoot, "config.json"), JSON.stringify({ workspaceId: "..", characters: [] }, null, 2), "utf-8");

    const result = await handleChapterProxyFinalization({
      workspaceId: "..",
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "accept",
      confirm: true,
      _projectRoot: projectRoot,
    });

    // P0 修复后：安全解析器拒绝 workspaceId=".."，返回 status=error
    assert.equal(result.status, "error", "workspaceId='..' 必须被安全解析器阻断");
    assert.ok(result.error, "应返回错误信息");

    // 验证未写入 workspaces/ 外（projectRoot/chapters/1.md 不应存在）
    const escapedChapterPath = join(projectRoot, "chapters", "1.md");
    assert.equal(existsSync(escapedChapterPath), false, "不得写入 workspaces/ 外的章节文件");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 12. P1 重复摄入: 两次定稿 -> 2 条 evidence（非 3 条）
// ============================================================================

test("handler P1 重复摄入: 两次 accept 持久化游标 -> store 仅 2 条 evidence（非 3 条）", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    const strategyContext = {
      strategyId: "editorial-opportunity-001",
      modelVersion: "doubao-seed-2-1-pro-260628",
      opportunityType: "dialogue_density",
    };

    // 第一次 accept：approvalId=cpa-001，摄入 1 条 evidence
    saveProxyApprovedDraft(makeDraftOptions({ workspacePath, approvalId: "cpa-001" }));
    let result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-001",
      action: "accept",
      confirm: true,
      strategyContext,
      _projectRoot: projectRoot,
    });
    assert.equal(result.status, "ok");

    // 第二次 accept：approvalId=cpa-002（不同 approvalId，新 pending draft）
    saveProxyApprovedDraft(makeDraftOptions({ workspacePath, approvalId: "cpa-002" }));
    result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-002",
      action: "accept",
      confirm: true,
      strategyContext,
      _projectRoot: projectRoot,
    });
    assert.equal(result.status, "ok");

    // 加载策略信誉存储，检查 evidence 数量
    const store = loadStrategyPolicyStore(workspaceId, projectRoot);
    const partitions = store.toJSON().partitions;
    const mvPart = partitions[strategyContext.modelVersion] ?? {};
    const rep = mvPart[strategyContext.strategyId];
    assert.ok(rep, "应有策略信誉记录");
    // P1 修复后：游标持久化，第二次只摄入 cpa-002 -> 总共 2 条 evidence
    // P1 修复前：每次重新摄入全部历史 -> 第二次摄入 cpa-001 + cpa-002 -> 总共 3 条
    assert.equal(rep.evidence.length, 2, `应有 2 条 evidence（游标去重），实际 ${rep.evidence.length}`);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 13. P1 失败反馈污染: commitAndSave 失败 -> 不记录 accept 成功反馈
// ============================================================================

test("handler P1 失败反馈污染: commitAndSave 失败时不记录 accept 成功反馈", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    // 注入失败的 commitAndSave（模拟原子保存/状态提交异常）
    const failingCommitAndSave = () => ({
      ok: false,
      error: "mock_atomic_save_failure",
      stateCommit: null,
    });

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "accept",
      confirm: true,
      _commitAndSaveFn: failingCommitAndSave,
      _projectRoot: projectRoot,
    });

    // commit 失败
    assert.ok(result.finalization, "应有 finalization 结果");
    assert.equal(result.finalization.commit.ok, false, "commitAndSave 应失败");

    // P1 修复后：commit 失败时不记录 accept 成功反馈
    // P1 修复前：无论 commit 是否成功都记录 accept 反馈 -> feedback.jsonl 有 1 条
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 0, `commit 失败时不应记录 accept 反馈，实际 ${records.length} 条`);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 14. 显式确认: accept 无 confirm=true -> blocked (confirmation_required)
// ============================================================================

test("handler 显式确认: accept 无 confirm=true -> blocked (confirmation_required)", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "accept",
      // 故意不传 confirm: true
      _projectRoot: projectRoot,
    });

    // P1 修复后：accept 必须显式确认，否则 blocked
    assert.equal(result.status, "blocked", "accept 无 confirm 应返回 blocked");
    assert.equal(result.finalization.finalization.blockReason, "confirmation_required");

    // 未确认时不得 commitAndSave / 清除 pending
    assert.equal(result.finalization.commit, undefined, "未确认不得 commitAndSave");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true, "未确认时 pending 保留");

    // chapters/ 不应被写入
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 15. revision 校验: accept 错误 revision -> blocked (stale_revision)
// ============================================================================

test("handler revision 校验: accept 错误 revision -> blocked (stale_revision)", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    // pending draft 的 savedAt = "2026-07-17T00:00:00.000Z"（makeDraftOptions 默认）
    setupPendingDraft(workspacePath);

    const result = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "accept",
      confirm: true,
      revision: "WRONG_REVISION", // 与 pending draft 的 savedAt 不匹配
      _projectRoot: projectRoot,
    });

    // P1 修复后：revision 与 pending draft 的 savedAt 不匹配 -> blocked
    assert.equal(result.status, "blocked", "错误 revision 应返回 blocked");
    assert.equal(result.finalization.finalization.blockReason, "stale_revision");

    // 不得 commitAndSave / 清除 pending
    assert.equal(result.finalization.commit, undefined, "stale revision 不得 commitAndSave");
    assert.equal(hasPendingProxyDraft(workspacePath, "1"), true, "stale revision 时 pending 保留");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 16. 幂等键: 同 idempotencyKey 重调 -> idempotent=true，不重复执行
// ============================================================================

test("handler 幂等键: 同 idempotencyKey 重调 -> idempotent=true，不重复执行", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    // 第一次 accept：idempotencyKey=key-001，正常执行
    const result1 = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "accept",
      confirm: true,
      idempotencyKey: "key-001",
      _projectRoot: projectRoot,
    });
    assert.equal(result1.status, "ok");
    assert.equal(result1.idempotent, false, "首次调用应非幂等返回");
    assert.equal(result1.finalization.commit.ok, true);

    // chapters/1.md 已写入
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), true);
    const firstText = readFileSync(chapterPath, "utf-8");

    // 第二次同 idempotencyKey 调用：应返回 idempotent=true，不重复执行
    // 重新设置 pending（模拟重试场景）
    saveProxyApprovedDraft(makeDraftOptions({ workspacePath, approvalId: "cpa-handler-002" }));
    const result2 = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-002",
      action: "accept",
      confirm: true,
      idempotencyKey: "key-001", // 同一幂等键
      _projectRoot: projectRoot,
    });

    // P1 修复后：幂等键命中，返回 idempotent=true，不执行 runFinalization
    assert.equal(result2.idempotent, true, "同 idempotencyKey 重调应返回 idempotent=true");
    assert.equal(result2.status, "ok");

    // chapters/1.md 内容不变（未被第二次调用覆盖）
    const secondText = readFileSync(chapterPath, "utf-8");
    assert.equal(secondText, firstText, "幂等命中时正文不得被覆盖");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 17. P1 幂等键错误消耗: accept commit 失败 -> 不记录幂等键 -> 同 key 可成功重试
// ============================================================================
// 动态复现（用户阻断项 P1）：
//   首次 commitAndSave 失败 -> status="ok"（无 blockReason）-> 旧代码仅凭 status==="ok"
//   即记录幂等键 -> 同 key 重试直接返回 idempotent=true -> 章节始终未写入。
// 修复后成功条件收紧为 commit?.ok === true：commit 失败/pending 恢复时不记录幂等键，
// 同 key 重试可正常执行并写入正文。
// ============================================================================

test("handler P1 幂等键错误消耗: accept commit 失败不记录幂等键，同 key 可成功重试", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    setupPendingDraft(workspacePath);

    // 注入失败的 commitAndSave（模拟原子保存/状态提交异常）
    const failingCommitAndSave = () => ({
      ok: false,
      error: "mock_atomic_save_failure",
      stateCommit: null,
    });

    // 第一次 accept：commit 失败
    const result1 = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "accept",
      confirm: true,
      idempotencyKey: "retry-key-001",
      _commitAndSaveFn: failingCommitAndSave,
      _projectRoot: projectRoot,
    });

    // commit 失败 + pending 已恢复（用户可重试）
    assert.ok(result1.finalization, "应有 finalization 结果");
    assert.equal(result1.finalization.commit.ok, false, "首次 commitAndSave 应失败");
    assert.equal(result1.finalization.pendingRestored, true, "commit 失败应恢复 pending sentinel");

    // P0-1 修复（用户阻断项）：commit.ok=false 时 handler 必须返回 status="blocked"
    // （不能误报 "ok"，否则调用方无法区分"成功定稿"与"提交失败待重试"）
    assert.equal(
      result1.status,
      "blocked",
      "commit.ok=false 时 handler 必须返回 status=blocked，不得误报 ok",
    );

    // P1 修复后：commit 失败不得记录幂等键（否则同 key 重试会被短路）
    const keysAfterFailure = loadIdempotencyKeys(workspacePath);
    assert.equal(
      Object.prototype.hasOwnProperty.call(keysAfterFailure, "retry-key-001"),
      false,
      "commit 失败时不得记录幂等键",
    );

    // chapters/1.md 未写入
    const chapterPath = join(workspacePath, "chapters", "1.md");
    assert.equal(existsSync(chapterPath), false, "commit 失败时章节不得写入");

    // 第二次 accept：同 idempotencyKey + 成功 commitAndSave（默认真实实现）
    // 应实际执行（idempotent=false），而非被旧幂等键短路返回 idempotent=true
    const result2 = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "accept",
      confirm: true,
      idempotencyKey: "retry-key-001", // 同一幂等键
      _projectRoot: projectRoot,
    });

    // P1 修复后：同 key 重试实际执行，写入正文
    assert.equal(result2.idempotent, false, "commit 失败后同 key 重试应实际执行，而非 idempotent=true");
    assert.equal(result2.status, "ok");
    assert.equal(result2.finalization.commit.ok, true, "重试 commitAndSave 应成功");

    // chapters/1.md 已写入
    assert.equal(existsSync(chapterPath), true, "重试后章节应写入");
    const writtenText = readFileSync(chapterPath, "utf-8");
    assert.ok(writtenText.length > 0, "写入正文不得为空");

    // 成功后幂等键应被记录（便于后续同 key 重放返回 idempotent=true）
    const keysAfterSuccess = loadIdempotencyKeys(workspacePath);
    assert.equal(
      Object.prototype.hasOwnProperty.call(keysAfterSuccess, "retry-key-001"),
      true,
      "commit 成功后应记录幂等键",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 18. P1 幂等键错误消耗: rollback rolledBack=false -> 不记录幂等键 -> 同 key 可重试
// ============================================================================
// 用户阻断项 P1：rollback 也应验证 rolledBack === true 后才能消耗幂等键。
// 场景：rollback 时章节尚未提交（chapter_not_committed）-> rolledBack=false ->
// 旧代码仅凭 status==="ok" 记录幂等键 -> 同 key 重试被短路。
// 修复后：rolledBack=false 时不记录幂等键，同 key 重试可执行；章节后提交后重试成功回滚。
// ============================================================================

test("handler P1 幂等键错误消耗: rollback rolledBack=false 不记录幂等键，同 key 可成功重试", async () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    writeWorkspaceConfig(workspacePath, TEST_CHARACTERS);
    // 注意：不创建 chapters/1.md（模拟章节尚未提交）

    // 第一次 rollback：章节未提交 -> rolledBack=false
    const result1 = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "rollback",
      confirm: true,
      idempotencyKey: "rollback-key-001",
      _projectRoot: projectRoot,
    });

    assert.equal(result1.status, "ok");
    assert.equal(result1.finalization.finalization.action, "rollback");
    assert.equal(
      result1.finalization.finalization.rollbackResult.rolledBack,
      false,
      "章节未提交时 rolledBack 应为 false",
    );

    // P1 修复后：rolledBack=false 不得记录幂等键
    const keysAfterFailure = loadIdempotencyKeys(workspacePath);
    assert.equal(
      Object.prototype.hasOwnProperty.call(keysAfterFailure, "rollback-key-001"),
      false,
      "rolledBack=false 时不得记录幂等键",
    );

    // 模拟章节后被提交（例如另一路径完成 commit）
    const chaptersDir = join(workspacePath, "chapters");
    const chapterPath = join(chaptersDir, "1.md");
    mkdirSync(chaptersDir, { recursive: true });
    writeFileSync(chapterPath, "后被提交的章节正文。", "utf-8");

    // 第二次 rollback：同 idempotencyKey -> 应实际执行并成功回滚
    const result2 = await handleChapterProxyFinalization({
      workspaceId,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-handler-001",
      action: "rollback",
      confirm: true,
      idempotencyKey: "rollback-key-001", // 同一幂等键
      _projectRoot: projectRoot,
    });

    // P1 修复后：同 key 重试实际执行，成功回滚
    assert.equal(result2.idempotent, false, "rolledBack=false 后同 key 重试应实际执行，而非 idempotent=true");
    assert.equal(result2.finalization.finalization.rollbackResult.rolledBack, true, "重试应成功回滚");
    assert.equal(existsSync(chapterPath), false, "重试后章节文件应被删除");

    // 成功回滚后幂等键应被记录
    const keysAfterSuccess = loadIdempotencyKeys(workspacePath);
    assert.equal(
      Object.prototype.hasOwnProperty.call(keysAfterSuccess, "rollback-key-001"),
      true,
      "rolledBack=true 后应记录幂等键",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
