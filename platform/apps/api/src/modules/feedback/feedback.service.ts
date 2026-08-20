/**
 * 用户章节/项目反馈：只追加，供后续学习与人工复核。
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { requireOwnedProject } from '../../common/ownership';

const FEEDBACK_TYPES = new Set(['quality', 'factual', 'other']);

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: number, projectId: number): Promise<unknown[]> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const rows = await this.prisma.novelFeedback.findMany({
      where: { projectId, userId },
      orderBy: { id: 'desc' },
      take: 50,
    });
    return rows.map((row) => this.toView(row));
  }

  async create(
    userId: number,
    projectId: number,
    input: { type: string; content: string; chapterId?: number },
  ): Promise<unknown> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const type = input.type.trim();
    const content = input.content.trim();
    if (!FEEDBACK_TYPES.has(type)) {
      throw new BadRequestException('反馈类型无效');
    }
    if (!content) {
      throw new BadRequestException('反馈内容不能为空');
    }
    if (input.chapterId) {
      const chapter = await this.prisma.novelChapter.findFirst({
        where: { id: input.chapterId, projectId, userId, deletedAt: null },
      });
      if (!chapter) {
        throw new BadRequestException('章节不存在');
      }
    }
    const created = await this.prisma.novelFeedback.create({
      data: {
        projectId,
        userId,
        chapterId: input.chapterId,
        type,
        content,
      },
    });
    return this.toView(created);
  }

  async adminList(page: number, pageSize: number): Promise<unknown> {
    const [rows, total] = await Promise.all([
      this.prisma.novelFeedback.findMany({
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.novelFeedback.count(),
    ]);
    return {
      items: rows.map((row) => this.toView(row)),
      total,
      page,
      pageSize,
    };
  }

  private toView(row: {
    id: number;
    projectId: number;
    userId: number;
    chapterId: number | null;
    type: string;
    content: string;
    createdAt: Date;
  }): unknown {
    return {
      id: row.id,
      projectId: row.projectId,
      userId: row.userId,
      chapterId: row.chapterId,
      type: row.type,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
