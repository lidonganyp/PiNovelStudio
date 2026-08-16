/**
 * EVOLUTION-RELEASE-GOVERNANCE-G7 - 用户反馈接入策略证据与 release 健康报告测试（Slice 2）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §12.2 line 587
 *
 * 本测试覆盖 G7 Slice 2：
 * - chapter-proxy-approval-feedback-ingestor: 把 feedback.jsonl 中的用户决策记录
 *   转化为 UserFeedbackIngestor 能消费的 evidence，写入 strategy-policy.json
 * - release-health-aggregator: 归集所有 chapter 的反馈记录 + 策略信誉快照，
 *   生成 release 健康报告（只读，不写入）
 *
 * 反馈映射规则（计划 §12.2）：
 * - accept + proxyRecommendedSource=editorial -> ingestChoice(chosen=editorial) win
 * - accept + proxyRecommendedSource=raw      -> ingestChoice(chosen=raw) loss
 * - accept_with_edits                        -> ingestEdit(deliveredSource=editorial, modified=true)
 * - reject                                   -> ingestChoice(chosen=raw) loss
 * - rollback / inspect                       -> 跳过（post-hoc / 只读）
 *
 * 验证点：
 * 1. accept editorial -> strategy-policy.json 写入 win evidence
 * 2. accept raw       -> 写入 loss evidence
 * 3. accept_with_edits -> 写入 loss + editDistance + WEIGHT_USER_MODIFICATION
 * 4. reject           -> 写入 loss
 * 5. rollback / inspect -> 跳过，不写入
 * 6. 无 strategyId context -> 跳过，不写入
 * 7. 重复摄入去重 -> 第二次调用跳过已摄入 approvalId
 * 8. release-health-aggregator: 聚合 feedback + strategy 快照
 * 9. release-health-aggregator: 空 workspace -> 全零报告
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordProxyApprovalFeedback } from "../dist/v2/governance/chapter-proxy-approval-feedback-recorder.js";
import { loadStrategyPolicyStore, saveStrategyPolicyStore } from "../dist/v2/learning/strategy-policy-store.js";
import { ingestProxyApprovalFeedbackToStrategy, ingestAllProxyApprovalFeedback } from "../dist-test/v2/governance/chapter-proxy-approval-feedback-ingestor.js";
import { aggregateReleaseHealth } from "../dist-test/v2/governance/release-health-aggregator.js";

// ============================================================================
// helpers
// ============================================================================

function makeTempWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "g7-feedback-"));
  const workspaceId = "ws-test";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(workspacePath, { recursive: true });
  return { projectRoot, workspaceId, workspacePath };
}

function makeCompleteLineage(overrides = {}) {
  return {
    orchestratorRunId: "run-g7-1",
    candidateId: "cand-ed-1",
    strategyBundleId: "bundle:editorial-opportunity-v1",
    strategyId: "editorial-opportunity-v1",
    modelVersion: "doubao-seed-2-1-pro",
    promptBundleId: "prompt-g7-v1",
    exposureId: "exp-g7-1",
    feedbackEventId: "fb-g7-1",
    sourceChapter: "ch1",
    deliveredSource: "editorial",
    ...overrides,
  };
}

function makeFeedbackRecord(overrides = {}) {
  const { lineage, ...rest } = overrides;
  return {
    timestamp: "2026-07-17T00:00:00.000Z",
    approvalId: "cpa-fb-001",
    chapterId: "1",
    workspaceId: "ws-test",
    action: "accept",
    proxyJudgmentBias: {
      proxyRecommendedSource: "editorial",
      userAcceptedSource: "editorial",
      aligned: true,
    },
    // USER-FEEDBACK-EVIDENCE-PIPELINE-1：代理反馈默认带完整血缘才可强更新
    lineage: lineage === null ? undefined : makeCompleteLineage(lineage ?? {}),
    ...rest,
  };
}

/** 固定 StrategyContext 解析器：所有记录都映射到同一策略 */
function fixedContextResolver(strategyId = "editorial-opportunity-v1") {
  return () => ({
    sourceChapter: "ch1",
    modelVersion: "doubao-seed-2-1-pro",
    strategyId,
    opportunityType: "prose-polish",
  });
}

