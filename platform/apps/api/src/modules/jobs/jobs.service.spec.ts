/** 章节 HTTP 调度的交付契约回归测试。 */
import { describe, expect, it, vi } from 'vitest';
import { JobsService } from './jobs.service';

function makeService(runtimeResult: unknown) {
  const prisma = {
    novelProject: {
      findFirst: vi.fn().mockResolvedValue({ genre: 'fantasy', subGenres: [], worldKeyTerms: [] }),
    },
    novelCharacter: {
      findMany: vi.fn().mockResolvedValue([{
        name: '主角', aliases: [], roleType: 'protagonist', identity: '修士', goals: '',
        motivation: '', personality: '', abilities: '', relationships: '', secrets: '',
        characterArc: '', currentState: '', notes: '', sortOrder: 0,
      }]),
    },
    novelDocument: {
      findMany: vi.fn().mockResolvedValue([
        { documentType: 'style_profile', title: '风格', content: '{"voice":"冷峻"}', updatedAt: new Date(), id: 1 },
        { documentType: 'narrative_state', title: '状态', content: '{"chapters":[]}', updatedAt: new Date(), id: 2 },
      ]),
    },
    novelChapter: { findFirst: vi.fn().mockResolvedValue(null) },
    novelChapterSeed: {
      findUnique: vi.fn().mockResolvedValue({
        intent: '推进本章冲突',
        mustInclude: '',
        forbiddenFacts: '',
        characterMotives: '',
        promises: '',
        endingGoal: '留下章末钩子',
      }),
    },
    novelBalanceHold: { findUnique: vi.fn().mockResolvedValue({ settledAmount: 12n }) },
    setting: { findMany: vi.fn().mockResolvedValue([]) },
    novelGenerationJob: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(),
  };
  const billing = {
    createHold: vi.fn().mockResolvedValue({}),
    settleCall: vi.fn().mockResolvedValue({}),
    updateJobProgress: vi.fn().mockResolvedValue({}),
    finalizeHold: vi.fn().mockResolvedValue({ status: 'released', settledAmount: 12n }),
    finalizeHoldInTransaction: vi.fn().mockResolvedValue({ status: 'settled', settledAmount: 12n }),
  };
  const rates = {
    buildRateSnapshot: vi.fn().mockResolvedValue({
      inputPricePerMillion: '100',
      outputPricePerMillion: '100',
    }),
  };
  const runtime = { invoke: vi.fn().mockResolvedValue(runtimeResult) };
  const service = new JobsService(prisma as never, billing as never, rates as never, runtime as never);
  return { service, prisma, billing, runtime, rates };
}

const input = {
  userId: 1,
  projectId: 2,
  chapterId: 3,
  jobId: 'job-1',
  maxCharge: 100n,
  chapterNumber: 1,
  chapterVersion: 1,
  seedVersion: 1,
};

