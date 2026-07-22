/**
 * BatchGenerationOrchestrator — 批量章节生成串行编排
 *
 * 串行编排：逐章调用 handleGenerateChapter（统一主链路），推进 frontier，
 * 失败暂停，幂等 resume。
 *
 * 铁律：
 * - 只允许单 workspace 串行执行（BATCH-P0-03）
 * - 每章调用现有 handleGenerateChapter / runUnifiedPipeline，禁止直接调用模型（BATCH-P0-04）
 * - 每章成功后才推进下一章，确认章节文件和长期状态都已提交（BATCH-P0-05）
 * - 失败暂停；第 42 章失败时不得自动生成第 43 章（BATCH-P0-07）
 * - 幂等保护：重复 resume 不得重复提交已完成章节（BATCH-P0-08）
 * - 机器文学裁判 / pairwise judge / 旧 raw/editorial 双链路不得进入批量生产流程
 *
 * 章节成功判定（三者都满足才推进 frontier）：
 *   1. result.status === "ok"
 *   2. chapters/{N}.md 文件存在
 *   3. result.stageResults.stateCommit 无错误
 *      （回退：narrative-state-store.json 含 sourceChapter=ch{N} 的 finalText-anchored entry）
 */

import { existsSync } from "fs";
import { join } from "node:path";
import type { BatchJobState, BatchJobSummary, BatchChapterResult } from "./batch-generation-job-store.js";
import {
  loadBatchJobStore,
  saveBatchJobStore,
  isChapterAlreadyCompleted,
} from "./batch-generation-job-store.js";

// ============================================================================
// 类型
// ============================================================================

/**
 * 批量编排输入。
 * mockGenerateChapter 用于测试注入（生产路径走 handleGenerateChapter）。
 */
export interface BatchOrchestratorInput {
  /** 已加载的 BatchJobState（caller 负责 load） */
  state: BatchJobState;
  /** 项目根目录 */
  projectRoot: string;
  /** 测试用 mock：注入替代 handleGenerateChapter 的函数 */
  mockGenerateChapter?: (input: {
    workspaceId: string;
    chapterId: string;
    chapterNumber: number;
    _projectRoot?: string;
  }) => Promise<any>;
}

/**
 * 批量编排输出。
 */
export interface BatchOrchestratorOutput {
  /** 最终任务状态 */
  state: BatchJobState;
}

// ============================================================================
// 核心编排函数
// ============================================================================

/**
 * 运行批量章节生成。
 *
 * 同步阻塞直到：
 *   - 全部章节完成（status="completed"）
 *   - 某章失败且 stopOnFailure=true（status="paused"）
 *   - 某章失败且 stopOnFailure=false（status="error"）
 *   - 检测到 cancelRequested（status="cancelled"）
 *
 * 每章开始前：
 *   1. 重新加载 state 检查 cancelRequested
 *   2. 幂等性检查：已完成章节跳过
 *   3. 标记章节 running，原子保存
 *   4. 调用 handleGenerateChapter 或 mock
 *   5. 判定成功：status=ok + 文件存在 + stateCommit 无错误
 *   6. 成功 → 推进 frontier；失败 → 暂停并 break
 */
