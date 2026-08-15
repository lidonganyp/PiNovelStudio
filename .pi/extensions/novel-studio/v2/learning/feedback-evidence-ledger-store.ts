/**
 * Feedback Evidence Ledger Store — 用户反馈证据账本持久化
 *
 * USER-FEEDBACK-EVIDENCE-PIPELINE-1 Phase 4 生产接入：
 * - 账本是追加式真相源（observation / revoke / quarantine / pollute）
 * - strategy-policy.json 仍是运行时物化缓存；可由账本重算
 * - 反馈写入失败不得影响章节正文事务（调用方 try/catch）
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  FeedbackEvidenceLedgerEvent,
  FeedbackEvidenceObservation,
} from "./feedback-evidence-contracts.js";
import {
  recomputeAllStrategyReputations,
  recomputeStrategyReputation,
  materializeReputation,
} from "./strategy-reputation-recompute.js";
import type { StrategyPolicyStore } from "./strategy-policy-store.js";

export const FEEDBACK_LEDGER_SCHEMA_ID = "pinovel.feedback-evidence-ledger" as const;
export const FEEDBACK_LEDGER_SCHEMA_VERSION = "v1" as const;
export const FEEDBACK_LEDGER_FILE_NAME = "feedback-evidence-ledger.json";

export interface FeedbackEvidenceLedgerArtifact {
  schemaId: typeof FEEDBACK_LEDGER_SCHEMA_ID;
  schemaVersion: typeof FEEDBACK_LEDGER_SCHEMA_VERSION;
  workspaceId: string;
  events: FeedbackEvidenceLedgerEvent[];
  updatedAt: string;
}

export function feedbackEvidenceLedgerPath(
  workspaceId: string,
  projectRoot: string,
): string {
  return join(
    projectRoot,
    "workspaces",
    workspaceId,
    "strategy-evidence",
    FEEDBACK_LEDGER_FILE_NAME,
  );
}

function emptyArtifact(workspaceId: string): FeedbackEvidenceLedgerArtifact {
  return {
    schemaId: FEEDBACK_LEDGER_SCHEMA_ID,
    schemaVersion: FEEDBACK_LEDGER_SCHEMA_VERSION,
    workspaceId,
    events: [],
    updatedAt: new Date().toISOString(),
  };
}

export function loadFeedbackEvidenceLedger(
  workspaceId: string,
  projectRoot: string,
): FeedbackEvidenceLedgerArtifact {
  const path = feedbackEvidenceLedgerPath(workspaceId, projectRoot);
  if (!existsSync(path)) return emptyArtifact(workspaceId);
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as FeedbackEvidenceLedgerArtifact;
    if (
      raw.schemaId !== FEEDBACK_LEDGER_SCHEMA_ID ||
      raw.schemaVersion !== FEEDBACK_LEDGER_SCHEMA_VERSION ||
      raw.workspaceId !== workspaceId ||
      !Array.isArray(raw.events)
    ) {
      return emptyArtifact(workspaceId);
    }
    return raw;
  } catch {
    return emptyArtifact(workspaceId);
  }
}

export function saveFeedbackEvidenceLedger(
  artifact: FeedbackEvidenceLedgerArtifact,
  projectRoot: string,
): void {
  const path = feedbackEvidenceLedgerPath(artifact.workspaceId, projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const next: FeedbackEvidenceLedgerArtifact = {
    ...artifact,
    updatedAt: new Date().toISOString(),
  };
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
  renameSync(tmp, path);
}

/**
 * 追加账本事件（append-only）。
 * 同一 observation.evidenceId 已存在时返回 appended=false（幂等）。
 */
export function appendFeedbackEvidenceEvents(
  workspaceId: string,
  projectRoot: string,
  newEvents: FeedbackEvidenceLedgerEvent[],
): { appended: number; artifact: FeedbackEvidenceLedgerArtifact } {
  const artifact = loadFeedbackEvidenceLedger(workspaceId, projectRoot);
  const existingIds = new Set(
    artifact.events
      .filter((e): e is FeedbackEvidenceObservation => e.eventType === "observation")
      .map((e) => e.evidenceId),
  );
  const existingEventIds = new Set(
    artifact.events
      .filter((e) => e.eventType !== "observation")
      .map((e) => ("eventId" in e ? e.eventId : "")),
  );

  const toAppend: FeedbackEvidenceLedgerEvent[] = [];
  for (const event of newEvents) {
    if (event.eventType === "observation") {
      if (existingIds.has(event.evidenceId)) continue;
      existingIds.add(event.evidenceId);
      toAppend.push(event);
    } else {
      if (existingEventIds.has(event.eventId)) continue;
      existingEventIds.add(event.eventId);
      toAppend.push(event);
    }
  }

  if (toAppend.length === 0) {
    return { appended: 0, artifact };
  }

  const next: FeedbackEvidenceLedgerArtifact = {
    ...artifact,
    events: [...artifact.events, ...toAppend],
    updatedAt: new Date().toISOString(),
  };
  saveFeedbackEvidenceLedger(next, projectRoot);
  return { appended: toAppend.length, artifact: next };
}

