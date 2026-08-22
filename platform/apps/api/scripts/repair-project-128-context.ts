/**
 * 项目 128 上下文修复：先快照，再隔离污染大纲、压缩 narrative_state、重锚 hash。
 * 默认 dry-run；加 --apply 才写库。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import '../src/config/load-env-file';
import { compactNarrativeStateJson, isUsableStoryOutline } from '../src/modules/jobs/book-context';

const PROJECT_ID = 128;
const apply = process.argv.includes('--apply');
const prisma = new PrismaClient();
const outDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/tasks/project-128-snapshots',
);

function hash12(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

function reanchorHashes(json: string, chapterNumber: number, actualHash: string): string {
  const chapterId = `ch${chapterNumber}`;
  return json.replace(
    new RegExp(`${chapterId}#finalText:[0-9a-fA-F]{12}`, 'g'),
    `${chapterId}#finalText:${actualHash}`,
  );
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const project = await prisma.novelProject.findUnique({ where: { id: PROJECT_ID } });
  if (!project) {
    throw new Error(`project ${PROJECT_ID} not found`);
  }
  const documents = await prisma.novelDocument.findMany({
    where: { projectId: PROJECT_ID, deletedAt: null },
    select: { id: true, documentType: true, title: true, content: true, currentVersion: true },
  });
  const chapters = await prisma.novelChapter.findMany({
    where: { projectId: PROJECT_ID, deletedAt: null },
    include: { seed: true },
    orderBy: { chapterNumber: 'asc' },
  });
  const snapshot = {
    capturedAt: new Date().toISOString(),
    project: {
      id: project.id,
      title: project.title,
      genre: project.genre,
      description: project.description,
    },
    documents: documents.map((row) => ({
      id: row.id,
      documentType: row.documentType,
      title: row.title,
      currentVersion: row.currentVersion,
      chars: row.content.length,
      head: row.content.slice(0, 240),
      polluted: row.documentType === 'story_outline' && !isUsableStoryOutline(row.content),
    })),
    chapters: chapters.map((row) => ({
      id: row.id,
      chapterNumber: row.chapterNumber,
      title: row.title,
      chars: row.content.length,
      hash12: hash12(row.content),
      seedIntent: row.seed?.intent ?? '',
    })),
  };
  writeFileSync(resolve(outDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');

  const outline = documents.find((row) => row.documentType === 'story_outline');
  const narrative = documents.find((row) => row.documentType === 'narrative_state');
  const chapter1 = chapters.find((row) => row.chapterNumber === 1);
  const report: Record<string, unknown> = {
    apply,
    snapshotPath: resolve(outDir, 'snapshot.json'),
    isolatedOutline: false,
    compactedNarrative: false,
    reanchoredHash: null as string | null,
  };

  if (apply && outline && !isUsableStoryOutline(outline.content)) {
    const nextVersion = outline.currentVersion + 1;
    await prisma.novelDocument.update({
      where: { id: outline.id },
      data: {
        documentType: 'story_outline_isolated',
        title: `${outline.title}（已隔离污染稿）`,
        currentVersion: nextVersion,
      },
    });
    await prisma.novelDocumentVersion.create({
      data: {
        documentId: outline.id,
        createdBy: project.userId,
        versionNumber: nextVersion,
        content: outline.content,
        changeSummary: 'isolation: chapter-seed dump was polluting story_outline',
      },
    });
    report.isolatedOutline = true;
  }

  if (apply && narrative && chapter1) {
    const actualHash = hash12(chapter1.content);
    const compacted = compactNarrativeStateJson(narrative.content);
    const nextJson = reanchorHashes(compacted.json, 1, actualHash);
    const nextVersion = narrative.currentVersion + 1;
    await prisma.novelDocument.update({
      where: { id: narrative.id },
      data: { content: nextJson, currentVersion: nextVersion },
    });
    await prisma.novelDocumentVersion.create({
      data: {
        documentId: narrative.id,
        createdBy: project.userId,
        versionNumber: nextVersion,
        content: nextJson,
        changeSummary: `repair: compact accepted-chapter evidence and reanchor ch1 hash to ${actualHash}`,
      },
    });
    report.compactedNarrative = true;
    report.reanchoredHash = actualHash;
  }

  writeFileSync(resolve(outDir, 'repair-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
