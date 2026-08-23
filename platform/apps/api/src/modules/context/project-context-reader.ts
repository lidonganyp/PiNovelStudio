/**
 * 当前用户项目范围内的完整读取器。
 * 章节正文只保留摘要和续接片段，禁止把整章无条件交给模型。
 */
import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  compactNarrativeStateJson,
  excerptLastSentences,
  isUsableStoryOutline,
  type CompactNarrativeState,
} from '../jobs/book-context';
import { findStateHashMismatch, hashChapterText } from './context-compiler';

const EXCERPT_CHARS = 280;
const TAIL_CHARS = 160;

export interface ProjectContextRecords {
  userId: number;
  project: {
    id: number;
    userId: number;
    title: string;
    description: string;
    genre: string;
    subGenres: unknown;
    worldKeyTerms: unknown;
    version: number;
    deletedAt?: Date | null;
  } | null;
  documents: Array<{
    id: number;
    documentType: string;
    content: string;
    currentVersion: number;
    updatedAt: Date;
    deletedAt?: Date | null;
  }>;
  characters: Array<{
    id: number;
    name: string;
    roleType: string;
    identity: string;
    goals: string;
    motivation: string;
    currentState: string;
    relationships: string;
    secrets: string;
    characterArc: string;
    version: number;
  }>;
  outlineNodes: Array<{
    title: string;
    summary: string;
    nodeType: string;
    narrativeGoal: string;
    version: number;
  }>;
  chapters: Array<{
    chapterNumber: number;
    title: string;
    content: string;
    wordCount: number;
    version: number;
    seed?: {
      intent: string;
      mustInclude: string;
      forbiddenFacts: string;
      characterMotives: string;
      promises: string;
      endingGoal: string;
      version: number;
    } | null;
  }>;
  chapterVersions?: Array<{
    id: number;
    chapterId: number;
    chapterNumber: number;
    versionNumber: number;
    content: string;
    tailExcerpt: string;
    source: string;
    generationJobId?: string | null;
    createdAt: Date;
  }>;
  feedback?: Array<{
    id: number;
    chapterId?: number | null;
    chapterNumber?: number | null;
    type: string;
    content: string;
    createdAt: Date;
  }>;
  assistantHistory?: Array<{
    id: number;
    role: string;
    content: string;
    createdAt: Date;
  }>;
  generationJobs?: Array<{
    jobId: string;
    chapterId?: number | null;
    chapterNumber?: number | null;
    status: string;
    progressStage: string;
    failureMessage?: string | null;
    completedAt?: Date | null;
  }>;
}

export interface ProjectDocumentView {
  id: number;
  documentType: string;
  content: string;
  currentVersion: number;
  updatedAt: string;
  authorConfirmed: boolean;
}

export interface ProjectContextSnapshot {
  projectId: number;
  userId: number;
  sourceVersion: string;
  project: {
    title: string;
    description: string;
    genre: string;
    subGenres: string[];
    worldKeyTerms: string[];
    version: number;
  };
  outline?: { id: number; content: string; currentVersion: number; usable: boolean };
  outlineNodes: ProjectContextRecords['outlineNodes'];
  characters: ProjectContextRecords['characters'];
  documents: ProjectDocumentView[];
  chapters: Array<{
    chapterNumber: number;
    title: string;
    wordCount: number;
    version: number;
    excerpt: string;
    tailExcerpt: string;
    contentHash: string;
    seed?: {
      intent: string;
      mustInclude: string;
      forbiddenFacts: string;
      characterMotives: string;
      promises: string;
      endingGoal: string;
      version: number;
    };
  }>;
  chapterVersions: Array<NonNullable<ProjectContextRecords['chapterVersions']>[number] & { tailExcerpt: string }>;
  feedback: NonNullable<ProjectContextRecords['feedback']>;
  assistantHistory: NonNullable<ProjectContextRecords['assistantHistory']>;
  generationJobs: NonNullable<ProjectContextRecords['generationJobs']>;
  narrativeCompact: CompactNarrativeState;
  previousContinuation?: {
    chapterNumber: number;
    tailExcerpt: string;
    sourceChapterHash: string;
  };
  hashMismatch?: { expected: string; actual: string; chapterNumber: number };
}

