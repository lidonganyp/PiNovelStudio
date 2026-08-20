/**
 * 大纲树：列出 / 创建 / 更新 / 软删除节点。
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { requireOwnedProject } from '../../common/ownership';

export class CreateOutlineNodeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  parentId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  nodeType?: string;

  @IsString()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  summary?: string;
}

export class UpdateOutlineNodeDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

@Injectable()
export class OutlineService {
  constructor(private readonly prisma: PrismaService) {}

  async tree(userId: number, projectId: number): Promise<unknown[]> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const rows = await this.prisma.novelOutlineNode.findMany({
      where: { projectId, userId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return this.buildTree(rows, null);
  }

  async create(
    userId: number,
    projectId: number,
    dto: CreateOutlineNodeDto,
  ): Promise<unknown> {
    await requireOwnedProject(this.prisma, userId, projectId);
    if (dto.parentId) {
      const parent = await this.prisma.novelOutlineNode.findFirst({
        where: { id: dto.parentId, projectId, deletedAt: null },
      });
      if (!parent) throw new NotFoundException('父节点不存在');
    }
    const created = await this.prisma.novelOutlineNode.create({
      data: {
        projectId,
        userId,
        parentId: dto.parentId ?? null,
        nodeType: dto.nodeType ?? 'chapter',
        title: dto.title,
        summary: dto.summary ?? '',
      },
    });
    return this.toView(created);
  }

  async update(
    userId: number,
    projectId: number,
    nodeId: number,
    dto: UpdateOutlineNodeDto,
  ): Promise<unknown> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const row = await this.prisma.novelOutlineNode.findFirst({
      where: { id: nodeId, projectId, userId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('大纲节点不存在');
    const write = await this.prisma.novelOutlineNode.updateMany({
      where: {
        id: nodeId,
        projectId,
        userId,
        deletedAt: null,
        version: row.version,
      },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.summary !== undefined ? { summary: dto.summary } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        version: { increment: 1 },
      },
    });
    if (write.count !== 1) {
      throw new ConflictException({
        statusCode: 409,
        message: '澶х翰鐗堟湰鍐茬獊',
        reason: 'version_conflict',
      });
    }
    const updated = await this.prisma.novelOutlineNode.findUniqueOrThrow({
      where: { id: nodeId },
    });
    return this.toView(updated);
  }

  async remove(
    userId: number,
    projectId: number,
    nodeId: number,
  ): Promise<{ ok: true }> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const row = await this.prisma.novelOutlineNode.findFirst({
      where: { id: nodeId, projectId, userId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('大纲节点不存在');
    await this.prisma.novelOutlineNode.update({
      where: { id: nodeId },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  private buildTree(
    rows: Array<{
      id: number;
      parentId: number | null;
      nodeType: string;
      title: string;
      summary: string;
      sortOrder: number;
      version: number;
    }>,
    parentId: number | null,
  ): unknown[] {
    return rows
      .filter((row) => row.parentId === parentId)
      .map((row) => ({
        ...this.toView(row),
        children: this.buildTree(rows, row.id),
      }));
  }

  private toView(row: {
    id: number;
    parentId?: number | null;
    nodeType: string;
    title: string;
    summary: string;
    sortOrder: number;
    version: number;
  }): Record<string, unknown> {
    return {
      id: row.id,
      parentId: row.parentId ?? null,
      nodeType: row.nodeType,
      title: row.title,
      summary: row.summary,
      sortOrder: row.sortOrder,
      version: row.version,
    };
  }
}
