import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { FIXTURE_CHAPTER_ONE, FIXTURE_STORY_OUTLINE, makeStaleNarrativeState } from './fixtures';
import {
  compileProjectContextSnapshot,
  loadOwnedProjectContext,
} from './project-context-reader';
import { classifyMaterialReadiness } from './material-readiness';

function baseRecords(overrides: Partial<Parameters<typeof compileProjectContextSnapshot>[0]> = {}) {
  return {
    userId: 7,
    project: {
      id: 128,
      userId: 7,
      title: '铜哨',
      description: '',
      genre: '',
      subGenres: [],
      worldKeyTerms: [],
      version: 3,
      deletedAt: null,
    },
    documents: [
      {
        id: 83,
        documentType: 'story_outline',
        content: FIXTURE_STORY_OUTLINE,
        currentVersion: 2,
        updatedAt: new Date('2026-08-21T00:00:00Z'),
      },
    ],
    characters: [
      {
        id: 1,
        name: '沈砚',
        roleType: 'protagonist',
        identity: '重生者',
        goals: '',
        motivation: '',
        currentState: '',
        relationships: '',
        secrets: '',
        characterArc: '',
        version: 1,
      },
    ],
    outlineNodes: [
      {
        title: '第二章：不要相信沈建国',
        summary: '沈砚带着铜哨追查父亲留下的禁令',
        nodeType: 'chapter',
        narrativeGoal: '推进禁令压力',
        version: 1,
      },
    ],
    chapters: [
      {
        chapterNumber: 1,
        title: '第一章',
        content: FIXTURE_CHAPTER_ONE,
        wordCount: FIXTURE_CHAPTER_ONE.length,
        version: 2,
        seed: {
          intent: '车祸重生',
          mustInclude: '铜哨',
          forbiddenFacts: '',
          characterMotives: '',
          promises: '不要相信沈建国',
          endingGoal: '留下铜哨悬念',
          version: 1,
        },
      },
    ],
    ...overrides,
  };
}

