/** Durable revision journeys against PostgreSQL; transport fixtures are not novel prose. */
import { randomUUID } from 'node:crypto';
import type { NovelChapter } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { RevisionsService } from '../src/modules/jobs/revisions.service';

describe('confirmed sequential revisions', () => {
  const prisma = new PrismaService();
  let userId: number;
  beforeAll(async () => {
    await prisma.$connect();
    userId = (await prisma.user.create({ data: { email: `revision-${randomUUID()}@test.local`, passwordHash: 'fixture', nickname: 'fixture' } })).id;
  });
  afterAll(async () => {
    await prisma.novelRevision.deleteMany({ where: { userId } });
    await prisma.novelChapterVersion.deleteMany({ where: { userId } });
    await prisma.novelGenerationJob.deleteMany({ where: { userId } });
    await prisma.novelChapterSeed.deleteMany({ where: { userId } });
    await prisma.novelChapter.deleteMany({ where: { userId } });
    await prisma.novelCharacter.deleteMany({ where: { userId } });
    await prisma.novelProject.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function fixture(manual = 0) {
    const project = await prisma.novelProject.create({ data: { userId, title: 'revision-fixture', genre: 'fantasy' } });
    await prisma.novelCharacter.create({ data: { userId, projectId: project.id, name: 'fixture', motivation: 'new-author-intent' } });
    const chapters: NovelChapter[] = [];
    for (let n = 1; n <= 3; n++) {
      const chapter = await prisma.novelChapter.create({ data: { userId, projectId: project.id, chapterNumber: n, content: `accepted-${n}`, status: 'generated' } });
      await prisma.novelChapterSeed.create({ data: { userId, projectId: project.id, chapterId: chapter.id, intent: 'fixture-intent', endingGoal: 'fixture-goal' } });
      await prisma.novelChapterVersion.create({ data: { userId, projectId: project.id, chapterId: chapter.id, createdBy: userId, versionNumber: 1, title: '', content: chapter.content, wordCount: 1, source: n === manual ? 'manual_save' : 'ai_generated' } });
      chapters.push(chapter);
    }
    let failChapter = 0;
    const submit = vi.fn(async (_user: number, _project: number, id: number, options: { jobId: string; revisionId: string }) => {
      const chapter = chapters.find((row) => row.id === id)!;
      const failed = chapter.chapterNumber === failChapter;
      await prisma.novelGenerationJob.create({ data: { jobId: options.jobId, userId, projectId: project.id, chapterId: id, revisionId: options.revisionId, status: failed ? 'failed' : 'succeeded', maxCharge: 200n, settledAmount: failed ? 0n : 10n, completedAt: new Date(), failure: failed ? { reason: 'fixture style failure', recoverable: true } : undefined } });
      if (!failed) await prisma.novelChapter.update({ where: { id }, data: { content: `transport-result-${chapter.chapterNumber}`, generationJobId: options.jobId, version: { increment: 1 } } });
      return { jobId: options.jobId };
    });
    const service = new RevisionsService(prisma, { submitChapterGeneration: submit } as never);
    return { project, chapters, service, submit, fail: (n: number) => { failChapter = n; } };
  }

  it('requires confirmation, rewrites existing chapters in order, and survives a new worker instance', async () => {
    const { service, project, submit } = await fixture();
    const plan = await service.propose(userId, project.id, {});
    await service.tick();
    expect(submit).not.toHaveBeenCalled();
    await service.confirm(userId, project.id, plan.id, plan.version);
    await service.confirm(userId, project.id, plan.id, plan.version);
    for (let i = 0; i < 4; i++) await service.tick();
    const resumed = new RevisionsService(prisma, { submitChapterGeneration: submit } as never);
    for (let i = 0; i < 6; i++) await resumed.tick();
    expect(submit.mock.calls.map((call) => call[2])).toHaveLength(3);
    expect(submit.mock.calls.every((call) => (call[3] as unknown as { continuationMode: string }).continuationMode === 'replace')).toBe(true);
    expect(await service.get(userId, project.id, plan.id)).toMatchObject({ status: 'succeeded', completedChapters: 3 });
  });

  it('retains successful progress and automatically recovers only the failed chapter within consent', async () => {
    const { service, project, submit, fail } = await fixture();
    fail(2);
    const plan = await service.propose(userId, project.id, {});
    await service.confirm(userId, project.id, plan.id, plan.version);
    for (let i = 0; i < 3; i++) await service.tick();
    expect(await service.get(userId, project.id, plan.id)).toMatchObject({ status: 'running', completedChapters: 1 });
    expect(submit).toHaveBeenCalledTimes(2);
    fail(0);
    for (let i = 0; i < 8; i++) await service.tick();
    expect(submit).toHaveBeenCalledTimes(4);
    expect((await service.get(userId, project.id, plan.id)).status).toBe('succeeded');
  });

  it('bounded automatic recovery stops at the original attempt budget', async () => {
    const { service, project, submit, fail } = await fixture(); fail(1);
    const plan = await service.propose(userId, project.id, {});
    await service.confirm(userId, project.id, plan.id, plan.version);
    for(let i=0;i<12;i++) await service.tick();
    expect(submit).toHaveBeenCalledTimes(7);
    expect(await service.get(userId, project.id, plan.id)).toMatchObject({ status:'paused', pauseCode:'budget_exhausted', completedChapters:0 });
    await expect(service.resume(userId, project.id, plan.id)).rejects.toThrow();
  });

  it('explicit manual approval binds the current version and permits only that protected chapter', async () => {
    const { service, project, submit, chapters } = await fixture(2);
    const plan = await service.propose(userId, project.id, {}); await service.confirm(userId, project.id, plan.id, plan.version);
    for(let i=0;i<5;i++) await service.tick();
    await expect(service.approveManual(userId,project.id,plan.id,99)).rejects.toThrow();
    await service.approveManual(userId,project.id,plan.id,chapters[1].version);
    for(let i=0;i<8;i++) await service.tick();
    expect(submit).toHaveBeenCalledTimes(3); expect((await service.get(userId,project.id,plan.id)).status).toBe('succeeded');
  });

  it('editing a completed predecessor pauses before any later chapter dispatch', async () => {
    const { service, project, submit, chapters } = await fixture();
    const plan = await service.propose(userId, project.id, {}); await service.confirm(userId, project.id, plan.id, plan.version);
    await service.tick();await service.tick();
    await prisma.novelChapter.update({where:{id:chapters[0].id},data:{version:{increment:1},content:'manual-change-after-completion'}});
    await service.tick(); expect(submit).toHaveBeenCalledTimes(1);
    expect(await service.get(userId,project.id,plan.id)).toMatchObject({status:'paused',pauseCode:'materials_changed'});
  });

  it('pauses before a manually edited chapter and never silently skips it', async () => {
    const { service, project, submit, chapters } = await fixture(2);
    const plan = await service.propose(userId, project.id, {});
    await service.confirm(userId, project.id, plan.id, plan.version);
    for (let i = 0; i < 6; i++) await service.tick();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await service.get(userId, project.id, plan.id)).toMatchObject({ status: 'paused', pauseCode: 'manual_chapter', completedChapters: 1 });
    expect((await prisma.novelChapter.findUniqueOrThrow({ where: { id: chapters[1].id } })).content).toBe('accepted-2');
  });

  it('rejects changed author materials at confirmation and enforces ownership', async () => {
    const { service, project } = await fixture();
    const plan = await service.propose(userId, project.id, {});
    await expect(service.get(userId + 1, project.id, plan.id)).rejects.toThrow();
    await prisma.novelCharacter.updateMany({ where: { projectId: project.id }, data: { motivation: 'edited-again' } });
    await expect(service.confirm(userId, project.id, plan.id, plan.version)).rejects.toThrow();
  });
});
