/**
 * NB-1R：章节切分校准（真实语料 precision 验证）
 *
 * 核心原则（任务要求）：
 * - 用独立方法生成 ground-truth 边界，不与 splitter 共用同一 regex（避免循环验证）
 * - 高置信章节边界 precision ≥ 98% 才可进入 benchmark
 * - 不允许固定字数 fallback（splitter 已强制；校准器只观测不引入 fallback）
 * - 未达到阈值的书必须拒绝或降为低置信
 * - 不得通过调低置信阈值虚增覆盖率
 *
 * 独立 ground-truth 扫描器设计（与 splitter 的差异）：
 * 1. 逐行扫描（split by \n），splitter 用 multiline regex matchAll
 * 2. 更广的 heading 变体：含「回」（武侠/历史经典单位）、节、更多特殊类型（前言/引子/后记/引言/序言/结语）
 * 3. 行长约束：heading 行必须 < 80 字符，避免匹配到正文段落中恰好以「第N章」开头的句子
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import { splitChaptersStrict } from "./chapter-splitter.js";
import type {
  BookCalibrationResult,
  ChapterBoundaryAnnotation,
  ChapterBoundaryErrorCategory,
  CalibrationStats,
  ChapterSplitResult,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/** 匹配容差：splitter 与 ground-truth 的 heading offset 差异上限（字符） */
const OFFSET_TOLERANCE = 5;

/** ground-truth heading 行最大长度（超过则不视为 heading，避免匹配正文） */
const GT_HEADING_LINE_MAX_LENGTH = 80;

/** 高置信 precision 阈值（任务要求 ≥98%） */
const HIGH_CONFIDENCE_PRECISION = 0.98;

/** heading 字段最大保存长度：超过则截断，防止正文泄漏（源文件中 heading 与 body 同行时 splitter 会捕获整行） */
const HEADING_MAX_LENGTH = 80;

/** 中文+阿拉伯数字 */
const CJK_NUMERAL = "[0-9零〇一二三四五六七八九十百千万两]+";

/**
 * ground-truth heading 正则（比 splitter 更广）：
 * - 第N章/节/回（splitter 只有章节，无回）
 * - Chapter N
 * - 序章/楔子/终章/番外/尾声/前言/引子/后记/引言/序言/结语（splitter 无后6种）
 */
const GT_HEADING_RE = new RegExp(
  `^(?:第(${CJK_NUMERAL})[章节回]|Chapter\\s+([0-9]+)|(序章|楔子|终章|番外篇?|尾声|前言|引子|后记|引言|序言|结语))` +
    `[ \\t　:：.、-]*(.*)$`,
  "i",
);

/** 中文数字 → 阿拉伯数字 */
const CHINESE_NUMERAL_VALUES: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};

/** 审核批次标记（AI 程序化校准） */
const ANNOTATOR = "nb-1r-programmatic-v1";

// ─────────────────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────────────────

export interface CalibrateOptions {
  bookId: string;
  title: string;
  genre: string;
  /** 已解码的全文（不含 BOM，\n 换行） */
  decodedText: string;
}

/**
 * 对单本书做章节切分校准：
 * 1. 独立 line-based 扫描器生成 ground-truth headings
 * 2. 运行 splitChaptersStrict 获取 splitter 输出
 * 3. 逐章匹配，标注 correct / false_positive / missing
 * 4. 计算 precision / recall，输出书级判定
 *
 * 不含正文：annotations 只保存 offset + heading 文本 + 标签。
 */
