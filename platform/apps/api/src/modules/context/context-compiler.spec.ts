import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertNoFullPreviousChapter,
  compileProjectContext,
  findStateHashMismatch,
  hashChapterText,
  reanchorNarrativeStateToChapter,
  searchChapterCollectionSpans,
  searchChapterSpans,
} from './context-compiler';
import {
  estimateTokens,
  getContextBudgetProfile,
  totalBudget,
} from './token-budget';
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

  it('reanchors only final-text references for the edited chapter', () => {
    const actualHash = hashChapterText(FIXTURE_CHAPTER_ONE);
    const result = reanchorNarrativeStateToChapter(
      makeStaleNarrativeState(),
      1,
      actualHash,
    );
    expect(result.updatedEntries).toBe(2);
    expect(result.content).toContain(`ch1#finalText:${actualHash}:0-40`);
    expect(result.content).toContain(`ch1#finalText:${actualHash}:12-40`);
    expect(findStateHashMismatch(result.content, {
      chapterNumber: 1,
      content: FIXTURE_CHAPTER_ONE,
    })).toBeNull();
  });

  it('accepts legacy numeric chapters, sourceRef arrays, and nested memory references', () => {
    const narrative = JSON.stringify({
      canon: [{
        sourceChapter: 1,
        sourceRef: ['ch1#finalText:deadbeefcafe:0-40'],
        memory: {
          sourceChapter: 1,
          sourceRef: ['ch1#finalText:deadbeefcafe:0-40'],
        },
      }],
    });
    const mismatch = findStateHashMismatch(narrative, {
      chapterNumber: 1,
      content: FIXTURE_CHAPTER_ONE,
    });
    expect(mismatch?.expected).toBe('deadbeefcafe');

    const actualHash = hashChapterText(FIXTURE_CHAPTER_ONE);
    const repaired = reanchorNarrativeStateToChapter(narrative, 1, actualHash);
    expect(repaired.updatedEntries).toBe(1);
    const parsed = JSON.parse(repaired.content) as {
      canon: [{ sourceChapter: string; sourceRef: string[]; memory: { sourceChapter: string; sourceRef: string[] } }];
    };
    expect(parsed.canon[0].sourceChapter).toBe('ch1');
    expect(parsed.canon[0].sourceRef[0]).toContain(`ch1#finalText:${actualHash}`);
    expect(parsed.canon[0].memory.sourceChapter).toBe('ch1');
    expect(parsed.canon[0].memory.sourceRef[0]).toContain(`ch1#finalText:${actualHash}`);
    expect(findStateHashMismatch(repaired.content, {
      chapterNumber: 1,
      content: FIXTURE_CHAPTER_ONE,
    })).toBeNull();
  });

  it('moves references when a chapter number is manually changed', () => {
    const actualHash = hashChapterText(FIXTURE_CHAPTER_ONE);
    const result = reanchorNarrativeStateToChapter(
      makeStaleNarrativeState(),
      7,
      actualHash,
      1,
    );
    expect(result.content).toContain(`"sourceChapter": "ch7"`);
    expect(result.content).toContain(`ch7#finalText:${actualHash}`);
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
    expect(hashChapterText(`\uFEFF  ${FIXTURE_CHAPTER_ONE}  `)).toBe(expected);
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

  it('keeps the full story outline for authorization while clipping the prompt copy', () => {
    const huge = `${'很长的前文。'.repeat(8000)}魂玉可以封印伤势。`;
    const compiled = compileProjectContext({
      storyOutline: { content: `# 故事大纲\n${huge}` },
      chapterSeed: FIXTURE_CHAPTER_TWO_SEED,
      characters: FIXTURE_CHARACTERS,
    });
    // 提示词副本受 storyOutline 块预算裁剪，尾部高影响术语被丢弃。
    expect(compiled.usableStoryOutline).toBeDefined();
    expect(compiled.usableStoryOutline).not.toContain('封印');
    // 授权副本必须保留全文，否则 FactGuard 会把大纲已有术语误判为未授权新设定。
    expect(compiled.fullStoryOutline).toContain('封印');
    expect(estimateTokens(compiled.fullStoryOutline ?? '')).toBeGreaterThan(totalBudget());
  });

  it('does not emit a full story outline when the outline is unusable', () => {
    const compiled = compileProjectContext({
      storyOutline: { id: 1, content: FIXTURE_POLLUTED_OUTLINE, currentVersion: 3 },
      chapterSeed: FIXTURE_CHAPTER_TWO_SEED,
      characters: FIXTURE_CHARACTERS,
    });
    expect(compiled.fullStoryOutline).toBeUndefined();
  });

  it('supports 128k/256k/512k context profiles without changing authorization material', () => {
    expect(getContextBudgetProfile('128k').totalTokenBudget).toBe(128_000);
    expect(getContextBudgetProfile('256k').totalTokenBudget).toBe(256_000);
    expect(getContextBudgetProfile('512k').totalTokenBudget).toBe(512_000);
    expect(totalBudget('128k')).toBe(128_000);

    const longOutline = `${'大纲历史节点。'.repeat(10_000)}魂玉可以封印伤势。`;
    const compiled = compileProjectContext({
      contextProfile: '128k',
      storyOutline: { content: `# 故事大纲\n${longOutline}` },
      chapterSeed: FIXTURE_CHAPTER_TWO_SEED,
      characters: FIXTURE_CHARACTERS,
    });
    expect(compiled.manifest.totalTokenBudget).toBe(128_000);
    expect(compiled.manifest.blocks.find((block) => block.name === 'storyOutline')?.tokenBudget)
      .toBeGreaterThan(4_000);
    expect(compiled.fullStoryOutline).toContain('封印');
    expect(compiled.manifest.truncatedBlocks).toEqual(expect.arrayContaining(['storyOutline']));
  });

  it('assembles recent chapter memory and query-ranked historical evidence with coverage', () => {
    const chapters = Array.from({ length: 9 }, (_, index) => ({
      chapterNumber: index + 1,
      title: `章节${index + 1}`,
      status: 'generated',
      wordCount: 120,
      content: `第${index + 1}章正文。${index === 2 ? '远期线索-铜哨' : '普通推进'}。${'细节。'.repeat(20)}`,
      seed: null,
    }));
    const compiled = compileProjectContext({
      contextProfile: '128k',
      chapterSeed: { ...FIXTURE_CHAPTER_TWO_SEED, chapterNumber: 10 },
      characters: FIXTURE_CHARACTERS,
      chapterCatalog: chapters,
      previousChapter: chapters[8],
      historicalQueries: ['远期线索-铜哨'],
    });
    const recent = compiled.manifest.blocks.find((block) => block.name === 'recentChapterContent');
    expect(recent?.included).toBe(true);
    expect(compiled.bookBrief).toContain('第7章正文');
    expect(compiled.bookBrief).not.toContain(chapters[8].content);
    expect(compiled.selectedEvidenceSpans[0]?.text).toContain('远期线索-铜哨');
    expect(compiled.manifest.retrievalCoverage).toMatchObject({
      requestedQueries: 1,
      matchedQueries: 1,
      recentChaptersIncluded: expect.any(Number),
    });
  });
});
