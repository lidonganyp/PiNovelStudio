/**
 * 章节编号解析：统一支持阿拉伯数字和中文数字，供目录、规划和预检复用。
 */

const CHINESE_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function parseChapterNumber(raw: string): number | null {
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const number = Number.parseInt(value, 10);
    return number >= 1 ? number : null;
  }
  if (!value || value === '零' || value === '〇') return null;
  if (value === '十') return 10;
  if (value.startsWith('十')) {
    const ones = digitValue(value.slice(1));
    return ones === null ? null : 10 + ones;
  }
  if (value.endsWith('十')) {
    const tens = digitValue(value.slice(0, -1));
    return tens === null ? null : tens * 10;
  }
  const split = value.indexOf('十');
  if (split > 0 && split < value.length - 1) {
    const tens = digitValue(value.slice(0, split));
    const ones = digitValue(value.slice(split + 1));
    return tens === null || ones === null ? null : tens * 10 + ones;
  }
  return digitValue(value);
}

export function chapterNumberFromTitle(text: string): number | null {
  const match = text.match(/第\s*(\d{1,3}|[零〇一二三四五六七八九十]+)\s*章/);
  return match ? parseChapterNumber(match[1]) : null;
}

export function chapterTitleMatches(text: string, chapterNumber: number): boolean {
  return chapterNumberFromTitle(text) === chapterNumber;
}

function digitValue(value: string): number | null {
  if (value.length !== 1) return null;
  const index = CHINESE_DIGITS.indexOf(value);
  return index > 0 ? index : null;
}