export function calibrateChapterSplitting(
  options: CalibrateOptions,
): BookCalibrationResult {
  const { bookId, title, genre, decodedText } = options;
  const text = normalizeText(decodedText);

  // 1. ground-truth 扫描（独立 line-based）
  const groundTruth = scanGroundTruthHeadings(text);

  // 2. splitter 输出
  const splitterResult: ChapterSplitResult = splitChaptersStrict(text);

  // 3. splitter 被拒绝时：所有 ground-truth 标记为 missing
  if (splitterResult.rejectionReason) {
    const annotations: ChapterBoundaryAnnotation[] = groundTruth.map(
      (gt, i) => ({
        bookId,
        splitterIndex: -1,
        headingOffset: gt.offset,
        bodyStartOffset: gt.bodyStartOffset,
        bodyEndOffset: gt.bodyEndOffset,
        heading: truncateHeading(gt.heading),
        chapterNumber: gt.chapterNumber,
        label: "missing",
        errorCategory: "rejected_no_headings",
        annotator: ANNOTATOR,
      }),
    );
    return {
      bookId,
      title,
      genre,
      groundTruthCount: groundTruth.length,
      splitterCount: 0,
      truePositive: 0,
      falsePositive: 0,
      falseNegative: groundTruth.length,
      precision: 0,
      recall: 0,
      splitConfidence: splitterResult.splitConfidence,
      rejectionReason: splitterResult.rejectionReason,
      verdict: "rejected",
      annotations,
      issues: splitterResult.issues,
    };
  }

  // 4. 逐章匹配
  const annotations: ChapterBoundaryAnnotation[] = [];
  const matchedGtIndices = new Set<number>();
  let truePositive = 0;
  let falsePositive = 0;

  for (let i = 0; i < splitterResult.chapters.length; i++) {
    const ch = splitterResult.chapters[i];
    const matchResult = findGroundTruthMatch(ch.startOffset, ch.heading, ch.chapterNumber, groundTruth, matchedGtIndices);

    if (matchResult.matched) {
      truePositive++;
      matchedGtIndices.add(matchResult.gtIndex);
      annotations.push({
        bookId,
        splitterIndex: i,
        headingOffset: ch.startOffset,
        bodyStartOffset: ch.bodyStartOffset,
        bodyEndOffset: ch.endOffset,
        heading: truncateHeading(ch.heading),
        chapterNumber: ch.chapterNumber,
        label: "correct",
        annotator: ANNOTATOR,
      });
    } else {
      falsePositive++;
      const errorCategory = matchResult.errorCategory ?? "spurious_heading";
      annotations.push({
        bookId,
        splitterIndex: i,
        headingOffset: ch.startOffset,
        bodyStartOffset: ch.bodyStartOffset,
        bodyEndOffset: ch.endOffset,
        heading: truncateHeading(ch.heading),
        chapterNumber: ch.chapterNumber,
        label: "false_positive",
        errorCategory,
        annotator: ANNOTATOR,
      });
    }
  }

  // 5. 未匹配的 ground-truth = false negative（splitter 漏掉）
  let falseNegative = 0;
  for (let i = 0; i < groundTruth.length; i++) {
    if (!matchedGtIndices.has(i)) {
      falseNegative++;
      const gt = groundTruth[i];
      annotations.push({
        bookId,
        splitterIndex: -1,
        headingOffset: gt.offset,
        bodyStartOffset: gt.bodyStartOffset,
        bodyEndOffset: gt.bodyEndOffset,
        heading: truncateHeading(gt.heading),
        chapterNumber: gt.chapterNumber,
        label: "missing",
        errorCategory: "missing_heading",
        annotator: ANNOTATOR,
      });
    }
  }

  const precision = truePositive + falsePositive > 0
    ? truePositive / (truePositive + falsePositive)
    : 0;
  const recall = truePositive + falseNegative > 0
    ? truePositive / (truePositive + falseNegative)
    : 0;

  // 6. 书级判定
  let verdict: BookCalibrationResult["verdict"];
  if (precision >= HIGH_CONFIDENCE_PRECISION) {
    verdict = "high_confidence";
  } else {
    verdict = "low_confidence";
  }

  return {
    bookId,
    title,
    genre,
    groundTruthCount: groundTruth.length,
    splitterCount: splitterResult.chapters.length,
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    splitConfidence: splitterResult.splitConfidence,
    verdict,
    annotations,
    issues: splitterResult.issues,
  };
}

/**
 * 聚合多本书的校准统计。
 */
