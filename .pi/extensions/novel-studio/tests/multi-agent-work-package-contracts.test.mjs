/**
 * MA-1 / MA-2 局部 / MA-4 局部 — 代理工作包、结果契约、编排器裁决
 *
 * 测试编译产物 dist/；修改 TS 后需 npm run build:prod 或 build。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAgentWorkPackage,
  validateAgentWorkPackage,
  assertResourceInScope,
  assertActionAllowed,
  assertInputFieldsWhitelisted,
  AgentWorkPackageError,
  summarizeAgentWorkPackage,
} from "../dist/v2/core/agent-work-package.js";
import {
  isAgentRole,
  getAgentRoleProfile,
  roleAllowsAction,
  listAgentRoleProfiles,
} from "../dist/v2/core/agent-roles.js";
import {
  validateDraftAgentResult,
  validateFactGuardResult,
  validateEditorialResult,
  validateStoryPreservationResult,
  validateCommitResult,
  summarizeAgentResult,
  AGENT_RESULT_SCHEMA,
  AGENT_RESULT_VERSION,
} from "../dist/v2/core/agent-result-contracts.js";
import {
  adaptDraftAgentResult,
  adaptFactGuardResult,
  adaptEditorialResult,
  adaptStoryPreservationResult,
  adaptCommitResult,
} from "../dist/v2/core/agent-result-adapters.js";
import {
  getInputFieldWhitelist,
  getDefaultAllowedResources,
  getDefaultForbiddenResources,
} from "../dist/v2/core/agent-input-whitelist.js";
import {
  createOrchestratorDecision,
  decideFromAgentResult,
  resolveDecisionConflict,
  assertStagesCompleteBeforeCommit,
  isAgenticDirectDeliveryAttempt,
  DECISION_PRIORITY_RANK,
} from "../dist/v2/core/orchestrator-decision.js";

function makeWorkPackage(overrides = {}) {
  const role = overrides.agentRole ?? "novelos_agentic";
  const sessionId = overrides.sessionId ?? "sess-ma-1";
  return createAgentWorkPackage({
    taskId: "task-ma-1",
    orchestratorRunId: "run-ma-1",
    workspaceId: "ws-ma",
    chapterId: "ch1",
    agentRole: role,
    sessionId,
    objective: "生成并校验本章候选",
    stage: "agentic",
    inputFieldWhitelist: getInputFieldWhitelist(role),
    allowedResources: getDefaultAllowedResources(role, sessionId),
    forbiddenResources: getDefaultForbiddenResources(role),
    contextHash: "ctx-hash-1",
    promptBundleHash: "prompt-hash-1",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

test("MA-0/1: 全部代理角色有 profile，且 agentic 禁止 commit 动作", () => {
  const profiles = listAgentRoleProfiles();
  assert.ok(profiles.length >= 10);
  for (const p of profiles) {
    assert.equal(isAgentRole(p.role), true);
  }
  assert.equal(roleAllowsAction("novelos_agentic", "chapter.save"), false);
  assert.equal(roleAllowsAction("novelos_agentic", "state.commit"), false);
  assert.equal(roleAllowsAction("novelos_agentic", "draft.generate"), true);
  assert.equal(roleAllowsAction("final_state_commit", "chapter.save"), true);
  assert.equal(getAgentRoleProfile("novelos_agentic").maxAutonomyLevel, "bounded_execute");
});

// ---------------------------------------------------------------------------
// Work package
// ---------------------------------------------------------------------------

test("MA-1.1: 创建工作包含哈希且校验通过", () => {
  const pkg = makeWorkPackage();
  assert.equal(pkg.schema, "pinovel.agent-work-package");
  assert.equal(pkg.version, "1.0.0");
  assert.ok(pkg.packageHash.length >= 32);
  assert.equal(validateAgentWorkPackage(pkg).ok, true);
  const summary = summarizeAgentWorkPackage(pkg);
  assert.equal(summary.agentRole, "novelos_agentic");
  assert.ok(!("objective" in summary) || summary.packageHash);
});

test("MA-1.1: 未知角色 fail-closed", () => {
  assert.throws(
    () => makeWorkPackage({ agentRole: "rogue_writer" }),
    (err) => err instanceof AgentWorkPackageError && err.code === "unknown_role",
  );
});

test("MA-1.1: 伪造 packageHash 校验失败", () => {
  const pkg = makeWorkPackage();
  const tampered = { ...pkg, packageHash: "0".repeat(64) };
  const v = validateAgentWorkPackage(tampered);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("packageHash")));
});

test("MA-1.1: 资源越界与路径穿越拒绝", () => {
  const pkg = makeWorkPackage();
  assert.throws(
    () => assertResourceInScope(pkg, "chapters/ch1.md"),
    (err) => err instanceof AgentWorkPackageError,
  );
  assert.throws(
    () => assertResourceInScope(pkg, "../.env"),
    (err) => err instanceof AgentWorkPackageError && err.code === "resource_out_of_scope",
  );
  assert.doesNotThrow(() =>
    assertResourceInScope(pkg, `novelos-sessions/${pkg.sessionId}/draft.md`),
  );
});

test("MA-1.1: 禁止动作与输入字段越权 fail-closed", () => {
  const pkg = makeWorkPackage();
  assert.throws(
    () => assertActionAllowed(pkg, "chapter.save"),
    (err) => err instanceof AgentWorkPackageError,
  );
  assert.doesNotThrow(() => assertActionAllowed(pkg, "draft.generate"));
  assert.throws(
    () =>
      assertInputFieldsWhitelisted(pkg, {
        chapterIntent: "x",
        secretInternalThoughts: "nope",
      }),
    (err) =>
      err instanceof AgentWorkPackageError && err.code === "input_field_not_allowed",
  );
});

test("MA-1.1: 给 agentic 授予 chapter.save 在创建时拒绝", () => {
  assert.throws(
    () =>
      makeWorkPackage({
        allowedActions: ["draft.generate", "chapter.save"],
      }),
    (err) => err instanceof AgentWorkPackageError,
  );
});

// ---------------------------------------------------------------------------
// Result contracts + adapters
// ---------------------------------------------------------------------------

test("MA-1.2/1.3: DraftAgentResult 适配与校验", () => {
  const pkg = makeWorkPackage({ agentRole: "novelos_agentic" });
  const loop = {
    text: "第一章正文。",
    fallback: false,
    repairRounds: 0,
    lineage: {
      evidencePlan: {},
      toolCalls: 1,
      sourceRefs: ["canon:1"],
      stopReason: "verifier_cleared",
      budgetSnapshot: {},
      evidenceFacts: ["f1"],
      verifierCleared: true,
      hardFindingCount: 0,
      firstAction: "tool_call",
      actualRetrievalCalls: 1,
      modelCallsByKind: { draft: 1, patch: 0, verify: 0 },
    },
  };
  const draft = adaptDraftAgentResult(loop, {
    workPackage: pkg,
    candidateId: "cand-agentic-1",
  });
  assert.equal(draft.schema, AGENT_RESULT_SCHEMA);
  assert.equal(draft.version, AGENT_RESULT_VERSION);
  assert.equal(draft.status, "ok");
  assert.equal(draft.candidateId, "cand-agentic-1");
  assert.equal(validateDraftAgentResult(draft).ok, true);
  const summary = summarizeAgentResult(draft);
  assert.equal(summary.textChars, "第一章正文。".length);
  assert.ok(!("text" in summary));
});

test("MA-1.2: Draft 缺少 candidateId 在 ok 状态 fail-closed", () => {
  const bad = {
    schema: AGENT_RESULT_SCHEMA,
    version: AGENT_RESULT_VERSION,
    status: "ok",
    agentRole: "novelos_agentic",
    sessionId: "s1",
    text: "x",
    unresolvedFindings: [],
    usedEvidenceRefs: [],
    actionsTaken: [],
    stopReason: "ok",
    lineage: {
      orchestratorRunId: "r1",
      agentRole: "novelos_agentic",
      agentSessionId: "s1",
      usedEvidenceRefs: [],
    },
  };
  const v = validateDraftAgentResult(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("candidateId")));
});

test("MA-1.3: FactGuard / Editorial / StoryPreservation / Commit 适配", () => {
  const fgPkg = makeWorkPackage({
    agentRole: "fact_guard",
    stage: "fact_guard",
  });
  const fg = adaptFactGuardResult(
    { ok: true, errors: [], report: { hardBlocks: [], allDiagnostics: [], hasHardBlock: false } },
    { workPackage: fgPkg, candidateId: "cand-1" },
  );
  assert.equal(fg.passed, true);
  assert.equal(validateFactGuardResult(fg).ok, true);

  const stylePkg = makeWorkPackage({
    agentRole: "author_style",
    stage: "author_style",
    sourceCandidateId: "cand-1",
  });
  const editorial = adaptEditorialResult(
    {
      candidate: {
        id: "cand-style-1",
        kind: "editorial_amplified",
        text: "优化后正文。",
        model: "m",
        route: "v2_amplified",
        promptProfile: {
          type: "editorial",
          tokensIn: 1,
          containsDialogueRatio: false,
          containsParagraphLengthConstraint: false,
          containsControlChecklist: false,
          containsMechanicalMetric: false,
          contractIds: [],
        },
        contextHash: "c",
        generatedAt: new Date().toISOString(),
        durationMs: 1,
      },
      failureReason: null,
      failureKind: null,
      styleProfileLoaded: true,
      styleGuidanceConsumed: true,
      styleReferenceIds: ["fp1"],
      guidanceCount: 3,
      retryWithReducedGuidance: false,
    },
    { workPackage: stylePkg, sourceCandidateId: "cand-1" },
  );
  assert.equal(editorial.status, "ok");
  assert.equal(validateEditorialResult(editorial).ok, true);

  const spPkg = makeWorkPackage({
    agentRole: "story_preservation",
    stage: "story_preservation",
  });
  const sp = adaptStoryPreservationResult(
    {
      preserved: true,
      unverifiable: false,
      rejectionType: null,
      missingEvents: [],
      replacedEvents: [],
      orderViolations: [],
      rawEventAnchors: [],
      rawEventAnchorFindings: [],
      entityCoverage: "full_entities",
      reason: "ok",
    },
    {
      workPackage: spPkg,
      sourceCandidateId: "cand-1",
      optimizedCandidateId: "cand-style-1",
    },
  );
  assert.equal(sp.preserved, true);
  assert.equal(validateStoryPreservationResult(sp).ok, true);

  const commitPkg = makeWorkPackage({
    agentRole: "final_state_commit",
    stage: "final_state_commit",
  });
  const commit = adaptCommitResult(
    {
      committed: true,
      chapterFilePath: "workspaces/ws/chapters/ch1.md",
      stateCommitted: 2,
      stateRejected: 0,
      artifactHash: "abc",
    },
    { workPackage: commitPkg, candidateId: "cand-style-1" },
  );
  assert.equal(commit.committed, true);
  assert.equal(validateCommitResult(commit).ok, true);
});

test("MA-1.3: FactGuard hard fail 不得 status=ok", () => {
  const pkg = makeWorkPackage({ agentRole: "fact_guard", stage: "fact_guard" });
  const fg = adaptFactGuardResult(
    { ok: false, errors: ["实体幻觉：不存在的角色"] },
    { workPackage: pkg, candidateId: "cand-x" },
  );
  assert.equal(fg.passed, false);
  assert.equal(fg.status, "blocked");
  assert.equal(validateFactGuardResult(fg).ok, true);
});

// ---------------------------------------------------------------------------
// Orchestrator decision
// ---------------------------------------------------------------------------

test("MA-4.1/4.2: blocked 结果不得 continue", () => {
  const pkg = makeWorkPackage({ agentRole: "fact_guard", stage: "fact_guard" });
  const blocked = adaptFactGuardResult(
    { ok: false, errors: ["hard"] },
    { workPackage: pkg, candidateId: "c1" },
  );
  const decision = decideFromAgentResult({
    orchestratorRunId: "run-1",
    workspaceId: "ws",
    chapterId: "ch1",
    fromStage: "fact_guard",
    nextStageIfOk: "author_style",
    result: blocked,
    workPackageId: pkg.packageId,
  });
  assert.equal(decision.transition, "block");
  assert.equal(decision.allowed, false);
  assert.equal(decision.kind, "decision");
});

test("MA-4.2: 冲突时硬事实优先于风格建议", () => {
  const hard = createOrchestratorDecision({
    orchestratorRunId: "r",
    workspaceId: "w",
    chapterId: "c",
    fromStage: "fact_guard",
    toStage: null,
    priority: "hard_fact",
    transition: "block",
    allowed: false,
    reason: "fact",
  });
  const style = createOrchestratorDecision({
    orchestratorRunId: "r",
    workspaceId: "w",
    chapterId: "c",
    fromStage: "author_style",
    toStage: "story_preservation",
    priority: "style_advice",
    transition: "continue",
    allowed: true,
    reason: "style ok",
  });
  const winner = resolveDecisionConflict([style, hard]);
  assert.equal(winner.priority, "hard_fact");
  assert.equal(winner.allowed, false);
  assert.ok(
    DECISION_PRIORITY_RANK.hard_fact < DECISION_PRIORITY_RANK.style_advice,
  );
});

test("MA-4.3: 阶段守卫 — 缺风格优化不得 commit；禁止 Agentic 直交付", () => {
  const incomplete = assertStagesCompleteBeforeCommit([
    "novelos_agentic",
    "fact_guard",
  ]);
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.missing.includes("author_style"));
  assert.ok(incomplete.missing.includes("story_preservation"));

  const complete = assertStagesCompleteBeforeCommit([
    "novelos_agentic",
    "author_style",
    "story_preservation",
    "final_fact_recheck",
  ]);
  assert.equal(complete.ok, true);

  assert.equal(
    isAgenticDirectDeliveryAttempt({
      selectedSource: "raw",
      completedStages: ["novelos_agentic"],
      agenticOnly: true,
    }),
    true,
  );
  assert.equal(
    isAgenticDirectDeliveryAttempt({
      selectedSource: "editorial",
      completedStages: ["novelos_agentic", "author_style", "story_preservation"],
    }),
    false,
  );
});

test("MA-2 局部: 模型角色 profile 不得 mayCommit", () => {
  for (const role of [
    "novelos_agentic",
    "author_style",
    "fact_guard",
    "story_preservation",
  ]) {
    assert.equal(getAgentRoleProfile(role).mayCommit, false);
  }
  assert.equal(getAgentRoleProfile("final_state_commit").mayCommit, true);
});
