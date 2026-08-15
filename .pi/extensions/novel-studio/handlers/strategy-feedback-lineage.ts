/**
 * Strategy feedback lineage helpers for the public novel_strategy_feedback path.
 *
 * USER-FEEDBACK-EVIDENCE-PIPELINE-1:
 * - literary reputation updates require complete canonical lineage
 * - missing lineage => neutral / unattributed (no policy pollution)
 * - every recorded decision should append to the feedback evidence ledger
 */

import type { StrategyTraceContext } from "./strategy-feedback-trace-context.js";
import {
  isCompleteLineage,
  buildStrategyBundleId,
  type FeedbackLineage,
  type DeliveredSource,
} from "../v2/learning/feedback-evidence-contracts.js";
import {
  appendFeedbackEvidenceEvents,
  loadFeedbackEvidenceLedger,
  observationFromRecordedOutcome,
} from "../v2/learning/feedback-evidence-ledger-store.js";
import {
  isLineageCompleteForStrategyUpdate,
  type AgentLineageIndex,
} from "../v2/core/agent-lineage-index.js";
import {
  recomputeStrategyReputation,
  materializeReputation,
} from "../v2/learning/strategy-reputation-recompute.js";
import type { StrategyPolicyStore } from "../v2/learning/strategy-policy-store.js";

export interface FeedbackLineageInput {
  workspaceId: string;
  strategyId: string;
  modelVersion: string;
  sourceChapter: string;
  feedbackEventId: string;
  deliveredSource?: DeliveredSource;
  selectedStrategyIds?: string[];
  /** explicit overrides from tool input */
  orchestratorRunId?: string;
  candidateId?: string;
  strategyBundleId?: string;
  exposureId?: string;
  promptBundleId?: string;
  /** recovered from quality trace */
  traceContext?: StrategyTraceContext | null;
}

export interface ResolvedFeedbackLineage {
  complete: boolean;
  lineage: Partial<FeedbackLineage>;
  completeLineage?: FeedbackLineage;
  reason: string;
}

export function resolveFeedbackLineage(
  input: FeedbackLineageInput,
): ResolvedFeedbackLineage {
  const tc = input.traceContext ?? null;
  const strategyIds =
    input.selectedStrategyIds && input.selectedStrategyIds.length > 0
      ? input.selectedStrategyIds
      : tc?.selectedStrategyIds && tc.selectedStrategyIds.length > 0
        ? tc.selectedStrategyIds
        : [input.strategyId];

  const lineage: Partial<FeedbackLineage> = {
    orchestratorRunId:
      input.orchestratorRunId?.trim() || tc?.orchestratorRunId || undefined,
    candidateId: input.candidateId?.trim() || tc?.candidateId || undefined,
    strategyBundleId:
      input.strategyBundleId?.trim() ||
      tc?.strategyBundleId ||
      buildStrategyBundleId(strategyIds),
    strategyId: input.strategyId,
    modelVersion: input.modelVersion,
    promptBundleId:
      input.promptBundleId?.trim() || tc?.promptBundleId || undefined,
    deliveredSource:
      input.deliveredSource ||
      tc?.deliveredSource ||
      "editorial",
    exposureId: input.exposureId?.trim() || tc?.exposureId || undefined,
    feedbackEventId: input.feedbackEventId,
    sourceChapter: input.sourceChapter,
  };

  if (!isCompleteLineage(lineage as FeedbackLineage)) {
    return {
      complete: false,
      lineage,
      reason:
        "incomplete canonical lineage (need orchestratorRunId/candidateId/exposureId/promptBundleId/strategyBundleId)",
    };
  }

  // MA-5.2：若 trace 携带 agentLineageIndex，则额外要求 run/candidate 协作血缘完整
  // 才允许文学策略信誉更新；索引缺失时不阻断（旧 trace 兼容），仅完整索引下强制。
  const indexRaw = tc?.agentLineageIndex;
  const candidateId = lineage.candidateId;
  if (
    indexRaw &&
    typeof indexRaw === "object" &&
    !Array.isArray(indexRaw) &&
    typeof candidateId === "string" &&
    candidateId.trim()
  ) {
    const index = indexRaw as unknown as AgentLineageIndex;
    if (index.schema === "pinovel.agent-lineage-index") {
      const gate = isLineageCompleteForStrategyUpdate(index, candidateId);
      if (!gate.ok) {
        return {
          complete: false,
          lineage,
          reason: `agent lineage index incomplete for strategy update: ${gate.reasons.join("; ")}`,
        };
      }
    }
  }

  return {
    complete: true,
    lineage,
    completeLineage: lineage as FeedbackLineage,
    reason: "complete lineage from input/trace",
  };
}

/**
 * Append observation to ledger. Failures are swallowed by caller policy
 * (must not roll back chapter text). Returns append count.
 */
