/**
 * 角色档案 CRUD（软删除 + 乐观锁）。
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { requireOwnedProject } from '../../common/ownership';

export class CreateCharacterDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  roleType?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @IsOptional()
  @IsString()
  identity?: string;

  @IsOptional()
  @IsString()
  goals?: string;
}

export class UpdateCharacterDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  identity?: string;

  @IsOptional()
  @IsString()
  goals?: string;

  @IsOptional()
  @IsString()
  motivation?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

@Injectable()
export class CharactersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: number, projectId: number): Promise<unknown[]> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const rows = await this.prisma.novelCharacter.findMany({
      where: { projectId, userId, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
    return rows.map((row) => this.toView(row));
  }

  async create(
    userId: number,
    projectId: number,
    dto: CreateCharacterDto,
  ): Promise<unknown> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const max = await this.prisma.novelCharacter.aggregate({
      where: { projectId, deletedAt: null },
      _max: { sortOrder: true },
    });
    const created = await this.prisma.novelCharacter.create({
      data: {
        projectId,
        userId,
        name: dto.name,
        roleType: dto.roleType ?? 'other',
        aliases: dto.aliases ?? [],
        identity: dto.identity ?? '',
        goals: dto.goals ?? '',
        sortOrder: (max._max.sortOrder ?? 0) + 1,
      },
    });
    return this.toView(created);
  }

  async update(
    userId: number,
    projectId: number,
    characterId: number,
    dto: UpdateCharacterDto,
  ): Promise<unknown> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const row = await this.prisma.novelCharacter.findFirst({
      where: { id: characterId, projectId, userId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('角色不存在');
    if (row.version !== dto.expectedVersion) {
      throw new ConflictException({
        statusCode: 409,
        message: '角色版本冲突',
        reason: 'version_conflict',
        currentVersion: row.version,
      });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const write = await tx.novelCharacter.updateMany({
        where: {
          id: characterId,
          projectId,
          userId,
          deletedAt: null,
          version: dto.expectedVersion,
        },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.identity !== undefined ? { identity: dto.identity } : {}),
          ...(dto.goals !== undefined ? { goals: dto.goals } : {}),
          ...(dto.motivation !== undefined ? { motivation: dto.motivation } : {}),
          version: { increment: 1 },
        },
      });
      if (write.count !== 1) {
        const current = await tx.novelCharacter.findFirst({
          where: { id: characterId, projectId, userId, deletedAt: null },
          select: { version: true },
        });
        throw new ConflictException({
          statusCode: 409,
          message: '瑙掕壊鐗堟湰鍐茬獊',
          reason: 'version_conflict',
          currentVersion: current?.version ?? row.version,
        });
      }
      return tx.novelCharacter.findUniqueOrThrow({ where: { id: characterId } });
    });
    return this.toView(updated);
  }

  async remove(
    userId: number,
    projectId: number,
    characterId: number,
  ): Promise<{ ok: true }> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const row = await this.prisma.novelCharacter.findFirst({
      where: { id: characterId, projectId, userId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('角色不存在');
    await this.prisma.novelCharacter.update({
      where: { id: characterId },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  private toView(row: {
    id: number;
    name: string;
    roleType: string;
    aliases: unknown;
    identity: string;
    goals: string;
    version: number;
    sortOrder: number;
  }): Record<string, unknown> {
    return {
      id: row.id,
      name: row.name,
      roleType: row.roleType,
      aliases: row.aliases,
      identity: row.identity,
      goals: row.goals,
      version: row.version,
      sortOrder: row.sortOrder,
    };
  }
}
