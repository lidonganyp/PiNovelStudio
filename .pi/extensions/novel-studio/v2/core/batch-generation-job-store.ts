/**
 * BatchGenerationJobStore — 批量章节生成任务状态持久化（Wave 2：revision/CAS）
 *
 * 持久化批量任务状态（BatchJobState）、章节结果、checkpoint、原子保存。
 * 模式蓝本：v2/learning/strategy-policy-store.ts
 *
 * 存储：workspaces/{id}/batch-jobs/{jobId}.json
 *
 * 设计原则：
 * - 原子保存（tmp → rename，复用 orchestrator-commit-save.ts:atomicSave）
 * - CONCURRENCY-WAVE2：compare-and-swap 保存。每个 BatchJobState 携带
 *   stateRevision（磁盘单调递增）、lastEventId（最近状态转移事件）、
 *   ownerRunId（当前持锁 run）。saveBatchJobStore 在 per-job CAS guard
 *   （{jobId}.cas-lock，'wx' 原子创建 + 僵死接管）内执行
 *   "读磁盘 revision → 与期望比较 → 写入 revision+1"。
 *   磁盘 revision 不等于期望时返回 concurrent_state_update，保留磁盘状态，
 *   不做覆盖重试。保存成功会把新 revision 回写到调用方的 state 对象，
 *   使"load → 原地修改 → save"链式 CAS 自动成立（乐观并发控制）。
 * - 幂等性双校验：章节文件存在 AND narrative-state-store.json 含 finalText-anchored entry
 * - 重复 resume 不得重复提交已完成章节
 * - 进程中断后从最后一个已提交章节恢复
 *
 * BATCH-P0-02 / BATCH-P0-06 / BATCH-P0-08 / CONCURRENCY-WAVE2
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "path";
import { atomicSave } from "./orchestrator-commit-save.js";
import { withExclusiveGuard } from "./fs-atomic.js";

// ============================================================================
// 常量
// ============================================================================

const BATCH_JOBS_DIR = "batch-jobs";
const BATCH_JOB_FILE_EXT = ".json";

/** 默认批量任务上限 */
export const DEFAULT_MAX_CHAPTERS = 100;

/** confirmLargeBatch 放宽上限 */
export const LARGE_BATCH_MAX_CHAPTERS = 1000;

// ============================================================================
// 安全校验（P0-FIX-1：路径穿越防护）
// ============================================================================

/** workspaceId / jobId 合法字符集：字母数字开头，允许 - _ */
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * 校验 workspaceId：拒绝路径穿越（.., /, \）和特殊字符。
 * 抛出 Error 而非静默返回——路径穿越是安全阻断项，不应被吞掉。
 */
export function validateWorkspaceId(workspaceId: string): void {
  if (
    !workspaceId ||
    typeof workspaceId !== "string" ||
    !SAFE_ID_RE.test(workspaceId) ||
    workspaceId.includes("..")
  ) {
    throw new Error(`Invalid workspaceId: "${workspaceId}" — must match ${SAFE_ID_RE} and contain no path traversal`);
  }
}

/**
 * 校验 jobId：同 workspaceId 规则。
 * generateJobId() 产出 batch-{timestamp}-{rand} 格式，天然合法。
 * 用户自定义 jobId 需通过同一校验。
 */
export function validateJobId(jobId: string): void {
  if (
    !jobId ||
    typeof jobId !== "string" ||
    !SAFE_ID_RE.test(jobId) ||
    jobId.includes("..")
  ) {
    throw new Error(`Invalid jobId: "${jobId}" — must match ${SAFE_ID_RE} and contain no path traversal`);
  }
}

// ============================================================================
// 类型
// ============================================================================

