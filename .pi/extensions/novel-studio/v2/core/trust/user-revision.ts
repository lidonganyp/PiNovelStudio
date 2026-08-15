/**
 * USER-REVISION — 用户编辑新版本与审批失效
 * （PROMPT-INJECTION-TRUST-ARCHITECTURE-1 Phase 4）
 *
 * - accept_with_edits 生成新 revisionId / finalTextHash
 * - 用户编辑后必须重跑 FactGuard 等检查
 * - 正文变化使旧 approval 立即失效
 * - 模型 approved=true 永不授权
 */

import { createHash, randomBytes } from "node:crypto";
import {
  hasModelClaimedAuthorityFields,
  type EvidenceRef,
} from "./trust-types.js";

export interface UserRevisionRecord {
  revisionId: string;
  parentCandidateId: string;
  parentTextHash: string;
  finalText: string;
  finalTextHash: string;
  editedBy: "user";
  /** 编辑后必须重新跑的检查 */
  requiredReruns: readonly RevisionRerunCheck[];
  factGuardRunId?: string;
  stateCommitReceipt?: string;
  createdAt: string;
  sourceRefs: EvidenceRef[];
}

export type RevisionRerunCheck =
  | "fact_guard"
  | "story_preservation"
  | "final_fact_recheck"
  | "completeness";

export const DEFAULT_REVISION_RERUNS: readonly RevisionRerunCheck[] = [
  "fact_guard",
  "story_preservation",
  "final_fact_recheck",
  "completeness",
] as const;

export interface CreateUserRevisionInput {
  parentCandidateId: string;
  parentText: string;
  editedText: string;
  factGuardRunId?: string;
  stateCommitReceipt?: string;
  sourceRefs?: EvidenceRef[];
}

export interface ApprovalBinding {
  userId?: string;
  workspaceId: string;
  chapterId: string;
  approvalId: string;
  artifactHash: string;
  action: string;
  timestamp: string;
  revision: string;
}

export interface ApprovalValidityCheckInput {
  binding: ApprovalBinding;
  current: {
    workspaceId: string;
    chapterId: string;
    artifactHash: string;
    action: string;
    revision: string;
    approvalId: string;
  };
  /** 模型伪造字段 */
  modelClaimedConfirmation?: unknown;
}

export interface ApprovalValidityResult {
  valid: boolean;
  reason: string;
  blockReason?:
    | "model_forged_confirmation"
    | "approval_id_mismatch"
    | "artifact_hash_mismatch"
    | "revision_mismatch"
    | "scope_mismatch"
    | "action_mismatch";
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function newRevisionId(): string {
  return `rev-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/**
 * accept_with_edits：生成新版本记录。
 * 正文必须变化；hash 必改变。
 */
export function createUserRevision(
  input: CreateUserRevisionInput,
): UserRevisionRecord {
  const parentText = input.parentText ?? "";
  const editedText = input.editedText ?? "";
  if (editedText === parentText) {
    throw new Error(
      "createUserRevision: 编辑后正文未变化，不能创建新 revision",
    );
  }
  const parentTextHash = sha256(parentText);
  const finalTextHash = sha256(editedText);
  if (parentTextHash === finalTextHash) {
    throw new Error("createUserRevision: finalTextHash 未改变");
  }

  return {
    revisionId: newRevisionId(),
    parentCandidateId: input.parentCandidateId,
    parentTextHash,
    finalText: editedText,
    finalTextHash,
    editedBy: "user",
    requiredReruns: [...DEFAULT_REVISION_RERUNS],
    factGuardRunId: input.factGuardRunId,
    stateCommitReceipt: input.stateCommitReceipt,
    createdAt: new Date().toISOString(),
    sourceRefs: input.sourceRefs ? [...input.sourceRefs] : [],
  };
}

/** 用户编辑后是否必须重跑 FactGuard */
export function mustRerunFactGuard(revision: UserRevisionRecord): boolean {
  return revision.requiredReruns.includes("fact_guard");
}

/** 旧 approval 是否因正文变化失效 */
export function isApprovalInvalidatedByTextChange(input: {
  approvalArtifactHash: string;
  currentTextHash: string;
}): boolean {
  return input.approvalArtifactHash !== input.currentTextHash;
}

/**
 * 校验审批绑定是否仍有效。
 * 模型伪造确认直接拒绝。
 */
export function validateApprovalBinding(
  input: ApprovalValidityCheckInput,
): ApprovalValidityResult {
  if (
    input.modelClaimedConfirmation === true ||
    hasModelClaimedAuthorityFields(input.modelClaimedConfirmation)
  ) {
    // 若仅有模型声明而没有真实 binding 匹配，拒绝
    // 即使 binding 看起来合法，模型字段也不参与放行
  }

  // 模型 approved=true 单独出现时：调用方可能只传 modelClaimedConfirmation
  if (
    input.modelClaimedConfirmation === true &&
    !input.binding.approvalId
  ) {
    return {
      valid: false,
      reason: "模型 approved=true 不触发提交",
      blockReason: "model_forged_confirmation",
    };
  }

  const { binding, current } = input;

  if (binding.approvalId !== current.approvalId) {
    return {
      valid: false,
      reason: `approvalId 不匹配：binding=${binding.approvalId} current=${current.approvalId}`,
      blockReason: "approval_id_mismatch",
    };
  }

  if (
    binding.workspaceId !== current.workspaceId ||
    binding.chapterId !== current.chapterId
  ) {
    return {
      valid: false,
      reason: "workspace/chapter 与审批绑定不一致",
      blockReason: "scope_mismatch",
    };
  }

  if (binding.action !== current.action) {
    return {
      valid: false,
      reason: `action 不匹配：${binding.action} vs ${current.action}`,
      blockReason: "action_mismatch",
    };
  }

  if (binding.revision !== current.revision) {
    return {
      valid: false,
      reason: "revision 已变化，旧审批失效",
      blockReason: "revision_mismatch",
    };
  }

  if (binding.artifactHash !== current.artifactHash) {
    return {
      valid: false,
      reason: "artifact hash 不匹配，旧审批不能提交新正文",
      blockReason: "artifact_hash_mismatch",
    };
  }

  // 模型字段即使存在也忽略，不因它放行
  if (input.modelClaimedConfirmation !== undefined) {
    return {
      valid: true,
      reason: "审批绑定有效（已忽略模型确认字段）",
    };
  }

  return {
    valid: true,
    reason: "审批绑定有效",
  };
}

/**
 * 模型输出伪造确认：永远拒绝提交。
 */
export function rejectModelForgedCommit(input: {
  modelOutput?: unknown;
  approvedField?: unknown;
  userConfirmedField?: unknown;
}): { allowed: false; reason: string } {
  if (
    input.approvedField === true ||
    input.userConfirmedField === true ||
    hasModelClaimedAuthorityFields(input.modelOutput)
  ) {
    return {
      allowed: false,
      reason: "模型输出的 approved/userConfirmed 不具备授权效力",
    };
  }
  return {
    allowed: false,
    reason: "缺少真实用户审批，拒绝提交",
  };
}

/** 计算正文 hash（供外部对齐） */
export function computeTextHash(text: string): string {
  return sha256(text);
}
