/**
 * ACTION-APPROVAL-RECEIPT — 正式审批对象（P2）。
 *
 * 真相源：delete/任务列表/项目计划20260812-2.md §4-P2 / §4-P4
 *
 * 用完整审批对象替代单独的布尔确认和时间戳判断。
 * 三类审批语义不得混用：
 * 1. 章节代理审批 approvalId（proxy）
 * 2. 用户最终提交 approvalId（user_commit）
 * 3. release 治理审批 artifact（release）
 *
 * 设计：
 * - canonical hash 稳定、append-only
 * - 旧审批不能作用于新正文 / 跨 workspace / 跨 chapter
 * - actor 由可信宿主注入，模型不能伪造 actor=user
 * - 提交成功后才消费；失败不消费
 */

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import type {
  ActionName,
  ActorType,
  AuthorizationResultCode,
} from "../core/control-types.js";
import { computeArtifactHash } from "../core/autonomy-policy.js";
import {
  hasModelClaimedAuthorityFields,
} from "../core/trust/trust-types.js";
import { emitTrustAuditEvent } from "../core/trust/trust-audit.js";
import {
  isApprovalInvalidatedByTextChange,
  validateApprovalBinding,
} from "../core/trust/user-revision.js";

// ============================================================================
// Types
// ============================================================================

export const ACTION_APPROVAL_RECEIPT_SCHEMA_ID =
  "pinovel.action-approval-receipt" as const;
export const ACTION_APPROVAL_RECEIPT_SCHEMA_VERSION = 1 as const;

/** 审批语义类别：禁止三类混用同一对象 */
export type ApprovalReceiptKind =
  | "user_commit"
  | "chapter_proxy"
  | "release_governance";

export type ApprovalDecision = "approve" | "reject" | "rollback" | "inspect";

export type RequiredCheckName =
  | "fact_guard"
  | "story_preservation"
  | "completeness"
  | "pending_bound"
  | "revision_match"
  | "artifact_hash_match";

export interface ActionApprovalReceipt {
  schemaId: typeof ACTION_APPROVAL_RECEIPT_SCHEMA_ID;
  schemaVersion: typeof ACTION_APPROVAL_RECEIPT_SCHEMA_VERSION;
  /** 审批对象规范 hash（不含 receiptHash 自身） */
  receiptHash: string;
  workspaceId: string;
  chapterId: string;
  action: ActionName;
  kind: ApprovalReceiptKind;
  artifactHash: string;
  revision: string;
  approvalId: string;
  /** 由可信宿主注入；模型输入不得覆盖 */
  actor: ActorType;
  issuedAt: string;
  expiresAt: string;
  requiredChecks: RequiredCheckName[];
  scope: {
    workspaceId: string;
    chapterId: string;
    taskId?: string;
    batchJobId?: string;
  };
  taskId: string;
  decision: ApprovalDecision;
  /** 是否已消费（一次性授权） */
  consumed: boolean;
  consumedAt?: string;
}

export interface CreateActionApprovalReceiptInput {
  workspaceId: string;
  chapterId: string;
  action: ActionName;
  kind?: ApprovalReceiptKind;
  artifactHash: string;
  revision: string;
  approvalId?: string;
  actor: ActorType;
  issuedAt?: string;
  /** 有效期毫秒；默认 24h */
  ttlMs?: number;
  requiredChecks?: RequiredCheckName[];
  taskId: string;
  batchJobId?: string;
  decision: ApprovalDecision;
}

export interface AuthorizeCommitActionInput {
  receipt: ActionApprovalReceipt;
  /** 当前待提交正文（用于重新计算 hash） */
  finalText: string;
  workspaceId: string;
  chapterId: string;
  action: ActionName;
  revision: string;
  /** 已完成的检查 */
  completedChecks?: ReadonlySet<RequiredCheckName> | RequiredCheckName[];
  /** 当前时间（测试可注入） */
  now?: Date;
  /**
   * 模型侧伪造字段；若出现，明确拒绝并记录，不视为用户批准。
   */
  modelClaimedConfirmation?: unknown;
  /** 期望的 actor（默认 orchestrator 执行 + receipt.actor=user） */
  executorActor?: ActorType;
}

