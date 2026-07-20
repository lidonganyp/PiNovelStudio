/**
 * NovelOS Narrative Search Service（OPT-9.3）
 *
 * 统一的按需检索服务，供所有叙事工具调用。
 * - 复用 LegacyStateAdapter 只读导入 NarrativeStateStore（canon/character/promise/pattern）
 * - 复用 workspace/manager.ts 的章节目录结构读取历史章节正文
 * - 不新建并行数据层，不反向写回 legacy 文件
 *
 * 设计原则：
 * - 只读：所有方法不写入任何文件
 * - 缓存：同一 workspace 的 NarrativeStateStore 只导入一次
 * - 可追溯：每个结果带 sourceRef（legacy 文件名 + entry id / 章节文件 + offset）
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { createLegacyStateAdapter } from "../../v2/adapters/legacy-state-adapter.js";
import type { NarrativeStateStore, CanonEntry, CharacterStateEntry, PromiseEntry, PatternEntry } from "../../v2/core/final-state-commit.js";
import type { EvidenceLevel } from "../tools/tool-protocol.js";

// ============================================================================
// ChapterSpan — 原文 span 搜索结果
// ============================================================================

// EvidenceLevel 类型从 ../tools/tool-protocol.js 导入（M1.1 统一证据等级）

export interface ChapterSpan {
  /** 章节 ID，如 "ch17" */
  chapterId: string;
  /** 章节文件路径 */
  filePath: string;
  /** 匹配文本片段 */
  excerpt: string;
  /** 在全文中的起始字符偏移 */
  startOffset: number;
  /** 在全文中的结束字符偏移 */
  endOffset: number;
  /** sourceRef，如 "ch17#final.md:120-180" */
  sourceRef: string;
  /** M1.1：证据等级（confirmed_state > exact_chapter_span > inferred > profile_only） */
  evidenceLevel?: EvidenceLevel;
  /** M1.1：相关性分数 0-1（用于排序，高=更相关） */
  relevanceScore?: number;
}

// ============================================================================
// RankedEvidence — 统一证据包装（M1.1）
// ============================================================================

/**
 * 统一证据包装，用于 searchRanked 跨源检索结果排序。
 * 把 canon/character/chapter_span 等不同来源的证据统一成可比的 RankedEvidence。
 */
export interface RankedEvidence {
  /** sourceRef（canon id / character id / chapter span ref） */
  sourceRef: string;
  /** 证据文本片段 */
  excerpt: string;
  /** 证据等级 */
  evidenceLevel: EvidenceLevel;
  /** 相关性分数 0-1 */
  relevanceScore: number;
  /** 原始来源标记 */
  origin: "canon" | "character" | "chapter_span" | "promise" | "pattern";
}

// ============================================================================
// NarrativeSearchService
// ============================================================================

export interface NarrativeSearchServiceOptions {
  projectRoot: string;
  workspaceId: string;
  /** 来源章节标记（如 "ch17"，用于 LegacyStateAdapter） */
  sourceChapter: string;
}

export class NarrativeSearchService {
  private readonly projectRoot: string;
  private readonly workspaceId: string;
  private readonly sourceChapter: string;
  private storeCache: NarrativeStateStore | null = null;
  private storeSources: string[] = [];

  constructor(options: NarrativeSearchServiceOptions) {
    this.projectRoot = options.projectRoot;
    this.workspaceId = options.workspaceId;
    this.sourceChapter = options.sourceChapter;
  }

  // ── NarrativeStateStore 访问 ──────────────────────────────────────────

  /**
   * 获取 NarrativeStateStore（从 legacy 状态文件导入，缓存）。
   * 返回 { store, sources }：sources 是导入来源文件列表。
   */
  getStateStore(): { store: NarrativeStateStore; sources: string[] } {
    if (this.storeCache) {
      return { store: this.storeCache, sources: this.storeSources };
    }
    const adapter = createLegacyStateAdapter();
    const result = adapter.importFromLegacy(
      this.workspaceId,
      this.projectRoot,
      this.sourceChapter,
    );
    this.storeCache = result.store;
    this.storeSources = result.sources;
    return { store: result.store, sources: result.sources };
  }

