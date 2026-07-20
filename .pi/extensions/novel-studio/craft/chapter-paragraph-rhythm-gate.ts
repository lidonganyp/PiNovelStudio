/**
 * PiNovelStudio — 整章段落节奏 Gate（P26 Doubao 适配新增）
 *
 * 职责：
 *   - analyzeChapterParagraphRhythm：按 /\n+/ 切段，统计 over220/over280/over360 计数
 *   - repairLongParagraphsLocal：对 over360 的段，在句末标点（。！？）处分段，
 *     非破坏性（不删内容，只加换行），目标 120-220 字/段
 *   - recheckAfterLocalRepair：修复后重跑 analyze
 *
 * 参照 stage6.5 local_repair → rerun → hard_block 范式。
 *
 * 边界：
 *   - 硬上限 PARAGRAPH_HARD_LIMIT=360（与用户需求一致：禁止 600-800 字单段）
 *   - 软上限 PARAGRAPH_SOFT_LIMIT=280
 *   - 动作/场面软上限 PARAGRAPH_ACTION_SOFT_LIMIT=220
 *   - local_repair 只对 over360 段触发，保留所有文字内容
 */

/** 硬上限：超过此长度的段必须分段或阻断 */
export const PARAGRAPH_HARD_LIMIT = 360;
/** 软上限：超过此长度记录但不阻断 */
export const PARAGRAPH_SOFT_LIMIT = 280;
/** 动作/场面软上限 */
export const PARAGRAPH_ACTION_SOFT_LIMIT = 220;

/** local_repair 目标段落长度 */
const REPAIR_TARGET_LENGTH = 150;
/** local_repair 段落硬上限（确保修复后不再超 360） */
const REPAIR_HARD_CAP = 220;

export interface ChapterParagraphRhythmResult {
  paragraphCount: number;
  averageParagraphLength: number;
  maxParagraphLength: number;
  over220Count: number;
  over280Count: number;
  over360Count: number;
  blockedParagraphIndexes: number[];
  repairSuggestion: string;
  /** over360Count === 0 */
  passed: boolean;
  /** 切分结果，供 repair 用 */
  paragraphs: string[];
}

/**
 * 分析整章段落节奏。
 * 按 /\n+/ 切段，空段跳过。统计各阈值计数与最长段。
 */
export function analyzeChapterParagraphRhythm(text: string): ChapterParagraphRhythmResult {
  const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0);
  const paragraphCount = paragraphs.length;

  let totalLen = 0;
  let maxLen = 0;
  let over220Count = 0;
  let over280Count = 0;
  let over360Count = 0;
  const blockedParagraphIndexes: number[] = [];

  paragraphs.forEach((p, i) => {
    // 用去空白后的字符数计量（中文按字，英文按字符）
    const len = p.replace(/\s/g, "").length;
    totalLen += len;
    if (len > maxLen) maxLen = len;
    if (len > PARAGRAPH_ACTION_SOFT_LIMIT) over220Count++;
    if (len > PARAGRAPH_SOFT_LIMIT) over280Count++;
    if (len > PARAGRAPH_HARD_LIMIT) {
      over360Count++;
      blockedParagraphIndexes.push(i);
    }
  });

  const averageParagraphLength = paragraphCount > 0 ? Math.round(totalLen / paragraphCount) : 0;
  const passed = over360Count === 0;

  return {
    paragraphCount,
    averageParagraphLength,
    maxParagraphLength: maxLen,
    over220Count,
    over280Count,
    over360Count,
    blockedParagraphIndexes,
    repairSuggestion: buildRepairSuggestion(over360Count, over280Count, maxLen),
    passed,
    paragraphs,
  };
}

/**
 * 局部修复：对 over360 的段，在句末标点（。！？）处分段。
 * 非破坏性：保留所有文字内容，只插入换行。目标 120-220 字/段。
 *
 * 算法：
 *   1. 对每个 over360 段，按 /(?<=[。！？])/ 切句
 *   2. 贪心累加句子到当前段，直到加入下一句会超过 REPAIR_TARGET_LENGTH
 *   3. 当前段达到目标长度时换行开新段
 *   4. 确保任何新段不超过 REPAIR_HARD_CAP
 */
export function repairLongParagraphsLocal(
  text: string,
  result?: ChapterParagraphRhythmResult,
): { repairedText: string; repairedCount: number } {
  const analysis = result || analyzeChapterParagraphRhythm(text);
  if (analysis.over360Count === 0) {
    return { repairedText: text, repairedCount: 0 };
  }

  // 按原始 /\n+/ 切段，保留段间分隔
  const originalParagraphs = text.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0);
  const repairedParagraphs: string[] = [];
  let repairedCount = 0;

  for (const para of originalParagraphs) {
    const len = para.replace(/\s/g, "").length;
    if (len <= PARAGRAPH_HARD_LIMIT) {
      repairedParagraphs.push(para);
      continue;
    }
    // over360：按句末标点切句
    const sentences = para.split(/(?<=[。！？])/).filter(s => s.trim().length > 0);
    if (sentences.length <= 1) {
      // 无法切句（极端情况），保留原段
      repairedParagraphs.push(para);
      continue;
    }
    const regrouped = regroupSentences(sentences);
    repairedParagraphs.push(...regrouped);
    repairedCount++;
  }

  const repairedText = repairedParagraphs.join("\n");
  return { repairedText, repairedCount };
}

/**
 * 复检：修复后重跑 analyze。
 */
export function recheckAfterLocalRepair(text: string): ChapterParagraphRhythmResult {
  return analyzeChapterParagraphRhythm(text);
}

/**
 * 贪心重组句子为目标长度的段落。
 * 累加句子直到当前段达到 REPAIR_TARGET_LENGTH，且不超过 REPAIR_HARD_CAP。
 */
function regroupSentences(sentences: string[]): string[] {
  const result: string[] = [];
  let current = "";
  let currentLen = 0;

  for (const sentence of sentences) {
    const sentenceLen = sentence.replace(/\s/g, "").length;
    if (sentenceLen === 0) continue;

    // 若当前段为空，直接加入
    if (currentLen === 0) {
      current = sentence;
      currentLen = sentenceLen;
      continue;
    }

    // 若加入此句不超 REPAIR_HARD_CAP，且当前段未达 REPAIR_TARGET_LENGTH，累加
    if (currentLen + sentenceLen <= REPAIR_HARD_CAP && currentLen < REPAIR_TARGET_LENGTH) {
      current += sentence;
      currentLen += sentenceLen;
    } else {
      // 当前段已达目标或加入会超 cap，收尾开新段
      result.push(current.trim());
      current = sentence;
      currentLen = sentenceLen;
    }
  }

  if (current.trim().length > 0) {
    result.push(current.trim());
  }

  return result;
}

function buildRepairSuggestion(over360Count: number, over280Count: number, maxLen: number): string {
  if (over360Count > 0) {
    return `段落节奏硬门禁失败：${over360Count} 段超 ${PARAGRAPH_HARD_LIMIT} 字（最长 ${maxLen} 字）。已在句末标点处自动分段；若仍失败需回到 Stage 2 检查事件级段落契约或手动分段。`;
  }
  if (over280Count > 0) {
    return `段落节奏软警告：${over280Count} 段超 ${PARAGRAPH_SOFT_LIMIT} 字（最长 ${maxLen} 字）。建议检查是否合并了短段。`;
  }
  return "段落节奏正常";
}
