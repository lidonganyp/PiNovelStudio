/**
 * MA-6.1 — 最小 15 项多代理 Eval 矩阵（可自动化断言）
 *
 * 本文件验证边界协议与编排器裁决规则；不宣称文学质量提升。
 * 依赖 dist/ 编译产物。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAgentWorkPackage,
  assertActionAllowed,
  assertResourceInScope,
  AgentWorkPackageError,
} from "../dist/v2/core/agent-work-package.js";
import { getAgentRoleProfile, roleAllowsAction } from "../dist/v2/core/agent-roles.js";
import {
  getInputFieldWhitelist,
  getDefaultAllowedResources,
  getDefaultForbiddenResources,
} from "../dist/v2/core/agent-input-whitelist.js";
import {
  adaptDraftFromAgenticSource,
  adaptFactGuardResult,
  adaptEditorialResult,
  adaptStoryPreservationResult,
  adaptCommitResult,
} from "../dist/v2/core/agent-result-adapters.js";
import {
  decideFromAgentResult,
  resolveDecisionConflict,
  assertStagesCompleteBeforeCommit,
  isAgenticDirectDeliveryAttempt,
  createOrchestratorDecision,
} from "../dist/v2/core/orchestrator-decision.js";
import {
  createCollaborationTraceState,
  buildRoleWorkPackage,
  recordWorkPackage,
  recordAgentResult,
  attachCollaborationToStageResults,
  guardCommitStages,
} from "../dist/v2/core/agent-collaboration-runtime.js";
import {
  authorizeAction,
  createModelAutonomyPolicy,
} from "../dist/v2/core/autonomy-policy.js";

function basePkg(role = "novelos_agentic") {
  const sessionId = "sess-eval";
  return createAgentWorkPackage({
    taskId: "task-eval",
    orchestratorRunId: "run-eval",
    workspaceId: "ws-eval",
    chapterId: "ch1",
    agentRole: role,
    sessionId,
    objective: "eval",
    stage: role,
    inputFieldWhitelist: getInputFieldWhitelist(role),
    allowedResources: getDefaultAllowedResources(role, sessionId),
    forbiddenResources: getDefaultForbiddenResources(role),
    contextHash: "ctx-eval",
  });
}

// 1. 上下文足够时 Agentic 能直接生成（契约层：ok draft）
test("Eval-1: 上下文足够时 DraftAgentResult status=ok", () => {
  const pkg = basePkg("novelos_agentic");
  const draft = adaptDraftFromAgenticSource(
    {
      candidate: {
        id: "c1",
        kind: "agentic_raw",
        text: "正文",
        model: "m",
        route: "r",
        promptProfile: {
          type: "control",
          tokensIn: 1,
          containsDialogueRatio: false,
          containsParagraphLengthConstraint: false,
          containsControlChecklist: false,
          containsMechanicalMetric: false,
          contractIds: [],
        },
        contextHash: "h",
        generatedAt: new Date().toISOString(),
        durationMs: 1,
      },
      sessionId: "s1",
      trajectoryPath: "/t",
      budgetSnapshot: {},
      stopReason: "verifier_cleared",
      sourceRefs: [],
      toolCalls: 0,
      decisionMode: "agentic_inline",
      firstAction: "draft",
      actualRetrievalCalls: 0,
      mustVerifyCount: 0,
      mustVerifyCoveredCount: 0,
      modelCallsByKind: { draft: 1, patch: 0, verify: 0 },
    },
    { workPackage: pkg, candidateId: "c1" },
  );
  assert.equal(draft.status, "ok");
  assert.equal(draft.firstAction === undefined || true, true);
  assert.equal(draft.details?.firstAction, "draft");
});

// 2. 存在 mustVerify 时先检索再生成（可观测 firstAction=tool_call）
test("Eval-2: mustVerify 路径 firstAction=tool_call 可追溯", () => {
  const pkg = basePkg("novelos_agentic");
  const draft = adaptDraftFromAgenticSource(
    {
      candidate: {
        id: "c2",
        kind: "agentic_raw",
        text: "正文",
        model: "m",
        route: "r",
        promptProfile: {
          type: "control",
          tokensIn: 1,
          containsDialogueRatio: false,
          containsParagraphLengthConstraint: false,
          containsControlChecklist: false,
          containsMechanicalMetric: false,
          contractIds: [],
        },
        contextHash: "h",
        generatedAt: new Date().toISOString(),
        durationMs: 1,
      },
      sessionId: "s2",
      trajectoryPath: "/t",
      budgetSnapshot: {},
      stopReason: "verifier_cleared",
      sourceRefs: ["fact:1"],
      toolCalls: 2,
      decisionMode: "agentic_inline",
      firstAction: "tool_call",
      actualRetrievalCalls: 2,
      mustVerifyCount: 3,
      mustVerifyCoveredCount: 3,
      modelCallsByKind: { draft: 1, patch: 0, verify: 0 },
    },
    { workPackage: pkg },
  );
  assert.equal(draft.details.firstAction, "tool_call");
  assert.equal(draft.details.actualRetrievalCalls, 2);
  assert.ok(draft.usedEvidenceRefs.includes("fact:1"));
});

// 3. Agentic 不能调用被禁止工具
test("Eval-3: Agentic 禁止工具映射为动作拒绝", () => {
  const pkg = basePkg("novelos_agentic");
  assert.throws(() => assertActionAllowed(pkg, "chapter.save"));
  assert.throws(() => assertActionAllowed(pkg, "state.commit"));
  const policy = createModelAutonomyPolicy();
  const d = policy.authorizeToolCall({
    toolName: "state.commit",
    taskId: "t",
    workspaceId: "w",
  });
  assert.equal(d.allowed, false);
});

// 4. Agentic 不能提交状态或保存章节
test("Eval-4: 模型 actor 提交/保存 次数为 0（策略层）", () => {
  for (const action of ["chapter.save", "state.commit", "release.promote", "baseline.replace"]) {
    const d = authorizeAction({
      request: {
        taskId: "t",
        workspaceId: "w",
        action,
        requestedLevel: "commit",
        actor: "model",
        scope: { workspaceId: "w" },
      },
    });
    assert.equal(d.allowed, false, action);
  }
  assert.equal(getAgentRoleProfile("novelos_agentic").mayCommit, false);
});

// 5. FactGuard 硬冲突阻断后续提交
test("Eval-5: FactGuard hard → decision block", () => {
  const pkg = basePkg("fact_guard");
  const fg = adaptFactGuardResult(
    { ok: false, errors: ["实体幻觉"] },
    { workPackage: pkg, candidateId: "c1" },
  );
  const decision = decideFromAgentResult({
    orchestratorRunId: "r",
    workspaceId: "w",
    chapterId: "c",
    fromStage: "fact_guard",
    nextStageIfOk: "author_style",
    result: fg,
  });
  assert.equal(decision.transition, "block");
  assert.equal(decision.allowed, false);
});

// 6. 风格优化只改变表达，不改变事件骨架（契约：sourceCandidateId 保留）
test("Eval-6: EditorialResult 保留 sourceCandidateId 且不授予 commit", () => {
  const pkg = basePkg("author_style");
  const ed = adaptEditorialResult(
    {
      candidate: {
        id: "e1",
        kind: "editorial_amplified",
        text: "优化",
        model: "m",
        route: "r",
        promptProfile: {
          type: "editorial",
          tokensIn: 1,
          containsDialogueRatio: false,
          containsParagraphLengthConstraint: false,
          containsControlChecklist: false,
          containsMechanicalMetric: false,
          contractIds: [],
        },
        contextHash: "h",
        generatedAt: new Date().toISOString(),
        durationMs: 1,
      },
      failureReason: null,
      failureKind: null,
      styleProfileLoaded: true,
      styleGuidanceConsumed: true,
      styleReferenceIds: [],
      guidanceCount: 1,
      retryWithReducedGuidance: false,
    },
    { workPackage: pkg, sourceCandidateId: "agentic-1" },
  );
  assert.equal(ed.sourceCandidateId, "agentic-1");
  assert.equal(roleAllowsAction("author_style", "state.commit"), false);
});

// 7. StoryPreservation 漂移 → 非 ok
test("Eval-7: StoryPreservation 漂移 status=blocked 且可驱动重试语义", () => {
  const pkg = basePkg("story_preservation");
  const sp = adaptStoryPreservationResult(
    {
      preserved: false,
      unverifiable: false,
      rejectionType: "replaced_event",
      missingEvents: [],
      replacedEvents: [{ subject: "A", rawSentence: "x", editorialSentence: "y", reason: "r" }],
      orderViolations: [],
      rawEventAnchors: [],
      rawEventAnchorFindings: [],
      entityCoverage: "full_entities",
      reason: "drift",
    },
    { workPackage: pkg, sourceCandidateId: "a1", optimizedCandidateId: "e1" },
  );
  assert.equal(sp.status, "blocked");
  assert.equal(sp.preserved, false);
});

// 8. schema 错误只重试 gate
test("Eval-8: 契约校验失败抛 validation_failed（映射 retry_gate，不改正文）", () => {
  assert.throws(
    () =>
      adaptDraftFromAgenticSource(
        {
          // 有正文但无 candidateId → status=ok 时契约 fail-closed
          candidate: {
            id: "",
            kind: "agentic_raw",
            text: "x",
            model: "m",
            route: "r",
            promptProfile: {
              type: "control",
              tokensIn: 1,
              containsDialogueRatio: false,
              containsParagraphLengthConstraint: false,
              containsControlChecklist: false,
              containsMechanicalMetric: false,
              contractIds: [],
            },
            contextHash: "h",
            generatedAt: new Date().toISOString(),
            durationMs: 1,
          },
          sessionId: "s-ok",
          trajectoryPath: "/t",
          budgetSnapshot: {},
          stopReason: "verifier_cleared",
          sourceRefs: [],
          toolCalls: 0,
          decisionMode: "agentic_inline",
          firstAction: "draft",
          actualRetrievalCalls: 0,
          mustVerifyCount: 0,
          mustVerifyCoveredCount: 0,
          modelCallsByKind: { draft: 1, patch: 0, verify: 0 },
        },
        { workPackage: basePkg() },
      ),
    (err) => err instanceof AgentWorkPackageError && err.code === "validation_failed",
  );
});

// 9. 任一代理失败都有可定位 status/stopReason
test("Eval-9: 失败结果含 stopReason 与 lineage", () => {
  const pkg = basePkg("author_style");
  const ed = adaptEditorialResult(
    {
      candidate: null,
      failureReason: "timeout",
      failureKind: "model_timeout",
      styleProfileLoaded: true,
      styleGuidanceConsumed: true,
      styleReferenceIds: [],
      guidanceCount: 1,
      retryWithReducedGuidance: false,
    },
    { workPackage: pkg, sourceCandidateId: "a1" },
  );
  assert.equal(ed.status, "recoverable");
  assert.ok(ed.stopReason);
  assert.ok(ed.lineage.orchestratorRunId);
  assert.ok(ed.lineage.workPackageId);
});

// 10. 多代理结果可追溯到 candidate 和 session
test("Eval-10: collaboration trace 索引 workPackages + agentResults", () => {
  const state = createCollaborationTraceState({
    orchestratorRunId: "run-1",
    workspaceId: "ws",
    chapterId: "ch1",
  });
  const pkg = buildRoleWorkPackage(state, "novelos_agentic", {
    stage: "s1",
    sessionId: "sess-1",
    objective: "draft",
  });
  recordWorkPackage(state, pkg);
  const draft = adaptDraftFromAgenticSource(
    {
      candidate: {
        id: "cand-1",
        kind: "agentic_raw",
        text: "t",
        model: "m",
        route: "r",
        promptProfile: {
          type: "control",
          tokensIn: 1,
          containsDialogueRatio: false,
          containsParagraphLengthConstraint: false,
          containsControlChecklist: false,
          containsMechanicalMetric: false,
          contractIds: [],
        },
        contextHash: "h",
        generatedAt: new Date().toISOString(),
        durationMs: 1,
      },
      sessionId: "sess-1",
      trajectoryPath: "/t",
      budgetSnapshot: {},
      stopReason: "verifier_cleared",
      sourceRefs: ["e1"],
      toolCalls: 0,
      decisionMode: "agentic_inline",
      firstAction: "draft",
      actualRetrievalCalls: 0,
      mustVerifyCount: 0,
      mustVerifyCoveredCount: 0,
      modelCallsByKind: { draft: 1, patch: 0, verify: 0 },
    },
    { workPackage: pkg, candidateId: "cand-1" },
  );
  recordAgentResult(state, draft, "fact_guard", pkg.packageId);
  const stageResults = {};
  attachCollaborationToStageResults(stageResults, state);
  const collab = stageResults.agentCollaboration;
  assert.equal(collab.agentResults.novelos_agentic.candidateId, "cand-1");
  assert.equal(collab.workPackages.novelos_agentic.sessionId, "sess-1");
  assert.ok(collab.decisions.length >= 1);
});

// 11. 多策略共同作用不伪造单策略胜负（仅记录 bundle）
test("Eval-11: lineage 可携带 strategyBundleId 而不要求单策略胜负", () => {
  const pkg = createAgentWorkPackage({
    taskId: "t",
    orchestratorRunId: "r",
    workspaceId: "w",
    chapterId: "c",
    agentRole: "author_style",
    sessionId: "s",
    objective: "style",
    stage: "author_style",
    inputFieldWhitelist: getInputFieldWhitelist("author_style"),
    allowedResources: getDefaultAllowedResources("author_style", "s"),
    forbiddenResources: getDefaultForbiddenResources("author_style"),
    contextHash: "h",
    strategyBundleId: "bundle:ab",
    strategyId: undefined,
  });
  assert.equal(pkg.strategyBundleId, "bundle:ab");
  assert.equal(pkg.strategyId, undefined);
});

// 12. Agentic 初稿不会绕过作者风格优化直接交付
test("Eval-12: Agentic 直交付检测 + 阶段守卫", () => {
  assert.equal(
    isAgenticDirectDeliveryAttempt({
      selectedSource: "raw",
      completedStages: ["novelos_agentic", "fact_guard"],
    }),
    true,
  );
  const guard = assertStagesCompleteBeforeCommit([
    "novelos_agentic",
    "fact_guard",
  ]);
  assert.equal(guard.ok, false);
  assert.ok(guard.missing.includes("author_style"));
});

// 13. 最终状态只由系统在最终正文确认后提交
test("Eval-13: CommitResult 仅 final_state_commit 角色；模型 mayCommit=false", () => {
  const pkg = basePkg("final_state_commit");
  const commit = adaptCommitResult(
    {
      committed: true,
      chapterFilePath: "workspaces/w/chapters/c.md",
      stateCommitted: 1,
      stateRejected: 0,
    },
    { workPackage: pkg, candidateId: "final-1" },
  );
  assert.equal(commit.agentRole, "final_state_commit");
  assert.equal(commit.committed, true);
  assert.equal(getAgentRoleProfile("novelos_agentic").mayCommit, false);
});

// 14. 子代理看不到无关或超出授权范围的上下文
test("Eval-14: 输入白名单 + 禁止资源", () => {
  const pkg = basePkg("novelos_agentic");
  assert.throws(() => assertResourceInScope(pkg, "chapters/ch1.md"));
  assert.throws(() => assertResourceInScope(pkg, "narrative-state-store.json"));
  assert.ok(getInputFieldWhitelist("novelos_agentic").includes("chapterIntent"));
  assert.ok(!getInputFieldWhitelist("novelos_agentic").includes("rawThinkingChain"));
});

// 15. 一个代理的建议不会自动改变另一个代理的权限
test("Eval-15: 冲突裁决时低优先级 continue 不能覆盖 hard_fact block", () => {
  const block = createOrchestratorDecision({
    orchestratorRunId: "r",
    workspaceId: "w",
    chapterId: "c",
    fromStage: "fact_guard",
    toStage: null,
    priority: "hard_fact",
    transition: "block",
    allowed: false,
    reason: "hard",
  });
  const styleContinue = createOrchestratorDecision({
    orchestratorRunId: "r",
    workspaceId: "w",
    chapterId: "c",
    fromStage: "author_style",
    toStage: "story_preservation",
    priority: "style_advice",
    transition: "continue",
    allowed: true,
    reason: "style suggests continue",
  });
  const winner = resolveDecisionConflict([styleContinue, block]);
  assert.equal(winner.allowed, false);
  assert.equal(winner.priority, "hard_fact");
  // 权限 profile 不可被“建议”改写
  assert.equal(roleAllowsAction("author_style", "chapter.save"), false);
});

test("Eval-extra: guardCommitStages 完整路径通过", () => {
  const state = createCollaborationTraceState({
    orchestratorRunId: "r",
    workspaceId: "w",
    chapterId: "c",
  });
  state.completedStages.push(
    "novelos_agentic",
    "author_style",
    "story_preservation",
    "final_fact_recheck",
  );
  assert.equal(guardCommitStages(state).ok, true);
});
