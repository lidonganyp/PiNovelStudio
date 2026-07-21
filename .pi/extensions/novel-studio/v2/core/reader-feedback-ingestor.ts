/**
 * reader-feedback-ingestor — 读者反馈摄入（READER-FEEDBACK-1，advisory 工具层）
 *
 * 职责：把用户/读者对本章的反馈（正向/负向/中性）持久化到
 * workspaces/{id}/series/reader-feedback.json，供下游诊断层作为 advisory 输入。
 *
 * 设计原则（advisory-only，附录 F/G 工作流）：
 * - 不进入 raw prompt，不阻断生成，不决定文学胜负
 * - 只记录用户明确提供的反馈，不机器生成反馈内容
 * - 反馈来源必须可追溯（chapterId + sourceRef + 提交时间戳）
 * - 失败不阻断主链路（advisory）
 *
 * 与 MethodologyDiagnosticState 的契约：
 * - 下一章生成时，MethodologyDiagnosticStateLoader 可读取 reader-feedback.json
 * - 反馈作为 advisory 证据，提示模型注意读者体验趋势
 * - 反馈不直接触发候选生成或文学判断
 *
 * 与 Phase 6 在线学习的关系：
 * - 反馈可作为 Phase 6 strategy feedback 的辅助输入
 * - 但不替代 strategy feedback 的正式提交流程
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

// ============================================================================
// 数据契约
// ============================================================================

export type ReaderFeedbackType = "positive" | "negative" | "neutral";

export interface ReaderFeedbackEntry {
  /** 反馈 id（自动生成：`feedback:{chapterId}:{timestamp}`） */
  id: string;
  /** 关联章节 id（如 "ch17"） */
  chapterId: string;
  /** 关联章节号（如 17） */
  chapterNumber: number;
  /** 反馈类型 */
  feedbackType: ReaderFeedbackType;
  /** 反馈内容（用户原文，不机器生成） */
  feedbackText: string;
  /** 反馈来源引用（如 "user:session-xxx" 或 "reviewer:role-name"） */
  sourceRef: string;
  /** 提交时间戳（ISO 8601） */
  submittedAt: string;
  /**
   * 可选：反馈聚焦的具体维度（advisory，便于下游诊断层归类）
   * 如：pacing / character / plot / style / naturalness
   */
  focusDimensions?: string[];
}

export interface ReaderFeedbackStore {
  schemaVersion: number;
  workspaceId: string;
  feedbacks: ReaderFeedbackEntry[];
  lastUpdated: string;
}

export interface IngestReaderFeedbackInput {
  workspacePath: string;
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  feedbackType: ReaderFeedbackType;
  feedbackText: string;
  sourceRef: string;
  focusDimensions?: string[];
}

export interface IngestReaderFeedbackResult {
  ok: boolean;
  error?: string;
  entry: ReaderFeedbackEntry | null;
  /** 写入的文件路径（用于 trace 审计） */
  writtenPath: string | null;
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 摄入读者反馈并持久化到 series/reader-feedback.json。
 *
 * 事务策略：
 * - 读取 existing store（如有）
 * - 追加新反馈条目
 * - 原子写入（tmp → rename）
 * - 失败返回 ok=false，不抛异常（advisory，不阻断主链路）
 */
export function ingestReaderFeedback(
  input: IngestReaderFeedbackInput,
): IngestReaderFeedbackResult {
  const feedbackPath = join(input.workspacePath, "series", "reader-feedback.json");

  // 校验必填字段
  if (!input.feedbackText || input.feedbackText.trim().length === 0) {
    return {
      ok: false,
      error: "feedbackText 必填且不能为空",
      entry: null,
      writtenPath: null,
    };
  }
  if (!input.sourceRef || input.sourceRef.trim().length === 0) {
    return {
      ok: false,
      error: "sourceRef 必填（反馈来源必须可追溯）",
      entry: null,
      writtenPath: null,
    };
  }

  // 读取 existing store
  let store: ReaderFeedbackStore;
  try {
    if (existsSync(feedbackPath)) {
      const raw = readFileSync(feedbackPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ReaderFeedbackStore>;
      store = {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        feedbacks: Array.isArray(parsed.feedbacks) ? parsed.feedbacks : [],
        lastUpdated: parsed.lastUpdated ?? "",
      };
    } else {
      store = {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        feedbacks: [],
        lastUpdated: "",
      };
    }
  } catch {
    store = {
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      feedbacks: [],
      lastUpdated: "",
    };
  }

  // 生成新反馈条目
  const now = new Date().toISOString();
  const timestamp = Date.now();
  const entry: ReaderFeedbackEntry = {
    id: `feedback:${input.chapterId}:${timestamp}`,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    feedbackType: input.feedbackType,
    feedbackText: input.feedbackText.trim(),
    sourceRef: input.sourceRef,
    submittedAt: now,
    focusDimensions: input.focusDimensions,
  };

  store.feedbacks.push(entry);
  // 保留最近 100 条（避免无限增长）
  if (store.feedbacks.length > 100) {
    store.feedbacks = store.feedbacks.slice(-100);
  }
  store.lastUpdated = now;

  // 原子写入
  try {
    const dir = dirname(feedbackPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${feedbackPath}.${process.pid}.${timestamp}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(store, null, 2), "utf-8");
    renameSync(tmpPath, feedbackPath);
    return { ok: true, entry, writtenPath: feedbackPath };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, entry: null, writtenPath: null };
  }
}
