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
 *   3. P1-E：verifyStateCommitted 严格校验状态提交
 *      - stateCommit.error / stateCommit.blocked → 失败
 *      - stateCommit.skipped → 可接受（无 stagedStateUpdate）
 *      - 否则读磁盘 narrative-state-store.json 验证：
 *        a) lastCommittedChapter === "ch{N}"
 *        b) 存在至少一条 sourceRef 含 "ch{N}#finalText:" 的 entry（finalText 锚点）
 */

import { existsSync, readFileSync } from "fs";
import { join } from "node:path";
import { atomicSave } from "./orchestrator-commit-save.js";
import type { BatchJobState, BatchJobSummary, BatchChapterResult } from "./batch-generation-job-store.js";
import {
  loadBatchJobStore,
  saveBatchJobStore,
  isChapterAlreadyCompleted,
} from "./batch-generation-job-store.js";
import { renewBatchLock, LOCK_TIMEOUT_MS } from "./batch-generation-lock.js";

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
 * 锁心跳间隔：LOCK_TIMEOUT_MS / 3 = 10 分钟。
 *
 * P0-B：单章 Agentic + 风格优化可能超过 30 分钟，锁会在章节执行中到期，
 * 第二任务可抢占同一 workspace。心跳在章节执行期间定时续租，确保锁不过期。
 */
const LOCK_HEARTBEAT_INTERVAL_MS = Math.floor(LOCK_TIMEOUT_MS / 3);

/**
 * 启动锁心跳：在章节执行期间定时续租锁。
 *
 * 返回 stop 函数——章节调用结束后必须调用以清除定时器。
 * 心跳续租失败不阻断主链路（锁过期由 acquireBatchLock 僵死锁恢复处理）。
 */
