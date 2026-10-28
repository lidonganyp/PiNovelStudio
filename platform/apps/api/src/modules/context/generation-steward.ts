/**
 * 生成管家：缺资料走补齐/确认，不抛普通预检错误；确认后才写作者资料并提交统一生成。
 */
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { JobsService } from '../jobs/jobs.service';
import { FAILURE_CODES, FailureHttpException, makeFailure } from './failure-envelope';
import {
  classifyMaterialReadiness,
  type MaterialProposal,
  type MaterialReadiness,
} from './material-readiness';
import { saveConfirmedAuthorMaterials } from '../assistant/assistant-artifacts';
import {
  loadOwnedProjectContext,
} from './project-context-reader';
import { reanchorNarrativeStateToChapter } from './context-compiler';
import type { ContinuationMode, TargetWordRange } from './types';

export const STEWARD_ACTIONS = ['apply_and_generate', 'save_draft', 'cancel', 'revise'] as const;
export type StewardAction = (typeof STEWARD_ACTIONS)[number];
export type ConfirmStewardAction = Exclude<StewardAction, 'revise'>;

export type ProposalStatus = 'pending' | 'applied' | 'cancelled' | 'draft_saved';

export interface StewardResult {
  status: MaterialReadiness['status'];
  reply: string;
  chapterNumber: number;
  proposalId?: string;
  sourceVersion: string;
  proposals: MaterialProposal[];
  missing: string[];
  generationJobId?: string;
  publicEntry?: 'novel_generate_chapter';
  proposalStatus?: ProposalStatus;
  confirmedAt?: string;
  confirmedFields?: string[];
  /** Preserve append/replace across every proposal round-trip. */
  continuationMode?: ContinuationMode;
  /** Preserve the requested final whole-chapter length across confirmation rounds. */
  targetWordCount?: TargetWordRange;
}

export interface ProposalEdit {
  field: string;
  value: string;
}

interface StoredProposal {
  id: string;
  projectId: number;
  chapterNumber: number;
  sourceVersion: string;
  status: 'pending' | 'applied' | 'cancelled' | 'draft_saved';
  proposals: MaterialProposal[];
  missing: string[];
  createdAt: string;
  continuationMode?: ContinuationMode;
  targetWordCount?: TargetWordRange;
  confirmedAt?: string;
  confirmedFields?: string[];
  /** Revision after this proposal's own material writes, used for submission-only recovery. */
  confirmedSourceVersion?: string;
  generationJobId?: string;
}

const PROPOSAL_TYPE = 'material_proposal';

export async function prepareGenerationSteward(input: {
  prisma: PrismaService;
  userId: number;
  projectId: number;
  chapterNumber: number;
  continuationMode?: ContinuationMode;
  targetWordCount?: TargetWordRange;
}): Promise<StewardResult> {
  let snapshot = await loadOwnedProjectContext(input.prisma, input.userId, input.projectId, input.chapterNumber);
  if (snapshot.hashMismatch) {
    const narrative = snapshot.documents.find((row) => row.documentType === 'narrative_state');
    const hash = snapshot.previousContinuation?.chapterNumber === snapshot.hashMismatch.chapterNumber
      ? snapshot.previousContinuation.sourceChapterHash
      : '';
    if (narrative && hash) {
      const repaired = reanchorNarrativeStateToChapter(
        narrative.content,
        snapshot.hashMismatch.chapterNumber,
        hash,
      );
      if (repaired.updatedEntries > 0) {
        const nextVersion = narrative.currentVersion + 1;
        await input.prisma.novelDocument.update({
          where: { id: narrative.id },
          data: { content: repaired.content, currentVersion: nextVersion },
        });
        await input.prisma.novelDocumentVersion.create({
          data: {
            documentId: narrative.id,
            createdBy: input.userId,
            versionNumber: nextVersion,
            content: repaired.content,
            changeSummary: `同步第${snapshot.hashMismatch.chapterNumber}章正文哈希引用`,
          },
        });
        snapshot = await loadOwnedProjectContext(input.prisma, input.userId, input.projectId, input.chapterNumber);
      }
    }
  }
  const readiness = classifyMaterialReadiness(snapshot, input.chapterNumber);
  if (readiness.status === 'hard_blocked') {
    throw new FailureHttpException(makeFailure({
      stage: 'runtime.preflight',
      gate: 'narrative_state',
      code: FAILURE_CODES.stateStoreHashMismatch,
      severity: 'preflight',
      reason: readiness.hardBlockReason ?? '生成前出现不可恢复的系统故障',
      recoverable: false,
      userActionRequired: ['修复前章叙事状态后再试'],
    }));
  }
  if (readiness.status === 'ready') {
    return {
      status: 'ready',
      reply: `项目资料已齐，将为第${input.chapterNumber}章提交正式生成任务。正文由 novel_generate_chapter 统一撰写。`,
      chapterNumber: input.chapterNumber,
      sourceVersion: snapshot.sourceVersion,
      proposals: [],
      missing: [],
      continuationMode: input.continuationMode,
      targetWordCount: input.targetWordCount,
    };
  }
  const stored = await saveProposal(
    input.prisma,
    input.userId,
    input.projectId,
    readiness,
    input.continuationMode,
    input.targetWordCount,
  );
  return {
    status: readiness.status,
    reply: buildConfirmationReply(readiness),
    chapterNumber: input.chapterNumber,
    proposalId: stored.id,
    sourceVersion: snapshot.sourceVersion,
    proposals: readiness.proposals,
    missing: readiness.missing,
    proposalStatus: 'pending',
    continuationMode: input.continuationMode,
    targetWordCount: input.targetWordCount,
  };
}

