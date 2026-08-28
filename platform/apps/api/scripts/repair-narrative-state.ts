/**
 * Repair a project's narrative-state watermark from an accepted chapter.
 * The script stores only a hash-bound marker, never chapter prose.
 * Default mode is a read-only audit; pass --apply to commit the repair.
 */
import '../src/config/load-env-file';
import { PrismaClient } from '@prisma/client';
import { ensureChapterFinalTextCommit, hashChapterText } from '../src/modules/context/context-compiler';

interface Options {
  projectId: number;
  chapterNumber: number;
  apply: boolean;
}

function parseOptions(argv: string[]): Options {
  let projectId: number | undefined;
  let chapterNumber: number | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') projectId = Number(argv[++index]);
    else if (arg === '--chapter') chapterNumber = Number(argv[++index]);
    else if (arg === '--apply') apply = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isSafeInteger(projectId) || (projectId ?? 0) < 1) throw new Error('--project is required');
  if (!Number.isSafeInteger(chapterNumber) || (chapterNumber ?? 0) < 1) throw new Error('--chapter is required');
  return { projectId: projectId as number, chapterNumber: chapterNumber as number, apply };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const project = await prisma.novelProject.findUnique({ where: { id: options.projectId }, select: { id: true, userId: true, title: true } });
    if (!project) throw new Error(`project ${options.projectId} not found`);
    const chapter = await prisma.novelChapter.findFirst({
      where: { projectId: options.projectId, userId: project.userId, chapterNumber: options.chapterNumber, deletedAt: null },
      select: { id: true, chapterNumber: true, content: true, status: true, version: true },
    });
    if (!chapter || !chapter.content.trim()) throw new Error(`accepted chapter ${options.chapterNumber} content not found`);
    const hash = hashChapterText(chapter.content);
    const narrative = await prisma.novelDocument.findFirst({
      where: { projectId: options.projectId, userId: project.userId, documentType: 'narrative_state', deletedAt: null },
      orderBy: { id: 'asc' },
      select: { id: true, content: true, currentVersion: true },
    });
    if (!narrative) throw new Error('narrative_state document not found; create it through the normal project workflow first');
    const repaired = ensureChapterFinalTextCommit(narrative.content, options.chapterNumber, chapter.content);
    const result = { projectId: project.id, chapterId: chapter.id, chapterNumber: chapter.chapterNumber, chapterStatus: chapter.status, chapterVersion: chapter.version, finalTextHash: repaired.hash, changed: repaired.updated, applied: false };
    if (options.apply && repaired.updated) {
      await prisma.$transaction(async (tx) => {
        const nextVersion = narrative.currentVersion + 1;
        const write = await tx.novelDocument.updateMany({
          where: { id: narrative.id, projectId: options.projectId, userId: project.userId, deletedAt: null, currentVersion: narrative.currentVersion },
          data: { content: repaired.content, currentVersion: nextVersion },
        });
        if (write.count !== 1) throw new Error('narrative state changed while repair was running');
        await tx.novelDocumentVersion.create({
          data: { documentId: narrative.id, createdBy: project.userId, versionNumber: nextVersion, content: repaired.content, changeSummary: `chapter ${options.chapterNumber} final text state repair` },
        });
      });
      result.applied = true;
    }
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