  /** 查询 canon 条目（可按 category 过滤） */
  queryCanon(category?: CanonEntry["category"]): CanonEntry[] {
    const { store } = this.getStateStore();
    if (!category) return store.canon;
    return store.canon.filter((e) => e.category === category);
  }

  /** 查询角色状态条目（按 characterId 过滤） */
  queryCharacterState(characterId?: string): CharacterStateEntry[] {
    const { store } = this.getStateStore();
    if (!characterId) return store.character;
    return store.character.filter((e) => e.characterId === characterId);
  }

  /** 查询角色知识边界（character field 包含 "knowledge" 或 "knows"） */
  queryCharacterKnowledgeBoundary(characterId?: string): CharacterStateEntry[] {
    const entries = this.queryCharacterState(characterId);
    return entries.filter(
      (e) =>
        e.field.toLowerCase().includes("knowledge") ||
        e.field.toLowerCase().includes("knows") ||
        e.field.toLowerCase().includes("knowledgeboundary"),
    );
  }

  /** 查询 promise/伏笔条目（可按 status 过滤） */
  queryPromiseLedger(status?: PromiseEntry["status"]): PromiseEntry[] {
    const { store } = this.getStateStore();
    if (!status) return store.promise;
    return store.promise.filter((e) => e.status === status);
  }

  /** 查询 pattern 条目（可按 patternType 过滤） */
  queryPatternMemory(patternType?: PatternEntry["patternType"]): PatternEntry[] {
    const { store } = this.getStateStore();
    if (!patternType) return store.pattern;
    return store.pattern.filter((e) => e.patternType === patternType);
  }

  /** 查询时间线条目（canon category=timeline） */
  queryTimeline(): CanonEntry[] {
    return this.queryCanon("timeline");
  }

  // ── 章节正文搜索 ──────────────────────────────────────────────────────

  /**
   * 获取 workspace 章节目录路径。
   * 章节存储为 workspaces/{id}/chapters/chapter-{N}/final.md
   */
  private getChaptersDir(): string {
    return join(this.projectRoot, "workspaces", this.workspaceId, "chapters");
  }

