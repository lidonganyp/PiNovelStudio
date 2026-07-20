/**
 * EVOLUTION-RELEASE-GOVERNANCE-G7 - 反馈摄入/健康归集生产触发时机测试（Finalization Trigger）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §12.2
 *        docs/remaining-development-dispatch-plan-20260715.md §0.2
 *
 * 本测试覆盖生产触发时机接线的核心契约（计划 §0.2 objective）：
 * 使内部调用链从"可被 handler 调用"升级为"生产自动触发"。
 *
 * 触发时机设计（模块 header 详述）：
 * - 用户定稿完成（accept/accept_with_edits/reject/rollback）
 *   -> triggerFinalizationWithFeedbackAndHealth
 *   -> runFinalization（记录 feedback.jsonl）
 *   -> ingestProxyApprovalFeedbackToStrategy（提供 strategyContext 时）
 *   -> aggregateReleaseHealth（始终）
 * - 章节交付 / 定时聚合 -> 直接调用 aggregateReleaseHealth（只读幂等，无需 ingest）
 *
 * 验证点：
 * 1. triggerFinalizationWithFeedbackAndHealth 是 function（模块导出存在）
 * 2. accept + strategyContext: finalization.canCommit=true + commit.ok=true
 *    + feedbackIngest 存在且 ingestedCount>=1 + releaseHealth 存在且 totalFeedbackRecords>=1
 * 3. accept 无 strategyContext: finalization.canCommit=true + feedbackIngest=undefined + releaseHealth 存在
 * 4. reject + strategyContext: finalization.canCommit=false + feedbackIngest 存在且 ingestedCount>=1
 *    （reject -> choice(raw) -> loss）+ releaseHealth.actionBreakdown.reject>=1
 * 5. inspect + approvalArtifact + strategyContext: finalization.action="inspect" + canCommit=false
 *    + inspectSummary 存在 + feedbackIngest 存在且 ingestedCount=0（inspect 不记录 feedback）
 *    + releaseHealth.totalFeedbackRecords=0
 * 6. 调用顺序保证：accept + strategyContext 在全新 workspace -> feedbackIngest.ingestedCount===1
 *    （runFinalization 先记录 feedback，ingest 后看到该记录；若顺序反转 ingest 会看到 0 条）
 * 7. runFinalization 抛错（inspect 无 approvalArtifact）-> trigger 传播异常
 *    + strategy-policy.json 未创建（ingest 未运行）
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
import { strategyPolicyPath } from "../dist/v2/learning/strategy-policy-store.js";
// RED 阶段：trigger 模块尚未实现，此 import 会失败（ERR_MODULE_NOT_FOUND），
// 导致整个测试文件 RED。GREEN 阶段实现模块 + 纳入 test-modules barrel 后通过。
import {
  triggerFinalizationWithFeedbackAndHealth,
} from "../dist-test/v2/governance/chapter-proxy-approval-finalization-trigger.js";

// ============================================================================
// helpers
// ============================================================================

function makeTempWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "g7-final-trigger-"));
  const workspaceId = "ws-test";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(workspacePath, { recursive: true });
  return { projectRoot, workspaceId, workspacePath };
}

function makeDraftOptions(overrides = {}) {
  return {
    workspacePath: "",
    approvalId: "cpa-trigger-001",
    chapterId: "1",
    candidateId: "cand-ed-001",
    selectedSource: "editorial",
    finalText: "代理审批稿正文。这是一段足够长的正文，用于通过 FactGuard 的格式校验。",
    savedAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * 最小 UnifiedOrchestratorInput（与 finalization-entry 测试同形态）。
 * commitAndSave + checkCandidateFactGuard 在 finalization 路径下只消费这些字段。
 */
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
    characterNames: ["李明"],
    stagedStateUpdate: null,
  };
}

function setupPendingDraft(workspacePath, overrides = {}) {
  saveProxyApprovedDraft(makeDraftOptions({ workspacePath, ...overrides }));
  assert.equal(hasPendingProxyDraft(workspacePath, "1"), true);
}

/**
 * 构造 ChapterProxyApprovalArtifact fixture（inspect 入口测试用）。
 * 字段对齐 v2/governance/chapter-proxy-approval-types.ts ChapterProxyApprovalArtifact。
 */
function makeApproval(overrides = {}) {
  return {
    schemaId: "pinovel.chapter-proxy-approval",
    schemaVersion: 1,
    approvalId: "cpa-trigger-001",
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
    recommendedCandidateId: "cand-ed-001",
    recommendedSource: "editorial",
    winningSpans: ["span-B-0-10"],
    losingSpans: ["span-A-0-8"],
    risks: ["raw 叙事推进偏弱"],
    rationale: "editorial 对白密度与节奏更稳。",
    reviewerType: "validated_human_proxy",
    reviewerModel: "gpt5.6-sol",
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    promptHash: "hash-prompt-001",
    inputArtifactHash: "hash-input-001",
    decidedAt: "2026-07-17T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 60000 },
    ...overrides,
  };
}

