/**
 * AGENT-RESULT-ADAPTERS — 现有业务结果 → 统一契约（MA-1.3）
 *
 * 保留现有业务字段于 details，不重命名生产语义字段。
 * 适配失败 / 校验失败由调用方映射为 retry_gate FailureEnvelope。
 */

import type { AgentLoopResult } from "../../novelos/agent/narrative-agent-loop-types.js";
import type { AgenticRawSourceResult } from "../../novelos/agent/agentic-raw-candidate-source.js";
import type { AuthorStyleOptimizationResult } from "./author-style-optimizer.js";
import type { StoryPreservationGateReport } from "./editorial-story-preservation-gate.js";
import type { FactContinuityReport } from "./fact-continuity-guard.js";
import type { AgentWorkPackage } from "./agent-work-package.js";
import {
  AGENT_RESULT_SCHEMA,
  AGENT_RESULT_VERSION,
  type AgentFinding,
  type AgentLineage,
  type CommitResult,
  type DraftAgentResult,
  type EditorialResult,
  type FactGuardResult,
  type StoryPreservationResult,
  validateCommitResult,
  validateDraftAgentResult,
  validateEditorialResult,
  validateFactGuardResult,
  validateStoryPreservationResult,
} from "./agent-result-contracts.js";
import { AgentWorkPackageError } from "./agent-work-package.js";

export interface AdaptContext {
  workPackage: AgentWorkPackage;
  orchestratorRunId?: string;
  candidateId?: string;
  sourceCandidateId?: string;
  parentCandidateId?: string;
  modelVersion?: string;
  strategyId?: string;
  strategyBundleId?: string;
}

function baseLineage(ctx: AdaptContext, usedEvidenceRefs: string[] = []): AgentLineage {
  const pkg = ctx.workPackage;
  return {
    orchestratorRunId: ctx.orchestratorRunId ?? pkg.orchestratorRunId,
    candidateId: ctx.candidateId,
    sourceCandidateId: ctx.sourceCandidateId ?? pkg.sourceCandidateId,
    parentCandidateId: ctx.parentCandidateId ?? pkg.parentCandidateId,
    agentRole: pkg.agentRole,
    agentSessionId: pkg.sessionId,
    strategyId: ctx.strategyId ?? pkg.strategyId,
    strategyBundleId: ctx.strategyBundleId ?? pkg.strategyBundleId,
    modelVersion: ctx.modelVersion,
    promptBundleHash: pkg.promptBundleHash,
    contextHash: pkg.contextHash,
    usedEvidenceRefs: [...usedEvidenceRefs],
    workPackageId: pkg.packageId,
    workPackageHash: pkg.packageHash,
  };
}

function assertValid<T>(
  label: string,
  validation: { ok: boolean; errors: string[] },
  value: T,
): T {
  if (!validation.ok) {
    throw new AgentWorkPackageError(
      `${label} 契约校验失败：${validation.errors.join("; ")}`,
      "validation_failed",
    );
  }
  return value;
}

/**
 * AgenticRawSourceResult → DraftAgentResult（生产编排器主路径）
 */
