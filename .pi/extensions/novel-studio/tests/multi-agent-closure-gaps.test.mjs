/**
 * MA 核验收口：工作包工具门闩 / 契约 fail-closed / 血缘索引
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAgentWorkPackage } from "../dist/v2/core/agent-work-package.js";
import {
  getDefaultAllowedResources,
  getDefaultForbiddenResources,
  getInputFieldWhitelist,
} from "../dist/v2/core/agent-input-whitelist.js";
import {
  evaluateToolCallAgainstWorkPackage,
  evaluateInputAgainstWorkPackage,
} from "../dist/v2/core/agent-work-package-tool-gate.js";
import {
  classifyCollaborationContractError,
  collaborationFailureGuidance,
} from "../dist/v2/core/agent-collaboration-fail-closed.js";
import { AgentWorkPackageError } from "../dist/v2/core/agent-work-package.js";
import {
  buildAgentLineageIndex,
  isLineageCompleteForStrategyUpdate,
  queryLineageByCandidate,
} from "../dist/v2/core/agent-lineage-index.js";

function pkg(role = "novelos_agentic") {
  const sessionId = "sess-gap";
  return createAgentWorkPackage({
    taskId: "task-gap",
    orchestratorRunId: "run-gap",
    workspaceId: "ws-gap",
    chapterId: "ch1",
    agentRole: role,
    sessionId,
    objective: "gap",
    stage: role,
    inputFieldWhitelist: getInputFieldWhitelist(role),
    allowedResources: getDefaultAllowedResources(role, sessionId),
    forbiddenResources: getDefaultForbiddenResources(role),
    contextHash: "ctx-gap",
  });
}

test("MA-2.3: 工作包工具门闩拒绝 chapter.save / 未知工具 / 路径越界", () => {
  const workPackage = pkg("novelos_agentic");
  const denySave = evaluateToolCallAgainstWorkPackage({
    workPackage,
    toolName: "chapter.save",
  });
  assert.equal(denySave.allowed, false);

  const denyUnknown = evaluateToolCallAgainstWorkPackage({
    workPackage,
    toolName: "delete_workspace_root",
  });
  assert.equal(denyUnknown.allowed, false);
  assert.equal(denyUnknown.code, "unknown_action");

  const denyPath = evaluateToolCallAgainstWorkPackage({
    workPackage,
    toolName: "query_character_profile",
    toolArgs: { path: "chapters/ch1.md" },
  });
  assert.equal(denyPath.allowed, false);

  const allowQuery = evaluateToolCallAgainstWorkPackage({
    workPackage,
    toolName: "query_character_profile",
    toolArgs: { name: "叶尘" },
  });
  assert.equal(allowQuery.allowed, true);
  assert.equal(allowQuery.action, "retrieval.execute");
});

test("MA-3.2: 输入白名单强制校验", () => {
  const workPackage = pkg("novelos_agentic");
  const ok = evaluateInputAgainstWorkPackage({
    workPackage,
    payload: {
      chapterIntent: "x",
      seedContext: "y",
      context: {},
    },
  });
  assert.equal(ok.allowed, true);

  const bad = evaluateInputAgainstWorkPackage({
    workPackage,
    payload: {
      chapterIntent: "x",
      secretThinkingChain: "nope",
    },
  });
  assert.equal(bad.allowed, false);
  assert.equal(bad.code, "input_field_not_allowed");
});

test("契约失败分类：validation_failed → retry_gate guidance", () => {
  const failure = classifyCollaborationContractError(
    "author_style_contract",
    "author_style",
    new AgentWorkPackageError("契约校验失败", "validation_failed"),
  );
  assert.equal(failure.retryable, true);
  const guidance = collaborationFailureGuidance(failure);
  assert.equal(guidance.gate, "agent_result_schema");
  assert.equal(guidance.severityOverride, "recoverable");
  assert.equal(guidance.retryPlan?.strategy, "retry_gate");
});

test("MA-5.2: lineage index 可按 candidate/session 查询", () => {
  const stageResults = {
    orchestratorRunId: "run-1",
    novelos: {
      sessionId: "sess-1",
      trajectoryPath: "/tmp/traj.jsonl",
      candidateId: "cand-1",
    },
    agentCollaboration: {
      orchestratorRunId: "run-1",
      workPackages: {
        novelos_agentic: {
          packageId: "awp-1",
          packageHash: "hash-1",
          stage: "stage1",
          sessionId: "sess-1",
        },
      },
      agentResults: {
        novelos_agentic: {
          status: "ok",
          candidateId: "cand-1",
          sessionId: "sess-1",
          lineage: {
            orchestratorRunId: "run-1",
            candidateId: "cand-1",
            agentSessionId: "sess-1",
            workPackageId: "awp-1",
            workPackageHash: "hash-1",
            usedEvidenceRefs: ["e1"],
          },
        },
      },
      decisions: [
        {
          decisionId: "d1",
          sourceAgentRole: "novelos_agentic",
          candidateId: "cand-1",
        },
      ],
    },
  };

  const index = buildAgentLineageIndex({
    stageResults,
    workspaceId: "ws",
    chapterId: "ch1",
  });
  assert.equal(index.all.length, 1);
  const byCand = queryLineageByCandidate(index, "cand-1");
  assert.equal(byCand.length, 1);
  assert.equal(byCand[0].trajectoryPath, "/tmp/traj.jsonl");
  assert.equal(byCand[0].workPackageHash, "hash-1");
  const complete = isLineageCompleteForStrategyUpdate(index, "cand-1");
  assert.equal(complete.ok, true);
});

test("MA-5.2: 不完整血缘不得更新策略", () => {
  const index = buildAgentLineageIndex({
    stageResults: {
      novelos: { sessionId: "s", candidateId: "c" },
      agentCollaboration: { agentResults: {}, workPackages: {}, decisions: [] },
    },
  });
  const complete = isLineageCompleteForStrategyUpdate(index, "c");
  assert.equal(complete.ok, false);
  assert.ok(complete.reasons.length > 0);
});

test("fail-closed: 漂移重试不得用 completedStages 伪装契约成功（守卫语义）", async () => {
  const {
    assertStagesCompleteBeforeCommit,
  } = await import("../dist/v2/core/orchestrator-decision.js");
  // 业务门通过但未 recordAgentResult → completedStages 缺 story_preservation → 不得 commit
  const guard = assertStagesCompleteBeforeCommit([
    "novelos_agentic",
    "author_style",
    "final_fact_recheck",
  ]);
  assert.equal(guard.ok, false);
  assert.ok(guard.missing.includes("story_preservation"));
});

test("MA-3.2: requireWorkPackageInput 生产入口 fail-closed", async () => {
  const { requireWorkPackageInput } = await import(
    "../dist/v2/core/agent-collaboration-runtime.js"
  );
  const workPackage = pkg("novelos_agentic");
  assert.doesNotThrow(() =>
    requireWorkPackageInput(workPackage, {
      chapterIntent: "x",
      seedContext: "y",
      context: {},
    }),
  );
  assert.throws(
    () =>
      requireWorkPackageInput(workPackage, {
        chapterIntent: "x",
        leakedInternalNotes: "nope",
      }),
    (err) => err && err.code === "input_field_not_allowed",
  );
});

test("MA-5.2: resolveFeedbackLineage 在 index 不完整时拒绝文学信誉更新", async () => {
  const { resolveFeedbackLineage } = await import(
    "../dist/handlers/strategy-feedback-lineage.js"
  );
  const incompleteIndex = buildAgentLineageIndex({
    stageResults: {
      novelos: { sessionId: "s", candidateId: "cand-x" },
      agentCollaboration: { agentResults: {}, workPackages: {}, decisions: [] },
    },
  });
  const resolved = resolveFeedbackLineage({
    workspaceId: "ws",
    strategyId: "s1",
    modelVersion: "m1",
    sourceChapter: "ch1",
    feedbackEventId: "fb1",
    orchestratorRunId: "run-1",
    candidateId: "cand-x",
    strategyBundleId: "bundle:s1",
    exposureId: "exp-1",
    promptBundleId: "prompt:1",
    traceContext: {
      modelVersion: "m1",
      selectedStrategyIds: ["s1"],
      sourceChapter: "ch1",
      opportunityType: "author_style",
      tracePath: "/t",
      agentLineageIndex: incompleteIndex,
    },
  });
  assert.equal(resolved.complete, false);
  assert.match(resolved.reason, /agent lineage index incomplete|incomplete/i);
});