describe('project context reader', () => {
  it('keeps previous-chapter excerpts and never embeds the full chapter as the working set', () => {
    const snapshot = compileProjectContextSnapshot(baseRecords());
    expect(snapshot.projectId).toBe(128);
    expect(snapshot.chapters[0]?.excerpt.length).toBeLessThanOrEqual(FIXTURE_CHAPTER_ONE.length);
    expect(snapshot.previousContinuation?.tailExcerpt).toContain('不要相信沈建国');
    expect(snapshot.previousContinuation?.tailExcerpt).not.toContain('电动车穿过跨江大桥');
    expect(JSON.stringify(snapshot.chapters)).not.toContain(FIXTURE_CHAPTER_ONE.repeat(2));
  });

  it('refuses to compile another user\'s project', () => {
    expect(() => compileProjectContextSnapshot(baseRecords({
      userId: 99,
    }))).toThrow(NotFoundException);
  });

  it('surfaces state hash mismatch as snapshot evidence', () => {
    const snapshot = compileProjectContextSnapshot(baseRecords({
      documents: [
        {
          id: 84,
          documentType: 'narrative_state',
          content: makeStaleNarrativeState(),
          currentVersion: 1,
          updatedAt: new Date(),
        },
      ],
    }));
    expect(snapshot.hashMismatch?.expected).toBeDefined();
    expect(snapshot.hashMismatch?.actual).not.toBe(snapshot.hashMismatch?.expected);
  });

  it('scopes every reader query to the current user and project', async () => {
    const prisma = {
      novelProject: { findFirst: vi.fn().mockResolvedValue(null) },
      novelDocument: { findMany: vi.fn().mockResolvedValue([]) },
      novelCharacter: { findMany: vi.fn().mockResolvedValue([]) },
      novelOutlineNode: { findMany: vi.fn().mockResolvedValue([]) },
      novelChapter: { findMany: vi.fn().mockResolvedValue([]) },
    };
    await expect(loadOwnedProjectContext(prisma as never, 7, 128)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.novelProject.findFirst).toHaveBeenCalledWith({
      where: { id: 128, userId: 7, deletedAt: null },
    });
    expect(prisma.novelDocument.findMany).toHaveBeenCalledWith({
      where: { projectId: 128, userId: 7, deletedAt: null },
    });
    expect(prisma.novelCharacter.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 128, userId: 7, deletedAt: null },
    }));
    expect(prisma.novelChapter.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 128, userId: 7, deletedAt: null },
    }));
  });
  it('treats empty canon/promise ledgers as a valid state instead of requiring confirmation', () => {
    const snapshot = compileProjectContextSnapshot(baseRecords({
      project: {
        id: 128, userId: 7, title: 'Project', description: 'genre',
        genre: 'genre', subGenres: ['sub'], worldKeyTerms: ['term'], version: 4,
      },
      documents: [
        { id: 1, documentType: 'story_outline', content: FIXTURE_STORY_OUTLINE, currentVersion: 1, updatedAt: new Date() },
        { id: 2, documentType: 'worldbuilding', content: 'world', currentVersion: 1, updatedAt: new Date() },
        { id: 3, documentType: 'creative_constitution', content: 'constitution', currentVersion: 1, updatedAt: new Date() },
        { id: 4, documentType: 'style_profile', content: 'style', currentVersion: 1, updatedAt: new Date() },
      ],
      characters: [{
        id: 1, name: 'Protagonist', roleType: 'protagonist', identity: 'identity',
        goals: 'goal', motivation: 'motivation', currentState: 'state',
        relationships: '', secrets: '', characterArc: '', version: 2,
      }],
      chapters: [{
        chapterNumber: 2, title: 'Chapter 2', content: '', wordCount: 0, version: 1,
        seed: { intent: 'intent', mustInclude: '', forbiddenFacts: '', characterMotives: '', promises: '', endingGoal: 'ending', version: 1 },
      }],
    }));
    const readiness = classifyMaterialReadiness(snapshot, 2);
    expect(readiness.status).toBe('ready');
    expect(readiness.missing).not.toContain('Canon');
    expect(readiness.missing).not.toContain('伏笔/承诺');
    expect(readiness.proposals.some((row) => row.field === 'canon' || row.field === 'promises')).toBe(false);
  });

  it('reads chapter versions, feedback, assistant history, and generation records in project scope', async () => {
    const records = baseRecords();
    const prisma = {
      novelProject: { findFirst: vi.fn().mockResolvedValue(records.project) },
      novelDocument: { findMany: vi.fn().mockResolvedValue(records.documents) },
      novelCharacter: { findMany: vi.fn().mockResolvedValue(records.characters) },
      novelOutlineNode: { findMany: vi.fn().mockResolvedValue(records.outlineNodes) },
      novelChapter: { findMany: vi.fn().mockResolvedValue(records.chapters) },
      novelChapterVersion: { findMany: vi.fn().mockResolvedValue([{ id: 1, chapterId: 1, chapterNumber: 1, versionNumber: 1, content: 'old', source: 'manual_save', generationJobId: null, createdAt: new Date() }]) },
      novelFeedback: { findMany: vi.fn().mockResolvedValue([{ id: 2, chapterId: 1, type: 'user', content: 'keep the hook', createdAt: new Date() }]) },
      novelAssistantMessage: { findMany: vi.fn().mockResolvedValue([{ id: 3, role: 'user', content: '生成第二章', createdAt: new Date() }]) },
      novelGenerationJob: { findMany: vi.fn().mockResolvedValue([{ jobId: 'job-1', chapterId: 1, status: 'succeeded', progressStage: 'saved', failureMessage: null, completedAt: new Date() }]) },
    };
    const snapshot = await loadOwnedProjectContext(prisma as never, 7, 128);
    expect(snapshot.chapterVersions).toHaveLength(1);
    expect(snapshot.feedback).toHaveLength(1);
    expect(snapshot.assistantHistory).toHaveLength(1);
    expect(snapshot.generationJobs).toHaveLength(1);
    expect(prisma.novelFeedback.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: 128, userId: 7 } }));
  });
});

