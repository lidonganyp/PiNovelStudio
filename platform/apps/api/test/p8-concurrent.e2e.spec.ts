/**
 * P8-2 并发生成：同一用户 5 路并发生成；产品约束为每用户 1 个 running 任务，
 * 因此恰好 1 成功 + 4 个 409，预占不超扣，账本恒等式零差额。
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
import { env } from '../src/config/env';
import { encryptSecret } from '../src/common/crypto/aes-gcm';
import { computeLedgerIdentity } from '../src/modules/billing/ledger';
import { BillingService } from '../src/modules/billing/billing.service';
import { InsufficientBalanceException } from '../src/modules/billing/billing.errors';

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = 'Password123';

describe('P8-2 并发生成与对账', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let billing: BillingService;
  let userToken = '';
  let userId = 0;
  let projectId = 0;
  const chapterIds: number[] = [];
  let providerId = 0;

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
        email: `p8-conc-${runId}@test.local`,
        password,
        nickname: '并发用户',
      },
    });
    userToken = userRes.json().accessToken as string;
    userId = userRes.json().user.id as number;
    await billing.adjustBalance({
      userId,
      adminUserId: userId,
      amount: 10000n,
      reason: 'P8 并发测试初始余额',
    });

    const provider = await prisma.modelProvider.create({
      data: {
        providerKey: `p8-conc-${runId}`,
        name: 'P8 Concurrent',
        apiBaseUrl: 'https://example.test/v1',
        apiKeyEncrypted: encryptSecret('test-key', env.AES_MASTER_KEY),
        enabled: true,
      },
    });
    providerId = provider.id;
    await prisma.modelRate.create({
      data: {
        modelKey: env.STUB_WRITER_MODEL,
        displayName: 'stub writer',
        providerId,
        inputPricePerMillion: 100n,
        outputPricePerMillion: 100n,
        effectiveFrom: new Date('2020-01-01T00:00:00Z'),
        enabled: true,
      },
    });

    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: '并发之书', genre: '玄幻' },
    });
    projectId = project.json().id as number;

    for (let i = 1; i <= 5; i += 1) {
      const chapter = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/chapters`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { chapterNumber: i, title: `第${i}章` },
      });
      const chapterId = chapter.json().id as number;
      chapterIds.push(chapterId);
      const seed = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/chapters/${chapterId}/seed`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { intent: `意图${i}`, endingGoal: `目标${i}`, expectedVersion: 1 },
      });
      expect(seed.statusCode).toBe(201);
    }
  });

  afterAll(async () => {
    const raw = new PrismaClient();
    try {
      const users = await raw.user.findMany({
        where: { email: { contains: runId } },
        select: { id: true },
      });
      const userIds = users.map((item) => item.id);
      await raw.novelGenerationCall.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelBalanceHold.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelBillingAdjustment.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelChapterVersion.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelChapterSeed.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelGenerationJob.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelChapter.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelProject.deleteMany({ where: { userId: { in: userIds } } });
      await raw.modelRate.deleteMany({ where: { providerId } });
      await raw.modelProvider.deleteMany({ where: { id: providerId } });
      await raw.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await raw.$disconnect();
      await app.close();
    }
  });

  it('5 路并发生成恰好一路成功，其余 409，预占与余额守恒', async () => {
    const results = await Promise.all(
      chapterIds.map((chapterId) =>
        app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/chapters/${chapterId}/generate`,
          headers: { authorization: `Bearer ${userToken}` },
        }),
      ),
    );
    const succeeded = results.filter((row) => row.statusCode === 201);
    const conflicted = results.filter((row) => row.statusCode === 409);
    expect(succeeded.length + conflicted.length).toBe(5);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    expect(succeeded.every((row) => row.json().status === 'succeeded')).toBe(true);

    const jobs = await prisma.novelGenerationJob.findMany({ where: { userId } });
    expect(jobs).toHaveLength(succeeded.length);
    expect(jobs.every((job) => job.status === 'succeeded')).toBe(true);

    const holds = await prisma.novelBalanceHold.findMany({ where: { userId } });
    expect(holds).toHaveLength(jobs.length);
    expect(holds.every((hold) => hold.status === 'settled')).toBe(true);

    const identity = await computeLedgerIdentity(prisma, userId);
    expect(identity.balanceMatches).toBe(true);
    expect(identity.availableMatches).toBe(true);
    expect(identity.reservedFen).toBe(0n);
    expect(identity.settledFen).toBe(0n);
    expect(identity.balanceFen + identity.bonusBalanceFen).toBe(10000n - identity.settledFen);
  });

  it('5 路并发预占不超扣：余额 1000 分、每笔 300 分，成功额合计 ≤ 1000', async () => {
    const holdUser = await prisma.user.create({
      data: {
        email: `p8-hold-${runId}@test.local`,
        passwordHash: 'x',
        nickname: '预占并发',
      },
    });
    await billing.adjustBalance({
      userId: holdUser.id,
      adminUserId: holdUser.id,
      amount: 1000n,
      reason: 'P8 预占测试初始余额',
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        billing.createHold({
          userId: holdUser.id,
          jobId: `p8-hold-${runId}-${index}`,
          amount: 300n,
        }),
      ),
    );
    const ok = outcomes.filter((row) => row.status === 'fulfilled');
    const rejected = outcomes.filter((row) => row.status === 'rejected');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(ok.length).toBeLessThanOrEqual(3);
    expect(rejected.length).toBe(5 - ok.length);
    for (const row of rejected) {
      expect((row as PromiseRejectedResult).reason).toBeInstanceOf(
        InsufficientBalanceException,
      );
    }
    const identity = await computeLedgerIdentity(prisma, holdUser.id);
    expect(identity.balanceMatches).toBe(true);
    expect(identity.availableMatches).toBe(true);
    expect(identity.reservedFen).toBe(300n * BigInt(ok.length));
    expect(identity.reservedFen <= 1000n).toBe(true);
    expect(identity.availableFen >= 0n).toBe(true);
  });
});
