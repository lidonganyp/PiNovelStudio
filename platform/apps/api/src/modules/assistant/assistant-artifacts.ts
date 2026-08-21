/**
 * 将助手产出落入项目板块：大纲文档/大纲树/角色/章节种子。
 * 章节正文只调度统一生成链路，绝不把聊天稿写成章节。
 */
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { JobsService } from '../jobs/jobs.service';
import {
  CHARACTERS_BLOCK_RE,
  CHAPTER_SEED_BLOCK_RE,
  extractMarkedBlock,
  inferCharactersFromText,
  inferGenerateChapterNumber,
  looksLikeOutline,
  OUTLINE_BLOCK_RE,
  parseChapterSeed,
  parseCharacterLines,
  parseOutlineChapters,
  stripGenerateChapterMarker,
  userAskedForCharacters,
  userAskedForOutline,
  type OutlineChapter,
  type ParsedCharacter,
  type ParsedChapterSeed,
} from './assistant-markers';

const logger = new Logger('AssistantArtifacts');

export interface AssistantArtifactsView {
  outlineSaved: boolean;
  charactersSaved: number;
  chaptersTouched: number[];
  generationJobId?: string;
  focusTab?: 'outline' | 'characters' | 'chapter' | 'seed';
}

export interface AssistantArtifactResult {
  content: string;
  metadata: Record<string, unknown>;
  artifacts: AssistantArtifactsView;
  generationJobId?: string;
}

export async function applyAssistantArtifacts(input: {
  prisma: PrismaService;
  jobs: JobsService;
  userId: number;
  projectId: number;
  content: string;
  userContent: string;
}): Promise<AssistantArtifactResult> {
  let content = input.content;
  const metadata: Record<string, unknown> = {};
  const artifacts: AssistantArtifactsView = {
    outlineSaved: false,
    charactersSaved: 0,
    chaptersTouched: [],
  };

  const outlineBlock = extractMarkedBlock(content, OUTLINE_BLOCK_RE);
  let outlineMarkdown = outlineBlock?.inner ?? '';
  if (outlineBlock) content = outlineBlock.stripped;
  if (
    !outlineMarkdown &&
    userAskedForOutline(input.userContent) &&
    looksLikeOutline(content)
  ) {
    outlineMarkdown = content.trim();
  }

  let outlineChapters: OutlineChapter[] = [];
  if (outlineMarkdown && looksLikeOutline(outlineMarkdown)) {
    await upsertStoryOutline(input.prisma, input.userId, input.projectId, outlineMarkdown);
    outlineChapters = parseOutlineChapters(outlineMarkdown);
    await replaceOutlineNodes(
      input.prisma,
      input.userId,
      input.projectId,
      outlineMarkdown,
      outlineChapters,
    );
    const touched = await ensureChapterShells(
      input.prisma,
      input.userId,
      input.projectId,
      outlineChapters,
    );
    artifacts.outlineSaved = true;
    artifacts.chaptersTouched = touched;
    artifacts.focusTab = 'outline';
    metadata.is_outline = true;
    metadata.chapters_touched = touched;
  }

  const charactersBlock = extractMarkedBlock(content, CHARACTERS_BLOCK_RE);
  if (charactersBlock) content = charactersBlock.stripped;
  const characters = uniqueCharacters([
    ...parseCharacterLines(charactersBlock?.inner ?? ''),
    ...inferCharactersFromText(charactersBlock?.inner || content),
  ]);
  const shouldSaveCharacters =
    characters.length > 0 &&
    (Boolean(charactersBlock) ||
      userAskedForCharacters(input.userContent) ||
      artifacts.outlineSaved);
  if (shouldSaveCharacters) {
    artifacts.charactersSaved = await upsertCharacters(
      input.prisma,
      input.userId,
      input.projectId,
      characters,
    );
    if (artifacts.charactersSaved > 0) {
      metadata.is_characters = true;
      metadata.characters_count = artifacts.charactersSaved;
      if (!artifacts.focusTab) artifacts.focusTab = 'characters';
    }
  }

  const seedBlock = extractMarkedBlock(content, CHAPTER_SEED_BLOCK_RE);
  let parsedSeed: ParsedChapterSeed | null = null;
  if (seedBlock) {
    content = seedBlock.stripped;
    parsedSeed = parseChapterSeed(seedBlock.inner);
    if (!parsedSeed) {
      content = `${content}\n\n⚠️ 章节种子缺少有效章节号，未保存。`.trim();
    } else {
      await ensureChapterWithSeed(
        input.prisma,
        input.userId,
        input.projectId,
        parsedSeed.chapterNumber,
        parsedSeed,
      );
      artifacts.chaptersTouched = uniqueNumbers([
        ...artifacts.chaptersTouched,
        parsedSeed.chapterNumber,
      ]);
      metadata.is_chapter_seed = true;
      metadata.chapter_number = parsedSeed.chapterNumber;
      artifacts.focusTab = 'seed';
    }
  }

  content = stripGenerateChapterMarker(content);
  const chapterNumber = inferGenerateChapterNumber(input.userContent, input.content);
  if (chapterNumber !== null) {
    try {
      const seed =
        parsedSeed?.chapterNumber === chapterNumber
          ? parsedSeed
          : seedFromOutline(outlineChapters, chapterNumber) ?? {
              chapterNumber,
              intent: input.userContent.slice(0, 200) || `撰写第${chapterNumber}章`,
              mustInclude: '',
              forbiddenFacts: '',
              characterMotives: '',
              promises: '',
              endingGoal: `完成第${chapterNumber}章`,
            };
      const chapter = await ensureChapterWithSeed(
        input.prisma,
        input.userId,
        input.projectId,
        chapterNumber,
        seed ?? undefined,
      );
      artifacts.chaptersTouched = uniqueNumbers([
        ...artifacts.chaptersTouched,
        chapterNumber,
      ]);
      const job = (await input.jobs.submitChapterGeneration(
        input.userId,
        input.projectId,
        chapter.id,
      )) as { jobId?: unknown };
      if (typeof job.jobId === 'string' && job.jobId) {
        metadata.is_chapter = 'pending';
        metadata.chapter_number = chapterNumber;
        metadata.chapter_job_id = job.jobId;
        artifacts.generationJobId = job.jobId;
        artifacts.focusTab = 'chapter';
        content = `${content}\n\n已提交第${chapterNumber}章生成任务。章节正文由系统内置生成流程撰写，不会使用聊天稿。请在上方任务面板查看进度。`.trim();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`assistant chapter generate dispatch failed: ${message}`);
      content = `${content}\n\n⚠️ 第${chapterNumber}章未能开始生成：${message}`.trim();
    }
  }

  if (artifacts.outlineSaved) {
    content = `${content}\n\n已写入「大纲」板块。`.trim();
  }
  if (artifacts.charactersSaved > 0) {
    content = `${content}\n\n已写入「角色」板块 ${artifacts.charactersSaved} 人。`.trim();
  }

  return {
    content,
    metadata: { ...metadata, artifacts },
    artifacts,
    generationJobId: artifacts.generationJobId,
  };
}

