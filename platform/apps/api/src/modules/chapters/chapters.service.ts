/**
 * 章节目录 / 正文乐观锁 / 软删除 / 种子 / 版本。
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { countWords, requireOwnedProject } from '../../common/ownership';
import type {
  CreateChapterDto,
  RestoreVersionDto,
  UpdateChapterDto,
  UpsertSeedDto,
} from './dto/chapter.dto';

@Injectable()
export class ChaptersService {
  constructor(private readonly prisma: PrismaService) {}

  /** 章节目录（未删除）。 */
  async list(userId: number, projectId: number): Promise<unknown[]> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const rows = await this.prisma.novelChapter.findMany({
      where: { projectId, userId, deletedAt: null },
      orderBy: { chapterNumber: 'asc' },
      include: { seed: true },
    });
    return rows.map((row) => this.toChapterView(row));
  }

  /** 新建章节并创建空种子。 */
  async create(
    userId: number,
    projectId: number,
    dto: CreateChapterDto,
  ): Promise<unknown> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const dup = await this.prisma.novelChapter.findFirst({
      where: {
        projectId,
        chapterNumber: dto.chapterNumber,
        deletedAt: null,
      },
    });
    if (dup) {
      throw new ConflictException('该章节序号已存在');
    }
    let created;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const chapter = await tx.novelChapter.create({
          data: {
            projectId,
            userId,
            chapterNumber: dto.chapterNumber,
            title: dto.title ?? '',
          },
        });
        await tx.novelChapterSeed.create({
          data: { chapterId: chapter.id, projectId, userId },
        });
        await tx.novelProject.update({
          where: { id: projectId },
          data: { lastActiveAt: new Date() },
        });
        return tx.novelChapter.findUniqueOrThrow({
          where: { id: chapter.id },
          include: { seed: true },
        });
      });
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null &&
        'code' in error && (error as { code?: unknown }).code === 'P2002') {
        throw new ConflictException('chapter number already exists');
      }
      throw error;
    }
    return this.toChapterView(created);
  }

  /** 章节详情。 */
  async get(
    userId: number,
    projectId: number,
    chapterId: number,
  ): Promise<unknown> {
    const chapter = await this.requireChapter(userId, projectId, chapterId);
    return this.toChapterView(chapter);
  }

  /** 保存正文：乐观锁，冲突 409，并写入 manual_save 版本。 */
  async update(
    userId: number,
    projectId: number,
    chapterId: number,
    dto: UpdateChapterDto,
  ): Promise<unknown> {
    const chapter = await this.requireChapter(userId, projectId, chapterId);
    if (chapter.version !== dto.expectedVersion) {
      throw new ConflictException({
        statusCode: 409,
        message: '章节版本冲突',
        reason: 'version_conflict',
        currentVersion: chapter.version,
      });
    }
    const nextChapterNumber = dto.chapterNumber ?? chapter.chapterNumber;
    if (nextChapterNumber !== chapter.chapterNumber) {
      const duplicate = await this.prisma.novelChapter.findFirst({
        where: {
          projectId,
          chapterNumber: nextChapterNumber,
          deletedAt: null,
          id: { not: chapterId },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new ConflictException('该章节序号已存在');
      }
    }
    const nextTitle = dto.title ?? chapter.title;
    const nextContent = dto.content ?? chapter.content;
    let updated;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
      const write = await tx.novelChapter.updateMany({
        where: {
          id: chapterId,
          projectId,
          userId,
          deletedAt: null,
          version: dto.expectedVersion,
        },
        data: {
          chapterNumber: nextChapterNumber,
          title: nextTitle,
          content: nextContent,
          wordCount: countWords(nextContent),
          version: { increment: 1 },
        },
      });
      if (write.count !== 1) {
        const current = await tx.novelChapter.findFirst({
          where: { id: chapterId, projectId, userId, deletedAt: null },
          select: { version: true },
        });
        throw new ConflictException({
          statusCode: 409,
          message: '章节版本冲突',
          reason: 'version_conflict',
          currentVersion: current?.version ?? chapter.version,
        });
      }
      const saved = await tx.novelChapter.findUniqueOrThrow({
        where: { id: chapterId },
        include: { seed: true },
      });
      await tx.novelChapterVersion.create({
        data: {
          chapterId,
          projectId,
          userId,
          versionNumber: saved.version,
          title: saved.title,
          content: saved.content,
          wordCount: saved.wordCount,
          source: 'manual_save',
          createdBy: userId,
        },
      });
      return saved;
      });
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null &&
        'code' in error && (error as { code?: unknown }).code === 'P2002') {
        throw new ConflictException('该章节序号已存在');
      }
      throw error;
    }
    return this.toChapterView(updated);
  }

  /** 软删除章节。 */
  async remove(
    userId: number,
    projectId: number,
    chapterId: number,
  ): Promise<{ ok: true }> {
    await this.requireChapter(userId, projectId, chapterId);
    await this.prisma.novelChapter.update({
      where: { id: chapterId },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  /** 读取种子。 */
  async getSeed(
    userId: number,
    projectId: number,
    chapterId: number,
  ): Promise<unknown> {
    const chapter = await this.requireChapter(userId, projectId, chapterId);
    return this.toSeedView(chapter.seed);
  }

  /** 编写种子。 */
  async upsertSeed(
    userId: number,
    projectId: number,
    chapterId: number,
    dto: UpsertSeedDto,
  ): Promise<unknown> {
    const chapter = await this.requireChapter(userId, projectId, chapterId);
    if (!chapter.seed) {
      throw new NotFoundException('seed not found');
    }
    if (chapter.seed.version !== dto.expectedVersion) {
      throw new ConflictException({
        statusCode: 409,
        message: '绉嶅瓙鐗堟湰鍐茬獊',
        reason: 'version_conflict',
        currentVersion: chapter.seed.version,
      });
    }
    const seed = await this.prisma.$transaction(async (tx) => {
      const write = await tx.novelChapterSeed.updateMany({
        where: {
          chapterId,
          projectId,
          userId,
          version: dto.expectedVersion,
        },
        data: {
          ...(dto.intent !== undefined ? { intent: dto.intent } : {}),
          ...(dto.mustInclude !== undefined ? { mustInclude: dto.mustInclude } : {}),
          ...(dto.forbiddenFacts !== undefined
            ? { forbiddenFacts: dto.forbiddenFacts }
            : {}),
          ...(dto.characterMotives !== undefined
            ? { characterMotives: dto.characterMotives }
            : {}),
          ...(dto.promises !== undefined ? { promises: dto.promises } : {}),
          ...(dto.endingGoal !== undefined ? { endingGoal: dto.endingGoal } : {}),
          status: 'ready',
          version: { increment: 1 },
        },
      });
      if (write.count !== 1) {
        const current = await tx.novelChapterSeed.findFirst({
          where: { chapterId, projectId, userId },
          select: { version: true },
        });
        throw new ConflictException({
          statusCode: 409,
          message: '绉嶅瓙鐗堟湰鍐茬獊',
          reason: 'version_conflict',
          currentVersion: current?.version ?? chapter.seed!.version,
        });
      }
      return tx.novelChapterSeed.findUniqueOrThrow({ where: { chapterId } });
    });
    return this.toSeedView(seed);
  }

  /** 版本列表。 */
  async listVersions(
    userId: number,
    projectId: number,
    chapterId: number,
  ): Promise<unknown[]> {
    await this.requireChapter(userId, projectId, chapterId);
    const rows = await this.prisma.novelChapterVersion.findMany({
      where: { chapterId, projectId },
      orderBy: { versionNumber: 'desc' },
    });
    return rows.map((row) => this.toVersionView(row));
  }

  /** 从历史版本恢复：用旧正文创建新版本，不删历史。 */
  async restoreVersion(
    userId: number,
    projectId: number,
    chapterId: number,
    dto: RestoreVersionDto,
  ): Promise<unknown> {
    const chapter = await this.requireChapter(userId, projectId, chapterId);
    const snapshot = await this.prisma.novelChapterVersion.findUnique({
      where: {
        chapterId_versionNumber: {
          chapterId,
          versionNumber: dto.versionNumber,
        },
      },
    });
    if (!snapshot) {
      throw new NotFoundException('版本不存在');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      // The restore request was authorized against this exact chapter version.
      // A blind update here could overwrite a manual save or completed
      // generation that happened between requireChapter() and this transaction.
      const write = await tx.novelChapter.updateMany({
        where: {
          id: chapterId,
          projectId,
          userId,
          deletedAt: null,
          version: chapter.version,
        },
        data: {
          title: snapshot.title,
          content: snapshot.content,
          wordCount: snapshot.wordCount,
          version: { increment: 1 },
        },
      });
      if (write.count !== 1) {
        const current = await tx.novelChapter.findFirst({
          where: { id: chapterId, projectId, userId, deletedAt: null },
          select: { version: true },
        });
        throw new ConflictException({
          statusCode: 409,
          message: '章节版本冲突',
          reason: 'version_conflict',
          currentVersion: current?.version ?? chapter.version,
        });
      }
      const saved = await tx.novelChapter.findUniqueOrThrow({
        where: { id: chapterId },
        include: { seed: true },
      });
      await tx.novelChapterVersion.create({
        data: {
          chapterId,
          projectId,
          userId,
          versionNumber: saved.version,
          title: saved.title,
          content: saved.content,
          wordCount: saved.wordCount,
          source: 'restore',
          createdBy: userId,
        },
      });
      return saved;
    });
    void chapter;
    return this.toChapterView(updated);
  }

  async requireChapter(
    userId: number,
    projectId: number,
    chapterId: number,
  ): Promise<{
    id: number;
    projectId: number;
    userId: number;
    chapterNumber: number;
    title: string;
    content: string;
    wordCount: number;
    status: string;
    version: number;
    generationJobId: string | null;
    seed: {
      id: number;
      intent: string;
      mustInclude: string;
      forbiddenFacts: string;
      characterMotives: string;
      promises: string;
      endingGoal: string;
      status: string;
      version: number;
    } | null;
  }> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const chapter = await this.prisma.novelChapter.findFirst({
      where: { id: chapterId, projectId, userId, deletedAt: null },
      include: { seed: true },
    });
    if (!chapter) {
      throw new NotFoundException('章节不存在');
    }
    return chapter;
  }

  toChapterView(row: {
    id: number;
    projectId: number;
    chapterNumber: number;
    title: string;
    content: string;
    wordCount: number;
    status: string;
    version: number;
    generationJobId: string | null;
    seed?: unknown;
  }): Record<string, unknown> {
    return {
      id: row.id,
      projectId: row.projectId,
      chapterNumber: row.chapterNumber,
      title: row.title,
      content: row.content,
      wordCount: row.wordCount,
      status: row.status,
      version: row.version,
      generationJobId: row.generationJobId,
      seed: row.seed ? this.toSeedView(row.seed as never) : null,
    };
  }

  toSeedView(seed: {
    id: number;
    intent: string;
    mustInclude: string;
    forbiddenFacts: string;
    characterMotives: string;
    promises: string;
    endingGoal: string;
    status: string;
    version: number;
  } | null): Record<string, unknown> | null {
    if (!seed) return null;
    return {
      id: seed.id,
      intent: seed.intent,
      mustInclude: seed.mustInclude,
      forbiddenFacts: seed.forbiddenFacts,
      characterMotives: seed.characterMotives,
      promises: seed.promises,
      endingGoal: seed.endingGoal,
      status: seed.status,
      version: seed.version,
    };
  }

  toVersionView(row: {
    id: number;
    versionNumber: number;
    title: string;
    content: string;
    wordCount: number;
    source: string;
    createdAt: Date;
  }): Record<string, unknown> {
    return {
      id: row.id,
      versionNumber: row.versionNumber,
      title: row.title,
      content: row.content,
      wordCount: row.wordCount,
      source: row.source,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
