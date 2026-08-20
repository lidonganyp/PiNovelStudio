/**
 * 支付订单状态机单测（真实 PostgreSQL，对照 development-plan.md §9.2）。
 * 覆盖：下单、通知入账、重复通知不重复入账、金额不符拒绝、查单补偿、过期。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentService } from '../src/modules/payment/payment.service';
import type {
  ChannelQueryResult,
  PaymentChannelAdapter,
} from '../src/modules/payment/payment.types';

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

class FakeAdapter implements PaymentChannelAdapter {
  readonly channel = 'alipay';
  paidByOrderNo = new Map<string, ChannelQueryResult>();

  async createPayment(order: {
    orderNo: string;
  }): Promise<{ qrContent: string }> {
    return { qrContent: `fake-qr:${order.orderNo}` };
  }

  async verifyNotify(input: {
    body: unknown;
  }): Promise<{ orderNo: string; amountFen: bigint; externalTradeNo: string }> {
    const body = input.body as {
      orderNo: string;
      amount: number;
      tradeNo: string;
    };
    return {
      orderNo: body.orderNo,
      amountFen: BigInt(body.amount),
      externalTradeNo: body.tradeNo,
    };
  }

  async queryPayment(orderNo: string): Promise<ChannelQueryResult> {
    return this.paidByOrderNo.get(orderNo) ?? { status: 'unpaid' };
  }
}

describe('PaymentService', () => {
  let prisma: PrismaService;
  let payment: PaymentService;
  let adapter: FakeAdapter;
  let userId: number;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    adapter = new FakeAdapter();
    payment = new PaymentService(prisma, {
      alipay: adapter,
      wechat: adapter,
    });
    const user = await prisma.user.create({
      data: {
        email: `pay-user-${runId}@test.local`,
        passwordHash: 'x',
        nickname: '支付用户',
        balance: 0n,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    const raw = new PrismaClient();
    try {
      const users = await raw.user.findMany({
        where: { email: { contains: runId } },
        select: { id: true },
      });
      const userIds = users.map((item) => item.id);
      await raw.auditLog.deleteMany({
        where: { targetId: { contains: runId } },
      });
      await raw.paymentOrder.deleteMany({ where: { userId: { in: userIds } } });
      await raw.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await raw.$disconnect();
      await prisma.$disconnect();
    }
  });

  it('下单创建 created 订单并返回收款码内容', async () => {
    const order = await payment.createOrder({
      userId,
      channel: 'alipay',
      amountFen: 1000n,
    });
    expect(order.status).toBe('created');
    expect(order.amount).toBe(1000n);
    expect(order.qrContent).toContain('fake-qr:');
    expect(order.orderNo.startsWith('PO')).toBe(true);
    // WeChat Native out_trade_no is limited to 32 characters.
    expect(order.orderNo.length).toBeLessThanOrEqual(32);
  });

  it('keeps a local order pending when provider order creation has an ambiguous failure', async () => {
    const createPayment = vi.spyOn(adapter, 'createPayment').mockRejectedValueOnce(
      new Error('provider unavailable'),
    );

    await expect(
      payment.createOrder({ userId, channel: 'alipay', amountFen: 1100n }),
    ).rejects.toThrow('provider unavailable');

    const pending = await prisma.paymentOrder.findFirstOrThrow({
      where: { userId, amount: 1100n },
      orderBy: { createdAt: 'desc' },
    });
    expect(pending.status).toBe('created');
    expect(pending.qrContent).toBe('');
    createPayment.mockRestore();
  });

  it('keeps an uncertain provider result reconcilable so a paid order cannot be stranded', async () => {
    const createPayment = vi.spyOn(adapter, 'createPayment').mockRejectedValueOnce(
      new Error('provider response timeout after order creation'),
    );

    await expect(
      payment.createOrder({ userId, channel: 'alipay', amountFen: 1150n }),
    ).rejects.toThrow('provider response timeout after order creation');

    const uncertain = await prisma.paymentOrder.findFirstOrThrow({
      where: { userId, amount: 1150n },
      orderBy: { createdAt: 'desc' },
    });
    expect(uncertain.status).toBe('created');
    adapter.paidByOrderNo.set(uncertain.orderNo, {
      status: 'paid',
      amountFen: 1150n,
      externalTradeNo: `T-${runId}-uncertain-create`,
    });

    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await payment.reconcilePendingOrders();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.balance).toBe(before.balance + 1150n);
    expect((await prisma.paymentOrder.findUniqueOrThrow({ where: { orderNo: uncertain.orderNo } })).status)
      .toBe('paid');
    adapter.paidByOrderNo.delete(uncertain.orderNo);
    createPayment.mockRestore();
  });

  it('合法通知将订单标为 paid 并给余额入账', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const order = await payment.createOrder({
      userId,
      channel: 'alipay',
      amountFen: 2500n,
    });
    const result = await payment.handleNotify('alipay', {
      body: {
        orderNo: order.orderNo,
        amount: 2500,
        tradeNo: `T-${runId}-1`,
      },
    });
    expect(result.alreadyPaid).toBe(false);
    expect(result.status).toBe('paid');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.balance).toBe(before.balance + 2500n);
    const stored = await prisma.paymentOrder.findUniqueOrThrow({
      where: { orderNo: order.orderNo },
    });
    expect(stored.status).toBe('paid');
    expect(stored.externalTradeNo).toBe(`T-${runId}-1`);
  });

  it('重复通知幂等：余额不重复入账', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const paid = await prisma.paymentOrder.findFirstOrThrow({
      where: { userId, status: 'paid' },
    });
    const again = await payment.handleNotify('alipay', {
      body: {
        orderNo: paid.orderNo,
        amount: Number(paid.amount),
        tradeNo: paid.externalTradeNo,
      },
    });
    expect(again.alreadyPaid).toBe(true);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.balance).toBe(before.balance);
  });

  it('通知金额与订单不符则拒绝且余额不变', async () => {
    const order = await payment.createOrder({
      userId,
      channel: 'wechat',
      amountFen: 800n,
    });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await expect(
      payment.handleNotify('wechat', {
        body: {
          orderNo: order.orderNo,
          amount: 801,
          tradeNo: `T-${runId}-mismatch`,
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.balance).toBe(before.balance);
    const stored = await prisma.paymentOrder.findUniqueOrThrow({
      where: { orderNo: order.orderNo },
    });
    expect(stored.status).toBe('created');
  });

  it('rejects a verified notification delivered on a different payment channel', async () => {
    const order = await payment.createOrder({
      userId,
      channel: 'alipay',
      amountFen: 900n,
    });

    await expect(
      payment.handleNotify('wechat', {
        body: {
          orderNo: order.orderNo,
          amount: 900,
          tradeNo: `T-${runId}-wrong-channel`,
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('查单补偿：渠道已支付但通知丢失时入账', async () => {
    const order = await payment.createOrder({
      userId,
      channel: 'alipay',
      amountFen: 300n,
    });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    adapter.paidByOrderNo.set(order.orderNo, {
      status: 'paid',
      amountFen: 300n,
      externalTradeNo: `T-${runId}-recon`,
    });
    const report = await payment.reconcilePendingOrders();
    expect(report.credited).toBeGreaterThanOrEqual(1);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.balance).toBe(before.balance + 300n);
    const stored = await prisma.paymentOrder.findUniqueOrThrow({
      where: { orderNo: order.orderNo },
    });
    expect(stored.status).toBe('paid');
    adapter.paidByOrderNo.delete(order.orderNo);
  });

  it('does not credit a reconciliation result that omits the provider amount', async () => {
    const order = await payment.createOrder({
      userId,
      channel: 'alipay',
      amountFen: 350n,
    });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    adapter.paidByOrderNo.set(order.orderNo, {
      status: 'paid',
      externalTradeNo: `T-${runId}-missing-amount`,
    });

    await payment.reconcilePendingOrders();

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const stored = await prisma.paymentOrder.findUniqueOrThrow({ where: { orderNo: order.orderNo } });
    expect(after.balance).toBe(before.balance);
    expect(stored.status).toBe('created');
    adapter.paidByOrderNo.delete(order.orderNo);
  });

  it('过期订单不可再入账', async () => {
    const order = await payment.createOrder({
      userId,
      channel: 'alipay',
      amountFen: 400n,
    });
    await prisma.paymentOrder.update({
      where: { orderNo: order.orderNo },
      data: { createdAt: new Date(Date.now() - 40 * 60 * 1000) },
    });
    adapter.paidByOrderNo.set(order.orderNo, { status: 'closed' });
    await payment.reconcilePendingOrders();
    const stored = await prisma.paymentOrder.findUniqueOrThrow({
      where: { orderNo: order.orderNo },
    });
    expect(stored.status).toBe('expired');
    await expect(
      payment.handleNotify('alipay', {
        body: {
          orderNo: order.orderNo,
          amount: 400,
          tradeNo: `T-${runId}-late`,
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('查询不存在或非本人订单 404', async () => {
    await expect(payment.getOrder(userId, 'PO-missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const other = await prisma.user.create({
      data: {
        email: `pay-other-${runId}@test.local`,
        passwordHash: 'x',
        nickname: '他人',
      },
    });
    const order = await payment.createOrder({
      userId,
      channel: 'alipay',
      amountFen: 100n,
    });
    await expect(
      payment.getOrder(other.id, order.orderNo),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('拒绝非正金额', async () => {
    await expect(
      payment.createOrder({ userId, channel: 'alipay', amountFen: 0n }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects amounts above the exact provider-safe integer range', async () => {
    await expect(
      payment.createOrder({
        userId,
        channel: 'alipay',
        amountFen: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('拒绝缺少外部交易号的通知', async () => {
    const order = await payment.createOrder({
      userId,
      channel: 'alipay',
      amountFen: 500n,
    });
    await expect(
      payment.handleNotify('alipay', {
        body: { orderNo: order.orderNo, amount: 500, tradeNo: '' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('过期扫描不会覆盖扫描后并发完成的支付订单', async () => {
    const order = await payment.createOrder({
      userId,
      channel: 'alipay',
      amountFen: 600n,
    });
    await prisma.paymentOrder.update({
      where: { orderNo: order.orderNo },
      data: { createdAt: new Date(Date.now() - 40 * 60 * 1000) },
    });
    const originalFindMany = prisma.paymentOrder.findMany.bind(prisma.paymentOrder);
    const findMany = vi.spyOn(prisma.paymentOrder, 'findMany');
    findMany.mockImplementationOnce(
      (async (...args: Parameters<typeof originalFindMany>) => {
        const rows = await originalFindMany(...args);
        await payment.handleNotify('alipay', {
          body: {
            orderNo: order.orderNo,
            amount: 600,
            tradeNo: `T-${runId}-race`,
          },
        });
        return rows;
      }) as never,
    );
    try {
      await payment.reconcilePendingOrders();
    } finally {
      findMany.mockRestore();
    }
    const stored = await prisma.paymentOrder.findUniqueOrThrow({
      where: { orderNo: order.orderNo },
    });
    expect(stored.status).toBe('paid');
  });
});
