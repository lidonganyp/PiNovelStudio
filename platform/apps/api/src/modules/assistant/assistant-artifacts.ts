/**
 * 将助手产出落入项目板块：大纲文档/大纲树/角色/章节种子。
 * 章节正文只调度统一生成链路，绝不把聊天稿写成章节。
 */
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { JobsService } from '../jobs/jobs.service';
import { assertArtifactAllowed } from '../context/assistant-contract';
import { FAILURE_CODES, FailureHttpException, makeFailure } from '../context/failure-envelope';
import { isUsableStoryOutline } from '../jobs/book-context';
import type { AssistantAction, ContinuationMode, TargetWordRange } from '../context/types';
import {
  looksLikeOutline,
  parseOutlineChapters,
  type OutlineChapter,
  type ParsedCharacter,
  type ParsedChapterSeed,
} from './assistant-markers';
import type { PlannerEnvelope } from './planner-envelope';

const logger = new Logger('AssistantArtifacts');

export interface AssistantArtifactsView {
  outlineSaved: boolean;
  charactersSaved: number;
  chaptersTouched: number[];
  generationJobId?: string;
  focusTab?: 'outline' | 'characters' | 'chapter' | 'seed';
  publicEntry?: 'novel_generate_chapter';
  records: Array<{ type: 'story_outline' | 'chapter_seed' | 'query_answer'; saved: boolean; id?: number }>;
}

export interface AssistantArtifactResult {
  content: string;
  metadata: Record<string, unknown>;
  artifacts: AssistantArtifactsView;
  generationJobId?: string;
}

export interface ConfirmedMaterialProposal {
  field: string;
  value: string;
  source: string[];
  requiresConfirmation: boolean;
}

/** 用户确认后写入作者资料与 ChapterSeed；绝不写入最终章节正文。 */
export async function saveConfirmedAuthorMaterials(input: {
  prisma: PrismaService;
  userId: number;
  projectId: number;
  chapterNumber: number;
  confirmed: Set<string>;
  proposals: ConfirmedMaterialProposal[];
}): Promise<{ chapterId?: number }> {
  for (const item of input.proposals) {
    if (!item.value.trim()) continue;
    if (item.requiresConfirmation && !input.confirmed.has(item.field)) continue;
    if (!item.requiresConfirmation && !input.confirmed.has(item.field) && item.field !== 'chapter_seed') {
      continue;
    }
    if (item.field === 'genre') {
      await input.prisma.novelProject.update({
        where: { id: input.projectId },
        data: { genre: item.value, version: { increment: 1 }, lastActiveAt: new Date() },
      });
      continue;
    }
    if (item.field === 'worldbuilding' || item.field === 'creative_constitution' || item.field === 'style_profile') {
      await upsertTypedDocument(
        input.prisma,
        input.userId,
        input.projectId,
        item.field,
        titleOf(item.field),
        item.value,
        '用户确认后写入',
      );
      continue;
    }
    if (item.field === 'character_states') {
      await applyCharacterNotes(input.prisma, input.userId, input.projectId, item.value);
      continue;
    }
    if (item.field === 'canon_state' || item.field === 'promise_ledger') {
      await upsertNarrativeList(
        input.prisma,
        input.userId,
        input.projectId,
        item.field,
        item.value,
      );
    }
  }
  const seedProposal = input.proposals.find((row) => row.field === 'chapter_seed');
  const canWriteSeed = Boolean(
    seedProposal?.value.trim()
    && (input.confirmed.has('chapter_seed') || seedProposal?.requiresConfirmation === false),
  );
  if (!canWriteSeed) {
    const existing = await input.prisma.novelChapter.findFirst({
      where: {
        projectId: input.projectId,
        userId: input.userId,
        chapterNumber: input.chapterNumber,
        deletedAt: null,
      },
      select: { id: true },
    });
    return { chapterId: existing?.id };
  }
  const chapter = await upsertChapterSeedFromProposal(
    input.prisma,
    input.userId,
    input.projectId,
    input.chapterNumber,
    seedProposal?.value ?? '',
  );
  return { chapterId: chapter.id };
}

