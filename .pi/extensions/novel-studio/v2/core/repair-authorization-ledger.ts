/**
 * RepairAuthorizationLedger — 修订授权一次性预算 reservation。
 *
 * 签发时绑定 authorizationId / candidateTextHash / snapshotId / expiresAt。
 * 执行前必须 consume：校验 hash/snapshot/expiresAt，且每张 reservation 只能用一次。
 */

import type { RepairAuthorization } from "./repair-authorization-contracts.js";

export type RepairReservationConsumeFailure =
  | "deny_missing_reservation"
  | "deny_reservation_consumed"
  | "deny_reservation_expired"
  | "stale_authorization";

export interface RepairReservationConsumeResult {
  ok: boolean;
  reasonCode?: RepairReservationConsumeFailure;
  reason?: string;
}

interface StoredReservation {
  reservationId: string;
  authorizationId: string;
  candidateTextHash: string;
  snapshotId: string;
  expiresAt: string;
  consumed: boolean;
}

export interface RepairAuthorizationLedger {
  register(authorization: RepairAuthorization): RepairAuthorization;
  consume(
    authorization: RepairAuthorization,
    currentCandidateTextHash: string,
    currentSnapshotId: string,
    nowMs?: number,
  ): RepairReservationConsumeResult;
}

function buildReservationId(authorizationId: string): string {
  return `resv-${authorizationId}`;
}

export function createRepairAuthorizationLedger(): RepairAuthorizationLedger {
  const reservations = new Map<string, StoredReservation>();

  return {
    register(authorization: RepairAuthorization): RepairAuthorization {
      const reservationId = authorization.budgetReservationId ?? buildReservationId(authorization.authorizationId);
      reservations.set(reservationId, {
        reservationId,
        authorizationId: authorization.authorizationId,
        candidateTextHash: authorization.candidateTextHash,
        snapshotId: authorization.snapshotId,
        expiresAt: authorization.expiresAt,
        consumed: false,
      });
      return {
        ...authorization,
        budgetReservationId: reservationId,
      };
    },

    consume(
      authorization: RepairAuthorization,
      currentCandidateTextHash: string,
      currentSnapshotId: string,
      nowMs?: number,
    ): RepairReservationConsumeResult {
      const reservationId = authorization.budgetReservationId;
      if (!reservationId) {
        return {
          ok: false,
          reasonCode: "deny_missing_reservation",
          reason: "授权缺少 budgetReservationId",
        };
      }
      const stored = reservations.get(reservationId);
      if (!stored) {
        return {
          ok: false,
          reasonCode: "deny_missing_reservation",
          reason: `reservation ${reservationId} 不存在`,
        };
      }
      if (stored.consumed) {
        return {
          ok: false,
          reasonCode: "deny_reservation_consumed",
          reason: `reservation ${reservationId} 已一次性消费`,
        };
      }
      if (
        stored.candidateTextHash !== currentCandidateTextHash
        || stored.snapshotId !== currentSnapshotId
        || stored.candidateTextHash !== authorization.candidateTextHash
        || stored.snapshotId !== authorization.snapshotId
        || stored.expiresAt !== authorization.expiresAt
      ) {
        return {
          ok: false,
          reasonCode: "stale_authorization",
          reason: "执行时 candidateTextHash / snapshotId / expiresAt 与 reservation 不一致",
        };
      }
      const expiresMs = Date.parse(stored.expiresAt);
      const now = nowMs ?? Date.now();
      if (!stored.expiresAt || Number.isNaN(expiresMs) || expiresMs <= now) {
        return {
          ok: false,
          reasonCode: "deny_reservation_expired",
          reason: `reservation ${reservationId} 已过期或 expiresAt 无效`,
        };
      }
      stored.consumed = true;
      reservations.set(reservationId, stored);
      return { ok: true };
    },
  };
}
