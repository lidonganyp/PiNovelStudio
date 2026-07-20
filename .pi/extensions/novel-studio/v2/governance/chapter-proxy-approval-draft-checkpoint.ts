/**
 * ChapterProxyApprovalDraftCheckpoint — 代理审批稿 pending checkpoint（G7-Checkpoint）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §12.2
 *
 * 代理审批稿不是正式最终版。用户最终确认前，FinalStateCommit 和正式章节原子保存
 * 均不得执行（计划 §6.3 line 280）。本模块提供只读、可恢复的 pending checkpoint：
 * - saveProxyApprovedDraft：落盘到 workspaces/{id}/chapter-approvals/（隔离目录）
 * - hasPendingProxyDraft：被 commitAndSave 守护调用，阻止未确认稿提交状态/覆盖正式章节
 * - loadProxyApprovedDraft：供 Review Surface 读取（后续切片）
 * - clearPendingProxyDraft：用户最终确认后清除 pending 标记（后续切片）
 *
 * 设计原则（计划 §6.3 / §12.2）：
 * - 落盘到 chapter-approvals/ 隔离目录，不写正式 chapters/
 * - append-only：同 approvalId 重复写入拒绝（防止篡改审批稿）
 * - pending sentinel：{chapterId}.pending.json 快速检查本章是否有未确认代理审批稿
 * - 不调用模型、不提交状态、不推进 frontier
 * - 目录穿越防护（与 chapter-proxy-approval-registry 同模式）
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不写 chapters/、不执行 FinalStateCommit
 * - 闭包自包含（仅依赖 node:fs / node:path），可安全进入生产闭包
 * - 被 v2/core/orchestrator-commit-save.ts 守护调用（hasPendingProxyDraft）
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import {
  validateStateEntry,
  type NarrativeStateEntry,
  type StagedStateUpdate,
} from "../core/final-state-commit.js";

// ============================================================================
// 类型
// ============================================================================

/** saveProxyApprovedDraft 选项 */
export interface SaveProxyApprovedDraftOptions {
  /** workspace 路径（workspaces/{workspaceId}） */
  workspacePath: string;
  /** 审批 ID（与 ChapterProxyApprovalArtifact.approvalId 一致） */
  approvalId: string;
  /** 章节 ID */
  chapterId: string;
  /** 胜出候选 ID */
  candidateId: string;
  /** 候选来源（raw/editorial/system_selected） */
  selectedSource: string;
  /** 代理审批稿正文 */
  finalText: string;
  /** 保存时间戳（ISO 字符串） */
  savedAt: string;
  /** 候选选定时的完整暂存状态，供用户定稿后按最终正文重新锚定 */
  stagedStateUpdate?: StagedStateUpdate;
}

/** loadProxyApprovedDraft 返回 */
export interface LoadProxyApprovedDraftResult {
  approvalId: string;
  chapterId: string;
  candidateId: string;
  selectedSource: string;
  finalText: string;
  savedAt: string;
  draftFilePath: string;
  stagedStateUpdate?: StagedStateUpdate;
}

/** pending sentinel 公开结构（用于定稿操作 approvalId 双重绑定校验） */
export interface PendingSentinelInfo {
  chapterId: string;
  approvalId: string;
  status: "pending";
  savedAt: string;
}

/** pending sentinel 内部结构 */
interface PendingSentinel {
  chapterId: string;
  approvalId: string;
  status: "pending";
  savedAt: string;
}

// ============================================================================
// 路径解析与安全校验
// ============================================================================

/**
 * 代理审批稿 checkpoint 根目录：workspaces/{id}/chapter-approvals/
 *
 * 与 chapter-proxy-approval-registry 共用同一目录（approvalsDir），
 * 但文件名后缀不同（.draft.md / .draft.meta.json / .pending.json），
 * 与 registry 的 {approvalId}.json / chapter-approvals-index.jsonl 物理隔离。
 */
export function resolveDraftCheckpointDir(workspacePath: string): string {
  return join(workspacePath, "chapter-approvals");
}

/** P0: approvalId 安全字符集（仅字母数字、dash、underscore；禁止路径分隔符、点、空格） */
const SAFE_APPROVAL_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * P0 防目录穿越（与 chapter-proxy-approval-registry 同模式）：
 * 校验 approvalId 字符集，并确保 resolve 后路径仍位于 draftDir 内。
 * 防止 approvalId='../escaped' 等在隔离目录外创建/读取文件。
 */