export interface BatchChapterResult {
  /** 章节编号 */
  chapterNumber: number;
  /** 章节 ID（与 chapterNumber 一致：String(chapterNumber)） */
  chapterId: string;
  /** 章节状态 */
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "checkpoint";
  /** 开始时间 ISO timestamp */
  startedAt?: string;
  /** 完成时间 ISO timestamp */
  completedAt?: string;
  /** 耗时（毫秒） */
  durationMs?: number;
  /** 该章模型调用次数（来自 stageResults.modelCallCount） */
  modelCalls?: number;
  /** 状态提交结果 */
  stateCommitResult?: { ok: true } | { ok: false; reason: string };
  /** 失败时的结构化 FailureEnvelope */
  failureEnvelope?: unknown;
  /** 落盘的 chapters/{N}.md 路径 */
  chapterFilePath?: string;
  /** traces/{chapterId}-quality-trace.json 路径 */
  tracePath?: string;
  /**
   * AUTONOMY-P5：本章独立授权 scope / checkpoint 绑定。
   * 批量任务不能获得无限期 chapter.save 授权；每章独立确认。
   */
  authorizationScope?: {
    workspaceId: string;
    chapterId: string;
    batchJobId: string;
    artifactHash?: string;
    approvalId?: string;
    revision?: string;
  };
  /** 中断原因（checkpoint / blocked / failed） */
  interruptReason?: string;
}

export interface BatchJobSummary {
  totalChapters: number;
  completedChapters: number;
  failedChapters: number;
  totalDurationMs: number;
  totalModelCalls: number;
  failureEnvelopes: unknown[];
}

export interface BatchJobState {
  /** 任务 ID：batch-{timestamp}-{rand} */
  jobId: string;
  workspaceId: string;
  /** 任务状态 */
  status: "running" | "completed" | "paused" | "cancelled" | "error";
  startChapter: number;
  endChapter: number;
  seedSource: "workspace_or_planner" | "workspace_only";
  stopOnFailure: boolean;
  confirmLargeBatch: boolean;
  createdAt: string;
  updatedAt: string;
  /** 当前 frontier：下一个待生成章节号（completedChapters + 1） */
  frontier: number;
  /** 已完成的章节号集合（幂等性判定依据，配合文件存在性双校验） */
  completedChapters: number[];
  /** 失败的章节（触发暂停） */
  failedChapter: number | null;
  /** 全部章节结果（按章节号索引：chapters[chapterNumber - startChapter]） */
  chapters: BatchChapterResult[];
  /** 取消请求标志（cancel action 设置，编排循环每章前检查） */
  cancelRequested: boolean;
  /** summary（任务完成或暂停时填充） */
  summary?: BatchJobSummary;
  /**
   * AUTONOMY-P5：批量生成剩余预算（可生成初稿/checkpoint 的章节数）。
   * 不包含无限期 chapter.save 授权。
   */
  remainingDraftBudget?: number;
  /**
   * AUTONOMY-P5：中断原因（checkpoint_pending / blocked / failed / cancelled）。
   * 进程重启只能从 checkpoint 恢复，不能自动推断用户批准。
   */
  interruptReason?: string;
  /**
   * AUTONOMY-P5：暂停在 checkpoint 的章节号（未确认，不得推进 frontier）。
   */
  checkpointChapter?: number | null;
  /**
   * CONCURRENCY-WAVE2：状态修订号（磁盘单调递增）。
   * 保存时作为 CAS 期望值；成功后回写新值。缺省视为 0（legacy 状态文件）。
   */
  stateRevision?: number;
  /**
   * CONCURRENCY-WAVE2：最近一次状态转移事件 ID（evt-{rev}-{event}-{uuid8}）。
   * 崩溃恢复时按事件事实判断状态，而不是按文件存在推断。
   */
  lastEventId?: string | null;
  /**
   * CONCURRENCY-WAVE2：当前持有该任务的 run 实例 ID（与批量锁 ownerRunId 同源）。
   * resume 产生新 ownerRunId；两个 resume 不能同时接管同一任务。
   */
  ownerRunId?: string | null;
  /**
   * 批量任务级统一预算账本。跨章累计；下一章启动前必须先 admit。
   */
  budgetLedger?: import("./budget-types.js").BudgetLedger;
}

// ============================================================================
// Store 类
// ============================================================================

/**
 * 批量任务状态 Store。
 * 持有 BatchJobState 的可变引用，提供更新与持久化方法。
 */
export class BatchGenerationJobStore {
  private data: BatchJobState;

