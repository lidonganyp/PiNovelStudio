/**
 * RUN-LIFECYCLE P6 tail — evidence_revoked → 学习投影重算
 *
 * 覆盖计划 §4.3「Learning：evidenceIds[] 有效集；撤销写 evidence_revoked，不删原始反馈」
 * 与 §2.1「Strategy policy = Learning 投影（evidenceId 可撤销）」的统一接线：
 *   1. 治理撤销写 RunAggregate 审计事件 evidence_revoked
 *   2. 向 feedback-evidence-ledger 追加 revoke（原始 observation 保留）
 *   3. 从 ledger 重建 strategy-policy.json（孤儿策略回弱先验）
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  revokeEvidenceWithLearningRecompute,
  createRunAggregateRepository,
  AuditEventStore,
  createRunId,
  createTraceId,
} from "../dist/v2/core/unified-entry.js";
import {
  appendFeedbackEvidenceEvents,
  loadFeedbackEvidenceLedger,
  loadStrategyPolicyStore,
  saveStrategyPolicyStore,
  materializePolicyFromFeedbackLedger,
  createStrategyPolicyStore,
  WEAK_PRIOR_ALPHA,
} from "../dist/v2/learning/strategy-policy-store.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "run-life-bridge-"));
}

function observation(id, strategyId, outcome, weight, timestamp) {
  return {
    eventType: "observation",
    evidenceId: id,
    feedbackLevel: "explicit_direct",
    outcome,
    decisionCount: 1,
    weightedEvidence: weight,
    attributionConfidence: "high",
    lineage: {
      orchestratorRunId: "run-1",
      candidateId: "c1",
      strategyBundleId: `bundle:${strategyId}`,
      strategyId,
      modelVersion: "m1",
      promptBundleId: "p1",
      deliveredSource: "editorial",
      exposureId: "e1",
      feedbackEventId: id,
      sourceChapter: "ch1",
    },
    strategyBundleId: `bundle:${strategyId}`,
    strategyIds: [strategyId],
    strategyId,
    modelVersion: "m1",
    sourceChapter: "ch1",
    source: "user",
    timestamp,
  };
}

function makeRun(root, workspaceId) {
  const runId = createRunId();
  const traceId = createTraceId();
  const store = new AuditEventStore({
    projectRoot: root,
    workspaceId,
    runId,
    traceId,
    persist: true,
  });
  const repo = createRunAggregateRepository({
    projectRoot: root,
    workspaceId,
    chapterId: "ch1",
    runId,
    traceId,
    persist: true,
  });
  repo.appendEvent(store, {
    actor: "orchestrator",
    stage: "run",
    eventType: "run_started",
    status: "started",
    evidenceLevel: "observed",
    parentEventId: null,
  });
  return { store, repo };
}

describe("P6 tail: evidence_revoked → learning projection recompute", () => {
  test("revoke last evidence → strategy resets to weak prior; ledger keeps observation + revoke", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-bridge-orphan";

      // 1) 写入 observation + 物化策略信誉
      appendFeedbackEvidenceEvents(workspaceId, root, [
        observation("ev-1", "s1", "win", 2, "2026-08-13T00:00:00.000Z"),
      ]);
      const store0 = createStrategyPolicyStore(workspaceId);
      const n0 = materializePolicyFromFeedbackLedger(store0, workspaceId, root);
      assert.equal(n0, 1);
      saveStrategyPolicyStore(store0, workspaceId, root);

      const before = loadStrategyPolicyStore(workspaceId, root).getReputation("s1", "m1");
      assert.equal(before.sampleCount, 1);
      assert.equal(before.alpha, WEAK_PRIOR_ALPHA + 2);

      // 2) 治理撤销 + 学习投影重算
      const { store, repo } = makeRun(root, workspaceId);
      const result = revokeEvidenceWithLearningRecompute(store, repo, {
        evidenceId: "ev-1",
        reason: "rollback chapter",
        chapterId: "ch1",
        commandId: "cmd-rev-1",
        projectRoot: root,
        workspaceId,
      });

      assert.equal(result.ok, true);
      assert.equal(result.alreadyRevoked, false);
      assert.equal(result.ledgerRevoked, true);
      assert.ok(result.aggregate.revokedEvidenceIds.includes("ev-1"));

      // 3) 学习侧：原始 observation 保留 + revoke 事件追加
      const ledger = loadFeedbackEvidenceLedger(workspaceId, root);
      const types = ledger.events.map((e) => e.eventType);
      assert.deepEqual(types, ["observation", "revoke"]);
      assert.equal(ledger.events[1].targetEvidenceId, "ev-1");

      // 4) 策略信誉回弱先验（孤儿复位）
      const after = loadStrategyPolicyStore(workspaceId, root).getReputation("s1", "m1");
      assert.equal(after.sampleCount, 0);
      assert.equal(after.alpha, WEAK_PRIOR_ALPHA);
      assert.equal(after.beta, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("revoke one of two evidence → remaining contribution kept; revoked removed", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-bridge-partial";

      appendFeedbackEvidenceEvents(workspaceId, root, [
        observation("ev-1", "s1", "win", 2, "2026-08-13T00:00:00.000Z"),
        observation("ev-2", "s1", "loss", 3, "2026-08-13T00:00:01.000Z"),
      ]);
      const store0 = createStrategyPolicyStore(workspaceId);
      materializePolicyFromFeedbackLedger(store0, workspaceId, root);
      saveStrategyPolicyStore(store0, workspaceId, root);

      const before = loadStrategyPolicyStore(workspaceId, root).getReputation("s1", "m1");
      assert.equal(before.sampleCount, 2);
      assert.equal(before.alpha, WEAK_PRIOR_ALPHA + 2);
      assert.equal(before.beta, WEAK_PRIOR_ALPHA + 3);

      const { store, repo } = makeRun(root, workspaceId);
      const result = revokeEvidenceWithLearningRecompute(store, repo, {
        evidenceId: "ev-1",
        reason: "win was misattributed",
        chapterId: "ch1",
        commandId: "cmd-rev-2",
        projectRoot: root,
        workspaceId,
      });
      assert.equal(result.ok, true);
      assert.equal(result.ledgerRevoked, true);

      // ev-1 (win) 撤销后：仅剩 ev-2 (loss) → alpha 回弱先验，beta 保留 loss 贡献
      const after = loadStrategyPolicyStore(workspaceId, root).getReputation("s1", "m1");
      assert.equal(after.sampleCount, 1);
      assert.equal(after.alpha, WEAK_PRIOR_ALPHA);
      assert.equal(after.beta, WEAK_PRIOR_ALPHA + 3);
      assert.equal(after.consecutiveLosses, 1);

      const ledger = loadFeedbackEvidenceLedger(workspaceId, root);
      assert.equal(ledger.events.length, 3);
      assert.equal(ledger.events[2].eventType, "revoke");
      assert.equal(ledger.events[2].targetEvidenceId, "ev-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("idempotent revoke: same commandId does not duplicate ledger revoke", () => {
    const root = tempRoot();
    try {
      const workspaceId = "ws-bridge-idem";

      appendFeedbackEvidenceEvents(workspaceId, root, [
        observation("ev-1", "s1", "win", 2, "2026-08-13T00:00:00.000Z"),
      ]);
      const store0 = createStrategyPolicyStore(workspaceId);
      materializePolicyFromFeedbackLedger(store0, workspaceId, root);
      saveStrategyPolicyStore(store0, workspaceId, root);

      const { store, repo } = makeRun(root, workspaceId);
      const first = revokeEvidenceWithLearningRecompute(store, repo, {
        evidenceId: "ev-1",
        reason: "rollback",
        chapterId: "ch1",
        commandId: "cmd-rev-idem",
        projectRoot: root,
        workspaceId,
      });
      assert.equal(first.ok, true);
      assert.equal(first.ledgerRevoked, true);

      // 再次撤销同一 evidence（新 run 亦或同 run 重放）：审计 alreadyRevoked 短路
      const { store: store2, repo: repo2 } = makeRun(root, workspaceId);
      const second = revokeEvidenceWithLearningRecompute(store2, repo2, {
        evidenceId: "ev-1",
        reason: "rollback",
        chapterId: "ch1",
        commandId: "cmd-rev-idem",
        projectRoot: root,
        workspaceId,
      });
      assert.equal(second.ok, true);
      // 审计层：新 run 尚未撤销过 → alreadyRevoked=false；但 ledger 层幂等，不重复 revoke
      assert.equal(second.ledgerRevoked, false);

      const ledger = loadFeedbackEvidenceLedger(workspaceId, root);
      const revokes = ledger.events.filter((e) => e.eventType === "revoke");
      assert.equal(revokes.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
