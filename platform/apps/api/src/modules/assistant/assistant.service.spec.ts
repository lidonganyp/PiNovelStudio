import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env';
import { FailureHttpException, FAILURE_CODES, makeFailure } from '../context/failure-envelope';
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

  it('blocks generate-chapter chat on author_contract before planner, hold, or job create', async () => {
    const { service, prisma, billing, jobs } = makeService();
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
    jobs.assertAuthorContract.mockRejectedValue(authorBlock);

    await expect(service.post(1, 128, '生成第二章')).rejects.toMatchObject({
      envelope: expect.objectContaining({
        gate: 'author_contract',
        code: 'runtime_preflight_failed',
        userActionRequired: expect.arrayContaining([
          '项目类型为空',
          '缺少作者确认的风格档案',
          '缺少作者确认的世界观',
          '缺少作者确认的创作宪法',
        ]),
      }),
    });
    expect(jobs.assertAuthorContract).toHaveBeenCalledWith(1, 128);
    expect(jobs.submitChapterGeneration).not.toHaveBeenCalled();
    expect(billing.createHold).not.toHaveBeenCalled();
    expect(prisma.novelGenerationJob.create).not.toHaveBeenCalled();
  });

  it('runs generation author preflight before the planner-disabled guard', async () => {
    const { service, prisma, billing, jobs } = makeService();
    const authorBlock = new FailureHttpException(makeFailure({
      stage: 'runtime.preflight',
      gate: 'author_contract',
      code: FAILURE_CODES.runtimePreflightFailed,
      severity: 'preflight',
      reason: 'author materials are incomplete',
      recoverable: false,
      userActionRequired: ['project genre is empty'],
    }));
    jobs.assertAuthorContract.mockRejectedValue(authorBlock);
    const previousPlannerMode = env.PLANNER_MODE;
    env.PLANNER_MODE = 'disabled';
    try {
      await expect(service.post(1, 128, '生成第二章')).rejects.toMatchObject({
        envelope: expect.objectContaining({
          code: FAILURE_CODES.runtimePreflightFailed,
          gate: 'author_contract',
        }),
      });
    } finally {
      env.PLANNER_MODE = previousPlannerMode;
    }
    expect(jobs.assertAuthorContract).toHaveBeenCalledWith(1, 128);
    expect(prisma.novelGenerationJob.create).not.toHaveBeenCalled();
    expect(billing.createHold).not.toHaveBeenCalled();
  });

  it('keeps generation blocked after a successful preflight when the planner is disabled', async () => {
    const { service, prisma, billing, jobs } = makeService();
    const previousPlannerMode = env.PLANNER_MODE;
    env.PLANNER_MODE = 'disabled';
    try {
      await expect(service.post(1, 128, '生成第二章')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    } finally {
      env.PLANNER_MODE = previousPlannerMode;
    }
    expect(jobs.assertAuthorContract).toHaveBeenCalledWith(1, 128);
    expect(prisma.novelGenerationJob.create).not.toHaveBeenCalled();
    expect(billing.createHold).not.toHaveBeenCalled();
  });
});