  constructor(workspaceId: string, initial?: Partial<BatchJobState>) {
    const now = new Date().toISOString();
    this.data = {
      jobId: initial?.jobId ?? "",
      workspaceId,
      status: initial?.status ?? "running",
      startChapter: initial?.startChapter ?? 1,
      endChapter: initial?.endChapter ?? 1,
      seedSource: initial?.seedSource ?? "workspace_or_planner",
      stopOnFailure: initial?.stopOnFailure ?? true,
      confirmLargeBatch: initial?.confirmLargeBatch ?? false,
      createdAt: initial?.createdAt ?? now,
      updatedAt: initial?.updatedAt ?? now,
      frontier: initial?.frontier ?? (initial?.startChapter ?? 1),
      completedChapters: initial?.completedChapters ?? [],
      failedChapter: initial?.failedChapter ?? null,
      chapters: initial?.chapters ?? [],
      cancelRequested: initial?.cancelRequested ?? false,
      summary: initial?.summary,
      remainingDraftBudget:
        initial?.remainingDraftBudget ??
        Math.max(
          0,
          (initial?.endChapter ?? 1) - (initial?.startChapter ?? 1) + 1,
        ),
      interruptReason: initial?.interruptReason,
      checkpointChapter: initial?.checkpointChapter ?? null,
      stateRevision: initial?.stateRevision ?? 0,
      lastEventId: initial?.lastEventId ?? null,
      ownerRunId: initial?.ownerRunId ?? null,
      budgetLedger: initial?.budgetLedger,
    };
  }

  get state(): BatchJobState {
    return this.data;
  }

  /** 直接更新内部 state（用于编排器原地修改后同步） */
  syncFromState(state: BatchJobState): void {
    this.data = { ...state };
  }

  toJSON(): BatchJobState {
    return {
      ...this.data,
      chapters: [...this.data.chapters],
      completedChapters: [...this.data.completedChapters],
    };
  }
}

// ============================================================================
// 持久化函数
// ============================================================================

/**
 * 返回批量任务状态文件路径。
 * workspaces/{workspaceId}/batch-jobs/{jobId}.json
 */
export function batchJobPath(workspaceId: string, jobId: string, projectRoot: string): string {
  validateWorkspaceId(workspaceId);
  validateJobId(jobId);
  return join(projectRoot, "workspaces", workspaceId, BATCH_JOBS_DIR, `${jobId}${BATCH_JOB_FILE_EXT}`);
}

/**
 * 加载批量任务状态。文件不存在返回 null。
 */
export function loadBatchJobStore(
  workspaceId: string,
  jobId: string,
  projectRoot: string,
): BatchGenerationJobStore | null {
  const path = batchJobPath(workspaceId, jobId, projectRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    // 确保 chapters 数组长度覆盖 startChapter..endChapter 范围
    const totalSlots = raw.endChapter - raw.startChapter + 1;
    if (!Array.isArray(raw.chapters) || raw.chapters.length < totalSlots) {
      const chapters: BatchChapterResult[] = [];
      for (let i = 0; i < totalSlots; i++) {
        chapters[i] = raw.chapters?.[i] ?? {
          chapterNumber: raw.startChapter + i,
          chapterId: String(raw.startChapter + i),
          status: "pending" as const,
        };
      }
      raw.chapters = chapters;
    }
    return new BatchGenerationJobStore(workspaceId, raw);
  } catch {
    return null;
  }
}

/**
 * CONCURRENCY-WAVE2：CAS 保存结果。
 * - ok=true：写入成功，stateRevision 为新修订号
 * - ok=false + concurrent_state_update：磁盘修订号与期望不符（他方已写入），
 *   磁盘状态被保留，调用方不得盲目覆盖重试
 * - ok=false + state_file_corrupt：磁盘状态文件损坏，fail-closed 拒绝覆盖
 */
export type SaveBatchJobResult =
  | { ok: true; stateRevision: number; lastEventId: string }
  | {
      ok: false;
      reason: "concurrent_state_update" | "state_file_corrupt";
      diskRevision: number;
      expectedRevision: number;
    };

export interface SaveBatchJobOptions {
  /**
   * 显式期望修订号。缺省使用 state.stateRevision（乐观并发：
   * 调用方的内存副本必须基于磁盘最新版本——load 出来的对象天然满足）。
   */
  expectedRevision?: number;
  /** 状态转移标签（写入 lastEventId，如 "chapter_completed:5" / "cancel_requested"） */
  event?: string;
}