export interface AuthorizeCommitActionResult {
  allowed: boolean;
  reason: string;
  blockReason?: AuthorizationResultCode;
  receiptHash: string;
  artifactHash: string;
}

// ============================================================================
// Canonical hash
// ============================================================================

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalPayload(
  receipt: Omit<ActionApprovalReceipt, "receiptHash">,
): Record<string, unknown> {
  return {
    schemaId: receipt.schemaId,
    schemaVersion: receipt.schemaVersion,
    workspaceId: receipt.workspaceId,
    chapterId: receipt.chapterId,
    action: receipt.action,
    kind: receipt.kind,
    artifactHash: receipt.artifactHash,
    revision: receipt.revision,
    approvalId: receipt.approvalId,
    actor: receipt.actor,
    issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt,
    requiredChecks: [...receipt.requiredChecks].sort(),
    scope: {
      workspaceId: receipt.scope.workspaceId,
      chapterId: receipt.scope.chapterId,
      taskId: receipt.scope.taskId ?? null,
      batchJobId: receipt.scope.batchJobId ?? null,
    },
    taskId: receipt.taskId,
    decision: receipt.decision,
    // consumed 不参与 hash：消费状态可变，身份不变
  };
}

export function computeReceiptHash(
  receipt: Omit<ActionApprovalReceipt, "receiptHash">,
): string {
  return createHash("sha256")
    .update(stableStringify(canonicalPayload(receipt)), "utf8")
    .digest("hex");
}

