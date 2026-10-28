/**
 * 小说助手生成管家 e2e：缺资料走确认，不返回技术错误；确认后才提交统一生成。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
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
import { FIXTURE_CHAPTER_ONE, FIXTURE_STORY_OUTLINE } from '../src/modules/context/fixtures';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { applyAssistantArtifacts } from '../src/modules/assistant/assistant-artifacts';

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = 'Password123';

describe('助手生成管家 e2e', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let tokenA = '';
  let tokenB = '';
  let projectId = 0;
  let userIdA = 0;
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
      payload: { email: `steward-a-${runId}@test.local`, password, nickname: '管家甲' },
    });
    tokenA = a.json().accessToken as string;
    userIdA = a.json().user.id as number;
    const b = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: `steward-b-${runId}@test.local`, password, nickname: '管家乙' },
    });
    tokenB = b.json().accessToken as string;
    await prisma.user.update({
      where: { email: `steward-a-${runId}@test.local` },
      data: { balance: 5000n },
    });
    const provider = await prisma.modelProvider.create({
      data: {
        providerKey: `steward-e2e-${runId}`,
        name: 'Steward E2E Provider',
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
          displayName: `${modelKey} steward rate`,
          providerId: testProviderId,
          inputPricePerMillion: 100n,
          outputPricePerMillion: 100n,
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
          enabled: true,
        },
      });
    }

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: '铜哨', description: '沈砚重生追查旧案' },
    });
    expect(created.statusCode).toBe(201);
    projectId = created.json().id as number;

    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/characters`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: '沈砚', roleType: 'protagonist', identity: '重生者' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/outline`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        title: '第二章：不要相信沈建国',
        nodeType: 'chapter',
        summary: '沈砚带着铜哨追查父亲留下的禁令',
      },
    });
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/documents`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        documentType: 'story_outline',
        title: '故事大纲',
        content: FIXTURE_STORY_OUTLINE,
      },
    });
    const chapter = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chapters`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { chapterNumber: 1, title: '第一章' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/chapters/${chapter.json().id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { content: FIXTURE_CHAPTER_ONE, expectedVersion: 1 },
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
      await raw.novelErrorReport.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelGenerationCall.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelBalanceHold.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelAssistantMessage.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelChapterVersion.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelChapterSeed.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelDocumentVersion.deleteMany({ where: { createdBy: { in: userIds } } });
      await raw.novelDocument.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelOutlineNode.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelCharacter.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelGenerationJob.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelChapter.deleteMany({ where: { userId: { in: userIds } } });
      await raw.novelProject.deleteMany({ where: { userId: { in: userIds } } });
      await raw.modelRate.deleteMany({ where: { providerId: testProviderId } });
      await raw.modelProvider.deleteMany({ where: { providerKey: { contains: runId } } });
      await raw.user.deleteMany({ where: { email: { contains: runId } } });
    } finally {
      await raw.$disconnect();
      await app.close();
    }
  });

  it('生成第二章：缺资料返回确认方案而不是 422，且不建任务、不预占', async () => {
    const posted = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { content: '生成第二章' },
    });
    expect(posted.statusCode).toBe(201);
    const body = posted.json() as {
      steward?: {
        status: string;
        proposalId?: string;
        sourceVersion: string;
        proposals: Array<{ field: string; value: string }>;
      };
      generationJobId?: string;
      assistantMessage: { content: string };
    };
    expect(body.steward?.status).toBe('confirmation_required');
    expect(body.generationJobId).toBeUndefined();
    expect(body.assistantMessage.content).toContain('以下内容无法从现有资料可靠确定');
    expect(body.assistantMessage.content).not.toContain('runtime_preflight_failed');
    const jobs = await prisma.novelGenerationJob.findMany({
      where: { projectId, jobType: 'chapter_generation' },
    });
    expect(jobs).toHaveLength(0);
    const holds = await prisma.novelBalanceHold.findMany({ where: { userId: userIdA } });
    expect(holds).toHaveLength(0);
  });

  it('Workbench SSE 把资料缺口写成 steward 事件而不是 failure', async () => {
    const streamed = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assistant/messages`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        accept: 'text/event-stream',
      },
      payload: { content: '生成第二章' },
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body).toContain('"type":"steward"');
    expect(streamed.body).not.toContain('"type":"failure"');
    expect(streamed.body).not.toContain('runtime_preflight_failed');
  });

  it('用户确认后一次性写入资料并只提交一次 novel_generate_chapter', async () => {
    const prepared = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { content: '生成第二章' },
    });
    const initialSteward = prepared.json().steward as {
      proposalId: string;
      sourceVersion: string;
      proposals: Array<{ field: string; value: string }>;
    };
    // The outline does not state a genre. Supply that one unresolved field
    // through the steward's revision flow before applying the auto-filled
    // materials; inferred fields remain confirmation-free.
    const revised = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        content: '补充项目类型为悬疑',
        stewardAction: 'revise',
        proposalId: initialSteward.proposalId,
        sourceVersion: initialSteward.sourceVersion,
        proposalEdits: [{ field: 'genre', value: '悬疑' }],
      },
    });
    expect(revised.statusCode).toBe(201);
    const steward = revised.json().steward as {
      proposalId: string;
      sourceVersion: string;
      proposals: Array<{ field: string; value: string }>;
    };
    const confirmedFields = steward.proposals.filter((row) => row.value.trim()).map((row) => row.field);
    const first = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        content: '采用并继续生成',
        stewardAction: 'apply_and_generate',
        proposalId: steward.proposalId,
        sourceVersion: steward.sourceVersion,
        confirmedFields,
      },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { generationJobId?: string; steward?: { status: string } };
    expect(firstBody.generationJobId).toBeTruthy();
    expect(firstBody.steward?.status).toBe('ready');

    const project = await prisma.novelProject.findFirst({ where: { id: projectId } });
    expect(project?.genre.trim().length).toBeGreaterThan(0);
    const docs = await prisma.novelDocument.findMany({
      where: { projectId, documentType: { in: ['worldbuilding', 'creative_constitution', 'style_profile'] } },
    });
    expect(docs.map((row) => row.documentType).sort()).toEqual([
      'creative_constitution',
      'style_profile',
      'worldbuilding',
    ]);
    const chapterTwo = await prisma.novelChapter.findFirst({
      where: { projectId, chapterNumber: 2 },
      include: { seed: true },
    });
    expect(chapterTwo?.seed?.intent.trim().length).toBeGreaterThan(0);
    expect(chapterTwo?.content ?? '').not.toContain('采用并继续生成');
    expect(chapterTwo?.content ?? '').not.toContain('生成第二章');

    const second = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        content: '采用并继续生成',
        stewardAction: 'apply_and_generate',
        proposalId: steward.proposalId,
        sourceVersion: steward.sourceVersion,
        confirmedFields,
      },
    });
    expect(second.json().generationJobId).toBe(firstBody.generationJobId);
    const jobs = await prisma.novelGenerationJob.findMany({
      where: { projectId, jobType: 'chapter_generation' },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobType).toBe('chapter_generation');
  });

  it.each(['characters', 'outline'] as const)('资料保存后提交失败，再修改 %s 必须重新确认最新资料', async (changedMaterial) => {
    const project = await prisma.novelProject.create({
      data: { userId: userIdA, title: 'revision-probe', description: 'Investigate the old city', genre: '悬疑' },
    });
    for (const [documentType, content] of [
      ['worldbuilding', '# World\nOld city'],
      ['creative_constitution', '# Constitution\nPreserve confirmed facts'],
    ]) {
      await prisma.novelDocument.create({ data: { userId: userIdA, projectId: project.id, documentType: documentType!, title: documentType!, content: content! } });
    }
    await prisma.novelCharacter.create({
      data: { userId: userIdA, projectId: project.id, name: 'Lin Mo', identity: 'investigator', goals: 'solve the case' },
    });
    const url = `/api/projects/${project.id}/assistant/messages`;
    const headers = { authorization: `Bearer ${tokenA}` };
    const prepared = await app.inject({ method: 'POST', url, headers, payload: { content: '生成第一章' } });
    expect(prepared.statusCode).toBe(201);
    const steward = prepared.json().steward as { proposalId: string; sourceVersion: string };
    expect(steward.proposalId).toBeTruthy();
    const payload = { content: '采用并生成', stewardAction: 'apply_and_generate', proposalId: steward.proposalId, sourceVersion: steward.sourceVersion };
    const estimate = vi.spyOn(app.get(JobsService) as unknown as { estimateMaxCharge(): Promise<bigint> }, 'estimateMaxCharge')
      .mockRejectedValueOnce(new NotFoundException('未找到模型 v2_rawstage2_gemini31 的生效费率'));
    try {
      const failed = await app.inject({ method: 'POST', url, headers, payload });
      expect(failed.statusCode).toBe(503);
    } finally {
      estimate.mockRestore();
    }
    const chapter = await prisma.novelChapter.findFirstOrThrow({ where: { projectId: project.id, chapterNumber: 1 } });
    const seedBefore = await prisma.novelChapterSeed.findUniqueOrThrow({ where: { chapterId: chapter.id } });
    await applyAssistantArtifacts({
      prisma, jobs: app.get(JobsService), userId: userIdA, projectId: project.id,
      action: 'plan_story_outline', userContent: '修改资料',
      envelope: changedMaterial === 'characters'
        ? { reply: '更新角色', characters: [{ name: 'Lin Mo', roleType: 'protagonist', description: 'reporter investigating the old city' }] }
        : { reply: '更新大纲', storyOutline: '# 故事大纲\n## 第一卷\n1. **第一章：新的调查方向**\n   调查记者追查新的线索。' },
    });
    const stale = await app.inject({ method: 'POST', url, headers, payload });
    expect(stale.statusCode).toBe(422);
    expect(stale.json().failure).toMatchObject({ gate: 'proposal_version', recoverable: false });
    expect(await prisma.novelGenerationJob.count({ where: { projectId: project.id } })).toBe(0);
    const seedAfter = await prisma.novelChapterSeed.findUniqueOrThrow({ where: { chapterId: chapter.id } });
    expect(seedAfter.version).toBe(seedBefore.version);
    expect(seedAfter.intent).toBe(seedBefore.intent);
    // A new request compiles current materials; it must not be stuck behind the old proposal.
    const fresh = await app.inject({ method: 'POST', url, headers, payload: { content: '重新生成第一章' } });
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json().generationJobId).toBeTruthy();
    await vi.waitFor(async () => {
      const job = await prisma.novelGenerationJob.findUniqueOrThrow({ where: { jobId: fresh.json().generationJobId } });
      expect(job.status).toBe('succeeded');
    });
  });

  it('跨项目读取隔离：用户 B 不能读取用户 A 的助手资料', async () => {
    const stolen = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { content: '生成第二章' },
    });
    expect(stolen.statusCode).toBe(404);
  });

  it('计费配置失败保留已确认资料，配置恢复后同一方案可重试且只提交一次', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: 'first-chapter-e2e', description: 'Investigate the disappearance in the old city', genre: 'mystery' },
    });
    expect(created.statusCode).toBe(201);
    const firstProjectId = created.json().id as number;

    await app.inject({
      method: 'POST',
      url: `/api/projects/${firstProjectId}/documents`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { documentType: 'worldbuilding', title: 'World', content: '# World\nOld city' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/projects/${firstProjectId}/documents`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { documentType: 'creative_constitution', title: 'Constitution', content: '# Constitution\nDo not rewrite confirmed facts' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/projects/${firstProjectId}/characters`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        name: 'Lin Mo', roleType: 'protagonist', identity: 'investigator', goals: 'solve the case',
      },
    });

    const prepared = await app.inject({
      method: 'POST',
      url: `/api/projects/${firstProjectId}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { content: '生成第一章' },
    });
    expect(prepared.statusCode).toBe(201);
    const steward = prepared.json().steward as {
      status: string;
      proposalId: string;
      sourceVersion: string;
      proposals: Array<{ field: string; value: string }>;
      missing: string[];
    };
    expect(steward.status).toBe('confirmation_required');
    expect(steward.missing).toContain('风格档案');
    expect(steward.missing).toContain('章节种子');
    expect(steward.missing).not.toContain('Canon');
    expect(steward.missing).not.toContain('伏笔/承诺');

    const confirmedFields = steward.proposals.filter((row) => row.value.trim()).map((row) => row.field);
    const submission = {
      method: 'POST' as const,
      url: `/api/projects/${firstProjectId}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenA}`, accept: 'text/event-stream' },
      payload: {
        content: '采用并继续生成',
        stewardAction: 'apply_and_generate',
        proposalId: steward.proposalId,
        sourceVersion: steward.sourceVersion,
        confirmedFields,
      },
    };
    const estimate = vi.spyOn(app.get(JobsService) as unknown as {
      estimateMaxCharge(): Promise<bigint>;
    }, 'estimateMaxCharge').mockRejectedValueOnce(
      new NotFoundException('未找到模型 v2_rawstage2_gemini31 的生效费率'),
    );
    try {
      const blocked = await app.inject(submission);
      expect(blocked.statusCode).toBe(503);
      expect(blocked.json().failure).toMatchObject({
        code: 'generation_billing_unavailable',
        gate: 'billing_configuration',
        recoverable: false,
        reason: '生成服务的计费配置尚未就绪，请联系管理员补全后再生成。',
      });
      expect(blocked.body).not.toMatch(/Provider|gemini|操作失败，请稍后重试/u);
      await expect(prisma.novelGenerationJob.count({ where: { projectId: firstProjectId } })).resolves.toBe(0);
      const seed = await prisma.novelChapterSeed.findFirst({ where: { projectId: firstProjectId } });
      expect(seed?.intent.trim()).toBeTruthy();
      await expect(prisma.novelErrorReport.count({
        where: { projectId: firstProjectId, code: 'generation_billing_unavailable' },
      })).resolves.toBe(1);
    } finally {
      estimate.mockRestore();
    }
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/projects/${firstProjectId}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        content: '采用并继续生成',
        stewardAction: 'apply_and_generate',
        proposalId: steward.proposalId,
        sourceVersion: steward.sourceVersion,
        confirmedFields,
      },
    });
    expect(confirmed.statusCode).toBe(201);
    const confirmedBody = confirmed.json() as {
      generationJobId?: string;
      steward?: { status: string; missing: string[] };
    };
    expect(confirmedBody.steward?.status).toBe('ready');
    expect(confirmedBody.steward?.missing).toEqual([]);
    expect(confirmedBody.generationJobId).toBeTruthy();

    const chapter = await prisma.novelChapter.findFirst({
      where: { projectId: firstProjectId, chapterNumber: 1 },
      include: { seed: true },
    });
    expect(chapter?.seed?.intent.trim()).toBeTruthy();
    expect(chapter?.seed?.endingGoal.trim()).toBeTruthy();

    const repeated = await app.inject({
      method: 'POST',
      url: `/api/projects/${firstProjectId}/assistant/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        content: '采用并继续生成',
        stewardAction: 'apply_and_generate',
        proposalId: steward.proposalId,
        sourceVersion: steward.sourceVersion,
        confirmedFields,
      },
    });
    expect(repeated.json().generationJobId).toBe(confirmedBody.generationJobId);
    await expect(prisma.novelGenerationJob.count({ where: { projectId: firstProjectId, jobType: 'chapter_generation' } })).resolves.toBe(1);
  });
});
