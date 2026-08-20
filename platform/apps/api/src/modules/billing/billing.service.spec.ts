import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { BillingService } from './billing.service';

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
