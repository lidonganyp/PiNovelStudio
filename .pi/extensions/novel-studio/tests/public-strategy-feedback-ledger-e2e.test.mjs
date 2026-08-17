/**
 * USER-FEEDBACK-EVIDENCE-PIPELINE-1
 * End-to-end audit: quality-trace → public handleStrategyFeedback → ledger → policy
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleStrategyFeedback } from "../dist/handlers/public-handlers.js";
import {
  loadFeedbackEvidenceLedger,
  materializePolicyFromFeedbackLedger,
} from "../dist/v2/learning/feedback-evidence-ledger-store.js";
import {
  createStrategyPolicyStore,
  WEAK_PRIOR_ALPHA,
} from "../dist/v2/learning/strategy-policy-store.js";

function makeProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), "pinovel-fb-e2e-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "docs", "top-tier-chinese-novel-system-development-plan.md"),
    "# marker\n",
    "utf8",
  );
  writeFileSync(join(root, "config", "model-routing.json"), "{}\n", "utf8");
  return root;
}

test("E2E: 完整 trace 血缘 → 公共反馈入口 → ledger observation → policy win", async () => {
  const projectRoot = makeProjectRoot();
  const workspaceId = "e2e-ws";
  const tracesDir = join(projectRoot, "workspaces", workspaceId, "traces");
  mkdirSync(tracesDir, { recursive: true });

  writeFileSync(
    join(tracesDir, "3-quality-trace.json"),
    JSON.stringify(
      {
        records: [
          {
            stage: "final_selected",
            strategyContext: {
              modelVersion: "glm-5.2",
              selectedStrategyIds: ["voice_emphasis"],
              sourceChapter: "ch3",
              opportunityType: "author_style",
              orchestratorRunId: "run-e2e-ch3",
              candidateId: "cand-ed-ch3",
              strategyBundleId: "bundle:voice_emphasis",
              exposureId: "exp-e2e-ch3",
              promptBundleId: "prompt:author_style:default",
              deliveredSource: "editorial",
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  try {
    const result = await handleStrategyFeedback({
      workspaceId,
      chapterId: "3",
      action: "choice",
      strategyId: "voice_emphasis",
      chosen: "editorial",
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.modelVersion, "glm-5.2");
    assert.equal(result.result?.recorded, true);
    assert.equal(result.lineageAudit?.complete, true);
    assert.ok((result.lineageAudit?.ledgerAppended ?? 0) >= 1);

    const ledger = loadFeedbackEvidenceLedger(workspaceId, projectRoot);
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.events[0].eventType, "observation");
    assert.equal(ledger.events[0].outcome, "win");
    assert.equal(ledger.events[0].lineage.orchestratorRunId, "run-e2e-ch3");
    assert.equal(ledger.events[0].lineage.exposureId, "exp-e2e-ch3");
    assert.equal(ledger.events[0].lineage.candidateId, "cand-ed-ch3");
    assert.equal(ledger.events[0].lineage.promptBundleId, "prompt:author_style:default");

    const policyPath = join(
      projectRoot,
      "workspaces",
      workspaceId,
      "strategy-policy.json",
    );
    assert.ok(existsSync(policyPath));
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    const rep = policy.partitions?.["glm-5.2"]?.voice_emphasis;
    assert.ok(rep);
    assert.equal(rep.sampleCount, 1);
    assert.ok(rep.alpha > WEAK_PRIOR_ALPHA);

    // ledger recompute materialization path
    const store = createStrategyPolicyStore(workspaceId);
    const count = materializePolicyFromFeedbackLedger(store, workspaceId, projectRoot);
    assert.ok(count >= 1);
    const recomputed = store.getReputation("voice_emphasis", "glm-5.2");
    assert.equal(recomputed.sampleCount, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("E2E: revert 撤销写账本 revoke，policy 可由账本重算回弱先验", async () => {
  const projectRoot = makeProjectRoot();
  const workspaceId = "e2e-ws-revert";
  const tracesDir = join(projectRoot, "workspaces", workspaceId, "traces");
  mkdirSync(tracesDir, { recursive: true });

  writeFileSync(
    join(tracesDir, "3-quality-trace.json"),
    JSON.stringify(
      {
        records: [
          {
            stage: "final_selected",
            strategyContext: {
              modelVersion: "glm-5.2",
              selectedStrategyIds: ["voice_emphasis"],
              sourceChapter: "ch3",
              opportunityType: "author_style",
              orchestratorRunId: "run-e2e-ch3",
              candidateId: "cand-ed-ch3",
              strategyBundleId: "bundle:voice_emphasis",
              exposureId: "exp-e2e-ch3",
              promptBundleId: "prompt:author_style:default",
              deliveredSource: "editorial",
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  try {
    // 1) choice 落 observation + policy win
    const choice = await handleStrategyFeedback({
      workspaceId,
      chapterId: "3",
      action: "choice",
      strategyId: "voice_emphasis",
      chosen: "editorial",
      _projectRoot: projectRoot,
    });
    assert.equal(choice.result?.recorded, true);

    const ledgerBefore = loadFeedbackEvidenceLedger(workspaceId, projectRoot);
    assert.equal(ledgerBefore.events.length, 1);
    assert.equal(ledgerBefore.events[0].eventType, "observation");
    const evidenceId = ledgerBefore.events[0].evidenceId;
    assert.ok(evidenceId);

    // 2) revert 撤销该 evidence → 账本追加 revoke（不再只直写 strategy-policy.json）
    const revert = await handleStrategyFeedback({
      workspaceId,
      chapterId: "3",
      action: "revert",
      strategyId: "voice_emphasis",
      feedbackEventId: evidenceId,
      reason: "test rollback",
      _projectRoot: projectRoot,
    });
    assert.equal(revert.result?.reverted, true);

    const ledgerAfter = loadFeedbackEvidenceLedger(workspaceId, projectRoot);
    assert.equal(ledgerAfter.events.length, 2);
    assert.equal(ledgerAfter.events[1].eventType, "revoke");
    assert.equal(ledgerAfter.events[1].targetEvidenceId, evidenceId);

    // 3) policy 由账本重算 → 弱先验（原始 observation 保留 + revoke 生效）
    const store = createStrategyPolicyStore(workspaceId);
    materializePolicyFromFeedbackLedger(store, workspaceId, projectRoot);
    const recomputed = store.getReputation("voice_emphasis", "glm-5.2");
    assert.equal(recomputed.sampleCount, 0);
    assert.equal(recomputed.alpha, WEAK_PRIOR_ALPHA);

    // 4) 幂等：同一 evidenceId 再次撤销不重复落账本 revoke
    await handleStrategyFeedback({
      workspaceId,
      chapterId: "3",
      action: "revert",
      strategyId: "voice_emphasis",
      feedbackEventId: evidenceId,
      reason: "test rollback (dup)",
      _projectRoot: projectRoot,
    });
    const ledgerIdem = loadFeedbackEvidenceLedger(workspaceId, projectRoot);
    const revokes = ledgerIdem.events.filter((e) => e.eventType === "revoke");
    assert.equal(revokes.length, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("E2E: 缺血缘公共反馈不写 policy，但可写 neutral ledger observation", async () => {
  const projectRoot = makeProjectRoot();
  const workspaceId = "e2e-ws-incomplete";
  try {
    const result = await handleStrategyFeedback({
      workspaceId,
      action: "choice",
      strategyId: "voice_emphasis",
      modelVersion: "glm-5.2",
      sourceChapter: "ch9",
      chosen: "editorial",
      _projectRoot: projectRoot,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.result?.recorded, false);
    assert.equal(result.lineageAudit?.complete, false);

    const policyPath = join(
      projectRoot,
      "workspaces",
      workspaceId,
      "strategy-policy.json",
    );
    // incomplete lineage must not create literary reputation samples
    if (existsSync(policyPath)) {
      const policy = JSON.parse(readFileSync(policyPath, "utf8"));
      const rep = policy.partitions?.["glm-5.2"]?.voice_emphasis;
      assert.ok(!rep || rep.sampleCount === 0);
    }

    const ledger = loadFeedbackEvidenceLedger(workspaceId, projectRoot);
    assert.ok(ledger.events.length >= 1);
    assert.equal(ledger.events[0].outcome, "neutral");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
