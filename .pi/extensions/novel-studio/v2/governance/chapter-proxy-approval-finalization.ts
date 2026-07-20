/**
 * ChapterProxyApprovalFinalization — 章节代理审批用户定稿操作（G7-Finalization，计划 §12.2）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §12.2
 *
 * 用户定稿操作（计划 §12.2）：
 * - acceptProxyDraft：用户原样接受代理审批稿 → clear pending + canCommit=true
 * - acceptProxyDraftWithEdits：用户修改后接受 → 重跑 FactGuard → 通过则 clear pending + canCommit=true
 * - rejectAndRegenerate：用户拒绝 → clear pending + canCommit=false（不 commitAndSave）
 * - inspectAlternatives：只读查看候选信息（不修改 pending）
 * - rollbackCommittedChapter：回滚已提交章节（备份 + 删除 chapters/{chapterId}.md）
 *
 * 核心约束（计划 §6.3 line 280）：
 * - 代理审批稿不是正式最终版。用户修改后必须基于用户稿重新运行 FinalFactRecheck。
 * - 用户最终确认前，FinalStateCommit 和正式章节原子保存均不得执行。
 * - 只有用户最终确认的版本才能执行 FinalStateCommit、原子保存并成为下一章 frontier。
 *
 * P0 安全约束（approvalId 双重绑定）：
 * - accept/accept_with_edits/reject 必须先验证传入 approvalId 与 pending sentinel
 *   记录的 approvalId 一致，方可清除 pending（防越权确认/拒绝他人 pending）。
 * - 校验失败时不清除 pending、不运行 FactGuard、canCommit=false。
 * - 使用 getPendingSentinel 只读 sentinel（不依赖 draft 元数据），避免元数据损坏误判。
 *
 * 设计原则：
 * - 本模块不直接调用 commitAndSave（避免重耦合 UnifiedOrchestratorInput）。
 *   定稿操作返回 canCommit 标志，调用方（编排器/CLI）根据 canCommit 决定是否调用 commitAndSave。
 * - commitAndSave 内部有 hasPendingProxyDraft 守护：pending 未清除时拒绝执行。
 *   因此 accept 操作必须先 clear pending，调用方才能成功 commitAndSave。
 * - acceptProxyDraftWithEdits 用依赖注入 rerunFactGuard（调用方包装 checkCandidateFactGuard），
 *   避免本模块直接依赖 UnifiedOrchestratorInput。
 * - FactGuard 不通过时不清除 pending（用户可继续修改后重试）。
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不直接调用 commitAndSave、不提交长期状态
 * - inspectAlternatives 纯只读
 * - rollbackCommittedChapter 回滚章节文件（备份 + 删除）+ 从 pre-commit 备份恢复叙事状态；
 *   无 pre-commit 备份时仅回滚正文并标记 narrativeStateRestoreRequired=true（调用方单独处理）
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";

import {
  clearPendingProxyDraft,
  getPendingSentinel,
} from "./chapter-proxy-approval-draft-checkpoint.js";
import type { ChapterProxyApprovalArtifact } from "./chapter-proxy-approval-types.js";

// ============================================================================
// 类型
// ============================================================================

/** FactGuard 重跑函数（调用方包装 checkCandidateFactGuard） */
export type FactGuardRerunFn = (text: string) => { ok: boolean; errors: string[] };

/** 定稿动作类型 */
export type FinalizationAction =
  | "accept"
  | "accept_with_edits"
  | "reject"
  | "inspect"
  | "rollback";

/** inspect_alternatives 候选摘要 */
export interface InspectAlternativesSummary {
  approvalId: string;
  chapterId: string;
  candidateIds: string[];
  recommendedCandidateId: string;
  recommendedSource: string;
  finalStatus: string;
  winningSpans: string[];
  losingSpans: string[];
  risks: string[];
  rationale: string;
}

