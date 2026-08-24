/**
 * 全书上下文编译：大纲 / 角色 / 未结伏笔 / 既成事实。
 * 100 章不能把前文整章塞进模型；只给可检索的工作集。
 */
import { ContextCompileError, FAILURE_CODES, makeFailure } from '../context/failure-envelope';
const MAX_FACT_CHARS = 160;
const MAX_PROMISES = 80;
const MAX_CANON = 40;
const MIN_OUTLINE_CHARS = 8;

export function isUsableStoryOutline(content: string): boolean {
  const text = content.trim();
  if (text.length < MIN_OUTLINE_CHARS) return false;
  if (/\[\[CHAPTER_SEED_|\[\[GENERATE_CHAPTER:/.test(text)) return false;
  return true;
}

export function excerptLastSentences(text: string, maxChars = 160): string {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return '';
  const sentences = trimmed
    .split(/(?<=[。！？!?])\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  const tail: string[] = [];
  let used = 0;
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index];
    if (used > 0 && used + sentence.length > maxChars) break;
    tail.unshift(sentence);
    used += sentence.length;
    if (tail.length >= 2) break;
  }
  return tail.join('');
}

export interface CompactNarrativeState {
  canon: Array<{ fact: string; sourceChapter?: string }>;
  character: Array<{ characterId: string; field: string; value: string }>;
  promise: Array<{ description: string; status?: string; sourceChapter?: string }>;
}

export function compactNarrativeStateJson(raw: string): {
  json: string;
  compact: CompactNarrativeState;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { json: raw, compact: { canon: [], character: [], promise: [] } };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { json: raw, compact: { canon: [], character: [], promise: [] } };
  }
  const store = parsed as Record<string, unknown>;
  const canon = compactCanon(asObjectArray(store.canon)).slice(0, MAX_CANON);
  const character = compactCharacters(asObjectArray(store.character));
  const promise = compactPromises(asObjectArray(store.promise)).slice(0, MAX_PROMISES);
  const next = {
    ...store,
    canon,
    character,
    promise,
    pattern: [],
    eventLog: [],
  };
  return {
    json: JSON.stringify(next),
    compact: {
      canon: canon.map((row) => ({
        fact: String(row.fact ?? ''),
        sourceChapter: typeof row.sourceChapter === 'string' ? row.sourceChapter : undefined,
      })),
      character: character.map((row) => ({
        characterId: String(row.characterId ?? ''),
        field: String(row.field ?? ''),
        value: String(row.value ?? ''),
      })),
      promise: promise.map((row) => ({
        description: String(row.description ?? ''),
        status: typeof row.status === 'string' ? row.status : undefined,
        sourceChapter: typeof row.sourceChapter === 'string' ? row.sourceChapter : undefined,
      })),
    },
  };
}

export function buildBookContextBrief(input: {
  outline?: string;
  characterLines: string[];
  compact: CompactNarrativeState;
  previousStop?: string;
}): string {
  const lines = ['# 全书工作集', ''];
  if (input.outline?.trim() && isUsableStoryOutline(input.outline)) {
    lines.push('## 大纲', input.outline.trim().slice(0, 1200), '');
  }
  if (input.characterLines.length > 0) {
    lines.push('## 角色', ...input.characterLines.map((line) => `- ${line}`), '');
  }
  const characterState = input.compact.character.filter(
    (item) => item.value.trim().length > 0,
  );
  if (characterState.length > 0) {
    lines.push('## 角色现状');
    for (const item of characterState) {
      lines.push(`- ${item.characterId} ${item.field}：${clip(item.value, MAX_FACT_CHARS)}`);
    }
    lines.push('');
  }
  if (input.compact.promise.length > 0) {
    lines.push('## 未结伏笔/承诺');
    for (const item of input.compact.promise) {
      const chapter = item.sourceChapter ? `（${item.sourceChapter}）` : '';
      lines.push(`- ${item.description}${chapter}`);
    }
    lines.push('');
  }
  if (input.compact.canon.length > 0) {
    lines.push('## 既成事实');
    for (const item of input.compact.canon) {
      lines.push(`- ${item.fact}`);
    }
    lines.push('');
  }
  if (input.previousStop?.trim()) {
    lines.push('## 前章停点', input.previousStop.trim(), '');
  }
  return lines.join('\n').trim();
}

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
  );
}

