/**
 * USER-FEEDBACK-EVIDENCE-PIPELINE-1 — 生产账本接入 + 完整 exposure 字段
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordProxyApprovalFeedback } from "../dist/v2/governance/chapter-proxy-approval-feedback-recorder.js";
import { ingestProxyApprovalFeedbackToStrategy } from "../dist/v2/governance/chapter-proxy-approval-feedback-ingestor.js";
import {
  loadFeedbackEvidenceLedger,
  feedbackEvidenceLedgerPath,
} from "../dist/v2/learning/feedback-evidence-ledger-store.js";
import { buildStrategyBundleId } from "../dist/v2/learning/feedback-evidence-contracts.js";
import { selectAuthorStyleStrategies } from "../dist/v2/learning/author-style-strategy-registry.js";
import { createStrategyPolicyStore } from "../dist/v2/learning/strategy-policy-store.js";

function makeTempWorkspace() {
  const projectRoot = mkdtempSync(join(tmpdir(), "fb-ledger-"));
  const workspaceId = "ws-ledger";
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(workspacePath, { recursive: true });
  return { projectRoot, workspaceId, workspacePath };
}

const COMPLETE_LINEAGE = {
  orchestratorRunId: "run-prod-1",
  candidateId: "cand-ed-1",
  strategyBundleId: "bundle:editorial-opportunity-v1",
  strategyId: "editorial-opportunity-v1",
  modelVersion: "doubao-seed-2-1-pro",
  promptBundleId: "prompt-prod-v1",
  exposureId: "exp-prod-1",
  feedbackEventId: "fb-prod-1",
  sourceChapter: "ch1",
  deliveredSource: "editorial",
};

test("生产代理反馈摄入同时写入 feedback-evidence-ledger.json", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: {
        timestamp: "2026-08-12T00:00:00.000Z",
        approvalId: "cpa-ledger-001",
        chapterId: "1",
        workspaceId,
        action: "accept",
        proxyJudgmentBias: {
          proxyRecommendedSource: "editorial",
          userAcceptedSource: "editorial",
          aligned: true,
        },
        lineage: COMPLETE_LINEAGE,
      },
    });

    const result = ingestProxyApprovalFeedbackToStrategy({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver: () => ({
        sourceChapter: "ch1",
        modelVersion: "doubao-seed-2-1-pro",
        strategyId: "editorial-opportunity-v1",
        opportunityType: "prose-polish",
      }),
    });

    assert.equal(result.ingestedCount, 1);

    const ledgerPath = feedbackEvidenceLedgerPath(workspaceId, projectRoot);
    assert.ok(existsSync(ledgerPath), "ledger 文件应存在");

    const artifact = loadFeedbackEvidenceLedger(workspaceId, projectRoot);
    assert.equal(artifact.schemaId, "pinovel.feedback-evidence-ledger");
    assert.equal(artifact.events.length, 1);
    assert.equal(artifact.events[0].eventType, "observation");
    assert.equal(artifact.events[0].feedbackLevel, "proxy_confirmed");
    assert.equal(artifact.events[0].lineage.orchestratorRunId, "run-prod-1");
    assert.equal(artifact.events[0].lineage.exposureId, "exp-prod-1");
    assert.equal(artifact.events[0].lineage.promptBundleId, "prompt-prod-v1");
    assert.equal(artifact.events[0].strategyBundleId, "bundle:editorial-opportunity-v1");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("selectAuthorStyleStrategies 透传 exposureSnapshot 到上层", () => {
  const store = createStrategyPolicyStore("ws-exp");
  store.setStatus("guidance_reduction", "m1", "active", "admitted");
  store.putReputation({
    strategyId: "guidance_reduction",
    modelVersion: "m1",
    alpha: 20,
    beta: 1,
    sampleCount: 19,
    consecutiveLosses: 0,
    status: "active",
    evidence: [],
    lastUpdated: new Date().toISOString(),
  });

  const selection = selectAuthorStyleStrategies({
    modelVersion: "m1",
    policyStore: store,
    seed: 11,
  });

  assert.ok(selection.exposureSnapshot);
  assert.equal(
    selection.exposureSnapshot.selectedCount,
    selection.selected.length,
  );
  assert.deepEqual(
    selection.exposureSnapshot.strategyIds,
    selection.selected.map((s) => s.strategyId),
  );
  if (selection.selected.length > 0) {
    assert.equal(
      selection.exposureSnapshot.strategyBundleId,
      buildStrategyBundleId(selection.exposureSnapshot.strategyIds),
    );
  }
});

test("缺失 lineage 不写 ledger 也不写 policy", () => {
  const { projectRoot, workspaceId, workspacePath } = makeTempWorkspace();
  try {
    recordProxyApprovalFeedback({
      workspacePath,
      feedback: {
        timestamp: "2026-08-12T00:00:00.000Z",
        approvalId: "cpa-ledger-002",
        chapterId: "1",
        workspaceId,
        action: "accept",
        proxyJudgmentBias: {
          proxyRecommendedSource: "editorial",
          userAcceptedSource: "editorial",
          aligned: true,
        },
        // 无 lineage
      },
    });

    const result = ingestProxyApprovalFeedbackToStrategy({
      workspacePath,
      workspaceId,
      projectRoot,
      contextResolver: () => ({
        sourceChapter: "ch1",
        modelVersion: "doubao-seed-2-1-pro",
        strategyId: "editorial-opportunity-v1",
        opportunityType: "prose-polish",
      }),
    });

    assert.equal(result.ingestedCount, 0);
    assert.equal(result.skippedReasons[0].reason, "incomplete_lineage");
    assert.equal(
      loadFeedbackEvidenceLedger(workspaceId, projectRoot).events.length,
      0,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
