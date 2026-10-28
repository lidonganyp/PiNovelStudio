/** Stable author consent fingerprint shared by revision dispatch and final chapter commit. */
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

export async function revisionAuthorHash(prisma: Prisma.TransactionClient, userId: number, projectId: number, chapterIds: number[]): Promise<string> {
  const [project, characters, documents, seeds] = await Promise.all([
    prisma.novelProject.findFirst({ where: { id: projectId, userId, deletedAt: null }, select: { title: true, description: true, genre: true, subGenres: true, worldKeyTerms: true } }),
    prisma.novelCharacter.findMany({ where: { userId, projectId, deletedAt: null }, orderBy: { id: 'asc' } }),
    prisma.novelDocument.findMany({ where: { userId, projectId, deletedAt: null, documentType: { in: ['story_outline', 'creative_constitution', 'worldbuilding', 'style_profile'] } }, select: { id: true, content: true, currentVersion: true, documentType: true }, orderBy: { id: 'asc' } }),
    prisma.novelChapterSeed.findMany({ where: { userId, projectId, chapterId: { in: chapterIds } }, select: { chapterId: true, intent: true, mustInclude: true, forbiddenFacts: true, characterMotives: true, promises: true, endingGoal: true, version: true }, orderBy: { chapterId: 'asc' } }),
  ]);
  return createHash('sha256').update(JSON.stringify({ project, characters, documents, seeds })).digest('hex');
}

export async function assertRevisionConsent(prisma: Prisma.TransactionClient, revisionId: string, userId: number, projectId: number): Promise<void> {
  const revision = await prisma.novelRevision.findFirst({ where: { id: revisionId, userId, projectId } });
  if (!revision) throw new Error('generation_materials_changed: 重写授权不存在');
  const plan = revision.plan as { items: Array<{ chapterId: number }> };
  if (revision.inputHash !== await revisionAuthorHash(prisma, userId, projectId, plan.items.map((item) => item.chapterId))) {
    throw new Error('generation_materials_changed: 已确认的创作资料发生变化，请重新确认范围');
  }
}
