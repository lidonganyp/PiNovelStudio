/** 章节创建并发一致性回归测试。 */
import { describe, expect, it, vi } from 'vitest';
import { ChaptersService } from './chapters.service';

describe('ChaptersService chapter-number uniqueness', () => {
  it('updates and returns a manually changed chapter number', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const saved = {
      id: 3,
      projectId: 2,
      userId: 1,
      chapterNumber: 7,
      title: '标题',
      content: '正文',
      wordCount: 2,
      status: 'draft',
      version: 2,
      generationJobId: null,
      seed: null,
    };
    const prisma = {
      novelProject: {
        findFirst: vi.fn().mockResolvedValue({ id: 2, userId: 1, deletedAt: null }),
      },
      novelChapter: {
        findFirst: vi.fn()
          .mockResolvedValueOnce({ ...saved, chapterNumber: 3, version: 1 })
          .mockResolvedValueOnce(null),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          novelChapter: {
            updateMany,
            findUniqueOrThrow: vi.fn().mockResolvedValue(saved),
          },
          novelChapterVersion: { create: vi.fn() },
        }),
      ),
    };
    const service = new ChaptersService(prisma as never);

    await expect(service.update(1, 2, 3, {
      chapterNumber: 7,
      title: '标题',
      content: '正文',
      expectedVersion: 1,
    })).resolves.toMatchObject({ chapterNumber: 7 });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ chapterNumber: 7 }),
    }));
  });

  it('rejects a manually changed chapter number already used by another chapter', async () => {
    const prisma = {
      novelProject: {
        findFirst: vi.fn().mockResolvedValue({ id: 2, userId: 1, deletedAt: null }),
      },
      novelChapter: {
        findFirst: vi.fn()
          .mockResolvedValueOnce({
            id: 3,
            projectId: 2,
            userId: 1,
            chapterNumber: 3,
            title: '',
            content: '',
            wordCount: 0,
            status: 'draft',
            version: 1,
            generationJobId: null,
            seed: null,
          })
          .mockResolvedValueOnce({ id: 8, chapterNumber: 7 }),
      },
    };
    const service = new ChaptersService(prisma as never);

    await expect(service.update(1, 2, 3, {
      chapterNumber: 7,
      expectedVersion: 1,
    })).rejects.toMatchObject({ status: 409 });
  });

  it('maps a concurrent duplicate chapter number insert to a conflict', async () => {
    const prisma = {
      novelProject: {
        findFirst: vi.fn().mockResolvedValue({ id: 2, userId: 1, deletedAt: null }),
      },
      novelChapter: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          novelChapter: {
            create: vi.fn().mockRejectedValue({ code: 'P2002' }),
          },
        }),
      ),
    };
    const service = new ChaptersService(prisma as never);

    await expect(
      service.create(1, 2, { chapterNumber: 3, title: '第三章' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to restore a version when the chapter changed after the read', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      novelProject: {
        findFirst: vi.fn().mockResolvedValue({ id: 2, userId: 1, deletedAt: null }),
      },
      novelChapter: {
        findFirst: vi.fn().mockResolvedValue({
          id: 3,
          projectId: 2,
          userId: 1,
          chapterNumber: 1,
          title: '当前标题',
          content: '当前正文',
          wordCount: 4,
          status: 'generated',
          version: 3,
          generationJobId: null,
          seed: null,
        }),
      },
      novelChapterVersion: {
        findUnique: vi.fn().mockResolvedValue({
          chapterId: 3,
          versionNumber: 1,
          title: '旧标题',
          content: '旧正文',
          wordCount: 3,
        }),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          novelChapter: {
            updateMany,
            findFirst: vi.fn().mockResolvedValue({ version: 4 }),
          },
          novelChapterVersion: {
            create: vi.fn(),
          },
        }),
      ),
    };
    const service = new ChaptersService(prisma as never);

    await expect(service.restoreVersion(1, 2, 3, { versionNumber: 1 }))
      .rejects.toMatchObject({ status: 409 });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 3,
        projectId: 2,
        userId: 1,
        version: 3,
        deletedAt: null,
      }),
    }));
  });

  it('refuses to overwrite a seed changed after the seed was read', async () => {
    const seedUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      novelProject: {
        findFirst: vi.fn().mockResolvedValue({ id: 2, userId: 1, deletedAt: null }),
      },
      novelChapter: {
        findFirst: vi.fn().mockResolvedValue({
          id: 3,
          projectId: 2,
          userId: 1,
          chapterNumber: 1,
          title: '标题',
          content: '',
          wordCount: 0,
          status: 'draft',
          version: 1,
          generationJobId: null,
          seed: {
            id: 9,
            chapterId: 3,
            projectId: 2,
            userId: 1,
            intent: '旧意图',
            mustInclude: '',
            forbiddenFacts: '',
            characterMotives: '',
            promises: '',
            endingGoal: '旧目标',
            status: 'ready',
            version: 2,
          },
        }),
      },
      novelChapterSeed: {
        updateMany: seedUpdateMany,
        findFirst: vi.fn().mockResolvedValue({ version: 3 }),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          novelChapterSeed: {
            updateMany: seedUpdateMany,
            findFirst: vi.fn().mockResolvedValue({ version: 3 }),
            findUniqueOrThrow: vi.fn(),
          },
        }),
      ),
    };
    const service = new ChaptersService(prisma as never);

    await expect(service.upsertSeed(1, 2, 3, {
      expectedVersion: 2,
      intent: '新意图',
      endingGoal: '新目标',
    })).rejects.toMatchObject({ status: 409 });
    expect(seedUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        chapterId: 3,
        projectId: 2,
        userId: 1,
        version: 2,
      }),
    }));
  });
});

