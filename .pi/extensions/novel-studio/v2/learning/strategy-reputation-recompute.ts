/**
 * Strategy Reputation Recompute — 从证据账本确定性重算信誉
 *
 * 真相源：docs/user-feedback-evidence-pipeline-development-plan.md §Phase 4
 *
 * 不变量：
 * - evidence ledger 是唯一真相源
 * - strategy-policy.json 只是可重建的运行时物化缓存
 * - revoked / quarantined / polluted 不参与重算
 * - decisionCount 计真实决策数；weightedEvidence 只影响 alpha/beta 幅度
 * - 纯函数：不读写文件、不调用模型
 */

import {
  WEAK_PRIOR_ALPHA,
  WEAK_PRIOR_BETA,
  type StrategyEvidence,
  type StrategyReputation,
  type StrategyStatus,
} from "./strategy-policy-store.js";
import type {
  FeedbackEvidenceLedgerEvent,
  FeedbackEvidenceObservation,
  FeedbackOutcome,
} from "./feedback-evidence-contracts.js";

// ============================================================================
// Effective observation view
// ============================================================================

export interface EffectiveObservation {
  evidenceId: string;
  strategyKey: string;
  modelVersion: string;
  outcome: Exclude<FeedbackOutcome, "neutral">;
  decisionCount: number;
  weightedEvidence: number;
  sourceChapter: string;
  source: "judge" | "user";
  timestamp: string;
  note?: string;
  feedbackLevel?: string;
  strategyBundleId?: string;
  strategyId?: string;
}

export interface RecomputeScope {
  modelVersion?: string;
  /** strategyId 或 strategyBundleId */
  strategyKey?: string;
}

export interface RecomputedReputation {
  strategyKey: string;
  modelVersion: string;
  alpha: number;
  beta: number;
  /** 真实独立决策数（decisionCount 累加） */
  sampleCount: number;
  /** 加权证据量（仅审计，不等于 sampleCount） */
  weightedEvidenceTotal: number;
  consecutiveLosses: number;
  evidence: StrategyEvidence[];
  lastUpdated: string;
}

// ============================================================================
// Ledger → effective view
// ============================================================================

function isObservation(
  event: FeedbackEvidenceLedgerEvent,
): event is FeedbackEvidenceObservation {
  return event.eventType === "observation";
}

/**
 * 从完整账本计算有效观察视图。
 * 后续 revoke/quarantine/pollute 事件会使对应 evidenceId 失效。
 */
export function buildEffectiveObservations(
  ledger: readonly FeedbackEvidenceLedgerEvent[],
): EffectiveObservation[] {
  const observations = new Map<string, FeedbackEvidenceObservation>();
  const revoked = new Set<string>();
  const quarantined = new Set<string>();
  const polluted = new Set<string>();

  for (const event of ledger) {
    if (isObservation(event)) {
      observations.set(event.evidenceId, event);
      continue;
    }
    if (event.eventType === "revoke") {
      revoked.add(event.targetEvidenceId);
    } else if (event.eventType === "quarantine") {
      quarantined.add(event.targetEvidenceId);
    } else if (event.eventType === "pollute") {
      polluted.add(event.targetEvidenceId);
    }
    // resolve_conflict 不自动恢复；需显式新 observation 或解除 quarantine 事件（未来扩展）
  }

  const effective: EffectiveObservation[] = [];
  for (const obs of observations.values()) {
    if (revoked.has(obs.evidenceId)) continue;
    if (quarantined.has(obs.evidenceId)) continue;
    if (polluted.has(obs.evidenceId)) continue;
    if (obs.outcome === "neutral") continue;
    // non-literary categories never enter literary reputation
    if (obs.nonLiteraryCategory) continue;
    if (
      obs.feedbackLevel === "natural_language_unattributed" ||
      obs.feedbackLevel === "mechanical_signal" ||
      obs.feedbackLevel === "implicit_accept" ||
      obs.feedbackLevel === "conflicted_or_revoked"
    ) {
      continue;
    }

    const strategyKey =
      obs.strategyId ??
      obs.strategyBundleId ??
      (obs.strategyIds.length === 1 ? obs.strategyIds[0] : obs.strategyBundleId);

    if (!strategyKey) continue;

    effective.push({
      evidenceId: obs.evidenceId,
      strategyKey,
      modelVersion: obs.modelVersion,
      outcome: obs.outcome,
      decisionCount: Math.max(1, obs.decisionCount || 1),
      weightedEvidence: Math.max(0, obs.weightedEvidence || 0),
      sourceChapter: obs.sourceChapter,
      source: obs.source === "judge" ? "judge" : "user",
      timestamp: obs.timestamp,
      note: obs.note,
      feedbackLevel: obs.feedbackLevel,
      strategyBundleId: obs.strategyBundleId,
      strategyId: obs.strategyId,
    });
  }

  // 稳定排序：timestamp + evidenceId
  effective.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0;
  });

  return effective;
}

// ============================================================================
// Recompute
// ============================================================================