function newApprovalId(): string {
  return `uar-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

// ============================================================================
// Create / validate
// ============================================================================

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 创建用户定稿审批对象。
 * actor 必须由可信宿主注入；若 actor=model 直接抛错（不能伪造用户）。
 */
export function createActionApprovalReceipt(
  input: CreateActionApprovalReceiptInput,
): ActionApprovalReceipt {
  if (input.actor === "model") {
    throw new Error(
      "createActionApprovalReceipt: actor=model 禁止；审批对象不能由模型伪造用户身份",
    );
  }
  if (!input.artifactHash?.trim()) {
    throw new Error("createActionApprovalReceipt: artifactHash 必填");
  }
  if (!input.revision?.trim()) {
    throw new Error("createActionApprovalReceipt: revision 必填");
  }
  if (!input.workspaceId?.trim() || !input.chapterId?.trim()) {
    throw new Error("createActionApprovalReceipt: workspaceId/chapterId 必填");
  }

  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.parse(issuedAt) + ttlMs).toISOString();
  const kind = input.kind ?? "user_commit";
  const requiredChecks = input.requiredChecks ?? [
    "fact_guard",
    "story_preservation",
    "completeness",
    "pending_bound",
    "revision_match",
    "artifact_hash_match",
  ];

  const base: Omit<ActionApprovalReceipt, "receiptHash"> = {
    schemaId: ACTION_APPROVAL_RECEIPT_SCHEMA_ID,
    schemaVersion: ACTION_APPROVAL_RECEIPT_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    action: input.action,
    kind,
    artifactHash: input.artifactHash,
    revision: input.revision,
    approvalId: input.approvalId ?? newApprovalId(),
    actor: input.actor,
    issuedAt,
    expiresAt,
    requiredChecks: [...requiredChecks],
    scope: {
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      taskId: input.taskId,
      batchJobId: input.batchJobId,
    },
    taskId: input.taskId,
    decision: input.decision,
    consumed: false,
  };

  return {
    ...base,
    receiptHash: computeReceiptHash(base),
  };
}

export function validateActionApprovalReceipt(
  receipt: ActionApprovalReceipt,
): string[] {
  const errors: string[] = [];
  if (receipt.schemaId !== ACTION_APPROVAL_RECEIPT_SCHEMA_ID) {
    errors.push("schemaId 不匹配");
  }
  if (receipt.schemaVersion !== ACTION_APPROVAL_RECEIPT_SCHEMA_VERSION) {
    errors.push("schemaVersion 不匹配");
  }
  if (receipt.actor === "model") {
    errors.push("actor=model 非法");
  }
  if (!receipt.artifactHash?.trim()) errors.push("artifactHash 缺失");
  if (!receipt.revision?.trim()) errors.push("revision 缺失");
  if (!receipt.approvalId?.trim()) errors.push("approvalId 缺失");
  if (!receipt.workspaceId?.trim()) errors.push("workspaceId 缺失");
  if (!receipt.chapterId?.trim()) errors.push("chapterId 缺失");

  const { receiptHash: _ignored, consumed: _c, consumedAt: _ca, ...rest } =
    receipt;
  const expected = computeReceiptHash(
    rest as Omit<ActionApprovalReceipt, "receiptHash">,
  );
  // recompute with full base including consumed=false identity fields
  const base: Omit<ActionApprovalReceipt, "receiptHash"> = {
    schemaId: receipt.schemaId,
    schemaVersion: receipt.schemaVersion,
    workspaceId: receipt.workspaceId,
    chapterId: receipt.chapterId,
    action: receipt.action,
    kind: receipt.kind,
    artifactHash: receipt.artifactHash,
    revision: receipt.revision,
    approvalId: receipt.approvalId,
    actor: receipt.actor,
    issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt,
    requiredChecks: receipt.requiredChecks,
    scope: receipt.scope,
    taskId: receipt.taskId,
    decision: receipt.decision,
    consumed: false,
  };
  const hash = computeReceiptHash(base);
  if (receipt.receiptHash !== hash) {
    errors.push("receiptHash 校验失败");
  }
  // silence unused
  void expected;
  void _ignored;
  void _c;
  void _ca;
  return errors;
}

// ============================================================================
// authorizeCommitAction
// ============================================================================

function asCheckSet(
  checks?: ReadonlySet<RequiredCheckName> | RequiredCheckName[],
): Set<RequiredCheckName> {
  if (!checks) return new Set();
  if (checks instanceof Set) return new Set(checks);
  return new Set(checks);
}

/**
 * 正式提交前统一授权校验。
 *
 * 检查顺序：
 * 1. 模型伪造确认字段忽略并拒绝（若仅凭该字段）
 * 2. receipt 结构 / hash
 * 3. executor actor 必须为可信编排器
 * 4. receipt.actor 必须为 user（用户授权）或 system（系统任务授权）
 * 5. action / workspace / chapter 匹配
 * 6. revision 匹配
 * 7. artifact hash 匹配当前正文
 * 8. 未过期
 * 9. 未消费
 * 10. required checks 完成
 * 11. decision 必须为 approve（reject/inspect 不得 commit）
 */
export function authorizeCommitAction(
  input: AuthorizeCommitActionInput,
): AuthorizeCommitActionResult {
  const {
    receipt,
    finalText,
    workspaceId,
    chapterId,
    action,
    revision,
    now = new Date(),
    executorActor = "orchestrator",
  } = input;

  const currentHash = computeArtifactHash(finalText);

  // 模型输出确认字段永不授权（即使 receipt.actor 非 model）
  if (
    input.modelClaimedConfirmation === true ||
    hasModelClaimedAuthorityFields(input.modelClaimedConfirmation)
  ) {
    if (receipt.actor === "model" || input.modelClaimedConfirmation === true) {
      emitTrustAuditEvent({
        decisionType: "model_claim_ignored",
        allowed: false,
        reason: "模型伪造 confirm/approved 不视为用户批准",
        workspaceId,
        chapterId,
        hashes: { artifactHash: currentHash },
      });
      // 若 receipt 本身是合法 user 审批且 hash 匹配，仅忽略模型字段继续后续校验；
      // 若 actor=model 则直接拒绝。
      if (receipt.actor === "model") {
        return {
          allowed: false,
          reason: "模型伪造 confirm 不视为用户批准",
          blockReason: "actor_forbidden",
          receiptHash: receipt.receiptHash,
          artifactHash: currentHash,
        };
      }
    }
  }

  // 正文变化 → 旧 approval 立即失效
  if (
    isApprovalInvalidatedByTextChange({
      approvalArtifactHash: receipt.artifactHash,
      currentTextHash: currentHash,
    })
  ) {
    emitTrustAuditEvent({
      decisionType: "approval_invalidation",
      allowed: false,
      reason: "正文变化导致旧 approval 失效",
      workspaceId,
      chapterId,
      hashes: {
        receiptArtifactHash: receipt.artifactHash,
        currentHash,
      },
    });
    return {
      allowed: false,
      reason: `artifactHash 不匹配：receipt=${receipt.artifactHash} current=${currentHash}`,
      blockReason: "artifact_hash_mismatch",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  // 绑定校验（workspace/chapter/action/revision/approvalId）
  const bindingCheck = validateApprovalBinding({
    binding: {
      workspaceId: receipt.workspaceId,
      chapterId: receipt.chapterId,
      approvalId: receipt.approvalId,
      artifactHash: receipt.artifactHash,
      action: receipt.action,
      timestamp: receipt.issuedAt,
      revision: receipt.revision,
    },
    current: {
      workspaceId,
      chapterId,
      artifactHash: currentHash,
      action,
      revision,
      approvalId: receipt.approvalId,
    },
    modelClaimedConfirmation: input.modelClaimedConfirmation,
  });
  if (!bindingCheck.valid && bindingCheck.blockReason === "model_forged_confirmation") {
    return {
      allowed: false,
      reason: bindingCheck.reason,
      blockReason: "actor_forbidden",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  const structureErrors = validateActionApprovalReceipt(receipt);
  if (structureErrors.length > 0) {
    return {
      allowed: false,
      reason: `审批对象无效：${structureErrors.join("; ")}`,
      blockReason: "denied",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  if (executorActor === "model") {
    return {
      allowed: false,
      reason: "模型不能作为 commit 执行者",
      blockReason: "actor_forbidden",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  if (executorActor !== "orchestrator" && executorActor !== "system") {
    return {
      allowed: false,
      reason: `不可信执行者：${executorActor}`,
      blockReason: "actor_forbidden",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  // 用户定稿审批必须由 user actor 签发；release 治理不走本函数
  if (receipt.kind === "user_commit" && receipt.actor !== "user" && receipt.actor !== "system") {
    return {
      allowed: false,
      reason: `用户定稿审批 actor 非法：${receipt.actor}`,
      blockReason: "actor_forbidden",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  if (receipt.kind === "chapter_proxy") {
    return {
      allowed: false,
      reason: "章节代理审批对象不能直接用于正式提交",
      blockReason: "denied",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  if (receipt.kind === "release_governance") {
    return {
      allowed: false,
      reason: "release 治理审批对象不能用于章节正式提交",
      blockReason: "denied",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  if (receipt.decision !== "approve") {
    return {
      allowed: false,
      reason: `审批决策不允许提交：${receipt.decision}`,
      blockReason: "denied",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  if (receipt.action !== action) {
    return {
      allowed: false,
      reason: `action 不匹配：receipt=${receipt.action} requested=${action}`,
      blockReason: "scope_mismatch",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  if (
    receipt.workspaceId !== workspaceId ||
    receipt.scope.workspaceId !== workspaceId
  ) {
    return {
      allowed: false,
      reason: `workspace 不匹配：receipt=${receipt.workspaceId} requested=${workspaceId}`,
      blockReason: "scope_mismatch",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  if (receipt.chapterId !== chapterId || receipt.scope.chapterId !== chapterId) {
    return {
      allowed: false,
      reason: `chapter 不匹配：receipt=${receipt.chapterId} requested=${chapterId}`,
      blockReason: "scope_mismatch",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  if (receipt.revision !== revision) {
    return {
      allowed: false,
      reason: `revision 不匹配：receipt=${receipt.revision} requested=${revision}`,
      blockReason: "stale_revision",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  if (receipt.artifactHash !== currentHash) {
    return {
      allowed: false,
      reason: `artifactHash 不匹配：receipt=${receipt.artifactHash} current=${currentHash}`,
      blockReason: "artifact_hash_mismatch",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  const expiresMs = Date.parse(receipt.expiresAt);
  // 与 authorization-card 一致：到期时间点即过期（now >= expiresAt）
  if (!Number.isFinite(expiresMs) || now.getTime() >= expiresMs) {
    return {
      allowed: false,
      reason: `审批已过期：expiresAt=${receipt.expiresAt}`,
      blockReason: "approval_expired",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  if (receipt.consumed) {
    return {
      allowed: false,
      reason: "审批已消费，不可重复使用",
      blockReason: "already_consumed",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  const completed = asCheckSet(input.completedChecks);
  const missing = receipt.requiredChecks.filter((c) => !completed.has(c));
  // artifact_hash_match / revision_match 由本函数直接验证，视为已完成
  const stillMissing = missing.filter(
    (c) => c !== "artifact_hash_match" && c !== "revision_match",
  );
  if (stillMissing.length > 0) {
    return {
      allowed: false,
      reason: `required checks 未完成：${stillMissing.join(",")}`,
      blockReason: "checks_incomplete",
      receiptHash: receipt.receiptHash,
      artifactHash: currentHash,
    };
  }

  return {
    allowed: true,
    reason: "commit 授权通过",
    receiptHash: receipt.receiptHash,
    artifactHash: currentHash,
  };
}

/**
 * 标记审批已消费（仅在提交成功后调用）。
 * 返回新对象，不修改入参（不可变）。
 */
export function consumeApprovalReceipt(
  receipt: ActionApprovalReceipt,
  consumedAt: string = new Date().toISOString(),
): ActionApprovalReceipt {
  if (receipt.consumed) {
    return { ...receipt };
  }
  return {
    ...receipt,
    consumed: true,
    consumedAt,
  };
}

// ============================================================================
// Append-only store (workspace-scoped)
// ============================================================================

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

function assertSafeId(id: string, label: string): void {
  if (!id || !SAFE_ID_RE.test(id)) {
    throw new Error(`${label} 非法：${JSON.stringify(id)}`);
  }
}

export function resolveApprovalReceiptDir(workspacePath: string): string {
  return join(workspacePath, "chapter-approvals", "user-receipts");
}

function receiptPath(dir: string, approvalId: string): string {
  assertSafeId(approvalId, "approvalId");
  const p = resolve(dir, `${approvalId}.receipt.json`);
  const rel = relative(dir, p);
  if (rel.startsWith("..") || resolve(dir, rel) !== p) {
    throw new Error(`approvalId 路径穿越：${approvalId}`);
  }
  return p;
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

/**
 * append-only 写入审批对象。同 approvalId 已存在则拒绝。
 */
export function saveActionApprovalReceipt(
  workspacePath: string,
  receipt: ActionApprovalReceipt,
): void {
  const errors = validateActionApprovalReceipt(receipt);
  if (errors.length > 0) {
    throw new Error(`拒绝写入非法审批对象：${errors.join("; ")}`);
  }
  const dir = resolveApprovalReceiptDir(workspacePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = receiptPath(dir, receipt.approvalId);
  if (existsSync(path)) {
    throw new Error(
      `审批对象已存在（append-only）：approvalId=${receipt.approvalId}`,
    );
  }
  atomicWrite(path, JSON.stringify(receipt, null, 2));
  const indexPath = join(dir, "receipts-index.jsonl");
  appendFileSync(
    indexPath,
    JSON.stringify({
      approvalId: receipt.approvalId,
      receiptHash: receipt.receiptHash,
      chapterId: receipt.chapterId,
      action: receipt.action,
      issuedAt: receipt.issuedAt,
      decision: receipt.decision,
    }) + "\n",
    "utf-8",
  );
}

export function loadActionApprovalReceipt(
  workspacePath: string,
  approvalId: string,
): ActionApprovalReceipt | null {
  const dir = resolveApprovalReceiptDir(workspacePath);
  const path = receiptPath(dir, approvalId);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as ActionApprovalReceipt;
  const errors = validateActionApprovalReceipt(parsed);
  if (errors.length > 0) {
    throw new Error(
      `审批对象损坏：approvalId=${approvalId} ${errors.join("; ")}`,
    );
  }
  return parsed;
}

/**
 * 消费落盘：提交成功后覆盖写入 consumed=true。
 * 仅允许 consumed false→true 这一次状态变更（append-only 身份，可变消费位）。
 */
export function persistConsumedApprovalReceipt(
  workspacePath: string,
  receipt: ActionApprovalReceipt,
): void {
  if (!receipt.consumed) {
    throw new Error("persistConsumedApprovalReceipt: receipt.consumed 必须为 true");
  }
  const dir = resolveApprovalReceiptDir(workspacePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = receiptPath(dir, receipt.approvalId);
  atomicWrite(path, JSON.stringify(receipt, null, 2));
}

export { computeArtifactHash };