export async function confirmGenerationSteward(input: {
  prisma: PrismaService;
  jobs: JobsService;
  userId: number;
  projectId: number;
  action: ConfirmStewardAction;
  proposalId: string;
  sourceVersion: string;
  confirmedFields?: string[];
  continuationMode?: ContinuationMode;
  targetWordCount?: TargetWordRange;
}): Promise<StewardResult> {
  const proposal = await loadProposal(input.prisma, input.userId, input.projectId, input.proposalId);
  const continuationMode = input.continuationMode ?? proposal.continuationMode;
  const targetWordCount = input.targetWordCount ?? proposal.targetWordCount;
  if (proposal.status === 'applied' && proposal.generationJobId) {
    return {
      status: 'ready',
      reply: `该方案已确认过，沿用已提交的第${proposal.chapterNumber}章生成任务。`,
      chapterNumber: proposal.chapterNumber,
      proposalId: proposal.id,
      sourceVersion: proposal.sourceVersion,
      proposals: proposal.proposals,
      missing: [],
      generationJobId: proposal.generationJobId,
      publicEntry: 'novel_generate_chapter',
      proposalStatus: 'applied',
      confirmedAt: proposal.confirmedAt,
      confirmedFields: proposal.confirmedFields,
      continuationMode,
      targetWordCount,
    };
  }
  if (input.action === 'cancel') {
    await updateProposal(input.prisma, input.userId, input.projectId, {
      ...proposal,
      status: 'cancelled',
    });
    return {
      status: 'confirmation_required',
      reply: '已取消本次补齐方案，不会提交生成任务，也不会产生费用。',
      chapterNumber: proposal.chapterNumber,
      proposalId: proposal.id,
      sourceVersion: proposal.sourceVersion,
      proposals: proposal.proposals,
      missing: proposal.missing,
      proposalStatus: 'cancelled',
      continuationMode,
      targetWordCount,
    };
  }
  if (input.action === 'save_draft') {
    await updateProposal(input.prisma, input.userId, input.projectId, {
      ...proposal,
      status: 'draft_saved',
    });
    return {
      status: 'confirmation_required',
      reply: '已保存补齐草案。未写入作者正史，也未提交生成任务。',
      chapterNumber: proposal.chapterNumber,
      proposalId: proposal.id,
      sourceVersion: proposal.sourceVersion,
      proposals: proposal.proposals,
      missing: proposal.missing,
      proposalStatus: 'draft_saved',
      continuationMode,
      targetWordCount,
    };
  }
  const snapshot = await loadOwnedProjectContext(input.prisma, input.userId, input.projectId, proposal.chapterNumber);
  const versionMatches = snapshot.sourceVersion === input.sourceVersion
    && snapshot.sourceVersion === proposal.sourceVersion;
  const resumesConfirmedMaterials = snapshot.sourceVersion === proposal.confirmedSourceVersion
    && input.sourceVersion === proposal.sourceVersion;
  if (!versionMatches && !resumesConfirmedMaterials) {
    throw new FailureHttpException(makeFailure({
      stage: 'assistant.artifact',
      gate: 'proposal_version',
      code: FAILURE_CODES.artifactSaveFailed,
      severity: 'preflight',
      reason: '项目资料在确认期间已变化，请重新发起章节生成，查看最新方案后再确认。',
      recoverable: false,
      userActionRequired: ['重新发起目标章节生成，按最新大纲和角色资料确认方案'],
    }));
  }
  const confirmed = new Set(
    input.confirmedFields
      ?? proposal.proposals.filter((row) => row.value.trim()).map((row) => row.field),
  );
  let after = snapshot;
  let saved: { chapterId?: number } = { chapterId: undefined };
  if (versionMatches) {
    saved = await saveConfirmedAuthorMaterialsAtomic({
      prisma: input.prisma,
      userId: input.userId,
      projectId: input.projectId,
      chapterNumber: proposal.chapterNumber,
      confirmed,
      proposals: proposal.proposals,
    });
    after = await loadOwnedProjectContext(input.prisma, input.userId, input.projectId, proposal.chapterNumber);
  }
  const readiness = classifyMaterialReadiness(after, proposal.chapterNumber);
  if (readiness.status === 'hard_blocked') {
    throw new FailureHttpException(makeFailure({
      stage: 'runtime.preflight',
      gate: 'narrative_state',
      code: FAILURE_CODES.stateStoreHashMismatch,
      severity: 'preflight',
      reason: readiness.hardBlockReason ?? '生成前出现不可恢复的系统故障',
      recoverable: false,
      userActionRequired: ['修复前章叙事状态后再试'],
    }));
  }
  if (readiness.status !== 'ready' && readiness.status !== 'auto_fill') {
    const remaining = await saveProposal(input.prisma, input.userId, input.projectId, {
      ...readiness,
      chapterNumber: proposal.chapterNumber,
      sourceVersion: after.sourceVersion,
    }, continuationMode, targetWordCount);
    return {
      status: 'confirmation_required',
      reply: buildConfirmationReply(readiness),
      chapterNumber: proposal.chapterNumber,
      proposalId: remaining.id,
      sourceVersion: after.sourceVersion,
      proposals: readiness.proposals,
      missing: readiness.missing,
      proposalStatus: 'pending',
      continuationMode,
      targetWordCount,
    };
  }
  let chapterId = saved.chapterId;
  if (readiness.status === 'auto_fill' || !chapterId) {
    const seeded = await saveConfirmedAuthorMaterialsAtomic({
      prisma: input.prisma,
      userId: input.userId,
      projectId: input.projectId,
      chapterNumber: proposal.chapterNumber,
      confirmed: new Set(readiness.proposals.map((row) => row.field)),
      proposals: readiness.proposals,
    });
    chapterId = seeded.chapterId ?? chapterId;
  }
  if (!chapterId) {
    const existing = await input.prisma.novelChapter.findFirst({
      where: {
        projectId: input.projectId,
        userId: input.userId,
        chapterNumber: proposal.chapterNumber,
        deletedAt: null,
      },
      select: { id: true },
    });
    chapterId = existing?.id;
  }
  if (!chapterId) {
    return {
      status: 'confirmation_required',
      reply: buildConfirmationReply(readiness),
      chapterNumber: proposal.chapterNumber,
      proposalId: proposal.id,
      sourceVersion: after.sourceVersion,
      proposals: readiness.proposals,
      missing: readiness.missing.length > 0 ? readiness.missing : ['章节种子'],
      proposalStatus: 'pending',
      continuationMode,
      targetWordCount,
    };
  }
  let generationJobId: string | undefined;
  // Save the exact revision produced by our own writes before submission can
  // fail. Readiness alone cannot distinguish a safe retry from new author edits.
  const confirmedSnapshot = await loadOwnedProjectContext(input.prisma, input.userId, input.projectId, proposal.chapterNumber);
  const confirmedSourceVersion = confirmedSnapshot.sourceVersion;
  await updateProposal(input.prisma, input.userId, input.projectId, {
    ...proposal,
    confirmedSourceVersion,
    confirmedFields: [...confirmed],
  });
  try {
    const job = await input.jobs.submitChapterGeneration(
      input.userId,
      input.projectId,
      chapterId,
      { continuationMode, targetWordCount },
    ) as { jobId?: unknown };
    generationJobId = typeof job.jobId === 'string' ? job.jobId : undefined;
  } catch (error: unknown) {
    const jobDelegate = (input.prisma as unknown as {
      novelGenerationJob?: { findFirst?: (args: unknown) => Promise<{ jobId: string } | null> };
    }).novelGenerationJob;
    if (!jobDelegate?.findFirst) throw error;
    let existingJob: { jobId: string } | null;
    try {
      existingJob = await jobDelegate.findFirst({
        where: {
          userId: input.userId,
          projectId: input.projectId,
          chapterId,
          jobType: 'chapter_generation',
          status: { in: ['pending', 'running'] },
        },
        select: { jobId: true },
      });
    } catch {
      throw error;
    }
    if (!existingJob) throw error;
    generationJobId = existingJob.jobId;
  }
  const confirmedAt = new Date().toISOString();
  await updateProposal(input.prisma, input.userId, input.projectId, {
    ...proposal,
    continuationMode,
    targetWordCount,
    status: 'applied',
    confirmedAt,
    confirmedFields: [...confirmed],
    confirmedSourceVersion,
    generationJobId,
  });
  return {
    status: 'ready',
    reply: `已保存确认资料并为第${proposal.chapterNumber}章提交正式生成任务。正文由 novel_generate_chapter 统一撰写。`,
    chapterNumber: proposal.chapterNumber,
    proposalId: proposal.id,
    sourceVersion: after.sourceVersion,
    proposals: proposal.proposals,
    missing: [],
    generationJobId,
    publicEntry: 'novel_generate_chapter',
    proposalStatus: 'applied',
    confirmedAt,
    confirmedFields: [...confirmed],
    continuationMode,
    targetWordCount,
  };
}

