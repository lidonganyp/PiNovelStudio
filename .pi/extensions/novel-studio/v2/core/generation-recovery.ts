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
 * FactGuard reports the first occurrence span. The second occurrence is
 * located byte-for-byte and removed through its next sentence boundary. If
 * an exact second occurrence cannot be found, the text is left untouched.
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
  const segments = splitExactSegments(text);
  const removals: DuplicateRepair[] = [];
  for (let later = segments.length - 1; later >= 1; later -= 1) {
    const laterSegment = segments[later];
    if (!laterSegment || laterSegment.bodyStart < protectedLength) continue;
    const comparable = laterSegment.body.trim().replace(/\s+/gu, " ");
    if (comparable.length < minimumLength) continue;
    const earlier = segments.find((segment, index) =>
      index < later
      && segment.body.trim().replace(/\s+/gu, " ") === comparable
    );
    if (!earlier) continue;
    removals.push({
      start: laterSegment.bodyStart,
      end: laterSegment.end,
      excerpt: text.slice(laterSegment.bodyStart, laterSegment.end),
    });
  }
  if (removals.length === 0) {
    return { text, changed: false, removed: [] };
  }

  let repaired = text;
  const removed: DuplicateRepair[] = [];
  for (const removal of removals.sort((left, right) => right.start - left.start)) {
    repaired = `${repaired.slice(0, removal.start)}${repaired.slice(removal.end)}`;
    removed.push(removal);
  }

  return { text: repaired, changed: removed.length > 0, removed };
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