export function compileProjectContextSnapshot(records: ProjectContextRecords): ProjectContextSnapshot {
  if (!records.project || records.project.deletedAt || records.project.userId !== records.userId) {
    throw new NotFoundException('项目不存在');
  }
  const project = records.project;
  const byType = new Map(records.documents.filter((row) => !row.deletedAt).map((row) => [row.documentType, row]));
  const outline = byType.get('story_outline');
  const narrative = byType.get('narrative_state');
  const compact = narrative
    ? compactNarrativeStateJson(narrative.content).compact
    : { canon: [], character: [], promise: [] };
  const chapters = records.chapters
    .slice()
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
    .map((chapter) => {
      const trimmed = chapter.content.replace(/^\uFEFF/, '').trim();
      return {
        chapterNumber: chapter.chapterNumber,
        title: chapter.title,
        wordCount: chapter.wordCount,
        version: chapter.version,
        excerpt: trimmed.slice(0, EXCERPT_CHARS),
        tailExcerpt: excerptLastSentences(trimmed, TAIL_CHARS),
        contentHash: trimmed ? hashChapterText(trimmed) : '',
        seed: chapter.seed
          ? {
              intent: chapter.seed.intent,
              mustInclude: chapter.seed.mustInclude,
              forbiddenFacts: chapter.seed.forbiddenFacts,
              characterMotives: chapter.seed.characterMotives,
              promises: chapter.seed.promises,
              endingGoal: chapter.seed.endingGoal,
              version: chapter.seed.version,
            }
          : undefined,
      };
    });
  const lastChapter = chapters.at(-1);
  const previous = lastChapter && lastChapter.tailExcerpt
    ? {
        chapterNumber: lastChapter.chapterNumber,
        tailExcerpt: lastChapter.tailExcerpt,
        sourceChapterHash: lastChapter.contentHash,
      }
    : undefined;
  const previousFull = records.chapters.find((row) => row.chapterNumber === previous?.chapterNumber);
  const mismatch = previousFull
    ? findStateHashMismatch(narrative?.content, {
        chapterNumber: previousFull.chapterNumber,
        content: previousFull.content,
      })
    : null;
  const documents: ProjectDocumentView[] = records.documents
    .filter((row) => !row.deletedAt)
    .map((row) => ({
      id: row.id,
      documentType: row.documentType,
      content: row.content,
      currentVersion: row.currentVersion,
      updatedAt: row.updatedAt.toISOString(),
      authorConfirmed: row.content.trim().length > 0 && row.documentType !== 'material_proposal',
    }));
  const snapshot: ProjectContextSnapshot = {
    projectId: project.id,
    userId: records.userId,
    sourceVersion: '',
    project: {
      title: project.title,
      description: project.description,
      genre: project.genre,
      subGenres: readStringArray(project.subGenres),
      worldKeyTerms: readStringArray(project.worldKeyTerms),
      version: project.version,
    },
    outline: outline
      ? {
          id: outline.id,
          content: outline.content,
          currentVersion: outline.currentVersion,
          usable: isUsableStoryOutline(outline.content),
        }
      : undefined,
    outlineNodes: records.outlineNodes,
    characters: records.characters,
    documents,
    chapters,
    chapterVersions: (records.chapterVersions ?? []).map((row) => {
      const trimmed = row.content.replace(/^\uFEFF/, '').trim();
      return {
        ...row,
        content: trimmed.slice(0, EXCERPT_CHARS),
        tailExcerpt: excerptLastSentences(trimmed, TAIL_CHARS),
      };
    }),
    feedback: records.feedback ?? [],
    assistantHistory: records.assistantHistory ?? [],
    generationJobs: records.generationJobs ?? [],
    narrativeCompact: compact,
    previousContinuation: previous,
    hashMismatch: mismatch
      ? { ...mismatch, chapterNumber: previousFull?.chapterNumber ?? 0 }
      : undefined,
  };
  snapshot.sourceVersion = computeSourceVersion(snapshot);
  return snapshot;
}

