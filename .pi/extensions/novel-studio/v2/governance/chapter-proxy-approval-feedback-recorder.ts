/**
 * ChapterProxyApprovalFeedbackRecorder — 用户反馈记录器（G7-Feedback，计划 §12.2）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §12.2
 *
 * 记录用户定稿操作的真实反馈，用于策略证据与 release 健康报告（计划 §12.2）：
 * - recordProxyApprovalFeedback：追加用户决策记录到 chapter-approvals/feedback.jsonl
 * - loadProxyApprovalFeedback：读取反馈记录（可选按 chapterId 过滤）
 * - computeEditedTextDiff：计算原稿 vs 用户稿差异摘要
 *
 * 反馈记录内容：
 * - timestamp / approvalId / chapterId / workspaceId
 * - action（accept / accept_with_edits / reject / inspect / rollback）
 * - factGuardPassed（accept_with_edits 时的 FactGuard 重跑结果）
 * - editedTextDiff（用户修改 diff 摘要）
 * - proxyJudgmentBias（代理推荐 vs 用户决策是否一致）
 * - rollbackResult（rollback 时的回滚结果）
 *
 * 设计原则：
 * - append-only：feedback.jsonl 只追加，不修改历史记录
 * - 每条记录一行 JSON（jsonl 格式），便于流式读取和追加
 * - 目录穿越防护（chapterId / approvalId 安全校验，与 draft-checkpoint 同模式）
 * - 损坏 JSON 行抛错（不静默返回 null）
 * - 不写 chapters/、不提交状态、不调用模型
 *
 * 边界（READY_LOCAL）：
 * - 闭包自包含（仅依赖 node:fs / node:path）
 * - 不依赖 finalization / draft-checkpoint 运行时（调用方负责构造反馈记录）
 * - 当前阶段在 dist-test/ 闭包；未来 G7 真实集成时由 prod 入口拉入 prod 闭包
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

// ============================================================================
// 类型
// ============================================================================

/** 用户修改 diff 摘要 */
export interface EditedTextDiff {
  originalLength: number;
  editedLength: number;
  lengthDelta: number;
  same: boolean;
  diffSummary: string;
}

/** 代理判断偏差（代理推荐 vs 用户决策） */
export interface ProxyJudgmentBias {
  /** 代理推荐的候选来源（raw/editorial/system_selected） */
  proxyRecommendedSource: string;
  /** 用户实际接受的来源 */
  userAcceptedSource: string;
  /** 代理推荐与用户决策是否一致 */
  aligned: boolean;
}

/** 用户定稿动作类型 */
export type FeedbackAction =
  | "accept"
  | "accept_with_edits"
  | "reject"
  | "inspect"
  | "rollback";

/** 反馈记录 */
export interface ProxyApprovalFeedbackRecord {
  timestamp: string;
  approvalId: string;
  chapterId: string;
  workspaceId: string;
  action: FeedbackAction;
  /** FactGuard 重跑结果（仅 accept_with_edits） */
  factGuardPassed?: boolean;
  /** 用户修改 diff 摘要（仅 accept_with_edits） */
  editedTextDiff?: EditedTextDiff;
  /** 代理判断偏差 */
  proxyJudgmentBias: ProxyJudgmentBias;
  /** rollback 结果（仅 rollback） */
  rollbackResult?: {
    rolledBack: boolean;
    backupPath?: string;
    narrativeStateRestoreRequired?: boolean;
  };
}

/** recordProxyApprovalFeedback 选项 */
export interface RecordProxyApprovalFeedbackOptions {
  workspacePath: string;
  feedback: ProxyApprovalFeedbackRecord;
}

// ============================================================================
// 安全校验
// ============================================================================

/** chapterId 安全字符集（与 draft-checkpoint / finalization 同模式） */
const SAFE_CHAPTER_ID_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_APPROVAL_ID_RE = /^[A-Za-z0-9_-]+$/;

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

function assertSafeApprovalId(approvalId: string): void {
  if (
    typeof approvalId !== "string" ||
    approvalId.length === 0 ||
    !SAFE_APPROVAL_ID_RE.test(approvalId)
  ) {
    throw new Error(
      `approvalId 含非法字符或为空（仅允许字母数字、dash、underscore）：${JSON.stringify(approvalId)}`,
    );
  }
}

// ============================================================================
// 路径解析
// ============================================================================

/**
 * feedback.jsonl 路径：workspaces/{id}/chapter-approvals/feedback.jsonl
 *
 * 与 draft-checkpoint / registry 共用 chapter-approvals/ 目录，
 * 但文件名 feedback.jsonl 是独立的，不与 draft/registry 文件冲突。
 */
