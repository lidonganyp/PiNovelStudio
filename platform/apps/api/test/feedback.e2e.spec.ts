/**
 * 用户反馈：归属校验、创建、管理列表/详情/回复、门户可见回复、审计。
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
const userEmail = `fb-user-${runId}@test.local`;
const otherEmail = `fb-other-${runId}@test.local`;
const adminEmail = `fb-admin-${runId}@test.local`;

type FeedbackAdminItem = {
  id: number;
  projectId: number;
  projectTitle: string;
  userId: number;
  userEmail: string;
  userNickname: string;
  chapterId: number | null;
  chapterNumber: number | null;
  chapterTitle: string | null;
  type: string;
  content: string;
  status: 'pending' | 'replied';
  replyContent: string | null;
  repliedAt: string | null;
  adminUserId: number | null;
  adminNickname: string | null;
  createdAt: string;
};

describe('反馈 API e2e', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let userToken = '';
  let userId = 0;
  let otherToken = '';
  let adminToken = '';
  let adminUserId = 0;
  let projectId = 0;
  let otherProjectId = 0;
  let chapterId = 0;
  let feedbackId = 0;

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
        email: userEmail,
        password,
        nickname: '反馈用户',
      },
    });
    userToken = userRes.json().accessToken as string;
    userId = userRes.json().user.id as number;

    const otherRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: otherEmail,
        password,
        nickname: '其他用户',
      },
    });
    otherToken = otherRes.json().accessToken as string;

    const adminRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: adminEmail,
        password,
        nickname: '反馈管理',
      },
    });
    adminUserId = adminRes.json().user.id as number;
    await prisma.user.update({
      where: { id: adminUserId },
      data: { role: 'admin' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: adminEmail, password },
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

    const otherProject = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { title: '别人的项目', genre: '都市' },
    });
    otherProjectId = otherProject.json().id as number;

    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/feedback`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { type: 'quality', content: '这章钩子偏弱', chapterId },
    });
    expect(created.statusCode).toBe(201);
    feedbackId = created.json().id as number;
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
        where: { actorId: { in: userIds } },
      });
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

  it('管理员可以分页查看所有反馈', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/feedback`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { type: 'factual', content: '时间线对不上', chapterId },
    });
    const page1 = await app.inject({
      method: 'GET',
      url: '/api/admin/feedback?page=1&pageSize=1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(page1.statusCode).toBe(200);
    const body = page1.json() as {
      items: FeedbackAdminItem[];
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.total).toBeGreaterThanOrEqual(2);

    const unpaged = await app.inject({
      method: 'GET',
      url: '/api/admin/feedback',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(unpaged.json().pageSize).toBe(20);

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/admin/feedback?type=quality&status=pending&q=钩子',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(filtered.statusCode).toBe(200);
    const filteredItems = (filtered.json().items as FeedbackAdminItem[]).filter(
      (item) => item.id === feedbackId,
    );
    expect(filteredItems).toHaveLength(1);
    expect(filteredItems[0].type).toBe('quality');
    expect(filteredItems[0].status).toBe('pending');
  });

  it('非管理员访问管理反馈接口返回 403', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/feedback',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(list.statusCode).toBe(403);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/admin/feedback/${feedbackId}`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(detail.statusCode).toBe(403);

    const reply = await app.inject({
      method: 'POST',
      url: `/api/admin/feedback/${feedbackId}/reply`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { content: '不该成功' },
    });
    expect(reply.statusCode).toBe(403);
  });

  it('管理员可以查看反馈详情，关联信息正确', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/feedback/${feedbackId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const item = res.json() as FeedbackAdminItem;
    expect(item.id).toBe(feedbackId);
    expect(item.projectId).toBe(projectId);
    expect(item.projectTitle).toBe('反馈项目');
    expect(item.userId).toBe(userId);
    expect(item.userEmail).toBe(userEmail);
    expect(item.userNickname).toBe('反馈用户');
    expect(item.chapterId).toBe(chapterId);
    expect(item.chapterNumber).toBe(1);
    expect(item.chapterTitle).toBe('开篇');
    expect(item.type).toBe('quality');
    expect(item.content).toBe('这章钩子偏弱');
    expect(item.status).toBe('pending');
    expect(item.replyContent).toBeNull();

    const list = await app.inject({
      method: 'GET',
      url: `/api/admin/feedback?q=${encodeURIComponent(userEmail)}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const match = (list.json().items as FeedbackAdminItem[]).find(
      (row) => row.id === feedbackId,
    );
    expect(match).toBeTruthy();
    expect(match?.projectTitle).toBe('反馈项目');
    expect(match?.chapterNumber).toBe(1);
    expect(match?.userNickname).toBe('反馈用户');
  });

  it('空回复、超长回复返回 400；不存在的反馈返回 404', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: `/api/admin/feedback/${feedbackId}/reply`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { content: '' },
    });
    expect(empty.statusCode).toBe(400);

    const blank = await app.inject({
      method: 'POST',
      url: `/api/admin/feedback/${feedbackId}/reply`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { content: '   ' },
    });
    expect(blank.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: 'POST',
      url: `/api/admin/feedback/${feedbackId}/reply`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { content: '字'.repeat(5001) },
    });
    expect(tooLong.statusCode).toBe(400);

    const missingGet = await app.inject({
      method: 'GET',
      url: '/api/admin/feedback/999999999',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(missingGet.statusCode).toBe(404);

    const missingReply = await app.inject({
      method: 'POST',
      url: '/api/admin/feedback/999999999/reply',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { content: '幽灵回复' },
    });
    expect(missingReply.statusCode).toBe(404);
  });

  it('管理员可以回复反馈；再次回复覆盖原记录；用户门户可见；写审计；不触发生成计费', async () => {
    const jobsBefore = await prisma.novelGenerationJob.count();
    const holdsBefore = await prisma.novelBalanceHold.count();
    const callsBefore = await prisma.novelGenerationCall.count();
    const feedbackCountBefore = await prisma.novelFeedback.count({
      where: { userId, projectId },
    });

    const reply = await app.inject({
      method: 'POST',
      url: `/api/admin/feedback/${feedbackId}/reply`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { content: '  钩子会在下一章补强  ' },
    });
    expect(reply.statusCode).toBe(201);
    const first = reply.json() as FeedbackAdminItem;
    expect(first.status).toBe('replied');
    expect(first.replyContent).toBe('钩子会在下一章补强');
    expect(first.repliedAt).toBeTruthy();
    expect(first.adminUserId).toBe(adminUserId);
    expect(first.adminNickname).toBe('反馈管理');

    const portal = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/feedback`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(portal.statusCode).toBe(200);
    const portalItem = (portal.json() as Array<Record<string, unknown>>).find(
      (row) => row.id === feedbackId,
    );
    expect(portalItem).toBeTruthy();
    expect(portalItem?.status).toBe('replied');
    expect(portalItem?.replyContent).toBe('钩子会在下一章补强');
    expect(portalItem?.repliedAt).toBeTruthy();
    expect(portalItem?.adminNickname).toBe('反馈管理');

    const second = await app.inject({
      method: 'POST',
      url: `/api/admin/feedback/${feedbackId}/reply`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { content: '已按你的意见修订' },
    });
    expect(second.statusCode).toBe(201);
    const updated = second.json() as FeedbackAdminItem;
    expect(updated.id).toBe(feedbackId);
    expect(updated.replyContent).toBe('已按你的意见修订');
    expect(updated.status).toBe('replied');

    const feedbackCountAfter = await prisma.novelFeedback.count({
      where: { userId, projectId },
    });
    expect(feedbackCountAfter).toBe(feedbackCountBefore);
    const listAfter = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/feedback`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect((listAfter.json() as unknown[]).length).toBe(feedbackCountAfter);

    const logs = await prisma.auditLog.findMany({
      where: {
        action: 'feedback.reply',
        targetType: 'novel_feedback',
        targetId: String(feedbackId),
      },
      orderBy: { id: 'desc' },
    });
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0].actorType).toBe('admin');
    expect(logs[0].actorId).toBe(adminUserId);
    const detail = logs[0].detail as {
      projectId: number;
      userId: number;
      previousStatus: string;
      nextStatus: string;
      repliedAt: string;
      content?: unknown;
      replyContent?: unknown;
    };
    expect(detail.projectId).toBe(projectId);
    expect(detail.userId).toBe(userId);
    expect(detail.nextStatus).toBe('replied');
    expect(detail.repliedAt).toBeTruthy();
    expect(detail.content).toBeUndefined();
    expect(detail.replyContent).toBeUndefined();

    expect(await prisma.novelGenerationJob.count()).toBe(jobsBefore);
    expect(await prisma.novelBalanceHold.count()).toBe(holdsBefore);
    expect(await prisma.novelGenerationCall.count()).toBe(callsBefore);
  });

  it('用户不能读取其他项目反馈', async () => {
    const stolenProject = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/feedback`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(stolenProject.statusCode).toBe(404);

    const own = await app.inject({
      method: 'GET',
      url: `/api/projects/${otherProjectId}/feedback`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual([]);
  });
});