function startLockHeartbeat(
  workspaceId: string,
  jobId: string,
  projectRoot: string,
): () => void {
  const timer = setInterval(() => {
    try {
      renewBatchLock(workspaceId, jobId, projectRoot);
    } catch {
      // 心跳续租失败不阻断主链路
    }
  }, LOCK_HEARTBEAT_INTERVAL_MS);
  // unref 让定时器不阻止进程退出
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

/**
 * P1-E：严格验证本章状态已提交到 narrative-state-store.json。
 *
 * 旧检查 `(stateCommit as any)?.ok !== false` 永真（`ok` 字段在真实
 * `commitAndSave` 输出中不存在——只有 mock 设了它），导致状态提交失败
 * 或未执行时仍被判定为成功。
 *
 * 新检查逻辑：
 * 1. stateCommit.error 或 stateCommit.blocked → 失败
 * 2. stateCommit.skipped → 可接受（无 stagedStateUpdate，不验证磁盘）
 * 3. 否则读磁盘 narrative-state-store.json 验证：
 *    a) lastCommittedChapter === "ch{N}"
 *    b) 存在至少一条 sourceRef 含 "ch{N}#finalText:" 的 entry（finalText 锚点）
 *    c) committed=0（全部 rejected）时无 finalText 锚点 → 失败
 */
function verifyStateCommitted(
  stateCommit: any,
  workspaceId: string,
  chapterNumber: number,
  projectRoot: string,
): boolean {
  if (!stateCommit) return false;
  // 错误/阻断 → 失败
  if (stateCommit.error || stateCommit.blocked) return false;
  // skipped（无 stagedStateUpdate）→ 可接受
  if (stateCommit.skipped) return true;
  // committed/rejected 结构 → 验证磁盘
  const expectedChapter = `ch${chapterNumber}`;
  const stateStorePath = join(
    projectRoot, "workspaces", workspaceId, "narrative-state-store.json",
  );
  if (!existsSync(stateStorePath)) return false;
  try {
    const raw = readFileSync(stateStorePath, "utf-8");
    const store = JSON.parse(raw);
    // 1. lastCommittedChapter 必须等于 ch{N}
    if (store.lastCommittedChapter !== expectedChapter) return false;
    // 2. 存在至少一条本章 finalText 锚点的 entry（检查所有数组，含 eventLog）
    const anchor = `${expectedChapter}#finalText:`;
    const allEntries: any[] = [
      ...(store.canon ?? []),
      ...(store.character ?? []),
      ...(store.promise ?? []),
      ...(store.pattern ?? []),
      ...(store.expectation ?? []),
      ...(store.eventLog ?? []),
    ];
    return allEntries.some(
      (e) => typeof e?.sourceRef === "string" && e.sourceRef.includes(anchor),
    );
  } catch {
    return false;
  }
}

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

  // P1-FIX-6: 清理上次 paused 阶段的瞬态失败状态（resume 场景下重算 summary）
  state.failedChapter = null;
  state.summary = undefined;

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
    // P0-B：章节执行期间启动锁心跳，防止单章超过 30 分钟锁过期被抢占
    const chapterInput = {
      workspaceId,
      chapterId: String(state.frontier),
      chapterNumber: state.frontier,
      _projectRoot: projectRoot,
    };
    const stopHeartbeat = startLockHeartbeat(workspaceId, jobId, projectRoot);
    let result: any;
    let chapterSucceeded = false;
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
    } finally {
      stopHeartbeat();
    }

    // 5. P0-FIX-4 + P1-C：先从磁盘合并最新 cancelRequested
    //    章节执行期间 cancel action 可能被外部设置到磁盘。
    //    必须在记录章节结果之前合并，防止后续 save 用旧内存 cancelRequested=false
    //    覆盖磁盘上的 cancelRequested=true。
    const freshAfterChapter = loadBatchJobStore(workspaceId, jobId, projectRoot);
    if (freshAfterChapter?.state.cancelRequested) {
      state.cancelRequested = true;
    }

    // 6. 成功判定：status=ok + 章节文件存在 + P1-E 严格状态提交校验
    const chapterFile = join(
      projectRoot, "workspaces", workspaceId, "chapters", `${state.frontier}.md`,
    );
    const chapterFileExists = existsSync(chapterFile);
    const stateCommitOk = verifyStateCommitted(
      result?.stageResults?.stateCommit as any,
      workspaceId,
      state.frontier,
      projectRoot,
    );
    chapterSucceeded = result?.status === "ok" && chapterFileExists && stateCommitOk;

    // 7. 记录本章提交结果（P1-C：cancelRequested 已合并，save 不会覆盖 cancel 标志）
    //    先记录完成/失败，再检查 cancel——防止 cancel 漏记已提交章节
    if (chapterSucceeded) {
      // 7a. 成功：推进 frontier
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
      // P0-FIX-5: 长任务续租锁 — 每章完成后延长 expiresAt，避免 100 章任务超过 30 分钟被误判过期
      renewBatchLock(workspaceId, jobId, projectRoot);
    } else {
      // 7b. 失败：记录失败结果（但不立即设置 status 或 break——先检查 cancel）
      chapterResult.status = "failed";
      chapterResult.completedAt = new Date().toISOString();
      chapterResult.failureEnvelope = result?.failureEnvelope ?? {
        stage: "batch_chapter",
        severity: "error",
        reason: `chapter ${state.frontier} did not reach status=ok (status=${result?.status}, fileExists=${chapterFileExists}, stateCommitOk=${stateCommitOk})`,
        recoverable: false,
      };
      state.failedChapter = state.frontier;
      state.updatedAt = new Date().toISOString();
      saveBatchJobStore(state, workspaceId, jobId, projectRoot);
    }

    // 8. P0-FIX-4 + P1-C：章节结果已记录后，检查 cancel
    //    cancelRequested 已在步骤 5 合并到内存；cancel 优先于 paused/error
    if (state.cancelRequested) {
      state.status = "cancelled";
      state.updatedAt = new Date().toISOString();
      saveBatchJobStore(state, workspaceId, jobId, projectRoot);
      break;
    }

    // 9. 章节失败且未 cancel → 按 stopOnFailure 处理
    if (!chapterSucceeded) {
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
  // BATCH-P1-02 + P1-FIX-6：任务结束（completed / paused / cancelled / error）时重算 summary
  // 始终重算，防止 resume 后旧的 failed/summary 数据陈旧
  state.summary = buildSummary(state);
  state.updatedAt = new Date().toISOString();
  saveBatchJobStore(state, workspaceId, jobId, projectRoot);

  // BATCH-P1-02：写入批量 summary trace 文件
  writeBatchSummaryTrace(state, projectRoot);

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

/**
 * 写入批量 summary trace 文件（BATCH-P1-02）。
 *
 * 路径：workspaces/{id}/traces/batch-{jobId}-summary.json
 *
 * 内容：
 * - jobId / workspaceId / status / startChapter / endChapter
 * - summary（汇总统计）
 * - chapters（每章耗时、模型调用、状态提交结果、失败 envelope、trace 路径）
 * - createdAt / updatedAt
 *
 * 在 runBatchGeneration 结束时调用，无论任务状态如何都写入 trace。
 */
export function writeBatchSummaryTrace(state: BatchJobState, projectRoot: string): void {
  const tracePath = join(
    projectRoot,
    "workspaces",
    state.workspaceId,
    "traces",
    `batch-${state.jobId}-summary.json`,
  );
  const trace = {
    jobId: state.jobId,
    workspaceId: state.workspaceId,
    status: state.status,
    startChapter: state.startChapter,
    endChapter: state.endChapter,
    summary: state.summary,
    chapters: state.chapters.map((ch) => ({
      chapterNumber: ch.chapterNumber,
      status: ch.status,
      startedAt: ch.startedAt,
      completedAt: ch.completedAt,
      durationMs: ch.durationMs,
      modelCalls: ch.modelCalls,
      stateCommitResult: ch.stateCommitResult,
      failureEnvelope: ch.failureEnvelope,
      chapterFilePath: ch.chapterFilePath,
      tracePath: ch.tracePath,
    })),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
  try {
    atomicSave(tracePath, JSON.stringify(trace, null, 2));
  } catch {
    // trace 写入失败不阻断主链路（advisory）
  }
}
