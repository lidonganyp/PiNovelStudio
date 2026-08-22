import { describe, expect, it } from 'vitest';
import { FailureHttpException } from './failure-envelope';
import { parseAssistantRequest, assertArtifactAllowed } from './assistant-contract';
import { FAILURE_CODES } from './failure-envelope';

describe('assistant action contract', () => {
  it('accepts missing action as auto mode', () => {
    const request = parseAssistantRequest({ content: '写大纲' });
    expect(request.action).toBeUndefined();
    expect(request.chapterNumber).toBeUndefined();
    expect(request.confirmGeneration).toBe(false);
  });

  it('rejects an invalid action value', () => {
    try {
      parseAssistantRequest({ content: '写大纲', action: 'rewrite_book' });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(FailureHttpException);
      expect((error as FailureHttpException).envelope.code).toBe(FAILURE_CODES.illegalAction);
    }
  });

  it('requires chapter number for plan_chapter and generate_chapter', () => {
    try {
      parseAssistantRequest({ content: '写第二章种子', action: 'plan_chapter' });
      throw new Error('expected failure');
    } catch (error) {
      expect((error as FailureHttpException).envelope.code).toBe(FAILURE_CODES.missingChapterNumber);
    }
  });

  it('requires explicit generation confirmation', () => {
    try {
      parseAssistantRequest({
        content: '生成第二章',
        action: 'generate_chapter',
        chapterNumber: 2,
      });
      throw new Error('expected failure');
    } catch (error) {
      expect((error as FailureHttpException).envelope.code).toBe(
        FAILURE_CODES.generationUnconfirmed,
      );
    }
  });

  it('accepts a confirmed generate_chapter request', () => {
    const request = parseAssistantRequest({
      content: '生成第二章',
      action: 'generate_chapter',
      chapterNumber: 2,
      confirmGeneration: true,
    });
    expect(request.action).toBe('generate_chapter');
    expect(request.chapterNumber).toBe(2);
  });

  it('blocks story_outline artifacts on plan_chapter', () => {
    try {
      assertArtifactAllowed('plan_chapter', 'story_outline');
      throw new Error('expected failure');
    } catch (error) {
      expect((error as FailureHttpException).envelope.code).toBe(
        FAILURE_CODES.artifactActionMismatch,
      );
    }
  });

  it('blocks chapter_seed artifacts on plan_story_outline', () => {
    try {
      assertArtifactAllowed('plan_story_outline', 'chapter_seed');
      throw new Error('expected failure');
    } catch (error) {
      expect((error as FailureHttpException).envelope.code).toBe(
        FAILURE_CODES.artifactActionMismatch,
      );
    }
  });
});
