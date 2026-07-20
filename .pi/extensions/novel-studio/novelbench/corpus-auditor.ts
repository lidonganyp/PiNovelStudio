/**
 * NB-0：语料审计与 Manifest
 *
 * 扫描本地小说语料库，生成不含正文的 Manifest。
 *
 * 核心规则（任务要求）：
 * - 永不改写/移动原始文件（只读）
 * - 仅保存元数据 + 可配置源路径，不保存正文
 * - 按 bookId 排序保证确定性（相同输入 → 相同 manifest）
 * - 去重：canonical 优先精校 → 更大 size → 更高 encodingScore，余者 duplicate
 * - 编码识别失败、章节切分失败、重复文件均有明确报告（issues）
 *
 * 复用 eval/replay-case-extractor.ts 的 decodeNovelSourceBuffer 做多编码解码。
 */

import { createHash } from "node:crypto";
import { readFile, stat, readdir } from "node:fs/promises";
import { join, relative, basename, extname } from "node:path";
import { decodeNovelSourceBuffer } from "../eval/replay-case-extractor.js";
import type {
  BookManifestEntry,
  CorpusAuditStats,
  CorpusAuditResult,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/** 类型关键词 → genre 映射（从目录路径推断） */
const GENRE_KEYWORDS: Array<{ genre: string; keywords: string[] }> = [
  { genre: "玄幻", keywords: ["玄幻", "修真", "修仙", "仙侠"] },
  { genre: "武侠", keywords: ["武侠"] },
  { genre: "奇幻", keywords: ["奇幻", "魔幻"] },
  { genre: "灵异", keywords: ["灵异", "恐怖", "悬疑"] },
  { genre: "末日", keywords: ["末日", "废土", "末世"] },
  { genre: "都市", keywords: ["都市", "现实"] },
  { genre: "历史", keywords: ["历史", "架空"] },
  { genre: "科幻", keywords: ["科幻"] },
];

/** 精校/校对/完本关键词（用于识别 canonical 优先版本） */
const PROOFREAD_KEYWORDS = ["精校", "校对", "精修", "完本", "全集", "无错字"];

/** 广告/污染关键词 */
const POLLUTION_KEYWORDS = [
  "www.",
  "http://",
  "https://",
  ".com",
  ".net",
  "更多小说",
  "请访问",
  "扫码",
  "关注公众号",
];

/** 最小文件大小（字节）；低于此视为 incomplete */
const MIN_FILE_SIZE = 1024;

/** 最小章节数；低于此视为 incomplete */
const MIN_CHAPTER_COUNT = 3;

/** 编码得分低于此阈值视为 mojibake */
const MOJIBAKE_SCORE_THRESHOLD = 0.3;

/** 粗略章节标题正则（用于 NB-0 章节计数；NB-1 用更严格的 splitChaptersStrict） */
const ROUGH_CHAPTER_HEADING =
  /^(?:第[0-9零〇一二三四五六七八九十百千万两]+[章节]|Chapter\s+[0-9]+|序章|楔子|终章|番外)/gim;

// ─────────────────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditCorporaOptions {
  /** 语料根目录（绝对路径） */
  root: string;
  /**
   * 是否记录真实审计时间戳（默认 true）。
   * 测试时可传 false 以保证 auditTimestamp 稳定，便于断言 hash 稳定。
   */
  recordTimestamp?: boolean;
}

/**
 * 审计整个语料库，生成 Manifest。
 *
 * @returns 按 bookId 排序的条目 + 统计
 */
export async function auditCorpora(
  options: AuditCorporaOptions,
): Promise<CorpusAuditResult> {
  const { root, recordTimestamp = true } = options;
  const auditTimestamp = recordTimestamp ? new Date().toISOString() : "stable";

  const filePaths = await collectTxtFiles(root);
  const rawEntries: BookManifestEntry[] = [];
  for (let i = 0; i < filePaths.length; i++) {
    if ((i + 1) % 50 === 0 || i === 0) {
      process.stderr.write(
        `[NB-0] 审计进度 ${i + 1}/${filePaths.length}\n`,
      );
    }
    const entry = await auditSingleFile(filePaths[i], root, auditTimestamp);
    rawEntries.push(entry);
  }
  process.stderr.write(`[NB-0] 审计完成 ${filePaths.length} 文件，开始去重\n`);

  const entries = resolveDuplicates(rawEntries);
  entries.sort((a, b) => a.bookId.localeCompare(b.bookId));

  const stats = computeStats(entries);
  return { entries, stats };
}