export function resolveFeedbackFilePath(workspacePath: string): string {
  return join(workspacePath, "chapter-approvals", "feedback.jsonl");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// computeEditedTextDiff
// ============================================================================

/**
 * 计算原稿 vs 用户稿差异摘要。
 *
 * 简单实现：长度差 + 是否相同 + 人类可读摘要。
 * 不做 char-level diff（避免引入 diff 依赖；摘要足够用于策略证据）。
 */
export function computeEditedTextDiff(
  original: string,
  edited: string,
): EditedTextDiff {
  const originalLength = original.length;
  const editedLength = edited.length;
  const lengthDelta = editedLength - originalLength;
  const same = original === edited;

  let diffSummary: string;
  if (same) {
    diffSummary = "无修改（原稿与用户稿完全一致）";
  } else if (lengthDelta > 0) {
    diffSummary = `用户稿增加 ${lengthDelta} 字符`;
  } else if (lengthDelta < 0) {
    diffSummary = `用户稿减少 ${-lengthDelta} 字符`;
  } else {
    diffSummary = "长度相同但内容有修改";
  }

  return {
    originalLength,
    editedLength,
    lengthDelta,
    same,
    diffSummary,
  };
}

// ============================================================================
// recordProxyApprovalFeedback
// ============================================================================

/**
 * 追加用户反馈记录到 feedback.jsonl（append-only）。
 *
 * - 安全校验 chapterId / approvalId（目录穿越防护）
 * - 每条记录一行 JSON（jsonl 格式）
 * - appendFileSync 追加（不覆盖历史记录）
 * - 落盘到 chapter-approvals/feedback.jsonl（隔离，不写 chapters/）
 *
 * 返回 feedbackFilePath（便于调用方审计）。
 */
export function recordProxyApprovalFeedback(
  options: RecordProxyApprovalFeedbackOptions,
): { feedbackFilePath: string } {
  const { workspacePath, feedback } = options;

  // 安全校验
  assertSafeChapterId(feedback.chapterId);
  assertSafeApprovalId(feedback.approvalId);

  const feedbackFilePath = resolveFeedbackFilePath(workspacePath);
  const feedbackDir = join(workspacePath, "chapter-approvals");
  ensureDir(feedbackDir);

  // 追加一行 JSON（append-only）
  const line = JSON.stringify(feedback) + "\n";
  appendFileSync(feedbackFilePath, line, "utf-8");

  return { feedbackFilePath };
}

// ============================================================================
// loadProxyApprovalFeedback
// ============================================================================

/**
 * 读取反馈记录（可选按 chapterId 过滤）。
 *
 * - 文件不存在 → 返回空数组
 * - 文件存在 → 按行解析 JSON
 * - 损坏 JSON 行抛错（不静默返回 null）
 * - chapterId 过滤时校验安全（目录穿越防护）
 *
 * @param workspacePath workspace 路径
 * @param chapterId 可选：只返回该章的反馈记录
 */
export function loadProxyApprovalFeedback(
  workspacePath: string,
  chapterId?: string,
): ProxyApprovalFeedbackRecord[] {
  if (chapterId !== undefined) {
    assertSafeChapterId(chapterId);
  }

  const feedbackFilePath = resolveFeedbackFilePath(workspacePath);
  if (!existsSync(feedbackFilePath)) {
    return [];
  }

  const content = readFileSync(feedbackFilePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  const records: ProxyApprovalFeedbackRecord[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(
        `feedback.jsonl JSON 解析失败：${(e as Error).message}，行内容：${line.slice(0, 100)}`,
      );
    }
    const record = parsed as ProxyApprovalFeedbackRecord;
    if (chapterId !== undefined && record.chapterId !== chapterId) {
      continue;
    }
    records.push(record);
  }

  return records;
}

// ============================================================================
// Ingest Cursor — 已摄入 approvalId 游标（P1 重复摄入防护，计划 §12.2）
// ============================================================================

/**
 * 已摄入 approvalId 集合的持久化游标。
 *
 * 防止同一 approvalId 被重复摄入策略证据（P1 重复摄入阻断）：
 * - 第一次 accept(cpa-001) → ingest cpa-001 → cursor={cpa-001}
 * - 第二次 accept(cpa-002) → ingest cpa-002（跳过 cpa-001）→ cursor={cpa-001,cpa-002}
 *
 * 落盘到 chapter-approvals/ingest-cursor.json（与 feedback.jsonl 同目录）。
 * 原子写入：temp → rename。文件不存在时返回空集合。
 */
export interface IngestCursor {
  /** 已摄入的 approvalId 集合（去重） */
  ingestedApprovalIds: string[];
  /** 最后更新时间戳（ISO 字符串） */
  updatedAt: string;
}

/** ingest-cursor.json 路径 */
export function resolveIngestCursorFilePath(workspacePath: string): string {
  return join(workspacePath, "chapter-approvals", "ingest-cursor.json");
}

/** 加载已摄入 approvalId 游标（文件不存在时返回空集合） */
export function loadIngestCursor(workspacePath: string): Set<string> {
  const cursorPath = resolveIngestCursorFilePath(workspacePath);
  if (!existsSync(cursorPath)) {
    return new Set<string>();
  }
  try {
    const content = readFileSync(cursorPath, "utf-8");
    const parsed = JSON.parse(content) as IngestCursor;
    if (!Array.isArray(parsed.ingestedApprovalIds)) {
      return new Set<string>();
    }
    return new Set<string>(
      parsed.ingestedApprovalIds.filter((id) => typeof id === "string"),
    );
  } catch {
    return new Set<string>();
  }
}

/**
 * 保存已摄入 approvalId 游标（原子写入）。
 *
 * @param workspacePath workspace 路径
 * @param ingestedApprovalIds 已摄入的 approvalId 集合
 */
export function saveIngestCursor(
  workspacePath: string,
  ingestedApprovalIds: Set<string>,
): void {
  const cursorPath = resolveIngestCursorFilePath(workspacePath);
  const cursorDir = join(workspacePath, "chapter-approvals");
  ensureDir(cursorDir);

  const cursor: IngestCursor = {
    ingestedApprovalIds: Array.from(ingestedApprovalIds),
    updatedAt: new Date().toISOString(),
  };

  // 原子写入：temp → rename
  const tmpPath = cursorPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(cursor, null, 2), "utf-8");
  renameSync(tmpPath, cursorPath);
}

