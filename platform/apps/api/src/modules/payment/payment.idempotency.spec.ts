import { describe, expect, it, vi } from 'vitest';
import { PaymentService } from './payment.service';

describe('PaymentService paid-notification identity', () => {
  it('rejects a duplicate notification when its paid transaction identity differs', async () => {
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
        $executeRaw: vi.fn(),
        paymentOrder: {
          findUnique: vi.fn().mockResolvedValue({
            orderNo: 'PO-1',
            channel: 'alipay',
            amount: 100n,
            externalTradeNo: 'TRADE-ORIGINAL',
            status: 'paid',
          }),
        },
      })),
    };
    const adapter = {
      verifyNotify: vi.fn().mockResolvedValue({
        orderNo: 'PO-1', amountFen: 100n, externalTradeNo: 'TRADE-DIFFERENT',
      }),
    };
    const service = new PaymentService(prisma as never, { alipay: adapter } as never);

    await expect(service.handleNotify('alipay', { body: {} })).rejects.toMatchObject({ status: 409 });
  });
});
