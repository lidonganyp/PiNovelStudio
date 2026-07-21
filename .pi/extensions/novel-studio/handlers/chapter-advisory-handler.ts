/**
 * chapter-advisory-handler — 章节诊断 + 反馈/provenance advisory 工具层入口
 *
 * 职责：通过 novel_workspace_manager action 委托，提供三个只读/写入 advisory 入口：
 * - action="diagnostic"：聚合查询 MethodologyDiagnosticState + ClosureTracker scanCompleteness
 *   + ChapterProgressionContract，只读，不修改工作树
 * - action="ingest_reader_feedback"：摄入读者反馈到 series/reader-feedback.json（advisory）
 * - action="record_return_chapter"：记录回流章 provenance 到 series/return-chapter-provenance.json（advisory）
 *
 * 设计原则（附录 F/G 工作流）：
 * - 不注册第 7 个公开工具，保持 6 工具契约
 * - advisory-only：不进入 raw prompt，不阻断生成，不决定文学胜负
 * - diagnostic 是只读查询，不修改任何文件
 * - ingest_reader_feedback / record_return_chapter 是写入 advisory 元数据，不修改正文/状态
 *
 * 与 workspace-manager-handler 的契约：
 * - workspace-manager-handler 检测 action 为 advisory 路径时委托给本模块
 * - 本模块返回统一 { status, ...result } 结构
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadClosureTracker } from "../craft/closure-tracker.js";
import { ingestReaderFeedback, type ReaderFeedbackType } from "../v2/core/reader-feedback-ingestor.js";
import {
  recordReturnChapterProvenance,
  type ReturnChapterType,
} from "../v2/core/return-chapter-provenance.js";
import { resolveWorkspacePath } from "../utils/fs.js";

// ============================================================================
// 入口参数（与 HandleWorkspaceManagerInput 对齐）
// ============================================================================

export interface ChapterAdvisoryInput {
  action: "diagnostic" | "ingest_reader_feedback" | "record_return_chapter";
  workspaceId: string;
  /** diagnostic 用：查询的章节号（可选，默认返回最新章） */
  chapterNumber?: number;
  /** ingest_reader_feedback 用 */
  feedbackType?: ReaderFeedbackType;
  feedbackText?: string;
  sourceRef?: string;
  focusDimensions?: string[];
  chapterId?: string;
  /** record_return_chapter 用 */
  returnType?: ReturnChapterType;
  sourceChapterIds?: string[];
  reason?: string;
  /** 项目根路径（默认 cwd） */
  _projectRoot?: string;
}

export interface ChapterAdvisoryResult {
  status: "success" | "error";
  error?: string;
  // diagnostic 结果
  diagnostic?: {
    workspaceId: string;
    chapterNumber: number | null;
    closureReport: unknown | null;
    progressionContract: unknown | null;
    readerFeedbackCount: number;
    returnChapterCount: number;
  };
  // ingest_reader_feedback 结果
  feedbackEntry?: unknown;
  // record_return_chapter 结果
  provenanceEntry?: unknown;
}

// ============================================================================
// 主入口
// ============================================================================

