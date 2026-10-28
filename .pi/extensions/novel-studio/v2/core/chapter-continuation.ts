/** Pure helpers for preserving an author-authored chapter prefix. */

export type ContinuationMode = "replace" | "append";

function normalizeContinuationText(text: string): string {
  // Providers may normalize line endings differently from the persisted
  // chapter. Compare semantic text, not CRLF vs LF serialization noise.
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}

/**
 * Detect a style response that contains the complete source chapter followed
 * by another substantial chapter rewrite. This is different from an exact
 * adjacent paragraph duplicate: the second copy is usually paraphrased, so
 * FactGuard's byte-level duplicate scanner cannot identify it reliably.
 *
 * A style candidate is allowed to grow modestly, but it must not prepend the
 * entire source and then append another near-chapter-sized payload. The
 * conservative ratio/size thresholds avoid treating ordinary sentence-level
 * expansion as a duplicate while catching the observed source+rewrite shape.
 */
export function hasCompleteChapterEcho(
  source: string,
  generated: string,
  minimumLengthRatio = 1.5,
  minimumExtraLength = 800,
): boolean {
  const normalizedSource = normalizeContinuationText(source);
  const normalizedGenerated = normalizeContinuationText(generated);
  if (!normalizedSource || !normalizedGenerated) return false;
  if (!normalizedGenerated.startsWith(normalizedSource)) return false;
  const extraLength = normalizedGenerated.length - normalizedSource.length;
  if (extraLength < minimumExtraLength) return false;
  return normalizedGenerated.length >= normalizedSource.length * minimumLengthRatio;
}

/**
 * Detect a model response that appears to be a rewritten complete prefix.
 * A suffix-only response is valid; an exact complete chapter is also valid.
 * When the first line substantially overlaps the author prefix but is not
 * byte-identical, callers must retry instead of silently prepending the old
 * prefix and creating two versions of the chapter opening.
 */
export function hasContinuationPrefixMismatch(existing: string, generated: string): boolean {
  const prefix = normalizeContinuationText(existing);
  const result = normalizeContinuationText(generated);
  if (!prefix || !result) return false;
  if (result.startsWith(prefix)) return false;
  // A complete prefix may only appear at byte zero. A leading label or an
  // echoed prefix must be retried instead of being silently sliced/merged.
  if (result.indexOf(prefix) > 0) return true;

  const prefixFirstLine = prefix.split(/\r?\n/, 1)[0] ?? "";
  const resultFirstLine = result.split(/\r?\n/, 1)[0] ?? "";
  if (prefixFirstLine.length < 12 || resultFirstLine.length < 8) return false;
  let common = 0;
  const limit = Math.min(prefixFirstLine.length, resultFirstLine.length);
  while (common < limit && prefixFirstLine[common] === resultFirstLine[common]) common += 1;
  const required = Math.max(8, Math.floor(prefixFirstLine.length * 0.55));
  if (common >= required) return true;

  // Common-prefix checks miss a one-character mutation at the opening. Use a
  // bounded edit-distance comparison only when both lines are chapter-like
  // in length; unrelated suffix prose should remain valid.
  const comparableLength = Math.max(prefixFirstLine.length, resultFirstLine.length);
  if (resultFirstLine.length < Math.floor(prefixFirstLine.length * 0.8)) return false;
  const distanceLimit = Math.floor(comparableLength * 0.2);
  const distance = boundedEditDistance(prefixFirstLine, resultFirstLine, distanceLimit);
  return distance <= distanceLimit;
}

function boundedEditDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const value = Math.min(
        (previous[rightIndex] ?? limit + 1) + 1,
        (current[rightIndex - 1] ?? limit + 1) + 1,
        (previous[rightIndex - 1] ?? limit + 1) + substitutionCost,
      );
      current[rightIndex] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length] ?? limit + 1;
}

/**
 * Models may return a complete chapter or only the newly written suffix.
 * In append mode the existing draft is authoritative and is never discarded.
 */
export function mergeChapterContinuation(existing: string, generated: string): string {
  const prefix = existing.replace(/^\uFEFF/, "").trimEnd();
  const result = generated.replace(/^\uFEFF/, "").trim();
  if (!prefix) return result;
  if (!result) return prefix;

  const comparablePrefix = normalizeContinuationText(prefix);
  const comparableResult = normalizeContinuationText(result);
  if (comparableResult.startsWith(comparablePrefix)) {
    // Compare normalized transport text, but always retain the author's bytes.
    // Otherwise LF/CRLF differences silently prepend a second complete prefix.
    return prefix + comparableResult.slice(comparablePrefix.length);
  }
  const embeddedPrefix = result.indexOf(prefix);
  if (embeddedPrefix >= 0 && embeddedPrefix < 80) {
    return result.slice(embeddedPrefix).trim();
  }
  return `${prefix}\n\n${result}`;
}

/**
 * Remove only an immediately repeated long paragraph from generated prose.
 *
 * The author-authored prefix is protected byte-for-byte. Non-adjacent or
 * short repetitions are intentionally left untouched for FactGuard to reject
 * or for the author to review; this helper is a minimal recovery, not a prose
 * deduplicator. In append mode, an exact sentence/line echoed from the
 * protected prefix is also removed from the generated suffix. This handles
 * the common case where an editorial pass repeats a resource/action sentence
 * from the existing chapter before continuing with new prose.
 */
