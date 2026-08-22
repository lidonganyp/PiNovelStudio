import { describe, expect, it } from 'vitest';
import { FailureHttpException, FAILURE_CODES } from '../context/failure-envelope';
import { parsePlannerEnvelope } from './planner-envelope';

describe('parsePlannerEnvelope', () => {
  it('accepts JSON outline for plan_story_outline and ignores generate markers', () => {
    const envelope = parsePlannerEnvelope(
      JSON.stringify({
        reply: '已拟好全书大纲 [[GENERATE_CHAPTER:1]]',
        storyOutline: '# 故事大纲\n1. 第一章：雨夜',
        characters: [{ name: '沈砚', roleType: 'protagonist', description: '重生者' }],
      }),
      'plan_story_outline',
    );
    expect(envelope.reply).toBe('已拟好全书大纲');
    expect(envelope.storyOutline).toContain('第一章：雨夜');
    expect(envelope.characters?.[0]?.name).toBe('沈砚');
    expect(envelope.chapterSeed).toBeUndefined();
  });

  it('does not treat marker dumps as production output', () => {
    try {
      parsePlannerEnvelope(
        '[[OUTLINE_START]]\n# 故事大纲\n1. 第一章\n[[OUTLINE_END]]\n[[GENERATE_CHAPTER:1]]',
        'plan_story_outline',
      );
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(FailureHttpException);
      expect((error as FailureHttpException).envelope.code).toBe(
        FAILURE_CODES.plannerSchemaInvalid,
      );
    }
  });

  it('keeps query_project free text as reply and does not parse markers into artifacts', () => {
    const envelope = parsePlannerEnvelope(
      '现有大纲还缺世界观。\n[[OUTLINE_START]]\n# 故事大纲\n[[OUTLINE_END]]',
      'query_project',
    );
    expect(envelope.reply).toContain('现有大纲还缺世界观');
    expect(envelope.storyOutline).toBeUndefined();
    expect(envelope.chapterSeed).toBeUndefined();
  });

  it('auto mode infers plan_story_outline from the model action field', () => {
    const envelope = parsePlannerEnvelope(
      JSON.stringify({
        action: 'plan_story_outline',
        reply: '已拟好全书大纲',
        storyOutline: '# 故事大纲\n1. 第一章：雨夜',
        characters: [{ name: '沈砚', roleType: 'protagonist', description: '重生者' }],
      }),
    );
    expect(envelope.action).toBe('plan_story_outline');
    expect(envelope.reply).toBe('已拟好全书大纲');
    expect(envelope.storyOutline).toContain('第一章：雨夜');
    expect(envelope.characters?.[0]?.name).toBe('沈砚');
  });

  it('auto mode keeps query_project JSON as reply only', () => {
    const envelope = parsePlannerEnvelope(
      JSON.stringify({ action: 'query_project', reply: '这是查询回复' }),
    );
    expect(envelope.action).toBe('query_project');
    expect(envelope.reply).toBe('这是查询回复');
    expect(envelope.storyOutline).toBeUndefined();
    expect(envelope.chapterSeed).toBeUndefined();
  });

  it('auto mode treats plain text as query_project fallback', () => {
    const envelope = parsePlannerEnvelope('先聊聊你的想法吧');
    expect(envelope.action).toBe('query_project');
    expect(envelope.reply).toBe('先聊聊你的想法吧');
  });

  it('auto mode rejects JSON without a valid action field', () => {
    try {
      parsePlannerEnvelope(JSON.stringify({ reply: '缺少动作字段' }));
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(FailureHttpException);
      expect((error as FailureHttpException).envelope.code).toBe(
        FAILURE_CODES.plannerSchemaInvalid,
      );
    }
  });
});