/** rollback 结果 */
export interface RollbackResult {
  rolledBack: boolean;
  chapterFilePath: string;
  backupPath?: string;
  reason?: string;
  /** 是否需要调用方单独恢复 narrative-state（无 pre-commit 备份或恢复失败时为 true） */
  narrativeStateRestoreRequired: boolean;
  /** P1: 是否已从 pre-commit 备份恢复叙事状态（CanonState/CharacterState/PromiseLedger/PatternMemory/Expectation） */
  stateRestored?: boolean;
  /** P1: 恢复使用的 pre-commit 状态备份路径 */
  stateBackupPath?: string;
  /** P1: 状态恢复失败原因（恢复成功时为 undefined） */
  stateRestoreError?: string;
}

/** 定稿操作结果 */
export interface FinalizationResult {
  action: FinalizationAction;
  /** 是否清除了 pending（accept/reject 清除；inspect/rollback 不清除） */
  clearedPending: boolean;
  /** 是否允许后续 commitAndSave（只有 accept/accept_with_edits 通过时为 true） */
  canCommit: boolean;
  /** FactGuard 重跑结果（仅 accept_with_edits） */
  factGuardPassed?: boolean;
  factGuardErrors?: string[];
  /** 阻断原因 */
  blockReason?: string;
  /** 用户修改后的正文（仅 accept_with_edits 通过时，供 commitAndSave） */
  editedText?: string;
  /** 候选摘要（仅 inspect） */
  inspectSummary?: InspectAlternativesSummary;
  /** rollback 结果（仅 rollback） */
  rollbackResult?: RollbackResult;
}

/** acceptProxyDraft 选项 */
export interface AcceptProxyDraftOptions {
  workspacePath: string;
  chapterId: string;
  approvalId: string;
}

/** acceptProxyDraftWithEdits 选项 */
export interface AcceptProxyDraftWithEditsOptions extends AcceptProxyDraftOptions {
  /** 用户修改后的正文 */
  editedText: string;
  /** FactGuard 重跑函数（依赖注入） */
  rerunFactGuard: FactGuardRerunFn;
}

/** rejectAndRegenerate 选项 */
export interface RejectAndRegenerateOptions extends AcceptProxyDraftOptions {}

/** rollbackCommittedChapter 选项 */
export interface RollbackCommittedChapterOptions {
  workspacePath: string;
  chapterId: string;
}

// ============================================================================
// 安全校验
// ============================================================================

/** chapterId 安全字符集（与 draft-checkpoint assertSafeChapterId 同模式） */
const SAFE_CHAPTER_ID_RE = /^[A-Za-z0-9_-]+$/;

function assertSafeChapterId(chapterId: string): void {
  if (
    typeof chapterId !== "string" ||
    chapterId.length === 0 ||
    !SAFE_CHAPTER_ID_RE.test(chapterId)
  ) {
    throw new Error(
      `chapterId 含非法字符或为空（仅允许字母数字、dash、underscore）：${JSON.stringify(chapterId)}`,
    );
  }
}

/** 原子写入：temp → rename。失败不覆盖原文件。 */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// approvalId 双重绑定校验（P0 安全：防越权确认/拒绝他人 pending）
// ============================================================================

/**
 * 校验传入 approvalId 与 pending sentinel 记录的 approvalId 一致。
 *
 * 安全约束（P0）：accept/accept_with_edits/reject 必须先验证传入 approvalId
 * 与 pending sentinel 的 approvalId 一致，方可清除 pending。
 * - 无 pending sentinel -> { ok: false, reason: "no_pending_draft" }
 * - sentinel.chapterId 与传入 chapterId 不一致 -> { ok: false, reason: "chapter_id_mismatch" }
 * - sentinel.approvalId 与传入 approvalId 不一致 -> { ok: false, reason: "approval_id_mismatch" }
 * - 一致 -> { ok: true }
 *
 * 使用 getPendingSentinel（只读 sentinel，不加载 draft 元数据），
 * 避免 draft 元数据损坏时误判为无 pending。
 */
function verifyPendingApprovalId(
  workspacePath: string,
  chapterId: string,
  approvalId: string,
): { ok: boolean; reason?: string } {
  const sentinel = getPendingSentinel(workspacePath, chapterId);
  if (sentinel === null) {
    return { ok: false, reason: "no_pending_draft" };
  }
  if (sentinel.chapterId !== chapterId) {
    return { ok: false, reason: "chapter_id_mismatch" };
  }
  if (sentinel.approvalId !== approvalId) {
    return { ok: false, reason: "approval_id_mismatch" };
  }
  return { ok: true };
}