function seedFromOutline(
  chapters: OutlineChapter[],
  chapterNumber: number,
): ParsedChapterSeed | null {
  const found = chapters.find((item) => item.chapterNumber === chapterNumber);
  if (!found) return null;
  const summary = found.summary || found.title;
  return {
    chapterNumber,
    intent: summary,
    mustInclude: summary,
    forbiddenFacts: '',
    characterMotives: '',
    promises: '',
    endingGoal: `完成第${chapterNumber}章「${found.title}」的既定情节`,
  };
}

async function upsertStoryOutline(
  prisma: PrismaService,
  userId: number,
  projectId: number,
  content: string,
): Promise<void> {
  const existing = await prisma.novelDocument.findFirst({
    where: { projectId, userId, documentType: 'story_outline', deletedAt: null },
  });
  if (!existing) {
    const created = await prisma.novelDocument.create({
      data: {
        projectId,
        userId,
        documentType: 'story_outline',
        title: '故事大纲',
        content,
        currentVersion: 1,
      },
    });
    await prisma.novelDocumentVersion.create({
      data: {
        documentId: created.id,
        createdBy: userId,
        versionNumber: 1,
        content,
        changeSummary: '助手生成大纲',
      },
    });
  } else {
    const nextVersion = existing.currentVersion + 1;
    await prisma.novelDocument.update({
      where: { id: existing.id },
      data: { content, currentVersion: nextVersion },
    });
    await prisma.novelDocumentVersion.create({
      data: {
        documentId: existing.id,
        createdBy: userId,
        versionNumber: nextVersion,
        content,
        changeSummary: '助手更新大纲',
      },
    });
  }
  await prisma.novelProject.update({
    where: { id: projectId },
    data: { workflowState: 'outline_draft', lastActiveAt: new Date() },
  });
}

