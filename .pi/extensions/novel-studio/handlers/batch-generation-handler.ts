/**
 * BatchGenerationHandler — 批量章节生成入口 handler
 *
 * 解析 action（start / resume / status / cancel），调用 orchestrator，返回状态结构。
 *
 * 同步执行：start / resume 阻塞直到任务完成 / 暂停 / 取消。
 *
 * action 行为：
 * - start：校验范围 → 获取锁 → 创建 BatchJobState → runBatchGeneration → 释放锁
 * - resume：校验 jobId + status=paused → 获取锁 → runBatchGeneration → 释放锁
 * - status：加载 BatchJobState 返回（不获取锁，不执行生成）
 * - cancel：设置 cancelRequested=true 原子保存（不主动中断运行循环）
 *
 * CONCURRENCY-WAVE5：commandId 命中收据则幂等返回；save CAS 失败上浮
 * concurrent_state_update，不得伪装成功。
 *
 * BATCH-P0-01 / BATCH-P1-01
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "node:path";
import { atomicSave } from "../v2/core/orchestrator-commit-save.js";
import { getProjectRoot } from "../utils/config.js";
import {
  generateJobId,
  batchJobPath,
  loadBatchJobStore,
  saveBatchJobStore,
  updateBatchJobControlFields,
  validateWorkspaceId,
  validateJobId,
  validateCommandId,
  lookupBatchCommandReceipt,
  recordBatchCommandReceipt,
  reconcileBatchJobAfterCrash,
  DEFAULT_MAX_CHAPTERS,
  LARGE_BATCH_MAX_CHAPTERS,
  type BatchJobState,
  type BatchChapterResult,
  type BatchConcurrencyError,
  type BatchCommandResultSnapshot,
} from "../v2/core/batch-generation-job-store.js";
// 显式 import 以确保 orchestrator / lock 模块进入生产闭包（dist/）。
import { runBatchGeneration } from "../v2/core/batch-generation-orchestrator.js";
import {
  acquireBatchLock,
  releaseBatchLock,
  readBatchLock,
  isLockAlive,
} from "../v2/core/batch-generation-lock.js";

// ============================================================================
// 类型
// ============================================================================

export type BatchAction = "start" | "resume" | "status" | "cancel";

export interface BatchGenerationInput {
  mode: "batch";
  action: BatchAction;
  workspaceId: string;
  // action="start" 必填
  startChapter?: number;
  endChapter?: number;
  seedSource?: "workspace_or_planner" | "workspace_only";
  stopOnFailure?: boolean;
  confirmLargeBatch?: boolean;
  // action="resume"|"status"|"cancel" 必填
  jobId?: string;
  /**
   * CONCURRENCY-WAVE5：用户命令幂等键。
   * resume/cancel 建议携带；start 携带时重复提交返回首次结果。
   */
  commandId?: string;
  // 测试注入（不公开）
  _projectRoot?: string;
  _mockGenerateChapter?: (input: {
    workspaceId: string;
    chapterId: string;
    chapterNumber: number;
    _projectRoot?: string;
  }) => Promise<any>;
}

export interface BatchGenerationResult {
  status: "running" | "completed" | "paused" | "cancelled" | "error";
  jobId: string;
  currentChapter: number | null;
  completedChapters: number;
  totalChapters: number;
  failedChapter: number | null;
  checkpointPath: string;
  /** 暂停/失败时的诊断信息 */
  failureEnvelope?: unknown;
  summary?: import("../v2/core/batch-generation-job-store.js").BatchJobSummary;
  /** 相同 commandId 命中首次结果 */
  idempotent?: boolean;
  /** CAS / 命令冲突码（不得伪装为 completed/cancelled 成功） */
  concurrencyError?: BatchConcurrencyError;
}

// ============================================================================
// Handler
// ============================================================================

/**
 * 批量章节生成入口 handler。
 *
 * 由 register-tools.ts:invoke() 在 mode === "batch" 时调用。
 * 内部解析 action，委托 batch-generation-orchestrator.ts:runBatchGeneration 执行。
 */
