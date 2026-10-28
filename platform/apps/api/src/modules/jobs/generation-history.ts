/** Restore the state before a rewritten chapter; future mutations cannot be undone by filtering rows. */
import { hashChapterText } from '../context/context-compiler';
import { ContextCompileError, FAILURE_CODES, makeFailure } from '../context/failure-envelope';
import type { ContinuationMode } from './chapter-continuation';

interface StateDocument {
  id: number;
  content: string;
  currentVersion?: number;
}
interface StateVersion { versionNumber: number; content: string }
interface ChapterEvidence { chapterNumber: number; content: string }
interface HistoryRequest {
  chapterNumber: number;
  mode: ContinuationMode;
  workspaceId: string;
  state?: StateDocument;
  previousChapter?: ChapterEvidence;
  historicalChapters: ChapterEvidence[];
  loadVersions: (beforeVersion: number) => Promise<StateVersion[]>;
}

export class GenerationHistoryResolver {
  async resolve(input: HistoryRequest): Promise<StateDocument | undefined> {
    const state = input.state;
    if (!state) return undefined;
    const current = parseState(state.content);
    if (!current) throw unavailableHistory(input.chapterNumber);
    const boundary = input.chapterNumber - 1;
    const watermark = chapterNumber(current?.lastCommittedChapter);
    if (latestChapter(current) <= boundary && (!watermark || watermark === boundary)) return state;

    if (boundary === 0) {
      return { ...state, content: JSON.stringify({
        schemaVersion: 1, workspaceId: input.workspaceId,
        canon: [], character: [], promise: [], pattern: [],
      }) };
    }

    // A successful earlier rewrite moves the current watermark backwards.
    // Do not resurrect old future checkpoints to jump over pending rewrites.
    if (watermark > 0 && watermark < boundary) throw unavailableHistory(input.chapterNumber);

    // Do not derive a past state from today's entries: a promise sourced in
    // ch1 may have been fulfilled in ch5 and a character value overwritten.
    // Only a complete checkpoint at the preceding accepted text is usable.
    let beforeVersion = state.currentVersion ?? Number.MAX_SAFE_INTEGER;
    while (true) {
      const versions = await input.loadVersions(beforeVersion);
      if (versions.length === 0) break;
      for (const version of versions) {
        const candidate = parseState(version.content);
        if (candidate && checkpointMatches(candidate, boundary, input)) {
          return { ...state, content: version.content };
        }
      }
      const next = Math.min(...versions.map((version) => version.versionNumber));
      if (next >= beforeVersion) break;
      beforeVersion = next;
    }
    throw unavailableHistory(input.chapterNumber);
  }
}

function unavailableHistory(chapter: number): ContextCompileError {
  return new ContextCompileError(makeFailure({
    stage: 'runtime.preflight', gate: 'generation_history',
    code: FAILURE_CODES.generationHistoryUnavailable,
    severity: 'preflight', recoverable: false,
    reason: chapter === 1
      ? '叙事状态格式损坏，已在模型调用前停止。请修复状态后重新预检。'
      : `找不到与第${chapter - 1}章已保存正文一致的历史叙事状态，已在模型调用前停止。请从更早的有效断点依次重写。`,
    evidence: { chapterNumber: chapter, requiredCheckpointChapter: chapter - 1 },
    userActionRequired: chapter === 1 ? ['修复叙事状态格式后重新预检']
      : ['从更早的有效断点开始顺序重写，必要时从第一章开始'],
  }));
}

function parseState(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function chapterNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : 0;
  if (typeof value !== 'string') return 0;
  const match = value.trim().match(/^(?:ch\s*|第\s*)?(\d+)(?:\s*章)?$/iu);
  return match ? Number(match[1]) : 0;
}

/** Include nested memory/sourceRefs: a top-level watermark alone is insufficient. */
function latestChapter(value: unknown, key = ''): number {
  if (key === 'sourceChapter' || key === 'lastCommittedChapter') return chapterNumber(value);
  if (typeof value === 'string') {
    return Math.max(0, ...Array.from(value.matchAll(/(?:^|\b)ch(\d+)#finalText:/giu), (match) => Number(match[1])));
  }
  if (Array.isArray(value)) return Math.max(0, ...value.map((item) => latestChapter(item, key)));
  if (!value || typeof value !== 'object') return 0;
  return Math.max(0, ...Object.entries(value).map(([childKey, child]) => latestChapter(child, childKey)));
}

function finalTextReferences(value: unknown): Array<{ chapter: number; hash: string }> {
  if (typeof value === 'string') {
    return Array.from(value.matchAll(/(?:^|\b)ch(\d+)#finalText:([0-9a-f]{12})(?![0-9a-f])/giu),
      (match) => ({ chapter: Number(match[1]), hash: match[2].toLowerCase() }));
  }
  if (Array.isArray(value)) return value.flatMap(finalTextReferences);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(finalTextReferences);
}

function checkpointMatches(state: Record<string, unknown>, boundary: number, input: HistoryRequest): boolean {
  if (chapterNumber(state.lastCommittedChapter) !== boundary || latestChapter(state) > boundary) return false;
  const chapters = new Map(input.historicalChapters.map((chapter) => [chapter.chapterNumber, chapter]));
  if (input.previousChapter) chapters.set(input.previousChapter.chapterNumber, input.previousChapter);
  const references = finalTextReferences(state);
  if (!references.some((reference) => reference.chapter === boundary)) return false;
  return references.every((reference) => {
    const chapter = chapters.get(reference.chapter);
    return chapter && chapter.content.trim() && hashChapterText(chapter.content) === reference.hash;
  });
}
