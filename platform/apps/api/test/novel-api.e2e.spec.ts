/**
 * 小说业务 API e2e：CRUD、乐观锁 409、越权 404、stub 生成与账单。
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

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = 'Password123';

describe('小说业务 API e2e', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let tokenA = '';
  let tokenB = '';
  let projectId = 0;
  let chapterId = 0;
  let testProviderId = 0;

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

    const a = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `p4-a-${runId}@test.local`,
        password,
        nickname: '作者甲',
      },
    });
    tokenA = a.json().accessToken as string;
    const b = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `p4-b-${runId}@test.local`,
        password,
        nickname: '作者乙',
      },
    });
    tokenB = b.json().accessToken as string;
    await prisma.user.update({
      where: { email: `p4-a-${runId}@test.local` },
      data: { balance: 5000n },
    });
    const provider = await prisma.modelProvider.create({
      data: {
        providerKey: `novel-e2e-${runId}`,
        name: 'Novel API E2E Provider',
        apiBaseUrl: 'https://example.test/v1',
        apiKeyEncrypted: encryptSecret('test-key', env.AES_MASTER_KEY),
        enabled: true,
      },
    });
    testProviderId = provider.id;
    for (const modelKey of new Set([env.STUB_WRITER_MODEL, env.PLANNER_MODEL])) {
      await prisma.modelRate.create({
        data: {
          modelKey,
          displayName: `${modelKey} test rate`,
          providerId: testProviderId,
          inputPricePerMillion: 100n,
          outputPricePerMillion: 100n,
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
          enabled: true,
        },
      });
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
      await raw.novelGenerationCall.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.novelBalanceHold.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.novelAssistantMessage.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.novelChapterVersion.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.novelChapterSeed.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.novelDocumentVersion.deleteMany({
        where: { createdBy: { in: userIds } },
      });
      await raw.novelDocument.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.novelOutlineNode.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.novelCharacter.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.novelGenerationJob.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.novelChapter.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.novelProject.deleteMany({
        where: { userId: { in: userIds } },
      });
      await raw.modelRate.deleteMany({
        where: { providerId: testProviderId },
      });
      await raw.modelProvider.deleteMany({
        where: { providerKey: { contains: runId } },
      });
      await raw.user.deleteMany({ where: { email: { contains: runId } } });
    } finally {
      await raw.$disconnect();
      await app.close();
    }
  });

  it('创建项目；用户 B 访问返回 404', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: '霜刃录', genre: '玄幻', description: '测试' },
    });
    expect(created.statusCode).toBe(201);
    projectId = created.json().id as number;

    const stolen = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(stolen.statusCode).toBe(404);
  });

  it('项目更新使用乐观锁，拒绝覆盖较新的生成契约', async () => {
    const current = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json().version).toBe(1);

    const first = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { genre: '仙侠', expectedVersion: 1 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(2);

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { worldKeyTerms: ['旧世界观'], expectedVersion: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().reason).toBe('version_conflict');
  });

  it('章节乐观锁冲突 409，正确版本可保存', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { chapterNumber: 1, title: '开篇' },
    });
    expect(created.statusCode).toBe(201);
    chapterId = created.json().id as number;
    expect(created.json().version).toBe(1);

    const conflict = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/chapters/${chapterId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { content: '旧版本写入', expectedVersion: 99 },
    });
    expect(conflict.statusCode).toBe(409);

    const ok = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/chapters/${chapterId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { content: '正文一稿', expectedVersion: 1 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version).toBe(2);
    expect(ok.json().content).toBe('正文一稿');
  });

  it('用户 B 访问用户 A 的章节 / 角色返回 404', async () => {
    const chapter = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/chapters/${chapterId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(chapter.statusCode).toBe(404);

    const chars = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/characters`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(chars.statusCode).toBe(404);
  });

  it('角色 / 大纲 / 文档 CRUD 与文档版本递增', async () => {
    const character = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/characters`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: '沈清', roleType: 'protagonist' },
    });
    expect(character.statusCode).toBe(201);

    const node = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/outline`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: '卷一', nodeType: 'volume' },
    });
    expect(node.statusCode).toBe(201);
    const tree = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/outline`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(tree.statusCode).toBe(200);
    expect(tree.json()).toHaveLength(1);

    const doc = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/documents`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        documentType: 'worldbuilding',
        title: '世界观',
        content: '初稿',
      },
    });
    expect(doc.statusCode).toBe(201);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/documents/${doc.json().id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { content: '二稿', changeSummary: '补充设定' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().currentVersion).toBe(2);
  });

  it('种子不完整时拒绝生成；补全后 stub 生成写入正文', async () => {
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters/${chapterId}/generate`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(blocked.statusCode).toBe(400);

    const seed = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters/${chapterId}/seed`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { intent: '开局遇险', endingGoal: '逃出生天', expectedVersion: 1 },
    });
    expect(seed.statusCode).toBe(201);

    const generated = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters/${chapterId}/generate`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(generated.statusCode).toBe(201);
    expect(generated.json().status).toBe('succeeded');
    const jobId = generated.json().jobId as string;

    const chapter = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/chapters/${chapterId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(chapter.json().status).toBe('generated');
    expect(String(chapter.json().content)).toContain('开局遇险');

    const job = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(job.statusCode).toBe(200);
    expect(job.json().status).toBe('succeeded');

    const stolenJob = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(stolenJob.statusCode).toBe(404);
  });

  it('助手发消息可取回历史；账单总览可读', async () => {
    const posted = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { content: '帮我规划下一章', action: 'query_project' },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json().assistantMessage.role).toBe('assistant');

    const history = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(history.json().length).toBeGreaterThanOrEqual(2);

    const autoPosted = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { content: '帮我看看现在的进度' },
    });
    expect(autoPosted.statusCode).toBe(201);
    expect(autoPosted.json().assistantMessage.role).toBe('assistant');

    const summary = await app.inject({
      method: 'GET',
      url: '/api/billing/summary',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(summary.statusCode).toBe(200);
    expect(typeof summary.json().balance).toBe('string');

    const records = await app.inject({
      method: 'GET',
      url: '/api/billing/records',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(records.statusCode).toBe(200);
    expect(Array.isArray(records.json().items)).toBe(true);
  });

  it('软删除项目后详情 404', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(del.statusCode).toBe(200);
    const gone = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('回收站可恢复，导出全书 TXT，助手可删单条', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: `回收导出-${runId}`, description: '简介' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as number;
    await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/chapters`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { chapterNumber: 1, title: '开端' },
    });

    const exported = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}/export`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().filename).toMatch(/\.txt$/);
    expect(exported.json().content).toContain('第1章 开端');

    const archived = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(archived.statusCode).toBe(200);
    const trash = await app.inject({
      method: 'GET',
      url: '/api/projects/trash',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(trash.statusCode).toBe(200);
    expect(
      (trash.json().items as Array<{ id: number }>).some((item) => item.id === id),
    ).toBe(true);

    const restored = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/restore`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(restored.statusCode).toBe(201);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().chapterCount).toBeGreaterThanOrEqual(1);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(listed.statusCode).toBe(200);
  });
});
