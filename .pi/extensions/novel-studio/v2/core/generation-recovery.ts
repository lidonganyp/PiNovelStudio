/**
 * Small, deterministic recovery helpers for chapter generation.
 *
 * The model and the orchestrator own generation policy. This module only
 * measures a draft, applies a conservative duplicate repair, and preserves
 * the best readable text when a later gate fails.
 */

export interface TargetWordRange {
  min: number;
  max: number;
}

export interface TargetLengthAssessment {
  contentCharacters: number;
  minimum: number;
  maximum: number;
  remaining: number;
  needsContinuation: boolean;
  withinRange: boolean;
  overMaximum: boolean;
}

export interface DuplicateFindingLike {
  source?: string;
  id?: string;
  evidence?: string;
  span?: { start: number; end: number };
}

export interface DuplicateRepair {
  start: number;
  end: number;
  excerpt: string;
}

export interface DuplicateRepairResult {
  text: string;
  changed: boolean;
  removed: DuplicateRepair[];
}

export interface RecoverableDraftCandidate {
  source: string;
  text: string;
  verified?: boolean;
}

export interface RecoverableDraft {
  state: "ready" | "needs_review" | "empty";
  text: string;
  source: string | null;
}

/** Resolve a per-request target before falling back to the workspace default. */
export function resolveTargetWordRange(
  requested: TargetWordRange | undefined,
  configured: TargetWordRange | undefined,
): TargetWordRange | undefined {
  return requested ?? configured;
}

/** Count non-whitespace characters, matching the persisted chapter word count. */
export function countContentCharacters(text: string): number {
  return text.replace(/\s+/gu, "").length;
}

/** Determine whether a draft needs a continuation call to reach its lower bound. */
export function assessTargetLength(
  text: string,
  target: TargetWordRange,
): TargetLengthAssessment {
  const minimum = normalizeBound(target.min, 0);
  const requestedMaximum = normalizeBound(target.max, minimum);
  const maximum = Math.max(minimum, requestedMaximum);
  const contentCharacters = countContentCharacters(text);
  const remaining = Math.max(0, minimum - contentCharacters);
  return {
    contentCharacters,
    minimum,
    maximum,
    remaining,
    needsContinuation: contentCharacters < minimum,
    withinRange: contentCharacters >= minimum && contentCharacters <= maximum,
    overMaximum: contentCharacters > maximum,
  };
}

/**
 * Remove only the later occurrence of deterministic duplicate findings.
 *
 * FactGuard reports the first occurrence span. Locate the later occurrence
 * using the same byte-exact sliding-window semantics as the guard, then remove
 * the later duplicate window cluster through sentence boundaries. A duplicate
 * window may cross a paragraph boundary, so comparing complete paragraphs is
 * insufficient here.
 */
export function repairDuplicateFindings(
  text: string,
  findings: readonly DuplicateFindingLike[],
  protectedPrefix = "",
): DuplicateRepairResult {
  if (!text || findings.length === 0) {
    return { text, changed: false, removed: [] };
  }

  const duplicateFindings = findings
    .filter(isDuplicateFinding)
    .filter((finding) => isValidSpan(finding.span))
    .sort((left, right) => (right.span!.start - left.span!.start));
  if (duplicateFindings.length === 0) {
    return { text, changed: false, removed: [] };
  }

  const protectedLength = protectedPrefix.trim().length > 0 && text.startsWith(protectedPrefix)
    ? protectedPrefix.length
    : 0;
  const minimumLength = Math.max(
    8,
    Math.min(24, ...duplicateFindings.map((finding) => finding.span!.end - finding.span!.start)),
  );
  const duplicateWindows = collectDuplicateWindows(text, minimumLength);
  const targetLaterStarts = duplicateFindings
    .map((finding) => {
      const span = finding.span!;
      const chunk = text.slice(span.start, span.end);
      if (chunk.length < minimumLength) return -1;
      return text.indexOf(chunk, span.end);
    })
    .filter((start): start is number => start >= protectedLength);
  if (targetLaterStarts.length === 0) {
    return { text, changed: false, removed: [] };
  }

  // Keep only duplicate windows connected to a reported later occurrence.
  // This prevents a legitimate repeated phrase elsewhere in the chapter from
  // being edited while still extending through an unreported tail (the guard
  // caps diagnostics at five regions).
  const clusterGap = Math.max(64, minimumLength * 4);
  // A capped diagnostic list can leave a later duplicate block just beyond
  // the normal window cluster. Link nearby blocks for recovery, but keep the
  // tighter clusterGap below so unique text between them remains untouched.
  const connectionGap = Math.max(128, minimumLength * 5);
  const relevantLaterStarts = new Set(targetLaterStarts);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const window of duplicateWindows) {
      if (window.start < protectedLength || relevantLaterStarts.has(window.start)) continue;
      if ([...relevantLaterStarts].some((target) => Math.abs(window.start - target) <= connectionGap)) {
        relevantLaterStarts.add(window.start);
        expanded = true;
      }
    }
  }
  const laterStarts = [...relevantLaterStarts].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const start of laterStarts) {
    const cluster = clusters.at(-1);
    if (!cluster || start - cluster.at(-1)! > clusterGap) {
      clusters.push([start]);
    } else {
      cluster.push(start);
    }
  }

  const segments = splitExactSegments(text);
  const removals: DuplicateRepair[] = [];
  for (const cluster of clusters) {
    const firstLater = cluster[0];
    const lastLater = cluster.at(-1)!;
    const firstSegment = segments.find((segment) =>
      segment.start <= firstLater && firstLater < segment.end
    );
    const lastSegment = segments.find((segment) =>
      segment.start <= lastLater && lastLater < segment.end
    );
    if (!firstSegment || !lastSegment) continue;
    const start = Math.max(protectedLength, firstSegment.bodyStart);
    // The separator before the duplicate remains in the retained text. When
    // present, consume the separator after it as well so both sides do not
    // combine into an extra blank paragraph (or a trailing newline).
    const hasLeadingWhitespace = /\s/u.test(text.slice(firstSegment.start, start));
    const end = hasLeadingWhitespace
      ? consumeTrailingWhitespace(text, lastSegment.end)
      : lastSegment.end;
    const removalStart = end >= text.length && hasLeadingWhitespace
      ? Math.max(protectedLength, firstSegment.start)
      : start;
    if (end <= removalStart) continue;
    removals.push({
      start: removalStart,
      end,
      excerpt: text.slice(removalStart, end),
    });
  }

  // Merge overlapping clusters before applying edits so offsets remain those
  // of the original text and a suffix is never removed twice.
  removals.sort((left, right) => left.start - right.start);
  const mergedRemovals: DuplicateRepair[] = [];
  for (const removal of removals) {
    const previous = mergedRemovals.at(-1);
    if (previous && removal.start <= previous.end) {
      previous.end = Math.max(previous.end, removal.end);
      previous.excerpt = text.slice(previous.start, previous.end);
    } else {
      mergedRemovals.push({ ...removal });
    }
  }
  if (mergedRemovals.length === 0) {
    return { text, changed: false, removed: [] };
  }

  let repaired = text;
  const removed: DuplicateRepair[] = [];
  for (const removal of mergedRemovals.sort((left, right) => right.start - left.start)) {
    repaired = `${repaired.slice(0, removal.start)}${repaired.slice(removal.end)}`;
    removed.push(removal);
  }

  return { text: repaired, changed: removed.length > 0, removed };
}