describe('JobsService HTTP generation delivery contract', () => {
  it('does not let a delayed pending callback roll a running job back', async () => {
    const { service, prisma } = makeService({ status: 'ok', result: {} });
    prisma.novelGenerationJob.findUnique = vi.fn().mockResolvedValue({
      jobId: 'job-1',
      status: 'running',
      progressStage: 'generating_text',
    });
    prisma.novelGenerationJob.update = vi.fn().mockResolvedValue({
      status: 'running',
      progressStage: 'generating_text',
    });

    const result = await service.updateProgressIfExists({
      jobId: 'job-1',
      status: 'pending',
      stage: 'checking_materials',
    });

    expect(result).toMatchObject({ status: 'running', accepted: false });
    expect(prisma.novelGenerationJob.update).not.toHaveBeenCalled();
  });

  it('does not let a late non-terminal callback overwrite a terminal job', async () => {
    const { service, prisma } = makeService({ status: 'ok', result: {} });
    prisma.novelGenerationJob.findUnique = vi.fn().mockResolvedValue({
      jobId: 'job-1',
      status: 'succeeded',
      progressStage: 'saving_chapter',
    });

    const result = await service.updateProgressIfExists({
      jobId: 'job-1',
      status: 'running',
      stage: 'generating_text',
    });

    expect(result).toMatchObject({ status: 'succeeded', accepted: false });
    expect(prisma.novelGenerationJob.update).not.toHaveBeenCalled();
  });

  it('does not resurrect a job that becomes terminal after the callback read', async () => {
    const { service, prisma } = makeService({ status: 'ok', result: {} });
    prisma.novelGenerationJob.findUnique = vi.fn()
      .mockResolvedValueOnce({
        jobId: 'job-1',
        status: 'running',
        progressStage: 'generating_text',
      })
      .mockResolvedValueOnce({
        jobId: 'job-1',
        status: 'succeeded',
        progressStage: 'saving_chapter',
      });
    prisma.novelGenerationJob.updateMany = vi.fn().mockResolvedValue({ count: 0 });

    const result = await service.updateProgressIfExists({
      jobId: 'job-1',
      status: 'running',
      stage: 'generating_text',
    });

    expect(result).toMatchObject({ status: 'succeeded', accepted: false });
    expect(prisma.novelGenerationJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        jobId: 'job-1',
        status: { in: ['pending', 'running'] },
      }),
    }));
  });

  it('recovers jobs left pending or running by an API restart', async () => {
    const { service, prisma, billing } = makeService({ status: 'ok', result: {} });
    prisma.novelGenerationJob.findMany = vi.fn().mockResolvedValue([
      { jobId: 'stale-pending', startedAt: new Date(Date.now() - 2_000_000) },
      { jobId: 'stale-running', startedAt: new Date(Date.now() - 2_000_000) },
    ]);

    await service.onModuleInit();

    expect(billing.finalizeHold).toHaveBeenNthCalledWith(1, {
      jobId: 'stale-pending',
      outcome: 'failure',
    });
    expect(billing.finalizeHold).toHaveBeenNthCalledWith(2, {
      jobId: 'stale-running',
      outcome: 'failure',
    });
    expect(prisma.novelGenerationJob.update).toHaveBeenCalledTimes(2);
    expect(prisma.novelGenerationJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { jobId: 'stale-pending' },
      data: expect.objectContaining({ status: 'failed', settledAmount: 12n }),
    }));
  });

  it('does not recover a fresh pending or running job during a rolling restart', async () => {
    const { service, prisma, billing } = makeService({ status: 'ok', result: {} });
    prisma.novelGenerationJob.findMany = vi.fn().mockResolvedValue([]);

    await service.onModuleInit();

    expect(billing.finalizeHold).not.toHaveBeenCalled();
    expect(prisma.novelGenerationJob.update).not.toHaveBeenCalled();
    expect(prisma.novelGenerationJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        startedAt: expect.objectContaining({ lt: expect.any(Date) }),
      }),
    }));
  });

  it('does not mark an interrupted job failed when its hold cannot be released', async () => {
    const { service, prisma, billing } = makeService({ status: 'ok', result: {} });
    prisma.novelGenerationJob.findMany = vi.fn().mockResolvedValue([
      { jobId: 'stale-with-unreleased-hold' },
    ]);
    billing.finalizeHold = vi.fn().mockRejectedValue(new Error('database unavailable'));

    await expect(service.onModuleInit()).rejects.toThrow('database unavailable');
    expect(prisma.novelGenerationJob.update).not.toHaveBeenCalled();
  });

  it('maps the database active-job uniqueness race to a conflict response', async () => {
    const { service, prisma } = makeService({ status: 'ok', result: {} });
    prisma.novelChapter.findFirst = vi.fn().mockResolvedValue({
      chapterNumber: 1,
      version: 1,
      seed: { intent: '推进冲突', endingGoal: '留下悬念' },
    });
    prisma.novelGenerationJob.findFirst = vi.fn().mockResolvedValue(null);
    prisma.novelGenerationJob.create = vi.fn().mockRejectedValue({ code: 'P2002' });

    await expect(service.submitChapterGeneration(1, 2, 3)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('fails before creating a job when the writer rate is not configured', async () => {
    const { service, prisma, rates } = makeService({ status: 'ok', result: {} });
    prisma.novelChapter.findFirst = vi.fn().mockResolvedValue({
      chapterNumber: 1,
      version: 1,
      seed: { intent: '推进冲突', endingGoal: '留下悬念' },
    });
    rates.buildRateSnapshot.mockRejectedValue(new Error('writer rate missing'));

    await expect(service.submitChapterGeneration(1, 2, 3)).rejects.toThrow('writer rate missing');
    expect(prisma.novelGenerationJob.create).not.toHaveBeenCalled();
  });

  it('does not report insufficient balance when creating a hold fails for another reason', async () => {
    const { service, prisma, billing } = makeService({ status: 'ok', result: {} });
    prisma.novelChapter.findFirst = vi.fn().mockResolvedValue({
      chapterNumber: 1,
      version: 1,
      seed: { intent: '推进冲突', endingGoal: '留下悬念' },
    });
    billing.createHold = vi.fn().mockRejectedValue(new Error('billing database unavailable'));

    await expect(service.submitChapterGeneration(1, 2, 3)).rejects.toThrow('billing database unavailable');
    expect(prisma.novelGenerationJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed' }),
    }));
  });

  it('refuses to overwrite a chapter edited after generation started', async () => {
    const { service, prisma } = makeService({
      status: 'ok',
      result: { status: 'ok', text: '鍙氦浠樻鏂�' },
    });
    prisma.$transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        novelChapter: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }),
    );

    await expect(
      (service as never as {
        persistGeneratedChapter(value: { userId: number; projectId: number; chapterId: number; jobId: string; chapterVersion: number }, text: string): Promise<void>;
      }).persistGeneratedChapter(
        { userId: 1, projectId: 2, chapterId: 3, jobId: 'job-1', chapterVersion: 4 },
        '鍙氦浠樻鏂�',
      ),
    ).rejects.toThrow('chapter changed while generation was running');
  });

  it('refuses to consume a seed edited after generation started', async () => {
    const { service, prisma } = makeService({
      status: 'ok',
      result: { status: 'ok', text: '生成正文' },
    });
    const seedUpdate = vi.fn().mockResolvedValue({});
    const seedUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    prisma.$transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        novelChapter: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            version: 2,
            title: '第一章',
            content: '生成正文',
            wordCount: 4,
          }),
        },
        novelChapterVersion: { create: vi.fn().mockResolvedValue({}) },
        novelChapterSeed: { update: seedUpdate, updateMany: seedUpdateMany },
        novelProject: {
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      }),
    );

    await expect(
      (service as never as {
        persistGeneratedChapter(value: {
          userId: number; projectId: number; chapterId: number; jobId: string;
          chapterVersion: number; seedVersion: number;
        }, text: string): Promise<void>;
      }).persistGeneratedChapter(
        {
          userId: 1, projectId: 2, chapterId: 3, jobId: 'job-1',
          chapterVersion: 1, seedVersion: 4,
        },
        '生成正文',
      ),
    ).rejects.toThrow('chapter seed changed while generation was running');
    expect(seedUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ chapterId: 3, version: 4 }),
    }));
    expect(seedUpdate).not.toHaveBeenCalled();
  });

  it('refuses to deliver into a project deleted during generation', async () => {
    const { service, prisma } = makeService({
      status: 'ok',
      result: { status: 'ok', text: '生成正文' },
    });
    const projectUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    prisma.$transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        novelChapter: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            version: 2,
            title: '第一章',
            content: '生成正文',
            wordCount: 4,
          }),
        },
        novelChapterVersion: { create: vi.fn().mockResolvedValue({}) },
        novelChapterSeed: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        novelProject: { updateMany: projectUpdateMany },
      }),
    );

    await expect(
      (service as never as {
        persistGeneratedChapter(value: {
          userId: number; projectId: number; chapterId: number; jobId: string;
          chapterVersion: number; seedVersion: number;
        }, text: string): Promise<void>;
      }).persistGeneratedChapter(
        {
          userId: 1, projectId: 2, chapterId: 3, jobId: 'job-1',
          chapterVersion: 1, seedVersion: 1,
        },
        '生成正文',
      ),
    ).rejects.toThrow('project deleted while generation was running');
    expect(projectUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 2, userId: 1, deletedAt: null }),
    }));
  });

  it('does not create a duplicate narrative state when one is created concurrently', async () => {
    const { service } = makeService({
      status: 'ok',
      result: { status: 'ok', text: '生成正文' },
    });
    const stateCreate = vi.fn().mockRejectedValue({ code: 'P2002' });
    const txProject = {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const tx = {
      novelChapter: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          version: 2, title: '第一章', content: '生成正文', wordCount: 4,
        }),
      },
      novelChapterVersion: { create: vi.fn().mockResolvedValue({}) },
      novelChapterSeed: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      novelProject: txProject,
      novelDocument: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: stateCreate,
      },
      novelDocumentVersion: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = (service as never as { prisma: unknown }).prisma as { $transaction: unknown };
    (prisma.$transaction as ReturnType<typeof vi.fn>) = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));

    await expect(
      (service as never as {
        persistGeneratedChapter(value: {
          userId: number; projectId: number; chapterId: number; jobId: string;
          chapterVersion: number; seedVersion: number;
        }, text: string, runtimeState: unknown): Promise<void>;
      }).persistGeneratedChapter(
        { userId: 1, projectId: 2, chapterId: 3, jobId: 'job-1', chapterVersion: 1, seedVersion: 1 },
        '生成正文',
        { chapters: ['new'] },
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(stateCreate).toHaveBeenCalled();
  });

  it('refuses to overwrite narrative state edited during generation', async () => {
    const { service, prisma } = makeService({
      status: 'ok',
      result: { status: 'ok', text: '生成正文' },
    });
    const stateUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const stateUpdate = vi.fn().mockResolvedValue({});
    prisma.$transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        novelChapter: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            version: 2,
            title: '第一章',
            content: '生成正文',
            wordCount: 4,
          }),
        },
        novelChapterVersion: { create: vi.fn().mockResolvedValue({}) },
        novelChapterSeed: {
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        novelProject: {
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        novelDocument: {
          findFirst: vi.fn().mockResolvedValue({ id: 9, currentVersion: 3 }),
          updateMany: stateUpdateMany,
          update: stateUpdate,
        },
        novelDocumentVersion: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    await expect(
      (service as never as {
        persistGeneratedChapter(value: { userId: number; projectId: number; chapterId: number; jobId: string; chapterVersion: number }, text: string, runtimeState: unknown): Promise<void>;
      }).persistGeneratedChapter(
        { userId: 1, projectId: 2, chapterId: 3, jobId: 'job-1', chapterVersion: 1 },
        '生成正文',
        { chapters: ['new'] },
      ),
    ).rejects.toThrow('narrative state changed while generation was running');
    expect(stateUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 9, currentVersion: 3 }),
    }));
    expect(stateUpdate).not.toHaveBeenCalled();
  });

  it('rejects malformed runtime state instead of silently delivering a chapter without state', async () => {
    const { service, prisma, billing } = makeService({
      status: 'ok',
      result: { status: 'ok', text: '鐢熸垚姝ｆ枃' },
    });
    const tx = {
      novelChapter: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          version: 2,
          title: '绗竴绔?',
          content: '鐢熸垚姝ｆ枃',
          wordCount: 4,
        }),
      },
      novelChapterVersion: { create: vi.fn().mockResolvedValue({}) },
      novelChapterSeed: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      novelProject: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      novelDocument: { findFirst: vi.fn() },
      novelDocumentVersion: { create: vi.fn() },
      novelGenerationJob: { update: vi.fn() },
    };
    prisma.$transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));

    await expect(
      (service as never as {
        persistGeneratedChapter(value: {
          userId: number; projectId: number; chapterId: number; jobId: string;
          chapterVersion: number; seedVersion: number;
        }, text: string, runtimeState: unknown): Promise<void>;
      }).persistGeneratedChapter(
        { userId: 1, projectId: 2, chapterId: 3, jobId: 'job-1', chapterVersion: 1, seedVersion: 1 },
        '鐢熸垚姝ｆ枃',
        'not-an-object',
      ),
    ).rejects.toThrow('runtime state is invalid');
    expect(billing.finalizeHoldInTransaction).not.toHaveBeenCalled();
  });

  it('marks a blocked runtime chapter as failed instead of succeeded', async () => {
    const { service, prisma, billing, runtime } = makeService({
      status: 'ok',
      result: { status: 'blocked', reason: 'fact guard blocked' },
    });

    await (service as never as { runHttpGeneration(value: typeof input): Promise<void> }).runHttpGeneration(input);

    expect(billing.finalizeHold).toHaveBeenCalledWith({ jobId: 'job-1', outcome: 'failure' });
    expect(prisma.novelGenerationJob.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'failed',
        settledAmount: 12n,
        failureMessage: 'fact guard blocked',
      }),
    }));
    expect(runtime.invoke).toHaveBeenCalledWith(
      expect.any(String),
      'novel_generate_chapter',
      expect.objectContaining({
        workspaceDocuments: expect.any(Array),
        projectConfig: expect.any(Object),
      }),
    );
    const runtimeInput = runtime.invoke.mock.calls[0][2] as {
      workspaceDocuments: Array<{ type: string; content: string }>;
    };
    expect(runtimeInput.workspaceDocuments.find((doc) => doc.type === 'style_profile')?.content)
      .toBe('{"voice":"冷峻"}');
    expect(runtimeInput.workspaceDocuments.find((doc) => doc.type === 'narrative_state')?.content)
      .toBe('{"chapters":[]}');
  });

  it('injects a default style fingerprint and constitution when the project omitted them', async () => {
    const { service, prisma, runtime } = makeService({
      status: 'ok',
      result: { status: 'blocked', reason: 'preflight' },
    });
    prisma.novelDocument.findMany = vi.fn().mockResolvedValue([]);
    prisma.novelProject.findFirst = vi.fn().mockResolvedValue({
      genre: '',
      subGenres: [],
      worldKeyTerms: [],
    });

    await (service as never as { runHttpGeneration(value: typeof input): Promise<void> }).runHttpGeneration(input);

    const runtimeInput = runtime.invoke.mock.calls[0][2] as {
      projectConfig: { genre: string };
      workspaceDocuments: Array<{ type: string; content: string }>;
    };
    expect(runtimeInput.projectConfig.genre).toBe('都市');
    const style = runtimeInput.workspaceDocuments.find((doc) => doc.type === 'style_profile')?.content ?? '';
    expect(style).toContain('editorialGuidance');
    expect(style).toContain('platform-default');
    expect(runtimeInput.workspaceDocuments.find((doc) => doc.type === 'creative_constitution')?.content)
      .toContain('创作宪法');
    expect(runtimeInput.workspaceDocuments.find((doc) => doc.type === 'worldbuilding')?.content)
      .toContain('世界观');
    expect(runtimeInput.workspaceDocuments.find((doc) => doc.type === 'explicit_outline')?.content)
      .toContain('内容摘要：推进本章冲突');
  });

  it('marks a non-empty ok chapter as succeeded only after its hold is finalized', async () => {
    const { service, prisma, billing } = makeService({
      status: 'ok',
      result: { status: 'ok', text: '可交付正文' },
      metering: { modelCallCount: 1 },
    });
    const tx = {
      novelChapter: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          version: 2,
          title: '第一章',
          content: '可交付正文',
          wordCount: 5,
        }),
      },
      novelChapterVersion: { create: vi.fn().mockResolvedValue({}) },
      novelChapterSeed: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      novelProject: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      novelGenerationJob: { update: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));

    await (service as never as { runHttpGeneration(value: typeof input): Promise<void> }).runHttpGeneration(input);

    expect(tx.novelGenerationJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'succeeded' }),
    }));
    expect(billing.finalizeHoldInTransaction).toHaveBeenCalledWith(tx, {
      jobId: 'job-1',
      outcome: 'success',
    });
  });

  it('rejects a non-empty runtime chapter when no model call was metered', async () => {
    const { service, prisma, billing } = makeService({
      status: 'ok',
      result: { status: 'ok', text: '未计费正文' },
      metering: { modelCallCount: 0 },
    });

    await (service as never as { runHttpGeneration(value: typeof input): Promise<void> }).runHttpGeneration(input);

    expect(billing.finalizeHold).toHaveBeenCalledWith({ jobId: 'job-1', outcome: 'failure' });
    expect(prisma.novelGenerationJob.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'failed',
        failureMessage: '章节生成未调用模型，未产出可交付正文',
      }),
    }));
  });

  it('persists the runtime invoke error instead of a generic generation failed label', async () => {
    const { service, prisma, runtime } = makeService({ status: 'ok', result: {} });
    runtime.invoke = vi.fn().mockRejectedValue(new Error('no active production release set'));

    await (service as never as { runHttpGeneration(value: typeof input): Promise<void> }).runHttpGeneration(input);

    expect(prisma.novelGenerationJob.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'failed',
        failureMessage: 'no active production release set',
      }),
    }));
  });

  it('marks an ok runtime response with blank text as failed', async () => {
    const { service, prisma, billing } = makeService({
      status: 'ok',
      result: { status: 'ok', text: '  ' },
    });

    await (service as never as { runHttpGeneration(value: typeof input): Promise<void> }).runHttpGeneration(input);

    expect(billing.finalizeHold).toHaveBeenCalledWith({ jobId: 'job-1', outcome: 'failure' });
    expect(prisma.novelGenerationJob.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed' }),
    }));
  });

  it('keeps a failed job active when failure hold finalization is unavailable', async () => {
    const { service, prisma, billing } = makeService({
      status: 'ok',
      result: { status: 'blocked', reason: 'fact guard blocked' },
    });
    billing.finalizeHold = vi.fn().mockRejectedValue(new Error('billing unavailable'));

    await (service as never as { runHttpGeneration(value: typeof input): Promise<void> }).runHttpGeneration(input);

    expect(prisma.novelGenerationJob.update).not.toHaveBeenCalled();
  });
});