export async function handleBatchGeneration(
  input: BatchGenerationInput,
): Promise<BatchGenerationResult> {
  const projectRoot = input._projectRoot || getProjectRoot();

  // P0-FIX-1：入口校验 workspaceId（所有 action 都需要）
  try {
    validateWorkspaceId(input.workspaceId);
  } catch (e: any) {
    return errorResult(input, projectRoot, e?.message ?? "invalid workspaceId");
  }
  // P0-FIX-1：resume/status/cancel 还需校验 jobId
  if ((input.action === "resume" || input.action === "status" || input.action === "cancel") && input.jobId) {
    try {
      validateJobId(input.jobId);
    } catch (e: any) {
      return errorResult(input, projectRoot, e?.message ?? "invalid jobId", input.jobId);
    }
  }
  if ((input.action === "resume" || input.action === "cancel") && !input.commandId) {
    return casErrorResult(
      input,
      projectRoot,
      "missing_command_id",
      "missing_command_id：resume/cancel 必须携带 commandId",
      input.jobId,
    );
  }
  if (input.commandId) {
    try {
      validateCommandId(input.commandId);
    } catch (e: any) {
      return errorResult(input, projectRoot, e?.message ?? "invalid commandId", input.jobId);
    }
    if (input.action !== "status") {
      const replay = replayCommandIfSeen(input, projectRoot);
      if (replay) return replay;
    }
  }

  switch (input.action) {
    case "start":
      return handleStart(input, projectRoot);
    case "resume":
      return handleResume(input, projectRoot);
    case "status":
      return handleStatus(input, projectRoot);
    case "cancel":
      return handleCancel(input, projectRoot);
    default:
      return errorResult(input, projectRoot, `未知 action: ${input.action}`);
  }
}

// ============================================================================
// action: start
// ============================================================================

