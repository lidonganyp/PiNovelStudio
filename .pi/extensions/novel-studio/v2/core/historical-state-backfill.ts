/**
 * HistoricalStateBackfill - seed long-term state from accepted chapter files.
 *
 * The migration is deterministic, idempotent, source-referenced, local-only,
 * and never reads the target chapter or calls an LLM.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  loadStateStore,
  saveStateStore,
  type CanonEntry,
  type CharacterStateEntry,
  type NarrativeStateEntry,
  type PatternEntry,
  type PromiseEntry,
} from "./final-state-commit.js";

export interface AcceptedChapterFile {
  chapterNumber: number;
  relativePath: string;
  absolutePath: string;
  sourceText: string;
  text: string;
  textStart: number;
}

export interface HistoricalStateBackfillInput {
  projectRoot: string;
  workspaceId: string;
  beforeChapterNumber: number;
}

export interface HistoricalStateBackfillReport {
  scannedChapters: number;
  addedEntries: number;
  updatedEntries: number;
  counts: { canon: number; character: number; promise: number; pattern: number };
  sourceFiles: string[];
}

export interface AcceptedReferenceSelection {
  examples: Array<{
    id: string;
    text: string;
    qualityScore: number;
    source: string;
    narrativeBeat?: string;
    emotionTarget?: string;
  }>;
  query: { narrativeBeat?: string; emotionTarget?: string };
  channel: "runtime" | "empty";
  sources: string[];
  manifestApproved: boolean;
}

interface CharacterIdentity {
  name: string;
  aliases: string[];
}

const ACCEPTED_EXCERPT_CHARS = 720;
const REFERENCE_EXCERPT_CHARS = 520;

export function listAcceptedChapterFiles(input: HistoricalStateBackfillInput): AcceptedChapterFile[] {
  const workspacePath = join(input.projectRoot, "workspaces", input.workspaceId);
  const chaptersPath = join(workspacePath, "chapters");
  if (!existsSync(chaptersPath)) return [];
  const completed = loadCompletedChapter(workspacePath);
  const upperBound = Math.min(input.beforeChapterNumber - 1, completed ?? input.beforeChapterNumber - 1);
  const selected = new Map<number, { path: string; rank: number; mtimeMs: number }>();

  for (const entry of readdirSync(chaptersPath, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const parsed = parseAcceptedChapterFileName(entry.name);
    if (!parsed || parsed.chapterNumber < 1 || parsed.chapterNumber > upperBound) continue;
    const absolutePath = join(chaptersPath, entry.name);
    const mtimeMs = statSync(absolutePath).mtimeMs;
    const current = selected.get(parsed.chapterNumber);
    if (!current || parsed.rank > current.rank || (parsed.rank === current.rank && mtimeMs > current.mtimeMs)) {
      selected.set(parsed.chapterNumber, { path: absolutePath, rank: parsed.rank, mtimeMs });
    }
  }

  const result: AcceptedChapterFile[] = [];
  for (const [chapterNumber, selectedFile] of [...selected.entries()].sort((a, b) => a[0] - b[0])) {
    try {
      const sourceText = readFileSync(selectedFile.path, "utf8");
      const { text, textStart } = extractAcceptedProse(sourceText);
      if (!text) continue;
      const fileName = selectedFile.path.split(/[\\/]/u).at(-1) ?? `${chapterNumber}.md`;
      result.push({
        chapterNumber,
        absolutePath: selectedFile.path,
        relativePath: `chapters/${fileName}`,
        sourceText,
        text,
        textStart,
      });
    } catch {
      // One unreadable historical file must not hide the remaining accepted chapters.
    }
  }
  return result;
}

export function backfillAcceptedChapterState(input: HistoricalStateBackfillInput): HistoricalStateBackfillReport {
  const workspacePath = join(input.projectRoot, "workspaces", input.workspaceId);
  const accepted = listAcceptedChapterFiles(input);
  const identities = loadCharacterIdentities(workspacePath);
  const store = loadStateStore(input.workspaceId, input.projectRoot);
  const existingIds = new Set([
    ...store.canon,
    ...store.character,
    ...store.promise,
    ...store.pattern,
    ...(store.expectation ?? []),
  ].map((entry) => entry.id));
  const additions: NarrativeStateEntry[] = [];
  const generatedEntries = new Map<string, NarrativeStateEntry>();

  for (const chapter of accepted) {
    const canon = makeAcceptedCanonEntry(chapter);
    generatedEntries.set(canon.id, canon);
    if (!existingIds.has(canon.id)) additions.push(canon);
    for (const character of makeParticipationEntries(chapter, identities)) {
      generatedEntries.set(character.id, character);
      if (!existingIds.has(character.id)) additions.push(character);
    }
    const pattern = makeEndingPatternEntry(chapter);
    generatedEntries.set(pattern.id, pattern);
    if (!existingIds.has(pattern.id)) additions.push(pattern);
  }
  for (const promise of loadHistoricalPromises(workspacePath, input.beforeChapterNumber)) {
    if (!existingIds.has(promise.id)) additions.push(promise);
  }

  const canon = additions.filter((entry): entry is CanonEntry => entry.kind === "canon");
  const character = additions.filter((entry): entry is CharacterStateEntry => entry.kind === "character");
  const promise = additions.filter((entry): entry is PromiseEntry => entry.kind === "promise");
  const pattern = additions.filter((entry): entry is PatternEntry => entry.kind === "pattern");
  const updatedIds = new Set<string>();
  const refreshGeneratedEntry = <T extends NarrativeStateEntry>(entry: T): T => {
    const replacement = generatedEntries.get(entry.id);
    if (!replacement || replacement.kind !== entry.kind || !shouldRefreshGeneratedEntry(entry, replacement)) {
      return entry;
    }
    updatedIds.add(entry.id);
    return replacement as T;
  };
  store.canon = store.canon.map(refreshGeneratedEntry);
  store.character = store.character.map(refreshGeneratedEntry);
  store.pattern = store.pattern.map(refreshGeneratedEntry);
  const updatedEntries = updatedIds.size;
  if (updatedEntries > 0 && store.eventLog) {
    store.eventLog = store.eventLog.map(refreshGeneratedEntry);
  }
  const latestAcceptedChapter = accepted.at(-1)?.chapterNumber ?? 0;
  const existingStateWatermark = Math.max(0, ...[
    ...store.canon,
    ...store.character,
    ...store.promise,
    ...store.pattern,
    ...(store.expectation ?? []),
  ].map((entry) => parseStateChapterNumber(entry.sourceChapter)));
  const currentWatermark = parseStateChapterNumber(store.lastCommittedChapter);
  const desiredWatermark = Math.max(currentWatermark, existingStateWatermark, latestAcceptedChapter);
  if (additions.length > 0) {
    store.canon.push(...canon);
    store.character.push(...character);
    store.promise.push(...promise);
    store.pattern.push(...pattern);
    store.eventLog = [...(store.eventLog ?? []), ...additions];
  }
  if (desiredWatermark > 0 && desiredWatermark !== currentWatermark) {
    store.lastCommittedChapter = `ch${desiredWatermark}`;
  }
  if (additions.length > 0 || updatedEntries > 0 || desiredWatermark !== currentWatermark) {
    saveStateStore(store, input.workspaceId, input.projectRoot);
  }

  return {
    scannedChapters: accepted.length,
    addedEntries: additions.length,
    updatedEntries,
    counts: { canon: canon.length, character: character.length, promise: promise.length, pattern: pattern.length },
    sourceFiles: accepted.map((chapter) => chapter.relativePath),
  };
}

function shouldRefreshGeneratedEntry(current: NarrativeStateEntry, replacement: NarrativeStateEntry): boolean {
  if (current.sourceRef !== replacement.sourceRef) return true;
  if (current.kind === "canon" && replacement.kind === "canon") return current.fact !== replacement.fact;
  if (current.kind === "character" && replacement.kind === "character") {
    return current.field !== replacement.field || current.value !== replacement.value;
  }
  if (current.kind === "pattern" && replacement.kind === "pattern") {
    return current.patternType !== replacement.patternType || current.description !== replacement.description;
  }
  return false;
}

export function selectAcceptedChapterReferences(input: HistoricalStateBackfillInput & {
  relevantCharacters: string[];
  keywords: string[];
  targetEmotion?: string;
  maxExamples?: number;
}): AcceptedReferenceSelection {
  const candidates = listAcceptedChapterFiles(input).map((chapter) => {
    let score = chapter.chapterNumber;
    for (const name of input.relevantCharacters.filter(Boolean)) {
      if (chapter.text.includes(name)) score += 100;
    }
    for (const keyword of input.keywords.filter((value) => value.trim().length >= 2)) {
      if (chapter.text.includes(keyword)) score += 40;
    }
    return { chapter, score };
  }).sort((a, b) => b.score - a.score || b.chapter.chapterNumber - a.chapter.chapterNumber);
  const examples = candidates.slice(0, Math.max(0, input.maxExamples ?? 2)).map(({ chapter }) => ({
    id: `accepted-ch${chapter.chapterNumber}`,
    text: compactExcerpt(chapter.text, REFERENCE_EXCERPT_CHARS).text,
    qualityScore: 1,
    source: chapter.relativePath,
    narrativeBeat: "accepted_chapter",
    ...(input.targetEmotion ? { emotionTarget: input.targetEmotion } : {}),
  }));
  return {
    examples,
    query: { narrativeBeat: "accepted_chapter", ...(input.targetEmotion ? { emotionTarget: input.targetEmotion } : {}) },
    channel: examples.length > 0 ? "runtime" : "empty",
    sources: examples.map((entry) => entry.source),
    manifestApproved: examples.length > 0,
  };
}

function parseAcceptedChapterFileName(name: string): { chapterNumber: number; rank: number } | null {
  const padded = name.match(/^chapter-(\d{2,})\.md$/iu);
  if (padded) return { chapterNumber: Number(padded[1]), rank: 4 };
  const bare = name.match(/^(\d+)\.md$/u);
  if (bare) return { chapterNumber: Number(bare[1]), rank: 3 };
  const chapter = name.match(/^chapter-(\d+)\.md$/iu);
  if (chapter) return { chapterNumber: Number(chapter[1]), rank: 2 };
  const short = name.match(/^ch(?:apter)?-?(\d+)\.md$/iu);
  return short ? { chapterNumber: Number(short[1]), rank: 1 } : null;
}

function loadCompletedChapter(workspacePath: string): number | null {
  try {
    const config = JSON.parse(readFileSync(join(workspacePath, "config.json"), "utf8")) as {
      chapterProgress?: { completed?: unknown };
    };
    return typeof config.chapterProgress?.completed === "number" ? config.chapterProgress.completed : null;
  } catch {
    return null;
  }
}

function loadCharacterIdentities(workspacePath: string): CharacterIdentity[] {
  try {
    const config = JSON.parse(readFileSync(join(workspacePath, "config.json"), "utf8")) as {
      characters?: Array<{ name?: unknown; aliases?: unknown }>;
    };
    return (config.characters ?? []).flatMap((entry) => typeof entry.name === "string"
      ? [{ name: entry.name, aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((value): value is string => typeof value === "string") : [] }]
      : []);
  } catch {
    return [];
  }
}

function makeAcceptedCanonEntry(chapter: AcceptedChapterFile): CanonEntry {
  const excerpt = compactExcerpt(chapter.text, ACCEPTED_EXCERPT_CHARS);
  const hash = textHash(chapter.sourceText);
  const sourceStart = chapter.textStart + excerpt.start;
  const sourceEnd = chapter.textStart + chapter.text.length;
  return {
    id: `canon:accepted-chapter:${chapter.chapterNumber}`,
    kind: "canon",
    fact: `第${chapter.chapterNumber}章接受稿末段：${excerpt.text}`,
    category: "timeline",
    sourceChapter: `ch${chapter.chapterNumber}`,
    sourceRef: `ch${chapter.chapterNumber}#finalText:${hash}:${sourceStart}-${sourceEnd}`,
    confidence: 1,
    lastUpdated: fileTimestamp(chapter.absolutePath),
  };
}

function makeParticipationEntries(chapter: AcceptedChapterFile, identities: CharacterIdentity[]): CharacterStateEntry[] {
  const hash = textHash(chapter.sourceText);
  return identities.flatMap((identity) => {
    const matchedName = [identity.name, ...identity.aliases].find((name) => name && chapter.text.includes(name));
    if (!matchedName) return [];
    const mentionStart = chapter.text.indexOf(matchedName);
    const excerptStart = Math.max(0, mentionStart - 80);
    const excerptEnd = Math.min(chapter.text.length, mentionStart + matchedName.length + 180);
    const evidence = chapter.text.slice(excerptStart, excerptEnd).replace(/\s+/gu, " ").trim();
    return [{
      id: `character:accepted-participation:${identity.name}:ch${chapter.chapterNumber}`,
      kind: "character" as const,
      characterId: identity.name,
      field: "acceptedChapterEvidence",
      value: `第${chapter.chapterNumber}章接受稿证据：${evidence}`,
      sourceChapter: `ch${chapter.chapterNumber}`,
      sourceRef: `ch${chapter.chapterNumber}#finalText:${hash}:${chapter.textStart + excerptStart}-${chapter.textStart + excerptEnd}`,
      confidence: 1,
      lastUpdated: fileTimestamp(chapter.absolutePath),
    }];
  });
}

function makeEndingPatternEntry(chapter: AcceptedChapterFile): PatternEntry {
  const tailExcerpt = compactExcerpt(chapter.text, 260);
  const tail = tailExcerpt.text;
  const endingType = /[？?]/u.test(tail)
    ? "疑问悬置"
    : /(?:倒计时|来不及|最后|只剩|明天|期限)/u.test(tail)
      ? "时间或行动压力"
      : /(?:却|但|原来|竟然|没想到)/u.test(tail)
        ? "信息差或反转"
        : "余韵悬置";
  return {
    id: `pattern:accepted-ending:ch${chapter.chapterNumber}`,
    kind: "pattern",
    patternType: "hook_type",
    description: `第${chapter.chapterNumber}章章末使用${endingType}`,
    occurrenceCount: 1,
    sourceChapter: `ch${chapter.chapterNumber}`,
    sourceRef: `ch${chapter.chapterNumber}#finalText:${textHash(chapter.sourceText)}:${chapter.textStart + tailExcerpt.start}-${chapter.textStart + chapter.text.length}`,
    confidence: 0.8,
    lastUpdated: fileTimestamp(chapter.absolutePath),
  };
}

function loadHistoricalPromises(workspacePath: string, beforeChapterNumber: number): PromiseEntry[] {
  const ledgerPath = join(workspacePath, "chapter-hooks-ledger.md");
  if (!existsSync(ledgerPath)) return [];
  let text = "";
  try {
    text = readFileSync(ledgerPath, "utf8");
  } catch {
    return [];
  }
  const entries: PromiseEntry[] = [];
  let headers: string[] = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.replace(/\*\*/gu, "").trim());
    if (cells.length < 3 || cells.every((cell) => /^[-:]+$/u.test(cell))) continue;
    if (cells.some((cell) => /^(?:编号|序号|章节|名称|主钩子|当前状态|状态)$/u.test(cell))) {
      headers = cells;
      continue;
    }
    if (headers.length !== cells.length) continue;
    const row = new Map(headers.map((header, cellIndex) => [header, cells[cellIndex]]));
    const id = pickCell(row, ["编号", "序号"]);
    const description = pickCell(row, ["名称", "内容摘要", "主钩子"]);
    const sourceChapter = parseChapterNumber(pickCell(row, ["埋入章", "章节", "来源"]));
    if (!id || !description || sourceChapter === null || sourceChapter >= beforeChapterNumber) continue;
    const statusText = pickCell(row, ["当前状态", "状态"]);
    const status: PromiseEntry["status"] = /resolved|fulfilled|已兑现|已回收/iu.test(statusText)
      ? "fulfilled"
      : /in_progress|advancing|推进/iu.test(statusText)
        ? "advancing"
        : /broken|违约/iu.test(statusText)
          ? "broken"
          : "open";
    entries.push({
      id: `promise:historical-ledger:${id}`,
      kind: "promise",
      promiseId: id,
      description,
      currentHeat: /A|high|高/iu.test(pickCell(row, ["级别", "建议级别"])) ? 0.8 : 0.5,
      status,
      sourceChapter: `ch${sourceChapter}`,
      sourceRef: `chapter-hooks-ledger.md#L${index + 1}`,
      confidence: 1,
      lastUpdated: fileTimestamp(ledgerPath),
    });
  }
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function pickCell(row: Map<string, string>, names: string[]): string {
  for (const name of names) {
    const value = row.get(name)?.trim();
    if (value) return value;
  }
  return "";
}

