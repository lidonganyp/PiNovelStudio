/**
 * return-chapter-provenance — 回流章 provenance 字段（RETURN-CHAPTER-1，advisory 工具层）
 *
 * 职责：记录"回流章"的 provenance 元数据，包括：
 * - 章节类型：rewrite（重写已有章节）/ recap（回顾前情）/ reveal（补充揭示）
 * - 来源章节：该回流章基于哪一章或哪些章节
 * - 触发原因：为什么需要回流章（如读者反馈/修订/补充揭示）
 * - sourceRef：可追溯的来源引用
 *
 * 持久化到 workspaces/{id}/series/return-chapter-provenance.json
 *
 * 设计原则（advisory-only）：
 * - 不进入 raw prompt，不阻断生成，不决定文学胜负
 * - 不替代正式章节生成流程；回流章仍需走 novel_generate_chapter
 * - provenance 只记录元数据，不记录正文内容
 * - 失败不阻断主链路（advisory）
 *
 * 与 MethodologyDiagnosticState 的契约：
 * - 下一章生成时，MethodologyDiagnosticStateLoader 可读取 return-chapter-provenance.json
 * - provenance 作为 advisory 证据，提示模型注意本章是回流章（避免重复内容）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

// ============================================================================
// 数据契约
// ============================================================================

export type ReturnChapterType = "rewrite" | "recap" | "reveal";

export interface ReturnChapterProvenanceEntry {
  /** 条目 id（自动生成：`return:{chapterId}:{timestamp}`） */
  id: string;
  /** 回流章 id（如 "ch17-recap"） */
  chapterId: string;
  /** 回流章对应的章节号（可能与原章节号相同或不同） */
  chapterNumber: number;
  /** 回流类型 */
  returnType: ReturnChapterType;
  /** 来源章节 id 列表（该回流章基于哪些原章节） */
  sourceChapterIds: string[];
  /** 触发原因（如"读者反馈指出 ch15 信息释放不足"） */
  reason: string;
  /** 来源引用（可追溯的触发证据，如 "feedback:ch15:1234567890"） */
  sourceRef: string;
  /** 提交时间戳（ISO 8601） */
  recordedAt: string;
}

export interface ReturnChapterProvenanceStore {
  schemaVersion: number;
  workspaceId: string;
  entries: ReturnChapterProvenanceEntry[];
  lastUpdated: string;
}

export interface RecordReturnChapterProvenanceInput {
  workspacePath: string;
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  returnType: ReturnChapterType;
  sourceChapterIds: string[];
  reason: string;
  sourceRef: string;
}

export interface RecordReturnChapterProvenanceResult {
  ok: boolean;
  error?: string;
  entry: ReturnChapterProvenanceEntry | null;
  /** 写入的文件路径（用于 trace 审计） */
  writtenPath: string | null;
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 记录回流章 provenance 并持久化到 series/return-chapter-provenance.json。
 *
 * 事务策略：
 * - 读取 existing store（如有）
 * - 追加新 provenance 条目
 * - 原子写入（tmp → rename）
 * - 失败返回 ok=false，不抛异常（advisory）
 */
export function recordReturnChapterProvenance(
  input: RecordReturnChapterProvenanceInput,
): RecordReturnChapterProvenanceResult {
  const provenancePath = join(input.workspacePath, "series", "return-chapter-provenance.json");

  // 校验必填字段
  if (!input.reason || input.reason.trim().length === 0) {
    return {
      ok: false,
      error: "reason 必填（回流章必须说明触发原因）",
      entry: null,
      writtenPath: null,
    };
  }
  if (!input.sourceRef || input.sourceRef.trim().length === 0) {
    return {
      ok: false,
      error: "sourceRef 必填（provenance 来源必须可追溯）",
      entry: null,
      writtenPath: null,
    };
  }
  if (!Array.isArray(input.sourceChapterIds) || input.sourceChapterIds.length === 0) {
    return {
      ok: false,
      error: "sourceChapterIds 必填且非空（回流章必须基于至少一个原章节）",
      entry: null,
      writtenPath: null,
    };
  }

  // 读取 existing store
  let store: ReturnChapterProvenanceStore;
  try {
    if (existsSync(provenancePath)) {
      const raw = readFileSync(provenancePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ReturnChapterProvenanceStore>;
      store = {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        lastUpdated: parsed.lastUpdated ?? "",
      };
    } else {
      store = {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        entries: [],
        lastUpdated: "",
      };
    }
  } catch {
    store = {
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      entries: [],
      lastUpdated: "",
    };
  }

  // 生成新条目
  const now = new Date().toISOString();
  const timestamp = Date.now();
  const entry: ReturnChapterProvenanceEntry = {
    id: `return:${input.chapterId}:${timestamp}`,
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    returnType: input.returnType,
    sourceChapterIds: input.sourceChapterIds,
    reason: input.reason.trim(),
    sourceRef: input.sourceRef,
    recordedAt: now,
  };

  store.entries.push(entry);
  store.lastUpdated = now;

  // 原子写入
  try {
    const dir = dirname(provenancePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${provenancePath}.${process.pid}.${timestamp}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(store, null, 2), "utf-8");
    renameSync(tmpPath, provenancePath);
    return { ok: true, entry, writtenPath: provenancePath };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, entry: null, writtenPath: null };
  }
}