// ============================================================================
// acceptProxyDraft
// ============================================================================

/**
 * 用户原样接受代理审批稿。
 *
 * - P0 先校验 approvalId 与 pending sentinel 一致（防越权确认他人 pending）
 * - 校验通过 -> clear pending（允许后续 commitAndSave）+ canCommit=true
 * - 校验失败 -> 不 clear pending + canCommit=false + blockReason
 *
 * 不重跑 FactGuard（代理审批稿在生成时已通过 FactGuard；用户原样接受不修改正文）。
 */
export function acceptProxyDraft(options: AcceptProxyDraftOptions): FinalizationResult {
  const { workspacePath, chapterId, approvalId } = options;
  assertSafeChapterId(chapterId);

  const verification = verifyPendingApprovalId(workspacePath, chapterId, approvalId);
  if (!verification.ok) {
    return {
      action: "accept",
      clearedPending: false,
      canCommit: false,
      blockReason: verification.reason,
    };
  }

  clearPendingProxyDraft(workspacePath, chapterId);

  return {
    action: "accept",
    clearedPending: true,
    canCommit: true,
  };
}

// ============================================================================
// acceptProxyDraftWithEdits
// ============================================================================

/**
 * 用户修改后接受代理审批稿。
 *
 * - 重跑 FactGuard（基于用户修改后的正文）
 * - 通过 → clear pending + canCommit=true + editedText（供 commitAndSave）
 * - 不通过 → 不 clear pending + canCommit=false + factGuardErrors（用户可继续修改）
 *
 * 核心约束（计划 §6.3）：用户修改后必须基于用户稿重新运行 FinalFactRecheck。
 */
export function acceptProxyDraftWithEdits(
  options: AcceptProxyDraftWithEditsOptions,
): FinalizationResult {
  const { workspacePath, chapterId, approvalId, editedText, rerunFactGuard } = options;
  assertSafeChapterId(chapterId);

  const verification = verifyPendingApprovalId(workspacePath, chapterId, approvalId);
  if (!verification.ok) {
    return {
      action: "accept_with_edits",
      clearedPending: false,
      canCommit: false,
      blockReason: verification.reason,
    };
  }

  const factGuardResult = rerunFactGuard(editedText);

  if (!factGuardResult.ok) {
    return {
      action: "accept_with_edits",
      clearedPending: false,
      canCommit: false,
      factGuardPassed: false,
      factGuardErrors: factGuardResult.errors,
      blockReason: "factguard_failed",
    };
  }

  clearPendingProxyDraft(workspacePath, chapterId);

  return {
    action: "accept_with_edits",
    clearedPending: true,
    canCommit: true,
    factGuardPassed: true,
    editedText,
  };
}

// ============================================================================
// rejectAndRegenerate
// ============================================================================

/**
 * 用户拒绝代理审批稿，要求重新生成。
 *
 * - clear pending（允许后续重新生成）
 * - 返回 canCommit=false（不 commitAndSave）
 */
export function rejectAndRegenerate(
  options: RejectAndRegenerateOptions,
): FinalizationResult {
  const { workspacePath, chapterId, approvalId } = options;
  assertSafeChapterId(chapterId);

  const verification = verifyPendingApprovalId(workspacePath, chapterId, approvalId);
  if (!verification.ok) {
    return {
      action: "reject",
      clearedPending: false,
      canCommit: false,
      blockReason: verification.reason,
    };
  }

  clearPendingProxyDraft(workspacePath, chapterId);

  return {
    action: "reject",
    clearedPending: true,
    canCommit: false,
  };
}

// ============================================================================
// inspectAlternatives
// ============================================================================

/**
 * 只读查看候选信息（不修改 pending，不 commitAndSave）。
 *
 * 从 approval artifact 提取候选摘要：candidateIds / recommendedSource /
 * winningSpans / losingSpans / risks / rationale / finalStatus。
 *
 * 调用方负责从 registry 加载 ChapterProxyApprovalArtifact 后传入。
 */