export function adaptDraftFromAgenticSource(
  source: AgenticRawSourceResult,
  ctx: AdaptContext & { candidateId?: string },
): DraftAgentResult {
  const unresolvedFindings: AgentFinding[] = (source.unresolvedFindings ?? []).map(
    (f) => ({
      code: f.failureType ?? f.id ?? "finding",
      severity: "hard" as const,
      message: f.description ?? f.conflictFact ?? f.failureType,
      evidenceRef: f.sourceRef,
    }),
  );
  let status: DraftAgentResult["status"] = "ok";
  if (!source.candidate?.text?.trim()) {
    status =
      source.failureKind === "model_timeout" ||
      source.failureKind === "model_error" ||
      source.failureKind === "budget_exhausted"
        ? "recoverable"
        : "blocked";
  }
  const candidateId = ctx.candidateId ?? source.candidate?.id;
  const result: DraftAgentResult = {
    schema: AGENT_RESULT_SCHEMA,
    version: AGENT_RESULT_VERSION,
    status,
    agentRole: "novelos_agentic",
    candidateId,
    sessionId: source.sessionId || ctx.workPackage.sessionId,
    text: source.candidate?.text ?? "",
    unresolvedFindings,
    usedEvidenceRefs: [...(source.sourceRefs ?? [])],
    actionsTaken: [
      {
        action: "draft.generate",
        outcome: source.candidate ? "ok" : "error",
        detail: source.failureKind ?? source.stopReason,
      },
    ],
    stopReason: source.failureKind ?? source.stopReason ?? "ok",
    lineage: baseLineage(
      { ...ctx, candidateId },
      source.sourceRefs ?? [],
    ),
    fallback: !source.candidate,
    repairRounds: source.repairRounds ?? 0,
    details: {
      trajectoryPath: source.trajectoryPath,
      failureReason: source.failureReason,
      failureKind: source.failureKind,
      decisionMode: source.decisionMode,
      firstAction: source.firstAction,
      actualRetrievalCalls: source.actualRetrievalCalls,
      mustVerifyCount: source.mustVerifyCount,
      mustVerifyCoveredCount: source.mustVerifyCoveredCount,
      modelCallsByKind: source.modelCallsByKind,
      verifierCleared: source.verifierCleared,
      hardFindingCount: source.hardFindingCount,
      toolCalls: source.toolCalls,
    },
  };
  return assertValid(
    "DraftAgentResult",
    validateDraftAgentResult(result),
    result,
  );
}

/**
 * AgentLoopResult → DraftAgentResult
 */
export function adaptDraftAgentResult(
  loop: AgentLoopResult,
  ctx: AdaptContext & { candidateId?: string },
): DraftAgentResult {
  const usedEvidenceRefs = [
    ...(loop.lineage?.sourceRefs ?? []),
  ];
  const unresolvedFindings: AgentFinding[] = (loop.verifierReport?.findings ?? [])
    .filter((f) => f.severity === "hard" || f.severity === "fatal" || f.severity === "review")
    .map((f) => ({
      code: f.failureType ?? f.id ?? "verifier_finding",
      severity:
        f.severity === "hard" || f.severity === "fatal"
          ? ("hard" as const)
          : ("advisory" as const),
      message: f.description ?? f.conflictFact ?? f.failureType ?? "finding",
      evidenceRef: f.sourceRef,
    }));

  let status: DraftAgentResult["status"] = "ok";
  if (loop.fallback || !loop.text?.trim()) {
    const kind = loop.lineage?.stopReason ?? "";
    status =
      kind === "model_error" || kind === "tool_error" || kind === "budget_exhausted"
        ? "recoverable"
        : "blocked";
  }
  if (loop.lineage?.hardFindingCount && loop.lineage.hardFindingCount > 0 && !loop.text?.trim()) {
    status = "blocked";
  }

  const candidateId =
    ctx.candidateId ??
    (loop.text?.trim() ? `agentic-${ctx.workPackage.sessionId}` : undefined);

  const result: DraftAgentResult = {
    schema: AGENT_RESULT_SCHEMA,
    version: AGENT_RESULT_VERSION,
    status,
    agentRole: "novelos_agentic",
    candidateId,
    sessionId: ctx.workPackage.sessionId,
    text: loop.text ?? "",
    unresolvedFindings,
    usedEvidenceRefs,
    actionsTaken: [
      {
        action: "draft.generate",
        outcome: loop.fallback ? "error" : "ok",
        detail: loop.lineage?.stopReason,
      },
    ],
    stopReason: loop.lineage?.stopReason ?? (loop.fallback ? "fallback" : "ok"),
    lineage: baseLineage(
      { ...ctx, candidateId },
      usedEvidenceRefs,
    ),
    fallback: loop.fallback,
    repairRounds: loop.repairRounds,
    details: {
      verifierCleared: loop.lineage?.verifierCleared,
      hardFindingCount: loop.lineage?.hardFindingCount,
      firstAction: loop.lineage?.firstAction,
      actualRetrievalCalls: loop.lineage?.actualRetrievalCalls,
      modelCallsByKind: loop.lineage?.modelCallsByKind,
      failureReason: loop.lineage?.failureReason,
      coverageGate: loop.lineage?.coverageGate,
      patchProposalCount: loop.patchProposals?.length ?? 0,
    },
  };

  return assertValid(
    "DraftAgentResult",
    validateDraftAgentResult(result),
    result,
  );
}

/**
 * checkCandidateFactGuard 输出 → FactGuardResult
 */