// ============================================================================
// 1. accept + editorial -> ingestChoice(chosen=editorial) -> win evidence
// ============================================================================

test("feedback-ingestor: accept editorial -> win evidence 写入 strategy-policy.json", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({
        approvalId: "cpa-fb-001",
        action: "accept",
        proxyJudgmentBias: {
          proxyRecommendedSource: "editorial",
          userAcceptedSource: "editorial",
          aligned: true,
        },
      }),
    });

    const result = ingestProxyApprovalFeedbackToStrategy({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver: fixedContextResolver(),
    });

    assert.equal(result.ingestedCount, 1, "应摄入 1 条");
    assert.equal(result.skippedCount, 0, "不应跳过");
    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0].outcome, "win", "accept editorial -> win");
    assert.equal(result.outcomes[0].source, "user");
    assert.equal(result.outcomes[0].recorded, true);

    // 写入 strategy-policy.json
    // USER-FEEDBACK-EVIDENCE-PIPELINE-1：
    //   weight=WEIGHT_USER_EXPLICIT=3 → alpha += 3
    //   sampleCount = decisionCount=1（不再把 weight 当样本数）
    const store = loadStrategyPolicyStore(workspaceId, projectRoot);
    const rep = store.getReputation("editorial-opportunity-v1", "doubao-seed-2-1-pro");
    assert.equal(rep.evidence.length, 1, "evidence 记录数应为 1");
    assert.equal(rep.evidence[0].outcome, "win");
    assert.equal(rep.evidence[0].source, "user");
    assert.equal(rep.alpha, 4, "win 后 alpha = 弱先验 1 + weight 3 = 4");
    assert.equal(rep.beta, 1, "beta 未增加");
    assert.equal(rep.sampleCount, 1, "sampleCount = decisionCount 1");
    assert.equal(rep.weightedEvidenceTotal, 3, "weightedEvidenceTotal = weight 3");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. accept + raw -> ingestChoice(chosen=raw) -> loss evidence
// ============================================================================

test("feedback-ingestor: accept raw -> loss evidence", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({
        approvalId: "cpa-fb-002",
        action: "accept",
        proxyJudgmentBias: {
          proxyRecommendedSource: "raw",
          userAcceptedSource: "raw",
          aligned: true,
        },
      }),
    });

    const result = ingestProxyApprovalFeedbackToStrategy({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver: fixedContextResolver(),
    });

    assert.equal(result.ingestedCount, 1);
    assert.equal(result.outcomes[0].outcome, "loss", "accept raw -> loss for editorial strategy");
    assert.equal(result.outcomes[0].weight, 3, "WEIGHT_USER_EXPLICIT=3");

    const store = loadStrategyPolicyStore(workspaceId, projectRoot);
    const rep = store.getReputation("editorial-opportunity-v1", "doubao-seed-2-1-pro");
    assert.equal(rep.evidence[0].outcome, "loss");
    // weight=WEIGHT_USER_EXPLICIT=3 -> beta = 1 + 3 = 4
    assert.equal(rep.beta, 4, "loss 后 beta = 弱先验 1 + weight 3 = 4");
    assert.equal(rep.consecutiveLosses, 1);
    assert.equal(rep.sampleCount, 1, "sampleCount = decisionCount 1");
    assert.equal(rep.weightedEvidenceTotal, 3, "weightedEvidenceTotal = weight 3");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. accept_with_edits -> ingestEdit(modified=true) -> loss evidence + editDistance
// ============================================================================

