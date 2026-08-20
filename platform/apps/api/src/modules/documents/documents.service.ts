/**
 * 设定文档 CRUD：每次保存追加版本。
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { requireOwnedProject } from '../../common/ownership';

export class CreateDocumentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  documentType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  content?: string;
}

export class UpdateDocumentDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  changeSummary?: string;
}

@Injectable()
export class DocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: number, projectId: number): Promise<unknown[]> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const rows = await this.prisma.novelDocument.findMany({
      where: { projectId, userId, deletedAt: null },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => this.toView(row));
  }

  async create(
    userId: number,
    projectId: number,
    dto: CreateDocumentDto,
  ): Promise<unknown> {
    await requireOwnedProject(this.prisma, userId, projectId);
    let created;
    try {
      created = await this.prisma.$transaction(async (tx) => {
      const doc = await tx.novelDocument.create({
        data: {
          projectId,
          userId,
          documentType: dto.documentType,
          title: dto.title,
          content: dto.content ?? '',
          currentVersion: 1,
        },
      });
      await tx.novelDocumentVersion.create({
        data: {
          documentId: doc.id,
          createdBy: userId,
          versionNumber: 1,
          content: doc.content,
          changeSummary: '初始版本',
        },
      });
      return doc;
      });
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null &&
        'code' in error && (error as { code?: unknown }).code === 'P2002') {
        throw new ConflictException('document already exists');
      }
      throw error;
    }
    return this.toView(created);
  }

  async get(
    userId: number,
    projectId: number,
    documentId: number,
  ): Promise<unknown> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const row = await this.prisma.novelDocument.findFirst({
      where: { id: documentId, projectId, userId, deletedAt: null },
      include: { versions: { orderBy: { versionNumber: 'desc' } } },
    });
    if (!row) throw new NotFoundException('文档不存在');
    return {
      ...this.toView(row),
      versions: row.versions.map((item) => ({
        versionNumber: item.versionNumber,
        content: item.content,
        changeSummary: item.changeSummary,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  }

  async update(
    userId: number,
    projectId: number,
    documentId: number,
    dto: UpdateDocumentDto,
  ): Promise<unknown> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const row = await this.prisma.novelDocument.findFirst({
      where: { id: documentId, projectId, userId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('文档不存在');
    const updated = await this.prisma.$transaction(async (tx) => {
      const nextVersion = row.currentVersion + 1;
      const write = await tx.novelDocument.updateMany({
        where: {
          id: documentId,
          projectId,
          userId,
          deletedAt: null,
          currentVersion: row.currentVersion,
        },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.content !== undefined ? { content: dto.content } : {}),
          currentVersion: nextVersion,
        },
      });
      if (write.count !== 1) {
        throw new ConflictException({
          statusCode: 409,
          message: '鏂囨。鐗堟湰鍐茬獊',
          reason: 'version_conflict',
        });
      }
      const saved = await tx.novelDocument.findUniqueOrThrow({ where: { id: documentId } });
      await tx.novelDocumentVersion.create({
        data: {
          documentId,
          createdBy: userId,
          versionNumber: nextVersion,
          content: saved.content,
          changeSummary: dto.changeSummary ?? '',
        },
      });
      return saved;
    });
    return this.toView(updated);
  }

  async remove(
    userId: number,
    projectId: number,
    documentId: number,
  ): Promise<{ ok: true }> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const row = await this.prisma.novelDocument.findFirst({
      where: { id: documentId, projectId, userId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('文档不存在');
    await this.prisma.novelDocument.update({
      where: { id: documentId },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  private toView(row: {
    id: number;
    documentType: string;
    title: string;
    content: string;
    currentVersion: number;
  }): Record<string, unknown> {
    return {
      id: row.id,
      documentType: row.documentType,
      title: row.title,
      content: row.content,
      currentVersion: row.currentVersion,
    };
  }
}