// ─────────────────────────────────────────────────────────────────────────────
// 文件扫描（递归，确定性排序）
// ─────────────────────────────────────────────────────────────────────────────

async function collectTxtFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 按名称排序保证扫描顺序确定
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".txt")) {
        result.push(full);
      }
    }
  }
  await walk(root);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 单文件审计
// ─────────────────────────────────────────────────────────────────────────────

async function auditSingleFile(
  filePath: string,
  root: string,
  auditTimestamp: string,
): Promise<BookManifestEntry> {
  const buffer = await readFile(filePath);
  const fileStat = await stat(filePath);
  const fileHash = sha256(buffer);
  const decoded = decodeNovelSourceBuffer(new Uint8Array(buffer));
  const contentHash = sha256(decoded.text);

  const { title, author, isProofread } = parseFilename(filePath);
  const genre = detectGenreFromPath(filePath);
  const bookId = computeBookId(title, author);
  const authorId = author ? computeAuthorId(author) : undefined;
  const chapterCount = countChapters(decoded.text);
  const averageChapterLength =
    chapterCount > 0 ? Math.round(decoded.text.length / chapterCount) : undefined;

  const issues: string[] = [];
  let status: BookManifestEntry["status"] = "canonical";

  // mojibake 检测（编码得分过低）
  if (decoded.score < MOJIBAKE_SCORE_THRESHOLD) {
    issues.push(
      `mojibake: 编码得分 ${decoded.score.toFixed(2)} 低于阈值 ${MOJIBAKE_SCORE_THRESHOLD}`,
    );
    status = "mojibake";
  }

  // incomplete 检测（文件过小或章节数过少）
  if (fileStat.size < MIN_FILE_SIZE) {
    issues.push(`incomplete: 文件过小（${fileStat.size} 字节 < ${MIN_FILE_SIZE}）`);
    status = status === "canonical" ? "incomplete" : status;
  } else if (chapterCount < MIN_CHAPTER_COUNT && status === "canonical") {
    issues.push(`incomplete: 章节数过少（${chapterCount} < ${MIN_CHAPTER_COUNT}）`);
    status = "incomplete";
  }

  // polluted 检测（广告/污染关键词）
  const pollutionFound = POLLUTION_KEYWORDS.filter((kw) =>
    decoded.text.includes(kw),
  );
  if (pollutionFound.length > 0) {
    issues.push(`polluted: 检测到广告/污染关键词 ${JSON.stringify(pollutionFound)}`);
    status = status === "canonical" ? "polluted" : status;
  }

  return {
    bookId,
    authorId,
    title,
    author,
    genre,
    sourcePath: relative(root, filePath).split(/[\\/]/).join("/"),
    fileHash,
    contentHash,
    size: fileStat.size,
    encoding: decoded.encoding,
    encodingScore: decoded.score,
    chapterCount,
    averageChapterLength,
    status,
    isProofread,
    issues,
    auditTimestamp,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 文件名解析
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedFilename {
  title: string;
  author?: string;
  isProofread: boolean;
}

/**
 * 解析文件名，识别书名/作者/精校变体。
 *
 * 支持格式：
 * - 《书名》作者.txt
 * - 书名 - 作者.txt / 书名 — 作者.txt / 书名 by 作者.txt
 * - [精校版]书名.txt / 书名（校对）.txt
 * - 纯书名.txt
 */
export function parseFilename(filePath: string): ParsedFilename {
  const name = basename(filePath, extname(filePath));
  let isProofread = false;
  let cleanName = name;

  // 检测精校/校对变体
  for (const kw of PROOFREAD_KEYWORDS) {
    if (cleanName.includes(kw)) {
      isProofread = true;
      break;
    }
  }

  // 移除常见修饰后缀：[精校版]、(校对)、【完本】等
  cleanName = cleanName
    .replace(/[【[\[（(][^\]】)）]*[精校校对完本全集无错字修]+[^\]】)）]*[\]】)）]/g, "")
    .replace(/\s*[（(][^)）]*[)）]\s*/g, "")
    .trim();

  // 《书名》作者 格式
  const bookTitleMatch = cleanName.match(/《([^》]+)》/);
  if (bookTitleMatch) {
    const title = bookTitleMatch[1].trim();
    const rest = cleanName.replace(/《[^》]+》/, "").trim();
    const author = extractAuthor(rest);
    return { title, author, isProofread };
  }

  // 书名 - 作者 / 书名 — 作者 / 书名 by 作者 格式
  const sepMatch = cleanName.match(/^(.+?)\s*[-—–]+\s*(.+)$/);
  if (sepMatch) {
    return {
      title: sepMatch[1].trim(),
      author: sepMatch[2].trim(),
      isProofread,
    };
  }
  const byMatch = cleanName.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    return {
      title: byMatch[1].trim(),
      author: byMatch[2].trim(),
      isProofread,
    };
  }

  // 纯书名
  return { title: cleanName, isProofread };
}