// ============================================================================
// Idempotency Keys — 幂等键持久化（P1 幂等阻断，计划 §12.2）
// ============================================================================

/**
 * 幂等键 → 已处理结果摘要的映射。
 *
 * 同一 idempotencyKey 重调时返回 idempotent=true，不重复执行定稿操作：
 * - 第一次调用 key-001 → 执行 → 保存 key-001 → {approvalId, timestamp}
 * - 第二次调用 key-001 → 命中游标 → idempotent=true，不执行
 *
 * 落盘到 chapter-approvals/idempotency-keys.json（与 feedback.jsonl 同目录）。
 * 原子写入：temp → rename。文件不存在时返回空映射。
 */
export interface IdempotencyKeyEntry {
  /** 关联的 approvalId（用于审计） */
  approvalId: string;
  /** 处理时间戳（ISO 字符串） */
  processedAt: string;
  /** 关联的 action（用于审计） */
  action: string;
}

export type IdempotencyKeyStore = Record<string, IdempotencyKeyEntry>;

/** idempotency-keys.json 路径 */
export function resolveIdempotencyKeysFilePath(workspacePath: string): string {
  return join(workspacePath, "chapter-approvals", "idempotency-keys.json");
}

/** 加载幂等键存储（文件不存在时返回空对象） */
export function loadIdempotencyKeys(workspacePath: string): IdempotencyKeyStore {
  const keysPath = resolveIdempotencyKeysFilePath(workspacePath);
  if (!existsSync(keysPath)) {
    return {};
  }
  try {
    const content = readFileSync(keysPath, "utf-8");
    const parsed = JSON.parse(content) as IdempotencyKeyStore;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

/** 检查幂等键是否已存在 */
export function hasIdempotencyKey(
  workspacePath: string,
  key: string,
): boolean {
  const store = loadIdempotencyKeys(workspacePath);
  return Object.prototype.hasOwnProperty.call(store, key);
}

/**
 * 记录幂等键处理结果（原子写入）。
 *
 * @param workspacePath workspace 路径
 * @param key 幂等键
 * @param entry 处理结果摘要
 */
export function recordIdempotencyKey(
  workspacePath: string,
  key: string,
  entry: IdempotencyKeyEntry,
): void {
  const keysPath = resolveIdempotencyKeysFilePath(workspacePath);
  const keysDir = join(workspacePath, "chapter-approvals");
  ensureDir(keysDir);

  const store = loadIdempotencyKeys(workspacePath);
  store[key] = entry;

  // 原子写入：temp → rename
  const tmpPath = keysPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), "utf-8");
  renameSync(tmpPath, keysPath);
}