export function adaptFactGuardResult(
  guard: {
    ok: boolean;
    errors: string[];
    report?: FactContinuityReport | null;
    constraintManifestHash?: string;
  },
  ctx: AdaptContext & {
    candidateId: string;
    role?: "fact_guard" | "final_fact_recheck";
    checkedFacts?: string[];
    sourceRefs?: string[];
  },
): FactGuardResult {
  const role = ctx.role ?? "fact_guard";
  const hardFindings: AgentFinding[] = (guard.errors ?? []).map((message, i) => ({
    code: `fact_guard_${i}`,
    severity: "hard" as const,
    message,
  }));
  const advisoryFindings: AgentFinding[] = [];
  const report = guard.report ?? null;
  if (report?.allDiagnostics) {
    for (const d of report.allDiagnostics) {
      if (d.severity === "hard" || d.severity === "fatal") continue;
      advisoryFindings.push({
        code: d.id ?? d.source ?? "advisory",
        severity: "advisory",
        message: d.evidence ?? d.source ?? "advisory",
      });
    }
  }

  const result: FactGuardResult = {
    schema: AGENT_RESULT_SCHEMA,
    version: AGENT_RESULT_VERSION,
    status: guard.ok ? "ok" : "blocked",
    agentRole: role,
    candidateId: ctx.candidateId,
    sessionId: ctx.workPackage.sessionId,
    passed: guard.ok === true,
    hardFindings,
    advisoryFindings,
    checkedFacts: ctx.checkedFacts ?? [],
    sourceRefs: ctx.sourceRefs ?? [],
    actionsTaken: [
      {
        action: "workspace.read",
        outcome: guard.ok ? "ok" : "error",
        detail: guard.ok ? "fact_guard_passed" : "fact_guard_failed",
      },
    ],
    stopReason: guard.ok ? "passed" : hardFindings[0]?.message ?? "fact_guard_blocked",
    lineage: baseLineage(
      { ...ctx, candidateId: ctx.candidateId },
      ctx.sourceRefs ?? [],
    ),
    details: {
      constraintManifestHash:
        guard.constraintManifestHash ?? ctx.workPackage.constraintManifestHash,
      errorCount: guard.errors?.length ?? 0,
      reportSummary: report
        ? {
            ok: guard.ok,
            // 只保留可序列化摘要
          }
        : null,
    },
  };

  // 临时改 workPackage.agentRole 语义：lineage 使用 role
  result.lineage = {
    ...result.lineage,
    agentRole: role,
  };

  return assertValid(
    "FactGuardResult",
    validateFactGuardResult(result),
    result,
  );
}

/**
 * AuthorStyleOptimizationResult → EditorialResult
 */
export function adaptEditorialResult(
  style: AuthorStyleOptimizationResult,
  ctx: AdaptContext & { sourceCandidateId: string },
): EditorialResult {
  let status: EditorialResult["status"] = "ok";
  if (!style.candidate) {
    if (
      style.failureKind === "empty_result" ||
      style.failureKind === "model_timeout"
    ) {
      status = "recoverable";
    } else {
      status = "blocked";
    }
  }

  let preservationRisk: EditorialResult["preservationRisk"] = "low";
  if (style.retryWithReducedGuidance) preservationRisk = "medium";
  if (status !== "ok") preservationRisk = "high";

  const candidateId = style.candidate?.id;
  const result: EditorialResult = {
    schema: AGENT_RESULT_SCHEMA,
    version: AGENT_RESULT_VERSION,
    status,
    agentRole: "author_style",
    candidateId,
    sessionId: ctx.workPackage.sessionId,
    sourceCandidateId: ctx.sourceCandidateId,
    text: style.candidate?.text,
    preservationRisk,
    failureKind: style.failureKind ?? undefined,
    strategyBundleId: ctx.strategyBundleId ?? ctx.workPackage.strategyBundleId,
    actionsTaken: [
      {
        action: "editorial.optimize",
        outcome: style.candidate ? "ok" : "error",
        detail: style.failureKind ?? style.failureReason ?? undefined,
      },
    ],
    stopReason:
      style.failureKind ??
      (style.candidate ? "optimized" : style.failureReason ?? "blocked"),
    lineage: baseLineage(
      {
        ...ctx,
        candidateId,
        sourceCandidateId: ctx.sourceCandidateId,
      },
      [],
    ),
    details: {
      styleProfileLoaded: style.styleProfileLoaded,
      styleGuidanceConsumed: style.styleGuidanceConsumed,
      styleReferenceIds: style.styleReferenceIds,
      guidanceCount: style.guidanceCount,
      retryWithReducedGuidance: style.retryWithReducedGuidance,
      failureReason: style.failureReason,
    },
  };

  return assertValid(
    "EditorialResult",
    validateEditorialResult(result),
    result,
  );
}

