import { describe, expect, it, vi } from 'vitest';
import { FailureHttpException, FAILURE_CODES, makeFailure } from '../context/failure-envelope';
import { applyAssistantArtifacts } from './assistant-artifacts';

function makePrisma() {
  return {
    novelDocument: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 9 }),
    },
    novelDocumentVersion: { create: vi.fn().mockResolvedValue({}) },
    novelProject: { update: vi.fn().mockResolvedValue({}) },
    novelOutlineNode: {
      updateMany: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockImplementation(async ({ data }: { data: { title: string; id?: number } }) => ({
        id: data.title.includes('卷') ? 100 : 200,
      })),
    },
    novelCharacter: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    novelChapter: {
      findFirst: vi.fn().mockResolvedValue(null),
      findFirstOrThrow: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 4, seed: { id: 7 }, content: '', title: '' }),
      update: vi.fn().mockResolvedValue({}),
    },
    novelChapterSeed: { update: vi.fn().mockResolvedValue({}), create: vi.fn() },
  };
}

describe('saveConfirmedAuthorMaterials', () => {
  it('saves confirmed documents and seed with version audit, never chapter prose', async () => {
    const { saveConfirmedAuthorMaterials } = await import('./assistant-artifacts');
    const prisma = makePrisma();
    prisma.novelChapter.findFirst = vi.fn().mockResolvedValue({
      id: 44,
      seed: { id: 7, intent: '', endingGoal: '', mustInclude: '', forbiddenFacts: '', characterMotives: '', promises: '' },
      content: '已有正文不得覆盖',
      title: '第二章',
    });
    const result = await saveConfirmedAuthorMaterials({
      prisma: prisma as never,
      userId: 1,
      projectId: 128,
      chapterNumber: 2,
      confirmed: new Set(['genre', 'worldbuilding', 'chapter_seed']),
      proposals: [
        { field: 'genre', value: '都市重生', source: ['story_outline'], requiresConfirmation: true },
        { field: 'worldbuilding', value: '# 世界观\n- 铜哨', source: ['chapter:1'], requiresConfirmation: true },
        { field: 'chapter_seed', value: JSON.stringify({ intent: '追查禁令', endingGoal: '留下压力' }), source: [], requiresConfirmation: false },
      ],
    });
    expect(result.chapterId).toBe(44);
    expect(prisma.novelProject.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ genre: '都市重生' }),
    }));
    expect(prisma.novelDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ documentType: 'worldbuilding' }),
    }));
    expect(prisma.novelDocumentVersion.create).toHaveBeenCalled();
    expect(prisma.novelChapter.update).not.toHaveBeenCalled();
    expect(prisma.novelChapter.create).not.toHaveBeenCalled();
  });
});

