import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { BillingService } from './billing.service';

describe('BillingService capAtHold settlement', () => {
  // 费率 1 分/百万 token：charge = tokensIn + tokensOut（分），便于构造超占场景。
  const rateSnapshot = { inputPricePerMillion: '1000000', outputPricePerMillion: '1000000' };

  function makeTx(hold: { amount: bigint; settledAmount: bigint }) {
    return {
      novelGenerationCall: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
          jobId: data.jobId,
          callId: data.callId,
          actualCharge: data.actualCharge,
          chargeFromReal: data.chargeFromReal,
          chargeFromBonus: data.chargeFromBonus,
        })),
      },
      novelBalanceHold: {
        findUnique: vi.fn().mockResolvedValue({
          id: 1,
          jobId: 'job-cap',
          userId: 7,
          amount: hold.amount,
          settledAmount: hold.settledAmount,
          status: 'active',
        }),
        update: vi.fn().mockImplementation(({ data }: { data: { settledAmount: { increment: bigint } } }) => ({
          id: 1,
          jobId: 'job-cap',
          userId: 7,
          amount: hold.amount,
          settledAmount: hold.settledAmount + data.settledAmount.increment,
          status: 'active',
        })),
      },
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 7, balance: 100000n, bonusBalance: 0n }),
        update: vi.fn().mockResolvedValue({}),
      },
      $executeRaw: vi.fn().mockResolvedValue(0),
    };
  }

  function makeService(tx: ReturnType<typeof makeTx>) {
    const prisma = {
      novelGenerationCall: { findUnique: vi.fn().mockResolvedValue(null) },
      novelBalanceHold: { findUnique: vi.fn() },
      $transaction: vi.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    };
    const rates = { buildRateSnapshot: vi.fn().mockResolvedValue(rateSnapshot) };
    return {
      service: new BillingService(prisma as never, rates as never),
      prisma,
      tx,
    };
  }

  it('caps the charge at the remaining hold budget when capAtHold is set', async () => {
    const tx = makeTx({ amount: 50n, settledAmount: 0n });
    const { service } = makeService(tx);

    const result = await service.settleCall({
      jobId: 'job-cap',
      callId: 'call-1',
      internalStage: 'chat',
      model: 'gpt-x',
      tokensIn: 30,
      tokensOut: 70, // 名义 charge = 100 分 > 预占 50 分
      capAtHold: true,
    });

    expect(result.actualCharge).toBe(50n);
    expect(result.settledAmount).toBe(50n);
    expect(tx.novelGenerationCall.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actualCharge: 50n, tokensIn: 30, tokensOut: 70 }),
    }));
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { balance: { decrement: 50n }, bonusBalance: { decrement: 0n } },
    }));
  });

  it('charges the full amount when capAtHold is set but within budget', async () => {
    const tx = makeTx({ amount: 200n, settledAmount: 0n });
    const { service } = makeService(tx);

    const result = await service.settleCall({
      jobId: 'job-cap',
      callId: 'call-1',
      internalStage: 'chat',
      model: 'gpt-x',
      tokensIn: 30,
      tokensOut: 70, // charge = 100 分 < 预占 200 分
      capAtHold: true,
    });

    expect(result.actualCharge).toBe(100n);
    expect(result.remainingBudget).toBe(100n);
  });

  it('still rejects over-budget settlement without capAtHold', async () => {
    const tx = makeTx({ amount: 50n, settledAmount: 0n });
    const { service } = makeService(tx);

    await expect(service.settleCall({
      jobId: 'job-cap',
      callId: 'call-1',
      internalStage: 'chat',
      model: 'gpt-x',
      tokensIn: 30,
      tokensOut: 70,
    })).rejects.toMatchObject({ status: 402 });
    expect(tx.novelGenerationCall.create).not.toHaveBeenCalled();
  });
});

describe('BillingService settlement idempotency', () => {
  it('rejects reuse of a call id with different call details', async () => {
    const prisma = {
      novelGenerationCall: {
        findUnique: vi.fn().mockResolvedValue({
          jobId: 'job-1',
          callId: 'call-1',
          internalStage: 'agentic_raw',
          model: 'model-a',
          tokensIn: 10,
          tokensOut: 20,
          actualCharge: 3n,
        }),
      },
      novelBalanceHold: {
        findUnique: vi.fn().mockResolvedValue({
          amount: 100n,
          settledAmount: 3n,
        }),
      },
    };
    const service = new BillingService(prisma as never, {} as never);

    await expect(service.settleCall({
      jobId: 'job-1',
      callId: 'call-1',
      internalStage: 'style_optimizer',
      model: 'model-a',
      tokensIn: 10,
      tokensOut: 20,
    })).rejects.toMatchObject({ status: 409 });
  });

  it('also rejects a mismatched call id after a concurrent insert race', async () => {
    const existing = {
      jobId: 'job-1',
      callId: 'call-1',
      internalStage: 'agentic_raw',
      model: 'model-a',
      tokensIn: 10,
      tokensOut: 20,
      actualCharge: 3n,
    };
    const prisma = {
      novelGenerationCall: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(existing),
      },
      novelBalanceHold: {
        findUnique: vi.fn().mockResolvedValue({ amount: 100n, settledAmount: 3n }),
      },
      $transaction: vi.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      ),
    };
    const service = new BillingService(prisma as never, {
      buildRateSnapshot: vi.fn().mockResolvedValue({
        inputPricePerMillion: '1', outputPricePerMillion: '1',
      }),
    } as never);

    await expect(service.settleCall({
      jobId: 'job-1',
      callId: 'call-1',
      internalStage: 'style_optimizer',
      model: 'model-a',
      tokensIn: 10,
      tokensOut: 20,
    })).rejects.toMatchObject({ status: 409 });
  });
});