export function aggregateCalibrationStats(
  results: BookCalibrationResult[],
): CalibrationStats {
  let totalGroundTruth = 0;
  let totalSplitter = 0;
  let totalTP = 0;
  let totalFP = 0;
  let totalFN = 0;
  let highConfidence = 0;
  let lowConfidence = 0;
  let rejected = 0;
  const errorDistribution: Record<string, number> = {};

  for (const r of results) {
    totalGroundTruth += r.groundTruthCount;
    totalSplitter += r.splitterCount;
    totalTP += r.truePositive;
    totalFP += r.falsePositive;
    totalFN += r.falseNegative;

    if (r.verdict === "high_confidence") highConfidence++;
    else if (r.verdict === "low_confidence") lowConfidence++;
    else rejected++;

    for (const a of r.annotations) {
      if (a.errorCategory) {
        errorDistribution[a.errorCategory] =
          (errorDistribution[a.errorCategory] ?? 0) + 1;
      }
    }
  }

  return {
    totalBooks: results.length,
    highConfidence,
    lowConfidence,
    rejected,
    totalGroundTruth,
    totalSplitter,
    totalTP,
    totalFP,
    totalFN,
    overallPrecision: totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 0,
    overallRecall: totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 0,
    errorDistribution,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ground-truth 扫描器（独立 line-based，与 splitter 不同实现）
// ─────────────────────────────────────────────────────────────────────────────

interface GroundTruthHeading {
  offset: number;
  bodyStartOffset: number;
  bodyEndOffset: number;
  heading: string;
  chapterNumber: number;
}

/**
 * 逐行扫描 ground-truth headings。
 *
 * 与 splitter 的差异：
 * - 逐行 split（splitter 用 multiline regex matchAll）
 * - 含「回」单位（splitter 无）
 * - 含更多特殊类型：前言/引子/后记/引言/序言/结语（splitter 无）
 * - 行长约束：< 80 字符才视为 heading（避免匹配正文）
 */
function scanGroundTruthHeadings(text: string): GroundTruthHeading[] {
  const headings: GroundTruthHeading[] = [];
  const lines = text.split("\n");

  // 计算每行起始 offset
  let lineOffset = 0;
  const lineOffsets: number[] = [];
  for (const line of lines) {
    lineOffsets.push(lineOffset);
    lineOffset += line.length + 1; // +1 for \n
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.length > GT_HEADING_LINE_MAX_LENGTH) {
      continue;
    }

    const match = trimmed.match(GT_HEADING_RE);
    if (!match) continue;

    const heading = match[0];
    const chapterNumber = resolveChapterNumber(
      match[1] ?? match[2] ?? match[3] ?? "",
      i + 1,
    );

    // body 范围：heading 行末到下一 heading 行首
    const headingLineStart = lineOffsets[i];
    const bodyStartOffset = headingLineStart + line.length + 1; // 跳过 \n

    // 找下一个 heading 行作为 body 结束
    let bodyEndOffset = text.length;
    for (let j = i + 1; j < lines.length; j++) {
      const nextTrimmed = lines[j].trim();
      if (
        nextTrimmed.length > 0 &&
        nextTrimmed.length <= GT_HEADING_LINE_MAX_LENGTH &&
        nextTrimmed.match(GT_HEADING_RE)
      ) {
        bodyEndOffset = lineOffsets[j];
        break;
      }
    }

    headings.push({
      offset: headingLineStart,
      bodyStartOffset,
      bodyEndOffset,
      heading,
      chapterNumber,
    });
  }

  return headings;
}

// ─────────────────────────────────────────────────────────────────────────────
// 匹配逻辑
// ─────────────────────────────────────────────────────────────────────────────

interface MatchResult {
  matched: boolean;
  gtIndex: number;
  errorCategory?: ChapterBoundaryErrorCategory;
}

/**
 * 在 ground-truth headings 中查找与 splitter chapter 匹配的项。
 *
 * 匹配策略（按优先级）：
 * 1. offset 接近（|diff| <= OFFSET_TOLERANCE）→ 匹配
 * 2. heading 文本归一化后相同 → 匹配（标记 offset_mismatch 如果 offset 差异大）
 * 3. 章节编号相同但 heading 不同 → 标记 wrong_chapter_number
 * 4. 无匹配 → spurious_heading
 */
function findGroundTruthMatch(
  splitterOffset: number,
  splitterHeading: string,
  splitterChapterNumber: number,
  groundTruth: GroundTruthHeading[],
  matchedGtIndices: Set<number>,
): MatchResult {
  // 1. offset 接近匹配
  for (let i = 0; i < groundTruth.length; i++) {
    if (matchedGtIndices.has(i)) continue;
    const gt = groundTruth[i];
    if (Math.abs(gt.offset - splitterOffset) <= OFFSET_TOLERANCE) {
      return { matched: true, gtIndex: i };
    }
  }

  // 2. heading 文本归一化匹配
  const splitterHeadingNorm = normalizeHeading(splitterHeading);
  for (let i = 0; i < groundTruth.length; i++) {
    if (matchedGtIndices.has(i)) continue;
    const gt = groundTruth[i];
    if (normalizeHeading(gt.heading) === splitterHeadingNorm) {
      // heading 相同但 offset 差异大 → 仍算匹配但标记 offset_mismatch
      return {
        matched: true,
        gtIndex: i,
        errorCategory:
          Math.abs(gt.offset - splitterOffset) > OFFSET_TOLERANCE
            ? "offset_mismatch"
            : undefined,
      };
    }
  }

  // 3. 章节编号相同但 heading 不同
  for (let i = 0; i < groundTruth.length; i++) {
    if (matchedGtIndices.has(i)) continue;
    const gt = groundTruth[i];
    if (gt.chapterNumber === splitterChapterNumber) {
      return {
        matched: false,
        gtIndex: i,
        errorCategory: "wrong_chapter_number",
      };
    }
  }

  // 4. 无匹配
  return { matched: false, gtIndex: -1, errorCategory: "spurious_heading" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

function normalizeText(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/**
 * 截断 heading 文本，防止正文泄漏。
 *
 * 源语料中 heading 与 body 可能同行（无换行），splitter 的 regex 会捕获整行。
 * annotation 只需 heading 用于识别/展示，截断到 HEADING_MAX_LENGTH 即可。
 */
function truncateHeading(heading: string): string {
  if (heading.length <= HEADING_MAX_LENGTH) return heading;
  return heading.slice(0, HEADING_MAX_LENGTH) + "…";
}

function normalizeHeading(heading: string): string {
  return heading
    .trim()
    .replace(/[ \\t　:：.、-]+/g, " ")
    .toLowerCase();
}

function resolveChapterNumber(raw: string, fallback: number): number {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
  if (raw === "序章" || raw === "楔子" || raw === "前言" || raw === "引子" || raw === "引言" || raw === "序言") {
    return 0;
  }
  if (raw === "终章" || raw === "尾声" || raw === "番外" || raw === "番外篇" || raw === "后记" || raw === "结语") {
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