function extractAuthor(text: string): string | undefined {
  const cleaned = text.replace(/^[\s\-—–,，:：]+/, "").trim();
  if (!cleaned) return undefined;
  return cleaned.replace(/^作者[:：]?\s*/, "").trim() || undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 类型检测
// ─────────────────────────────────────────────────────────────────────────────

/** 从文件路径的目录段推断类型 */
export function detectGenreFromPath(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  for (const seg of segments) {
    for (const { genre, keywords } of GENRE_KEYWORDS) {
      if (keywords.some((kw) => seg.includes(kw))) {
        return genre;
      }
    }
  }
  return "未分类";
}

// ─────────────────────────────────────────────────────────────────────────────
// ID 计算
// ─────────────────────────────────────────────────────────────────────────────

/** bookId = sha256(normalizedTitle + author) 前 16 字符 */
export function computeBookId(title: string, author?: string): string {
  const normalized =
    normalizeTitle(title) + (author ? "|" + author.trim() : "");
  return sha256(normalized).slice(0, 16);
}

/** authorId = sha256(author) 前 16 字符 */
export function computeAuthorId(author: string): string {
  return sha256(author.trim()).slice(0, 16);
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// 章节计数（粗略）
// ─────────────────────────────────────────────────────────────────────────────

/** 粗略统计章节数（用于 NB-0 Manifest；NB-1 用严格切分） */
export function countChapters(text: string): number {
  const matches = text.match(ROUGH_CHAPTER_HEADING);
  return matches ? matches.length : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 去重
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 按 normalizedTitle+author 分组，选 canonical。
 * canonical 优先级：精校 > 更大 size > 更高 encodingScore。
 * 其余标为 duplicate，duplicateOf 指向 canonical。
 */
function resolveDuplicates(
  entries: BookManifestEntry[],
): BookManifestEntry[] {
  const groups = new Map<string, BookManifestEntry[]>();
  for (const entry of entries) {
    const key =
      normalizeTitle(entry.title) +
      (entry.author ? "|" + entry.author.trim() : "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  const result: BookManifestEntry[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    // 排序选 canonical：精校 > size > encodingScore
    const sorted = [...group].sort((a, b) => {
      if (a.isProofread !== b.isProofread) return a.isProofread ? -1 : 1;
      if (a.size !== b.size) return b.size - a.size;
      return b.encodingScore - a.encodingScore;
    });
    const canonical = sorted[0];
    result.push(canonical);
    for (let i = 1; i < sorted.length; i++) {
      result.push({
        ...sorted[i],
        status: "duplicate",
        duplicateOf: canonical.bookId,
      });
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 统计
// ─────────────────────────────────────────────────────────────────────────────

function computeStats(entries: BookManifestEntry[]): CorpusAuditStats {
  const stats: CorpusAuditStats = {
    totalFiles: entries.length,
    canonical: 0,
    duplicate: 0,
    incomplete: 0,
    mojibake: 0,
    polluted: 0,
    byGenre: {},
    encodingDistribution: {},
  };
  for (const e of entries) {
    stats[e.status]++;
    stats.byGenre[e.genre] = (stats.byGenre[e.genre] ?? 0) + 1;
    stats.encodingDistribution[e.encoding] =
      (stats.encodingDistribution[e.encoding] ?? 0) + 1;
  }
  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
