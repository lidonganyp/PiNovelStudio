/**
 * P8-1 旅程：注册 → 管理员调账 → 建项目 → 写 seed → stub 生成 → 编辑章节 → 查明细。
 * CI 用 Fastify inject（与 Phase 1 起的 e2e 口径一致）；浏览器 Playwright 需独立起服务。
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

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = 'Password123';

describe('P8-1 用户旅程 e2e', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let userToken = '';
  let adminToken = '';
  let userId = 0;
  let projectId = 0;
  let chapterId = 0;
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

    const userRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `p8-user-${runId}@test.local`,
        password,
        nickname: '旅程用户',
      },
    });
    expect(userRes.statusCode).toBe(201);
    userToken = userRes.json().accessToken as string;
    userId = userRes.json().user.id as number;

    const adminRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `p8-admin-${runId}@test.local`,
        password,
        nickname: '旅程管理员',
      },
    });
    const adminId = adminRes.json().user.id as number;
    await prisma.user.update({ where: { id: adminId }, data: { role: 'admin' } });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `p8-admin-${runId}@test.local`, password },
    });
    adminToken = login.json().accessToken as string;

    const provider = await prisma.modelProvider.create({
      data: {
        providerKey: `p8-journey-${runId}`,
        name: 'P8 Journey',
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
      await raw.auditLog.deleteMany({
        where: { targetId: { in: userIds.map(String) } },
      });
      await raw.modelRate.deleteMany({ where: { providerId } });
      await raw.modelProvider.deleteMany({ where: { id: providerId } });
      await raw.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await raw.$disconnect();
      await app.close();
    }
  });

  it('管理员调账后用户可建项目、写种子、stub 生成并编辑正文', async () => {
    const adjust = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${userId}/adjustments`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { amount: 10000, reason: 'P8 旅程充值' },
    });
    expect(adjust.statusCode).toBe(201);

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(me.json().totalBalance).toBe('10000');

    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: '旅程之作', genre: '玄幻', description: 'P8-1' },
    });
    expect(project.statusCode).toBe(201);
    projectId = project.json().id as number;

    const chapter = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { chapterNumber: 1, title: '开篇' },
    });
    expect(chapter.statusCode).toBe(201);
    chapterId = chapter.json().id as number;

    const seed = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters/${chapterId}/seed`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { intent: '开局遇险', endingGoal: '逃出生天', expectedVersion: 1 },
    });
    expect(seed.statusCode).toBe(201);

    const generated = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters/${chapterId}/generate`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(generated.statusCode).toBe(201);
    expect(generated.json().status).toBe('succeeded');

    const afterGen = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/chapters/${chapterId}`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(afterGen.json().status).toBe('generated');
    const version = afterGen.json().version as number;

    const edited = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/chapters/${chapterId}`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { content: '用户手改正文', expectedVersion: version },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().content).toBe('用户手改正文');

    const records = await app.inject({
      method: 'GET',
      url: '/api/billing/records',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(records.statusCode).toBe(200);
    expect(Array.isArray(records.json().items)).toBe(true);

    const identity = await computeLedgerIdentity(prisma, userId);
    expect(identity.balanceMatches).toBe(true);
    expect(identity.availableMatches).toBe(true);
    expect(identity.settledFen).toBe(0n);
    expect(identity.balanceFen + identity.bonusBalanceFen).toBe(10000n - identity.settledFen);
    expect(identity.reservedFen).toBe(0n);
  });
});
