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
 * BATCH-P0-01 / BATCH-P1-01
 */

import { getProjectRoot } from "../utils/config.js";
import type { BatchJobState } from "../v2/core/batch-generation-job-store.js";
// 显式 import 以确保 orchestrator / lock 模块进入生产闭包（dist/）。
// 即使 RED 阶段 handler 体 throw not implemented，这些 value import 也会拉入依赖。
import { runBatchGeneration, type BatchOrchestratorInput } from "../v2/core/batch-generation-orchestrator.js";
import { acquireBatchLock, releaseBatchLock, type BatchLockInfo } from "../v2/core/batch-generation-lock.js";

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
}

// ============================================================================
// Handler（stub — RED 阶段 throw not implemented）
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
  throw new Error("not implemented: handleBatchGeneration (RED stub)");
}
