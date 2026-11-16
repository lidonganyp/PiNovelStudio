/** 章节内容评审顾问（advisory）单元测试。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({
  PINOVEL_CHAPTER_REVIEW_MODE: 'advisory' as 'advisory' | 'blocking' | 'off',
  PINOVEL_CHAPTER_REVIEW_MODEL: 'review-model',
  PINOVEL_CHAPTER_REVIEW_BASE_URL: 'http://reviewer.local',
  PINOVEL_CHAPTER_REVIEW_API_KEY: 'test-key',
  PINOVEL_CHAPTER_REVIEW_TIMEOUT_MS: 5000,
}));

vi.mock('../../config/env', () => ({ env: envMock }));

import { ChapterReviewAdvisorService } from './chapter-review-advisor.service';

const CHAPTER = {
  id: 3,
  projectId: 2,
  userId: 1,
  chapterNumber: 1,
  title: '第一章',
  content: '夜色沉沉。林远推开木门，看见桌上的一封信。',
  version: 5,
  deletedAt: null,
  seed: { intent: '开场悬念', endingGoal: '引出信件' },
};

function makePrisma(chapter: typeof CHAPTER | null = CHAPTER) {
  const traceCreate = vi.fn().mockResolvedValue({ id: 1 });
  const reviewUpsert = vi.fn().mockResolvedValue({ id: 1 });
  const chapterUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    novelChapter: {
      findFirst: vi.fn().mockResolvedValue(chapter),
    },
    novelChapterReview: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          novelChapterReviewTrace: { create: traceCreate },
          novelChapterReview: { upsert: reviewUpsert },
          novelChapter: { updateMany: chapterUpdateMany },
        }),
    ),
  };
  return { prisma, traceCreate, reviewUpsert, chapterUpdateMany };
}

function reviewerResponse(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('ChapterReviewAdvisorService', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockReset();
    envMock.PINOVEL_CHAPTER_REVIEW_MODE = 'advisory';
    envMock.PINOVEL_CHAPTER_REVIEW_MODEL = 'review-model';
    envMock.PINOVEL_CHAPTER_REVIEW_BASE_URL = 'http://reviewer.local';
    envMock.PINOVEL_CHAPTER_REVIEW_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseInput = {
    userId: 1,
    projectId: 2,
    chapterId: 3,
    chapterVersion: 5,
    generationJobId: 'job-1',
  };

  it('span 逐字校验：过滤不存在于正文中的证据片段并标记提示', async () => {
    fetchSpy.mockResolvedValue(
      reviewerResponse({
        verdict: 'approve',
        rationale: '开场节奏紧凑',
        risks: [],
        evidenceSpans: ['夜色沉沉', '凭空捏造的片段'],
      }),
    );
    const { prisma, reviewUpsert, traceCreate } = makePrisma();
    const service = new ChapterReviewAdvisorService(prisma as never);
    await service.reviewGeneratedChapter(baseInput);
    const completed = reviewUpsert.mock.calls.find(
      ([args]) => (args as { create: { status: string } }).create.status === 'completed',
    )?.[0] as { create: { evidenceSpans: string[]; error: string | null } };
    expect(completed.create.evidenceSpans).toEqual(['夜色沉沉']);
    expect(completed.create.error).toContain('未逐字命中');
    // quality-trace：pending + completed 两次状态流转均落追踪
    expect(traceCreate).toHaveBeenCalledTimes(2);
    expect(traceCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed', source: 'auto' }),
      }),
    );
  });

  it('评审模型 HTTP 失败：状态降级 failed 且不抛出异常（不阻断章节交付）', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 500 }));
    const { prisma, reviewUpsert, traceCreate } = makePrisma();
    const service = new ChapterReviewAdvisorService(prisma as never);
    await expect(
      service.reviewGeneratedChapter(baseInput),
    ).resolves.toBeUndefined();
    const statuses = reviewUpsert.mock.calls.map(
      ([args]) => (args as { create: { status: string } }).create.status,
    );
    expect(statuses).toEqual(['pending', 'failed']);
    expect(traceCreate).toHaveBeenCalledTimes(2);
    expect(traceCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          error: expect.stringContaining('HTTP 500'),
        }),
      }),
    );
  });

  it('章节版本已变化：评审结果直接丢弃，不写入任何记录', async () => {
    const { prisma, reviewUpsert, traceCreate } = makePrisma({
      ...CHAPTER,
      version: 6,
    });
    const service = new ChapterReviewAdvisorService(prisma as never);
    await service.reviewGeneratedChapter(baseInput);
    expect(reviewUpsert).not.toHaveBeenCalled();
    expect(traceCreate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('评审模型未配置：状态 failed（评审不可用），不调用模型', async () => {
    envMock.PINOVEL_CHAPTER_REVIEW_MODEL = '';
    const { prisma, reviewUpsert } = makePrisma();
    const service = new ChapterReviewAdvisorService(prisma as never);
    await service.reviewGeneratedChapter(baseInput);
    const failed = reviewUpsert.mock.calls[0]?.[0] as {
      create: { status: string; error: string };
    };
    expect(failed.create.status).toBe('failed');
    expect(failed.create.error).toContain('评审模型未配置');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('mode=off：状态 disabled 且不调用模型', async () => {
    envMock.PINOVEL_CHAPTER_REVIEW_MODE = 'off';
    const { prisma, reviewUpsert } = makePrisma();
    const service = new ChapterReviewAdvisorService(prisma as never);
    await service.reviewGeneratedChapter(baseInput);
    const disabled = reviewUpsert.mock.calls[0]?.[0] as {
      create: { status: string };
    };
    expect(disabled.create.status).toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('手动重新评审：trace 来源标记为 manual', async () => {
    fetchSpy.mockResolvedValue(
      reviewerResponse({
        verdict: 'hold',
        rationale: '节奏可再放缓',
        risks: ['悬念兑现偏慢'],
        evidenceSpans: [],
      }),
    );
    const { prisma, traceCreate } = makePrisma();
    const service = new ChapterReviewAdvisorService(prisma as never);
    await service.manualReview(1, 2, 3);
    expect(traceCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed', source: 'manual' }),
      }),
    );
  });

  it('评审输出缺少有效结论：降级 failed 且不抛出', async () => {
    fetchSpy.mockResolvedValue(
      reviewerResponse({ rationale: '没有结论字段' }),
    );
    const { prisma, reviewUpsert } = makePrisma();
    const service = new ChapterReviewAdvisorService(prisma as never);
    await expect(
      service.reviewGeneratedChapter(baseInput),
    ).resolves.toBeUndefined();
    const statuses = reviewUpsert.mock.calls.map(
      ([args]) => (args as { create: { status: string } }).create.status,
    );
    expect(statuses).toEqual(['pending', 'failed']);
  });
});