describe('material readiness', () => {
  it('asks for confirmation instead of hard-blocking missing genre, world, constitution, and style', () => {
    const snapshot = compileProjectContextSnapshot(baseRecords());
    const readiness = classifyMaterialReadiness(snapshot, 2);
    expect(readiness.status).toBe('confirmation_required');
    expect(readiness.missing).toEqual(expect.arrayContaining(['项目类型', '世界观', '创作宪法', '风格档案']));
    expect(readiness.proposals.every((row) => row.field === 'chapter_seed' || row.requiresConfirmation || row.field === 'character_states')).toBe(true);
    expect(JSON.stringify(readiness.proposals)).not.toContain('platform-default');
    expect(readiness.proposals.find((row) => row.field === 'genre')?.value).not.toBe('都市');
  });

  it('infers sourced proposals from outline and chapter 1 without using platform defaults', () => {
    const snapshot = compileProjectContextSnapshot(baseRecords());
    const readiness = classifyMaterialReadiness(snapshot, 2);
    const world = readiness.proposals.find((row) => row.field === 'worldbuilding');
    expect(world?.value).toContain('铜哨');
    expect(world?.source.some((item) => item.startsWith('chapter:') || item === 'story_outline')).toBe(true);
    const seed = readiness.proposals.find((row) => row.field === 'chapter_seed');
    expect(seed?.value).toContain('不要相信沈建国');
    expect(seed?.requiresConfirmation).toBe(false);
    const style = readiness.proposals.find((row) => row.field === 'style_profile');
    expect(style?.requiresConfirmation).toBe(true);
    expect(style?.value).not.toContain('platform-default');
  });

  it('marks hash mismatch as hard_blocked', () => {
    const snapshot = compileProjectContextSnapshot(baseRecords({
      documents: [
        {
          id: 84,
          documentType: 'narrative_state',
          content: makeStaleNarrativeState(),
          currentVersion: 1,
          updatedAt: new Date(),
        },
      ],
    }));
    const readiness = classifyMaterialReadiness(snapshot, 2);
    expect(readiness.status).toBe('hard_blocked');
    expect(readiness.hardBlockReason).toContain('哈希');
  });

  it('does not hard-block an empty project; it asks for confirmation without platform defaults', () => {
    const snapshot = compileProjectContextSnapshot({
      userId: 7,
      project: {
        id: 128, userId: 7, title: '未命名', description: '', genre: '',
        subGenres: [], worldKeyTerms: [], version: 1,
      },
      documents: [],
      characters: [],
      outlineNodes: [],
      chapters: [],
    });
    const readiness = classifyMaterialReadiness(snapshot, 2);
    expect(readiness.status).toBe('confirmation_required');
    expect(readiness.proposals.some((row) => row.value.includes('platform-default'))).toBe(false);
    expect(readiness.proposals.find((row) => row.field === 'genre')?.value).toBe('');
  });

  it('treats an empty first-chapter narrative state as an initial state and still prepares a seed', () => {
    const snapshot = compileProjectContextSnapshot({
      userId: 7,
      project: {
        id: 128, userId: 7, title: 'New work', description: 'The protagonist investigates a disappearance in the old city', genre: 'mystery',
        subGenres: [], worldKeyTerms: [], version: 1,
      },
      documents: [
        { id: 1, documentType: 'worldbuilding', content: '# World\nOld city', currentVersion: 1, updatedAt: new Date() },
        { id: 2, documentType: 'creative_constitution', content: '# Constitution\nDo not rewrite confirmed facts', currentVersion: 1, updatedAt: new Date() },
      ],
      characters: [{
        id: 1, name: 'Lin Mo', roleType: 'protagonist', identity: 'investigator', goals: 'solve the case',
        motivation: 'find his sister', currentState: 'returned to the old city', relationships: '', secrets: '', characterArc: '', version: 1,
      }],
      outlineNodes: [],
      chapters: [],
    });

    const readiness = classifyMaterialReadiness(snapshot, 1);
    const seed = readiness.proposals.find((row) => row.field === 'chapter_seed');

    expect(readiness.missing).not.toContain('Canon');
    expect(readiness.missing).not.toContain('伏笔/承诺');
    expect(seed?.value).toContain('chapterNumber');
    expect(seed?.value).toContain('intent');
    expect(seed?.value).toContain('endingGoal');
    expect(seed?.requiresConfirmation).toBe(true);
  });

  it('is ready when author materials and seed are present', () => {
    const snapshot = compileProjectContextSnapshot(baseRecords({
      project: {
        id: 128,
        userId: 7,
        title: '铜哨',
        description: '都市重生',
        genre: '都市重生',
        subGenres: ['重生'],
        worldKeyTerms: ['铜哨'],
        version: 4,
      },
      documents: [
        {
          id: 1,
          documentType: 'story_outline',
          content: FIXTURE_STORY_OUTLINE,
          currentVersion: 1,
          updatedAt: new Date(),
        },
        {
          id: 2,
          documentType: 'worldbuilding',
          content: '# 世界观\n- 铜哨是旧案证物',
          currentVersion: 1,
          updatedAt: new Date(),
        },
        {
          id: 3,
          documentType: 'creative_constitution',
          content: '# 创作宪法\n- 不违背已确认身份',
          currentVersion: 1,
          updatedAt: new Date(),
        },
        {
          id: 4,
          documentType: 'style_profile',
          content: '{"editorialGuidance":["克制"]}',
          currentVersion: 1,
          updatedAt: new Date(),
        },
        {
          id: 5,
          documentType: 'narrative_state',
          content: '{"canon":[{"fact":"fact"}],"promise":[{"description":"promise"}]}',
          currentVersion: 1,
          updatedAt: new Date(),
        },
      ],
      chapters: [
        {
          chapterNumber: 2,
          title: '第二章',
          content: '',
          wordCount: 0,
          version: 1,
          seed: {
            intent: '追查铜哨',
            mustInclude: '',
            forbiddenFacts: '',
            characterMotives: '',
            promises: '',
            endingGoal: '留下新压力',
            version: 1,
          },
        },
      ],
      characters: [
        {
          id: 1,
          name: '沈砚',
          roleType: 'protagonist',
          identity: '重生者',
          goals: '查清失踪',
          motivation: '确认父亲隐瞒',
          currentState: '握着铜哨',
          relationships: '',
          secrets: '',
          characterArc: '',
          version: 2,
        },
      ],
    }));
    const readiness = classifyMaterialReadiness(snapshot, 2);
    expect(readiness.status).toBe('ready');
    expect(readiness.missing.filter((item) => ['项目类型', '世界观', '创作宪法', '风格档案', '章节种子'].includes(item))).toEqual([]);
  });
});