async function handleStart(
  input: BatchGenerationInput,
  projectRoot: string,
): Promise<BatchGenerationResult> {
  const { workspaceId } = input;
  const startChapter = input.startChapter!;
  const endChapter = input.endChapter!;

  // 1. 范围校验
  if (!Number.isInteger(startChapter) || !Number.isInteger(endChapter)) {
    return errorResult(input, projectRoot, "startChapter / endChapter 必须为整数");
  }
  if (startChapter < 1) {
    return errorResult(input, projectRoot, "startChapter 必须 ≥ 1");
  }
  if (endChapter < startChapter) {
    return errorResult(input, projectRoot, "endChapter 必须 ≥ startChapter");
  }

  // 2. 上限校验
  const total = endChapter - startChapter + 1;
  if (total > LARGE_BATCH_MAX_CHAPTERS) {
    return errorResult(
      input, projectRoot,
      `批量范围 ${total} 章超过硬上限 ${LARGE_BATCH_MAX_CHAPTERS} 章`,
    );
  }
  if (total > DEFAULT_MAX_CHAPTERS && !input.confirmLargeBatch) {
    return errorResult(
      input, projectRoot,
      `批量范围 ${total} 章超过默认上限 ${DEFAULT_MAX_CHAPTERS} 章，需设置 confirmLargeBatch=true 确认`,
    );
  }

  // 3. 扩展 preflight 检查（BATCH-P1-04：缺世界观/角色档案/前章状态在生成前阻断）
  const prereqCheck = checkBatchPrerequisites(workspaceId, startChapter, projectRoot);
  if (!prereqCheck.ok) {
    return errorResult(input, projectRoot, prereqCheck.reason);
  }

  // 4. ChapterSeed 检查。
  // 自动章节契约拆分已退役；显式章纲/ChapterSeed 属于作者拥有输入。
  // workspace_or_planner 仅为旧调用兼容值，不再授权系统写入 chN-outline-explicit.md。
  const seedCheck = checkChapterSeedAvailable(workspaceId, startChapter, projectRoot);
  if (!seedCheck.ok) {
    return errorResult(input, projectRoot, seedCheck.reason);
  }

  // 5. 生成 jobId（P0-FIX-1：校验用户自定义 jobId）
  const jobId = input.jobId || generateJobId();
  try {
    validateJobId(jobId);
  } catch (e: any) {
    return errorResult(input, projectRoot, e?.message ?? "invalid jobId");
  }

  // 5b. CONCURRENCY-WAVE5：已有 job 不得用新 commandId 覆盖重建
  const existing = loadBatchJobStore(workspaceId, jobId, projectRoot);
  if (existing) {
    return persistCommand(
      input,
      casErrorResult(
        input,
        projectRoot,
        "concurrent_state_update",
        `concurrent_state_update：jobId ${jobId} 已存在（revision=${existing.state.stateRevision ?? 0}），拒绝用新 start 覆盖`,
        jobId,
      ),
      jobId,
    );
  }

  // 6. 获取 workspace 级锁（BATCH-P0-09）
  const lockResult = acquireBatchLock(workspaceId, jobId, projectRoot);
  if (!lockResult.ok) {
    return {
      ...errorResult(input, projectRoot, lockResult.reason, jobId),
      failureEnvelope: {
        stage: "batch_lock",
        severity: "error",
        reason: lockResult.reason,
        recoverable: false,
        existingLock: lockResult.existingLock,
      },
    };
  }

  try {
    // 7. 创建初始 BatchJobState
    const now = new Date().toISOString();
    const chapters: BatchChapterResult[] = [];
    for (let i = 0; i < total; i++) {
      chapters.push({
        chapterNumber: startChapter + i,
        chapterId: String(startChapter + i),
        status: "pending" as const,
      });
    }
    const state: BatchJobState = {
      jobId,
      workspaceId,
      status: "running",
      startChapter,
      endChapter,
      seedSource: input.seedSource ?? "workspace_only",
      stopOnFailure: input.stopOnFailure ?? true,
      confirmLargeBatch: input.confirmLargeBatch ?? false,
      createdAt: now,
      updatedAt: now,
      frontier: startChapter,
      completedChapters: [],
      failedChapter: null,
      chapters,
      cancelRequested: false,
    };
    const created = saveBatchJobStore(state, workspaceId, jobId, projectRoot, {
      event: "job_created",
    });
    if (!created.ok) {
      return persistCommand(
        input,
        casErrorResult(
          input,
          projectRoot,
          created.reason,
          `${created.reason}：创建 BatchJobState 失败（expected=${created.expectedRevision}, disk=${created.diskRevision}）`,
          jobId,
        ),
        jobId,
      );
    }

    // 8. 运行批量编排（同步阻塞直到完成/暂停/取消）
    const { state: finalState } = await runBatchGeneration({
      state,
      projectRoot,
      mockGenerateChapter: input._mockGenerateChapter,
    });

    return persistCommand(input, toResult(finalState, projectRoot), jobId);
  } finally {
    // 9. 释放锁（无论成功/失败/暂停）— P0-FIX-5：只删自己的锁
    releaseBatchLock(workspaceId, jobId, projectRoot);
  }
}

// ============================================================================
// action: resume
// ============================================================================

