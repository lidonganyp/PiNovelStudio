/** 生成物化缺省：缺风格档案/空题材不得进入正式 Preflight。 */
import { describe, expect, it } from 'vitest';
import {
  buildExplicitOutlineMarkdown,
  DEFAULT_PROJECT_GENRE,
  describeGenerationFailure,
  resolveProjectGenre,
} from './runtime-workspace-defaults';

describe('runtime workspace defaults', () => {
  it('fills a blank genre so preflight sees a world type', () => {
    expect(resolveProjectGenre('')).toBe(DEFAULT_PROJECT_GENRE);
    expect(resolveProjectGenre('  玄幻  ')).toBe('玄幻');
  });

  it('builds an explicit outline with a parseable event, characters, and summary', () => {
    const markdown = buildExplicitOutlineMarkdown({
      intent: '沈砚在雨夜发现旧案卷宗',
      mustInclude: '旧案卷宗',
      forbiddenFacts: '穿越',
      characterMotives: '沈砚要查清失踪',
      promises: '卷宗指向失踪名单',
      endingGoal: '沈砚决定连夜追查',
      characterNames: ['沈砚'],
    });

    expect(markdown).toContain('## 事件 1：沈砚在雨夜发现旧案卷宗');
    expect(markdown).toContain('参与角色：沈砚');
    expect(markdown).toContain('内容摘要：沈砚在雨夜发现旧案卷宗。旧案卷宗。沈砚要查清失踪');
    expect(markdown).toContain('章末目标：沈砚决定连夜追查');
    expect(markdown).not.toMatch(/^必须包含：/m);
    expect(markdown).toMatch(/^\s*参与角色：.+$/m);
    expect(markdown).toMatch(/^\s*内容摘要：.+$/m);
  });

  it('keeps the real runtime failure reason instead of a generic label', () => {
    expect(describeGenerationFailure(new Error('no active production release set'))).toBe(
      'no active production release set',
    );
  });
});
