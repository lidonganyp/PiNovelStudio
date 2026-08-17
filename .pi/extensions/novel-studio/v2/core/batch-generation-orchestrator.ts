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
import { renewBatchLock, readBatchLock, LOCK_TIMEOUT_MS } from "./batch-generation-lock.js";
import {
  createBudgetLedger,
  admitBatchChapter,
  expireReservations,
} from "./budget-ledger.js";
import type { BudgetLedger } from "./budget-types.js";
import {
  loadBudgetLedgerStore,
  saveBudgetLedgerStore,
} from "./budget-ledger-store.js";

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
  /**
   * CONCURRENCY-WAVE1/2：当前持有的批量锁身份（handler acquire 后传入）。
   * 编排器据此做锁归属校验与心跳续租；锁丢失/被接管时 fail-closed 停止，
   * 不无限假装持锁继续推进 frontier。
   */
  lock?: { lockId: string; ownerRunId: string };
  /** 测试用 mock：注入替代 handleGenerateChapter 的函数 */
  mockGenerateChapter?: (input: {
    workspaceId: string;
    chapterId: string;
    chapterNumber: number;
    _projectRoot?: string;
    _priorBudgetLedger?: BudgetLedger;
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
 * CONCURRENCY-WAVE1：续租返回结构化结果；失败（锁丢失/被接管/损坏）记录到
 * heartbeatFailure，编排循环在每章边界检查——锁丢失即 fail-closed 停止，
 * 不无限假装持锁。
 *
 * 返回 { stop, getFailure }——章节调用结束后必须调用 stop 清除定时器。
 */
function startLockHeartbeat(
  workspaceId: string,
  jobId: string,
  projectRoot: string,
  lockId?: string,
): { stop: () => void; getFailure: () => { code: string; reason: string; at: string } | null } {
  let heartbeatFailure: { code: string; reason: string; at: string } | null = null;
  const timer = setInterval(() => {
    try {
      const res = renewBatchLock(workspaceId, jobId, projectRoot, lockId);
      if (!res.ok && heartbeatFailure === null) {
        heartbeatFailure = {
          code: res.code,
          reason: res.reason,
          at: new Date().toISOString(),
        };
      }
    } catch (e: any) {
      if (heartbeatFailure === null) {
        heartbeatFailure = {
          code: "heartbeat_infra_error",
          reason: e?.message ?? String(e),
          at: new Date().toISOString(),
        };
      }
    }
  }, LOCK_HEARTBEAT_INTERVAL_MS);
  // unref 让定时器不阻止进程退出
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop: () => clearInterval(timer),
    getFailure: () => heartbeatFailure,
  };
}

// ============================================================================
// CONCURRENCY-WAVE2：CAS 保存与冲突处理
// ============================================================================

/**
 * 把磁盘上的事实性字段合并进本地 state（CAS 冲突恢复用）。
 * - cancelRequested：或合并（外部 cancel 不得被覆盖丢弃）
 * - completedChapters：并集（磁盘已确认完成的事实不回退）
 * - frontier：取 max（不回退已推进边界）
 * - chapters：磁盘上非 pending 的槽位结果优先于本地 pending
 * - stateRevision/lastEventId/ownerRunId：以磁盘为准（下一轮 CAS 基线）
 */
function mergeDiskStateIntoLocal(local: BatchJobState, disk: BatchJobState): void {
  local.cancelRequested = local.cancelRequested || disk.cancelRequested;
  for (const ch of disk.completedChapters) {
    if (!local.completedChapters.includes(ch)) local.completedChapters.push(ch);
  }
  local.frontier = Math.max(local.frontier, disk.frontier);
  for (let i = 0; i < disk.chapters.length && i < local.chapters.length; i++) {
    const d = disk.chapters[i];
    const l = local.chapters[i];
    if (d && d.status !== "pending" && (!l || l.status === "pending")) {
      local.chapters[i] = d;
    }
  }
  local.stateRevision = disk.stateRevision;
  local.lastEventId = disk.lastEventId;
}

/**
 * CAS 保存 + 冲突显式化：
 * - 保存成功 → "ok"
 * - concurrent_state_update → 重读磁盘合并事实后用磁盘 revision 重试一次；
 *   二次仍冲突 → 状态置 error + concurrent_state_update envelope → "blocked"
 *   （不盲目覆盖重试，磁盘状态保留）
 * - state_file_corrupt → 直接 "blocked"（fail-closed）
 *
 * blocked 时调用方必须停止推进（break），不得继续生成/提交。
 */
function saveStateCas(
  state: BatchJobState,
  workspaceId: string,
  jobId: string,
  projectRoot: string,
  event: string,
): "ok" | "blocked" {
  const res = saveBatchJobStore(state, workspaceId, jobId, projectRoot, { event });
  if (res.ok) return "ok";
  if (res.reason === "state_file_corrupt") {
    state.status = "error";
    state.interruptReason = "state_file_corrupt";
    (state as BatchJobState & { failureEnvelope?: unknown }).failureEnvelope = {
      stage: "batch_state_save",
      gate: "state_store",
      severity: "fatal",
      reason: `BatchJobState 文件损坏（${jobId}）。fail-closed：请人工检查 batch-jobs/${jobId}.json。`,
      recoverable: false,
    };
    return "blocked";
  }
  // concurrent_state_update → 重读磁盘事实，合并后以磁盘 revision 重试一次
  const diskStore = loadBatchJobStore(workspaceId, jobId, projectRoot);
  if (diskStore) {
    mergeDiskStateIntoLocal(state, diskStore.state);
    const retry = saveBatchJobStore(state, workspaceId, jobId, projectRoot, { event: `${event}-merged` });
    if (retry.ok) return "ok";
    state.status = "error";
    state.interruptReason = "concurrent_state_update";
    (state as BatchJobState & { failureEnvelope?: unknown }).failureEnvelope = {
      stage: "batch_state_save",
      gate: "state_store",
      severity: "fatal",
      reason: `concurrent_state_update：合并磁盘事实（revision=${retry.ok ? "" : retry.diskRevision}）后二次保存仍冲突。两个进程正在更新同一 BatchJobState；已停止，磁盘状态保留。`,
      recoverable: false,
      expectedRevision: retry.ok ? undefined : retry.expectedRevision,
      diskRevision: retry.ok ? undefined : retry.diskRevision,
    };
    return "blocked";
  }
  state.status = "error";
  state.interruptReason = "state_file_corrupt";
  (state as BatchJobState & { failureEnvelope?: unknown }).failureEnvelope = {
    stage: "batch_state_save",
    gate: "state_store",
    severity: "fatal",
    reason: `concurrent_state_update 后无法重读 ${jobId} 状态文件（可能损坏）。fail-closed 停止。`,
    recoverable: false,
  };
  return "blocked";
}

/**
 * CONCURRENCY-WAVE1：锁归属校验。
 * 返回 null=锁仍归当前 run 持有；否则返回结构化失败（锁丢失/被接管）。
 */
function verifyLockOwnership(
  workspaceId: string,
  projectRoot: string,
  lock: { lockId: string; ownerRunId: string } | undefined,
  heartbeatFailure: { code: string; reason: string; at: string } | null,
): { code: string; reason: string } | null {
  if (heartbeatFailure) {
    return { code: "lock_heartbeat_failed", reason: `锁心跳失败（${heartbeatFailure.code}）：${heartbeatFailure.reason}` };
  }
  if (!lock) return null; // 未提供锁身份（测试路径）→ 跳过校验
  const current = readBatchLock(workspaceId, projectRoot);
  if (!current) {
    return { code: "lock_missing", reason: `workspace ${workspaceId} 批量锁已不存在（被释放或接管），当前 run 失去提交权` };
  }
  if (current.lockId !== lock.lockId || current.ownerRunId !== lock.ownerRunId) {
    return {
      code: "lock_taken_over",
      reason: `workspace ${workspaceId} 批量锁已被接管（磁盘 lockId=${current.lockId}, ownerRunId=${current.ownerRunId}；期望 ${lock.lockId}/${lock.ownerRunId}）`,
    };
  }
  return null;
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
    // 0. CONCURRENCY-WAVE1：锁归属校验——锁丢失/被接管 → fail-closed 停止
    const lockIssue = verifyLockOwnership(workspaceId, projectRoot, input.lock, null);
    if (lockIssue) {
      state.status = "error";
      state.interruptReason = lockIssue.code;
      state.updatedAt = new Date().toISOString();
      (state as BatchJobState & { failureEnvelope?: unknown }).failureEnvelope = {
        stage: "batch_lock",
        gate: "workspace_lock",
        severity: "fatal",
        reason: `${lockIssue.reason}。已停止，不得在失去提交权后继续推进 frontier。`,
        code: lockIssue.code,
        recoverable: false,
      };
      if (saveStateCas(state, workspaceId, jobId, projectRoot, `lock_${lockIssue.code}`) === "blocked") break;
      break;
    }

    // 1. 重新加载 state 检查 cancelRequested（cancel action 可能在外部设置）
    const fresh = loadBatchJobStore(workspaceId, jobId, projectRoot);
    if (fresh?.state.cancelRequested) {
      state.status = "cancelled";
      state.cancelRequested = true;
      state.updatedAt = new Date().toISOString();
      if (saveStateCas(state, workspaceId, jobId, projectRoot, "cancel_detected") === "blocked") break;
      break;
    }

    // 2. 幂等性检查：已完成章节跳过（防重复 resume）
    if (isChapterAlreadyCompleted(workspaceId, state.frontier, projectRoot)) {
      if (!state.completedChapters.includes(state.frontier)) {
        state.completedChapters.push(state.frontier);
      }
      state.frontier++;
      state.updatedAt = new Date().toISOString();
      if (saveStateCas(state, workspaceId, jobId, projectRoot, `idempotent_skip_ch${state.frontier - 1}`) === "blocked") break;
      continue;
    }

    // 2b. Batch 预算准入：剩余章节/调用/recovery/等待/费用不足则 checkpoint，不启动下一章
    const chapterCount = state.endChapter - state.startChapter + 1;
    const storedLedger = loadBudgetLedgerStore(workspaceId, projectRoot);
    let jobLedger: BudgetLedger = state.budgetLedger
      ? createBudgetLedger(state.budgetLedger)
      : storedLedger.usage.batchChaptersUsed > 0 || storedLedger.usage.totalModelCalls > 0
        ? storedLedger
        : createBudgetLedger({
            runIdentity: {
              runId: jobId,
              releaseId: "batch",
              modelVersion: "batch",
              bundleId: "batch",
              budgetGrantId: jobId,
            },
            hardBudget: {
              maxBatchChapters: chapterCount,
              maxModelCalls: 25 * chapterCount,
              maxRecoveryModelCalls: 6 * chapterCount,
              maxProviderCost: 2.0 * chapterCount,
              maxTotalWaitMs: 45 * 60 * 1000 * chapterCount,
            },
          });
    jobLedger = expireReservations(jobLedger);
    const admitted = admitBatchChapter(jobLedger, { chapterNumber: state.frontier });
    if (!admitted.ok) {
      state.budgetLedger = admitted.ledger;
      saveBudgetLedgerStore(admitted.ledger, workspaceId, projectRoot);
      state.status = "paused";
      state.interruptReason = "budget_exhausted";
      state.checkpointChapter = state.frontier;
      state.updatedAt = new Date().toISOString();
      (state as BatchJobState & { failureEnvelope?: unknown }).failureEnvelope = {
        stage: "batch_budget",
        gate: "budget_ledger",
        severity: "recoverable",
        reason: `Batch 预算准入失败（${admitted.reason}）。已 checkpoint 在第 ${state.frontier} 章，未启动生成。`,
        recoverable: true,
        code: admitted.reason,
      };
      if (saveStateCas(state, workspaceId, jobId, projectRoot, `budget_checkpoint_ch${state.frontier}`) === "blocked") break;
      break;
    }
    state.budgetLedger = admitted.ledger;
    saveBudgetLedgerStore(admitted.ledger, workspaceId, projectRoot);

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
    if (saveStateCas(state, workspaceId, jobId, projectRoot, `chapter_running_${state.frontier}`) === "blocked") break;

    // 4. 调用统一主链路（mock 或 handleGenerateChapter）
    // P0-B：章节执行期间启动锁心跳，防止单章超过 30 分钟锁过期被抢占
    // CONCURRENCY-WAVE1：心跳失败被结构化记录并在章节边界 fail-closed
    const chapterInput = {
      workspaceId,
      chapterId: String(state.frontier),
      chapterNumber: state.frontier,
      _projectRoot: projectRoot,
      _priorBudgetLedger: state.budgetLedger,
    };
    const heartbeat = startLockHeartbeat(workspaceId, jobId, projectRoot, input.lock?.lockId);
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
      heartbeat.stop();
    }
    const heartbeatFailure = heartbeat.getFailure();
    const chapterLedger = result?.stageResults?.budgetLedger as BudgetLedger | undefined;
    if (chapterLedger) {
      state.budgetLedger = createBudgetLedger(chapterLedger);
      saveBudgetLedgerStore(state.budgetLedger, workspaceId, projectRoot);
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
    // AUTONOMY-P5：proxy approval pending / checkpoint 不得视为“已正式提交”
    // 不得推进 frontier，也不得消耗正式 chapter.save 授权。
    const commitSaveReason = result?.stageResults?.commitAndSave?.reason;
    const pendingCheckpoint =
      result?.status === "ok" &&
      !chapterFileExists &&
      (
        commitSaveReason === "proxy_approval_pending" ||
        (result?.stageResults?.commitAndSave?.skipped === true &&
          typeof commitSaveReason === "string" &&
          String(commitSaveReason).includes("proxy_approval")) ||
        (result?.chapterFilePath == null &&
          result?.stageResults?.proxyApproval?.shouldSkipCommit === true)
      );
    const blockedStatus = result?.status === "blocked";
    chapterSucceeded = result?.status === "ok" && chapterFileExists && stateCommitOk;

    // 每章独立 authorization scope（批量不得共享无限期 save 授权）
    chapterResult.authorizationScope = {
      workspaceId,
      chapterId: String(state.frontier),
      batchJobId: jobId,
      approvalId: result?.stageResults?.proxyApproval?.approvalId,
      revision: result?.stageResults?.proxyApproval?.savedAt,
      artifactHash: result?.stageResults?.proxyApproval?.artifactHash,
    };

    // 扣减批量初稿预算（无论成功/checkpoint/失败，只要发起过生成）
    if (typeof state.remainingDraftBudget === "number" && state.remainingDraftBudget > 0) {
      state.remainingDraftBudget -= 1;
    }

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
      if (saveStateCas(state, workspaceId, jobId, projectRoot, `chapter_completed_${state.frontier - 1}`) === "blocked") break;
      // P0-FIX-5: 长任务续租锁 — 每章完成后延长 expiresAt，避免 100 章任务超过 30 分钟被误判过期
      renewBatchLock(workspaceId, jobId, projectRoot, input.lock?.lockId);
    } else if (pendingCheckpoint || blockedStatus) {
      // 7a2. AUTONOMY-P5：checkpoint / blocked → 停止后续章节，不推进 frontier
      chapterResult.status = pendingCheckpoint ? "checkpoint" : "failed";
      chapterResult.completedAt = new Date().toISOString();
      chapterResult.interruptReason = pendingCheckpoint
        ? "checkpoint_pending"
        : "chapter_blocked";
      chapterResult.failureEnvelope = result?.failureEnvelope ?? {
        stage: "batch_chapter",
        severity: pendingCheckpoint ? "recoverable" : "hard",
        gate: pendingCheckpoint ? "approval" : "autonomy",
        reason: pendingCheckpoint
          ? `chapter ${state.frontier} 进入 checkpoint/pending，等待逐章用户确认后才能继续`
          : `chapter ${state.frontier} blocked；批量停止，不得越过未确认章节`,
        recoverable: pendingCheckpoint,
      };
      state.failedChapter = state.frontier;
      state.checkpointChapter = pendingCheckpoint ? state.frontier : state.checkpointChapter;
      state.interruptReason = pendingCheckpoint ? "checkpoint_pending" : "chapter_blocked";
      state.updatedAt = new Date().toISOString();
      if (saveStateCas(state, workspaceId, jobId, projectRoot, `chapter_interrupt_${state.frontier}`) === "blocked") break;
      chapterSucceeded = false;
    } else {
      // 7b. 失败：记录失败结果（但不立即设置 status 或 break——先检查 cancel）
      chapterResult.status = "failed";
      chapterResult.completedAt = new Date().toISOString();
      chapterResult.interruptReason = "chapter_failed";
      chapterResult.failureEnvelope = result?.failureEnvelope ?? {
        stage: "batch_chapter",
        severity: "error",
        reason: `chapter ${state.frontier} did not reach status=ok (status=${result?.status}, fileExists=${chapterFileExists}, stateCommitOk=${stateCommitOk})`,
        recoverable: false,
      };
      state.failedChapter = state.frontier;
      state.interruptReason = "chapter_failed";
      state.updatedAt = new Date().toISOString();
      if (saveStateCas(state, workspaceId, jobId, projectRoot, `chapter_failed_${state.frontier}`) === "blocked") break;
    }

    // 7c. CONCURRENCY-WAVE1：章节执行期间心跳失败 → 锁已丢失/被接管，
    //     fail-closed 停止任务（不无限假装持锁推进 frontier）
    if (input.lock && heartbeatFailure) {
      chapterResult.status = "failed";
      chapterResult.interruptReason = "lock_lost";
      chapterResult.failureEnvelope = {
        stage: "batch_lock",
        gate: "workspace_lock",
        severity: "fatal",
        code: "lock_heartbeat_failed",
        reason: `章节执行期间锁心跳失败（${heartbeatFailure.code}）：${heartbeatFailure.reason}。任务停止；恢复依据磁盘 stateRevision 与 commit 事实，不以锁状态判定提交成败。`,
        recoverable: false,
        heartbeatFailureAt: heartbeatFailure.at,
      };
      state.failedChapter = state.frontier;
      state.interruptReason = "lock_lost";
      state.status = "error";
      state.updatedAt = new Date().toISOString();
      saveStateCas(state, workspaceId, jobId, projectRoot, "lock_heartbeat_failed");
      break;
    }

    // 8. P0-FIX-4 + P1-C：章节结果已记录后，检查 cancel
    //    cancelRequested 已在步骤 5 合并到内存；cancel 优先于 paused/error
    if (state.cancelRequested) {
      state.status = "cancelled";
      state.updatedAt = new Date().toISOString();
      if (saveStateCas(state, workspaceId, jobId, projectRoot, "cancel_confirmed") === "blocked") break;
      break;
    }

    // 9. 章节失败且未 cancel → 按 stopOnFailure 处理
    if (!chapterSucceeded) {
      state.status = state.stopOnFailure ? "paused" : "error";
      state.updatedAt = new Date().toISOString();
      if (saveStateCas(state, workspaceId, jobId, projectRoot, `batch_stopped_${state.frontier}`) === "blocked") break;
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
  saveStateCas(state, workspaceId, jobId, projectRoot, `batch_final_${state.status}`);

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
