/**
 * 用户反馈：归属校验、创建与管理列表。
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

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = 'Password123';

describe('反馈 API e2e', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let userToken = '';
  let adminToken = '';
  let projectId = 0;
  let chapterId = 0;

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
        email: `fb-user-${runId}@test.local`,
        password,
        nickname: '反馈用户',
      },
    });
    userToken = userRes.json().accessToken as string;
    const adminRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `fb-admin-${runId}@test.local`,
        password,
        nickname: '反馈管理',
      },
    });
    await prisma.user.update({
      where: { id: adminRes.json().user.id as number },
      data: { role: 'admin' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `fb-admin-${runId}@test.local`, password },
    });
    adminToken = login.json().accessToken as string;

    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: '反馈项目', genre: '玄幻' },
    });
    projectId = project.json().id as number;
    const chapter = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { chapterNumber: 1, title: '开篇' },
    });
    chapterId = chapter.json().id as number;
  });

  afterAll(async () => {
    const raw = new PrismaClient();
    try {
      const users = await raw.user.findMany({
        where: { email: { contains: runId } },
        select: { id: true },
      });
      const userIds = users.map((item) => item.id);
      await raw.novelFeedback.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelChapterSeed.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelChapter.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelProject.deleteMany({ where: { userId: { in: userIds } } });
      await raw.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await raw.$disconnect();
      await app.close();
    }
  });

  it('创建反馈；越权 404；管理端可读', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/feedback`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { type: 'quality', content: '这章钩子偏弱', chapterId },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().content).toBe('这章钩子偏弱');

    const stolen = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/feedback`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(stolen.statusCode).toBe(404);

    const adminList = await app.inject({
      method: 'GET',
      url: '/api/admin/feedback',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().total).toBeGreaterThanOrEqual(1);
  });
});