export async function runBatchGeneration(
  input: BatchOrchestratorInput,
): Promise<BatchOrchestratorOutput> {
  const { state, projectRoot, mockGenerateChapter } = input;
  const workspaceId = state.workspaceId;
  const jobId = state.jobId;

  while (state.frontier <= state.endChapter) {
    // 1. 重新加载 state 检查 cancelRequested（cancel action 可能在外部设置）
    const fresh = loadBatchJobStore(workspaceId, jobId, projectRoot);
    if (fresh?.state.cancelRequested) {
      state.status = "cancelled";
      state.cancelRequested = true;
      state.updatedAt = new Date().toISOString();
      saveBatchJobStore(state, workspaceId, jobId, projectRoot);
      break;
    }

    // 2. 幂等性检查：已完成章节跳过（防重复 resume）
    if (isChapterAlreadyCompleted(workspaceId, state.frontier, projectRoot)) {
      if (!state.completedChapters.includes(state.frontier)) {
        state.completedChapters.push(state.frontier);
      }
      state.frontier++;
      state.updatedAt = new Date().toISOString();
      saveBatchJobStore(state, workspaceId, jobId, projectRoot);
      continue;
    }

    // 3. 标记当前章节 running
    const slotIndex = state.frontier - state.startChapter;
    const chapterResult: BatchChapterResult = {
      chapterNumber: state.frontier,
      chapterId: String(state.frontier),
      status: "running",
      startedAt: new Date().toISOString(),
    };
    state.chapters[slotIndex] = chapterResult;
    state.updatedAt = new Date().toISOString();
    saveBatchJobStore(state, workspaceId, jobId, projectRoot);

    // 4. 调用统一主链路（mock 或 handleGenerateChapter）
    const chapterInput = {
      workspaceId,
      chapterId: String(state.frontier),
      chapterNumber: state.frontier,
      _projectRoot: projectRoot,
    };
    let result: any;
    try {
      if (mockGenerateChapter) {
        result = await mockGenerateChapter(chapterInput);
      } else {
        // 动态 import 避免循环依赖：
        // public-handlers → batch-generation-handler → batch-generation-orchestrator → public-handlers
        const { handleGenerateChapter } = await import("../../handlers/public-handlers.js");
        result = await handleGenerateChapter(chapterInput);
      }
    } catch (e: any) {
      result = {
        status: "error",
        failureEnvelope: {
          stage: "batch_invoke",
          severity: "error",
          reason: e?.message ?? String(e),
          recoverable: false,
        },
      };
    }

    // 5. 成功判定：status=ok + 章节文件存在 + stateCommit 无错误
    const chapterFile = join(
      projectRoot, "workspaces", workspaceId, "chapters", `${state.frontier}.md`,
    );
    const stateCommitOk =
      (result?.stageResults?.stateCommit as any)?.ok !== false &&
      result?.stageResults?.stateCommitError !== true;
    const chapterFileExists = existsSync(chapterFile);

    if (result?.status === "ok" && chapterFileExists && stateCommitOk) {
      // 6a. 成功：推进 frontier
      chapterResult.status = "completed";
      chapterResult.completedAt = new Date().toISOString();
      chapterResult.durationMs = Date.now() - new Date(chapterResult.startedAt!).getTime();
      chapterResult.modelCalls = (result?.stageResults?.modelCallCount as number) ?? undefined;
      chapterResult.stateCommitResult = { ok: true };
      chapterResult.chapterFilePath = chapterFile;
      chapterResult.tracePath = join(
        projectRoot, "workspaces", workspaceId, "traces", `${state.frontier}-quality-trace.json`,
      );
      if (!state.completedChapters.includes(state.frontier)) {
        state.completedChapters.push(state.frontier);
      }
      state.frontier++;
      state.updatedAt = new Date().toISOString();
      saveBatchJobStore(state, workspaceId, jobId, projectRoot);
    } else {
      // 6b. 失败：暂停（stopOnFailure 默认 true）—— 不继续下一章
      chapterResult.status = "failed";
      chapterResult.completedAt = new Date().toISOString();
      chapterResult.failureEnvelope = result?.failureEnvelope ?? {
        stage: "batch_chapter",
        severity: "error",
        reason: `chapter ${state.frontier} did not reach status=ok (status=${result?.status}, fileExists=${chapterFileExists}, stateCommitOk=${stateCommitOk})`,
        recoverable: false,
      };
      state.failedChapter = state.frontier;
      state.status = state.stopOnFailure ? "paused" : "error";
      state.updatedAt = new Date().toISOString();
      saveBatchJobStore(state, workspaceId, jobId, projectRoot);
      break;
    }
  }

  // 7. 循环结束：检查是否全部完成
  if (state.frontier > state.endChapter && state.status === "running") {
    state.status = "completed";
  }
  if (state.status === "completed" && !state.summary) {
    state.summary = buildSummary(state);
  }
  state.updatedAt = new Date().toISOString();
  saveBatchJobStore(state, workspaceId, jobId, projectRoot);

  return { state };
}

/**
 * 构建 BatchJobSummary。
 * 汇总总章节数、完成数、失败数、总耗时、总模型调用、失败 envelope 列表。
 */
export function buildSummary(state: BatchJobState): BatchJobSummary {
  const totalChapters = state.endChapter - state.startChapter + 1;
  let completedChapters = 0;
  let failedChapters = 0;
  let totalDurationMs = 0;
  let totalModelCalls = 0;
  const failureEnvelopes: unknown[] = [];

  for (const ch of state.chapters) {
    if (!ch) continue;
    if (ch.status === "completed") {
      completedChapters++;
      if (typeof ch.durationMs === "number") totalDurationMs += ch.durationMs;
      if (typeof ch.modelCalls === "number") totalModelCalls += ch.modelCalls;
    } else if (ch.status === "failed") {
      failedChapters++;
      if (ch.failureEnvelope) failureEnvelopes.push(ch.failureEnvelope);
    }
  }

  return {
    totalChapters,
    completedChapters,
    failedChapters,
    totalDurationMs,
    totalModelCalls,
    failureEnvelopes,
  };
}
