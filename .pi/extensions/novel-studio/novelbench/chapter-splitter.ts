/**
 * NB-1：可靠章节切分
 *
 * 核心原则（任务要求）：
 * - 只让高置信真实章节进入 benchmark
 * - **无标题 fallback 禁止**：<2 heading → rejectionReason="no_reliable_headings"、chapters=[]
 * - 禁止固定 3000 字 fallback 被标记为真实章节
 * - source offset + hash 能重新定位完全相同的 reference body
 *
 * 支持：
 * - 第N章/节（中文+阿拉伯数字）
 * - Chapter N
 * - 序章/楔子/终章/番外/尾声
 * - 第N卷/集/部作父级 volume
 * - TOC 页/异常短章/超长章/重复章号检测
 * - 复合 splitConfidence（heading 清晰度 + 间距均匀性 + 编号连续性）
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import { createHash } from "node:crypto";
import type {
  ChapterSplit,
  VolumeInfo,
  ChapterSplitResult,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// 常量与正则
// ─────────────────────────────────────────────────────────────────────────────

const CJK_NUMERAL = "[0-9零〇一二三四五六七八九十百千万两]+";

/** 章节标题正则：第N章/节、Chapter N、序章/楔子/终章/番外/尾声 */
const CHAPTER_HEADING_RE = new RegExp(
  `^(?:第(${CJK_NUMERAL})[章节]|Chapter\\s+([0-9]+)|(序章|楔子|终章|番外篇?|尾声))` +
    `[ \\t　:：.、-]*(.*)$`,
  "gim",
);

/** 卷标题正则：第N卷/集/部 */
const VOLUME_HEADING_RE = new RegExp(
  `^第(${CJK_NUMERAL})[卷集部][ \\t　:：.、-]*(.*)$`,
  "gim",
);

/** 中文数字 → 阿拉伯数字（用于编号连续性检查） */
const CHINESE_NUMERAL_VALUES: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};

/** 异常短章阈值（字符数） */
const SHORT_CHAPTER_THRESHOLD = 200;

/** 超长章阈值（字符数） */
const OVERLONG_CHAPTER_THRESHOLD = 30000;

/** TOC 检测：连续短章数阈值 */
const TOC_CONSECUTIVE_SHORT = 5;

/** TOC 检测：每章 body 最大字符数 */
const TOC_BODY_MAX_CHARS = 20;

/** 抽样摘要长度 */
const SAMPLE_EXCERPT_LENGTH = 300;

// ─────────────────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 严格章节切分。无标题时不做 fallback，直接拒绝。
 *
 * @param decodedText 已解码的全文（不含 BOM，\n 换行）
 * @returns ChapterSplitResult（chapters 可能为空 + rejectionReason）
 */
export function splitChaptersStrict(decodedText: string): ChapterSplitResult {
  const text = normalizeText(decodedText);
  const issues: string[] = [];

  // 扫描卷标题
  const volumes = scanVolumes(text);

  // 扫描章节标题
  const rawMatches = scanChapterHeadings(text);

  // 无标题 fallback 禁止：<2 heading → 拒绝
  if (rawMatches.length < 2) {
    return {
      chapters: [],
      volumes,
      splitConfidence: 0,
      rejectionReason: "no_reliable_headings",
      issues: [
        `仅找到 ${rawMatches.length} 个章节标题，低于最低 2 个阈值；禁止 fallback`,
      ],
    };
  }

  // 构建章节切片
  const chapters = buildChapterSlices(text, rawMatches);

  // TOC 页检测：前 N 章连续极短
  const tocIssue = detectTocPage(chapters);
  if (tocIssue) {
    issues.push(tocIssue);
    // TOC 不直接拒绝，但严重降低置信度；若全部章节都是短章则拒绝
    const allShort = chapters.every(
      (c) => c.characterCount < TOC_BODY_MAX_CHARS,
    );
    if (allShort) {
      return {
        chapters: [],
        volumes,
        splitConfidence: 0,
        rejectionReason: "toc_page",
        issues: [...issues, "全部章节 body 极短，判定为目录页"],
      };
    }
  }

  // 逐章 issue 检测
  const chapterNumberCounts = new Map<number, number>();
  for (const ch of chapters) {
    if (ch.characterCount < SHORT_CHAPTER_THRESHOLD) {
      ch.issues.push(
        `short_chapter: body 仅 ${ch.characterCount} 字 < ${SHORT_CHAPTER_THRESHOLD}`,
      );
    }
    if (ch.characterCount > OVERLONG_CHAPTER_THRESHOLD) {
      ch.issues.push(
        `overlong_chapter: body ${ch.characterCount} 字 > ${OVERLONG_CHAPTER_THRESHOLD}`,
      );
    }
    chapterNumberCounts.set(
      ch.chapterNumber,
      (chapterNumberCounts.get(ch.chapterNumber) ?? 0) + 1,
    );
  }
  for (const [num, count] of chapterNumberCounts) {
    if (count > 1) {
      issues.push(
        `duplicate_chapter_number: 第 ${num} 章出现 ${count} 次`,
      );
      // 同步标记到对应章节
      for (const ch of chapters) {
        if (ch.chapterNumber === num) {
          ch.issues.push(`duplicate_chapter_number: 第 ${num} 章重复`);
        }
      }
    }
  }

  // 汇总各章 issue 到顶层
  for (const ch of chapters) {
    if (ch.issues.length > 0) {
      issues.push(`第${ch.chapterNumber}章: ${ch.issues.join("; ")}`);
    }
  }

  // 复合置信度
  const splitConfidence = computeConfidence(chapters);

  return {
    chapters,
    volumes,
    splitConfidence,
    issues,
  };
}