/**
 * 原子保存批量任务状态（CONCURRENCY-WAVE2：compare-and-swap）。
 *
 * 在 per-job CAS guard（{jobId}.cas-lock）内执行：
 *   读磁盘 revision → 与期望比较 → 写入 revision+1（含 lastEventId）
 *
 * - 磁盘不存在（首次创建）：以期望值为基线写入期望+1；
 * - 磁盘 revision === 期望：写入 期望+1，并把新 revision/lastEventId 回写到
 *   调用方传入的 state 对象（使连续 save 链式 CAS 成立）；
 * - 磁盘 revision !== 期望：返回 concurrent_state_update，磁盘不动；
 * - 磁盘损坏：返回 state_file_corrupt（fail-closed，不覆盖）。
 *
 * 接受 Store 实例或裸 BatchJobState。
 */
export function saveBatchJobStore(
  store: BatchGenerationJobStore | BatchJobState,
  workspaceId: string,
  jobId: string,
  projectRoot: string,
  options?: SaveBatchJobOptions,
): SaveBatchJobResult {
  validateWorkspaceId(workspaceId);
  validateJobId(jobId);
  const isStore = store instanceof BatchGenerationJobStore;
  const state = isStore ? store.toJSON() : store;
  const path = batchJobPath(workspaceId, jobId, projectRoot);
  const stateDir = join(projectRoot, "workspaces", workspaceId, BATCH_JOBS_DIR);
  if (!existsSync(stateDir)) {
    try { mkdirSync(stateDir, { recursive: true }); } catch { /* 已存在 */ }
  }
  const casLockPath = join(stateDir, `${jobId}.cas-lock`);
  const expectedRevision = options?.expectedRevision ?? state.stateRevision ?? 0;

  return withExclusiveGuard<SaveBatchJobResult>(casLockPath, () => {
    let diskRevision = 0;
    const diskExists = existsSync(path);
    if (diskExists) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        diskRevision = Number(raw?.stateRevision ?? 0) || 0;
      } catch {
        return {
          ok: false,
          reason: "state_file_corrupt",
          diskRevision: -1,
          expectedRevision,
        };
      }
    }
    if (diskExists && diskRevision !== expectedRevision) {
      return {
        ok: false,
        reason: "concurrent_state_update",
        diskRevision,
        expectedRevision,
      };
    }
    const newRevision = (diskExists ? diskRevision : expectedRevision) + 1;
    const eventTag = options?.event ? `${options.event}-` : "";
    const lastEventId = `evt-${newRevision}-${eventTag}${randomUUID().slice(0, 8)}`;
    const next: BatchJobState = {
      ...state,
      stateRevision: newRevision,
      lastEventId,
      updatedAt: new Date().toISOString(),
    };
    atomicSave(path, JSON.stringify(next, null, 2));
    appendBatchJobEvent(workspaceId, jobId, projectRoot, {
      eventId: lastEventId,
      jobId,
      event: options?.event ?? "state_saved",
      stateRevision: newRevision,
      recordedAt: next.updatedAt,
    });
    // 回写新 revision 到调用方对象：连续 "load → modify → save" 链式 CAS 自动成立
    if (isStore) {
      (store as BatchGenerationJobStore).syncFromState(next);
    } else {
      const mutable = store as BatchJobState;
      mutable.stateRevision = newRevision;
      mutable.lastEventId = lastEventId;
      mutable.updatedAt = next.updatedAt;
    }
    return { ok: true, stateRevision: newRevision, lastEventId };
  });
}

/**
 * CONCURRENCY-WAVE2：控制字段原子更新（reload → mutate → CAS save → 冲突重试）。
 *
 * 供 cancel 等外部控制操作使用：与编排器的状态保存并发时，CAS 冲突
 * 通过"重读磁盘最新事实 → 重新施加变更"解决，而不是覆盖他方写入。
 * 重试耗尽返回结构化失败（不静默丢弃控制请求）。
 */