export function repairAdjacentDuplicateParagraphs(
  text: string,
  protectedPrefix = "",
  minParagraphLength = 24,
): string {
  if (!text || minParagraphLength <= 0) return text;

  const normalizedProtectedPrefix = protectedPrefix.replace(/^\uFEFF/, "").trimEnd();
  const prefixLength = normalizedProtectedPrefix && text.startsWith(normalizedProtectedPrefix)
    ? normalizedProtectedPrefix.length
    : 0;
  const prefix = text.slice(0, prefixLength);
  let suffix = text.slice(prefixLength);
  if (!suffix) return text;

  // Models often repeat the last sentence of the author prefix as a bridge
  // before continuing. Preserve the prefix, but remove that exact repeated
  // sentence from the generated side. This is deliberately byte-exact after
  // whitespace normalization; fuzzy overlap would risk deleting new prose.
  const suffixBody = suffix.trimStart();
  const leadingWhitespace = suffix.slice(0, suffix.length - suffixBody.length);
  const boundaryOverlap = findPrefixBoundaryOverlapExact(
    prefix,
    suffixBody,
    // A complete Chinese sentence can be shorter than the duplicate scanner's
    // 24-character window; at a hard sentence boundary, eight normalized
    // characters are enough to avoid deleting a tiny connective word.
    Math.min(minParagraphLength, 8),
  );
  const boundaryRepaired = boundaryOverlap > 0;
  if (boundaryRepaired) {
    suffix = `${leadingWhitespace}${suffixBody.slice(boundaryOverlap)}`;
    // Keep the boundary repair observable even when the remaining suffix is
    // a single segment; the author prefix itself is never changed.
    if (!suffix.trim()) return prefix;
  }

  const segments = splitContinuationSegments(suffix);
  const protectedSegments = new Set(
    splitContinuationSegments(prefix)
      .map((segment) => comparableSegments([segment]))
      .filter((segment) => segment.length >= minParagraphLength),
  );

  // Remove only an immediately repeated run of exact sentence/paragraph
  // segments. A run of up to four segments catches model echo without using
  // fuzzy matching that could silently alter legitimate prose.
  const repaired = [...segments];
  let changed = false;
  if (protectedSegments.size > 0) {
    for (let index = repaired.length - 1; index >= 0; index -= 1) {
      const comparable = comparableSegments([repaired[index] ?? ""]);
      if (!protectedSegments.has(comparable)) continue;
      repaired.splice(index, 1);
      changed = true;
    }
  }

  if (repaired.length < 2) {
    if (!changed && !boundaryRepaired) return text;
    return `${prefix}${repaired.join("")}`;
  }

  let index = 0;
  while (index < repaired.length - 1) {
    let removed = false;
    const maxRun = Math.min(4, Math.floor((repaired.length - index) / 2));
    for (let run = maxRun; run >= 1; run -= 1) {
      const left = repaired.slice(index, index + run);
      const right = repaired.slice(index + run, index + run * 2);
      const leftComparable = comparableSegments(left);
      const rightComparable = comparableSegments(right);
      if (
        leftComparable.length >= minParagraphLength
        && leftComparable === rightComparable
      ) {
        const removedSegments = repaired.splice(index + run, run);
        const trailingWhitespace = removedSegments.at(-1)?.match(/\s+$/)?.[0] ?? "";
        const leftEnd = index + run - 1;
        if (trailingWhitespace && repaired[leftEnd]) {
          repaired[leftEnd] = repaired[leftEnd].replace(/\s+$/u, "") + trailingWhitespace;
        }
        changed = true;
        removed = true;
        break;
      }
    }
    if (!removed) index += 1;
  }

  return changed || boundaryRepaired ? `${prefix}${repaired.join("")}` : text;
}

function splitContinuationSegments(text: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const isSentenceEnd = "。！？!?；;".includes(char);
    const isLineEnd = char === "\n" || char === "\r";
    if (!isSentenceEnd && !isLineEnd) continue;

    let end = index + 1;
    while (end < text.length && /\s/.test(text[end] ?? "")) end += 1;
    segments.push(text.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < text.length) segments.push(text.slice(start));
  return segments;
}

function comparableSegments(segments: string[]): string {
  return segments.join("").trim().replace(/\s+/g, " ");
}

function findPrefixBoundaryOverlap(
  prefix: string,
  suffix: string,
  minParagraphLength: number,
): number {
  if (!prefix || !suffix) return 0;
  const maxLength = Math.min(prefix.length, suffix.length, 1200);
  for (let length = maxLength; length >= minParagraphLength; length -= 1) {
    const overlap = prefix.slice(prefix.length - length);
    if (overlap !== suffix.slice(0, length)) continue;
    const lastChar = overlap.at(-1) ?? "";
    if ("。！？!?；;.!\n\r".includes(lastChar)) {
      return length;
    }
  }
  return 0;
}

function findPrefixBoundaryOverlapExact(
  prefix: string,
  suffix: string,
  minParagraphLength: number,
): number {
  if (!prefix || !suffix) return 0;
  const startFloor = Math.max(0, prefix.length - Math.min(suffix.length, 1200));
  for (let start = prefix.length - minParagraphLength; start >= startFloor; start -= 1) {
    const overlap = prefix.slice(start);
    if (overlap.length < minParagraphLength || overlap !== suffix.slice(0, overlap.length)) continue;
    const preceding = prefix[start - 1] ?? "";
    if (start === 0 || /[。！？!?；;.!\n\r]/u.test(preceding)) return overlap.length;
  }
  return 0;
}