async function saveConfirmedAuthorMaterialsAtomic(input: Parameters<typeof saveConfirmedAuthorMaterials>[0]): Promise<{ chapterId?: number }> {
  const transaction = input.prisma.$transaction;
  if (typeof transaction !== 'function') {
    return saveConfirmedAuthorMaterials(input);
  }
  return input.prisma.$transaction(async (tx) => saveConfirmedAuthorMaterials({
    ...input,
    prisma: tx as never,
  }));
}

export function buildConfirmationReply(readiness: MaterialReadiness): string {
  const confirmable = readiness.proposals.filter((row) => row.requiresConfirmation);
  const filled = confirmable.filter((row) => row.value.trim());
  const empty = confirmable.filter((row) => !row.value.trim());
  const lines = [
    `已读取全书大纲、章节状态、角色状态和历史叙事资料。`,
    `可自动补齐的辅助资料会直接用于本次生成，不要求你重复确认。`,
    filled.length > 0 ? `仍需你确认的内容：${filled.map((row) => labelOf(row.field)).join('、')}。` : '',
    ...filled.map((row) => `- ${labelOf(row.field)}：${preview(row.value)}`),
    empty.length > 0
      ? `以下内容无法从现有资料可靠确定，请补充：${empty.map((row) => labelOf(row.field)).join('、')}。`
      : '',
    '确认后将直接提交第' + readiness.chapterNumber + '章正式生成；也可以只修改上面列出的内容。',
  ].filter(Boolean);
  return lines.join('\n');
}