function assertSafeApprovalId(draftDir: string, approvalId: string): void {
  if (
    typeof approvalId !== "string" ||
    approvalId.length === 0 ||
    !SAFE_APPROVAL_ID_RE.test(approvalId)
  ) {
    throw new Error(
      `approvalId 含非法字符或为空（仅允许字母数字、dash、underscore）：${JSON.stringify(approvalId)}`,
    );
  }
  const resolved = resolve(draftDir, `${approvalId}.draft.md`);
  const rel = relative(draftDir, resolved);
  if (rel.startsWith("..") || resolve(draftDir, rel) !== resolved) {
    throw new Error(
      `approvalId 路径穿越检测：resolve 后路径 ${resolved} 不在 ${draftDir} 内`,
    );
  }
}

/** chapterId 安全字符集（与 utils/chapter-path validateChapterId 同模式） */
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

function draftFilePath(draftDir: string, approvalId: string): string {
  assertSafeApprovalId(draftDir, approvalId);
  return join(draftDir, `${approvalId}.draft.md`);
}

function draftMetaPath(draftDir: string, approvalId: string): string {
  assertSafeApprovalId(draftDir, approvalId);
  return join(draftDir, `${approvalId}.draft.meta.json`);
}

function pendingSentinelPath(draftDir: string, chapterId: string): string {
  assertSafeChapterId(chapterId);
  return join(draftDir, `${chapterId}.pending.json`);
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
// saveProxyApprovedDraft
// ============================================================================

/**
 * 保存代理审批稿到隔离目录（pending checkpoint）。
 *
 * 落盘文件：
 * - {approvalId}.draft.md：代理审批稿正文（只读，供 Review Surface 展示）
 * - {approvalId}.draft.meta.json：元数据（approvalId/chapterId/candidateId/selectedSource/savedAt/draftFilePath）
 * - {chapterId}.pending.json：pending sentinel（快速检查本章是否有未确认稿）
 *
 * append-only：同 approvalId 重复写入拒绝（防止篡改审批稿）。
 * pending sentinel 是覆盖写入（同一章最新 pending draft 覆盖旧 sentinel）。
 *
 * 不写正式 chapters/ 目录、不执行 FinalStateCommit、不推进 frontier。
 */
export function saveProxyApprovedDraft(options: SaveProxyApprovedDraftOptions): void {
  const {
    workspacePath,
    approvalId,
    chapterId,
    candidateId,
    selectedSource,
    finalText,
    savedAt,
    stagedStateUpdate,
  } = options;

  const draftDir = resolveDraftCheckpointDir(workspacePath);
  ensureDir(draftDir);

  const dPath = draftFilePath(draftDir, approvalId);
  const mPath = draftMetaPath(draftDir, approvalId);

  // append-only：同 approvalId 重复写入拒绝
  if (existsSync(dPath)) {
    throw new Error(
      `代理审批稿已存在（append-only）：approvalId=${approvalId} already exists，重复写入被拒绝`,
    );
  }

  // 1. 写 draft 正文（原子写入）
  atomicWrite(dPath, finalText);

  // 2. 写元数据（原子写入）
  const meta: LoadProxyApprovedDraftResult = {
    approvalId,
    chapterId,
    candidateId,
    selectedSource,
    finalText,
    savedAt,
    draftFilePath: dPath,
    ...(stagedStateUpdate ? { stagedStateUpdate } : {}),
  };
  atomicWrite(mPath, JSON.stringify(meta, null, 2));

  // 3. 写 pending sentinel（覆盖写入：最新 pending draft 指向最新 approvalId）
  const sPath = pendingSentinelPath(draftDir, chapterId);
  const sentinel: PendingSentinel = {
    chapterId,
    approvalId,
    status: "pending",
    savedAt,
  };
  atomicWrite(sPath, JSON.stringify(sentinel, null, 2));
}

// ============================================================================
// loadProxyApprovedDraft
// ============================================================================

/**
 * 读取代理审批稿（供 Review Surface 展示）。
 * 不存在返回 null；损坏 JSON 抛错（不静默返回 null）。
 */
export function loadProxyApprovedDraft(
  workspacePath: string,
  approvalId: string,
): LoadProxyApprovedDraftResult | null {
  const draftDir = resolveDraftCheckpointDir(workspacePath);
  const mPath = draftMetaPath(draftDir, approvalId);
  if (!existsSync(mPath)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(mPath, "utf-8");
  } catch (e) {
    throw new Error(
      `读取代理审批稿元数据失败：approvalId=${approvalId}，${(e as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `代理审批稿元数据 JSON 解析失败：approvalId=${approvalId}，${(e as Error).message}`,
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.approvalId !== "string" ||
    typeof obj.chapterId !== "string" ||
    typeof obj.candidateId !== "string" ||
    typeof obj.selectedSource !== "string" ||
    typeof obj.finalText !== "string" ||
    typeof obj.savedAt !== "string" ||
    typeof obj.draftFilePath !== "string"
  ) {
    throw new Error(
      `代理审批稿元数据字段缺失或类型错误：approvalId=${approvalId}`,
    );
  }

  const stagedStateUpdate = parseStagedStateUpdate(obj.stagedStateUpdate, approvalId);

  return {
    approvalId: obj.approvalId,
    chapterId: obj.chapterId,
    candidateId: obj.candidateId,
    selectedSource: obj.selectedSource,
    finalText: obj.finalText,
    savedAt: obj.savedAt,
    draftFilePath: obj.draftFilePath,
    ...(stagedStateUpdate ? { stagedStateUpdate } : {}),
  };
}

function parseStagedStateUpdate(
  value: unknown,
  approvalId: string,
): StagedStateUpdate | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new Error(`代理审批稿 stagedStateUpdate 类型错误：approvalId=${approvalId}`);
  }

  const update = value as Record<string, unknown>;
  if (
    !Array.isArray(update.additions) ||
    !Array.isArray(update.invalidations) ||
    typeof update.sourceChapter !== "string" ||
    !update.invalidations.every((entry) => typeof entry === "string") ||
    (update.finalCandidateId !== undefined && typeof update.finalCandidateId !== "string")
  ) {
    throw new Error(`代理审批稿 stagedStateUpdate 字段缺失或类型错误：approvalId=${approvalId}`);
  }

  const additions = update.additions as NarrativeStateEntry[];
  const invalidEntry = additions.find((entry) => !validateStateEntry(entry).ok);
  if (invalidEntry) {
    throw new Error(
      `代理审批稿 stagedStateUpdate 含非法状态条目：approvalId=${approvalId}, entryId=${invalidEntry.id ?? "unknown"}`,
    );
  }

  return {
    additions: [...additions],
    invalidations: [...update.invalidations] as string[],
    sourceChapter: update.sourceChapter,
    ...(typeof update.finalCandidateId === "string"
      ? { finalCandidateId: update.finalCandidateId }
      : {}),
  };
}

// ============================================================================
// hasPendingProxyDraft
// ============================================================================

/**
 * 检查本章是否有未确认的代理审批稿。
 *
 * 被 v2/core/orchestrator-commit-save.ts 的 commitAndSave 守护调用：
 * - 返回 true 时，commitAndSave 拒绝执行（不写 chapters/、不提交状态）
 * - 返回 false 时，commitAndSave 正常执行
 *
 * 检查方式：读取 {chapterId}.pending.json sentinel 是否存在且 status="pending"。
 *
 * P0 fail-closed 安全语义（计划 §6.3 line 280；用户阻断项 P0-2 修复）：
 * - sentinel 文件不存在 -> 返回 false（确定无 pending，commitAndSave 放行）
 * - sentinel 文件存在且可解析、status="pending" -> 返回 true（阻断 commitAndSave）
 * - sentinel 文件存在但 JSON 损坏 / 读取失败 -> 返回 true（fail-closed：不可验证即阻断）
 * - sentinel 字段缺失或类型异常（chapterId/approvalId/savedAt/status 非字符串）-> 返回 true（fail-closed）
 * - sentinel 存在且字段完整、status 非 "pending"（如显式 "cleared"/"unknown"/"completed"）
 *   -> 返回 true（fail-closed 白名单：系统实际只写 status="pending"，任何非 "pending"
 *   值都是篡改/损坏/未知来源，必须视为 pending 阻断 commitAndSave）
 *
 * 设计理由（P0-2 修复）：sentinel 文件存在本身即代表"曾被写入 pending"。
 * saveProxyApprovedDraft / restorePendingSentinel 总是写 status="pending"；
 * clearPendingProxyDraft 直接 unlink 文件（不写 status）。因此磁盘上合法的
 * sentinel 永远 status="pending"，任何非 "pending" 字符串值都是篡改/损坏。
 * 旧实现 `return parsed.status === "pending"` 反向放行非 "pending" 值，
 * 攻击者把 status 改为 "cleared" 即可绕过 pending 守护让 commitAndSave 错误提交。
 * 修复为 fail-closed 白名单：字段完整时永远返回 true（视为 pending），
 * 与文件损坏/字段异常的 fail-closed 行为一致。
 */
export function hasPendingProxyDraft(workspacePath: string, chapterId: string): boolean {
  const draftDir = resolveDraftCheckpointDir(workspacePath);
  const sPath = pendingSentinelPath(draftDir, chapterId);
  if (!existsSync(sPath)) {
    return false;
  }
  try {
    const raw = readFileSync(sPath, "utf-8");
    const parsed = JSON.parse(raw) as PendingSentinel;
    // status 字段缺失或类型异常 -> fail-closed（视为 pending，阻断 commitAndSave）
    if (typeof parsed.status !== "string") {
      return true;
    }
    // 关键字段缺失或类型异常 -> fail-closed（不可验证即阻断）
    if (
      typeof parsed.chapterId !== "string" ||
      typeof parsed.approvalId !== "string" ||
      typeof parsed.savedAt !== "string"
    ) {
      return true;
    }
    // P0-2 修复：字段完整时永远视为 pending（fail-closed 白名单）。
    // 系统实际只写 status="pending"；任何非 "pending" 值都是篡改/损坏/未知来源，
    // 必须视为 pending 阻断 commitAndSave，不得反向放行。
    return true;
  } catch {
    // JSON 损坏 / 读取失败：fail-closed（视为 pending，阻断 commitAndSave）
    return true;
  }
}

// ============================================================================
// getPendingProxyDraft
// ============================================================================

/**
 * 获取本章最新 pending 代理审批稿（供 Review Surface 读取）。
 * 无 pending 时返回 null。
 */
export function getPendingProxyDraft(
  workspacePath: string,
  chapterId: string,
): LoadProxyApprovedDraftResult | null {
  const draftDir = resolveDraftCheckpointDir(workspacePath);
  const sPath = pendingSentinelPath(draftDir, chapterId);
  if (!existsSync(sPath)) {
    return null;
  }
  try {
    const raw = readFileSync(sPath, "utf-8");
    const sentinel = JSON.parse(raw) as PendingSentinel;
    if (sentinel.status !== "pending") {
      return null;
    }
    return loadProxyApprovedDraft(workspacePath, sentinel.approvalId);
  } catch {
    return null;
  }
}

// ============================================================================
// getPendingSentinel
// ============================================================================

/**
 * 读取本章 pending sentinel（不加载 draft 元数据）。
 *
 * 用于定稿操作（accept/reject）的 approvalId 双重绑定校验：
 * 传入 approvalId 必须与 sentinel 记录的 approvalId 一致，方可清除 pending。
 * 只读 sentinel（轻量），不依赖 draft 元数据文件，避免 draft 元数据损坏时
 * 误判为无 pending（getPendingProxyDraft 会因 draft 元数据加载失败而返回 null）。
 *
 * - 无 sentinel 文件 -> null
 * - sentinel 存在但 status !== "pending" -> null
 * - sentinel 字段缺失/类型错误 -> null（fail-closed：不返回可被伪造的 approvalId）
 * - sentinel JSON 损坏 -> null（fail-closed）
 *
 * 与 getPendingProxyDraft 的区别：本函数只读 sentinel，不加载 draft 元数据，
 * 适用于仅需 approvalId/chapterId 校验的场景（如定稿操作的权限校验）。
 */
export function getPendingSentinel(
  workspacePath: string,
  chapterId: string,
): PendingSentinelInfo | null {
  const draftDir = resolveDraftCheckpointDir(workspacePath);
  const sPath = pendingSentinelPath(draftDir, chapterId);
  if (!existsSync(sPath)) {
    return null;
  }
  try {
    const raw = readFileSync(sPath, "utf-8");
    const sentinel = JSON.parse(raw) as PendingSentinel;
    if (sentinel.status !== "pending") {
      return null;
    }
    if (
      typeof sentinel.chapterId !== "string" ||
      typeof sentinel.approvalId !== "string" ||
      typeof sentinel.savedAt !== "string"
    ) {
      return null;
    }
    return {
      chapterId: sentinel.chapterId,
      approvalId: sentinel.approvalId,
      status: "pending",
      savedAt: sentinel.savedAt,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// clearPendingProxyDraft
// ============================================================================

/**
 * 清除本章 pending 标记（用户最终确认后调用）。
 *
 * 只删除 pending sentinel，不删除 draft 文件和元数据（保留审计痕迹）。
 * 清除后 hasPendingProxyDraft 返回 false，commitAndSave 恢复正常。
 *
 * 后续切片（用户定稿操作）在用户执行 accept_proxy_draft 后调用此函数。
 */
export function clearPendingProxyDraft(workspacePath: string, chapterId: string): void {
  const draftDir = resolveDraftCheckpointDir(workspacePath);
  const sPath = pendingSentinelPath(draftDir, chapterId);
  if (existsSync(sPath)) {
    try {
      unlinkSync(sPath);
    } catch {
      // 删除失败不抛错（idempotent：已清除时 no-op）
    }
  }
}

// ============================================================================
// restorePendingSentinel
// ============================================================================

/**
 * 恢复本章 pending sentinel（commitAndSave 失败后调用）。
 *
 * 用途：accept/accept_with_edits 在 finalization 内部已经 clear pending，
 * 但后续 commitAndSave（原子保存 + 状态提交）可能失败。若失败后不恢复 pending，
 * 用户将无法重试定稿（hasPendingProxyDraft 返回 false 时 commitAndSave 会放行，
 * 但 Review Surface 看不到 pending 草稿；用户也无法再次 accept/accept_with_edits）。
 *
 * 恢复策略：
 * - 通过 approvalId 重新加载 draft 元数据（draft 文件未被 finalization 删除，仍存在）
 * - draft 元数据加载失败 / approvalId 不匹配 -> 不恢复（restored=false + reason）
 * - 成功加载 -> 覆盖写入 pending sentinel（status="pending"）
 *
 * 与 clearPendingProxyDraft 的关系：
 * - clear 只删 sentinel，不删 draft（保留审计痕迹）
 * - restore 利用保留的 draft 元数据重新写入 sentinel
 *
 * P0 安全：approvalId 与 draft 元数据的 approvalId 必须一致（双重绑定）；
 * 不一致时拒绝恢复（防止用错误 approvalId 复活其他审批的 pending）。
 *
 * @returns restored=true 表示 sentinel 已恢复；restored=false + reason 表示未恢复
 */
export function restorePendingSentinel(
  workspacePath: string,
  chapterId: string,
  approvalId: string,
  savedAt: string,
): { restored: boolean; reason?: string } {
  assertSafeChapterId(chapterId);

  // 通过 approvalId 重新加载 draft 元数据（draft 文件未删除）
  const draft = loadProxyApprovedDraft(workspacePath, approvalId);
  if (draft === null) {
    return { restored: false, reason: "draft_not_found" };
  }

  // P0 双重绑定：draft 元数据的 approvalId 必须与传入 approvalId 一致
  if (draft.approvalId !== approvalId) {
    return { restored: false, reason: "approval_id_mismatch" };
  }

  // draft 元数据的 chapterId 必须与传入 chapterId 一致
  if (draft.chapterId !== chapterId) {
    return { restored: false, reason: "chapter_id_mismatch" };
  }

  const draftDir = resolveDraftCheckpointDir(workspacePath);
  ensureDir(draftDir);
  const sPath = pendingSentinelPath(draftDir, chapterId);
  const sentinel: PendingSentinel = {
    chapterId,
    approvalId,
    status: "pending",
    savedAt,
  };
  atomicWrite(sPath, JSON.stringify(sentinel, null, 2));

  return { restored: true };
}