export async function handleChapterAdvisory(
  input: ChapterAdvisoryInput,
): Promise<ChapterAdvisoryResult> {
  const projectRoot = input._projectRoot ?? process.cwd();
  // P0-3 安全修复：复用 workspace 安全解析器，防止 workspaceId 路径穿越
  // （workspaceId=".." 或含特殊字符会被 validateWorkspaceId 拒绝；
  //  resolveWorkspacePath 二次校验 resolve 后路径仍在 workspaces/ 下）
  const workspacesBase = join(projectRoot, "workspaces");
  let workspacePath: string;
  try {
    workspacePath = resolveWorkspacePath(workspacesBase, input.workspaceId);
  } catch (e: unknown) {
    return {
      status: "error",
      error: `Invalid workspaceId: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!existsSync(workspacePath)) {
    return {
      status: "error",
      error: `Workspace "${input.workspaceId}" 不存在`,
    };
  }

  switch (input.action) {
    case "diagnostic":
      return handleDiagnostic(workspacePath, input);
    case "ingest_reader_feedback":
      return handleIngestReaderFeedback(workspacePath, input);
    case "record_return_chapter":
      return handleRecordReturnChapter(workspacePath, input);
    default:
      return {
        status: "error",
        error: `未知 advisory action: ${input.action}`,
      };
  }
}

// ============================================================================
// diagnostic 子操作：只读聚合查询
// ============================================================================

async function handleDiagnostic(
  workspacePath: string,
  input: ChapterAdvisoryInput,
): Promise<ChapterAdvisoryResult> {
  const seriesDir = join(workspacePath, "series");

  // 1. ClosureTracker scanCompleteness（只读，不保存）
  //    P0-1: 优先读 arc-registry-derived.json（派生缓存），fallback 到 arc-registry.json
  const arcRegistryDerivedPath = join(seriesDir, "arc-registry-derived.json");
  const arcRegistryLegacyPath = join(seriesDir, "arc-registry.json");
  const arcRegistryPath = existsSync(arcRegistryDerivedPath)
    ? arcRegistryDerivedPath
    : arcRegistryLegacyPath;
  let closureReport: unknown | null = null;
  if (existsSync(arcRegistryPath)) {
    try {
      const tracker = loadClosureTracker(arcRegistryPath);
      if (tracker) {
        closureReport = tracker.scanCompleteness();
      }
    } catch {
      // advisory，失败不影响其他维度
    }
  }

  // 2. ChapterProgressionContract（最新章）
  const contractsPath = join(seriesDir, "chapter-progression-contracts.json");
  let progressionContract: unknown | null = null;
  let chapterNumber: number | null = null;
  if (existsSync(contractsPath)) {
    try {
      const raw = readFileSync(contractsPath, "utf-8");
      const parsed = JSON.parse(raw) as { contracts?: Array<{ chapterNumber: number }> };
      const contracts = parsed.contracts ?? [];
      if (contracts.length > 0) {
        // 优先返回 chapterNumber 指定的章节，否则返回最新章
        const target =
          input.chapterNumber !== undefined
            ? contracts.find((c) => c.chapterNumber === input.chapterNumber)
            : contracts[contracts.length - 1];
        if (target) {
          progressionContract = target;
          chapterNumber = target.chapterNumber;
        }
      }
    } catch {
      // advisory
    }
  }

  // 3. Reader feedback 计数
  const feedbackPath = join(seriesDir, "reader-feedback.json");
  let readerFeedbackCount = 0;
  if (existsSync(feedbackPath)) {
    try {
      const raw = readFileSync(feedbackPath, "utf-8");
      const parsed = JSON.parse(raw) as { feedbacks?: unknown[] };
      readerFeedbackCount = Array.isArray(parsed.feedbacks) ? parsed.feedbacks.length : 0;
    } catch {
      // advisory
    }
  }

  // 4. Return chapter provenance 计数
  const provenancePath = join(seriesDir, "return-chapter-provenance.json");
  let returnChapterCount = 0;
  if (existsSync(provenancePath)) {
    try {
      const raw = readFileSync(provenancePath, "utf-8");
      const parsed = JSON.parse(raw) as { entries?: unknown[] };
      returnChapterCount = Array.isArray(parsed.entries) ? parsed.entries.length : 0;
    } catch {
      // advisory
    }
  }

  return {
    status: "success",
    diagnostic: {
      workspaceId: input.workspaceId,
      chapterNumber,
      closureReport,
      progressionContract,
      readerFeedbackCount,
      returnChapterCount,
    },
  };
}

// ============================================================================
// ingest_reader_feedback 子操作
// ============================================================================

function handleIngestReaderFeedback(
  workspacePath: string,
  input: ChapterAdvisoryInput,
): ChapterAdvisoryResult {
  if (!input.chapterId || input.chapterNumber === undefined) {
    return {
      status: "error",
      error: "ingest_reader_feedback 需要 chapterId 和 chapterNumber",
    };
  }
  if (!input.feedbackType) {
    return {
      status: "error",
      error: "ingest_reader_feedback 需要 feedbackType（positive/negative/neutral）",
    };
  }
  if (!input.feedbackText) {
    return {
      status: "error",
      error: "ingest_reader_feedback 需要 feedbackText",
    };
  }
  if (!input.sourceRef) {
    return {
      status: "error",
      error: "ingest_reader_feedback 需要 sourceRef（反馈来源必须可追溯）",
    };
  }

  const result = ingestReaderFeedback({
    workspacePath,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    feedbackType: input.feedbackType,
    feedbackText: input.feedbackText,
    sourceRef: input.sourceRef,
    focusDimensions: input.focusDimensions,
  });

  if (!result.ok) {
    return { status: "error", error: result.error };
  }
  return { status: "success", feedbackEntry: result.entry };
}

// ============================================================================
// record_return_chapter 子操作
// ============================================================================

function handleRecordReturnChapter(
  workspacePath: string,
  input: ChapterAdvisoryInput,
): ChapterAdvisoryResult {
  if (!input.chapterId || input.chapterNumber === undefined) {
    return {
      status: "error",
      error: "record_return_chapter 需要 chapterId 和 chapterNumber",
    };
  }
  if (!input.returnType) {
    return {
      status: "error",
      error: "record_return_chapter 需要 returnType（rewrite/recap/reveal）",
    };
  }
  if (!input.reason) {
    return {
      status: "error",
      error: "record_return_chapter 需要 reason（回流章必须说明触发原因）",
    };
  }
  if (!input.sourceRef) {
    return {
      status: "error",
      error: "record_return_chapter 需要 sourceRef（provenance 来源必须可追溯）",
    };
  }
  if (!Array.isArray(input.sourceChapterIds) || input.sourceChapterIds.length === 0) {
    return {
      status: "error",
      error: "record_return_chapter 需要 sourceChapterIds（非空数组）",
    };
  }

  const result = recordReturnChapterProvenance({
    workspacePath,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    returnType: input.returnType,
    sourceChapterIds: input.sourceChapterIds,
    reason: input.reason,
    sourceRef: input.sourceRef,
  });

  if (!result.ok) {
    return { status: "error", error: result.error };
  }
  return { status: "success", provenanceEntry: result.entry };
}