export async function submitReadyGenerationSteward(input: {
  prisma: PrismaService;
  jobs: JobsService;
  userId: number;
  projectId: number;
  chapterNumber: number;
  continuationMode?: ContinuationMode;
  targetWordCount?: TargetWordRange;
}): Promise<string | undefined> {
  let chapter = await input.prisma.novelChapter.findFirst({
    where: { projectId: input.projectId, userId: input.userId, chapterNumber: input.chapterNumber, deletedAt: null },
    include: { seed: true },
  });
  if (!chapter) {
    chapter = await input.prisma.novelChapter.create({
      data: {
        projectId: input.projectId,
        userId: input.userId,
        chapterNumber: input.chapterNumber,
        title: `第${input.chapterNumber}章`,
        seed: { create: { projectId: input.projectId, userId: input.userId } },
      },
      include: { seed: true },
    });
  }
  const job = await input.jobs.submitChapterGeneration(
    input.userId,
    input.projectId,
    chapter.id,
    {
      continuationMode: input.continuationMode,
      targetWordCount: input.targetWordCount,
    },
  ) as { jobId?: unknown };
  return typeof job.jobId === 'string' ? job.jobId : undefined;
}

export function parseStewardAction(value: unknown): StewardAction | undefined {
  return typeof value === 'string' && (STEWARD_ACTIONS as readonly string[]).includes(value)
    ? value as StewardAction
    : undefined;
}