async function handleResume(
  input: BatchGenerationInput,
  projectRoot: string,
): Promise<BatchGenerationResult> {
  const { workspaceId, jobId } = input;
  if (!jobId) {
    return errorResult(input, projectRoot, "resume 需要 jobId 参数");
  }

  // 1. 加载 state
  const store = loadBatchJobStore(workspaceId, jobId, projectRoot);
  if (!store) {
    return errorResult(input, projectRoot, `jobId ${jobId} 不存在`, jobId);
  }
  const state = store.state;

  // 2. 已完成的任务 resume → 幂等返回 completed（不重复调用模型）
  if (state.status === "completed") {
    return persistCommand(input, toResult(state, projectRoot), jobId);
  }

  // 3. 状态校验
  //    - paused：正常 resume
  //    - cancelled / error：拒绝（需重新 start）
  //    - running：P0-FIX-2 崩溃恢复 — 真实进程崩溃会留下 status=running，
  //               需结合锁持有者存活状态判断。锁死亡或不存在 → 视为孤儿任务，
  //               可 resume；锁仍存活 → 拒绝（任务可能仍在另一个进程中运行）。
  if (state.status === "cancelled" || state.status === "error") {
    return errorResult(
      input, projectRoot,
      `任务状态为 ${state.status}，cancelled/error 不可 resume，请重新 start`,
      jobId,
    );
  }
  if (state.status === "running") {
    const lockInfo = readBatchLock(workspaceId, projectRoot);
    if (lockInfo && isLockAlive(lockInfo)) {
      return errorResult(
        input, projectRoot,
        `任务 ${jobId} 仍在运行中（pid=${lockInfo.pid} 存活且锁未过期）。如确认是僵死锁，请等待锁过期或手动清理 batch-jobs/.lock`,
        jobId,
      );
    }
    // 孤儿 running 任务 → 落到下方获取锁并 resume
  } else if (state.status !== "paused") {
    return errorResult(
      input, projectRoot,
      `任务状态为 ${state.status}，只有 paused 或可确认的孤儿 running 状态才能 resume`,
      jobId,
    );
  }

  // 4. 获取锁（P0-FIX-2：孤儿 running 任务的僵死锁会被 acquireBatchLock 强制释放）
  const lockResult = acquireBatchLock(workspaceId, jobId, projectRoot);
  if (!lockResult.ok) {
    return {
      ...errorResult(input, projectRoot, lockResult.reason, jobId),
      failureEnvelope: {
        stage: "batch_lock",
        severity: "error",
        reason: lockResult.reason,
        recoverable: false,
        existingLock: lockResult.existingLock,
      },
    };
  }

  try {
    const reconciliation = reconcileBatchJobAfterCrash(state, projectRoot);
    if (!writeRecoveryTrace(workspaceId, jobId, projectRoot, reconciliation)) {
      return persistCommand(
        input,
        casErrorResult(
          input,
          projectRoot,
          "recovery_trace_failed",
          "recovery_trace_failed：崩溃恢复分类已算出，但 recovery trace 未能落盘，禁止继续 resume",
          jobId,
        ),
        jobId,
      );
    }
    if (reconciliation.decision === "blocked") {
      return persistCommand(
        input,
        errorResult(input, projectRoot, reconciliation.reason, jobId),
        jobId,
      );
    }
    if (reconciliation.decision === "completed") {
      state.status = "completed";
      state.frontier = state.endChapter + 1;
      state.completedChapters = reconciliation.recoveredChapters;
      const saved = saveBatchJobStore(state, workspaceId, jobId, projectRoot, {
        event: "crash_reconcile_completed",
      });
      if (!saved.ok) {
        return persistCommand(
          input,
          casErrorResult(
            input,
            projectRoot,
            saved.reason,
            `${saved.reason}：崩溃恢复标记 completed 失败`,
            jobId,
          ),
          jobId,
        );
      }
      return persistCommand(input, toResult(state, projectRoot), jobId);
    }

    // 5. 设置 running，保存（P1-FIX-6：orchestrator 会清理 failedChapter/summary）
    state.status = "running";
    state.updatedAt = new Date().toISOString();
    const saved = saveBatchJobStore(state, workspaceId, jobId, projectRoot, {
      event: "resume_running",
    });
    if (!saved.ok) {
      return persistCommand(
        input,
        casErrorResult(
          input,
          projectRoot,
          saved.reason,
          `${saved.reason}：resume 写入 running 失败（expected=${saved.expectedRevision}, disk=${saved.diskRevision}）`,
          jobId,
        ),
        jobId,
      );
    }

    // 6. 运行批量编排
    const { state: finalState } = await runBatchGeneration({
      state,
      projectRoot,
      mockGenerateChapter: input._mockGenerateChapter,
    });

    return persistCommand(input, toResult(finalState, projectRoot), jobId);
  } finally {
    releaseBatchLock(workspaceId, jobId, projectRoot);
  }
}