/**
 * 从全文 + ChapterSplit 重定位 reference body，验证 hash 一致。
 *
 * @returns body 文本；hash 不匹配时返回 null
 */
export function resolveReferenceBody(
  decodedText: string,
  split: ChapterSplit,
): string | null {
  const text = normalizeText(decodedText);
  const body = text.slice(split.bodyStartOffset, split.endOffset).trim();
  const hash = sha256(body);
  return hash === split.bodyHash ? body : null;
}

/**
 * 抽样首/中/末章 body 前 N 字摘要（供人工切分检查）。
 */
export function sampleChapters(
  decodedText: string,
  splits: ChapterSplit[],
  n = 3,
): Array<{ chapterNumber: number; heading: string; excerpt: string }> {
  if (splits.length === 0) return [];
  const text = normalizeText(decodedText);
  const indices = pickSampleIndices(splits.length, n);
  return indices.map((i) => {
    const split = splits[i];
    const body = text.slice(split.bodyStartOffset, split.endOffset).trim();
    return {
      chapterNumber: split.chapterNumber,
      heading: split.heading,
      excerpt: body.slice(0, SAMPLE_EXCERPT_LENGTH),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部实现
// ─────────────────────────────────────────────────────────────────────────────

interface RawHeadingMatch {
  index: number;
  heading: string;
  chapterNumber: number;
  title: string;
}

function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function scanVolumes(text: string): VolumeInfo[] {
  const volumes: VolumeInfo[] = [];
  const matches = [...text.matchAll(VOLUME_HEADING_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const startOffset = m.index ?? 0;
    const endOffset = matches[i + 1]?.index ?? text.length;
    const volumeNumber = m[1] ?? "";
    const title = (m[2] ?? "").trim();
    volumes.push({
      volumeNumber,
      title,
      startOffset,
      endOffset,
    });
  }
  return volumes;
}

function scanChapterHeadings(text: string): RawHeadingMatch[] {
  const matches = [...text.matchAll(CHAPTER_HEADING_RE)];
  return matches.map((m, replayIndex) => {
    const heading = m[0];
    const title = (m[4] ?? "").trim();
    const chapterNumber = resolveChapterNumber(
      m[1] ?? m[2] ?? m[3] ?? "",
      replayIndex + 1,
    );
    return {
      index: m.index ?? 0,
      heading,
      chapterNumber,
      title,
    };
  });
}

function buildChapterSlices(
  text: string,
  matches: RawHeadingMatch[],
): ChapterSplit[] {
  const chapters: ChapterSplit[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const headingEnd = m.index + m.heading.length;
    const bodyStartOffset = skipLineBreak(text, headingEnd);
    const endOffset = matches[i + 1]?.index ?? text.length;
    const body = text.slice(bodyStartOffset, endOffset).trim();
    const chapterNumber = m.chapterNumber;
    const title = m.title || `第${chapterNumber}章`;

    chapters.push({
      chapterNumber,
      heading: m.heading,
      title,
      startOffset: m.index,
      bodyStartOffset,
      endOffset,
      bodyHash: sha256(body),
      characterCount: body.length,
      splitConfidence: 0, // 逐章置信度留 0，整体置信度由 computeConfidence 计算
      issues: [],
    });
  }
  return chapters;
}

function detectTocPage(chapters: ChapterSplit[]): string | null {
  let consecutive = 0;
  let maxConsecutive = 0;
  for (const ch of chapters) {
    if (ch.characterCount < TOC_BODY_MAX_CHARS) {
      consecutive++;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
    } else {
      consecutive = 0;
    }
  }
  if (maxConsecutive >= TOC_CONSECUTIVE_SHORT) {
    return `toc_page: 连续 ${maxConsecutive} 章.body < ${TOC_BODY_MAX_CHARS} 字，疑似目录页`;
  }
  return null;
}

/**
 * 复合置信度（0-1）：
 * - heading 清晰度（0.4）：第N章/Chapter N 格式占比
 * - 间距均匀性（0.3）：章长变异系数越低越高
 * - 编号连续性（0.3）：编号连续递增比例
 */
function computeConfidence(chapters: ChapterSplit[]): number {
  if (chapters.length === 0) return 0;

  // heading 清晰度
  const clearCount = chapters.filter((c) =>
    /^(第[0-9零〇一二三四五六七八九十百千万两]+[章节]|Chapter\s+[0-9]+|序章|楔子|终章|番外)/i.test(
      c.heading,
    ),
  ).length;
  const clarityScore = clearCount / chapters.length;

  // 间距均匀性（变异系数倒数）
  const lengths = chapters.map((c) => c.characterCount);
  const meanLen = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  let uniformityScore = 1;
  if (meanLen > 0) {
    const variance =
      lengths.reduce((sum, l) => sum + (l - meanLen) ** 2, 0) / lengths.length;
    const stdDev = Math.sqrt(variance);
    const cv = stdDev / meanLen; // 变异系数
    uniformityScore = Math.max(0, 1 - cv);
  }

  // 编号连续性
  let continuousCount = 0;
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i].chapterNumber === chapters[i - 1].chapterNumber + 1) {
      continuousCount++;
    }
  }
  const continuityScore =
    chapters.length > 1 ? continuousCount / (chapters.length - 1) : 1;

  return (
    clarityScore * 0.4 + uniformityScore * 0.3 + continuityScore * 0.3
  );
}

function resolveChapterNumber(raw: string, fallback: number): number {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
  if (raw === "序章" || raw === "楔子") return 0;
  if (raw === "终章" || raw === "尾声" || raw === "番外" || raw === "番外篇") {
    return 9999;
  }
  const parsed = parseChineseInteger(raw);
  return parsed > 0 ? parsed : fallback;
}

function parseChineseInteger(raw: string): number {
  let result = 0;
  let section = 0;
  let number = 0;
  for (const char of raw) {
    const digit = CHINESE_NUMERAL_VALUES[char];
    if (digit !== undefined) {
      number = digit;
      continue;
    }
    if (char === "十" || char === "百" || char === "千") {
      const unit = char === "十" ? 10 : char === "百" ? 100 : 1000;
      section += (number || 1) * unit;
      number = 0;
      continue;
    }
    if (char === "万") {
      section = (section + number) * 10000;
      result += section;
      section = 0;
      number = 0;
    }
  }
  return result + section + number;
}

function skipLineBreak(text: string, offset: number): number {
  if (text[offset] === "\r" && text[offset + 1] === "\n") return offset + 2;
  if (text[offset] === "\n") return offset + 1;
  return offset;
}

function pickSampleIndices(total: number, n: number): number[] {
  if (total <= n) return Array.from({ length: total }, (_, i) => i);
  const result = new Set<number>();
  result.add(0); // 首
  result.add(total - 1); // 末
  // 中间均匀采样
  while (result.size < n) {
    const mid = Math.floor(total / 2);
    result.add(mid);
    if (result.size >= n) break;
    // 补充四分位
    result.add(Math.floor(total / 4));
    result.add(Math.floor((total * 3) / 4));
  }
  return [...result].sort((a, b) => a - b).slice(0, n);
}

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}
