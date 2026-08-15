/**
 * EVIDENCE-LEARNING-BRIDGE — RunAggregate evidence_revoked → 学习投影重算（P6 tail）
 *
 * 统一「治理撤销」与「学习侧信誉重算」两套真相源：
 *   1. 先追加 RunAggregate 审计事件 evidence_revoked（治理真相源）
 *   2. 再向 feedback-evidence-ledger 追加 revoke 变更事件（学习原始真相源）
 *   3. 最后从 ledger 重建 strategy-policy.json（Learning 投影）
 *
 * 规则：
 * - 治理撤销成功才传播学习侧；学习侧失败不阻断审计撤销（记录 learningError）
 * - 不删除原始反馈 observation，只追加 revoke（evidenceId 可撤销）
 * - 撤销幂等：同一 commandId / evidenceId 不重复追加 revoke 事件
 */

import { revokeEvidence } from "./evidence-governance.js";
import type {
  RevokeEvidenceInput,
  RevokeEvidenceResult,
} from "./evidence-governance.js";
import type { AuditEventStore } from "../audit/audit-event-store.js";
import type { RunAggregateRepository } from "./run-aggregate-repository.js";
import {
  loadStrategyPolicyStore,
  saveStrategyPolicyStore,
  materializePolicyFromFeedbackLedger,
  appendFeedbackEvidenceEvents,
} from "../../learning/strategy-policy-store.js";
import type { FeedbackEvidenceMutationEvent } from "../../learning/feedback-evidence-contracts.js";

export interface RevokeEvidenceWithLearningInput extends RevokeEvidenceInput {
  /** 工作区根（跨模块真相源统一） */
  projectRoot: string;
  workspaceId: string;
}

export interface RevokeEvidenceWithLearningResult extends RevokeEvidenceResult {
  /** 学习侧账本是否追加了 revoke 事件 */
  ledgerRevoked: boolean;
  /** 从 ledger 重建并物化的策略信誉条数 */
  policyMaterialized: number;
  /** 学习侧传播错误（不阻断审计撤销） */
  learningError?: string;
}

/**
 * 治理撤销 + 学习投影重算的统一入口。
 * 同步执行：审计事件 → ledger revoke → policy 重建。
 */
export function revokeEvidenceWithLearningRecompute(
  store: AuditEventStore,
  repo: RunAggregateRepository,
  input: RevokeEvidenceWithLearningInput,
): RevokeEvidenceWithLearningResult {
  const { projectRoot, workspaceId, ...revokeInput } = input;
  const revoked = revokeEvidence(store, repo, revokeInput);

  let ledgerRevoked = false;
  let policyMaterialized = 0;
  let learningError: string | undefined;

  if (revoked.ok && !revoked.alreadyRevoked) {
    try {
      const eventId = input.commandId ?? `revoke:${input.evidenceId}`;
      const event: FeedbackEvidenceMutationEvent = {
        eventType: "revoke",
        eventId,
        targetEvidenceId: input.evidenceId,
        reason: input.reason,
        timestamp: new Date().toISOString(),
      };
      const { appended } = appendFeedbackEvidenceEvents(workspaceId, projectRoot, [
        event,
      ]);
      ledgerRevoked = appended > 0;

      const policyStore = loadStrategyPolicyStore(workspaceId, projectRoot);
      policyMaterialized = materializePolicyFromFeedbackLedger(
        policyStore,
        workspaceId,
        projectRoot,
      );
      saveStrategyPolicyStore(policyStore, workspaceId, projectRoot);
    } catch (err) {
      learningError = err instanceof Error ? err.message : String(err);
    }
  }

  return { ...revoked, ledgerRevoked, policyMaterialized, learningError };
}
