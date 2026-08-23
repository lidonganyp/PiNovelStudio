/**
 * 用户章节/项目反馈：用户只追加；管理员查看、回复并写审计。
 */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { requireOwnedProject } from '../../common/ownership';
import { writeAudit } from '../admin/admin-audit';

const FEEDBACK_TYPES = new Set(['quality', 'factual', 'other']);
const MAX_REPLY_LENGTH = 5000;

const ADMIN_INCLUDE = {
  project: { select: { title: true } },
  user: { select: { email: true, nickname: true } },
  chapter: { select: { chapterNumber: true, title: true } },
  adminUser: { select: { nickname: true } },
} as const;

type FeedbackAdminRow = Prisma.NovelFeedbackGetPayload<{
  include: typeof ADMIN_INCLUDE;
}>;

type FeedbackUserRow = Prisma.NovelFeedbackGetPayload<{
  include: { adminUser: { select: { nickname: true } } };
}>;

export type FeedbackStatus = 'pending' | 'replied';

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: number, projectId: number): Promise<unknown[]> {
    await requireOwnedProject(this.prisma, userId, projectId);
    const rows = await this.prisma.novelFeedback.findMany({
      where: { projectId, userId },
      include: { adminUser: { select: { nickname: true } } },
      orderBy: { id: 'desc' },
      take: 50,
    });
    return rows.map((row) => this.toUserView(row));
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
      include: { adminUser: { select: { nickname: true } } },
    });
    return this.toUserView(created);
  }

  async adminList(
    page: number,
    pageSize: number,
    q?: string,
    type?: string,
    status?: string,
  ): Promise<unknown> {
    const where = this.adminWhere(q, type, status);
    const [rows, total] = await Promise.all([
      this.prisma.novelFeedback.findMany({
        where,
        include: ADMIN_INCLUDE,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.novelFeedback.count({ where }),
    ]);
    return {
      items: rows.map((row) => this.toAdminView(row)),
      total,
      page,
      pageSize,
    };
  }

  async adminGet(id: number): Promise<unknown> {
    const row = await this.prisma.novelFeedback.findUnique({
      where: { id },
      include: ADMIN_INCLUDE,
    });
    if (!row) {
      throw new NotFoundException('反馈不存在');
    }
    return this.toAdminView(row);
  }

  async adminReply(
    adminUserId: number,
    feedbackId: number,
    rawContent: string,
  ): Promise<unknown> {
    const content = rawContent.trim();
    if (!content) {
      throw new BadRequestException('回复内容不能为空');
    }
    if (content.length > MAX_REPLY_LENGTH) {
      throw new BadRequestException('回复内容过长');
    }
    const existing = await this.prisma.novelFeedback.findUnique({
      where: { id: feedbackId },
    });
    if (!existing) {
      throw new NotFoundException('反馈不存在');
    }
    const previousStatus: FeedbackStatus =
      existing.status === 'replied' ? 'replied' : 'pending';
    const repliedAt = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.novelFeedback.update({
          where: { id: feedbackId },
          data: {
            replyContent: content,
            repliedAt,
            adminUserId,
            status: 'replied',
          },
        });
        await writeAudit(tx as unknown as Prisma.TransactionClient, {
          actorId: adminUserId,
          actorType: 'admin',
          action: 'feedback.reply',
          targetType: 'novel_feedback',
          targetId: String(feedbackId),
          detail: {
            projectId: existing.projectId,
            userId: existing.userId,
            previousStatus,
            nextStatus: 'replied',
            repliedAt: repliedAt.toISOString(),
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('反馈不存在');
      }
      throw error;
    }
    return this.adminGet(feedbackId);
  }

  private adminWhere(
    q?: string,
    type?: string,
    status?: string,
  ): Prisma.NovelFeedbackWhereInput {
    const keyword = q?.trim();
    return {
      ...(type ? { type } : {}),
      ...(status ? { status } : {}),
      ...(keyword
        ? {
            OR: [
              { content: { contains: keyword, mode: 'insensitive' } },
              { user: { email: { contains: keyword, mode: 'insensitive' } } },
              {
                user: { nickname: { contains: keyword, mode: 'insensitive' } },
              },
              {
                project: { title: { contains: keyword, mode: 'insensitive' } },
              },
            ],
          }
        : {}),
    };
  }

  private toUserView(row: FeedbackUserRow): unknown {
    return {
      id: row.id,
      projectId: row.projectId,
      userId: row.userId,
      chapterId: row.chapterId,
      type: row.type,
      content: row.content,
      status: this.normalizeStatus(row.status),
      replyContent: row.replyContent,
      repliedAt: row.repliedAt ? row.repliedAt.toISOString() : null,
      adminNickname: row.adminUser?.nickname ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toAdminView(row: FeedbackAdminRow): unknown {
    return {
      id: row.id,
      projectId: row.projectId,
      projectTitle: row.project.title,
      userId: row.userId,
      userEmail: row.user.email,
      userNickname: row.user.nickname,
      chapterId: row.chapterId,
      chapterNumber: row.chapter?.chapterNumber ?? null,
      chapterTitle: row.chapter?.title ?? null,
      type: row.type,
      content: row.content,
      status: this.normalizeStatus(row.status),
      replyContent: row.replyContent,
      repliedAt: row.repliedAt ? row.repliedAt.toISOString() : null,
      adminUserId: row.adminUserId,
      adminNickname: row.adminUser?.nickname ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private normalizeStatus(status: string): FeedbackStatus {
    return status === 'replied' ? 'replied' : 'pending';
  }
}