export function appendPublicFeedbackLedgerObservation(input: {
  workspaceId: string;
  projectRoot: string;
  strategyId: string;
  modelVersion: string;
  sourceChapter: string;
  outcome: "win" | "loss" | "tie";
  weight: number;
  decisionCount?: number;
  recorded: boolean;
  evidenceId: string;
  feedbackLevel?: string;
  attributionConfidence?: string;
  note?: string;
  lineage?: Partial<FeedbackLineage>;
  nonLiterary?: boolean;
}): { appended: number; error?: string } {
  try {
    const observation = observationFromRecordedOutcome({
      evidenceId: input.evidenceId,
      strategyId: input.strategyId,
      modelVersion: input.modelVersion,
      sourceChapter: input.sourceChapter,
      outcome: input.outcome,
      weight: input.weight,
      decisionCount: input.decisionCount ?? 1,
      feedbackLevel: input.feedbackLevel,
      attributionConfidence: input.attributionConfidence,
      strategyBundleId: input.lineage?.strategyBundleId,
      strategyIds: input.lineage?.strategyId
        ? [input.lineage.strategyId]
        : [input.strategyId],
      note: input.note,
      lineage: input.lineage,
      recorded: input.recorded,
      nonLiterary: input.nonLiterary,
    });
    if (!observation) return { appended: 0 };
    const result = appendFeedbackEvidenceEvents(
      input.workspaceId,
      input.projectRoot,
      [observation],
    );
    return { appended: result.appended };
  } catch (error) {
    return {
      appended: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Append revoke to ledger (symmetric with appendPublicFeedbackLedgerObservation).
 *
 * 生产 revert 路径（novel_strategy_feedback action=revert）不再只直写 strategy-policy.json：
 * 撤销后向账本追加 revoke 事件，保持账本为追加式真相源（observation + revoke 均落账本），
 * strategy-policy.json 可由账本重算。targetEvidenceId 必须等于观测写入时的 evidenceId
 * （即 store 前缀 evidenceId，如 `choice:…`），否则重算时无法定位到被撤销的观测。
 *
 * 幂等：eventId 缺省为 `revoke:<evidenceId>`（稳定），同一 evidenceId 重复撤销不重复落账本。
 */
export function appendPublicFeedbackLedgerRevoke(input: {
  workspaceId: string;
  projectRoot: string;
  evidenceId: string;
  reason?: string;
  commandId?: string;
}): { appended: number; error?: string } {
  try {
    const eventId = input.commandId ?? `revoke:${input.evidenceId}`;
    const result = appendFeedbackEvidenceEvents(
      input.workspaceId,
      input.projectRoot,
      [
        {
          eventType: "revoke",
          eventId,
          targetEvidenceId: input.evidenceId,
          reason: input.reason ?? "user revert via novel_strategy_feedback",
          timestamp: new Date().toISOString(),
        },
      ],
    );
    return { appended: result.appended };
  } catch (error) {
    return {
      appended: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildFeedbackEventId(input: {
  workspaceId: string;
  strategyId: string;
  action: string;
  chapterId?: string;
  explicitId?: string;
}): string {
  if (input.explicitId && input.explicitId.trim()) return input.explicitId.trim();
  const chapter = input.chapterId?.trim() || "noch";
  // stable-ish per call site without requiring caller uuid; seq via timestamp
  return `public:${input.workspaceId}:${chapter}:${input.strategyId}:${input.action}:${Date.now()}`;
}

/**
 * P6：撤销后从账本重算被撤销策略的信誉，统一「账本真相源」与「policy 投影」。
 *
 * 生产 revert 路径在追加 revoke 事件后调用本函数，把被撤销策略的信誉重算为
 * 账本推导值（而非只依赖 store 就地突变），避免 store 直写与账本重算两套真相源漂移。
 * 仅重算目标策略（strategyId + modelVersion），不触碰其他策略的历史数据，
 * 因此不触发 materializePolicyFromFeedbackLedger 的孤儿复位（那会清空账本之外的历史证据）。
 *
 * 状态（status/statusChangedAt/statusReason）保留；alpha/beta/sampleCount 由账本有效观察确定性重算。
 * 失败不阻断：返回 recomputed=false，调用方保留 store 就地突变结果。
 */
export function recomputeStrategyReputationFromLedger(input: {
  workspaceId: string;
  projectRoot: string;
  store: StrategyPolicyStore;
  strategyId: string;
  modelVersion: string;
}): { recomputed: boolean; sampleCount: number; error?: string } {
  try {
    const ledger = loadFeedbackEvidenceLedger(input.workspaceId, input.projectRoot);
    const recomputed = recomputeStrategyReputation(
      ledger.events,
      input.modelVersion,
      input.strategyId,
    );
    const existing = input.store.getReputation(input.strategyId, input.modelVersion);
    const materialized = materializeReputation(recomputed, existing.status, {
      statusChangedAt: existing.statusChangedAt,
      statusReason: existing.statusReason,
    });
    input.store.putReputation(materialized);
    return { recomputed: true, sampleCount: materialized.sampleCount };
  } catch (error) {
    return {
      recomputed: false,
      sampleCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
