/**
 * UserRevisionDelta - 系统选定稿到用户最终稿的可追溯差异证据。
 *
 * 只生成 append-only 证据与 proposal，不自动修改 Constitution 或策略状态。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type RevisionQualityDimension =
  | "native_chinese"
  | "character_credibility"
  | "goal_obstacle_choice_result"
  | "emotional_progression"
  | "information_release"
  | "scene_immersion"
  | "causal_end_pressure"
  | "world_continuity"
  | "anti_template_ai_trace"
  | "worth_replacing_raw"
  | "unclassified";

export interface RevisionSpanAnnotation {
  spanIndex: number;
  reason: string;
  qualityDimension: RevisionQualityDimension;
  generalizable: boolean;
}

export interface UserRevisionDeltaInput {
  workspaceId: string;
  chapterId: string;
  selectedCandidateId: string;
  systemSelectedText: string;
  userFinalText: string;
  annotations?: RevisionSpanAnnotation[];
  capturedAt?: string;
}

export interface RevisionTextSpan {
  start: number;
  end: number;
  text: string;
}

export interface UserModifiedSpan {
  spanIndex: number;
  before: RevisionTextSpan;
  after: RevisionTextSpan;
  reason: string;
  qualityDimension: RevisionQualityDimension;
  generalizable: boolean;
}

export interface UserRevisionDeltaArtifact {
  schemaId: "pinovel.user-revision-delta";
  schemaVersion: 1;
  workspaceId: string;
  chapterId: string;
  selectedCandidateId: string;
  systemSelectedText: string;
  userFinalText: string;
  systemSelectedHash: string;
  userFinalHash: string;
  modifiedSpans: UserModifiedSpan[];
  capturedAt: string;
}

export interface RevisionPatternProposal {
  proposalId: string;
  status: "proposal_only";
  target: "constitution_or_strategy_review";
  reason: string;
  qualityDimension: Exclude<RevisionQualityDimension, "unclassified">;
  chapterIds: string[];
  occurrenceCount: number;
}

interface TokenSpan {
  text: string;
  start: number;
  end: number;
}

interface RawDiffSpan {
  before: RevisionTextSpan;
  after: RevisionTextSpan;
}

export function captureUserRevisionDelta(input: UserRevisionDeltaInput): UserRevisionDeltaArtifact {
  assertRevisionInput(input);
  const rawSpans = diffText(input.systemSelectedText, input.userFinalText);
  const annotationByIndex = new Map<number, RevisionSpanAnnotation>();
  for (const annotation of input.annotations ?? []) {
    if (!Number.isInteger(annotation.spanIndex) || annotation.spanIndex < 0 || annotation.spanIndex >= rawSpans.length) {
      throw new Error(`revision annotation spanIndex 越界: ${annotation.spanIndex}`);
    }
    if (!annotation.reason.trim()) {
      throw new Error(`revision annotation reason 不能为空: ${annotation.spanIndex}`);
    }
    annotationByIndex.set(annotation.spanIndex, annotation);
  }
  const modifiedSpans = rawSpans.map((span, spanIndex): UserModifiedSpan => {
    const annotation = annotationByIndex.get(spanIndex);
    return {
      spanIndex,
      before: span.before,
      after: span.after,
      reason: annotation?.reason.trim() ?? "unclassified",
      qualityDimension: annotation?.qualityDimension ?? "unclassified",
      generalizable: annotation?.generalizable ?? false,
    };
  });
  return {
    schemaId: "pinovel.user-revision-delta",
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    selectedCandidateId: input.selectedCandidateId,
    systemSelectedText: input.systemSelectedText,
    userFinalText: input.userFinalText,
    systemSelectedHash: sha256(input.systemSelectedText),
    userFinalHash: sha256(input.userFinalText),
    modifiedSpans,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
}

export function saveUserRevisionDelta(
  workspacePath: string,
  artifact: UserRevisionDeltaArtifact,
): string {
  validateArtifact(artifact);
  const filePath = join(
    workspacePath,
    "revision-deltas",
    `${sanitizeFilePart(artifact.chapterId)}-${artifact.userFinalHash.slice(0, 12)}.json`,
  );
  mkdirSync(dirname(filePath), { recursive: true });
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8");
    if (existing !== serialized) {
      throw new Error(`revision delta hash collision: ${filePath}`);
    }
    return filePath;
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, serialized, "utf8");
  renameSync(tmpPath, filePath);
  return filePath;
}

export function loadUserRevisionDelta(filePath: string): UserRevisionDeltaArtifact {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as UserRevisionDeltaArtifact;
  validateArtifact(parsed);
  return parsed;
}

export function buildRevisionPatternProposals(
  artifacts: UserRevisionDeltaArtifact[],
): RevisionPatternProposal[] {
  const groups = new Map<string, {
    reason: string;
    qualityDimension: Exclude<RevisionQualityDimension, "unclassified">;
    chapterIds: Set<string>;
    occurrenceCount: number;
  }>();
  for (const artifact of artifacts) {
    validateArtifact(artifact);
    for (const span of artifact.modifiedSpans) {
      if (!span.generalizable || span.qualityDimension === "unclassified" || span.reason === "unclassified") {
        continue;
      }
      const reason = normalizeReason(span.reason);
      const key = `${span.qualityDimension}:${reason}`;
      const current = groups.get(key) ?? {
        reason: span.reason,
        qualityDimension: span.qualityDimension,
        chapterIds: new Set<string>(),
        occurrenceCount: 0,
      };
      current.chapterIds.add(artifact.chapterId);
      current.occurrenceCount += 1;
      groups.set(key, current);
    }
  }
  return Array.from(groups.entries())
    .filter(([, group]) => group.chapterIds.size >= 2)
    .map(([key, group]) => ({
      proposalId: `revision-pattern:${sha256(key).slice(0, 16)}`,
      status: "proposal_only" as const,
      target: "constitution_or_strategy_review" as const,
      reason: group.reason,
      qualityDimension: group.qualityDimension,
      chapterIds: Array.from(group.chapterIds).sort(),
      occurrenceCount: group.occurrenceCount,
    }))
    .sort((a, b) => a.proposalId.localeCompare(b.proposalId));
}

function diffText(beforeText: string, afterText: string): RawDiffSpan[] {
  if (beforeText === afterText) return [];
  const beforeTokens = tokenize(beforeText);
  const afterTokens = tokenize(afterText);
  const lcs = buildLcsMatrix(beforeTokens, afterTokens);
  const spans: RawDiffSpan[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  let blockBeforeStart: number | null = null;
  let blockBeforeEnd = 0;
  let blockAfterStart: number | null = null;
  let blockAfterEnd = 0;

  const flush = (): void => {
    if (blockBeforeStart === null && blockAfterStart === null) return;
    const rawBeforeStart = blockBeforeStart ?? blockBeforeEnd;
    const rawAfterStart = blockAfterStart ?? blockAfterEnd;
    spans.push(refineDiffSpan(
      beforeText,
      afterText,
      rawBeforeStart,
      blockBeforeEnd,
      rawAfterStart,
      blockAfterEnd,
    ));
    blockBeforeStart = null;
    blockAfterStart = null;
  };

  while (beforeIndex < beforeTokens.length || afterIndex < afterTokens.length) {
    const beforeToken = beforeTokens[beforeIndex];
    const afterToken = afterTokens[afterIndex];
    if (beforeToken && afterToken && beforeToken.text === afterToken.text) {
      flush();
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }
    const deleteScore = beforeIndex < beforeTokens.length ? lcs[beforeIndex + 1][afterIndex] : -1;
    const insertScore = afterIndex < afterTokens.length ? lcs[beforeIndex][afterIndex + 1] : -1;
    if (beforeIndex < beforeTokens.length && (afterIndex >= afterTokens.length || deleteScore >= insertScore)) {
      if (blockBeforeStart === null) blockBeforeStart = beforeToken.start;
      blockBeforeEnd = beforeToken.end;
      if (blockAfterStart === null) {
        blockAfterStart = afterToken?.start ?? afterText.length;
        blockAfterEnd = blockAfterStart;
      }
      beforeIndex += 1;
    } else if (afterToken) {
      if (blockAfterStart === null) blockAfterStart = afterToken.start;
      blockAfterEnd = afterToken.end;
      if (blockBeforeStart === null) {
        blockBeforeStart = beforeToken?.start ?? beforeText.length;
        blockBeforeEnd = blockBeforeStart;
      }
      afterIndex += 1;
    }
  }
  flush();
  return spans.filter((span) => span.before.text !== span.after.text);
}

function tokenize(text: string): TokenSpan[] {
  const tokens: TokenSpan[] = [];
  const pattern = /[^。！？!?\r\n]+[。！？!?]?|\r?\n+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function buildLcsMatrix(before: TokenSpan[], after: TokenSpan[]): number[][] {
  const matrix = Array.from(
    { length: before.length + 1 },
    () => Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      matrix[i][j] = before[i].text === after[j].text
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  return matrix;
}

function refineDiffSpan(
  beforeText: string,
  afterText: string,
  beforeStart: number,
  beforeEnd: number,
  afterStart: number,
  afterEnd: number,
): RawDiffSpan {
  let beforeSlice = beforeText.slice(beforeStart, beforeEnd);
  let afterSlice = afterText.slice(afterStart, afterEnd);
  let prefix = 0;
  while (
    prefix < beforeSlice.length &&
    prefix < afterSlice.length &&
    beforeSlice[prefix] === afterSlice[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeSlice.length - prefix &&
    suffix < afterSlice.length - prefix &&
    beforeSlice[beforeSlice.length - 1 - suffix] === afterSlice[afterSlice.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  beforeStart += prefix;
  afterStart += prefix;
  beforeEnd -= suffix;
  afterEnd -= suffix;
  beforeSlice = beforeText.slice(beforeStart, beforeEnd);
  afterSlice = afterText.slice(afterStart, afterEnd);
  return {
    before: { start: beforeStart, end: beforeEnd, text: beforeSlice },
    after: { start: afterStart, end: afterEnd, text: afterSlice },
  };
}

function assertRevisionInput(input: UserRevisionDeltaInput): void {
  if (!input.workspaceId.trim()) throw new Error("workspaceId 不能为空");
  if (!input.chapterId.trim()) throw new Error("chapterId 不能为空");
  if (!input.selectedCandidateId.trim()) throw new Error("selectedCandidateId 不能为空");
}

function validateArtifact(artifact: UserRevisionDeltaArtifact): void {
  if (artifact.schemaId !== "pinovel.user-revision-delta" || artifact.schemaVersion !== 1) {
    throw new Error("非法 user revision delta schema");
  }
  if (sha256(artifact.systemSelectedText) !== artifact.systemSelectedHash) {
    throw new Error("systemSelectedHash 不匹配");
  }
  if (sha256(artifact.userFinalText) !== artifact.userFinalHash) {
    throw new Error("userFinalHash 不匹配");
  }
}

function normalizeReason(reason: string): string {
  return reason.trim().toLowerCase().replace(/\s+/g, " ");
}

function sanitizeFilePart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error("chapterId 无法安全用于文件名");
  }
  return sanitized;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

