/** 章节创建并发一致性回归测试。 */
import { describe, expect, it, vi } from 'vitest';
import { ChaptersService } from './chapters.service';

describe('ChaptersService chapter-number uniqueness', () => {
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