interface DuplicateWindow {
  start: number;
}

/** Mirror FactGuard's exact sliding-window duplicate scan for recovery. */
function collectDuplicateWindows(text: string, minLen: number): DuplicateWindow[] {
  if (text.length < minLen * 2) return [];
  const seen = new Map<string, number[]>();
  for (let start = 0; start + minLen <= text.length; start += 1) {
    const chunk = text.slice(start, start + minLen);
    if (chunk.trim().length < minLen * 0.5) continue;
    const starts = seen.get(chunk);
    if (starts) starts.push(start);
    else seen.set(chunk, [start]);
  }
  const windows: DuplicateWindow[] = [];
  for (const [chunk, starts] of seen) {
    if (starts.length < 2) continue;
    for (const start of starts.slice(1)) {
      windows.push({ start });
    }
  }
  return windows;
}

function consumeTrailingWhitespace(text: string, end: number): number {
  let cursor = end;
  while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

/** Preserve the first non-empty candidate instead of returning an empty error. */
export function selectRecoverableDraft(
  candidates: readonly RecoverableDraftCandidate[],
): RecoverableDraft {
  const selected = candidates.find((candidate) => candidate.text.trim().length > 0);
  if (!selected) {
    return { state: "empty", text: "", source: null };
  }
  return {
    state: selected.verified ? "ready" : "needs_review",
    text: selected.text,
    source: selected.source,
  };
}

function normalizeBound(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function isDuplicateFinding(finding: DuplicateFindingLike): boolean {
  const source = `${finding.source ?? ""} ${finding.id ?? ""} ${finding.evidence ?? ""}`;
  return /duplicate_scan|澶ф閲嶅|duplicate/i.test(source);
}

function isValidSpan(span: DuplicateFindingLike["span"]): span is { start: number; end: number } {
  return Boolean(
    span
      && Number.isInteger(span.start)
      && Number.isInteger(span.end)
      && span.start >= 0
      && span.end > span.start,
  );
}

function splitExactSegments(text: string): Array<{
  start: number;
  bodyStart: number;
  end: number;
  body: string;
}> {
  const segments: Array<{ start: number; bodyStart: number; end: number; body: string }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!/[。！？!?；;]/u.test(text[index] ?? "")) continue;
    const end = index + 1;
    const raw = text.slice(start, end);
    const leadingLength = raw.match(/^\s*/u)?.[0].length ?? 0;
    segments.push({
      start,
      bodyStart: start + leadingLength,
      end,
      body: raw.slice(leadingLength),
    });
    start = end;
  }
  if (start < text.length) {
    const raw = text.slice(start);
    const leadingLength = raw.match(/^\s*/u)?.[0].length ?? 0;
    segments.push({
      start,
      bodyStart: start + leadingLength,
      end: text.length,
      body: raw.slice(leadingLength),
    });
  }
  return segments;
}