/**
 * 从账本重算并物化到 StrategyPolicyStore（不改变人工 status，除非策略尚不存在）。
 */
export function materializePolicyFromFeedbackLedger(
  store: StrategyPolicyStore,
  workspaceId: string,
  projectRoot: string,
): number {
  const artifact = loadFeedbackEvidenceLedger(workspaceId, projectRoot);
  const recomputed = recomputeAllStrategyReputations(artifact.events);
  const computedKeys = new Set(
    recomputed.map((item) => `${item.modelVersion}::${item.strategyKey}`),
  );
  for (const item of recomputed) {
    const existing = store.getReputation(item.strategyKey, item.modelVersion);
    const next = materializeReputation(item, existing.status, {
      statusChangedAt: existing.statusChangedAt,
      statusReason: existing.statusReason,
    });
    store.putReputation(next);
  }

  // 孤儿策略复位：已物化但不再有有效证据（如唯一证据被 revoke/quarantine/pollute）
  // 的 strategyKey 应回到弱先验，避免残留旧信誉。status 保留（不自动晋级/退役）。
  for (const { modelVersion, strategyId } of store.listAllStrategyKeys()) {
    if (computedKeys.has(`${modelVersion}::${strategyId}`)) continue;
    const existing = store.getReputation(strategyId, modelVersion);
    const empty = recomputeStrategyReputation(artifact.events, modelVersion, strategyId);
    const reset = materializeReputation(empty, existing.status, {
      statusChangedAt: existing.statusChangedAt,
      statusReason: existing.statusReason,
    });
    store.putReputation(reset);
  }

  return recomputed.length;
}

/**
 * 从 RecordedOutcome 构造 observation 事件（生产反馈摄入用）。
 */
export function observationFromRecordedOutcome(input: {
  evidenceId: string;
  strategyId: string;
  modelVersion: string;
  sourceChapter: string;
  outcome: "win" | "loss" | "tie";
  weight: number;
  decisionCount?: number;
  feedbackLevel?: string;
  attributionConfidence?: string;
  strategyBundleId?: string;
  strategyIds?: string[];
  note?: string;
  lineage?: {
    orchestratorRunId?: string;
    candidateId?: string;
    strategyBundleId?: string;
    strategyId?: string;
    modelVersion?: string;
    promptBundleId?: string;
    deliveredSource?: "editorial" | "raw" | "fallback";
    exposureId?: string;
    feedbackEventId?: string;
    sourceChapter?: string;
  };
  recorded: boolean;
  nonLiterary?: boolean;
}): FeedbackEvidenceObservation | null {
  if (!input.recorded && input.outcome !== "tie") {
    // 未写入文学信誉的 neutral 仍可记 observation（审计），outcome 映射 neutral
  }

  const lineage = input.lineage ?? {};
  const strategyBundleId =
    input.strategyBundleId ??
    lineage.strategyBundleId ??
    `bundle:${input.strategyId}`;
  const feedbackLevel =
    (input.feedbackLevel as FeedbackEvidenceObservation["feedbackLevel"]) ??
    "explicit_direct";
  const mappedOutcome =
    !input.recorded || input.weight === 0
      ? "neutral"
      : input.outcome === "tie"
        ? "tie"
        : input.outcome;

  return {
    eventType: "observation",
    evidenceId: input.evidenceId,
    feedbackLevel,
    outcome: mappedOutcome,
    decisionCount: input.decisionCount ?? 1,
    weightedEvidence: input.weight,
    attributionConfidence:
      (input.attributionConfidence as FeedbackEvidenceObservation["attributionConfidence"]) ??
      "medium",
    lineage: {
      orchestratorRunId: lineage.orchestratorRunId ?? "unknown-run",
      candidateId: lineage.candidateId ?? "unknown-candidate",
      strategyBundleId,
      strategyId: lineage.strategyId ?? input.strategyId,
      modelVersion: lineage.modelVersion ?? input.modelVersion,
      promptBundleId: lineage.promptBundleId ?? "unknown-prompt",
      deliveredSource: lineage.deliveredSource ?? "editorial",
      exposureId: lineage.exposureId ?? "unknown-exposure",
      feedbackEventId: lineage.feedbackEventId ?? input.evidenceId,
      sourceChapter: lineage.sourceChapter ?? input.sourceChapter,
    },
    strategyBundleId,
    strategyIds: input.strategyIds ?? [input.strategyId],
    strategyId: input.strategyId,
    modelVersion: input.modelVersion,
    sourceChapter: input.sourceChapter,
    source: "user",
    timestamp: new Date().toISOString(),
    note: input.note,
    nonLiteraryCategory: input.nonLiterary ? "context" : undefined,
  };
}
