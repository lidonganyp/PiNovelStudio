import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertNoFullPreviousChapter,
  compileProjectContext,
  findStateHashMismatch,
  hashChapterText,
  searchChapterCollectionSpans,
  searchChapterSpans,
} from './context-compiler';
import { estimateTokens, totalBudget } from './token-budget';
import { ContextCompileError, FAILURE_CODES } from './failure-envelope';
import {
  FIXTURE_CHAPTER_ONE,
  FIXTURE_CHAPTER_TWO_SEED,
  FIXTURE_CHARACTERS,
  FIXTURE_POLLUTED_OUTLINE,
  FIXTURE_STORY_OUTLINE,
  makeStaleNarrativeState,
  STALE_STATE_HASH,
} from './fixtures';

describe('ContextCompiler', () => {
  it('includes a compact catalog for every chapter without injecting full chapter prose', () => {
    const compiled = compileProjectContext({
      characters: FIXTURE_CHARACTERS,
      supportingMaterials: [{ documentType: 'equipment', title: '道具表', content: '铜钥匙：开启北门；黑曜石：封存记忆。' }],
      chapterCatalog: [
        { chapterNumber: 1, title: '醒来', status: 'generated', wordCount: 1200, content: `${'第一章正文，包含旧钟和失踪的钥匙。'.repeat(20)}停在北门。`, seed: null },
        { chapterNumber: 2, title: '旧钟', status: 'generated', wordCount: 1300, content: '第二章正文，沈砚发现钥匙上的血迹。', seed: { intent: '追查钥匙', mustInclude: '', forbiddenFacts: '', characterMotives: '', promises: '查明血迹来源', endingGoal: '留下追踪线索' } },
        { chapterNumber: 17, title: '回声', status: 'draft', wordCount: 0, content: '', seed: null },
      ],
    });
    const catalog = compiled.manifest.blocks.find((block) => block.name === 'chapterCatalog');
    expect(catalog?.included).toBe(true);
    expect(compiled.bookBrief).toContain('第1章｜醒来');
    expect(compiled.bookBrief).toContain('第17章｜回声');
    expect(compiled.bookBrief).toContain('铜钥匙：开启北门');
    expect(compiled.bookBrief).not.toContain('第一章正文，包含旧钟和失踪的钥匙。'.repeat(20));
  });

  it('keeps character relationships, personality, equipment, secrets, and arc in the context', () => {
    const compiled = compileProjectContext({
      characters: [{
        name: '沈砚', roleType: 'protagonist', identity: '调查者',
        goals: '查清真相', motivation: '寻找父亲', currentState: '持有铜钥匙',
        relationships: '与林默互信未稳', personality: '谨慎', abilities: '铜钥匙',
        secrets: '隐瞒旧案', characterArc: '从逃避到承担', notes: '不可轻信陌生人',
      }],
    });
    expect(compiled.bookBrief).toContain('关系：与林默互信未稳');
    expect(compiled.bookBrief).toContain('能力/装备：铜钥匙');
    expect(compiled.bookBrief).toContain('人物弧：从逃避到承担');
  });

  it('searches bounded evidence across historical chapters', () => {
    const spans = searchChapterCollectionSpans({
      chapters: [
        { chapterNumber: 1, content: '沈砚第一次听见旧钟的回声。' },
        { chapterNumber: 12, content: `${'无关内容。'.repeat(80)}钥匙上的血迹指向北门。` },
      ],
      query: '血迹',
      purpose: 'query_project',
    });
    expect(spans[0].chapterNumber).toBe(12);
    expect(spans[0].text).toContain('血迹');
    expect(spans[0].text.length).toBeLessThan(12 * 100);
  });

  it('rejects polluted story outlines and does not copy chapter-seed dumps', () => {
    const compiled = compileProjectContext({
      storyOutline: { id: 1, content: FIXTURE_POLLUTED_OUTLINE, currentVersion: 3 },
      chapterSeed: FIXTURE_CHAPTER_TWO_SEED,
      characters: FIXTURE_CHARACTERS,
      previousChapter: { chapterNumber: 1, content: FIXTURE_CHAPTER_ONE },
    });
    expect(compiled.usableStoryOutline).toBeUndefined();
    expect(compiled.bookBrief).not.toContain('CHAPTER_SEED');
    expect(compiled.bookBrief).not.toContain('GENERATE_CHAPTER');
    expect(compiled.manifest.blocks.find((block) => block.name === 'storyOutline')?.included).toBe(false);
  });

  it('compiles layered continuation instead of previous-chapter prose', () => {
    const compiled = compileProjectContext({
      storyOutline: { content: FIXTURE_STORY_OUTLINE },
      chapterSeed: FIXTURE_CHAPTER_TWO_SEED,
      characters: FIXTURE_CHARACTERS,
      narrativeState: { content: JSON.stringify({
        canon: [{ id: 'canon:whistle', fact: '现实中出现了十五年前遗失的铜哨' }],
        character: [{ characterId: '沈砚', field: 'currentState', value: '握着铜哨' }],
        promise: [{ description: '不要相信沈建国', status: 'open', sourceChapter: 'ch1' }],
      }) },
      previousChapter: { chapterNumber: 1, content: FIXTURE_CHAPTER_ONE },
    });
    expect(compiled.previousChapterContinuation?.tailExcerpt).toContain('不要相信沈建国');
    expect(compiled.previousChapterContinuation?.tailExcerpt).not.toContain('电动车穿过跨江大桥');
    expect(compiled.previousChapterContinuation?.sourceChapterHash).toBe(hashChapterText(FIXTURE_CHAPTER_ONE));
    expect(compiled.bookBrief).not.toContain(FIXTURE_CHAPTER_ONE);
    const names = compiled.manifest.blocks.filter((block) => block.included).map((block) => block.name);
    expect(names).toEqual(expect.arrayContaining([
      'storyOutline',
      'chapterSeed',
      'characterStates',
      'canonState',
      'promiseLedger',
      'previousChapterContinuation',
    ]));
  });

  it('blocks state hash mismatch before generation', () => {
    const mismatch = findStateHashMismatch(
      makeStaleNarrativeState(),
      { chapterNumber: 1, content: FIXTURE_CHAPTER_ONE },
    );
    expect(mismatch?.expected).toBe(STALE_STATE_HASH);
    expect(mismatch?.actual).toBe(hashChapterText(FIXTURE_CHAPTER_ONE));
    expect(mismatch?.actual).not.toBe(STALE_STATE_HASH);
    try {
      compileProjectContext({
        characters: FIXTURE_CHARACTERS,
        narrativeState: { content: makeStaleNarrativeState() },
        previousChapter: { chapterNumber: 1, content: FIXTURE_CHAPTER_ONE },
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextCompileError);
      expect((error as ContextCompileError).envelope.code).toBe(
        FAILURE_CODES.stateStoreHashMismatch,
      );
    }
  });

  it('limits evidence spans and never returns the full chapter', () => {
    const long = `${'前文很长。'.repeat(80)}铜哨再现。${'后文也很长。'.repeat(80)}`;
    const spans = searchChapterSpans({
      chapterNumber: 1,
      content: long,
      query: '铜哨再现',
      purpose: 'query_project',
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toContain('铜哨再现');
    expect(spans[0].text.length).toBeLessThan(long.length);
    expect(spans[0].text).not.toBe(long);
  });

  it('detects a leaked full previous chapter in a production payload', () => {
    const previous = `${FIXTURE_CHAPTER_ONE}${'。补足长度让全文足够长。'.repeat(8)}`;
    try {
      assertNoFullPreviousChapter(
        { previousChapterText: previous, prompt: previous },
        previous,
      );
      throw new Error('expected failure');
    } catch (error) {
      expect((error as ContextCompileError).envelope.code).toBe(
        FAILURE_CODES.runtimePreflightFailed,
      );
    }
  });

  it('uses sha256-12 for chapter hashes', () => {
    const expected = createHash('sha256').update(FIXTURE_CHAPTER_ONE, 'utf8').digest('hex').slice(0, 12);
    expect(hashChapterText(FIXTURE_CHAPTER_ONE)).toBe(expected);
  });

  it('keeps bookBrief within the same total token budget as the manifest', () => {
    const huge = `${'很长的前文。'.repeat(8000)}沈砚握紧铜哨：不要相信沈建国。`;
    const compiled = compileProjectContext({
      storyOutline: { content: `# 故事大纲\n${huge}` },
      constitution: { content: huge },
      worldbuilding: { content: huge },
      styleProfile: { content: huge },
      chapterSeed: FIXTURE_CHAPTER_TWO_SEED,
      currentChapterOutline: { content: huge },
      characters: FIXTURE_CHARACTERS,
      previousChapter: { chapterNumber: 1, content: huge },
      evidenceQuery: { query: '铜哨', purpose: 'query_project' },
    });
    expect(estimateTokens(compiled.bookBrief)).toBeLessThanOrEqual(totalBudget());
    expect(compiled.bookBrief).not.toContain(huge);
    expect(compiled.manifest.blocks.find((block) => block.name === 'creativeConstitution')?.included).toBe(true);
    expect(compiled.manifest.blocks.find((block) => block.name === 'worldbuilding')?.included).toBe(true);
    expect(compiled.manifest.blocks.find((block) => block.name === 'styleProfile')?.included).toBe(true);
    expect(compiled.manifest.blocks.find((block) => block.name === 'currentChapterOutline')?.included).toBe(true);
    expect(compiled.bookBrief).toContain('## 世界观');
  });
});