const STRATEGY_CONTEXT = {
  strategyId: "editorial-opportunity-v1",
  modelVersion: "glm-5.2",
  opportunityType: "dialogue-density",
};

// ============================================================================
// 1. 模块导出存在
// ============================================================================

test("trigger 模块导出 triggerFinalizationWithFeedbackAndHealth 函数", () => {
  assert.equal(typeof triggerFinalizationWithFeedbackAndHealth, "function");
});

// ============================================================================
// 2. accept + strategyContext -> finalization 成功 + ingest + health 全触发
// ============================================================================

test("trigger accept + strategyContext: canCommit=true + commit.ok + ingest ingestedCount>=1 + health totalFeedbackRecords>=1", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");

    const result = triggerFinalizationWithFeedbackAndHealth({
      workspacePath,
      workspaceId,
      projectRoot,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-trigger-001",
      action: "accept",
      orchestratorInput,
      strategyContext: STRATEGY_CONTEXT,
    });

    // finalization 成功
    assert.equal(result.finalization.finalization.action, "accept");
    assert.equal(result.finalization.finalization.canCommit, true);
    assert.equal(result.finalization.commit.ok, true, "accept 应通过 commitAndSave");

    // ingest 触发：accept + editorial -> choice(editorial) -> win -> ingestedCount>=1
    assert.ok(result.feedbackIngest, "提供 strategyContext 时应有 feedbackIngest");
    assert.ok(
      result.feedbackIngest.ingestedCount >= 1,
      `ingest 应摄入至少 1 条（accept editorial win），实际 ${result.feedbackIngest.ingestedCount}`,
    );

    // health 触发：totalFeedbackRecords>=1 + actionBreakdown.accept>=1
    assert.ok(result.releaseHealth, "始终应有 releaseHealth");
    assert.ok(
      result.releaseHealth.totalFeedbackRecords >= 1,
      `health 应看到至少 1 条 feedback，实际 ${result.releaseHealth.totalFeedbackRecords}`,
    );
    assert.ok(
      result.releaseHealth.actionBreakdown.accept >= 1,
      `actionBreakdown.accept>=1，实际 ${result.releaseHealth.actionBreakdown.accept}`,
    );
    assert.equal(result.releaseHealth.workspaceId, workspaceId);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. accept 无 strategyContext -> finalization 成功 + feedbackIngest=undefined + health 仍存在
// ============================================================================

test("trigger accept 无 strategyContext: feedbackIngest=undefined + releaseHealth 仍存在", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");

    const result = triggerFinalizationWithFeedbackAndHealth({
      workspacePath,
      workspaceId,
      projectRoot,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-trigger-001",
      action: "accept",
      orchestratorInput,
      // 不提供 strategyContext
    });

    assert.equal(result.finalization.finalization.canCommit, true);
    assert.equal(result.finalization.commit.ok, true);
    assert.equal(result.feedbackIngest, undefined, "无 strategyContext 时 feedbackIngest 应为 undefined");
    assert.ok(result.releaseHealth, "无 strategyContext 时 releaseHealth 仍应存在");
    assert.ok(result.releaseHealth.totalFeedbackRecords >= 1, "health 仍应聚合 feedback");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. reject + strategyContext -> finalization canCommit=false + ingest + health
// ============================================================================

test("trigger reject + strategyContext: canCommit=false + ingest ingestedCount>=1 + health actionBreakdown.reject>=1", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");

    const result = triggerFinalizationWithFeedbackAndHealth({
      workspacePath,
      workspaceId,
      projectRoot,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-trigger-001",
      action: "reject",
      orchestratorInput,
      strategyContext: STRATEGY_CONTEXT,
    });

    // reject: canCommit=false, 不调用 commitAndSave
    assert.equal(result.finalization.finalization.action, "reject");
    assert.equal(result.finalization.finalization.canCommit, false);
    assert.equal(result.finalization.commit, undefined, "reject 不应调用 commitAndSave");

    // ingest 触发：reject -> choice(raw) -> loss -> ingestedCount>=1
    assert.ok(result.feedbackIngest, "reject + strategyContext 应有 feedbackIngest");
    assert.ok(
      result.feedbackIngest.ingestedCount >= 1,
      `reject 应摄入至少 1 条（choice raw loss），实际 ${result.feedbackIngest.ingestedCount}`,
    );

    // health: actionBreakdown.reject>=1
    assert.ok(result.releaseHealth);
    assert.ok(
      result.releaseHealth.actionBreakdown.reject >= 1,
      `actionBreakdown.reject>=1，实际 ${result.releaseHealth.actionBreakdown.reject}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. inspect + approvalArtifact + strategyContext -> 只读 + ingest ingestedCount=0 + health totalFeedbackRecords=0
// ============================================================================

test("trigger inspect + approvalArtifact + strategyContext: canCommit=false + inspectSummary + ingest ingestedCount=0 + health totalFeedbackRecords=0", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // inspect 是只读，不记录 feedback；全新 workspace 无 feedback.jsonl
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");
    const approvalArtifact = makeApproval();

    const result = triggerFinalizationWithFeedbackAndHealth({
      workspacePath,
      workspaceId,
      projectRoot,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-trigger-001",
      action: "inspect",
      orchestratorInput,
      approvalArtifact,
      strategyContext: STRATEGY_CONTEXT,
    });

    // inspect: 只读，canCommit=false，inspectSummary 存在
    assert.equal(result.finalization.finalization.action, "inspect");
    assert.equal(result.finalization.finalization.canCommit, false);
    assert.ok(result.finalization.finalization.inspectSummary, "应有 inspectSummary");
    assert.equal(result.finalization.commit, undefined, "inspect 不应调用 commitAndSave");

    // inspect 不记录 feedback -> ingest 看不到新记录 -> ingestedCount=0
    assert.ok(result.feedbackIngest, "提供 strategyContext 时 inspect 仍应调用 ingest（消费历史）");
    assert.equal(
      result.feedbackIngest.ingestedCount,
      0,
      `inspect 不记录 feedback，ingest 应摄入 0 条，实际 ${result.feedbackIngest.ingestedCount}`,
    );

    // health: 全新 workspace 无 feedback -> totalFeedbackRecords=0
    assert.ok(result.releaseHealth);
    assert.equal(
      result.releaseHealth.totalFeedbackRecords,
      0,
      `inspect 不产生 feedback，health totalFeedbackRecords 应为 0，实际 ${result.releaseHealth.totalFeedbackRecords}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. 调用顺序保证：accept + strategyContext 在全新 workspace -> ingestedCount===1
//    （runFinalization 先记录 feedback，ingest 后看到该记录；若顺序反转 ingest 看到 0 条）
// ============================================================================

test("trigger 调用顺序: accept + strategyContext 全新 workspace -> ingestedCount===1（证明 runFinalization 先于 ingest）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    setupPendingDraft(workspacePath);
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");

    const result = triggerFinalizationWithFeedbackAndHealth({
      workspacePath,
      workspaceId,
      projectRoot,
      chapterId: "1",
      chapterNumber: 1,
      approvalId: "cpa-trigger-001",
      action: "accept",
      orchestratorInput,
      strategyContext: STRATEGY_CONTEXT,
    });

    // 全新 workspace：runFinalization 记录 1 条 feedback，ingest 摄入该 1 条
    // 若 ingest 先于 runFinalization 运行，ingest 会看到 0 条 feedback.jsonl 记录
    assert.equal(
      result.feedbackIngest.ingestedCount,
      1,
      `ingest 应恰好摄入 1 条（runFinalization 新记录），实际 ${result.feedbackIngest.ingestedCount}`,
    );

    // 同时确认 feedback.jsonl 恰好 1 条（runFinalization 记录）
    const records = loadProxyApprovalFeedback(workspacePath);
    assert.equal(records.length, 1, "feedback.jsonl 应恰好 1 条");
    assert.equal(records[0].action, "accept");

    // 同时确认 strategy-policy.json 已被 ingest 写入
    const storePath = strategyPolicyPath(workspaceId, projectRoot);
    assert.equal(existsSync(storePath), true, "ingest 应写入 strategy-policy.json");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. runFinalization 抛错（inspect 无 approvalArtifact）-> trigger 传播异常 + ingest 未运行
// ============================================================================

test("trigger runFinalization 抛错（inspect 无 approvalArtifact）: 传播异常 + strategy-policy.json 未创建", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    const orchestratorInput = makeMinimalOrchestratorInput(projectRoot, workspaceId, "1");

    // inspect 未提供 approvalArtifact -> runFinalization 抛错
    assert.throws(
      () =>
        triggerFinalizationWithFeedbackAndHealth({
          workspacePath,
          workspaceId,
          projectRoot,
          chapterId: "1",
          chapterNumber: 1,
          approvalId: "cpa-trigger-001",
          action: "inspect",
          orchestratorInput,
          // 故意不提供 approvalArtifact
          strategyContext: STRATEGY_CONTEXT,
        }),
      /inspect 动作需要 approvalArtifact/,
    );

    // runFinalization 抛错 -> trigger 短路，ingest 未运行 -> strategy-policy.json 未创建
    const storePath = strategyPolicyPath(workspaceId, projectRoot);
    assert.equal(
      existsSync(storePath),
      false,
      "runFinalization 抛错时 ingest 不应运行，strategy-policy.json 不应被创建",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
