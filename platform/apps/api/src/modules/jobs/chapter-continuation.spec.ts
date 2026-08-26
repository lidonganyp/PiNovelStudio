import { describe, expect, it } from 'vitest';
import { inferContinuationMode, mergeChapterContinuation } from './chapter-continuation';

describe('chapter continuation helpers', () => {
  it('detects explicit continuation language', () => {
    expect(inferContinuationMode('接着我已经写完的部分继续写，补满2500字，不要覆盖原文')).toBe('append');
    expect(inferContinuationMode('续写第17章，从上一段接着写')).toBe('append');
  });

  it('returns undefined when the message carries no explicit signal', () => {
    expect(inferContinuationMode('请生成第17章完整正文')).toBeUndefined();
    expect(inferContinuationMode('生成下一章')).toBeUndefined();
    expect(inferContinuationMode('')).toBeUndefined();
  });

  it('detects explicit rewrite language', () => {
    expect(inferContinuationMode('重写第17章')).toBe('replace');
    expect(inferContinuationMode('对第17章不满意，推倒重来')).toBe('replace');
  });

  it('lets append signals win over replace signals', () => {
    expect(inferContinuationMode('不要重写，接着已有内容继续写')).toBe('append');
    expect(inferContinuationMode('保留已有正文，覆盖重写的部分')).toBe('append');
  });

  it('keeps the existing prefix when the model returns only a suffix', () => {
    expect(mergeChapterContinuation('已有正文停在这里。', '从门外传来脚步声。'))
      .toBe('已有正文停在这里。\n\n从门外传来脚步声。');
  });

  it('does not duplicate a model result that already contains the prefix', () => {
    expect(mergeChapterContinuation('已有正文。', '已有正文。\n\n新的段落。'))
      .toBe('已有正文。\n\n新的段落。');
  });

  it('returns an empty-prefix result unchanged', () => {
    expect(mergeChapterContinuation('', '新正文')).toBe('新正文');
  });
});
