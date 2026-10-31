/**
 * 上下文管理执行规范回归（AGENTS.md「上下文管理执行规范」第 4 条）：
 * 对话历史只保留最近消息，更早轮次被丢弃时必须显式声明省略条数，不得静默丢历史。
 */

import { describe, expect, it } from 'vitest';
import { buildAssistantSystemPrompt } from './assistant-prompt';

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    title: '测试书',
    genre: '都市',
    description: '简介',
    workflowState: 'project_created',
    hasOutline: false,
    characterNames: [],
    chapterCount: 0,
    nextChapterNumber: 1,
    ...overrides,
  };
}

describe('buildAssistantSystemPrompt 历史压缩声明', () => {
  it('未省略历史时不输出省略声明', () => {
    const prompt = buildAssistantSystemPrompt(baseContext());
    expect(prompt).not.toContain('已省略');
  });

  it('省略历史时显式声明条数', () => {
    const prompt = buildAssistantSystemPrompt(baseContext({ historyOmitted: 12 }));
    expect(prompt).toContain('更早的 12 条消息已省略');
  });

  it('historyOmitted 为 0 时等同未省略', () => {
    const prompt = buildAssistantSystemPrompt(baseContext({ historyOmitted: 0 }));
    expect(prompt).not.toContain('已省略');
  });
});