export async function applyAssistantArtifacts(input: {
  prisma: PrismaService;
  jobs: JobsService;
  userId: number;
  projectId: number;
  content?: string;
  userContent: string;
  action: AssistantAction;
  chapterNumber?: number;
  confirmGeneration?: boolean;
  continuationMode?: ContinuationMode;
  targetWordCount?: TargetWordRange;
  envelope: PlannerEnvelope;
}): Promise<AssistantArtifactResult> {
  let content = input.envelope.reply;
  const metadata: Record<string, unknown> = {};
  const artifacts: AssistantArtifactsView = {
    outlineSaved: false,
    charactersSaved: 0,
    chaptersTouched: [],
    records: [],
  };
  const outlineMarkdown = input.envelope.storyOutline?.trim() ?? '';
  const characters = uniqueCharacters(input.envelope.characters ?? []);
  const parsedSeed: ParsedChapterSeed | null = input.envelope.chapterSeed
    ? {
        chapterNumber: input.chapterNumber ?? input.envelope.chapterSeed.chapterNumber ?? 0,
        intent: input.envelope.chapterSeed.intent,
        mustInclude: input.envelope.chapterSeed.mustInclude,
        forbiddenFacts: input.envelope.chapterSeed.forbiddenFacts,
        characterMotives: input.envelope.chapterSeed.characterMotives,
        promises: input.envelope.chapterSeed.promises,
        endingGoal: input.envelope.chapterSeed.endingGoal,
      }
    : null;
  if (parsedSeed && parsedSeed.chapterNumber < 1) {
    throw new FailureHttpException(makeFailure({
      stage: 'assistant.action',
      gate: 'request_schema',
      code: FAILURE_CODES.missingChapterNumber,
      severity: 'preflight',
      reason: '章节规划或正文生成必须指定章节号',
      recoverable: false,
    }));
  }

  if (input.action === 'plan_story_outline') {
    if (outlineMarkdown && looksLikeOutline(outlineMarkdown) && isUsableStoryOutline(outlineMarkdown)) {
      assertArtifactAllowed(input.action, 'story_outline');
      try {
        await upsertStoryOutline(input.prisma, input.userId, input.projectId, outlineMarkdown);
        const outlineChapters = parseOutlineChapters(outlineMarkdown);
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
        artifacts.records.push({ type: 'story_outline', saved: true });
        metadata.is_outline = true;
        metadata.chapters_touched = touched;
      } catch (error: unknown) {
        if (error instanceof FailureHttpException) throw error;
        logger.warn(`story outline save failed: ${error instanceof Error ? error.message : String(error)}`);
        throw new FailureHttpException(makeFailure({
          stage: 'assistant.artifact',
          gate: 'story_outline',
          code: FAILURE_CODES.artifactSaveFailed,
          severity: 'recoverable',
          reason: '全书大纲保存失败，请稍后重试',
          recoverable: true,
          retryPlan: 'retry_same_stage',
        }));
      }
    }
    if (characters.length > 0) {
      artifacts.charactersSaved = await upsertCharacters(
        input.prisma,
        input.userId,
        input.projectId,
        characters,
      );
      if (artifacts.charactersSaved > 0) {
        metadata.is_characters = true;
        metadata.characters_count = artifacts.charactersSaved;
      }
    }
  }

  if (input.action === 'plan_chapter' || input.action === 'generate_chapter') {
    const chapterNumber = input.chapterNumber;
    if (!chapterNumber) {
      throw new FailureHttpException(makeFailure({
        stage: 'assistant.action',
        gate: 'request_schema',
        code: FAILURE_CODES.missingChapterNumber,
        severity: 'preflight',
        reason: '章节规划或正文生成必须指定章节号',
        recoverable: false,
      }));
    }
    if (parsedSeed) {
      assertArtifactAllowed(input.action, 'chapter_seed');
      const seed = { ...parsedSeed, chapterNumber };
      await ensureChapterWithSeed(
        input.prisma,
        input.userId,
        input.projectId,
        chapterNumber,
        seed,
      );
      artifacts.chaptersTouched = uniqueNumbers([...artifacts.chaptersTouched, chapterNumber]);
      artifacts.records.push({ type: 'chapter_seed', saved: true });
      metadata.is_chapter_seed = true;
      metadata.chapter_number = chapterNumber;
      artifacts.focusTab = 'seed';
    }
  }

  if (input.action === 'generate_chapter') {
    if (input.confirmGeneration !== true) {
      throw new FailureHttpException(makeFailure({
        stage: 'assistant.generate',
        gate: 'confirm',
        code: FAILURE_CODES.generationUnconfirmed,
        severity: 'preflight',
        reason: '生成正文需要明确确认',
        recoverable: false,
      }));
    }
    const chapterNumber = input.chapterNumber as number;
    try {
      const chapter = await ensureChapterWithSeed(
        input.prisma,
        input.userId,
        input.projectId,
        chapterNumber,
        parsedSeed ? { ...parsedSeed, chapterNumber } : undefined,
      );
      const job = (await input.jobs.submitChapterGeneration(
        input.userId,
        input.projectId,
        chapter.id,
        {
          continuationMode: input.continuationMode,
          targetWordCount: input.targetWordCount,
        },
      )) as { jobId?: unknown };
      if (typeof job.jobId === 'string' && job.jobId) {
        metadata.is_chapter = 'pending';
        metadata.chapter_number = chapterNumber;
        metadata.chapter_job_id = job.jobId;
        artifacts.generationJobId = job.jobId;
        artifacts.publicEntry = 'novel_generate_chapter';
        artifacts.focusTab = 'chapter';
        artifacts.chaptersTouched = uniqueNumbers([...artifacts.chaptersTouched, chapterNumber]);
        content = `${content}\n\n已提交第${chapterNumber}章生成任务。章节正文由 novel_generate_chapter 统一链路撰写，不会使用聊天稿。请在上方任务面板查看进度。`.trim();
      }
    } catch (error: unknown) {
      if (error instanceof FailureHttpException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`assistant chapter generate dispatch failed: ${message}`);
      throw new FailureHttpException(makeFailure({
        stage: 'jobs.submit',
        gate: 'submit_chapter_generation',
        code: FAILURE_CODES.jobSubmitFailed,
        severity: 'recoverable',
        reason: '章节任务提交失败，请稍后重试或先补章节种子',
        recoverable: true,
        retryPlan: 'retry_same_stage',
      }));
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
    await ensureChapterWithSeed(
      prisma,
      userId,
      projectId,
      item.chapterNumber,
      undefined,
      item.title,
    );
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
          version: { increment: 1 },
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
        mustInclude: seed.mustInclude,
        forbiddenFacts: seed.forbiddenFacts,
        characterMotives: seed.characterMotives,
        promises: seed.promises,
        endingGoal: nextEnding,
        status: nextIntent && nextEnding ? 'ready' : 'draft',
        version: { increment: 1 },
      },
    });
  }
  return { id: chapter.id };
}