/**
 * StoryPreservationGateReport → StoryPreservationResult
 */
export function adaptStoryPreservationResult(
  report: StoryPreservationGateReport,
  ctx: AdaptContext & {
    sourceCandidateId: string;
    optimizedCandidateId?: string;
  },
): StoryPreservationResult {
  const status: StoryPreservationResult["status"] = report.preserved
    ? "ok"
    : report.unverifiable
      ? "recoverable"
      : "blocked";

  const result: StoryPreservationResult = {
    schema: AGENT_RESULT_SCHEMA,
    version: AGENT_RESULT_VERSION,
    status,
    agentRole: "story_preservation",
    candidateId: ctx.optimizedCandidateId ?? ctx.candidateId,
    sessionId: ctx.workPackage.sessionId,
    preserved: report.preserved,
    unverifiable: report.unverifiable,
    rejectionType: report.rejectionType,
    sourceCandidateId: ctx.sourceCandidateId,
    optimizedCandidateId: ctx.optimizedCandidateId,
    reason: report.reason,
    actionsTaken: [
      {
        action: "workspace.read",
        outcome: report.preserved ? "ok" : "error",
        detail: report.rejectionType ?? "preserved",
      },
    ],
    stopReason: report.preserved
      ? "preserved"
      : report.rejectionType ?? "drift",
    lineage: baseLineage(
      {
        ...ctx,
        candidateId: ctx.optimizedCandidateId ?? ctx.candidateId,
        sourceCandidateId: ctx.sourceCandidateId,
      },
      [],
    ),
    details: {
      entityCoverage: report.entityCoverage,
      mode: report.mode,
      missingEventCount: report.missingEvents?.length ?? 0,
      replacedEventCount: report.replacedEvents?.length ?? 0,
      orderViolationCount: report.orderViolations?.length ?? 0,
      causalBreakCount: report.causalBreaks?.length ?? 0,
      stateChangeLossCount: report.stateChangeLosses?.length ?? 0,
      editorialEventCount: report.editorialEventCount,
    },
  };

  return assertValid(
    "StoryPreservationResult",
    validateStoryPreservationResult(result),
    result,
  );
}

/**
 * 提交阶段输出 → CommitResult
 */
export function adaptCommitResult(
  commit: {
    committed: boolean;
    chapterFilePath: string | null;
    stateCommitted?: number;
    stateRejected?: number;
    artifactHash?: string;
    revision?: string;
    authorizationTraceId?: string;
    reason?: string;
  },
  ctx: AdaptContext,
): CommitResult {
  const result: CommitResult = {
    schema: AGENT_RESULT_SCHEMA,
    version: AGENT_RESULT_VERSION,
    status: commit.committed ? "ok" : "blocked",
    agentRole: "final_state_commit",
    candidateId: ctx.candidateId,
    sessionId: ctx.workPackage.sessionId,
    committed: commit.committed,
    chapterFilePath: commit.chapterFilePath,
    stateCommitted: commit.stateCommitted ?? 0,
    stateRejected: commit.stateRejected ?? 0,
    artifactHash: commit.artifactHash,
    revision: commit.revision,
    authorizationTraceId: commit.authorizationTraceId,
    actionsTaken: [
      {
        action: "chapter.save",
        outcome: commit.committed && commit.chapterFilePath ? "ok" : "error",
      },
      {
        action: "state.commit",
        outcome: commit.committed ? "ok" : "error",
        detail: `committed=${commit.stateCommitted ?? 0},rejected=${commit.stateRejected ?? 0}`,
      },
    ],
    stopReason: commit.committed
      ? "committed"
      : commit.reason ?? "commit_blocked",
    lineage: baseLineage(ctx, []),
    details: {},
  };

  return assertValid(
    "CommitResult",
    validateCommitResult(result),
    result,
  );
}
