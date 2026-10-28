/** PostgreSQL dispatch leases retain frozen inputs and prevent duplicate workers. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { JobsService, fingerprintGenerationMaterials } from '../src/modules/jobs/jobs.service';

describe('durable chapter dispatch', () => {
  const prisma = new PrismaService();
  let userId: number;
  let projectId: number;
  let chapterId: number;
  beforeAll(async () => {
    await prisma.$connect();
    userId = (await prisma.user.create({ data: { email: `durable-${randomUUID()}@test.local`, passwordHash: 'fixture', nickname: 'fixture' } })).id;
    projectId = (await prisma.novelProject.create({ data: { userId, title: 'durable-fixture' } })).id;
    chapterId = (await prisma.novelChapter.create({ data: { userId, projectId, chapterNumber: 1 } })).id;
  });
  afterAll(async () => {
    await prisma.novelGenerationJob.deleteMany({ where: { userId } });
    await prisma.novelChapter.deleteMany({ where: { userId } });
    await prisma.novelProject.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });
  it('reclaims an expired lease with the original snapshot and dispatches only once across two workers', async () => {
    const jobId = randomUUID();
    await prisma.novelGenerationJob.create({ data: {
      jobId, userId, projectId, chapterId, status: 'running', maxCharge: 200n,
      leaseOwner: 'dead-worker', leaseUntil: new Date(Date.now() - 1),
      execution: { version: 1, deadlineAt: Date.now() + 60_000, input: { userId, projectId, chapterId,
        jobId, maxCharge: '200', chapterNumber: 1, chapterVersion: 7, seedVersion: 9,
        continuationMode: 'replace', continuationDraft: 'old', runtimeWorkspaceInput: { frozen: 'author-snapshot' } } },
    } });
    const billing = { createHold: vi.fn().mockResolvedValue({}) };
    const a = new JobsService(prisma, billing as never, {} as never, {} as never);
    const b = new JobsService(prisma, billing as never, {} as never, {} as never);
    const calls: unknown[] = [];
    const execute = async (input: unknown): Promise<void> => {
      calls.push(input);
      await prisma.novelGenerationJob.update({ where: { jobId }, data: { status: 'succeeded' } });
    };
    vi.spyOn(a as never as { runHttpGeneration: typeof execute }, 'runHttpGeneration').mockImplementation(execute);
    vi.spyOn(b as never as { runHttpGeneration: typeof execute }, 'runHttpGeneration').mockImplementation(execute);
    await Promise.all([a.dispatchStoredJobs(), b.dispatchStoredJobs()]);
    await a.drain(); await b.drain();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ chapterVersion: 7, seedVersion: 9, maxCharge: 200n, runtimeWorkspaceInput: { frozen: 'author-snapshot' } });
    expect(billing.createHold).toHaveBeenCalledTimes(1);
    expect((await prisma.novelGenerationJob.findUniqueOrThrow({ where: { jobId } })).leaseOwner).toBeNull();
  });
  it('material equality survives PostgreSQL JSONB key ordering and still detects author edits', async () => {
    const materials = { workspaceDocuments: [{ type: 'style_profile', content: 'author-style' }],
      projectConfig: { worldKeyTerms: ['term'], genre: 'fantasy', characters: [{ role: 'lead', name: 'fixture' }] },
      contextManifest: { materialSourceHash: 'state-hash', compiledAt: 'observation-only' } };
    const row = await prisma.novelGenerationJob.create({ data: { userId, projectId, chapterId, jobId: randomUUID(), status: 'failed', maxCharge: 200n, execution: materials } });
    const restored = row.execution as unknown as Record<string, unknown>;
    expect(fingerprintGenerationMaterials(restored)).toBe(fingerprintGenerationMaterials(materials));
    expect(fingerprintGenerationMaterials({ ...materials, contextManifest: { materialSourceHash:'state-hash', compiledAt:'new-observation' } })).toBe(fingerprintGenerationMaterials(materials));
    expect(fingerprintGenerationMaterials({ ...materials, workspaceDocuments: [{ type: 'style_profile', content: 'changed-style' }] })).not.toBe(fingerprintGenerationMaterials(materials));
  });
});