export async function reviseGenerationSteward(input: {
  prisma: PrismaService;
  userId: number;
  projectId: number;
  proposalId: string;
  sourceVersion: string;
  edits: ProposalEdit[];
}): Promise<StewardResult> {
  const proposal = await loadProposal(input.prisma, input.userId, input.projectId, input.proposalId);
  if (proposal.sourceVersion !== input.sourceVersion) {
    throw new FailureHttpException(makeFailure({
      stage: 'assistant.artifact',
      gate: 'proposal_version',
      code: FAILURE_CODES.artifactSaveFailed,
      severity: 'preflight',
      reason: '补齐方案对应的项目资料已经变化，请重新查看方案后修改。',
      recoverable: false,
    }));
  }
  if (proposal.status === 'applied' && proposal.generationJobId) {
    return {
      status: 'ready',
      reply: '该方案已经确认并提交过生成任务。',
      chapterNumber: proposal.chapterNumber,
      proposalId: proposal.id,
      sourceVersion: proposal.sourceVersion,
      proposals: proposal.proposals,
      missing: [],
      generationJobId: proposal.generationJobId,
      publicEntry: 'novel_generate_chapter',
      proposalStatus: 'applied',
      confirmedAt: proposal.confirmedAt,
      confirmedFields: proposal.confirmedFields,
      continuationMode: proposal.continuationMode,
      targetWordCount: proposal.targetWordCount,
    };
  }
  const editsByField = new Map(input.edits.map((edit) => [edit.field, edit.value.trim()]));
  const knownFields = new Set(proposal.proposals.map((row) => row.field));
  for (const field of editsByField.keys()) {
    if (!knownFields.has(field)) {
      throw new FailureHttpException(makeFailure({
        stage: 'assistant.artifact',
        gate: 'proposal_edit',
        code: FAILURE_CODES.artifactActionMismatch,
        severity: 'preflight',
        reason: '修改方案包含未知资料字段。',
        recoverable: false,
      }));
    }
  }
  const proposals = proposal.proposals.map((row) => (
    editsByField.has(row.field) ? { ...row, value: editsByField.get(row.field) ?? '' } : row
  ));
  const missing = proposal.missing.filter((label) => {
    const field = fieldForLabel(label);
    return !field || !proposals.find((row) => row.field === field)?.value.trim();
  });
  const updated: StoredProposal = {
    ...proposal,
    sourceVersion: proposal.confirmedSourceVersion ?? proposal.sourceVersion,
    status: 'pending',
    proposals,
    missing,
    confirmedAt: undefined,
    confirmedFields: undefined,
    confirmedSourceVersion: undefined,
    generationJobId: undefined,
  };
  if (proposal.confirmedSourceVersion) {
    const snapshot = await loadOwnedProjectContext(input.prisma, input.userId, input.projectId, proposal.chapterNumber);
    if (snapshot.sourceVersion !== proposal.confirmedSourceVersion) {
      throw new FailureHttpException(makeFailure({
        stage: 'assistant.artifact', gate: 'proposal_version', code: FAILURE_CODES.artifactSaveFailed,
        severity: 'preflight', reason: '项目资料已经变化，请重新发起章节生成后修改最新方案。', recoverable: false,
      }));
    }
  }
  await updateProposal(input.prisma, input.userId, input.projectId, updated);
  return {
    status: 'confirmation_required',
    reply: buildConfirmationReply({
      status: 'confirmation_required',
      missing,
      proposals,
      chapterNumber: proposal.chapterNumber,
      sourceVersion: updated.sourceVersion,
    }),
    chapterNumber: proposal.chapterNumber,
    proposalId: proposal.id,
    sourceVersion: updated.sourceVersion,
    proposals,
    missing,
    proposalStatus: 'pending',
    continuationMode: proposal.continuationMode,
    targetWordCount: proposal.targetWordCount,
  };
}