export function updateBatchJobControlFields(
  workspaceId: string,
  jobId: string,
  projectRoot: string,
  mutator: (state: BatchJobState) => void,
  maxAttempts: number = 3,
): { ok: true; state: BatchJobState } | { ok: false; reason: string } {
  validateWorkspaceId(workspaceId);
  validateJobId(jobId);
  let lastConflict: SaveBatchJobResult | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const loaded = loadBatchJobStore(workspaceId, jobId, projectRoot);
    if (!loaded) {
      return { ok: false, reason: `jobId ${jobId} 不存在` };
    }
    const state = loaded.state;
    mutator(state);
    const res = saveBatchJobStore(state, workspaceId, jobId, projectRoot, {
      expectedRevision: state.stateRevision ?? 0,
    });
    if (res.ok) {
      return { ok: true, state };
    }
    lastConflict = res;
  }
  return {
    ok: false,
    reason: `concurrent_state_update：控制字段更新在 ${maxAttempts} 次重试后仍冲突（last=${lastConflict && !lastConflict.ok ? lastConflict.reason : "unknown"}），请重试`,
  };
}

/**
 * 幂等性双校验：章节是否已完成。
 *
 * 双校验条件（两者都满足才视为已完成）：
 *   1. chapters/{N}.md 文件存在
 *   2. narrative-state-store.json 含 sourceChapter=ch{N} 的 finalText-anchored entry
 *
 * 单一条件不足：
 *   - 章节文件存在但 state store 无 entry → 视为未完成（state 未提交）
 *   - state store 有 entry 但章节文件缺失 → 视为未完成（文件丢失）
 */
export function isChapterAlreadyCompleted(
  workspaceId: string,
  chapterNumber: number,
  projectRoot: string,
): boolean {
  validateWorkspaceId(workspaceId);
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  const chapterFile = join(workspacePath, "chapters", `${chapterNumber}.md`);
  if (!existsSync(chapterFile)) return false;

  const stateStorePath = join(workspacePath, "narrative-state-store.json");
  if (!existsSync(stateStorePath)) return false;
  try {
    const store = JSON.parse(readFileSync(stateStorePath, "utf-8"));
    const allEntries: any[] = [
      ...(Array.isArray(store.canon) ? store.canon : []),
      ...(Array.isArray(store.character) ? store.character : []),
      ...(Array.isArray(store.promise) ? store.promise : []),
      ...(Array.isArray(store.pattern) ? store.pattern : []),
      ...(Array.isArray(store.expectation) ? store.expectation : []),
    ];
    const chapterId = `ch${chapterNumber}`;
    return allEntries.some(
      (e: any) =>
        e &&
        typeof e === "object" &&
        e.sourceChapter === chapterId &&
        typeof e.sourceRef === "string" &&
        e.sourceRef.includes("#finalText:"),
    );
  } catch {
    return false;
  }
}

/**
 * 生成新的 jobId：batch-{timestamp}-{rand}
 */
export function generateJobId(): string {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1e6).toString(36).padStart(4, "0");
  return `batch-${ts}-${rand}`;
}

// ============================================================================
// CONCURRENCY-WAVE5：workspace 级 commandId 收据账本
// ============================================================================

const COMMAND_LEDGER_FILE = "command-receipts.json";
const SAFE_COMMAND_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export type BatchConcurrencyError =
  | "concurrent_state_update"
  | "state_file_corrupt"
  | "already_consumed"
  | "stale_revision"
  | "missing_command_id"
  | "idempotency_receipt_failed"
  | "recovery_trace_failed";

export interface BatchCommandResultSnapshot {
  status: BatchJobState["status"] | "error";
  jobId: string;
  currentChapter: number | null;
  completedChapters: number;
  totalChapters: number;
  failedChapter: number | null;
  checkpointPath: string;
  concurrencyError?: BatchConcurrencyError;
  failureEnvelope?: unknown;
  summary?: BatchJobSummary;
}

export interface BatchCommandReceipt {
  commandId: string;
  action: string;
  jobId: string;
  recordedAt: string;
  result: BatchCommandResultSnapshot;
}

interface BatchCommandLedger {
  schemaVersion: 1;
  receipts: Record<string, BatchCommandReceipt>;
}

export function validateCommandId(commandId: string): void {
  if (!SAFE_COMMAND_ID_RE.test(commandId)) {
    throw new Error(`Invalid commandId: ${commandId}`);
  }
}