// ============================================================================
// action: status
// ============================================================================

function handleStatus(
  input: BatchGenerationInput,
  projectRoot: string,
): BatchGenerationResult {
  const { workspaceId, jobId } = input;
  if (!jobId) {
    return errorResult(input, projectRoot, "status 需要 jobId 参数");
  }

  const store = loadBatchJobStore(workspaceId, jobId, projectRoot);
  if (!store) {
    return errorResult(input, projectRoot, `jobId ${jobId} 不存在`, jobId);
  }
  return toResult(store.state, projectRoot);
}

// ============================================================================
// action: cancel
// ============================================================================

function handleCancel(
  input: BatchGenerationInput,
  projectRoot: string,
): BatchGenerationResult {
  const { workspaceId, jobId } = input;
  if (!jobId) {
    return errorResult(input, projectRoot, "cancel 需要 jobId 参数");
  }

  const store = loadBatchJobStore(workspaceId, jobId, projectRoot);
  if (!store) {
    return errorResult(input, projectRoot, `jobId ${jobId} 不存在`, jobId);
  }
  const state = store.state;

  if (state.status === "cancelled") {
    return persistCommand(
      input,
      casErrorResult(
        input,
        projectRoot,
        "already_consumed",
        `already_consumed：任务 ${jobId} 已被取消，不同 commandId 不得重复消费`,
        jobId,
      ),
      jobId,
    );
  }

  const updated = updateBatchJobControlFields(
    workspaceId,
    jobId,
    projectRoot,
    (next) => {
      next.cancelRequested = true;
      if (next.status === "paused") {
        next.status = "cancelled";
      }
    },
  );
  if (!updated.ok) {
    const concurrencyError: BatchConcurrencyError =
      updated.reason.includes("concurrent_state_update")
        ? "concurrent_state_update"
        : "state_file_corrupt";
    return persistCommand(
      input,
      casErrorResult(input, projectRoot, concurrencyError, updated.reason, jobId),
      jobId,
    );
  }

  // 不删除任何文件（cancel 不破坏已完成章节）
  return persistCommand(input, toResult(updated.state, projectRoot), jobId);
}

// ============================================================================
// 辅助函数
// ============================================================================

function replayCommandIfSeen(
  input: BatchGenerationInput,
  projectRoot: string,
): BatchGenerationResult | null {
  if (!input.commandId) return null;
  try {
    const seen = lookupBatchCommandReceipt(input.workspaceId, input.commandId, projectRoot);
    if (!seen) return null;
    return {
      ...seen.result,
      checkpointPath: seen.result.checkpointPath,
      idempotent: true,
    };
  } catch {
    return null;
  }
}

function persistCommand(
  input: BatchGenerationInput,
  result: BatchGenerationResult,
  jobId: string,
): BatchGenerationResult {
  if (!input.commandId) return result;
  const snapshot: BatchCommandResultSnapshot = {
    status: result.status,
    jobId: result.jobId || jobId,
    currentChapter: result.currentChapter,
    completedChapters: result.completedChapters,
    totalChapters: result.totalChapters,
    failedChapter: result.failedChapter,
    checkpointPath: result.checkpointPath,
    concurrencyError: result.concurrencyError,
    failureEnvelope: result.failureEnvelope,
    summary: result.summary,
  };
  const recorded = recordBatchCommandReceipt(
    input.workspaceId,
    {
      commandId: input.commandId,
      action: input.action,
      jobId: result.jobId || jobId,
      recordedAt: new Date().toISOString(),
      result: snapshot,
    },
    input._projectRoot || getProjectRoot(),
  );
  if (!recorded.ok) {
    return casErrorResult(
      input,
      input._projectRoot || getProjectRoot(),
      "idempotency_receipt_failed",
      `idempotency_receipt_failed：业务副作用可能已发生，但 commandId 收据未能落盘（${recorded.reason}）。禁止当作成功重试。`,
      result.jobId || jobId,
    );
  }
  return result;
}

