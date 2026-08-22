import { describe, expect, it } from 'vitest';
import {
  assertAuthorContractForGeneration,
  buildBookContextBrief,
  compactNarrativeStateJson,
  excerptLastSentences,
  isUsableStoryOutline,
  listAuthorContractGaps,
} from './book-context';
import { ContextCompileError, FAILURE_CODES } from '../context/failure-envelope';

describe('book context', () => {
  it('rejects chapter-seed dumps pretending to be a story outline', () => {
    expect(isUsableStoryOutline('[[CHAPTER_SEED_START]]\n章节号：2\n[[CHAPTER_SEED_END]]')).toBe(
      false,
    );
    expect(isUsableStoryOutline('# 故事大纲\n1. 第一章：雨夜翻车')).toBe(true);
  });

  it('drops chapter-tail dumps and style diagnostics from narrative state', () => {
    const { json, compact } = compactNarrativeStateJson(
      JSON.stringify({
        canon: [
          { id: 'canon:accepted-chapter:1', fact: '第1章接受稿末段：整章结尾原文……' },
          { id: 'canon:whistle', fact: '现实中出现了十五年前遗失的铜哨' },
        ],
        character: [
          { characterId: '沈砚', field: 'acceptedChapterEvidence', value: '大段正文' },
          { characterId: '沈砚', field: 'participation', value: 'present' },
          { characterId: '沈砚', field: 'currentState', value: '握着铜哨，不信沈建国' },
        ],
        promise: [{ description: '不要相信沈建国', status: 'open', sourceChapter: 'ch1' }],
        pattern: [{ patternType: 'sentence_risk', description: '翻译腔' }],
      }),
    );
    const parsed = JSON.parse(json) as { pattern: unknown[]; canon: unknown[] };
    expect(parsed.pattern).toEqual([]);
    expect(compact.canon.map((item) => item.fact)).toEqual(['现实中出现了十五年前遗失的铜哨']);
    expect(compact.character).toEqual([
      { characterId: '沈砚', field: 'currentState', value: '握着铜哨，不信沈建国' },
    ]);
    expect(compact.promise[0]?.description).toBe('不要相信沈建国');
  });

  it('keeps only the last sentences of previous text for continuity cache', () => {
    const excerpt = excerptLastSentences(
      '很长的前文。苏晴离开了。沈砚握紧铜哨：不要相信沈建国。',
    );
    expect(excerpt).toContain('不要相信沈建国');
    expect(excerpt).not.toContain('很长的前文');
  });

  it('compiles a book working set instead of previous-chapter prose', () => {
    const brief = buildBookContextBrief({
      outline: '# 故事大纲\n1. 第一章：雨夜翻车',
      characterLines: ['沈砚（protagonist）：重生者'],
      compact: {
        canon: [{ fact: '现实中出现了十五年前遗失的铜哨' }],
        character: [{ characterId: '沈砚', field: 'currentState', value: '握着铜哨' }],
        promise: [{ description: '不要相信沈建国', sourceChapter: 'ch1' }],
      },
      previousStop: '沈砚握紧铜哨：不要相信沈建国。',
    });
    expect(brief).toContain('## 大纲');
    expect(brief).toContain('沈砚（protagonist）：重生者');
    expect(brief).toContain('不要相信沈建国（ch1）');
    expect(brief).toContain('现实中出现了十五年前遗失的铜哨');
    expect(brief).toContain('## 前章停点');
    expect(brief).not.toContain('CHAPTER_SEED');
  });

  it('lists missing author materials instead of treating empty fields as ready', () => {
    const gaps = listAuthorContractGaps({
      genre: '',
      constitution: '',
      worldbuilding: '',
      styleProfile: '',
      characters: [{ goals: '', motivation: '', currentState: '', relationships: '' }],
      compact: { canon: [], character: [], promise: [] },
      usableStoryOutline: undefined,
    });
    expect(gaps.blocking).toEqual(expect.arrayContaining([
      '项目类型为空',
      '缺少作者确认的风格档案',
      '缺少作者确认的世界观',
      '缺少作者确认的创作宪法',
    ]));
    expect(gaps.advisory).toEqual(expect.arrayContaining([
      '角色目标/动机/当前状态均为空',
      'canon 事实为空，尚未经作者确认',
      '未结伏笔为空',
      '缺少作者确认的全书大纲',
    ]));
    expect(() => assertAuthorContractForGeneration(gaps)).toThrow(ContextCompileError);
    try {
      assertAuthorContractForGeneration(gaps);
    } catch (error) {
      const envelope = (error as ContextCompileError).envelope;
      expect(envelope.code).toBe(FAILURE_CODES.runtimePreflightFailed);
      expect(envelope.gate).toBe('author_contract');
      expect(envelope.reason).not.toContain('都市');
      expect(envelope.reason).not.toContain('platform-default');
    }
  });

  it('does not block when author genre, style, world, and constitution are present', () => {
    const gaps = listAuthorContractGaps({
      genre: '都市',
      constitution: '# 创作宪法\n不违背已确认身份',
      worldbuilding: '# 世界观\n铜哨是旧案证物',
      styleProfile: '{"editorialGuidance":["克制"]}',
      characters: [{ goals: '查清失踪', motivation: '复仇', currentState: '握着铜哨', relationships: '不信沈建国' }],
      compact: {
        canon: [{ fact: '现实中出现了十五年前遗失的铜哨' }],
        character: [{ characterId: '沈砚', field: 'currentState', value: '握着铜哨' }],
        promise: [{ description: '不要相信沈建国' }],
      },
      usableStoryOutline: '# 大纲\n重生后追查旧案',
    });
    expect(gaps.blocking).toEqual([]);
    expect(gaps.advisory).toEqual([]);
    expect(() => assertAuthorContractForGeneration(gaps)).not.toThrow();
  });
});
