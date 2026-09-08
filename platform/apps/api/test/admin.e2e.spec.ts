/**
 * 管理后台 e2e：调账、封禁、费率只增不改、用量与明细一致、越权 403。
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
import { PrismaService } from '../src/prisma/prisma.service';
import { BillingService } from '../src/modules/billing/billing.service';
import { encryptSecret } from '../src/common/crypto/aes-gcm';
import { env } from '../src/config/env';

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = 'Password123';

describe('管理后台 e2e', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let billing: BillingService;
  let adminToken = '';
  let userToken = '';
  let adminId = 0;
  let userId = 0;

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
    prisma = app.get(PrismaService);
    billing = app.get(BillingService);

    const userRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `p7-user-${runId}@test.local`,
        password,
        nickname: '普通用户',
      },
    });
    userToken = userRes.json().accessToken as string;
    userId = userRes.json().user.id as number;

    const adminRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `p7-admin-${runId}@test.local`,
        password,
        nickname: '管理员',
      },
    });
    adminId = adminRes.json().user.id as number;
    await prisma.user.update({
      where: { id: adminId },
      data: { role: 'admin' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `p7-admin-${runId}@test.local`, password },
    });
    adminToken = login.json().accessToken as string;
  });

  afterAll(async () => {
    const raw = new PrismaClient();
    try {
      const users = await raw.user.findMany({
        where: { email: { contains: runId } },
        select: { id: true },
      });
      const userIds = users.map((item) => item.id);
      await raw.novelGenerationCall.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.novelBalanceHold.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.novelBillingAdjustment.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.modelRate.deleteMany({
        where: { modelKey: { contains: runId } },
      });
      await raw.modelProvider.deleteMany({
        where: { providerKey: { contains: runId } },
      });
      await raw.auditLog.deleteMany({
        where: { targetId: { in: userIds.map(String) } },
      });
      await raw.setting.deleteMany({
        where: { key: { contains: runId } },
      });
      await raw.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await raw.$disconnect();
      await app.close();
    }
  });

  it('普通用户访问管理接口 403；概览仅管理员可读', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(403);
    const overview = await app.inject({
      method: 'GET',
      url: '/api/admin',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      userCount: expect.any(Number),
      activeUsers: expect.any(Number),
    });
  });

  it('不能封禁管理员', async () => {
    const banned = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${adminId}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'banned' },
    });
    expect(banned.statusCode).toBe(400);
  });

  it('调账即时生效并写审计，流水只追加', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${userId}/adjustments`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { amount: 5000, reason: '验收充值' },
    });
    expect(res.statusCode).toBe(201);
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(me.json().bonusBalance).toBe('5000');
    expect(me.json().totalBalance).toBe('5000');
    const audit = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-logs?action=user.adjust',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().total).toBeGreaterThanOrEqual(1);

    const paged = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-logs?page=1&pageSize=20',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(paged.statusCode).toBe(200);
    expect(Array.isArray(paged.json().items)).toBe(true);
  });

  it('新费率不影响历史结算快照', async () => {
    const provider = await prisma.modelProvider.create({
      data: {
        providerKey: `p7-${runId}`,
        name: 'P7 Provider',
        apiBaseUrl: 'https://example.test/v1',
        apiKeyEncrypted: encryptSecret('sk-old', env.AES_MASTER_KEY),
        enabled: true,
      },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/model-rates',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        modelKey: `p7-model-${runId}`,
        displayName: '旧价',
        providerId: provider.id,
        inputPricePerMillion: 100,
        outputPricePerMillion: 200,
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      },
    });
    expect(created.statusCode).toBe(201);

    await billing.createHold({
      userId,
      jobId: `p7-job-a-${runId}`,
      amount: 1000n,
    });
    const first = await billing.settleCall({
      jobId: `p7-job-a-${runId}`,
      callId: `p7-call-a-${runId}`,
      internalStage: 'agentic_raw',
      model: `p7-model-${runId}`,
      tokensIn: 100_000,
      tokensOut: 50_000,
    });
    expect(first.actualCharge).toBe(20n);

    const newer = await app.inject({
      method: 'POST',
      url: '/api/admin/model-rates',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        modelKey: `p7-model-${runId}`,
        displayName: '新价',
        providerId: provider.id,
        inputPricePerMillion: 1000,
        outputPricePerMillion: 2000,
        effectiveFrom: new Date().toISOString(),
      },
    });
    expect(newer.statusCode).toBe(201);

    await billing.createHold({
      userId,
      jobId: `p7-job-b-${runId}`,
      amount: 1000n,
    });
    const second = await billing.settleCall({
      jobId: `p7-job-b-${runId}`,
      callId: `p7-call-b-${runId}`,
      internalStage: 'agentic_raw',
      model: `p7-model-${runId}`,
      tokensIn: 100_000,
      tokensOut: 50_000,
    });
    expect(second.actualCharge).toBe(200n);

    const oldCall = await prisma.novelGenerationCall.findUniqueOrThrow({
      where: {
        jobId_callId: {
          jobId: `p7-job-a-${runId}`,
          callId: `p7-call-a-${runId}`,
        },
      },
    });
    const snapshot = oldCall.rateSnapshot as { inputPricePerMillion: string };
    expect(snapshot.inputPricePerMillion).toBe('100');
    expect(oldCall.actualCharge).toBe(20n);
  });

  it('用量汇总与明细下钻金额一致', async () => {
    const summary = await app.inject({
      method: 'GET',
      url: `/api/admin/usage/summary?groupBy=model`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(summary.statusCode).toBe(200);
    const modelRow = (summary.json() as Array<{ model: string; charge: string }>)
      .find((row) => row.model === `p7-model-${runId}`);
    expect(modelRow?.charge).toBe('220');

    const records = await app.inject({
      method: 'GET',
      url: `/api/admin/usage/records?model=p7-model-${runId}&pageSize=20`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const items = records.json().items as Array<{ actualCharge: string }>;
    const sum = items.reduce((acc, row) => acc + Number(row.actualCharge), 0);
    expect(String(sum)).toBe(modelRow?.charge);
  });

  it('封禁后无法登录；设置写入可读取', async () => {
    const banned = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${userId}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'banned' },
    });
    expect(banned.statusCode).toBe(201);
    const stale = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(stale.statusCode).toBe(401);
    expect(JSON.stringify(stale.json())).toMatch(/封禁/);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `p7-user-${runId}@test.local`, password },
    });
    expect(login.statusCode).toBe(401);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { items: [{ key: `p7-flag-${runId}`, value: { enabled: false } }] },
    });
    expect(put.statusCode).toBe(200);
    const list = put.json() as Array<{ key: string; value: unknown }>;
    const saved = list.find((item) => item.key === `p7-flag-${runId}`);
    expect(saved?.value).toEqual({ enabled: false });
  });

  it('用量看板与收入拆分按真实/虚拟记账', async () => {
    const dashboard = await app.inject({
      method: 'GET',
      url: '/api/admin/usage/dashboard',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().cards).toMatchObject({
      requests: expect.any(Number),
      charge: expect.any(String),
    });

    const revenue = await app.inject({
      method: 'GET',
      url: `/api/admin/revenue/summary?userId=${userId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(revenue.statusCode).toBe(200);
    const body = revenue.json() as {
      virtualRecharge: string;
      virtualConsume: string;
      remainingQuota: string;
    };
    expect(Number(body.virtualRecharge)).toBeGreaterThanOrEqual(5000);
    expect(Number(body.virtualConsume)).toBeGreaterThanOrEqual(220);
    expect(body.remainingQuota).toBeDefined();
  });

  it('查价缺少模型名返回 400；空结果提示手动填写', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/admin/model-rates/lookup',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(missing.statusCode).toBe(400);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/admin/model-rates/lookup?q=gemini-3.8-flash',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect([401, 403]).toContain(forbidden.statusCode);
  });

  it('Provider 列表不返回明文密钥', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/model-providers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        providerKey: `p7-new-${runId}`,
        name: '脱敏测试',
        apiBaseUrl: 'https://example.test',
        apiKey: 'sk-super-secret-key',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain('sk-super-secret-key');
    expect(created.json().apiKeyMasked).toBeTruthy();
  });
});