async function saveProposal(
  prisma: PrismaService,
  userId: number,
  projectId: number,
  readiness: MaterialReadiness,
  continuationMode?: ContinuationMode,
  targetWordCount?: TargetWordRange,
): Promise<StoredProposal> {
  const stored: StoredProposal = {
    id: randomUUID(),
    projectId,
    chapterNumber: readiness.chapterNumber,
    sourceVersion: readiness.sourceVersion,
    status: 'pending',
    proposals: readiness.proposals,
    missing: readiness.missing,
    createdAt: new Date().toISOString(),
    ...(continuationMode ? { continuationMode } : {}),
    ...(targetWordCount ? { targetWordCount } : {}),
  };
  const existing = await prisma.novelDocument.findFirst({
    where: { projectId, userId, documentType: PROPOSAL_TYPE, deletedAt: null },
  });
  const content = JSON.stringify(stored);
  if (!existing) {
    const created = await prisma.novelDocument.create({
      data: {
        projectId,
        userId,
        documentType: PROPOSAL_TYPE,
        title: `第${readiness.chapterNumber}章资料补齐方案`,
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
        changeSummary: '助手生成补齐方案',
      },
    });
  } else {
    const nextVersion = existing.currentVersion + 1;
    await prisma.novelDocument.update({
      where: { id: existing.id },
      data: { content, currentVersion: nextVersion, title: `第${readiness.chapterNumber}章资料补齐方案` },
    });
    await prisma.novelDocumentVersion.create({
      data: {
        documentId: existing.id,
        createdBy: userId,
        versionNumber: nextVersion,
        content,
        changeSummary: '助手更新补齐方案',
      },
    });
  }
  return stored;
}

async function loadProposal(
  prisma: PrismaService,
  userId: number,
  projectId: number,
  proposalId: string,
): Promise<StoredProposal> {
  const row = await prisma.novelDocument.findFirst({
    where: { projectId, userId, documentType: PROPOSAL_TYPE, deletedAt: null },
  });
  if (!row?.content) throw new NotFoundException('补齐方案不存在');
  const parsed = JSON.parse(row.content) as StoredProposal;
  if (parsed.id !== proposalId || parsed.projectId !== projectId) {
    throw new NotFoundException('补齐方案不存在');
  }
  return parsed;
}

async function updateProposal(
  prisma: PrismaService,
  userId: number,
  projectId: number,
  proposal: StoredProposal,
): Promise<void> {
  const row = await prisma.novelDocument.findFirst({
    where: { projectId, userId, documentType: PROPOSAL_TYPE, deletedAt: null },
  });
  if (!row) return;
  const content = JSON.stringify(proposal);
  const nextVersion = row.currentVersion + 1;
  await prisma.novelDocument.update({
    where: { id: row.id },
    data: { content, currentVersion: nextVersion },
  });
  await prisma.novelDocumentVersion.create({
    data: {
      documentId: row.id,
      createdBy: userId,
      versionNumber: nextVersion,
      content,
      changeSummary: `助手方案状态：${proposal.status}`,
    },
  });
}

function labelOf(field: string): string {
  if (field === 'genre') return '作品类型';
  if (field === 'worldbuilding') return '世界观';
  if (field === 'creative_constitution') return '创作宪法';
  if (field === 'style_profile') return '风格档案';
  if (field === 'chapter_seed') return '本章种子';
  if (field === 'character_states') return '角色状态';
  if (field === 'canon_state') return 'Canon';
  if (field === 'promise_ledger') return '伏笔/承诺';
  return field;
}

function fieldForLabel(label: string): string | undefined {
  return ['genre', 'worldbuilding', 'creative_constitution', 'style_profile', 'chapter_seed', 'character_states', 'canon_state', 'promise_ledger']
    .find((field) => labelOf(field) === label);
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 80 ? `${compact.slice(0, 79)}…` : compact;
}
