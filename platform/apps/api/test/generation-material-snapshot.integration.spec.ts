/** Real PostgreSQL regression for author edits racing with a pending writer response. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { BillingService } from '../src/modules/billing/billing.service';
import { RatesService } from '../src/modules/rates/rates.service';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { hashChapterText } from '../src/modules/context/context-compiler';

describe('generation material snapshot with PostgreSQL', () => {
  const prisma = new PrismaService();
  const rates = new RatesService(prisma);
  const billing = new BillingService(prisma, rates);
  let userId: number;

  beforeAll(async () => {
    await prisma.$connect();
    const user = await prisma.user.create({ data: {
      email: `snapshot-${randomUUID()}@test.local`, passwordHash: 'not-a-login',
      nickname: 'snapshot-integration', balance: 1000n,
    } });
    userId = user.id;
  });

  afterAll(async () => {
    try {
      if (userId) {
        await prisma.$transaction(async (tx) => {
          await tx.novelBalanceHold.deleteMany({ where: { userId } });
          await tx.novelChapterVersion.deleteMany({ where: { userId } });
          await tx.novelGenerationJob.deleteMany({ where: { userId } });
          await tx.novelChapterSeed.deleteMany({ where: { userId } });
          await tx.novelChapter.deleteMany({ where: { userId } });
          await tx.novelDocumentVersion.deleteMany({ where: { createdBy: userId } });
          await tx.novelDocument.deleteMany({ where: { userId } });
          await tx.novelCharacter.deleteMany({ where: { userId } });
          await tx.novelProject.deleteMany({ where: { userId } });
          await tx.user.delete({ where: { id: userId } });
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it.each(['character', 'deleted_style', 'unchanged'] as const)(
    'commits only matching material inputs: %s', async (change) => {
      const project = await prisma.novelProject.create({ data: { userId, title: 'snapshot-fixture', genre: 'fantasy' } });
      const projectId = project.id;
      const chapter = await prisma.novelChapter.create({ data: {
        userId, projectId, chapterNumber: 1, content: 'accepted-fixture', status: 'final',
      } });
      const chapterId = chapter.id;
      await prisma.novelChapterSeed.create({ data: {
        userId, projectId, chapterId, intent: 'fixture-intent', endingGoal: 'fixture-end',
      } });
      const character = await prisma.novelCharacter.create({ data: {
        userId, projectId, name: 'fixture-character', identity: 'fixture-identity', motivation: 'original',
      } });
      await prisma.novelDocument.createMany({ data: [
        { userId, projectId, documentType: 'style_profile', title: 'style', content: '{"voice":"fixture"}' },
        { userId, projectId, documentType: 'worldbuilding', title: 'world', content: 'fixture-world' },
        { userId, projectId, documentType: 'creative_constitution', title: 'constitution', content: 'fixture-constitution' },
        { userId, projectId, documentType: 'narrative_state', title: 'state', content: '{"canon":[],"character":[],"promise":[]}' },
      ] });
      const originalState = await prisma.novelDocument.findFirstOrThrow({ where: { projectId, documentType: 'narrative_state' } });
      const jobId = randomUUID();
      await prisma.novelGenerationJob.create({ data: { userId, projectId, chapterId, jobId, maxCharge: 100n, status: 'running' } });
      await billing.createHold({ userId, jobId, amount: 100n });
      const invoke = vi.fn(async () => {
        if (change === 'character') {
          await prisma.novelCharacter.update({ where: { id: character.id }, data: { motivation: 'edited', version: { increment: 1 } } });
        }
        if (change === 'deleted_style') {
          await prisma.novelDocument.updateMany({ where: { projectId, documentType: 'style_profile' }, data: { deletedAt: new Date() } });
        }
        return {
          status: 'ok', metering: { modelCallCount: 1, inputTokens: 1, outputTokens: 1 },
          result: { status: 'ok', text: 'transport-fixture', runtimeState: { canon: [], character: [], promise: [], lastCommittedChapter: 'ch1' } },
        };
      });
      const service = new JobsService(prisma, billing, rates, { invoke } as never);
      await (service as unknown as { runHttpGeneration(value: unknown): Promise<void> }).runHttpGeneration({
        userId, projectId, chapterId, jobId, maxCharge: 100n, chapterNumber: 1,
        chapterVersion: 1, seedVersion: 1, continuationMode: 'replace', continuationDraft: chapter.content,
      });
      const [saved, state, job, hold, versions] = await Promise.all([
        prisma.novelChapter.findUniqueOrThrow({ where: { id: chapterId } }),
        prisma.novelDocument.findUniqueOrThrow({ where: { id: originalState.id } }),
        prisma.novelGenerationJob.findUniqueOrThrow({ where: { jobId } }),
        prisma.novelBalanceHold.findUniqueOrThrow({ where: { jobId } }),
        prisma.novelChapterVersion.count({ where: { chapterId } }),
      ]);
      expect(invoke).toHaveBeenCalledTimes(1);
      if (change === 'unchanged') {
        expect(saved).toMatchObject({ content: 'transport-fixture', version: 2 });
        expect(state.currentVersion).toBe(2);
        expect(job.status).toBe('succeeded');
        expect(hold.status).toBe('settled');
        expect(versions).toBe(1);
      } else {
        expect(saved).toMatchObject({ content: 'accepted-fixture', version: 1 });
        expect(state.content).toBe(originalState.content);
        expect(state.currentVersion).toBe(1);
        expect(job).toMatchObject({ status: 'failed', failure: { code: 'generation_materials_changed', recoverable: false } });
        expect(hold.status).toBe('released');
        expect(versions).toBe(0);
      }
    },
  );

  it.each(['restore', 'missing_checkpoint', 'wrong_hash', 'state_edit', 'first_chapter'] as const)(
    'rewrites from a verified historical boundary in PostgreSQL: %s', async (scenario) => {
      const project = await prisma.novelProject.create({ data: { userId, title: 'history-fixture', genre: 'fantasy' } });
      const projectId = project.id;
      const chapters = [];
      for (let number = 1; number <= 3; number += 1) {
        const chapter = await prisma.novelChapter.create({ data: {
          userId, projectId, chapterNumber: number, title: `fixture-title-${number}`,
          content: `accepted-fixture-${number}`, status: 'generated',
        } });
        await prisma.novelChapterSeed.create({ data: {
          userId, projectId, chapterId: chapter.id, intent: 'fixture-intent', endingGoal: 'fixture-goal',
        } });
        chapters.push(chapter);
      }
      await prisma.novelCharacter.create({ data: {
        userId, projectId, name: 'fixture-character', identity: 'fixture-role', motivation: 'fixture-motive',
      } });
      await prisma.novelDocument.createMany({ data: [
        { userId, projectId, documentType: 'style_profile', title: 'style', content: '{"voice":"fixture"}' },
        { userId, projectId, documentType: 'worldbuilding', title: 'world', content: 'fixture-world' },
        { userId, projectId, documentType: 'creative_constitution', title: 'constitution', content: 'fixture-constitution' },
        { userId, projectId, documentType: 'story_outline', title: 'outline', content: 'author-future-plan deliberately remains available' },
      ] });
      const past = JSON.stringify({
        schemaVersion: 1, workspaceId: `p${projectId}`, lastCommittedChapter: 'ch1',
        canon: [{ fact: 'past-fact', sourceChapter: 'ch1', sourceRef: `ch1#finalText:${
          scenario === 'wrong_hash' ? 'aaaaaaaaaaaa' : hashChapterText(chapters[0].content)}` }],
        character: [{ characterId: 'fixture', field: 'location', value: 'past-location', sourceChapter: 'ch1' }],
        promise: [{ description: 'past-promise', status: 'open', sourceChapter: 'ch1' }], pattern: [],
      });
      const latest = JSON.stringify({
        ...JSON.parse(past), lastCommittedChapter: 'ch3',
        character: [{ characterId: 'fixture', field: 'location', value: 'future-location', sourceChapter: 'ch1' }],
        promise: [{ description: 'past-promise', status: 'fulfilled', sourceChapter: 'ch1' }],
      });
      const document = await prisma.novelDocument.create({ data: {
        userId, projectId, documentType: 'narrative_state', title: 'state', content: latest, currentVersion: 2,
      } });
      if (scenario !== 'missing_checkpoint') {
        await prisma.novelDocumentVersion.create({ data: {
          documentId: document.id, createdBy: userId, versionNumber: 1, content: past,
        } });
      }
      const target = chapters[scenario === 'first_chapter' ? 0 : 1];
      const jobId = randomUUID();
      await prisma.novelGenerationJob.create({ data: {
        userId, projectId, chapterId: target.id, jobId, maxCharge: 100n, status: 'running',
      } });
      await billing.createHold({ userId, jobId, amount: 100n });
      const nextState = { canon: [], character: [], promise: [], lastCommittedChapter: `ch${target.chapterNumber}` };
      const invoke = vi.fn(async (_token: unknown, tool: string, payload: Record<string, unknown>) => {
        expect(tool).toBe('novel_generate_chapter');
        const documents = payload.workspaceDocuments as Array<{ type: string; content: string }>;
        const narrative = JSON.parse(documents.find((row) => row.type === 'narrative_state')!.content);
        expect(JSON.stringify(payload)).not.toContain('future-location');
        expect(JSON.stringify(payload)).not.toContain('accepted-fixture-3');
        expect(JSON.stringify(payload)).toContain('author-future-plan');
        if (scenario === 'first_chapter') {
          expect(narrative.canon).toEqual([]);
          expect(narrative.character).toEqual([]);
        } else {
          expect(narrative.promise[0].status).toBe('open');
          expect(narrative.character[0].value).toBe('past-location');
        }
        if (scenario === 'state_edit') {
          await prisma.novelDocument.update({ where: { id: document.id }, data: {
            content: JSON.stringify({ ...JSON.parse(latest), authorEdit: 'changed' }),
            currentVersion: { increment: 1 },
          } });
        }
        return { status: 'ok', metering: { modelCallCount: 1 },
          result: { status: 'ok', text: 'rewritten-transport-fixture', runtimeState: nextState } };
      });
      const service = new JobsService(prisma, billing, rates, { invoke } as never);
      await (service as unknown as { runHttpGeneration(value: unknown): Promise<void> }).runHttpGeneration({
        userId, projectId, chapterId: target.id, jobId, maxCharge: 100n,
        chapterNumber: target.chapterNumber, chapterVersion: 1, seedVersion: 1,
        continuationMode: 'replace', continuationDraft: target.content,
      });
      const saved = await prisma.novelChapter.findUniqueOrThrow({ where: { id: target.id } });
      const job = await prisma.novelGenerationJob.findUniqueOrThrow({ where: { jobId } });
      const state = await prisma.novelDocument.findUniqueOrThrow({ where: { id: document.id } });
      const hold = await prisma.novelBalanceHold.findUniqueOrThrow({ where: { jobId } });
      if (scenario === 'missing_checkpoint' || scenario === 'wrong_hash') {
        expect(invoke).not.toHaveBeenCalled();
        expect(job).toMatchObject({ status: 'failed', failure: { code: 'generation_history_unavailable', recoverable: false } });
        expect(state.content).toBe(latest);
        expect(hold.status).toBe('released');
        expect(saved.content).toBe(target.content);
      } else if (scenario === 'state_edit') {
        expect(invoke).toHaveBeenCalledOnce();
        expect(job).toMatchObject({ status: 'failed', failure: { code: 'generation_materials_changed', recoverable: false } });
        expect(saved.content).toBe(target.content);
        expect(state.content).toContain('authorEdit');
        expect(hold.status).toBe('released');
      } else {
        expect(invoke).toHaveBeenCalledOnce();
        expect(job.status).toBe('succeeded');
        expect(saved.content).toBe('rewritten-transport-fixture');
        expect(JSON.parse(state.content)).toEqual(nextState);
        expect(state.currentVersion).toBe(3);
        expect(hold.status).toBe('settled');
      }
      expect((await prisma.novelChapter.findUniqueOrThrow({ where: { id: chapters[2].id } })).content).toBe(chapters[2].content);
    },
  );
});
