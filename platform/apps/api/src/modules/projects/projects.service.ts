/**
 * 小说项目 CRUD：列表分页/搜索、软删除、归属隔离。
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { requireOwnedProject } from '../../common/ownership';
import type { CreateProjectDto, UpdateProjectDto } from './dto/project.dto';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 当前用户项目分页列表。 */
  async list(
    userId: number,
    page: number,
    pageSize: number,
    q?: string,
  ): Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> {
    const where = {
      userId,
      deletedAt: null,
      ...(q?.trim()
        ? { title: { contains: q.trim(), mode: 'insensitive' as const } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.novelProject.findMany({
        where,
        orderBy: [{ lastActiveAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.novelProject.count({ where }),
    ]);
    const stats = await this.chapterStats(rows.map((row) => row.id));
    return {
      items: rows.map((row) => this.toView(row, stats.get(row.id))),
      total,
      page,
      pageSize,
    };
  }

  /** 回收站：已软删除项目。 */
  async listTrash(
    userId: number,
    page: number,
    pageSize: number,
  ): Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> {
    const where = { userId, deletedAt: { not: null } };
    const [rows, total] = await Promise.all([
      this.prisma.novelProject.findMany({
        where,
        orderBy: { deletedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.novelProject.count({ where }),
    ]);
    const stats = await this.chapterStats(rows.map((row) => row.id));
    return {
      items: rows.map((row) => this.toView(row, stats.get(row.id))),
      total,
      page,
      pageSize,
    };
  }

  /** 创建项目。 */
  async create(userId: number, dto: CreateProjectDto): Promise<unknown> {
    const created = await this.prisma.novelProject.create({
      data: {
        userId,
        title: dto.title,
        description: dto.description ?? '',
        genre: dto.genre ?? '',
        subGenres: dto.subGenres ?? [],
        worldKeyTerms: dto.worldKeyTerms ?? [],
        lastActiveAt: new Date(),
      },
    });
    return this.toView(created);
  }

  /** 项目详情。 */
  async get(userId: number, projectId: number): Promise<unknown> {
    const project = await requireOwnedProject(this.prisma, userId, projectId);
    const stats = await this.chapterStats([project.id]);
    return this.toView(project, stats.get(project.id));
  }

  /** 更新项目。 */
  async update(
    userId: number,
    projectId: number,
    dto: UpdateProjectDto,
  ): Promise<unknown> {
    const current = await requireOwnedProject(this.prisma, userId, projectId);
    const write = await this.prisma.novelProject.updateMany({
      where: {
        id: projectId,
        userId,
        deletedAt: null,
        version: dto.expectedVersion,
      },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.genre !== undefined ? { genre: dto.genre } : {}),
        ...(dto.subGenres !== undefined ? { subGenres: dto.subGenres } : {}),
        ...(dto.worldKeyTerms !== undefined
          ? { worldKeyTerms: dto.worldKeyTerms }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        version: { increment: 1 },
        lastActiveAt: new Date(),
      },
    });
    if (write.count !== 1) {
      const latest = await this.prisma.novelProject.findUnique({
        where: { id: projectId },
        select: { version: true },
      });
      throw new ConflictException({
        statusCode: 409,
        message: '项目已被其他请求更新，请刷新后重试',
        reason: 'version_conflict',
        currentVersion: latest?.version ?? current.version,
      });
    }
    const updated = await this.prisma.novelProject.findUniqueOrThrow({
      where: { id: projectId },
    });
    return this.toView(updated);
  }

  /** 软删除。 */
  async remove(userId: number, projectId: number): Promise<{ ok: true }> {
    await requireOwnedProject(this.prisma, userId, projectId);
    await this.prisma.novelProject.update({
      where: { id: projectId },
      data: { deletedAt: new Date(), status: 'archived' },
    });
    return { ok: true };
  }

  /** 从回收站恢复。 */
  async restore(userId: number, projectId: number): Promise<unknown> {
    const project = await this.prisma.novelProject.findFirst({
      where: { id: projectId, userId, deletedAt: { not: null } },
    });
    if (!project) {
      throw new NotFoundException('回收站中没有该项目');
    }
    const updated = await this.prisma.novelProject.update({
      where: { id: projectId },
      data: { deletedAt: null, status: 'active', lastActiveAt: new Date() },
    });
    return this.toView(updated);
  }

  /** 导出全书 TXT（按章节序号拼接）。 */
  async exportBook(
    userId: number,
    projectId: number,
  ): Promise<{ filename: string; content: string }> {
    const project = await requireOwnedProject(this.prisma, userId, projectId);
    const chapters = await this.prisma.novelChapter.findMany({
      where: { projectId, userId, deletedAt: null },
      orderBy: { chapterNumber: 'asc' },
    });
    const parts = [`《${project.title}》`, ''];
    if (project.description.trim()) {
      parts.push(project.description.trim(), '');
    }
    for (const chapter of chapters) {
      const heading = `第${chapter.chapterNumber}章${chapter.title ? ` ${chapter.title}` : ''}`;
      parts.push(heading, '', chapter.content.trim() || '（暂无正文）', '');
    }
    const content = `${parts.join('\n').trim()}\n`;
    return {
      filename: `${sanitizeFilename(project.title)}.txt`,
      content,
    };
  }

  private async chapterStats(
    projectIds: number[],
  ): Promise<Map<number, { chapterCount: number; wordCount: number }>> {
    const stats = new Map<number, { chapterCount: number; wordCount: number }>();
    if (projectIds.length === 0) return stats;
    const rows = await this.prisma.novelChapter.groupBy({
      by: ['projectId'],
      where: { projectId: { in: projectIds }, deletedAt: null },
      _count: { _all: true },
      _sum: { wordCount: true },
    });
    for (const row of rows) {
      stats.set(row.projectId, {
        chapterCount: row._count._all,
        wordCount: row._sum.wordCount ?? 0,
      });
    }
    return stats;
  }

  toView(
    row: {
      id: number;
      userId: number;
      title: string;
      description: string;
      genre: string;
      subGenres: unknown;
      worldKeyTerms: unknown;
      status: string;
      workflowState: string;
      version: number;
      createdAt: Date;
      updatedAt: Date;
      lastActiveAt?: Date | null;
      deletedAt?: Date | null;
    },
    stats?: { chapterCount: number; wordCount: number },
  ): Record<string, unknown> {
    return {
      id: row.id,
      userId: row.userId,
      title: row.title,
      description: row.description,
      genre: row.genre,
      subGenres: row.subGenres,
      worldKeyTerms: row.worldKeyTerms,
      status: row.status,
      workflowState: row.workflowState,
      version: row.version,
      chapterCount: stats?.chapterCount ?? 0,
      wordCount: stats?.wordCount ?? 0,
      lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deletedAt: row.deletedAt?.toISOString() ?? null,
    };
  }
}

function sanitizeFilename(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '_').trim() || 'novel';
  return cleaned.slice(0, 80);
}
