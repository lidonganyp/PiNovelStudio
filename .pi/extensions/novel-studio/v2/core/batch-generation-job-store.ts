/**
 * BatchGenerationJobStore — 批量章节生成任务状态持久化
 *
 * 持久化批量任务状态（BatchJobState）、章节结果、checkpoint、原子保存。
 * 模式蓝本：v2/learning/strategy-policy-store.ts
 *
 * 存储：workspaces/{id}/batch-jobs/{jobId}.json
 *
 * 设计原则：
 * - 原子保存（tmp → rename，复用 orchestrator-commit-save.ts:atomicSave）
 * - 幂等性双校验：章节文件存在 AND narrative-state-store.json 含 finalText-anchored entry
 * - 重复 resume 不得重复提交已完成章节
 * - 进程中断后从最后一个已提交章节恢复
 *
 * BATCH-P0-02 / BATCH-P0-06 / BATCH-P0-08
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { atomicSave } from "./orchestrator-commit-save.js";

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
  status: "pending" | "running" | "completed" | "failed" | "skipped";
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
 * 原子保存批量任务状态。
 * 接受 Store 实例或裸 BatchJobState。
 */
export function saveBatchJobStore(
  store: BatchGenerationJobStore | BatchJobState,
  workspaceId: string,
  jobId: string,
  projectRoot: string,
): void {
  const state = store instanceof BatchGenerationJobStore ? store.toJSON() : store;
  const path = batchJobPath(workspaceId, jobId, projectRoot);
  atomicSave(path, JSON.stringify(state, null, 2));
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
