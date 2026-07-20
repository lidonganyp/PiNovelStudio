/** G5 P1 declarative canary decision execution and trace recording. */
import type { EvolutionReleaseRegistry } from "./evolution-release-registry.js";
import type { ChangeClass, ReleaseStatus } from "./evolution-release-types.js";
import type { ReleaseHealthEvaluation } from "./release-health-evaluator.js";
import { executeAutoHold } from "./release-health-actions.js";
import type { CanaryPolicyDecision, CanaryStrategy } from "./canary-policy.js";
import { assertCanaryAuthorizes, type CanaryAuthorization } from "./canary-workspace-authorization.js";
import { CANARY_RUN_TRACE_SCHEMA_ID, CANARY_RUN_TRACE_SCHEMA_VERSION, type CanaryRunTrace, type CanaryTraceStore } from "./canary-trace-store.js";
import type { ReleasePointerStore } from "./release-pointer-store.js";

export interface ExecuteCanaryDecisionInput {
  decision: CanaryPolicyDecision;
  evaluation: ReleaseHealthEvaluation;
  releaseId: string;
  previousReleaseId: string | null;
  workspaceId: string;
  changeClass: ChangeClass;
  currentStatus: ReleaseStatus;
  authorization?: CanaryAuthorization;
  registry: EvolutionReleaseRegistry;
  traceStore: Pick<CanaryTraceStore, "writeCanaryTrace">;
  actor: "system" | "user";
  now?: string;
  runId?: string;
  /**
   * 可选：透传给 executeAutoHold，用于 hold 后清理指向该 release 的 active pointer（P1-3 修复）。
   *
   * canary 决策触发 auto-hold 时，与 cmdHealthSingle 走同一清理路径：
   * - dev pointer：system 可直接 rollback
   * - production pointer：system 无权回滚，标记悬挂 + warning
   *
   * 未提供时 executeAutoHold 保持原行为（向后兼容）。
   */
  pointerStore?: Pick<ReleasePointerStore, "readActive" | "rollback">;
}

export interface ExecuteCanaryDecisionResult {
  strategy: CanaryStrategy;
  blocked: boolean;
  blockedExitCode?: 5 | 6;
  autoHoldTriggered: boolean;
  trace?: CanaryRunTrace;
  errorReason?: string;
}

export function executeCanaryDecision(input: ExecuteCanaryDecisionInput): ExecuteCanaryDecisionResult {
  const strategy = input.decision.strategy;
  if (strategy === "skip" || strategy === "direct_promote") {
    return { strategy, blocked: false, autoHoldTriggered: false };
  }
  if (strategy === "bounded_canary") {
    if (!input.authorization || input.authorization.workspaceId !== input.workspaceId) {
      return { strategy, blocked: true, blockedExitCode: 6, autoHoldTriggered: false, errorReason: "REQUIRES_AUTH: matching workspace authorization required" };
    }
    try {
      assertCanaryAuthorizes(input.authorization, input.releaseId, { now: input.now });
    } catch (error) {
      return { strategy, blocked: true, blockedExitCode: 6, autoHoldTriggered: false, errorReason: error instanceof Error ? error.message : String(error) };
    }
  }
  let autoHoldTriggered = false;
  let autoHoldEventId: string | undefined;
  if (strategy === "blocked" && input.evaluation.status === "auto_hold_eligible") {
    // P1-3 修复：透传 pointerStore，让 executeAutoHold 清理指向 held release 的 active pointer
    const action = executeAutoHold(input.registry, input.evaluation, {
      actor: input.actor,
      ...(input.pointerStore ? { pointerStore: input.pointerStore } : {}),
    });
    autoHoldTriggered = action.held;
    autoHoldEventId = action.eventId;
  }
  const now = input.now ?? new Date().toISOString();
  const trace: CanaryRunTrace = {
    schemaId: CANARY_RUN_TRACE_SCHEMA_ID,
    schemaVersion: CANARY_RUN_TRACE_SCHEMA_VERSION,
    runId: input.runId ?? `canary-${input.releaseId}-${now.replace(/[^0-9A-Za-z]/g, "")}`,
    releaseId: input.releaseId,
    previousReleaseId: input.previousReleaseId,
    workspaceId: input.workspaceId,
    startedAt: now,
    completedAt: null,
    strategy,
    status: strategy === "shadow_required" ? "shadow_started" : strategy === "bounded_canary" ? "canary_started" : "blocked",
    healthSnapshot: {
      status: input.evaluation.status,
      alignmentRate: input.evaluation.evidence.alignmentRate,
      sampleCount: input.evaluation.evidence.sampleCount,
      rollbackRate: input.evaluation.evidence.rollbackRate,
      consecutiveNegative: input.evaluation.evidence.consecutiveNegative,
    },
    evidence: { changeClass: input.changeClass, currentStatus: input.currentStatus, ...(input.authorization ? { authorizationId: input.authorization.authorizationId } : {}) },
    outcome: { promoted: false, heldByAutoHold: autoHoldTriggered, ...(autoHoldEventId ? { autoHoldEventId } : {}) },
    shadowPendingRealRun: strategy === "shadow_required" || strategy === "bounded_canary",
  };
  try {
    input.traceStore.writeCanaryTrace(trace);
  } catch (error) {
    return { strategy, blocked: true, blockedExitCode: 5, autoHoldTriggered, errorReason: error instanceof Error ? error.message : String(error) };
  }
  return { strategy, blocked: strategy === "blocked", ...(strategy === "blocked" ? { blockedExitCode: 5 as const } : {}), autoHoldTriggered, trace };
}