function parseChapterNumber(value: string): number | null {
  const match = value.match(/第\s*0*(\d+)\s*章/u) ?? value.match(/(?:^|\D)(\d{1,4})(?:\D|$)/u);
  return match ? Number(match[1]) : null;
}

function parseStateChapterNumber(value: string | undefined): number {
  const match = value?.match(/^ch(\d+)$/u);
  return match ? Number(match[1]) : 0;
}

function extractAcceptedProse(sourceText: string): { text: string; textStart: number } {
  const appendixBoundary = sourceText.search(
    /\r?\n---[ \t]*\r?\n(?:[ \t]*\r?\n)*##[ \t]*(?:本章)?创作备注[^\r\n]*/u,
  );
  const headingBoundary = sourceText.search(/\r?\n##[ \t]*(?:本章)?创作备注[^\r\n]*/u);
  const boundary = appendixBoundary >= 0 ? appendixBoundary : headingBoundary;
  const proseRegion = sourceText.slice(0, boundary >= 0 ? boundary : sourceText.length);
  const withoutBom = proseRegion.replace(/^\uFEFF/u, "");
  const text = withoutBom.trim();
  return { text, textStart: text ? sourceText.indexOf(text) : 0 };
}

function compactExcerpt(text: string, maxChars: number): { text: string; start: number } {
  if (text.length <= maxChars) return { text, start: 0 };
  let start = text.length - maxChars;
  const paragraph = text.indexOf("\n\n", start);
  if (paragraph >= start && paragraph < start + Math.floor(maxChars / 3)) start = paragraph + 2;
  return { text: text.slice(start).trim(), start };
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function fileTimestamp(path: string): string {
  return new Date(statSync(path).mtimeMs).toISOString();
}