export function inspectAlternatives(
  approval: ChapterProxyApprovalArtifact,
): FinalizationResult {
  const inspectSummary: InspectAlternativesSummary = {
    approvalId: approval.approvalId,
    chapterId: approval.chapterId,
    candidateIds: approval.candidateIds,
    recommendedCandidateId: approval.recommendedCandidateId,
    recommendedSource: approval.recommendedSource,
    finalStatus: approval.finalStatus,
    winningSpans: approval.winningSpans,
    losingSpans: approval.losingSpans,
    risks: approval.risks,
    rationale: approval.rationale,
  };

  return {
    action: "inspect",
    clearedPending: false,
    canCommit: false,
    inspectSummary,
  };
}

// ============================================================================
// rollbackCommittedChapter
// ============================================================================

/**
 * 回滚已提交章节。
 *
 * - 检查 chapters/{chapterId}.md 是否存在
 * - 已提交 → 备份到 chapter-approvals/{chapterId}.rollback-backup-{timestamp}.md + 删除原文件
 * - 未提交 → rolledBack=false
 *
 * 边界：
 * - 只回滚章节文件（备份 + 删除）
 * - narrative-state 恢复由调用方单独处理（narrativeStateRestoreRequired=true 提示）
 * - 不恢复 pending（rollback 是回滚已提交章节，与 pending 无关）
 */
export function rollbackCommittedChapter(
  options: RollbackCommittedChapterOptions,
): FinalizationResult {
  const { workspacePath, chapterId } = options;
  assertSafeChapterId(chapterId);

  const chaptersDir = join(workspacePath, "chapters");
  const chapterPath = join(chaptersDir, `${chapterId}.md`);

  if (!existsSync(chapterPath)) {
    return {
      action: "rollback",
      clearedPending: false,
      canCommit: false,
      rollbackResult: {
        rolledBack: false,
        chapterFilePath: chapterPath,
        reason: "chapter_not_committed",
        narrativeStateRestoreRequired: false,
      },
    };
  }

  // 备份到 chapter-approvals/（与 draft-checkpoint 共用目录）
  const backupDir = join(workspacePath, "chapter-approvals");
  ensureDir(backupDir);
  const timestamp = Date.now();
  const backupPath = join(backupDir, `${chapterId}.rollback-backup-${timestamp}.md`);

  // 先备份（读 + 原子写入），成功后删除原文件
  const content = readFileSync(chapterPath, "utf-8");
  atomicWrite(backupPath, content);
  unlinkSync(chapterPath);

  // P1: 恢复章节前叙事状态（从 pre-commit-state 备份恢复）
  // commitAndSave 在状态提交前备份 narrative-state-store.json 到
  // chapter-approvals/{chapterId}.pre-commit-state-{timestamp}.json。
  // 此处查找最新备份并恢复，实现"正文与状态一起回退"闭环。
  const stateStorePath = join(workspacePath, "narrative-state-store.json");
  let stateRestored = false;
  let stateBackupPath: string | undefined;
  let stateRestoreError: string | undefined;

  const stateBackups = readdirSync(backupDir)
    .filter(
      (f) =>
        f.startsWith(`${chapterId}.pre-commit-state-`) && f.endsWith(".json"),
    )
    .sort()
    .reverse(); // 最新的在前（timestamp 递增 -> 排序后 reverse 取最新）

  if (stateBackups.length > 0) {
    stateBackupPath = join(backupDir, stateBackups[0]);
    try {
      const backupContent = readFileSync(stateBackupPath, "utf-8");
      atomicWrite(stateStorePath, backupContent);
      stateRestored = true;
    } catch (e: unknown) {
      stateRestoreError = e instanceof Error ? e.message : String(e);
      // 状态恢复失败不阻断章节回滚（正文已回滚）
    }
  } else {
    stateRestoreError = "no_pre_commit_state_backup";
  }

  return {
    action: "rollback",
    clearedPending: false,
    canCommit: false,
    rollbackResult: {
      rolledBack: true,
      chapterFilePath: chapterPath,
      backupPath,
      stateRestored,
      stateBackupPath,
      stateRestoreError,
      narrativeStateRestoreRequired: !stateRestored,
    },
  };
}
