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

  it('extracts the requested final chapter length from a fill-to command', () => {
    const request = parseAssistantRequest({
      content: '根据小说大纲，完善第十七章，补满2500字',
    });

    expect(request.targetWordCount).toEqual({ min: 2500, max: 2750 });
  });

  it('does not confuse a chapter number with a target length', () => {
    const request = parseAssistantRequest({ content: '完善第十七章' });

    expect(request.targetWordCount).toBeUndefined();
  });

  it('rejects an invalid explicit target range', () => {
    expect(() => parseAssistantRequest({
      content: '完善第十七章',
      targetWordCount: { min: 3000, max: 2500 },
    })).toThrowError(FailureHttpException);
  });

  it('parses steward confirmation protocol fields', () => {
    const request = parseAssistantRequest({
      content: '采用并继续生成',
      stewardAction: 'apply_and_generate',
      proposalId: 'prop-1',
      sourceVersion: 'abc123',
      confirmedFields: ['genre', 'worldbuilding'],
    });
    expect(request.stewardAction).toBe('apply_and_generate');
    expect(request.proposalId).toBe('prop-1');
    expect(request.sourceVersion).toBe('abc123');
    expect(request.confirmedFields).toEqual(['genre', 'worldbuilding']);
  });

  it('requires a proposal identity for every steward action', () => {
    expect(() => parseAssistantRequest({
      content: '修改方案',
      stewardAction: 'revise',
    })).toThrowError(FailureHttpException);
  });

  it('rejects unknown steward actions instead of treating them as a new generation request', () => {
    expect(() => parseAssistantRequest({
      content: '继续',
      stewardAction: 'submit_anyway',
      proposalId: 'prop-1',
      sourceVersion: 'v1',
    })).toThrowError(FailureHttpException);
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