describe('ChaptersService recordDecision（评审决策路由与版本链）', () => {
  const OWNED_PROJECT = { id: 2, userId: 1, deletedAt: null };
  const CHAPTER = {
    id: 3,
    projectId: 2,
    userId: 1,
    chapterNumber: 1,
    title: '第一章',
    content: '正文',
    wordCount: 2,
    status: 'generated',
    version: 5,
    generationJobId: 'job-old',
    reviewStatus: 'completed',
    reviewVerdict: 'hold',
    reviewRationale: '节奏可再放缓',
    seed: null,
  };

  function makePrisma(overrides?: { guardCount?: number }) {
    const updateMany = vi.fn().mockResolvedValue({ count: overrides?.guardCount ?? 1 });
    const seedUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const decisionCreate = vi.fn().mockResolvedValue({
      id: 11,
      decision: 'keep',
      chapterVersion: 5,
    });
    const prisma = {
      novelProject: {
        findFirst: vi.fn().mockResolvedValue(OWNED_PROJECT),
      },
      novelChapter: {
        findFirst: vi.fn().mockResolvedValue(CHAPTER),
      },
      novelChapterDecision: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          novelChapter: {
            updateMany,
            findFirst: vi.fn().mockResolvedValue({ version: 6 }),
          },
          novelChapterSeed: { updateMany: seedUpdateMany },
          novelChapterDecision: { create: decisionCreate },
        }),
      ),
    };
    return { prisma, updateMany, seedUpdateMany, decisionCreate };
  }

  it('keep：章节锁定为定稿（status=final），不触碰评审快照与种子', async () => {
    const { prisma, updateMany, seedUpdateMany } = makePrisma();
    const service = new ChaptersService(prisma as never);
    await expect(
      service.recordDecision(1, 2, 3, { decision: 'keep', expectedVersion: 5 }),
    ).resolves.toMatchObject({ id: 11, decision: 'keep' });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 3, version: 5 }),
        data: { status: 'final' },
      }),
    );
    expect(seedUpdateMany).not.toHaveBeenCalled();
  });

  it('regenerate：清理章节评审快照（旧评审结论随新版本过期）', async () => {
    const { prisma, updateMany, decisionCreate } = makePrisma();
    decisionCreate.mockResolvedValue({ id: 12, decision: 'regenerate', chapterVersion: 5 });
    const service = new ChaptersService(prisma as never);
    await service.recordDecision(1, 2, 3, { decision: 'regenerate', expectedVersion: 5 });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { reviewStatus: null, reviewVerdict: null, reviewRationale: null },
      }),
    );
  });

  it('revise_outline：更新种子意图并递增种子版本，决策记录携带 revisedIntent', async () => {
    const { prisma, seedUpdateMany, decisionCreate } = makePrisma();
    decisionCreate.mockResolvedValue({ id: 13, decision: 'revise_outline', chapterVersion: 5 });
    const service = new ChaptersService(prisma as never);
    await service.recordDecision(1, 2, 3, {
      decision: 'revise_outline',
      expectedVersion: 5,
      revisedIntent: '强化开场的悬念冲突',
    });
    expect(seedUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chapterId: 3, projectId: 2, userId: 1 },
        data: expect.objectContaining({
          intent: '强化开场的悬念冲突',
          status: 'ready',
          version: { increment: 1 },
        }),
      }),
    );
    expect(decisionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'revise_outline',
          revisedIntent: '强化开场的悬念冲突',
          chapterVersion: 5,
        }),
      }),
    );
  });

  it('revise_outline 缺少 revisedIntent：拒绝（400）', async () => {
    const { prisma } = makePrisma();
    const service = new ChaptersService(prisma as never);
    await expect(
      service.recordDecision(1, 2, 3, { decision: 'revise_outline', expectedVersion: 5 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('版本冲突（预检）：直接拒绝 409，不进入事务', async () => {
    const { prisma, decisionCreate } = makePrisma();
    const service = new ChaptersService(prisma as never);
    await expect(
      service.recordDecision(1, 2, 3, { decision: 'keep', expectedVersion: 4 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(decisionCreate).not.toHaveBeenCalled();
  });

  it('版本冲突（事务内原子守卫）：并发修改导致守卫失败时拒绝 409', async () => {
    const { prisma, decisionCreate } = makePrisma({ guardCount: 0 });
    const service = new ChaptersService(prisma as never);
    await expect(
      service.recordDecision(1, 2, 3, { decision: 'keep', expectedVersion: 5 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(decisionCreate).not.toHaveBeenCalled();
  });

  it('attachDecisionJob：把新生成任务回填到决策记录形成版本链', async () => {
    const { prisma } = makePrisma();
    const service = new ChaptersService(prisma as never);
    await service.attachDecisionJob(1, 12, 'job-new');
    expect(prisma.novelChapterDecision.updateMany).toHaveBeenCalledWith({
      where: { id: 12, userId: 1 },
      data: { newJobId: 'job-new' },
    });
  });
});