function casErrorResult(
  input: BatchGenerationInput,
  projectRoot: string,
  concurrencyError: BatchConcurrencyError,
  reason: string,
  jobId?: string,
): BatchGenerationResult {
  return {
    ...errorResult(input, projectRoot, reason, jobId),
    concurrencyError,
  };
}

function writeRecoveryTrace(
  workspaceId: string,
  jobId: string,
  projectRoot: string,
  reconciliation: ReturnType<typeof reconcileBatchJobAfterCrash>,
): boolean {
  try {
    const path = join(
      projectRoot,
      "workspaces",
      workspaceId,
      "batch-jobs",
      `${jobId}.recovery.json`,
    );
    atomicSave(path, JSON.stringify({
      jobId,
      workspaceId,
      recordedAt: new Date().toISOString(),
      ...reconciliation,
    }, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * 将 BatchJobState 映射为 BatchGenerationResult。
 */
function toResult(state: BatchJobState, projectRoot: string): BatchGenerationResult {
  const failedChapterResult = state.failedChapter !== null
    ? state.chapters.find((c) => c?.chapterNumber === state.failedChapter)
    : undefined;
  return {
    status: state.status,
    jobId: state.jobId,
    currentChapter: state.frontier <= state.endChapter ? state.frontier : null,
    completedChapters: state.completedChapters.length,
    totalChapters: state.endChapter - state.startChapter + 1,
    failedChapter: state.failedChapter,
    checkpointPath: batchJobPath(state.workspaceId, state.jobId, projectRoot),
    failureEnvelope: failedChapterResult?.failureEnvelope,
    summary: state.summary,
  };
}

/**
 * 构造校验失败的 BatchGenerationResult。
 */
function errorResult(
  input: BatchGenerationInput,
  projectRoot: string,
  reason: string,
  jobId?: string,
): BatchGenerationResult {
  const total = input.endChapter && input.startChapter
    ? input.endChapter - input.startChapter + 1
    : 0;
  return {
    status: "error",
    jobId: jobId ?? input.jobId ?? "",
    currentChapter: null,
    completedChapters: 0,
    totalChapters: total,
    failedChapter: null,
    // P0-FIX-1：errorResult 常用于校验失败场景（jobId 可能非法），
    // batchJobPath 内部会再次 validateJobId → 对非法 jobId 会抛出。
    // 此处必须吞掉该异常，否则会逃逸 handler 的 catch 块，导致
    // wrapLegacyTool 返回无 status 字段的 { details: { error } }。
    checkpointPath: safeCheckpointPath(input.workspaceId, jobId, projectRoot),
    failureEnvelope: {
      stage: "batch_handler",
      severity: "error",
      reason,
      recoverable: false,
    },
  };
}

/**
 * 安全计算 checkpointPath：jobId 非法（路径穿越等）时返回空字符串而非抛出。
 * errorResult / toResult 在 jobId 已通过校验的正常路径下仍返回完整路径；
 * 仅在 errorResult 处理校验失败场景时可能传入非法 jobId。
 */
function safeCheckpointPath(
  workspaceId: string,
  jobId: string | undefined,
  projectRoot: string,
): string {
  if (!jobId) return "";
  try {
    return batchJobPath(workspaceId, jobId, projectRoot);
  } catch {
    return "";
  }
}

/**
 * ChapterSeed 阻断检查（BATCH-P1-04，P0-FIX-3 修正）。
 *
 * ChapterSeedBuilder 真实消费的种子来源是 series/ch{startChapter}-outline-explicit.md
 * （由 loadAuthorChapterContract 加载并 parseExplicitOutline 解析）。
 * config.json 的 chapterSeeds 字段不被 ChapterSeedBuilder 消费，已移除该检查路径。
 *
 * 检查 series/ch{startChapter}-outline-explicit.md 是否存在。
 * 不存在 → 阻断（不调用模型），提示补充作者拥有的种子来源。
 */
function checkChapterSeedAvailable(
  workspaceId: string,
  startChapter: number,
  projectRoot: string,
): { ok: true } | { ok: false; reason: string } {
  const workspacePath = join(projectRoot, "workspaces", workspaceId);

  // P0-FIX-3：ChapterSeedBuilder 真实读取 series/ch{N}-outline-explicit.md
  const explicitOutlinePath = join(
    workspacePath, "series", `ch${startChapter}-outline-explicit.md`,
  );
  if (existsSync(explicitOutlinePath)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `workspace ${workspaceId} 缺少 ChapterSeed 来源：无 series/ch${startChapter}-outline-explicit.md。自动章节契约拆分已退役；请由作者补充可执行种子源后重试。`,
  };
}

// ============================================================================
// P1-04：扩展 preflight 检查
// ============================================================================

/**
 * 扩展 preflight 检查（BATCH-P1-04）。
 *
 * 在批量生成前检查 workspace 必备前置条件：
 *   1. config.json 存在且含 genre（世界观）
 *   2. characters/ 目录存在且非空（角色档案）
 *   3. startChapter > 1 时，narrative-state-store.json 必须存在（前章状态）
 *
 * 任一不满足 → 阻断（不调用模型）。
 *
 * 注意：此检查在 ChapterSeed 检查之前执行。世界观、角色档案、前章状态和
 * 作者拥有的 ChapterSeed 来源都必须由 workspace 提供；批量入口不再自动规划种子。
 */
function checkBatchPrerequisites(
  workspaceId: string,
  startChapter: number,
  projectRoot: string,
): { ok: true } | { ok: false; reason: string } {
  const workspacePath = join(projectRoot, "workspaces", workspaceId);

  // 1. config.json 含 genre（世界观）
  const configPath = join(workspacePath, "config.json");
  if (!existsSync(configPath)) {
    return {
      ok: false,
      reason: `workspace ${workspaceId} 缺少 config.json，无法确认世界观（genre）。请补全 workspace 配置。`,
    };
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    if (
      !config?.genre ||
      typeof config.genre !== "string" ||
      config.genre.trim().length === 0
    ) {
      return {
        ok: false,
        reason: `workspace ${workspaceId} config.json 缺少 genre（世界观）字段。世界观缺失 = 生产阻断，必须补全后再生成。`,
      };
    }
  } catch {
    return {
      ok: false,
      reason: `workspace ${workspaceId} config.json 解析失败，无法确认世界观（genre）。`,
    };
  }

  // 2. characters/ 目录存在且非空（角色档案）
  const charactersDir = join(workspacePath, "characters");
  if (!existsSync(charactersDir)) {
    return {
      ok: false,
      reason: `workspace ${workspaceId} 缺少 characters/ 角色档案目录。角色档案是生成前必需前置条件。`,
    };
  }
  let characterFiles: string[] = [];
  try {
    characterFiles = readdirSync(charactersDir).filter(
      (f) => f.endsWith(".md") || f.endsWith(".json"),
    );
  } catch {
    // 读取失败视为空
  }
  if (characterFiles.length === 0) {
    return {
      ok: false,
      reason: `workspace ${workspaceId} characters/ 目录为空，缺少角色档案。角色档案是生成前必需前置条件。`,
    };
  }

  // 3. startChapter > 1 时，narrative-state-store.json 必须存在（前章状态）
  if (startChapter > 1) {
    const stateStorePath = join(workspacePath, "narrative-state-store.json");
    if (!existsSync(stateStorePath)) {
      return {
        ok: false,
        reason: `workspace ${workspaceId} startChapter=${startChapter} > 1 但缺少 narrative-state-store.json（前章状态）。请先生成前序章节或补全前章状态。`,
      };
    }
  }

  return { ok: true };
}
