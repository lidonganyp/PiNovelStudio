/**
 * 支付充值 e2e：下单 → stub 通知入账 → 重复通知幂等 → 越权 404。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureHttpApp } from '../src/configure-http';
import { env } from '../src/config/env';

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = 'Password123';

describe('支付充值 e2e', () => {
  let app: NestFastifyApplication;
  let tokenA = '';
  let tokenB = '';
  let orderNo = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(
      new FastifyAdapter({ bodyLimit: 2 * 1024 * 1024 }),
    );
    configureHttpApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const a = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `p6-a-${runId}@test.local`,
        password,
        nickname: '充值甲',
      },
    });
    tokenA = a.json().accessToken as string;
    const b = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `p6-b-${runId}@test.local`,
        password,
        nickname: '充值乙',
      },
    });
    tokenB = b.json().accessToken as string;
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
        where: { targetId: { in: users.length ? [orderNo].filter(Boolean) : [] } },
      });
      await raw.paymentOrder.deleteMany({ where: { userId: { in: userIds } } });
      await raw.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await raw.$disconnect();
      await app.close();
    }
  });

  it('POST /api/payment/orders 创建订单', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/payment/orders',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { channel: 'alipay', amount: 1200 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('created');
    expect(body.amount).toBe('1200');
    expect(typeof body.qrContent).toBe('string');
    orderNo = body.orderNo as string;
  });

  it('用户 B 查询用户 A 订单返回 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/payment/orders/${orderNo}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('stub 渠道通知入账，重复通知不重复加余额', async () => {
    const notify = async (): Promise<ReturnType<typeof app.inject>> =>
      app.inject({
        method: 'POST',
        url: '/api/payment/notify/alipay',
        headers: { 'x-payment-stub-secret': env.PAYMENT_STUB_SECRET },
        payload: {
          orderNo,
          amount: 1200,
          tradeNo: `E2E-${runId}`,
        },
      });
    const first = await notify();
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('paid');

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(me.json().balance).toBe('1200');

    const second = await notify();
    expect(second.statusCode).toBe(200);
    expect(second.json().alreadyPaid).toBe(true);
    const meAgain = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(meAgain.json().balance).toBe('1200');
  });
});
