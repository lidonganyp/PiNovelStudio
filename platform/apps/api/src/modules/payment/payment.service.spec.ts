import { describe, expect, it, vi } from 'vitest';
import { PaymentService } from './payment.service';

function makeService(queryResult: unknown, createdAt: Date) {
  const order = {
    orderNo: 'PO-1',
    userId: 7,
    channel: 'alipay',
    amount: 100n,
    status: 'created',
    qrContent: '',
    payUrl: null,
    paidAt: null,
    createdAt,
  };
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    paymentOrder: {
      findMany: vi.fn().mockResolvedValue([order]),
      updateMany,
    },
  };
  const adapter = {
    queryPayment: vi.fn().mockResolvedValue(queryResult),
  };
  const service = new PaymentService(prisma as never, { alipay: adapter } as never);
  return { service, updateMany, adapter };
}

describe('PaymentService reconciliation safety', () => {
  it('does not expire an order when the payment provider query is unavailable', async () => {
    const { service, updateMany } = makeService(
      { status: 'unknown' },
      new Date(Date.now() - 31 * 60 * 1000),
    );

    const result = await service.reconcilePendingOrders();

    expect(result).toEqual({ credited: 0, expired: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('continues safely when one provider query throws instead of expiring the order', async () => {
    const { service, updateMany } = makeService(
      { status: 'unpaid' },
      new Date(Date.now() - 31 * 60 * 1000),
    );
    const prisma = (service as never as { prisma: { paymentOrder: { findMany: ReturnType<typeof vi.fn> } } }).prisma;
    const adapter = {
      queryPayment: vi.fn().mockRejectedValue(new Error('provider timeout')),
    };
    (service as never as { adapters: Record<string, unknown> }).adapters.alipay = adapter;
    prisma.paymentOrder.findMany.mockResolvedValue([{
      orderNo: 'PO-1', userId: 7, channel: 'alipay', amount: 100n, status: 'created',
      qrContent: '', payUrl: null, paidAt: null, createdAt: new Date(Date.now() - 31 * 60 * 1000),
    }]);

    await expect(service.reconcilePendingOrders()).resolves.toEqual({ credited: 0, expired: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('expires an overdue order only when the provider explicitly reports it closed', async () => {
    const { service, updateMany } = makeService(
      { status: 'closed' },
      new Date(Date.now() - 31 * 60 * 1000),
    );

    const result = await service.reconcilePendingOrders();

    expect(result).toEqual({ credited: 0, expired: 1 });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { orderNo: 'PO-1', status: 'created' },
      data: { status: 'expired' },
    }));
  });

  it('does not expire an overdue order from an unpaid snapshot because payment can race after the query', async () => {
    const { service, updateMany } = makeService(
      { status: 'unpaid' },
      new Date(Date.now() - 31 * 60 * 1000),
    );

    await expect(service.reconcilePendingOrders()).resolves.toEqual({
      credited: 0,
      expired: 0,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('maps a provider trade-number collision to a conflict instead of a 500', async () => {
    const { service } = makeService({ status: 'unpaid' }, new Date());
    const adapter = (service as never as { adapters: Record<string, { verifyNotify: () => Promise<unknown> }> }).adapters.alipay;
    adapter.verifyNotify = vi.fn().mockResolvedValue({
      orderNo: 'PO-1', amountFen: 100n, externalTradeNo: 'already-used',
    });
    const prisma = (service as never as { prisma: { $transaction: ReturnType<typeof vi.fn> } }).prisma;
    prisma.$transaction = vi.fn().mockRejectedValue({ code: 'P2002' });

    await expect(service.handleNotify('alipay', { body: {} })).rejects.toMatchObject({ status: 409 });
  });
});