async function replaceOutlineNodes(
  prisma: PrismaService,
  userId: number,
  projectId: number,
  markdown: string,
  chapters: OutlineChapter[],
): Promise<void> {
  await prisma.novelOutlineNode.updateMany({
    where: { projectId, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  const volumeTitles = [...new Set(chapters.map((item) => item.volumeTitle).filter(Boolean))] as string[];
  const volumeIds = new Map<string, number>();
  for (const [index, title] of volumeTitles.entries()) {
    const volume = await prisma.novelOutlineNode.create({
      data: {
        projectId,
        userId,
        nodeType: 'volume',
        title,
        summary: '',
        sortOrder: index,
      },
    });
    volumeIds.set(title, volume.id);
  }
  if (chapters.length === 0) {
    await prisma.novelOutlineNode.create({
      data: {
        projectId,
        userId,
        nodeType: 'document',
        title: '故事大纲',
        summary: markdown.slice(0, 500),
        sortOrder: 0,
      },
    });
    return;
  }
  for (const [index, chapter] of chapters.entries()) {
    await prisma.novelOutlineNode.create({
      data: {
        projectId,
        userId,
        parentId: chapter.volumeTitle ? volumeIds.get(chapter.volumeTitle) ?? null : null,
        nodeType: 'chapter',
        title: `第${chapter.chapterNumber}章 ${chapter.title}`.trim(),
        summary: chapter.summary,
        sortOrder: index,
      },
    });
  }
}

async function ensureChapterShells(
  prisma: PrismaService,
  userId: number,
  projectId: number,
  chapters: OutlineChapter[],
): Promise<number[]> {
  const touched: number[] = [];
  for (const item of chapters) {
    await ensureChapterWithSeed(prisma, userId, projectId, item.chapterNumber, {
      chapterNumber: item.chapterNumber,
      intent: item.summary || item.title,
      mustInclude: item.summary,
      forbiddenFacts: '',
      characterMotives: '',
      promises: '',
      endingGoal: `完成第${item.chapterNumber}章「${item.title}」的既定情节`,
    }, item.title);
    touched.push(item.chapterNumber);
  }
  return touched;
}

async function upsertCharacters(
  prisma: PrismaService,
  userId: number,
  projectId: number,
  characters: ParsedCharacter[],
): Promise<number> {
  if (characters.length === 0) return 0;
  const existing = await prisma.novelCharacter.findMany({
    where: { projectId, userId, deletedAt: null },
    select: { id: true, name: true },
  });
  const byName = new Map(existing.map((row) => [row.name, row.id]));
  let saved = 0;
  for (const character of characters) {
    const id = byName.get(character.name);
    if (id) {
      await prisma.novelCharacter.update({
        where: { id },
        data: {
          roleType: character.roleType,
          identity: character.description,
          personality: character.description,
        },
      });
    } else {
      await prisma.novelCharacter.create({
        data: {
          projectId,
          userId,
          name: character.name,
          roleType: character.roleType,
          identity: character.description,
          personality: character.description,
        },
      });
    }
    saved += 1;
  }
  return saved;
}

async function ensureChapterWithSeed(
  prisma: PrismaService,
  userId: number,
  projectId: number,
  chapterNumber: number,
  seed?: ParsedChapterSeed,
  title?: string,
): Promise<{ id: number }> {
  let chapter = await prisma.novelChapter.findFirst({
    where: { projectId, userId, chapterNumber, deletedAt: null },
    include: { seed: true },
  });
  if (!chapter) {
    chapter = await prisma.novelChapter.create({
      data: {
        projectId,
        userId,
        chapterNumber,
        title: title ? `第${chapterNumber}章 ${title}` : `第${chapterNumber}章`,
        seed: { create: { projectId, userId } },
      },
      include: { seed: true },
    });
  } else {
    if (title && !chapter.content.trim()) {
      await prisma.novelChapter.update({
        where: { id: chapter.id },
        data: { title: `第${chapterNumber}章 ${title}` },
      });
    }
    if (!chapter.seed) {
      await prisma.novelChapterSeed.create({
        data: { chapterId: chapter.id, projectId, userId },
      });
      chapter = await prisma.novelChapter.findFirstOrThrow({
        where: { id: chapter.id },
        include: { seed: true },
      });
    }
  }
  if (seed && chapter.seed) {
    const nextIntent = seed.intent.trim() || chapter.seed.intent;
    const nextEnding = seed.endingGoal.trim() || chapter.seed.endingGoal;
    await prisma.novelChapterSeed.update({
      where: { id: chapter.seed.id },
      data: {
        intent: nextIntent,
        mustInclude: seed.mustInclude || chapter.seed.mustInclude,
        forbiddenFacts: seed.forbiddenFacts || chapter.seed.forbiddenFacts,
        characterMotives: seed.characterMotives || chapter.seed.characterMotives,
        promises: seed.promises || chapter.seed.promises,
        endingGoal: nextEnding,
        status: nextIntent && nextEnding ? 'ready' : 'draft',
        version: { increment: 1 },
      },
    });
  }
  return { id: chapter.id };
}

function uniqueCharacters(characters: ParsedCharacter[]): ParsedCharacter[] {
  const byName = new Map<string, ParsedCharacter>();
  for (const character of characters) {
    byName.set(character.name, character);
  }
  return [...byName.values()];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}
