import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AssistantService } from './assistant.service';

function makeService() {
  const tx = {
    novelGenerationJob: { update: vi.fn().mockResolvedValue({}) },
    novelAssistantMessage: {
      create: vi.fn().mockResolvedValue({
        id: 2,
        role: 'assistant',
        content: 'reply',
        jobId: 'job-1',
        createdAt: new Date(),
      }),
    },
  };
  const prisma = {
    novelProject: { findFirst: vi.fn().mockResolvedValue({ id: 2 }) },
    novelGenerationJob: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    novelBalanceHold: {
      findUnique: vi.fn().mockResolvedValue({ settledAmount: 4n }),
    },
    novelAssistantMessage: {
      create: vi.fn().mockResolvedValue({
        id: 1,
        role: 'user',
        content: 'hello',
        jobId: 'job-1',
        createdAt: new Date(),
      }),
    },
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const billing = {
    createHold: vi.fn().mockResolvedValue({}),
    settleCall: vi.fn().mockResolvedValue({}),
    finalizeHold: vi.fn().mockResolvedValue({ status: 'released', settledAmount: 4n }),
    finalizeHoldInTransaction: vi.fn().mockResolvedValue({ status: 'settled', settledAmount: 4n }),
  };
  const rates = { findEffectiveRate: vi.fn() };
  const jobs = {
    submitChapterGeneration: vi.fn(),
    assertAuthorContract: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service: new AssistantService(
      prisma as never,
      billing as never,
      rates as never,
      jobs as never,
    ),
    prisma,
    billing,
    jobs,
    tx,
  };
}

describe('AssistantService billing delivery contract', () => {
  it('skips settlement and still delivers when the planner model has no effective rate', async () => {
    const { service, billing, tx } = makeService();
    billing.settleCall.mockRejectedValue(
      new NotFoundException('未找到模型 gpt-5.6 的生效费率'),
    );

    const result = await service.post(1, 2, 'hello');

    expect(result.chunks[0]).toContain('这是规划回复');
    expect(billing.finalizeHold).not.toHaveBeenCalled();
    expect(billing.finalizeHoldInTransaction).toHaveBeenCalledWith(
      tx,
      { jobId: expect.any(String), outcome: 'success' },
    );
    expect(tx.novelAssistantMessage.create).toHaveBeenCalled();
  });

  it('fails the job instead of delivering free output when settlement fails', async () => {
    const { service, prisma, billing } = makeService();
    billing.settleCall.mockRejectedValue(new Error('settlement unavailable'));

    await expect(service.post(1, 2, 'hello')).rejects.toThrow('settlement unavailable');
    expect(billing.finalizeHold).toHaveBeenCalledWith({ jobId: expect.any(String), outcome: 'failure' });
    expect(prisma.novelGenerationJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', settledAmount: 4n }),
    }));
  });

  it('persists the assistant reply and successful billing in one transaction', async () => {
    const { service, billing, tx } = makeService();

    await service.post(1, 2, 'hello');

    expect(billing.finalizeHoldInTransaction).toHaveBeenCalledWith(
      tx,
      { jobId: expect.any(String), outcome: 'success' },
    );
    expect(tx.novelGenerationJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'succeeded', settledAmount: 4n }),
    }));
    expect(tx.novelAssistantMessage.create).toHaveBeenCalled();
  });

  it('releases the hold when persisting the user message fails after reservation', async () => {
    const { service, prisma, billing } = makeService();
    prisma.novelAssistantMessage.create.mockRejectedValueOnce(new Error('message write failed'));

    await expect(service.post(1, 2, 'hello')).rejects.toThrow('聊天消息保存失败，请稍后重试');
    expect(billing.settleCall).not.toHaveBeenCalled();
    expect(billing.finalizeHold).toHaveBeenCalledWith({
      jobId: expect.any(String),
      outcome: 'failure',
    });
    expect(prisma.novelGenerationJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', settledAmount: 4n }),
    }));
  });

  it('turns missing author materials into a steward confirmation instead of a technical error', async () => {
    const { service, prisma, billing, jobs } = makeService();
    prisma.novelProject.findFirst.mockResolvedValue({
      id: 128, userId: 1, title: '铜哨', description: '', genre: '',
      subGenres: [], worldKeyTerms: [], version: 1, deletedAt: null,
    });
    const db = prisma as typeof prisma & {
      novelDocument: Record<string, ReturnType<typeof vi.fn>>;
      novelDocumentVersion: Record<string, ReturnType<typeof vi.fn>>;
      novelCharacter: Record<string, ReturnType<typeof vi.fn>>;
      novelOutlineNode: Record<string, ReturnType<typeof vi.fn>>;
      novelChapter: Record<string, ReturnType<typeof vi.fn>>;
    };
    db.novelDocument = {
      findMany: vi.fn().mockResolvedValue([{
        id: 83, documentType: 'story_outline',
        content: '# 故事大纲\n2. 第二章：不要相信沈建国\n   追查禁令',
        currentVersion: 1, updatedAt: new Date(), deletedAt: null,
      }]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 9, currentVersion: 1 }),
      update: vi.fn(),
    };
    db.novelDocumentVersion = { create: vi.fn() };
    db.novelCharacter = {
      findMany: vi.fn().mockResolvedValue([{
        id: 1, name: '沈砚', roleType: 'protagonist', identity: '重生者',
        goals: '', motivation: '', currentState: '', relationships: '',
        secrets: '', characterArc: '', version: 1,
      }]),
    };
    db.novelOutlineNode = {
      findMany: vi.fn().mockResolvedValue([{
        title: '第二章：不要相信沈建国', summary: '追查禁令', nodeType: 'chapter',
        narrativeGoal: '推进禁令', version: 1,
      }]),
    };
    db.novelChapter = {
      findMany: vi.fn().mockResolvedValue([{
        chapterNumber: 1, title: '第一章',
        content: '沈砚握紧铜哨：不要相信沈建国。',
        wordCount: 16, version: 1, seed: null,
      }]),
    };
    prisma.novelAssistantMessage.create
      .mockResolvedValueOnce({
        id: 1, role: 'user', content: '生成第二章', jobId: '', createdAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: 2, role: 'assistant', content: '草案', jobId: '', createdAt: new Date(),
      });

    const result = await service.post(1, 128, '生成第二章');
    expect(result.steward?.status).toBe('confirmation_required');
    expect(result.chunks[0]).toContain('仍需你确认的内容');
    expect(result.generationJobId).toBeUndefined();
    expect(jobs.assertAuthorContract).not.toHaveBeenCalled();
    expect(jobs.submitChapterGeneration).not.toHaveBeenCalled();
    expect(billing.createHold).not.toHaveBeenCalled();
    expect(prisma.novelGenerationJob.create).not.toHaveBeenCalled();
  });

  it('submits novel_generate_chapter when author materials are already ready', async () => {
    const { service, prisma, billing, jobs } = makeService();
    jobs.submitChapterGeneration.mockResolvedValue({ jobId: 'gen-ready' });
    prisma.novelProject.findFirst.mockResolvedValue({
      id: 128, userId: 1, title: '铜哨', description: '都市重生', genre: '都市重生',
      subGenres: ['重生'], worldKeyTerms: ['铜哨'], version: 4, deletedAt: null,
    });
    const db = prisma as typeof prisma & {
      novelDocument: Record<string, ReturnType<typeof vi.fn>>;
      novelCharacter: Record<string, ReturnType<typeof vi.fn>>;
      novelOutlineNode: Record<string, ReturnType<typeof vi.fn>>;
      novelChapter: Record<string, ReturnType<typeof vi.fn>>;
    };
    db.novelDocument = {
      findMany: vi.fn().mockResolvedValue([
        { id: 5, documentType: 'narrative_state', content: JSON.stringify({ canon: [{ fact: 'copper whistle exists' }], promise: [{ description: 'solve the disappearance' }] }), currentVersion: 1, updatedAt: new Date(), deletedAt: null },
        { id: 1, documentType: 'story_outline', content: '# 大纲\n2. 第二章', currentVersion: 1, updatedAt: new Date(), deletedAt: null },
        { id: 2, documentType: 'worldbuilding', content: '# 世界观\n- 铜哨', currentVersion: 1, updatedAt: new Date(), deletedAt: null },
        { id: 3, documentType: 'creative_constitution', content: '# 创作宪法\n- 不违背身份', currentVersion: 1, updatedAt: new Date(), deletedAt: null },
        { id: 4, documentType: 'style_profile', content: '{"editorialGuidance":["克制"]}', currentVersion: 1, updatedAt: new Date(), deletedAt: null },
      ]),
    };
    db.novelCharacter = {
      findMany: vi.fn().mockResolvedValue([{
        id: 1, name: '沈砚', roleType: 'protagonist', identity: '重生者',
        goals: '查清失踪', motivation: '确认父亲隐瞒', currentState: '握着铜哨',
        relationships: '', secrets: '', characterArc: '', version: 2,
      }]),
    };
    db.novelOutlineNode = { findMany: vi.fn().mockResolvedValue([]) };
    db.novelChapter = {
      findMany: vi.fn().mockResolvedValue([{
        chapterNumber: 2, title: '第二章', content: '', wordCount: 0, version: 1,
        seed: { intent: '追查铜哨', mustInclude: '', forbiddenFacts: '', characterMotives: '', promises: '', endingGoal: '留下新压力', version: 1 },
      }]),
      findFirst: vi.fn().mockResolvedValue({
        id: 44, chapterNumber: 2, seed: { intent: '追查铜哨', endingGoal: '留下新压力' },
      }),
    };
    prisma.novelAssistantMessage.create
      .mockResolvedValueOnce({ id: 1, role: 'user', content: '生成第二章', jobId: '', createdAt: new Date() })
      .mockResolvedValueOnce({ id: 2, role: 'assistant', content: '已提交', jobId: 'gen-ready', createdAt: new Date() });

    const result = await service.post(1, 128, '生成第二章');
    expect(result.generationJobId).toBe('gen-ready');
    expect(result.steward?.status).toBe('ready');
    expect(result.artifacts?.publicEntry).toBe('novel_generate_chapter');
    expect(jobs.submitChapterGeneration).toHaveBeenCalledTimes(1);
    expect(billing.createHold).not.toHaveBeenCalled();
    expect(prisma.novelGenerationJob.create).not.toHaveBeenCalled();
  });

  it('cancel steward action does not create a generation job or billing hold', async () => {
    const { service, prisma, billing, jobs } = makeService();
    const proposal = {
      id: 'prop-cancel',
      projectId: 128,
      chapterNumber: 2,
      sourceVersion: 'abc',
      status: 'pending',
      proposals: [],
      missing: ['世界观'],
      createdAt: new Date().toISOString(),
    };
    const db = prisma as typeof prisma & {
      novelDocument: Record<string, ReturnType<typeof vi.fn>>;
      novelDocumentVersion: Record<string, ReturnType<typeof vi.fn>>;
    };
    db.novelDocument = {
      findFirst: vi.fn().mockResolvedValue({ id: 9, currentVersion: 1, content: JSON.stringify(proposal) }),
      update: vi.fn(),
    };
    db.novelDocumentVersion = { create: vi.fn() };
    prisma.novelAssistantMessage.create
      .mockResolvedValueOnce({ id: 1, role: 'user', content: '取消', jobId: '', createdAt: new Date() })
      .mockResolvedValueOnce({ id: 2, role: 'assistant', content: '已取消', jobId: '', createdAt: new Date() });

    const result = await service.post(1, 128, {
      content: '取消',
      stewardAction: 'cancel',
      proposalId: 'prop-cancel',
      sourceVersion: 'abc',
    });
    expect(result.generationJobId).toBeUndefined();
    expect(jobs.submitChapterGeneration).not.toHaveBeenCalled();
    expect(billing.createHold).not.toHaveBeenCalled();
    expect(result.steward?.proposalStatus).toBe('cancelled');
  });
});
