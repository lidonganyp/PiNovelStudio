/**
 * 助手回复标记：大纲 / 角色 / 章节种子 / 生成章节。
 * 标记由规划模型输出，系统负责落库与调度，模型不得直接写章节正文。
 */

export const OUTLINE_BLOCK_RE =
  /\[\[OUTLINE_START\]\]\s*([\s\S]*?)\s*\[\[OUTLINE_END\]\]/;
export const CHARACTERS_BLOCK_RE =
  /\[\[CHARACTERS_START\]\]\s*([\s\S]*?)\s*\[\[CHARACTERS_END\]\]/;
export const CHAPTER_SEED_BLOCK_RE =
  /\[\[CHAPTER_SEED_START\]\]\s*([\s\S]*?)\s*\[\[CHAPTER_SEED_END\]\]/;
export const GENERATE_CHAPTER_RE = /\[\[GENERATE_CHAPTER:(\d+)\]\]/;
const CHARACTER_LINE_RE = /^([^|]+)\|([^|]+)\|(.+)$/;
const SEED_FIELD_RE =
  /^(章节号|意图|必须包含|禁止事实|角色动机|承诺|章末目标)[：:]\s*(.*)$/;

const ROLE_TYPES = new Set(['protagonist', 'supporting', 'antagonist', 'other']);

export interface ParsedCharacter {
  name: string;
  roleType: string;
  description: string;
}

export interface ParsedChapterSeed {
  chapterNumber: number;
  intent: string;
  mustInclude: string;
  forbiddenFacts: string;
  characterMotives: string;
  promises: string;
  endingGoal: string;
}

export function extractMarkedBlock(
  content: string,
  pattern: RegExp,
): { inner: string; stripped: string } | null {
  const match = content.match(pattern);
  if (!match || match[1] === undefined) return null;
  const inner = match[1].trim();
  const stripped = content.replace(pattern, inner).trim();
  return { inner, stripped };
}

export function parseCharacterLines(block: string): ParsedCharacter[] {
  const parsed: ParsedCharacter[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(CHARACTER_LINE_RE);
    if (!match) continue;
    const name = match[1].trim();
    const roleType = ROLE_TYPES.has(match[2].trim()) ? match[2].trim() : 'other';
    const description = match[3].trim();
    if (!name) continue;
    parsed.push({ name, roleType, description });
  }
  return parsed;
}

export function parseChapterSeed(block: string): ParsedChapterSeed | null {
  const fields = new Map<string, string>();
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(SEED_FIELD_RE);
    if (!match) continue;
    const value = match[2].trim();
    if (value) fields.set(match[1], value);
  }
  const chapterNumber = Number.parseInt(fields.get('章节号') ?? '', 10);
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) return null;
  return {
    chapterNumber,
    intent: fields.get('意图') ?? '',
    mustInclude: fields.get('必须包含') ?? '',
    forbiddenFacts: fields.get('禁止事实') ?? '',
    characterMotives: fields.get('角色动机') ?? '',
    promises: fields.get('承诺') ?? '',
    endingGoal: fields.get('章末目标') ?? '',
  };
}

export function extractGenerateChapterNumber(content: string): number | null {
  const match = content.match(GENERATE_CHAPTER_RE);
  if (!match) return null;
  const chapterNumber = Number.parseInt(match[1], 10);
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) return null;
  return chapterNumber;
}

export function stripGenerateChapterMarker(content: string): string {
  return content.replace(GENERATE_CHAPTER_RE, '').trim();
}

const ZH_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

export interface OutlineChapter {
  chapterNumber: number;
  title: string;
  summary: string;
  volumeTitle?: string;
}

export function parseChineseChapterNumber(raw: string): number | null {
  const digits = Number.parseInt(raw, 10);
  if (Number.isInteger(digits) && digits >= 1) return digits;
  if (raw in ZH_NUM) return ZH_NUM[raw];
  return null;
}

export function looksLikeOutline(text: string): boolean {
  return /故事大纲|第.+卷|第\s*\d+\s*章|第[一二三四五六七八九十]+\s*章/.test(text);
}

export function parseOutlineChapters(markdown: string): OutlineChapter[] {
  const chapters: OutlineChapter[] = [];
  let volumeTitle: string | undefined;
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const volume = line.match(/^#{1,3}\s*(第.+卷.*)$/);
    if (volume) {
      volumeTitle = volume[1].trim();
      continue;
    }
    const heading = line.match(
      /第\s*(\d+|[一二三四五六七八九十]+)\s*章[：:．.\s]*([^\n*]*)/,
    );
    if (!heading) continue;
    const chapterNumber = parseChineseChapterNumber(heading[1]);
    if (chapterNumber === null) continue;
    const title = heading[2].replace(/[*_#]/g, '').trim() || `第${chapterNumber}章`;
    const summaryLines: string[] = [];
    for (let look = index + 1; look < lines.length; look += 1) {
      const next = lines[look];
      if (/第\s*(?:\d+|[一二三四五六七八九十]+)\s*章/.test(next) || /^#{1,3}\s*第.+卷/.test(next.trim())) {
        break;
      }
      if (next.trim()) summaryLines.push(next.trim());
    }
    chapters.push({
      chapterNumber,
      title,
      summary: summaryLines.join(' ').slice(0, 500),
      volumeTitle,
    });
  }
  return uniqueChapters(chapters);
}

export function inferCharactersFromText(text: string): ParsedCharacter[] {
  const fromPipes = parseCharacterLines(text);
  if (fromPipes.length > 0) return fromPipes;
  const parsed: ParsedCharacter[] = [];
  const labeled = [
    { pattern: /主角[：:]\s*([^\n，。, |]{2,12})[，。,:]?\s*(.*)/g, role: 'protagonist' },
    { pattern: /反派[：:]\s*([^\n，。, |]{2,12})[，。,:]?\s*(.*)/g, role: 'antagonist' },
    { pattern: /配角[：:]\s*([^\n，。, |]{2,12})[，。,:]?\s*(.*)/g, role: 'supporting' },
  ];
  for (const item of labeled) {
    for (const match of text.matchAll(item.pattern)) {
      const name = match[1].trim();
      if (name) {
        parsed.push({
          name,
          roleType: item.role,
          description: (match[2] ?? '').trim().slice(0, 80),
        });
      }
    }
  }
  return uniqueCharacters(parsed);
}

export function inferGenerateChapterNumber(
  userContent: string,
  reply: string,
): number | null {
  const marked = extractGenerateChapterNumber(reply);
  if (marked !== null) return marked;
  const match = userContent.match(
    /(?:生成|写|来)\s*(?:一)?\s*第?\s*(\d+|[一二三四五六七八九十]+)\s*章/,
  );
  if (!match) return null;
  return parseChineseChapterNumber(match[1]);
}

export function userAskedForOutline(userContent: string): boolean {
  return /大纲|章纲|分卷|故事结构/.test(userContent);
}

export function userAskedForCharacters(userContent: string): boolean {
  return /角色|人物|主角|配角/.test(userContent);
}

function uniqueChapters(chapters: OutlineChapter[]): OutlineChapter[] {
  const byNumber = new Map<number, OutlineChapter>();
  for (const chapter of chapters) {
    byNumber.set(chapter.chapterNumber, chapter);
  }
  return [...byNumber.values()].sort((a, b) => a.chapterNumber - b.chapterNumber);
}

function uniqueCharacters(characters: ParsedCharacter[]): ParsedCharacter[] {
  const byName = new Map<string, ParsedCharacter>();
  for (const character of characters) {
    byName.set(character.name, character);
  }
  return [...byName.values()];
}