describe('applyAssistantArtifacts', () => {
  it('plan_story_outline saves the book outline and never submits generation', async () => {
    const prisma = makePrisma();
    const jobs = {
      submitChapterGeneration: vi.fn().mockResolvedValue({ jobId: 'gen-1' }),
    };

    const result = await applyAssistantArtifacts({
      prisma: prisma as never,
      jobs: jobs as never,
      userId: 1,
      projectId: 128,
      action: 'plan_story_outline',
      userContent: '帮我写一份都市重生大纲，并生成第一章',
      envelope: {
        reply: '已写好全书大纲',
        storyOutline: [
          '# 故事大纲',
          '## 第一卷：开端',
          '1. **第一章：牛马的一生**',
          '   沈砚倒下。',
        ].join('\n'),
        characters: [{ name: '沈砚', roleType: 'protagonist', description: '都市青年' }],
      },
    });

    expect(prisma.novelDocument.create).toHaveBeenCalled();
    expect(jobs.submitChapterGeneration).not.toHaveBeenCalled();
    expect(result.generationJobId).toBeUndefined();
    expect(result.artifacts.outlineSaved).toBe(true);
  });

  it('plan_chapter saves only the requested seed and does not rewrite story_outline', async () => {
    const prisma = makePrisma();
    const jobs = {
      submitChapterGeneration: vi.fn().mockResolvedValue({ jobId: 'gen-2' }),
    };
    const result = await applyAssistantArtifacts({
      prisma: prisma as never,
      jobs: jobs as never,
      userId: 1,
      projectId: 128,
      action: 'plan_chapter',
      chapterNumber: 2,
      userContent: '写第二章种子',
      envelope: {
        reply: '已写第二章种子',
        storyOutline: '# 故事大纲\n1. 第一章：污染',
        chapterSeed: {
          chapterNumber: 2,
          intent: '追查铜哨',
          mustInclude: '',
          forbiddenFacts: '',
          characterMotives: '',
          promises: '',
          endingGoal: '留下新压力',
        },
      },
    });
    expect(prisma.novelDocument.create).not.toHaveBeenCalled();
    expect(prisma.novelChapterSeed.update).toHaveBeenCalled();
    expect(jobs.submitChapterGeneration).not.toHaveBeenCalled();
    expect(result.artifacts.outlineSaved).toBe(false);
  });

  it('query_project writes nothing even when the reply looks like an outline', async () => {
    const prisma = makePrisma();
    const jobs = {
      submitChapterGeneration: vi.fn().mockResolvedValue({ jobId: 'gen-3' }),
    };
    await applyAssistantArtifacts({
      prisma: prisma as never,
      jobs: jobs as never,
      userId: 1,
      projectId: 128,
      action: 'query_project',
      userContent: '帮我写一份都市重生大纲',
      envelope: {
        reply: '# 故事大纲\n## 第一卷：开端\n1. **第一章：牛马的一生**',
        storyOutline: '# 故事大纲',
      },
    });
    expect(prisma.novelDocument.create).not.toHaveBeenCalled();
    expect(prisma.novelChapter.create).not.toHaveBeenCalled();
    expect(jobs.submitChapterGeneration).not.toHaveBeenCalled();
  });

  it('generate_chapter submits novel_generate_chapter and ignores outline dumps', async () => {
    const prisma = makePrisma();
    prisma.novelChapter.findFirst = vi.fn().mockResolvedValue({
      id: 4,
      seed: { id: 7, intent: '追查铜哨', endingGoal: '留下新压力', mustInclude: '', forbiddenFacts: '', characterMotives: '', promises: '' },
      content: '',
      title: '第2章',
    });
    const jobs = {
      submitChapterGeneration: vi.fn().mockResolvedValue({ jobId: 'gen-4' }),
    };
    const result = await applyAssistantArtifacts({
      prisma: prisma as never,
      jobs: jobs as never,
      userId: 1,
      projectId: 128,
      action: 'generate_chapter',
      chapterNumber: 2,
      confirmGeneration: true,
      targetWordCount: { min: 2500, max: 2750 },
      userContent: '生成第二章',
      envelope: {
        reply: '已提交正式生成',
        storyOutline: '# 故事大纲\n1. 第一章：不该写回全书大纲',
      },
    });
    expect(prisma.novelDocument.create).not.toHaveBeenCalled();
    expect(jobs.submitChapterGeneration).toHaveBeenCalledWith(1, 128, 4, {
      continuationMode: undefined,
      targetWordCount: { min: 2500, max: 2750 },
    });
    expect(result.generationJobId).toBe('gen-4');
    expect(result.artifacts.publicEntry).toBe('novel_generate_chapter');
  });

  it('keeps author_contract FailureHttpException instead of wrapping job_submit_failed', async () => {
    const prisma = makePrisma();
    prisma.novelChapter.findFirst = vi.fn().mockResolvedValue({
      id: 4,
      seed: { id: 7, intent: '追查铜哨', endingGoal: '留下新压力', mustInclude: '', forbiddenFacts: '', characterMotives: '', promises: '' },
      content: '',
      title: '第2章',
    });
    const authorBlock = new FailureHttpException(makeFailure({
      stage: 'runtime.preflight',
      gate: 'author_contract',
      code: FAILURE_CODES.runtimePreflightFailed,
      severity: 'preflight',
      reason: '缺少作者确认的生成资料，已阻断；不会用默认题材、风格或世界观代替',
      recoverable: false,
      userActionRequired: [
        '项目类型为空',
        '缺少作者确认的风格档案',
        '缺少作者确认的世界观',
        '缺少作者确认的创作宪法',
      ],
    }));
    const jobs = {
      submitChapterGeneration: vi.fn().mockRejectedValue(authorBlock),
    };

    await expect(applyAssistantArtifacts({
      prisma: prisma as never,
      jobs: jobs as never,
      userId: 1,
      projectId: 128,
      action: 'generate_chapter',
      chapterNumber: 2,
      confirmGeneration: true,
      userContent: '生成第二章',
      envelope: { reply: '准备提交正式生成' },
    })).rejects.toBe(authorBlock);

    try {
      await applyAssistantArtifacts({
        prisma: prisma as never,
        jobs: jobs as never,
        userId: 1,
        projectId: 128,
        action: 'generate_chapter',
        chapterNumber: 2,
        confirmGeneration: true,
        userContent: '生成第二章',
        envelope: { reply: '准备提交正式生成' },
      });
      throw new Error('expected FailureHttpException');
    } catch (error) {
      expect(error).toBeInstanceOf(FailureHttpException);
      const envelope = (error as FailureHttpException).envelope;
      expect(envelope.code).toBe('runtime_preflight_failed');
      expect(envelope.gate).toBe('author_contract');
      expect(envelope.userActionRequired).toEqual(expect.arrayContaining([
        '项目类型为空',
        '缺少作者确认的风格档案',
        '缺少作者确认的世界观',
        '缺少作者确认的创作宪法',
      ]));
    }
  });
});
