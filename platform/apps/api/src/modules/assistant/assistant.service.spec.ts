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
  const jobs = { submitChapterGeneration: vi.fn() };
  return {
    service: new AssistantService(
      prisma as never,
      billing as never,
      rates as never,
      jobs as never,
    ),
    prisma,
    billing,
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

    await expect(service.post(1, 2, 'hello')).rejects.toThrow('message write failed');
    expect(billing.settleCall).not.toHaveBeenCalled();
    expect(billing.finalizeHold).toHaveBeenCalledWith({
      jobId: expect.any(String),
      outcome: 'failure',
    });
    expect(prisma.novelGenerationJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', settledAmount: 4n }),
    }));
  });
});
