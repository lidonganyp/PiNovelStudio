/**
 * PiNovelStudio — Repeated Sentence Cleaner
 *
 * 从 anti-ai-detector.ts 提取的纯函数模块（refactor，行为零变化）。
 * 精确重复句检测与清理：归一化后逐句去重，保留首次出现，移除后续完全重复句。
 *
 * 提取原因：这组函数（removeExactRepeatedSentences 及其内部 helpers）是
 * 自包含的纯函数簇，唯一跨模块依赖是 RepeatableSentenceSpan 类型
 * （anti-ai-detector.ts 的 collectNonDialogueSentenceSpans 也使用该类型），
 * 通过 export + import 回引即可保持类型一致。
 */

export interface RepeatableSentenceSpan {
  raw: string;
  normalized: string;
  start: number;
  end: number;
}

export interface ExactRepeatedSentenceCleanupResult {
  text: string;
  removedCount: number;
  positions: number[];
}

const MIN_REPEAT_SENTENCE_LENGTH = 8;

function normalizeRepeatableSentence(sentence: string): string {
  const normalized = sentence.replace(/\s+/g, "").trim();
  const content = normalized.replace(/[。！？]+$/g, "");

  if (content.length < MIN_REPEAT_SENTENCE_LENGTH) {
    return "";
  }

  if (/^(第[一二三四五六七八九十百千万\d]+章|#+|【[^】]+】)$/.test(content)) {
    return "";
  }

  return normalized;
}

function collectRepeatableSentenceSpans(text: string): RepeatableSentenceSpan[] {
  const spans: RepeatableSentenceSpan[] = [];
  const sentenceRegex = /[^。！？\n]+[。！？]?/g;
  let match: RegExpExecArray | null;

  while ((match = sentenceRegex.exec(text)) !== null) {
    const raw = match[0];
    const normalized = normalizeRepeatableSentence(raw);

    if (normalized.length === 0) {
      continue;
    }

    spans.push({
      raw,
      normalized,
      start: match.index,
      end: match.index + raw.length,
    });
  }

  return spans;
}

export function collectExactRepeatedSentencePositions(text: string): number[] {
  const seen = new Set<string>();
  const positions: number[] = [];

  for (const span of collectRepeatableSentenceSpans(text)) {
    if (seen.has(span.normalized)) {
      positions.push(span.start);
      continue;
    }
    seen.add(span.normalized);
  }

  return positions;
}

export function removeExactRepeatedSentences(text: string): ExactRepeatedSentenceCleanupResult {
  const seen = new Set<string>();
  const removals: Array<{ start: number; end: number }> = [];

  for (const span of collectRepeatableSentenceSpans(text)) {
    if (seen.has(span.normalized)) {
      removals.push({ start: span.start, end: span.end });
      continue;
    }
    seen.add(span.normalized);
  }

  if (removals.length === 0) {
    return { text, removedCount: 0, positions: [] };
  }

  let cleaned = "";
  let cursor = 0;
  for (const removal of removals) {
    cleaned += text.slice(cursor, removal.start);
    cursor = removal.end;
  }
  cleaned += text.slice(cursor);

  cleaned = cleaned
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  return {
    text: cleaned,
    removedCount: removals.length,
    positions: removals.map((removal) => removal.start),
  };
}
