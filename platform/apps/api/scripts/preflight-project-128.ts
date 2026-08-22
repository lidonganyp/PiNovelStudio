/**
 * 项目 128 第二章生成前只读预检：不虚构作者设定，不提交生成任务。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import '../src/config/load-env-file';
import { compileProjectContext, estimateTokens } from '../src/modules/context/context-compiler';
import { listAuthorContractGaps } from '../src/modules/jobs/book-context';

const PROJECT_ID = 128;
const CHAPTER = 2;
const prisma = new PrismaClient();
const outDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/tasks/project-128-snapshots',
);

async function main(): Promise<void> {
  const project = await prisma.novelProject.findUnique({ where: { id: PROJECT_ID } });
  if (!project) throw new Error('project 128 not found');
  const documents = await prisma.novelDocument.findMany({
    where: { projectId: PROJECT_ID, deletedAt: null },
  });
  const characters = await prisma.novelCharacter.findMany({
    where: { projectId: PROJECT_ID, deletedAt: null },
  });
  const chapters = await prisma.novelChapter.findMany({
    where: { projectId: PROJECT_ID, deletedAt: null },
    include: { seed: true },
    orderBy: { chapterNumber: 'asc' },
  });
  const byType = new Map(documents.map((row) => [row.documentType, row]));
  const previous = chapters.find((row) => row.chapterNumber === CHAPTER - 1);
  const current = chapters.find((row) => row.chapterNumber === CHAPTER);
  const compiled = compileProjectContext({
    storyOutline: byType.get('story_outline'),
    constitution: byType.get('creative_constitution'),
    worldbuilding: byType.get('worldbuilding'),
    styleProfile: byType.get('style_profile'),
    narrativeState: byType.get('narrative_state'),
    chapterSeed: current?.seed
      ? { ...current.seed, chapterNumber: CHAPTER }
      : undefined,
    characters,
    previousChapter: previous
      ? { chapterNumber: previous.chapterNumber, content: previous.content }
      : undefined,
    enforceStateHash: true,
  });
  const contract = listAuthorContractGaps({
    genre: project.genre,
    constitution: byType.get('creative_constitution')?.content,
    worldbuilding: byType.get('worldbuilding')?.content,
    styleProfile: byType.get('style_profile')?.content,
    characters,
    compact: compiled.compact,
    usableStoryOutline: compiled.usableStoryOutline,
  });
  const gaps = [
    ...contract.blocking,
    ...contract.advisory,
    ...(!project.description.trim() ? ['项目简介为空'] : []),
  ];
  const included = compiled.manifest.blocks.filter((block) => block.included);
  const omitted = compiled.manifest.blocks.filter((block) => !block.included);
  const report = {
    capturedAt: new Date().toISOString(),
    hashCheck: 'passed',
    bookBriefTokens: estimateTokens(compiled.bookBrief),
    manifestTokens: compiled.manifest.totalTokensUsed,
    includedBlocks: included.map((block) => block.name),
    omittedBlocks: omitted.map((block) => ({ name: block.name, reason: block.omittedReason })),
    previousChapterFullTextInBrief: previous
      ? compiled.bookBrief.includes(previous.content)
      : false,
    defaultsInjected: false,
    generationReady: contract.blocking.length === 0,
    blocking: contract.blocking,
    gaps,
    staleJobId: '315869d1-c1ff-4a11-9abb-27633fa74f01',
    note: 'job 315869d1 发生在 Runtime 重建前且 modelCallCount=0，不能作为当前代码结论。缺少作者确认资料时不得提交第二章生成，也不会用默认题材/风格/世界观代替。',
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'chapter-2-preflight.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const report = {
      capturedAt: new Date().toISOString(),
      hashCheck: 'failed',
      error: message,
      generationReady: false,
    };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, 'chapter-2-preflight.json'), JSON.stringify(report, null, 2), 'utf8');
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