export function computeSourceVersion(snapshot: Omit<ProjectContextSnapshot, 'sourceVersion'> & { sourceVersion?: string }): string {
  const payload = {
    project: snapshot.project.version,
    docs: snapshot.documents
      .filter((row) => row.documentType !== 'material_proposal')
      .map((row) => `${row.documentType}:${row.currentVersion}`),
    characters: snapshot.characters.map((row) => `${row.id}:${row.version}`),
    outlineNodes: snapshot.outlineNodes.map((row) => `${row.title}:${row.version}`),
    chapters: snapshot.chapters.map((row) => `${row.chapterNumber}:${row.version}:${row.seed?.version ?? 0}`),
    chapterVersions: snapshot.chapterVersions.map((row) => `${row.id}:${row.versionNumber}:${row.createdAt.toISOString()}`),
    feedback: snapshot.feedback.map((row) => `${row.id}:${row.createdAt.toISOString()}`),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

export async function loadOwnedProjectContext(
  prisma: PrismaService,
  userId: number,
  projectId: number,
): Promise<ProjectContextSnapshot> {
  const [project, documents, characters, outlineNodes, chapters, chapterVersions, feedback, assistantHistory, generationJobs] = await Promise.all([
    prisma.novelProject.findFirst({
      where: { id: projectId, userId, deletedAt: null },
    }),
    prisma.novelDocument.findMany({
      where: { projectId, userId, deletedAt: null },
    }),
    prisma.novelCharacter.findMany({
      where: { projectId, userId, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.novelOutlineNode.findMany({
      where: { projectId, userId, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.novelChapter.findMany({
      where: { projectId, userId, deletedAt: null },
      include: { seed: true },
      orderBy: { chapterNumber: 'asc' },
    }),
    findOptionalMany<ChapterVersionRow>(prisma, 'novelChapterVersion', {
      where: { projectId, userId },
      include: { chapter: { select: { chapterNumber: true } } },
      orderBy: [{ chapterId: 'asc' }, { versionNumber: 'asc' }],
    }),
    findOptionalMany<FeedbackRow>(prisma, 'novelFeedback', {
      where: { projectId, userId },
      include: { chapter: { select: { chapterNumber: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    findOptionalMany<AssistantHistoryRow>(prisma, 'novelAssistantMessage', {
      where: { projectId, userId, deletedAt: null },
      select: { id: true, role: true, content: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    findOptionalMany<GenerationJobRow>(prisma, 'novelGenerationJob', {
      where: { projectId, userId },
      include: { chapter: { select: { chapterNumber: true } } },
      orderBy: { startedAt: 'asc' },
    }),
  ]);
  return compileProjectContextSnapshot({
    userId,
    project,
    documents,
    characters,
    outlineNodes,
    chapters,
    chapterVersions: chapterVersions.map((row) => ({
      ...(() => {
        const trimmed = row.content.replace(/^\uFEFF/, '').trim();
        return {
          content: trimmed.slice(0, EXCERPT_CHARS),
          tailExcerpt: excerptLastSentences(trimmed, TAIL_CHARS),
        };
      })(),
      id: row.id,
      chapterId: row.chapterId,
      chapterNumber: row.chapter?.chapterNumber
        ?? (row as unknown as { chapterNumber?: number }).chapterNumber
        ?? 0,
      versionNumber: row.versionNumber,
      source: row.source,
      generationJobId: row.generationJobId,
      createdAt: row.createdAt,
    })),
    feedback: feedback.map((row) => ({
      id: row.id,
      chapterId: row.chapterId,
      chapterNumber: row.chapter?.chapterNumber ?? null,
      type: row.type,
      content: row.content,
      createdAt: row.createdAt,
    })),
    assistantHistory,
    generationJobs: generationJobs.map((row) => ({
      jobId: row.jobId,
      chapterId: row.chapterId,
      chapterNumber: row.chapter?.chapterNumber ?? null,
      status: row.status,
      progressStage: row.progressStage,
      failureMessage: row.failureMessage,
      completedAt: row.completedAt,
    })),
  });
}

type OptionalFindManyDelegate = {
  findMany?: (args: unknown) => Promise<unknown>;
};

type ChapterVersionRow = NonNullable<ProjectContextRecords['chapterVersions']>[number]
  & { chapter?: { chapterNumber: number } | null };
type FeedbackRow = NonNullable<ProjectContextRecords['feedback']>[number]
  & { chapter?: { chapterNumber: number } | null };
type AssistantHistoryRow = NonNullable<ProjectContextRecords['assistantHistory']>[number];
type GenerationJobRow = NonNullable<ProjectContextRecords['generationJobs']>[number]
  & { chapter?: { chapterNumber: number } | null };

async function findOptionalMany<T>(
  prisma: PrismaService,
  model: string,
  args: unknown,
): Promise<T[]> {
  const delegate = (prisma as unknown as Record<string, unknown>)[model] as OptionalFindManyDelegate | undefined;
  if (!delegate || typeof delegate.findMany !== 'function') return [];
  const rows = await delegate.findMany(args);
  return Array.isArray(rows) ? rows as T[] : [];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