function commandLedgerPath(workspaceId: string, projectRoot: string): string {
  validateWorkspaceId(workspaceId);
  return join(projectRoot, "workspaces", workspaceId, BATCH_JOBS_DIR, COMMAND_LEDGER_FILE);
}

function emptyCommandLedger(): BatchCommandLedger {
  return { schemaVersion: 1, receipts: {} };
}

function readCommandLedger(workspaceId: string, projectRoot: string): BatchCommandLedger {
  const path = commandLedgerPath(workspaceId, projectRoot);
  if (!existsSync(path)) return emptyCommandLedger();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as BatchCommandLedger;
    if (!raw || typeof raw !== "object" || !raw.receipts) return emptyCommandLedger();
    return { schemaVersion: 1, receipts: { ...raw.receipts } };
  } catch {
    return emptyCommandLedger();
  }
}

/** 查找 workspace 内已记录的 commandId。未命中返回 null。 */
export function lookupBatchCommandReceipt(
  workspaceId: string,
  commandId: string,
  projectRoot: string,
): BatchCommandReceipt | null {
  validateWorkspaceId(workspaceId);
  validateCommandId(commandId);
  const entry = readCommandLedger(workspaceId, projectRoot).receipts[commandId];
  return entry ?? null;
}

/**
 * 原子记录 commandId 首次结果。相同 commandId 已存在时不覆盖，返回已有收据。
 * 写入失败返回 ok=false，不得假装已记录。
 */
export function recordBatchCommandReceipt(
  workspaceId: string,
  receipt: BatchCommandReceipt,
  projectRoot: string,
): { ok: true; receipt: BatchCommandReceipt; created: boolean } | { ok: false; reason: string } {
  validateWorkspaceId(workspaceId);
  validateCommandId(receipt.commandId);
  const stateDir = join(projectRoot, "workspaces", workspaceId, BATCH_JOBS_DIR);
  if (!existsSync(stateDir)) {
    try { mkdirSync(stateDir, { recursive: true }); } catch { /* 已存在 */ }
  }
  const path = commandLedgerPath(workspaceId, projectRoot);
  const guardPath = join(stateDir, "command-receipts.cas-lock");
  try {
    return withExclusiveGuard(guardPath, () => {
      const ledger = readCommandLedger(workspaceId, projectRoot);
      const existing = ledger.receipts[receipt.commandId];
      if (existing) {
        return { ok: true as const, receipt: existing, created: false };
      }
      const next: BatchCommandLedger = {
        schemaVersion: 1,
        receipts: {
          ...ledger.receipts,
          [receipt.commandId]: receipt,
        },
      };
      atomicSave(path, JSON.stringify(next, null, 2));
      return { ok: true as const, receipt, created: true };
    });
  } catch (e: unknown) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export type BatchRecoveryDecision =
  | "completed"
  | "retry"
  | "checkpoint"
  | "blocked";

export interface BatchJobEventRecord {
  eventId: string;
  jobId: string;
  event: string;
  stateRevision?: number;
  recordedAt?: string;
}

export interface ChapterCommitReceiptRecord {
  receiptId: string;
  commitIntentId: string;
  artifactHash: string;
  chapterFileHash: string;
  narrativeStateRevision: string;
  recordedAt: string;
}

export interface ChapterCommitFacts {
  chapterNumber: number;
  lastEventId: string | null;
  eventStreamVerified: boolean;
  chapterFilePresent: boolean;
  chapterFileHash: string | null;
  narrativeStateAnchored: boolean;
  narrativeStateRevision: string | null;
  narrativeStateRevisionMatches: boolean;
  commitIntentId: string | null;
  commitIntentCompleted: boolean;
  commitIntentHash: string | null;
  hashMatchesIntent: boolean;
  commitReceiptPresent: boolean;
  receiptId: string | null;
}

export interface BatchCrashReconciliation {
  decision: BatchRecoveryDecision;
  reason: string;
  recoveredChapters: number[];
  incompleteChapter: number | null;
  facts: ChapterCommitFacts[];
}

export function batchJobEventsPath(
  workspaceId: string,
  jobId: string,
  projectRoot: string,
): string {
  validateWorkspaceId(workspaceId);
  validateJobId(jobId);
  return join(projectRoot, "workspaces", workspaceId, BATCH_JOBS_DIR, `${jobId}.events.jsonl`);
}

export function appendBatchJobEvent(
  workspaceId: string,
  jobId: string,
  projectRoot: string,
  record: BatchJobEventRecord,
): void {
  const dir = join(projectRoot, "workspaces", workspaceId, BATCH_JOBS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(batchJobEventsPath(workspaceId, jobId, projectRoot), `${JSON.stringify(record)}\n`, "utf-8");
}

export function loadBatchJobEventStream(
  workspaceId: string,
  jobId: string,
  projectRoot: string,
): BatchJobEventRecord[] {
  const path = batchJobEventsPath(workspaceId, jobId, projectRoot);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BatchJobEventRecord)
      .filter((e) => e && typeof e.eventId === "string");
  } catch {
    return [];
  }
}