async function upsertTypedDocument(
  prisma: PrismaService,
  userId: number,
  projectId: number,
  documentType: string,
  title: string,
  content: string,
  changeSummary: string,
): Promise<void> {
  const existing = await prisma.novelDocument.findFirst({
    where: { projectId, userId, documentType, deletedAt: null },
  });
  if (existing?.content.trim()) {
    return;
  }
  if (!existing) {
    const created = await prisma.novelDocument.create({
      data: { projectId, userId, documentType, title, content, currentVersion: 1 },
    });
    await prisma.novelDocumentVersion.create({
      data: {
        documentId: created.id,
        createdBy: userId,
        versionNumber: 1,
        content,
        changeSummary,
      },
    });
    return;
  }
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
      changeSummary,
    },
  });
}

async function upsertNarrativeList(
  prisma: PrismaService,
  userId: number,
  projectId: number,
  field: 'canon_state' | 'promise_ledger',
  raw: string,
): Promise<void> {
  const existing = await prisma.novelDocument.findFirst({
    where: { projectId, userId, documentType: 'narrative_state', deletedAt: null },
  });
  let store: Record<string, unknown> = {};
  if (existing?.content.trim()) {
    try {
      const parsed = JSON.parse(existing.content) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        store = parsed as Record<string, unknown>;
      }
    } catch {
      store = {};
    }
  }
  const values = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (field === 'canon_state') {
    store.canon = values.map((fact) => ({ fact }));
  } else {
    store.promise = values.map((description) => ({ description, status: 'open' }));
  }
  const content = JSON.stringify(store);
  if (!existing) {
    const created = await prisma.novelDocument.create({
      data: { projectId, userId, documentType: 'narrative_state', title: 'Narrative State', content, currentVersion: 1 },
    });
    await prisma.novelDocumentVersion.create({
      data: { documentId: created.id, createdBy: userId, versionNumber: 1, content, changeSummary: 'Confirmed narrative state' },
    });
    return;
  }
  const nextVersion = existing.currentVersion + 1;
  await prisma.novelDocument.update({
    where: { id: existing.id },
    data: { content, currentVersion: nextVersion },
  });
  await prisma.novelDocumentVersion.create({
    data: { documentId: existing.id, createdBy: userId, versionNumber: nextVersion, content, changeSummary: 'Confirmed narrative state' },
  });
}

