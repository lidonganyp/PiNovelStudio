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
// 核心编排函数（stub — RED 阶段 throw not implemented）
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
  throw new Error("not implemented: runBatchGeneration (RED stub)");
}

/**
 * 构建 BatchJobSummary。
 * 汇总总章节数、完成数、失败数、总耗时、总模型调用、失败 envelope 列表。
 */
export function buildSummary(state: BatchJobState): BatchJobSummary {
  throw new Error("not implemented: buildSummary (RED stub)");
}