test("feedback-ingestor: accept_with_edits -> loss + editDistance", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({
        approvalId: "cpa-fb-003",
        action: "accept_with_edits",
        factGuardPassed: true,
        editedTextDiff: {
          originalLength: 100,
          editedLength: 130,
          lengthDelta: 30,
          same: false,
          diffSummary: "用户稿增加 30 字符",
        },
        proxyJudgmentBias: {
          proxyRecommendedSource: "editorial",
          userAcceptedSource: "user_edited",
          aligned: false,
        },
      }),
    });

    const result = ingestProxyApprovalFeedbackToStrategy({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver: fixedContextResolver(),
    });

    assert.equal(result.ingestedCount, 1);
    assert.equal(result.outcomes[0].outcome, "loss", "用户修改 editorial -> loss");
    // editDistance = lengthDelta / max(originalLength, 1) = 30 / 100 = 0.3 -> 触发 heavy edit
    assert.equal(result.outcomes[0].weight, 4, "WEIGHT_USER_MODIFICATION(3) + HEAVY_EDIT_BONUS(1) = 4");
    assert.equal(result.outcomes[0].decisionCount, 1, "decisionCount 恒为 1");

    const store = loadStrategyPolicyStore(workspaceId, projectRoot);
    const rep = store.getReputation("editorial-opportunity-v1", "doubao-seed-2-1-pro");
    assert.equal(rep.evidence[0].outcome, "loss");
    assert.equal(rep.evidence[0].weight, 4, "应有 heavy edit bonus 权重");
    assert.equal(rep.sampleCount, 1, "sampleCount = decisionCount，不因 weight=4 虚增");
    // note 可能是 heavy / structure / editType 描述，不再强制旧文案“重度修改”
    assert.ok(
      rep.evidence[0].note && rep.evidence[0].note.length > 0,
      `note 应有说明，实际：${rep.evidence[0].note}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. reject -> ingestChoice(chosen=raw) -> loss evidence
// ============================================================================

test("feedback-ingestor: reject -> loss evidence", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({
        approvalId: "cpa-fb-004",
        action: "reject",
        proxyJudgmentBias: {
          proxyRecommendedSource: "editorial",
          userAcceptedSource: "rejected",
          aligned: false,
        },
      }),
    });

    const result = ingestProxyApprovalFeedbackToStrategy({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver: fixedContextResolver(),
    });

    assert.equal(result.ingestedCount, 1);
    assert.equal(result.outcomes[0].outcome, "loss", "reject editorial -> loss");
    assert.equal(result.outcomes[0].weight, 3, "WEIGHT_USER_EXPLICIT=3");

    const store = loadStrategyPolicyStore(workspaceId, projectRoot);
    const rep = store.getReputation("editorial-opportunity-v1", "doubao-seed-2-1-pro");
    assert.equal(rep.evidence[0].outcome, "loss");
    assert.equal(rep.evidence[0].note, "用户明确选择 raw");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. rollback / inspect -> 跳过
// ============================================================================

test("feedback-ingestor: rollback / inspect -> 跳过，不写入策略信誉", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({
        approvalId: "cpa-fb-005a",
        action: "rollback",
        rollbackResult: { rolledBack: true, backupPath: "/tmp/backup" },
        proxyJudgmentBias: {
          proxyRecommendedSource: "editorial",
          userAcceptedSource: "editorial",
          aligned: true,
        },
      }),
    });
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({
        approvalId: "cpa-fb-005b",
        action: "inspect",
        proxyJudgmentBias: {
          proxyRecommendedSource: "editorial",
          userAcceptedSource: "editorial",
          aligned: true,
        },
      }),
    });

    const result = ingestProxyApprovalFeedbackToStrategy({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver: fixedContextResolver(),
    });

    assert.equal(result.ingestedCount, 0, "rollback/inspect 都应跳过");
    assert.equal(result.skippedCount, 2);
    assert.equal(result.outcomes.length, 0);

    // strategy-policy.json 不应被创建
    const store = loadStrategyPolicyStore(workspaceId, projectRoot);
    const rep = store.getReputation("editorial-opportunity-v1", "doubao-seed-2-1-pro");
    assert.equal(rep.sampleCount, 0, "不应有 evidence");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. 无 strategyId context -> 跳过
// ============================================================================

test("feedback-ingestor: contextResolver 返回 null -> 跳过", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({ approvalId: "cpa-fb-006" }),
    });

    const result = ingestProxyApprovalFeedbackToStrategy({
      workspacePath,
      workspaceId,
      projectRoot,
      // 返回 null 的 resolver：无策略上下文
      contextResolver: () => null,
    });

    assert.equal(result.ingestedCount, 0);
    assert.equal(result.skippedCount, 1);
    assert.equal(result.skippedReasons[0].reason, "no_strategy_context");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("feedback-ingestor: 缺失 lineage 的代理反馈不得强更新", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({
        approvalId: "cpa-fb-006b",
        lineage: null, // 明确缺失
      }),
    });

    const result = ingestProxyApprovalFeedbackToStrategy({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver: fixedContextResolver(),
    });

    assert.equal(result.ingestedCount, 0);
    assert.equal(result.skippedCount, 1);
    assert.equal(result.skippedReasons[0].reason, "incomplete_lineage");

    const store = loadStrategyPolicyStore(workspaceId, projectRoot);
    const rep = store.getReputation("editorial-opportunity-v1", "doubao-seed-2-1-pro");
    assert.equal(rep.sampleCount, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. 重复摄入去重 -> 第二次调用跳过已摄入 approvalId
// ============================================================================

test("feedback-ingestor: 重复摄入去重（alreadyIngestedApprovalIds）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({ approvalId: "cpa-fb-007" }),
    });

    // 第一次摄入
    const r1 = ingestProxyApprovalFeedbackToStrategy({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver: fixedContextResolver(),
    });
    assert.equal(r1.ingestedCount, 1);
    assert.equal(r1.ingestedApprovalIds[0], "cpa-fb-007");

    // 第二次摄入：传 alreadyIngestedApprovalIds 跳过
    const r2 = ingestProxyApprovalFeedbackToStrategy({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver: fixedContextResolver(),
      alreadyIngestedApprovalIds: new Set(r1.ingestedApprovalIds),
    });
    assert.equal(r2.ingestedCount, 0, "已摄入的 approvalId 应被跳过");
    assert.equal(r2.skippedCount, 1);
    assert.equal(r2.skippedReasons[0].reason, "already_ingested");

    // strategy-policy.json 不应有重复 evidence
    const store = loadStrategyPolicyStore(workspaceId, projectRoot);
    const rep = store.getReputation("editorial-opportunity-v1", "doubao-seed-2-1-pro");
    assert.equal(rep.evidence.length, 1, "evidence 记录不应重复");
    assert.equal(rep.sampleCount, 1, "sampleCount 保持 decisionCount=1，不重复");
    assert.equal(rep.weightedEvidenceTotal, 3, "weightedEvidenceTotal 保持 weight=3");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. ingestAllProxyApprovalFeedback: 多条记录批量摄入
// ============================================================================

test("feedback-ingestor: ingestAll 批量摄入多条记录（含 accept/reject/rollback 跳过）", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // 3 条 accept + 1 条 reject + 1 条 rollback
    for (const [i, action] of ["accept", "accept", "accept", "reject", "rollback"].entries()) {
      recordProxyApprovalFeedback({
        workspacePath,
        feedback: makeFeedbackRecord({
          approvalId: `cpa-fb-008-${i}`,
          chapterId: String(i + 1),
          action,
          lineage: makeCompleteLineage({
            feedbackEventId: `fb-g7-008-${i}`,
            exposureId: `exp-g7-008-${i}`,
            orchestratorRunId: `run-g7-008-${i}`,
          }),
          proxyJudgmentBias: {
            proxyRecommendedSource: "editorial",
            userAcceptedSource: action === "reject" ? "rejected" : "editorial",
            aligned: action !== "reject",
          },
        }),
      });
    }

    const result = ingestAllProxyApprovalFeedback({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver: fixedContextResolver(),
    });

    assert.equal(result.ingestedCount, 4, "3 accept + 1 reject = 4 摄入；rollback 跳过");
    assert.equal(result.skippedCount, 1, "rollback 跳过");

    // 每条 decisionCount=1，weight=3
    //   3 accept win  -> alpha += 9 -> alpha = 10
    //   1 reject loss -> beta  += 3 -> beta  = 4
    //   sampleCount = 4（决策数）
    //   weightedEvidenceTotal = 12
    const store = loadStrategyPolicyStore(workspaceId, projectRoot);
    const rep = store.getReputation("editorial-opportunity-v1", "doubao-seed-2-1-pro");
    assert.equal(rep.evidence.length, 4, "evidence 记录数 = 4");
    assert.equal(rep.sampleCount, 4, "sampleCount = 4 决策");
    assert.equal(rep.weightedEvidenceTotal, 12, "weightedEvidenceTotal = 4×3");
    assert.equal(rep.alpha, 10, "3 accept -> alpha = 1 + 9 = 10");
    assert.equal(rep.beta, 4, "1 reject -> beta = 1 + 3 = 4");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 9. release-health-aggregator: 聚合 feedback + 策略信誉快照
// ============================================================================

test("release-health-aggregator: 聚合 feedback + strategy 信誉快照", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    // 写入 4 条 feedback：2 accept editorial + 1 accept_with_edits + 1 reject
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({
        approvalId: "cpa-fb-009-1",
        action: "accept",
        lineage: makeCompleteLineage({ feedbackEventId: "fb-009-1", exposureId: "exp-009-1", orchestratorRunId: "run-009-1" }),
        proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "editorial", aligned: true },
      }),
    });
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({
        approvalId: "cpa-fb-009-2",
        chapterId: "2",
        action: "accept",
        lineage: makeCompleteLineage({ feedbackEventId: "fb-009-2", exposureId: "exp-009-2", orchestratorRunId: "run-009-2" }),
        proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "editorial", aligned: true },
      }),
    });
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({
        approvalId: "cpa-fb-009-3",
        chapterId: "3",
        action: "accept_with_edits",
        factGuardPassed: true,
        editedTextDiff: {
          originalLength: 100,
          editedLength: 140,
          lengthDelta: 40,
          same: false,
          diffSummary: "用户稿增加 40 字符",
        },
        lineage: makeCompleteLineage({ feedbackEventId: "fb-009-3", exposureId: "exp-009-3", orchestratorRunId: "run-009-3" }),
        proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "user_edited", aligned: false },
      }),
    });
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({
        approvalId: "cpa-fb-009-4",
        chapterId: "4",
        action: "reject",
        lineage: makeCompleteLineage({ feedbackEventId: "fb-009-4", exposureId: "exp-009-4", orchestratorRunId: "run-009-4" }),
        proxyJudgmentBias: { proxyRecommendedSource: "editorial", userAcceptedSource: "rejected", aligned: false },
      }),
    });

    // 先摄入到策略信誉，再聚合 release health
    ingestAllProxyApprovalFeedback({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver: fixedContextResolver(),
    });

    const report = aggregateReleaseHealth(workspacePath, { workspaceId, projectRoot });

    assert.equal(report.workspaceId, workspaceId);
    assert.equal(report.totalFeedbackRecords, 4, "4 条 feedback");
    assert.equal(report.actionBreakdown.accept, 2);
    assert.equal(report.actionBreakdown.accept_with_edits, 1);
    assert.equal(report.actionBreakdown.reject, 1);
    assert.equal(report.actionBreakdown.rollback, 0);
    assert.equal(report.actionBreakdown.inspect, 0);

    // alignment: 2 aligned (accept) + 2 misaligned (accept_with_edits + reject) = 0.5
    assert.equal(report.alignmentStats.aligned, 2);
    assert.equal(report.alignmentStats.misaligned, 2);
    assert.equal(report.alignmentStats.alignmentRate, 0.5);

    // edit stats: 1 edited approval, editDistance = 40/100 = 0.4 -> heavy
    assert.equal(report.editStats.editedApprovals, 1);
    assert.equal(report.editStats.averageEditDistance, 0.4);
    assert.equal(report.editStats.heavyEdits, 1, "editDistance=0.4 >= 0.3 应为 heavy");

    // FactGuard stats: 1 total, 1 passed, 0 blocked
    assert.equal(report.factGuardStats.total, 1);
    assert.equal(report.factGuardStats.passed, 1);
    assert.equal(report.factGuardStats.blocked, 0);
    assert.equal(report.factGuardStats.passRate, 1.0);

    // strategy reputations
    // decisionCount 语义：
    //   2 accept win -> alpha += 6 -> alpha = 7
    //   1 accept_with_edits loss (weight=4) + 1 reject loss (weight=3) -> beta = 8
    //   sampleCount = 4 决策
    //   weightedEvidenceTotal = 3+3+4+3 = 13
    //   winRate = (alpha-1)/weightedEvidenceTotal = 6/13
    assert.equal(report.strategyReputations.length, 1, "应有 1 个策略信誉快照");
    const rep = report.strategyReputations[0];
    assert.equal(rep.strategyId, "editorial-opportunity-v1");
    assert.equal(rep.modelVersion, "doubao-seed-2-1-pro");
    assert.equal(rep.sampleCount, 4, "sampleCount = 4 决策");
    assert.equal(rep.alpha, 7, "2 wins × weight 3 = 6 -> alpha = 1 + 6 = 7");
    assert.equal(rep.beta, 8, "1 heavy edit loss (4) + 1 reject loss (3) = 7 -> beta = 1 + 7 = 8");
    assert.equal(rep.winRate, 6 / 13, "winRate = (alpha-1)/weightedEvidenceTotal = 6/13");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 10. release-health-aggregator: 空 workspace -> 全零报告
// ============================================================================

test("release-health-aggregator: 空 workspace -> 全零报告", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    const report = aggregateReleaseHealth(workspacePath, { workspaceId, projectRoot });

    assert.equal(report.totalFeedbackRecords, 0);
    assert.equal(report.actionBreakdown.accept, 0);
    assert.equal(report.actionBreakdown.accept_with_edits, 0);
    assert.equal(report.actionBreakdown.reject, 0);
    assert.equal(report.alignmentStats.aligned, 0);
    assert.equal(report.alignmentStats.misaligned, 0);
    assert.equal(report.alignmentStats.alignmentRate, 0, "无数据时 alignmentRate 应为 0 而非 NaN");
    assert.equal(report.editStats.averageEditDistance, null, "无编辑记录时 averageEditDistance 应为 null");
    assert.equal(report.factGuardStats.passRate, null, "无 FactGuard 记录时 passRate 应为 null");
    assert.equal(report.strategyReputations.length, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 11. release-health-aggregator: 只读，不修改任何文件
// ============================================================================

test("release-health-aggregator: 只读，不修改 strategy-policy.json", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: makeFeedbackRecord({ approvalId: "cpa-fb-011" }),
    });
    ingestAllProxyApprovalFeedback({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver: fixedContextResolver(),
    });

    const policyPath = join(workspacePath, "strategy-policy.json");
    const before = readFileSync(policyPath, "utf-8");

    const report = aggregateReleaseHealth(workspacePath, { workspaceId, projectRoot });
    assert.ok(report.totalFeedbackRecords > 0);

    const after = readFileSync(policyPath, "utf-8");
    assert.equal(before, after, "aggregateReleaseHealth 不得修改 strategy-policy.json");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
