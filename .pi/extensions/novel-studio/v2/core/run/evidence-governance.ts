/**
 * EVIDENCE-GOVERNANCE — 按 evidenceId 撤销与有效集重算（P6）
 *
 * 规则：
 * - 原始反馈记录保留；撤销只改有效集
 * - 不得删除成本/延迟/模型调用事实
 * - 按 evidenceId 定点撤销，不用 revertLastOutcome 作为生产核心语义
 */

import type { AuditEventStore } from "../audit/audit-event-store.js";
import type { RunAggregateRepository } from "./run-aggregate-repository.js";
import type { RunAggregate } from "./run-aggregate-types.js";

export interface RevokeEvidenceInput {
  evidenceId: string;
  reason: string;
  /** 可选：限定章节，防止误伤其他章节 */
  chapterId?: string;
  commandId?: string;
}

export interface RevokeEvidenceResult {
  ok: boolean;
  evidenceId: string;
  alreadyRevoked: boolean;
  aggregate: RunAggregate;
  eventId: string | null;
  reason?: string;
}

/**
 * 追加 evidence_revoked 并折叠聚合。
 * 先事件后聚合。
 */
export function revokeEvidence(
  store: AuditEventStore,
  repo: RunAggregateRepository,
  input: RevokeEvidenceInput,
): RevokeEvidenceResult {
  const current = repo.getAggregate();
  if (input.chapterId && current.chapterId !== input.chapterId) {
    return {
      ok: false,
      evidenceId: input.evidenceId,
      alreadyRevoked: false,
      aggregate: current,
      eventId: null,
      reason: `chapter mismatch: aggregate=${current.chapterId} input=${input.chapterId}`,
    };
  }
  if (current.revokedEvidenceIds.includes(input.evidenceId)) {
    return {
      ok: true,
      evidenceId: input.evidenceId,
      alreadyRevoked: true,
      aggregate: current,
      eventId: current.seenCommandIds[input.commandId ?? ""] ?? null,
    };
  }

  const { append, fold } = repo.appendEvent(store, {
    actor: "governance",
    stage: "recovery",
    eventType: "evidence_revoked",
    status: "completed",
    evidenceLevel: "confirmed",
    decisionReason: input.reason,
    payload: {
      evidenceId: input.evidenceId,
      commandId: input.commandId,
      chapterId: current.chapterId,
    },
  });

  return {
    ok: fold.ok,
    evidenceId: input.evidenceId,
    alreadyRevoked: false,
    aggregate: fold.aggregate,
    eventId: append.event.eventId,
    reason: fold.error?.message,
  };
}

/** 有效证据 = active − revoked（防御性） */
export function listActiveEvidenceIds(aggregate: RunAggregate): string[] {
  const revoked = new Set(aggregate.revokedEvidenceIds);
  return aggregate.activeEvidenceIds.filter((id) => !revoked.has(id));
}

/**
 * 判断 evidence 是否仍计入策略信誉。
 */
export function isEvidenceActive(
  aggregate: RunAggregate,
  evidenceId: string,
): boolean {
  if (aggregate.revokedEvidenceIds.includes(evidenceId)) return false;
  return aggregate.activeEvidenceIds.includes(evidenceId);
}
