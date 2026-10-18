/** 章节 HTTP 调度的交付契约回归测试。 */
import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { FAILURE_CODES, makeFailure } from '../context/failure-envelope';
import { JobFailureError } from './job-failure';
import { JobsService } from './jobs.service';
import { env } from '../../config/env';

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
        { documentType: 'creative_constitution', title: '宪法', content: '# 创作宪法\n不违背已确认身份', updatedAt: new Date(), id: 3 },
        { documentType: 'worldbuilding', title: '世界观', content: '# 世界观\n铜哨是旧案证物', updatedAt: new Date(), id: 4 },
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
  const errorReports = { recordServerError: vi.fn().mockResolvedValue(null) };
  const service = new JobsService(prisma as never, billing as never, rates as never, runtime as never, errorReports as never);
  return { service, prisma, billing, runtime, rates, errorReports };
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
    const previous = env.NOVEL_RUNTIME_MODE;
    (env as { NOVEL_RUNTIME_MODE: string }).NOVEL_RUNTIME_MODE = 'http';
    prisma.novelChapter.findFirst = vi.fn().mockResolvedValue({
      chapterNumber: 1,
      version: 1,
      seed: { intent: '推进冲突', endingGoal: '留下悬念' },
    });
    rates.buildRateSnapshot.mockRejectedValue(new Error('writer rate missing'));
    try {
      await expect(service.submitChapterGeneration(1, 2, 3)).rejects.toThrow('writer rate missing');
      expect(prisma.novelGenerationJob.create).not.toHaveBeenCalled();
    } finally {
      (env as { NOVEL_RUNTIME_MODE: string }).NOVEL_RUNTIME_MODE = previous;
    }
  });

  it('returns an actionable non-retryable failure when a required writer rate is missing', async () => {
    const { service, prisma, rates, billing, runtime, errorReports } = makeService({ status: 'ok', result: {} });
    const previous = env.NOVEL_RUNTIME_MODE;
    (env as { NOVEL_RUNTIME_MODE: string }).NOVEL_RUNTIME_MODE = 'http';
    prisma.novelChapter.findFirst = vi.fn().mockResolvedValue({
      chapterNumber: 1,
      version: 1,
      seed: { intent: '推进冲突', endingGoal: '留下悬念' },
    });
    rates.buildRateSnapshot.mockRejectedValue(new NotFoundException('未找到模型 v2_rawstage2_gemini31 的生效费率'));
    try {
      await expect(service.submitChapterGeneration(1, 2, 3)).rejects.toMatchObject({
        status: 503,
        envelope: {
          stage: 'jobs.submit',
          gate: 'billing_configuration',
          code: 'generation_billing_unavailable',
          recoverable: false,
          reason: '生成服务的计费配置尚未就绪，请联系管理员补全后再生成。',
          userActionRequired: ['请联系管理员检查生成服务的生效费率与渠道配置'],
        },
      });
      expect(prisma.novelGenerationJob.create).not.toHaveBeenCalled();
      expect(billing.createHold).not.toHaveBeenCalled();
      expect(runtime.invoke).not.toHaveBeenCalled();
      expect(errorReports.recordServerError).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 2,
        chapterId: 3,
        code: 'generation_billing_unavailable',
        diagnostic: expect.objectContaining({ cause: expect.stringContaining('v2_rawstage2_gemini31') }),
      }));
    } finally {
      (env as { NOVEL_RUNTIME_MODE: string }).NOVEL_RUNTIME_MODE = previous;
    }
  });

  it('does not require a stub-writer rate for the local stub runtime', async () => {
    const { service, rates } = makeService({ status: 'ok', result: {} });
    const previous = env.NOVEL_RUNTIME_MODE;
    (env as { NOVEL_RUNTIME_MODE: string }).NOVEL_RUNTIME_MODE = 'stub';
    try {
      const amount = await (service as never as { estimateMaxCharge(): Promise<bigint> }).estimateMaxCharge();
      expect(amount).toBe(50n);
      expect(rates.buildRateSnapshot).not.toHaveBeenCalled();
    } finally {
      (env as { NOVEL_RUNTIME_MODE: string }).NOVEL_RUNTIME_MODE = previous;
    }
  });

  it('uses the formal production route when HTTP runtime has no explicit billing list', async () => {
    const { service } = makeService({ status: 'ok', result: {} });
    const previous = env.NOVEL_RUNTIME_MODE;
    const previousRoutes = env.NOVEL_BILLING_REQUIRED_MODELS;
    (env as { NOVEL_RUNTIME_MODE: string }).NOVEL_RUNTIME_MODE = 'http';
    (env as { NOVEL_BILLING_REQUIRED_MODELS: string }).NOVEL_BILLING_REQUIRED_MODELS = '';
    try {
      const models = (service as never as { requiredBillingModels(): string[] }).requiredBillingModels();
      expect(models).toEqual(['v2_rawstage2_gemini31', 'v2_amplified_gemini31']);
      expect(models).not.toContain('stub-writer');
    } finally {
      (env as { NOVEL_RUNTIME_MODE: string }).NOVEL_RUNTIME_MODE = previous;
      (env as { NOVEL_BILLING_REQUIRED_MODELS: string }).NOVEL_BILLING_REQUIRED_MODELS = previousRoutes;
    }
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

  it('keeps the requested chapter length on the queued HTTP generation payload', async () => {
    const { service, prisma } = makeService({ status: 'ok', result: {} });
    const previous = env.NOVEL_RUNTIME_MODE;
    (env as { NOVEL_RUNTIME_MODE: string }).NOVEL_RUNTIME_MODE = 'http';
    prisma.novelChapter.findFirst = vi.fn().mockResolvedValue({
      chapterNumber: 17,
      version: 3,
      content: '第十七章已有正文。',
      seed: {
        version: 2,
        intent: '完成第十七章冲突',
        endingGoal: '留下章末钩子',
      },
    });
    const buildRuntimeWorkspaceInput = vi.spyOn(
      service as never as { buildRuntimeWorkspaceInput(input: unknown): Promise<Record<string, unknown>> },
      'buildRuntimeWorkspaceInput',
    ).mockResolvedValue({ workspaceDocuments: [], projectConfig: {} });
    vi.spyOn(
      service as never as { estimateMaxCharge(): Promise<bigint> },
      'estimateMaxCharge',
    ).mockResolvedValue(100n);
    const runHttpGeneration = vi.spyOn(
      service as never as { runHttpGeneration(input: unknown): Promise<void> },
      'runHttpGeneration',
    ).mockResolvedValue();
    vi.spyOn(service, 'getJob').mockResolvedValue({ jobId: 'queued-job' });

    try {
      await service.submitChapterGeneration(1, 2, 3, {
        continuationMode: 'append',
        targetWordCount: { min: 2500, max: 2500 },
      });

      expect(buildRuntimeWorkspaceInput).toHaveBeenCalledWith(expect.objectContaining({
        continuationMode: 'append',
        targetWordCount: { min: 2500, max: 2500 },
      }));
      expect(runHttpGeneration).toHaveBeenCalledWith(expect.objectContaining({
        continuationMode: 'append',
        continuationDraft: '第十七章已有正文。',
        targetWordCount: { min: 2500, max: 2500 },
      }));
    } finally {
      (env as { NOVEL_RUNTIME_MODE: string }).NOVEL_RUNTIME_MODE = previous;
    }
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

  it('preserves the author-authored chapter prefix when delivering an append result', async () => {
    const { service, prisma } = makeService({
      status: 'ok',
      result: { status: 'ok', text: '从门外传来脚步声。' },
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const saved = {
      version: 2,
      title: '第十七章',
      content: '已有正文停在这里。\n\n从门外传来脚步声。',
      wordCount: 18,
    };
    prisma.$transaction = vi.fn(async (callback: (value: unknown) => Promise<unknown>) => callback({
      novelChapter: {
        updateMany,
        findUniqueOrThrow: vi.fn().mockResolvedValue(saved),
      },
      novelChapterVersion: { create: vi.fn().mockResolvedValue({}) },
      novelChapterSeed: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      novelProject: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }));

    await (service as never as {
      persistGeneratedChapter(value: {
        userId: number; projectId: number; chapterId: number; jobId: string;
        chapterVersion: number; seedVersion: number; continuationMode: 'append'; continuationDraft: string;
      }, text: string): Promise<void>;
    }).persistGeneratedChapter({
      userId: 1,
      projectId: 2,
      chapterId: 3,
      jobId: 'job-append',
      chapterVersion: 1,
      seedVersion: 1,
      continuationMode: 'append',
      continuationDraft: '已有正文停在这里。',
    }, '从门外传来脚步声。');

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: '已有正文停在这里。\n\n从门外传来脚步声。' }),
    }));
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
        failure: expect.objectContaining({
          code: 'generation_failed',
          stage: 'runtime.generate',
          reason: 'fact guard blocked',
        }),
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
    const narrative = runtimeInput.workspaceDocuments.find((doc) => doc.type === 'narrative_state')?.content;
    expect(narrative).toBeTruthy();
    expect(JSON.parse(narrative ?? '')).toMatchObject({ chapters: [] });
  });

  it('passes the current chapter draft to the runtime in append mode', async () => {
    const { service, prisma, runtime, billing } = makeService({
      status: 'ok',
      result: { status: 'blocked', reason: 'test stop' },
    });

    await (service as never as { runHttpGeneration(value: typeof input & {
      continuationMode: 'append'; continuationDraft: string;
      targetWordCount: { min: number; max: number };
      runtimeWorkspaceInput: Record<string, unknown>;
    }): Promise<void> }).runHttpGeneration({
      ...input,
      continuationMode: 'append',
      continuationDraft: '作者已经完成的第十七章前半段。',
      targetWordCount: { min: 2500, max: 2750 },
      runtimeWorkspaceInput: { workspaceDocuments: [], projectConfig: {} },
    });

    expect(runtime.invoke).toHaveBeenCalledWith(
      expect.any(String),
      'novel_generate_chapter',
      expect.objectContaining({
        continuationMode: 'append',
        currentChapterDraft: '作者已经完成的第十七章前半段。',
        targetWordCount: { min: 2500, max: 2750 },
      }),
    );
    expect(billing.finalizeHold).toHaveBeenCalledWith({ jobId: 'job-1', outcome: 'failure' });
    expect(prisma.novelGenerationJob.update).toHaveBeenCalled();
  });

  it('does not invent default style, constitution, worldbuilding, or genre', async () => {
    const { service, prisma, runtime, billing } = makeService({
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

    expect(runtime.invoke).not.toHaveBeenCalled();
    expect(billing.finalizeHold).toHaveBeenCalledWith({ jobId: 'job-1', outcome: 'failure' });
    expect(prisma.novelGenerationJob.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'failed',
        failure: expect.objectContaining({
          code: 'runtime_preflight_failed',
          gate: 'author_contract',
          stage: 'runtime.preflight',
        }),
      }),
    }));
    const failure = prisma.novelGenerationJob.update.mock.calls.at(-1)?.[0]?.data?.failure as {
      reason?: string;
      userActionRequired?: string[];
    };
    expect(JSON.stringify(failure)).not.toContain('platform-default');
    expect(failure.userActionRequired).toEqual(expect.arrayContaining([
      '项目类型为空',
      '缺少作者确认的风格档案',
      '缺少作者确认的世界观',
      '缺少作者确认的创作宪法',
    ]));
  });

  it('passes compact canon and promises without filling empty ledgers', async () => {
    const { service, runtime } = makeService({
      status: 'ok',
      result: { status: 'blocked', reason: 'preflight' },
    });

    await (service as never as { runHttpGeneration(value: typeof input): Promise<void> }).runHttpGeneration(input);

    const runtimeInput = runtime.invoke.mock.calls[0][2] as {
      workspaceDocuments: Array<{ type: string; content: string }>;
      contextManifest: { blocks: Array<{ name: string; included: boolean }> };
    };
    const narrative = JSON.parse(
      runtimeInput.workspaceDocuments.find((doc) => doc.type === 'narrative_state')?.content ?? '{}',
    ) as { canon: unknown[]; promise: unknown[] };
    expect(narrative.canon ?? []).toEqual([]);
    expect(narrative.promise ?? []).toEqual([]);
    expect(runtimeInput.workspaceDocuments.find((doc) => doc.type === 'style_profile')?.content)
      .toBe('{"voice":"冷峻"}');
    expect(JSON.stringify(runtimeInput)).not.toContain('platform-default');
    expect(runtimeInput.contextManifest.blocks.find((block) => block.name === 'canonState')?.included)
      .toBe(false);
    expect(runtimeInput.contextManifest.blocks.find((block) => block.name === 'promiseLedger')?.included)
      .toBe(false);
  });

  it('persists a 422 seed_readiness envelope as runtime_preflight_failed', async () => {
    const { service, prisma, runtime, billing } = makeService({
      status: 'ok',
      result: { status: 'blocked', reason: 'preflight' },
    });
    runtime.invoke = vi.fn().mockRejectedValue(new JobFailureError(makeFailure({
      stage: 'preflight',
      gate: 'seed_readiness',
      code: FAILURE_CODES.runtimePreflightFailed,
      severity: 'preflight',
      reason: '[seed_readiness] ChapterSeed 种子可生长性不足（score=70/100, status=blocked）',
      recoverable: false,
      fixInstructions: ['补充前章承接'],
    })));

    await (service as never as { runHttpGeneration(value: typeof input): Promise<void> }).runHttpGeneration(input);

    expect(billing.finalizeHold).toHaveBeenCalledWith({ jobId: 'job-1', outcome: 'failure' });
    expect(prisma.novelGenerationJob.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'failed',
        failure: expect.objectContaining({
          code: 'runtime_preflight_failed',
          gate: 'seed_readiness',
          stage: 'preflight',
          reason: expect.stringContaining('seed_readiness'),
        }),
      }),
    }));
  });

  it('compiles book working set instead of stuffing previous-chapter prose', async () => {
    const { service, prisma, runtime } = makeService({
      status: 'ok',
      result: { status: 'blocked', reason: 'preflight' },
    });
    prisma.novelCharacter.findMany = vi.fn().mockResolvedValue([{
      name: '沈砚', aliases: [], roleType: 'protagonist', identity: '重生者',
      goals: '', motivation: '', personality: '', abilities: '', relationships: '',
      secrets: '', characterArc: '', currentState: '', notes: '', sortOrder: 0,
    }]);
    prisma.novelDocument.findMany = vi.fn().mockResolvedValue([
      {
        documentType: 'story_outline',
        title: '故事大纲',
        content: '[[CHAPTER_SEED_START]]\n章节号：2\n意图：复述第一章\n[[CHAPTER_SEED_END]]',
        updatedAt: new Date(),
        id: 1,
      },
      {
        documentType: 'creative_constitution',
        title: '宪法',
        content: '# 创作宪法\n不违背已确认身份',
        updatedAt: new Date(),
        id: 3,
      },
      {
        documentType: 'worldbuilding',
        title: '世界观',
        content: '# 世界观\n铜哨是旧案证物',
        updatedAt: new Date(),
        id: 4,
      },
      {
        documentType: 'style_profile',
        title: '风格',
        content: '{"voice":"冷峻"}',
        updatedAt: new Date(),
        id: 5,
      },
      {
        documentType: 'narrative_state',
        title: '状态',
        content: JSON.stringify({
          canon: [
            { id: 'canon:accepted-chapter:1', fact: '第1章接受稿末段：整章结尾原文，电动车穿过跨江大桥……' },
            { id: 'canon:whistle', fact: '现实中出现了十五年前遗失的铜哨' },
          ],
          character: [
            { characterId: '沈砚', field: 'acceptedChapterEvidence', value: '大段正文' },
            { characterId: '沈砚', field: 'participation', value: 'present' },
          ],
          promise: [{ description: '不要相信沈建国', status: 'open', sourceChapter: 'ch1' }],
          pattern: [{ patternType: 'sentence_risk', description: '翻译腔' }],
        }),
        updatedAt: new Date(),
        id: 2,
      },
    ]);
    // 按查询条件区分：前章（chapterNumber=1）返回正文全文；当前章（id 查询）
    // 返回空草稿。否则同一 mock 值会让 append 兜底把"前章正文"误当成
    // 当前章草稿传给 runtime，与"不得塞前章正文"的断言语义混淆。
    prisma.novelChapter.findFirst = vi.fn().mockImplementation(async (args: {
      where?: { chapterNumber?: number; id?: number };
    }) => {
      if (args?.where?.chapterNumber === 1) {
        return {
          content: '很长的前文。苏晴离开了。沈砚握紧铜哨：不要相信沈建国。',
          chapterNumber: 1,
        };
      }
      return { content: '', version: 1, chapterNumber: 2 };
    });

    await (service as never as { runHttpGeneration(value: typeof input): Promise<void> }).runHttpGeneration({
      ...input,
      chapterNumber: 2,
    });

    const runtimeInput = runtime.invoke.mock.calls[0][2] as {
      previousChapterText?: string;
      previousChapterContinuation?: { tailExcerpt?: string };
      workspaceDocuments: Array<{ type: string; content: string }>;
    };
    const explicit = runtimeInput.workspaceDocuments.find((doc) => doc.type === 'explicit_outline')?.content ?? '';
    const outline = runtimeInput.workspaceDocuments.find((doc) => doc.type === 'story_outline')?.content ?? '';
    const narrative = JSON.parse(
      runtimeInput.workspaceDocuments.find((doc) => doc.type === 'narrative_state')?.content ?? '{}',
    ) as { canon: Array<{ id?: string; fact?: string }>; pattern: unknown[] };

    expect(explicit).not.toContain('很长的前文');
    expect(explicit).not.toContain('电动车穿过跨江大桥');
    expect(explicit).toContain('伏笔埋设：不要相信沈建国');
    expect(outline).not.toContain('CHAPTER_SEED');
    expect(outline).not.toContain('很长的前文');
    expect(JSON.stringify(runtimeInput)).toContain('不要相信沈建国');
    expect(runtimeInput.previousChapterText).toBeUndefined();
    expect(runtimeInput.previousChapterContinuation?.tailExcerpt).toContain('不要相信沈建国');
    expect(runtimeInput.previousChapterContinuation?.tailExcerpt).not.toContain('很长的前文');
    expect(narrative.canon.map((row) => row.id)).toEqual(['canon:whistle']);
    expect(narrative.pattern).toEqual([]);
    expect(JSON.stringify(runtimeInput)).not.toContain('很长的前文。苏晴离开了。沈砚握紧铜哨：不要相信沈建国。');
  });

  it('ships the full story outline for FactGuard authorization alongside the clipped prompt copy', async () => {
    const { service, prisma, runtime } = makeService({
      status: 'ok',
      result: { status: 'blocked', reason: 'preflight' },
    });
    const tailTerm = '魂玉可以封印伤势。';
    prisma.novelDocument.findMany = vi.fn().mockResolvedValue([
      {
        documentType: 'story_outline',
        title: '故事大纲',
        content: `# 故事大纲\n${'很长的前文。'.repeat(8000)}${tailTerm}`,
        updatedAt: new Date(),
        id: 1,
      },
      { documentType: 'style_profile', title: '风格', content: '{"voice":"冷峻"}', updatedAt: new Date(), id: 5 },
      { documentType: 'narrative_state', title: '状态', content: '{"chapters":[]}', updatedAt: new Date(), id: 2 },
      { documentType: 'creative_constitution', title: '宪法', content: '# 创作宪法\n不违背已确认身份', updatedAt: new Date(), id: 3 },
      { documentType: 'worldbuilding', title: '世界观', content: '# 世界观\n铜哨是旧案证物', updatedAt: new Date(), id: 4 },
    ]);
    prisma.novelChapter.findFirst = vi.fn().mockResolvedValue({
      content: '第一章正文。沈砚握紧铜哨。',
      chapterNumber: 1,
    });

    await (service as never as { runHttpGeneration(value: typeof input): Promise<void> }).runHttpGeneration({
      ...input,
      chapterNumber: 2,
    });

    const runtimeInput = runtime.invoke.mock.calls[0][2] as {
      workspaceDocuments: Array<{ type: string; content: string }>;
    };
    const clipped = runtimeInput.workspaceDocuments.find((doc) => doc.type === 'story_outline')?.content ?? '';
    const full = runtimeInput.workspaceDocuments.find((doc) => doc.type === 'story_outline_full')?.content ?? '';

    // 提示词副本仍受 token 预算裁剪。
    expect(clipped).not.toContain('封印');
    // 授权副本必须带上大纲尾部的高影响术语，否则 FactGuard 硬阻断整章。
    expect(full).toContain('封印');
  });

  it('blocks generation when narrative state hash does not match previous chapter text', async () => {
    const { service, prisma, runtime, billing } = makeService({
      status: 'ok',
      result: { status: 'ok', text: '不应生成', metering: { modelCallCount: 1 } },
    });
    prisma.novelDocument.findMany = vi.fn().mockResolvedValue([
      {
        documentType: 'narrative_state',
        title: '状态',
        content: JSON.stringify({
          canon: [{
            id: 'canon:whistle',
            sourceChapter: 'ch1',
            sourceRef: 'ch1#finalText:39e1530b9e06:12-40',
            fact: '现实中出现了十五年前遗失的铜哨',
          }],
          character: [],
          promise: [],
        }),
        updatedAt: new Date(),
        id: 2,
      },
    ]);
    prisma.novelChapter.findFirst = vi.fn().mockResolvedValue({
      content: '很长的前文。苏晴离开了。沈砚握紧铜哨：不要相信沈建国。',
      chapterNumber: 1,
    });

    await (service as never as { runHttpGeneration(value: typeof input): Promise<void> }).runHttpGeneration({
      ...input,
      chapterNumber: 2,
    });

    expect(runtime.invoke).not.toHaveBeenCalled();
    expect(billing.finalizeHold).toHaveBeenCalledWith({ jobId: 'job-1', outcome: 'failure' });
    expect(prisma.novelGenerationJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'failed',
        failureMessage: expect.stringContaining('哈希'),
        failure: expect.objectContaining({
          code: 'state_store_hash_mismatch',
          stage: 'runtime.preflight',
          recoverable: false,
        }),
      }),
    }));
  });

  it('returns the stored failure envelope from getJob', async () => {
    const { service, prisma } = makeService({ status: 'ok', result: {} });
    prisma.novelGenerationJob.findFirst = vi.fn().mockResolvedValue({
      jobId: 'job-1',
      projectId: 2,
      chapterId: 3,
      jobType: 'chapter_generation',
      status: 'failed',
      progressStage: 'checking_materials',
      maxCharge: 100n,
      settledAmount: 0n,
      failureMessage: '前章叙事状态与正文哈希不一致',
      failure: {
        stage: 'runtime.preflight',
        gate: 'narrative_state',
        code: 'state_store_hash_mismatch',
        severity: 'preflight',
        reason: '前章叙事状态与正文哈希不一致',
        recoverable: false,
      },
      startedAt: new Date(),
      completedAt: new Date(),
    });
    const view = await service.getJob(1, 'job-1') as {
      failure: { code: string; stage: string; retryPlan?: string };
      failureMessage: string;
    };
    expect(view.failureMessage).toContain('哈希');
    expect(view.failure.code).toBe('state_store_hash_mismatch');
    expect(view.failure.stage).toBe('runtime.preflight');
    expect(view.failure.retryPlan).toBeUndefined();
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
        failure: expect.objectContaining({
          code: 'generation_failed',
          stage: 'runtime.generate',
        }),
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
        failure: expect.objectContaining({
          code: 'generation_failed',
          stage: 'runtime.generate',
          recoverable: true,
          retryPlan: 'retry_same_stage',
        }),
      }),
    }));
  });

  it('stores narrative_state_commit_failed when runtime state cannot be committed', async () => {
    const { service, prisma, billing } = makeService({
      status: 'ok',
      result: { status: 'ok', text: '可交付正文', runtimeState: 'not-an-object' },
      metering: { modelCallCount: 1 },
    });
    prisma.$transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      novelChapter: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          version: 2, title: '第1章', content: '可交付正文', wordCount: 5,
        }),
      },
      novelChapterVersion: { create: vi.fn() },
      novelChapterSeed: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      novelProject: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      novelDocument: { findFirst: vi.fn() },
      novelDocumentVersion: { create: vi.fn() },
      novelGenerationJob: { update: vi.fn() },
    }));

    await (service as never as { runHttpGeneration(value: typeof input): Promise<void> }).runHttpGeneration(input);

    expect(billing.finalizeHold).toHaveBeenCalledWith({ jobId: 'job-1', outcome: 'failure' });
    expect(prisma.novelGenerationJob.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'failed',
        failure: expect.objectContaining({
          code: 'narrative_state_commit_failed',
          stage: 'runtime.commit',
        }),
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
