/**
 * 用户侧计费查询：总览与消费明细（联 call / job / project）。
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { fenToString } from './money';

@Injectable()
export class BillingQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(userId: number): Promise<unknown> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const grouped = await this.prisma.novelGenerationCall.aggregate({
      where: { userId, createdAt: { gte: since } },
      _sum: { actualCharge: true },
    });
    const holds = await this.prisma.novelBalanceHold.findMany({
      where: { userId, status: 'active' },
      select: { amount: true, settledAmount: true },
    });
    const reserved = holds.reduce(
      (sum, hold) => sum + (hold.amount - hold.settledAmount),
      0n,
    );
    const byDay = await this.prisma.$queryRaw<
      Array<{ day: Date; charge: bigint }>
    >`SELECT date_trunc('day', created_at) AS day,
             COALESCE(SUM(actual_charge), 0) AS charge
      FROM novel_generation_call
      WHERE user_id = ${userId} AND created_at >= ${since}
      GROUP BY 1
      ORDER BY 1 ASC`;
    return {
      balance: fenToString(user.balance),
      reserved: fenToString(reserved),
      available: fenToString(user.balance - reserved),
      spentLast30Days: fenToString(grouped._sum.actualCharge ?? 0n),
      spentByDay: byDay.map((row) => ({
        day: row.day.toISOString().slice(0, 10),
        charge: fenToString(row.charge),
      })),
    };
  }

  async records(
    userId: number,
    page: number,
    pageSize: number,
    projectId?: number,
  ): Promise<unknown> {
    const jobs = await this.prisma.novelGenerationJob.findMany({
      where: { userId, ...(projectId ? { projectId } : {}) },
      select: { jobId: true, projectId: true, project: { select: { title: true } } },
    });
    const jobMap = new Map(
      jobs.map((job) => [job.jobId, job] as const),
    );
    const jobIds = jobs.map((job) => job.jobId);
    const where = {
      userId,
      ...(projectId ? { jobId: { in: jobIds } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.novelGenerationCall.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.novelGenerationCall.count({ where }),
    ]);
    return {
      items: rows.map((row) => {
        const job = jobMap.get(row.jobId);
        return {
          callId: row.callId,
          jobId: row.jobId,
          projectId: job?.projectId ?? null,
          projectTitle: job?.project.title ?? null,
          model: row.model,
          internalStage: row.internalStage,
          tokensIn: row.tokensIn,
          tokensOut: row.tokensOut,
          actualCharge: fenToString(row.actualCharge),
          createdAt: row.createdAt.toISOString(),
        };
      }),
      total,
      page,
      pageSize,
    };
  }
}
