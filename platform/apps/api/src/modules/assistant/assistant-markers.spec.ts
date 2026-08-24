import { describe, expect, it } from 'vitest';
import {
  CHARACTERS_BLOCK_RE,
  CHAPTER_SEED_BLOCK_RE,
  extractGenerateChapterNumber,
  extractMarkedBlock,
  inferCharactersFromText,
  inferGenerateChapterNumber,
  shouldPreflightAuthorContract,
  OUTLINE_BLOCK_RE,
  parseChapterSeed,
  parseCharacterLines,
  parseOutlineChapters,
  stripGenerateChapterMarker,
} from './assistant-markers';

describe('assistant markers', () => {
  it('extracts an outline block and keeps the inner markdown visible', () => {
    const raw = '好的。\n[[OUTLINE_START]]\n# 大纲\n1. 开端\n[[OUTLINE_END]]\n已保存。';
    const extracted = extractMarkedBlock(raw, OUTLINE_BLOCK_RE);
    expect(extracted?.inner).toContain('# 大纲');
    expect(extracted?.stripped).toContain('# 大纲');
    expect(extracted?.stripped).not.toContain('OUTLINE_START');
  });

  it('parses character rows and defaults unknown role types', () => {
    const raw = '林默|protagonist|都市青年\n路人|wizard|无效类型\n';
    const extracted = extractMarkedBlock(
      `[[CHARACTERS_START]]\n${raw}[[CHARACTERS_END]]`,
      CHARACTERS_BLOCK_RE,
    );
    const parsed = parseCharacterLines(extracted?.inner ?? '');
    expect(parsed).toEqual([
      { name: '林默', roleType: 'protagonist', description: '都市青年' },
      { name: '路人', roleType: 'other', description: '无效类型' },
    ]);
  });

  it('parses a chapter seed and rejects a missing chapter number', () => {
    const ok = parseChapterSeed(
      extractMarkedBlock(
        '[[CHAPTER_SEED_START]]\n章节号：1\n意图：林默最后一天\n章末目标：倒下\n[[CHAPTER_SEED_END]]',
        CHAPTER_SEED_BLOCK_RE,
      )?.inner ?? '',
    );
    expect(ok).toEqual(expect.objectContaining({
      chapterNumber: 1,
      intent: '林默最后一天',
      endingGoal: '倒下',
    }));
    expect(parseChapterSeed('意图：没有章节号')).toBeNull();
  });

  it('extracts GENERATE_CHAPTER and strips the marker from display text', () => {
    const raw = '开始生成。\n[[GENERATE_CHAPTER:3]]';
    expect(extractGenerateChapterNumber(raw)).toBe(3);
    expect(stripGenerateChapterMarker(raw)).toBe('开始生成。');
  });
});

describe('unmarked outline and generate inference', () => {
  it('parses markdown chapters from a live-style outline without markers', () => {
    const markdown = [
      '# 故事大纲',
      '',
      '## 第一卷：梦醒之后',
      '1. **第一章：牛马的一生**',
      '   主角沈砚在重压下倒下。',
      '2. **第二章：原来人生是梦**',
      '   沈砚回到干净的现实。',
    ].join('\n');
    const chapters = parseOutlineChapters(markdown);
    expect(chapters).toEqual([
      expect.objectContaining({
        chapterNumber: 1,
        title: '牛马的一生',
        volumeTitle: '第一卷：梦醒之后',
      }),
      expect.objectContaining({ chapterNumber: 2, title: '原来人生是梦' }),
    ]);
    expect(chapters[0].summary).toContain('沈砚');
  });

  it('infers generate chapter 1 from the user message when the model omits the marker', () => {
    expect(inferGenerateChapterNumber('帮我生成第一章', '好的，开始准备。')).toBe(1);
    expect(inferGenerateChapterNumber('生成第二章', '')).toBe(2);
    expect(inferGenerateChapterNumber('续写第十七章', '')).toBe(17);
    expect(inferGenerateChapterNumber('接着写第18章', '')).toBe(18);
    expect(inferGenerateChapterNumber('随便聊聊设定', '好的。')).toBeNull();
  });

  it('recognizes completion and expansion wording as a chapter generation request', () => {
    const request = '根据小说大纲，完善第十七章，补满2500字';
    expect(inferGenerateChapterNumber(request, '')).toBe(17);
    expect(shouldPreflightAuthorContract(undefined, request)).toBe(true);
  });

  it('preflights author contract for explicit or locally recognized generate requests', () => {
    expect(shouldPreflightAuthorContract('generate_chapter', '随便聊聊')).toBe(true);
    expect(shouldPreflightAuthorContract(undefined, '生成第二章')).toBe(true);
    expect(shouldPreflightAuthorContract(undefined, '续写第十七章')).toBe(true);
    expect(shouldPreflightAuthorContract('query_project', '生成第二章')).toBe(false);
    expect(shouldPreflightAuthorContract(undefined, '帮我规划下一章')).toBe(false);
  });

  it('infers labeled characters without pipe rows', () => {
    expect(inferCharactersFromText('主角：沈砚，都市青年\n反派：债主老周')).toEqual([
      { name: '沈砚', roleType: 'protagonist', description: '都市青年' },
      { name: '债主老周', roleType: 'antagonist', description: '' },
    ]);
  });
});
