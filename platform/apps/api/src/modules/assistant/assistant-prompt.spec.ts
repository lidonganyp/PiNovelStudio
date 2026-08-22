import { describe, expect, it } from 'vitest';
import { buildAssistantSystemPrompt } from './assistant-prompt';

describe('assistant prompt continuation', () => {
  it('gives the planner a book working set instead of previous-chapter prose', () => {
    const prompt = buildAssistantSystemPrompt({
      title: '试书',
      genre: '都市',
      description: '',
      workflowState: 'generated',
      hasOutline: true,
      characterNames: ['沈砚'],
      chapterCount: 1,
      nextChapterNumber: 2,
      action: 'plan_chapter',
      bookContext: '## 未结伏笔/承诺\n- 不要相信沈建国',
    });
    expect(prompt).toContain('全书工作集');
    expect(prompt).toContain('不要相信沈建国');
    expect(prompt).toContain('不要复述上一章已经发生的情节');
    expect(prompt).not.toContain('上一章结尾原文');
    expect(prompt).toContain('只产出指定章节种子');
    expect(prompt).toContain('"chapterSeed"');
    expect(prompt).not.toContain('[[CHAPTER_SEED_START]]');
    expect(prompt).not.toContain('[[OUTLINE_START]]');
    expect(prompt).not.toContain('[[GENERATE_CHAPTER');
  });
});