function compactCanon(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows
    .filter((row) => {
      const id = String(row.id ?? '');
      const fact = String(row.fact ?? '').trim();
      if (!fact) return false;
      if (id.includes('accepted-chapter')) return false;
      if (fact.startsWith('第') && fact.includes('接受稿')) return false;
      return true;
    })
    .map((row) => ({
      ...row,
      fact: clip(String(row.fact), MAX_FACT_CHARS),
      ...normalizedSourceChapterField(row),
    }));
}

function compactCharacters(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.filter((row) => {
    const field = String(row.field ?? '');
    const value = String(row.value ?? '').trim();
    if (field === 'acceptedChapterEvidence') return false;
    if (field === 'participation' && (value === 'present' || value === '')) return false;
    if (!value) return false;
    return Boolean(row.characterId);
  }).map((row) => ({ ...row, ...normalizedSourceChapterField(row) }));
}

function compactPromises(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.filter((row) => {
    const description = String(row.description ?? '').trim();
    const status = String(row.status ?? 'open');
    if (!description) return false;
    return status === 'open' || status === 'advancing' || status === 'delayed';
  }).map((row) => ({ ...row, ...normalizedSourceChapterField(row) }));
}

function normalizedSourceChapterField(row: Record<string, unknown>): Record<string, unknown> {
  const sourceChapter = normalizeSourceChapter(row.sourceChapter);
  return sourceChapter ? { sourceChapter } : {};
}

function normalizeSourceChapter(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return `ch${value}`;
  }
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const direct = text.match(/^ch\s*(\d+)$/i) ?? text.match(/^(\d+)$/);
  if (direct) return `ch${Number.parseInt(direct[1], 10)}`;
  const titled = text.match(/^第\s*(\d+)\s*章$/);
  return titled ? `ch${Number.parseInt(titled[1], 10)}` : undefined;
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export interface AuthorContractInput {
  genre?: string | null;
  constitution?: string | null;
  worldbuilding?: string | null;
  styleProfile?: string | null;
  characters: Array<{
    goals?: string | null;
    motivation?: string | null;
    currentState?: string | null;
    relationships?: string | null;
  }>;
  compact: CompactNarrativeState;
  usableStoryOutline?: string;
}

export interface AuthorContractGaps {
  blocking: string[];
  advisory: string[];
}

export function listAuthorContractGaps(input: AuthorContractInput): AuthorContractGaps {
  const blocking: string[] = [];
  const advisory: string[] = [];
  if (!input.genre?.trim()) blocking.push('项目类型为空');
  if (!input.styleProfile?.trim()) blocking.push('缺少作者确认的风格档案');
  if (!input.worldbuilding?.trim()) blocking.push('缺少作者确认的世界观');
  if (!input.constitution?.trim()) blocking.push('缺少作者确认的创作宪法');
  if (input.characters.every((row) => !row.goals?.trim() && !row.motivation?.trim() && !row.currentState?.trim())) {
    advisory.push('角色目标/动机/当前状态均为空');
  }
  if (input.compact.canon.length === 0) advisory.push('canon 事实为空，尚未经作者确认');
  if (input.compact.promise.length === 0) advisory.push('未结伏笔为空');
  if (!input.usableStoryOutline?.trim()) advisory.push('缺少作者确认的全书大纲');
  return { blocking, advisory };
}

export function assertAuthorContractForGeneration(gaps: AuthorContractGaps): void {
  if (gaps.blocking.length === 0) return;
  throw new ContextCompileError(makeFailure({
    stage: 'runtime.preflight',
    gate: 'author_contract',
    code: FAILURE_CODES.runtimePreflightFailed,
    severity: 'preflight',
    reason: '缺少作者确认的生成资料，已阻断；不会用默认题材、风格或世界观代替',
    evidence: { blocking: gaps.blocking, advisory: gaps.advisory },
    recoverable: false,
    userActionRequired: [...gaps.blocking, ...gaps.advisory],
    fixInstructions: [
      '在项目资料中填写类型、世界观、创作宪法和风格档案',
      '补全角色目标、动机、当前状态和关系',
      '确认伏笔/既成事实后再生成第二章，不要用系统默认值顶替',
    ],
  }));
}
