/**
 * MEMORY-3 压缩策略注册表与可回源机制（MEMORY-COMPRESSION-1）
 *
 * 目标（任务文档 §六 / §十 / §七.3）：
 * - 不同记忆类型使用不同压缩策略（禁止统一压成自由文本摘要）
 * - 摘要必须保留 sourceChapter/sourceRef/textHash
 * - 按 memoryId 回源最终正文（sourceRef → 片段）
 * - 检测并禁止无来源的摘要套摘要
 *
 * 本模块是纯函数集合，无文件副作用；回源通过注入的 readChapter 提供器实现，
 * 保证可单测且可回源 fail-closed（hash 不匹配时拒绝返回模糊片段）。
 */

import { createHash } from "node:crypto";
import type { MemoryRecord, MemoryType } from "./memory-record.js";

function computeSha12(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

// ============================================================================
// 压缩等级
// ============================================================================

export type CompressionLevel =
  | "none" // 禁止自由语义压缩（结构化保存）
  | "summary_with_ref" // 可摘要但必须保留引用（sourceRef/textHash）
  | "high_abstract" // 允许较高抽象（PatternMemory/策略信誉）
  | "decay"; // 应衰减或过期（诊断/一次性推断）

export interface CompressionStrategy {
  memoryType: MemoryType;
  level: CompressionLevel;
  /** 是否允许生成辅助摘要（作为阅读辅助，不成为唯一真相源） */
  allowSummary: boolean;
  /** 是否必须保留生命周期与兑现条件（promise） */
  mustKeepLifecycle: boolean;
  /** 是否必须保留结构化字段（fact/canon/character），禁止纯自由文本 */
  mustKeepStructure: boolean;
  /** 是否必须保留原文引用 */
  mustKeepReference: boolean;
}

const STRATEGY_REGISTRY: Record<MemoryType, CompressionStrategy> = {
  working: {
    memoryType: "working",
    level: "decay",
    allowSummary: false,
    mustKeepLifecycle: false,
    mustKeepStructure: false,
    mustKeepReference: false,
  },
  chapter_fact: {
    memoryType: "chapter_fact",
    level: "none",
    allowSummary: false,
    mustKeepLifecycle: false,
    mustKeepStructure: true,
    mustKeepReference: true,
  },
  canon: {
    memoryType: "canon",
    level: "none",
    allowSummary: false,
    mustKeepLifecycle: false,
    mustKeepStructure: true,
    mustKeepReference: true,
  },
  character: {
    memoryType: "character",
    level: "summary_with_ref",
    allowSummary: true, // 允许生成辅助摘要，但结构化状态为权威
    mustKeepLifecycle: false,
    mustKeepStructure: true,
    mustKeepReference: true,
  },
  promise: {
    memoryType: "promise",
    level: "none",
    allowSummary: false,
    mustKeepLifecycle: true, // 不压缩生命周期和兑现条件
    mustKeepStructure: true,
    mustKeepReference: true,
  },
  pattern: {
    memoryType: "pattern",
    level: "high_abstract",
    allowSummary: true,
    mustKeepLifecycle: false,
    mustKeepStructure: false,
    mustKeepReference: false,
  },
  chapter_summary: {
    memoryType: "chapter_summary",
    level: "summary_with_ref",
    allowSummary: true,
    mustKeepLifecycle: false,
    mustKeepStructure: false,
    mustKeepReference: true, // 必须保留原文引用
  },
  source_text: {
    memoryType: "source_text",
    level: "none",
    allowSummary: false,
    mustKeepLifecycle: false,
    mustKeepStructure: false,
    mustKeepReference: false, // 本身即原文
  },
  plan: {
    memoryType: "plan",
    level: "none",
    allowSummary: false,
    mustKeepLifecycle: false,
    mustKeepStructure: false,
    mustKeepReference: false, // 不得进入正式事实检索
  },
  diagnostic: {
    memoryType: "diagnostic",
    level: "decay",
    allowSummary: false,
    mustKeepLifecycle: false,
    mustKeepStructure: false,
    mustKeepReference: false, // 必须有 TTL/衰减
  },
};

export function compressionStrategy(memoryType: MemoryType): CompressionStrategy {
  return STRATEGY_REGISTRY[memoryType];
}

export function isCompressionAllowed(memoryType: MemoryType): boolean {
  const s = STRATEGY_REGISTRY[memoryType];
  return s.level === "summary_with_ref" || s.level === "high_abstract";
}

// ============================================================================
// 可回源：sourceRef → 最终正文片段
// ============================================================================

/** 读取指定章节最终正文的提供器（由调用方注入，保持本模块无 I/O 副作用） */
export type ChapterTextProvider = (chapterNumber: number) => string | null;

/** 解析 sourceRef 为 { chapter, hash, start?, end? }。格式 ch{N}#finalText:{hash}[:{start}-{end}] */
export function parseSourceRef(
  sourceRef: string
): { chapter: number; hash: string; start?: number; end?: number } | null {
  const m = sourceRef.match(/^ch(\d+)#finalText:([0-9a-f]{12})(?::(\d+)-(\d+))?$/i);
  if (!m) return null;
  const chapter = parseInt(m[1], 10);
  const hash = m[2].toLowerCase();
  const hasSpan = m[3] !== undefined && m[4] !== undefined;
  if (!hasSpan) return { chapter, hash };
  return { chapter, hash, start: parseInt(m[3], 10), end: parseInt(m[4], 10) };
}

export interface ResolveSourceResult {
  ok: boolean;
  /** 回源到的最终正文片段 */
  excerpt: string | null;
  /** 回源结果说明（供诊断） */
  reason: string;
}

/**
 * 按 memoryId 的 sourceRef 回源最终正文片段。
 *
 * MEMORY-3 验收：
 * - 所有正式摘要 100% 可回源
 * - 原文修改或 hash 不匹配时检索 fail-closed（不返回模糊片段）
 * - 精确事实查询能回到原文，而不是只返回二次摘要
 */
export function resolveMemorySource(
  record: MemoryRecord,
  readChapter: ChapterTextProvider
): ResolveSourceResult {
  // 取第一个可解析的 sourceRef（同一记忆可有多个来源）
  for (const ref of record.sourceRef) {
    const parsed = parseSourceRef(ref);
    if (!parsed) continue;
    const chapterText = readChapter(parsed.chapter);
    if (chapterText == null) {
      return { ok: false, excerpt: null, reason: `chapter ${parsed.chapter} 正文不可用` };
    }
    // hash 校验 fail-closed：正文 hash 不匹配时拒绝返回，防止引用已修改的旧片段
    if (computeSha12(chapterText) !== parsed.hash) {
      return {
        ok: false,
        excerpt: null,
        reason: `sourceRef hash 不匹配（finalText 已修改或引用失效）：${ref}`,
      };
    }
    if (parsed.start !== undefined && parsed.end !== undefined) {
      if (parsed.start < 0 || parsed.end > chapterText.length || parsed.start >= parsed.end) {
        return { ok: false, excerpt: null, reason: `sourceRef span 越界：${ref}` };
      }
      return {
        ok: true,
        excerpt: chapterText.slice(parsed.start, parsed.end),
        reason: `回源成功 ch${parsed.chapter} [${parsed.start}-${parsed.end}]`,
      };
    }
    // 无 span（如 pattern kind）→ 返回整章不可取，标记不可精确定位
    return {
      ok: false,
      excerpt: null,
      reason: `sourceRef 无 span（${ref}），无法精确定位片段；请提供结构化字段或 span`,
    };
  }
  return { ok: false, excerpt: null, reason: "sourceRef 无法解析或无有效引用" };
}

/**
 * 判断摘要是否构成"摘要套摘要"（无来源的二度摘要）。
 *
 * MEMORY-3 验收：检测并禁止无来源的摘要套摘要（§3.3）。
 * - 摘要必须指向最终正文/结构化状态（存在可解析的 sourceRef）
 * - 若 payload 是摘要类型但全部 derivedFromMemoryIds 指向其他摘要且自身无 sourceRef → 拒绝
 */
export function detectSummaryOfSummary(record: MemoryRecord): {
  isSummaryOfSummary: boolean;
  reason?: string;
} {
  // 仅摘要类记忆（chapter_summary / 允许摘要的 character/pattern）需检查
  const s = compressionStrategy(record.memoryType);
  if (!s.mustKeepReference && !s.allowSummary) {
    return { isSummaryOfSummary: false };
  }
  // 摘要必须有可解析 sourceRef（回到最终正文/结构化状态）
  const hasDirectSource = record.sourceRef.some((ref) => parseSourceRef(ref) !== null);
  if (!hasDirectSource) {
    if (record.derivedFromMemoryIds.length === 0) {
      return { isSummaryOfSummary: false, reason: "非摘要（无来源也无派生）" };
    }
    return {
      isSummaryOfSummary: true,
      reason: `摘要无直接 sourceRef，仅派生自 [${record.derivedFromMemoryIds.join(",")}]，构成无来源摘要套摘要`,
    };
  }
  return { isSummaryOfSummary: false };
}
