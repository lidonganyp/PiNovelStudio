import { describe, expect, it } from 'vitest';
import { chapterNumberFromTitle, chapterTitleMatches, parseChapterNumber } from './chapter-number';

describe('chapter number parsing', () => {
  it('supports arabic and Chinese chapter numbers', () => {
    expect(parseChapterNumber('17')).toBe(17);
    expect(parseChapterNumber('十七')).toBe(17);
    expect(parseChapterNumber('二十')).toBe(20);
    expect(parseChapterNumber('二十一')).toBe(21);
  });

  it('matches titles without exposing numbering format to callers', () => {
    expect(chapterNumberFromTitle('第17章：回声')).toBe(17);
    expect(chapterNumberFromTitle('第十七章 回声')).toBe(17);
    expect(chapterTitleMatches('第十七章 回声', 17)).toBe(true);
    expect(chapterTitleMatches('第十六章 回声', 17)).toBe(false);
  });
});