/**
 * 从有效观察确定性重算某一 strategyKey + modelVersion 的信誉。
 */
export function recomputeStrategyReputation(
  ledger: readonly FeedbackEvidenceLedgerEvent[],
  modelVersion: string,
  strategyKey: string,
): RecomputedReputation {
  const effective = buildEffectiveObservations(ledger).filter(
    (o) => o.modelVersion === modelVersion && o.strategyKey === strategyKey,
  );

  let alpha = WEAK_PRIOR_ALPHA;
  let beta = WEAK_PRIOR_BETA;
  let sampleCount = 0;
  let weightedEvidenceTotal = 0;
  let consecutiveLosses = 0;
  const evidence: StrategyEvidence[] = [];
  let lastUpdated = new Date(0).toISOString();

  for (const obs of effective) {
    const w = obs.weightedEvidence;
    weightedEvidenceTotal += w;
    // decisionCount 计真实决策数；一次重度修改只算 1
    sampleCount += obs.decisionCount;

    if (obs.outcome === "win") {
      alpha += w;
      consecutiveLosses = 0;
    } else if (obs.outcome === "loss") {
      beta += w;
      consecutiveLosses += obs.decisionCount;
    } else {
      // tie
      alpha += w * 0.5;
      beta += w * 0.5;
    }

    evidence.push({
      sourceChapter: obs.sourceChapter,
      outcome: obs.outcome,
      source: obs.source,
      weight: w,
      timestamp: obs.timestamp,
      note: obs.note,
      evidenceId: obs.evidenceId,
      decisionCount: obs.decisionCount,
      strategyBundleId: obs.strategyBundleId,
      feedbackLevel: obs.feedbackLevel,
    });

    if (obs.timestamp > lastUpdated) lastUpdated = obs.timestamp;
  }

  if (effective.length === 0) {
    lastUpdated = new Date().toISOString();
  }

  return {
    strategyKey,
    modelVersion,
    alpha,
    beta,
    sampleCount,
    weightedEvidenceTotal,
    consecutiveLosses,
    evidence,
    lastUpdated,
  };
}

/**
 * 批量重算 scope 内所有 strategyKey。
 */
export function recomputeAllStrategyReputations(
  ledger: readonly FeedbackEvidenceLedgerEvent[],
  scope: RecomputeScope = {},
): RecomputedReputation[] {
  const effective = buildEffectiveObservations(ledger).filter((o) => {
    if (scope.modelVersion && o.modelVersion !== scope.modelVersion) return false;
    if (scope.strategyKey && o.strategyKey !== scope.strategyKey) return false;
    return true;
  });

  const keys = new Map<string, { modelVersion: string; strategyKey: string }>();
  for (const o of effective) {
    keys.set(`${o.modelVersion}::${o.strategyKey}`, {
      modelVersion: o.modelVersion,
      strategyKey: o.strategyKey,
    });
  }

  const results: RecomputedReputation[] = [];
  for (const { modelVersion, strategyKey } of keys.values()) {
    results.push(recomputeStrategyReputation(ledger, modelVersion, strategyKey));
  }

  results.sort((a, b) => {
    if (a.modelVersion !== b.modelVersion) {
      return a.modelVersion < b.modelVersion ? -1 : 1;
    }
    return a.strategyKey < b.strategyKey ? -1 : a.strategyKey > b.strategyKey ? 1 : 0;
  });

  return results;
}

/**
 * 将重算结果物化为 StrategyReputation（保留已有 status，不自动晋级/退役）。
 */
export function materializeReputation(
  recomputed: RecomputedReputation,
  existingStatus: StrategyStatus = "candidate",
  statusMeta?: { statusChangedAt?: string; statusReason?: string },
): StrategyReputation {
  return {
    strategyId: recomputed.strategyKey,
    modelVersion: recomputed.modelVersion,
    alpha: recomputed.alpha,
    beta: recomputed.beta,
    sampleCount: recomputed.sampleCount,
    consecutiveLosses: recomputed.consecutiveLosses,
    status: existingStatus,
    statusChangedAt: statusMeta?.statusChangedAt,
    statusReason: statusMeta?.statusReason,
    evidence: recomputed.evidence,
    lastUpdated: recomputed.lastUpdated,
    weightedEvidenceTotal: recomputed.weightedEvidenceTotal,
  };
}

/**
 * 比较增量更新与完整重算是否一致（验收用）。
 */
export function reputationsMatch(
  a: Pick<StrategyReputation, "alpha" | "beta" | "sampleCount" | "consecutiveLosses">,
  b: Pick<RecomputedReputation, "alpha" | "beta" | "sampleCount" | "consecutiveLosses">,
  epsilon = 1e-9,
): boolean {
  return (
    Math.abs(a.alpha - b.alpha) <= epsilon &&
    Math.abs(a.beta - b.beta) <= epsilon &&
    a.sampleCount === b.sampleCount &&
    a.consecutiveLosses === b.consecutiveLosses
  );
}