async function applyCharacterNotes(
  prisma: PrismaService,
  userId: number,
  projectId: number,
  raw: string,
): Promise<void> {
  for (const line of raw.split('\n')) {
    const [name, goals, motivation, currentState] = line.split('|');
    if (!name?.trim()) continue;
    const existing = await prisma.novelCharacter.findFirst({
      where: { projectId, userId, name: name.trim(), deletedAt: null },
    });
    if (!existing) continue;
    await prisma.novelCharacter.update({
      where: { id: existing.id },
      data: {
        goals: goals?.trim() || existing.goals,
        motivation: motivation?.trim() || existing.motivation,
        currentState: currentState?.trim() || existing.currentState,
        version: { increment: 1 },
      },
    });
  }
}

async function upsertChapterSeedFromProposal(
  prisma: PrismaService,
  userId: number,
  projectId: number,
  chapterNumber: number,
  raw: string,
): Promise<{ id: number }> {
  let parsed: ParsedChapterSeed = {
    chapterNumber,
    intent: '',
    mustInclude: '',
    forbiddenFacts: '',
    characterMotives: '',
    promises: '',
    endingGoal: '',
  };
  try {
    const json = JSON.parse(raw) as Partial<ParsedChapterSeed>;
    parsed = {
      chapterNumber,
      intent: json.intent ?? '',
      mustInclude: json.mustInclude ?? '',
      forbiddenFacts: json.forbiddenFacts ?? '',
      characterMotives: json.characterMotives ?? '',
      promises: json.promises ?? '',
      endingGoal: json.endingGoal ?? '',
    };
  } catch {
    parsed = {
      ...parsed,
      intent: raw,
      endingGoal: '留下可续写的章末压力',
    };
  }
  return ensureChapterWithSeed(prisma, userId, projectId, chapterNumber, parsed);
}

function titleOf(field: string): string {
  if (field === 'worldbuilding') return '世界观';
  if (field === 'creative_constitution') return '创作宪法';
  if (field === 'style_profile') return '风格档案';
  return field;
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