  /** 列出所有已生成章节的编号（升序） */
  listChapterNumbers(): number[] {
    const dir = this.getChaptersDir();
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir, { withFileTypes: true });
    const numbers: number[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("chapter-")) {
        const num = parseInt(entry.name.replace("chapter-", ""), 10);
        if (Number.isFinite(num) && num > 0) {
          numbers.push(num);
        }
      }
    }
    return numbers.sort((a, b) => a - b);
  }

  /** 读取指定章节的正文（final.md） */
  readChapterText(chapterNumber: number): string | null {
    const chapterDir = join(
      this.getChaptersDir(),
      `chapter-${String(chapterNumber).padStart(2, "0")}`,
    );
    // 同时尝试 chapter-N 和 chapter-0N 两种格式
    const candidates = [
      join(this.getChaptersDir(), `chapter-${chapterNumber}`, "final.md"),
      join(chapterDir, "final.md"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        return readFileSync(p, "utf-8");
      }
    }
    return null;
  }

  /**
   * 在历史章节正文中搜索包含 query 的 span。
   * - 从最新章节向前搜索（更相关）
   * - 返回所有匹配的 span（每个匹配取 query 上下文各 40 字符）
   * - 限制最多 maxResults（默认 10）防止无界遍历
   *
   * @param query 搜索关键词/短语
   * @param maxChapters 搜索最近多少章（默认 10）
   * @param maxResults 最大返回数（默认 10）
   */
  searchChapterSpan(
    query: string,
    maxChapters = 10,
    maxResults = 10,
  ): ChapterSpan[] {
    if (!query || query.trim().length === 0) return [];

    const allNumbers = this.listChapterNumbers();
    // 从最新章节向前取 maxChapters 章
    const toSearch = allNumbers.slice(-maxChapters).reverse();

    const results: ChapterSpan[] = [];
    for (const num of toSearch) {
      if (results.length >= maxResults) break;
      const text = this.readChapterText(num);
      if (!text) continue;

      const chapterId = `ch${num}`;
      const filePath = join(
        this.getChaptersDir(),
        `chapter-${String(num).padStart(2, "0")}`,
        "final.md",
      );

      // 搜索所有出现位置
      let searchFrom = 0;
      while (results.length < maxResults) {
        const idx = text.indexOf(query, searchFrom);
        if (idx === -1) break;
        const contextStart = Math.max(0, idx - 40);
        const contextEnd = Math.min(text.length, idx + query.length + 40);
        const excerpt = text.slice(contextStart, contextEnd);
        // M1.1：相关性分数 — query 越长越具体（0.70-0.88），低于 confirmed_state(0.95+)
        const relevanceScore = 0.7 + Math.min(query.length, 6) * 0.03;
        results.push({
          chapterId,
          filePath,
          excerpt,
          startOffset: idx,
          endOffset: idx + query.length,
          sourceRef: `${chapterId}#final.md:${idx}-${idx + query.length}`,
          evidenceLevel: "exact_chapter_span",
          relevanceScore,
        });
        searchFrom = idx + query.length;
      }
    }
    return results;
  }

  // ── M1.1：跨源综合检索 + 证据排序 ─────────────────────────────────────

  /**
   * 综合检索：按证据等级 + 相关性排序返回统一 RankedEvidence 列表（M1.1）。
   *
   * 检索顺序（优先级从高到低）：
   * 1. canon（confirmed_state, score 1.0）— 若 query 命中 canon.fact
   * 2. character state（confirmed_state, score 0.95）— 若 query 命中 character 字段
   * 3. chapter span（exact_chapter_span, score 0.70-0.88）— full-text 匹配
   *
   * 合并后按 evidenceLevel 优先级 + relevanceScore 降序排序，
   * 过滤 relevanceScore < 0.3 的低相关结果（过滤相似但错误结果）。
   *
   * @param query 搜索关键词/短语
   * @param options.category canon 类别过滤（如 "location"/"timeline"）
   * @param options.maxResults 最大返回数（默认 10）
   */
  searchRanked(
    query: string,
    options?: { category?: CanonEntry["category"]; maxResults?: number },
  ): RankedEvidence[] {
    const maxResults = options?.maxResults ?? 10;
    const evidences: RankedEvidence[] = [];

    // 1. canon（confirmed_state）— 只收录与 query 相关的 canon
    const canonEntries = this.queryCanon(options?.category);
    for (const entry of canonEntries) {
      if (!query) continue;
      if (entry.fact.includes(query) || query.includes(entry.fact)) {
        evidences.push({
          sourceRef: `canon:${entry.id}`,
          excerpt: entry.fact,
          evidenceLevel: "confirmed_state",
          relevanceScore: 1.0,
          origin: "canon",
        });
      }
    }

    // 2. character state（confirmed_state）
    const charEntries = this.queryCharacterState();
    for (const entry of charEntries) {
      const text = `${entry.field}:${entry.value}`;
      if (!query) continue;
      if (text.includes(query) || query.includes(entry.value)) {
        evidences.push({
          sourceRef: `character:${entry.characterId}:${entry.field}`,
          excerpt: text,
          evidenceLevel: "confirmed_state",
          relevanceScore: 0.95,
          origin: "character",
        });
      }
    }

    // 3. chapter span（exact_chapter_span）
    const spans = this.searchChapterSpan(query, 10, maxResults);
    for (const span of spans) {
      evidences.push({
        sourceRef: span.sourceRef,
        excerpt: span.excerpt,
        evidenceLevel: "exact_chapter_span",
        relevanceScore: span.relevanceScore ?? 0.7,
        origin: "chapter_span",
      });
    }

    // 排序：evidenceLevel 优先级 + relevanceScore 降序
    const levelPriority: Record<EvidenceLevel, number> = {
      confirmed_state: 3,
      exact_chapter_span: 2,
      confirmed: 2,
      inferred: 1,
      profile_only: 0,
    };
    evidences.sort((a, b) => {
      if (levelPriority[a.evidenceLevel] !== levelPriority[b.evidenceLevel]) {
        return levelPriority[b.evidenceLevel] - levelPriority[a.evidenceLevel];
      }
      return b.relevanceScore - a.relevanceScore;
    });

    // 过滤低相关结果 + 限制数量
    return evidences
      .filter((e) => e.relevanceScore >= 0.3)
      .slice(0, maxResults);
  }
}

// ============================================================================
// 工厂
// ============================================================================

export function createNarrativeSearchService(
  options: NarrativeSearchServiceOptions,
): NarrativeSearchService {
  return new NarrativeSearchService(options);
}