export function chapterCommitReceiptPath(workspacePath: string, chapterNumber: number): string | null {
  const ids = [String(chapterNumber), `ch${chapterNumber}`];
  for (const chapterId of ids) {
    const path = join(workspacePath, "chapter-approvals", `${chapterId}.commit-receipt.json`);
    if (existsSync(path)) return path;
  }
  return null;
}

export function loadChapterCommitReceipt(
  workspacePath: string,
  chapterNumber: number,
): ChapterCommitReceiptRecord | null {
  const path = chapterCommitReceiptPath(workspacePath, chapterNumber);
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as ChapterCommitReceiptRecord;
    if (!raw?.receiptId || !raw.artifactHash) return null;
    return raw;
  } catch {
    return null;
  }
}

function hashChapterText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function resolveChapterFile(workspacePath: string, chapterNumber: number): string | null {
  const candidates = [
    join(workspacePath, "chapters", `${chapterNumber}.md`),
    join(workspacePath, "chapters", `chapter-${chapterNumber}.md`),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function loadCompletedCommitIntent(
  workspacePath: string,
  chapterNumber: number,
): { commitIntentId: string; artifactHash: string } | null {
  const ids = [String(chapterNumber), `ch${chapterNumber}`];
  for (const chapterId of ids) {
    const path = join(workspacePath, "chapter-approvals", `${chapterId}.commit-intents.json`);
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as {
        entries?: Record<string, { commitIntentId?: string; artifactHash?: string; status?: string }>;
      };
      const entries = raw?.entries ?? {};
      for (const entry of Object.values(entries)) {
        if (entry?.status === "completed" && entry.artifactHash && entry.commitIntentId) {
          return { commitIntentId: entry.commitIntentId, artifactHash: entry.artifactHash };
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 读取单章恢复事实源：事件 ID、commit intent、正文 hash、NarrativeState、commit receipt。
 */
export function inspectChapterCommitFacts(
  workspaceId: string,
  chapterNumber: number,
  projectRoot: string,
  options: { jobId?: string | null; lastEventIdHint?: string | null } = {},
): ChapterCommitFacts {
  validateWorkspaceId(workspaceId);
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  const chapterFile = resolveChapterFile(workspacePath, chapterNumber);
  let chapterFileHash: string | null = null;
  if (chapterFile) {
    try { chapterFileHash = hashChapterText(readFileSync(chapterFile, "utf-8")); } catch { chapterFileHash = null; }
  }
  const anchored = isChapterAlreadyCompleted(workspaceId, chapterNumber, projectRoot);
  let narrativeStateRevision: string | null = null;
  const nsPath = join(workspacePath, "narrative-state-store.json");
  if (existsSync(nsPath)) {
    try {
      const ns = JSON.parse(readFileSync(nsPath, "utf-8")) as { lastCommittedChapter?: string };
      narrativeStateRevision = ns.lastCommittedChapter ?? null;
    } catch { /* ignore */ }
  }
  const revNum = Number(String(narrativeStateRevision ?? "").replace(/\D/g, "") || 0);
  const narrativeStateRevisionMatches = revNum >= chapterNumber;
  const intent = loadCompletedCommitIntent(workspacePath, chapterNumber);
  const hashMatchesIntent = Boolean(
    chapterFileHash && intent?.artifactHash && chapterFileHash === intent.artifactHash,
  );
  const receipt = loadChapterCommitReceipt(workspacePath, chapterNumber);
  const receiptHashOk = Boolean(
    receipt?.receiptId &&
    receipt.artifactHash &&
    chapterFileHash &&
    receipt.artifactHash === chapterFileHash,
  );
  const receiptIntentOk = !intent || !receipt?.commitIntentId || receipt.commitIntentId === intent.commitIntentId;
  const commitReceiptPresent = Boolean(receipt && receiptHashOk && receiptIntentOk);
  let eventStreamVerified = false;
  let lastEventId: string | null = null;
  if (options.jobId) {
    const stream = loadBatchJobEventStream(workspaceId, options.jobId, projectRoot);
    const hint = options.lastEventIdHint ?? null;
    const hit = hint ? stream.find((e) => e.eventId === hint) : stream.at(-1);
    eventStreamVerified = Boolean(hit);
    lastEventId = hit?.eventId ?? null;
  }
  return {
    chapterNumber,
    lastEventId,
    eventStreamVerified,
    chapterFilePresent: Boolean(chapterFile),
    chapterFileHash,
    narrativeStateAnchored: anchored,
    narrativeStateRevision,
    narrativeStateRevisionMatches,
    commitIntentId: intent?.commitIntentId ?? null,
    commitIntentCompleted: Boolean(intent),
    commitIntentHash: intent?.artifactHash ?? null,
    hashMatchesIntent,
    commitReceiptPresent,
    receiptId: commitReceiptPresent ? receipt?.receiptId ?? null : null,
  };
}

function chapterFactsComplete(facts: ChapterCommitFacts): boolean {
  return (
    facts.chapterFilePresent &&
    facts.narrativeStateAnchored &&
    facts.narrativeStateRevisionMatches &&
    facts.commitIntentCompleted &&
    facts.hashMatchesIntent &&
    facts.commitReceiptPresent &&
    Boolean(facts.receiptId) &&
    facts.eventStreamVerified &&
    Boolean(facts.lastEventId)
  );
}

/**
 * 崩溃恢复分类：按事件、commit intent、正文 hash、NarrativeState、receipt
 * 决定 completed / retry / checkpoint / blocked。
 * 锁存在不代表提交成功；缺任一事实源不得标 completed。
 */
export function reconcileBatchJobAfterCrash(
  state: BatchJobState,
  projectRoot: string,
): BatchCrashReconciliation {
  const recoveredChapters: number[] = [];
  let incompleteChapter: number | null = null;
  const facts: ChapterCommitFacts[] = [];
  for (let n = state.startChapter; n <= state.endChapter; n++) {
    const chapterFacts = inspectChapterCommitFacts(
      state.workspaceId,
      n,
      projectRoot,
      { jobId: state.jobId, lastEventIdHint: state.lastEventId ?? null },
    );
    facts.push(chapterFacts);
    if (chapterFactsComplete(chapterFacts)) {
      recoveredChapters.push(n);
      continue;
    }
    if (incompleteChapter === null) incompleteChapter = n;
  }
  if (state.checkpointChapter != null) {
    return {
      decision: "checkpoint",
      reason: `checkpoint_pending：第 ${state.checkpointChapter} 章待确认，frontier 不得越过`,
      recoveredChapters,
      incompleteChapter: state.checkpointChapter,
      facts,
    };
  }
  if (incompleteChapter === null) {
    return {
      decision: "completed",
      reason: "所有章节均具备事件、commit intent、正文 hash、NarrativeState 与 receipt",
      recoveredChapters,
      incompleteChapter: null,
      facts,
    };
  }
  if (state.status === "cancelled" || state.status === "error") {
    return {
      decision: "blocked",
      reason: `任务状态为 ${state.status}，崩溃恢复不得自动继续`,
      recoveredChapters,
      incompleteChapter,
      facts,
    };
  }
  return {
    decision: "retry",
    reason: `第 ${incompleteChapter} 章缺少完整提交事实源，应从该章重试`,
    recoveredChapters,
    incompleteChapter,
    facts,
  };
}
