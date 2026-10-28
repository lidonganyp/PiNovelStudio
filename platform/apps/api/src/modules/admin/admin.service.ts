/**
 * 管理后台业务：用户、调账、封禁、模型/费率、用量、收入、审计、设置。
 */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { encryptSecret } from '../../common/crypto/aes-gcm';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { fenToString } from '../billing/money';
import { BillingService } from '../billing/billing.service';
import { maskSecret, writeAudit } from './admin-audit';
import {
  lastUtcDays,
  parseUtcDayRange,
  previousUtcRange,
  type UtcDayRange,
} from './date-range';
import { lookupModelPrice } from './model-price-catalog';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  async overview(): Promise<unknown> {
    const paidCalls = await this.unrefundedCalls();
    const today = lastUtcDays(1);
    const week = lastUtcDays(7);
    const [
      userCount,
      activeUsers,
      recharge,
      consume,
      remaining,
      trend,
      topUsers,
      topModels,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: 'active' } }),
      this.prisma.paymentOrder.aggregate({
        where: { status: 'paid', paidAt: { gte: today.start, lt: today.end } },
        _sum: { amount: true },
      }),
      this.prisma.novelGenerationCall.aggregate({
        where: { ...paidCalls, createdAt: { gte: today.start, lt: today.end } },
        _sum: { actualCharge: true },
      }),
      this.remainingQuota(),
      this.revenueByDay(week),
      this.topUsersByConsume(week, 8),
      this.topModelsByConsume(week, 8),
    ]);
    return {
      userCount,
      activeUsers,
      rechargeToday: fenToString(recharge._sum.amount ?? 0n),
      consumeToday: fenToString(consume._sum.actualCharge ?? 0n),
      remainingQuota: remaining.remainingQuota,
      trend7d: trend,
      topUsers,
      topModels,
    };
  }

  async listUsers(
    page: number,
    pageSize: number,
    q?: string,
    status?: string,
  ): Promise<unknown> {
    const where: Prisma.UserWhereInput = {
      ...(status ? { status } : {}),
      ...(q?.trim()
        ? {
            OR: [
              { email: { contains: q.trim(), mode: 'insensitive' } },
              { nickname: { contains: q.trim(), mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    const spent = await this.prisma.novelGenerationCall.groupBy({
      by: ['userId'],
      where: { ...await this.unrefundedCalls(), userId: { in: rows.map((row) => row.id) } },
      _sum: { actualCharge: true },
    });
    const spentMap = new Map(
      spent.map((item) => [item.userId, item._sum.actualCharge ?? 0n]),
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        email: row.email,
        nickname: row.nickname,
        role: row.role,
        status: row.status,
        balance: fenToString(row.balance),
        bonusBalance: fenToString(row.bonusBalance),
        totalBalance: fenToString(row.balance + row.bonusBalance),
        spent: fenToString(spentMap.get(row.id) ?? 0n),
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async getUser(id: number): Promise<unknown> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');
    const [holds, orders, adjustments, spent] = await Promise.all([
      this.prisma.novelBalanceHold.findMany({
        where: { userId: id, status: 'active' },
      }),
      this.prisma.paymentOrder.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.novelBillingAdjustment.findMany({
        where: { userId: id },
        orderBy: { id: 'desc' },
        take: 20,
      }),
      this.prisma.novelGenerationCall.aggregate({
        where: { ...await this.unrefundedCalls(), userId: id },
        _sum: { actualCharge: true, chargeFromReal: true, chargeFromBonus: true },
      }),
    ]);
    return {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      role: user.role,
      status: user.status,
      balance: fenToString(user.balance),
      bonusBalance: fenToString(user.bonusBalance),
      totalBalance: fenToString(user.balance + user.bonusBalance),
      spent: fenToString(spent._sum.actualCharge ?? 0n),
      spentFromReal: fenToString(spent._sum.chargeFromReal ?? 0n),
      spentFromBonus: fenToString(spent._sum.chargeFromBonus ?? 0n),
      createdAt: user.createdAt.toISOString(),
      holds: holds.map((hold) => ({
        jobId: hold.jobId,
        amount: fenToString(hold.amount),
        settledAmount: fenToString(hold.settledAmount),
        status: hold.status,
      })),
      orders: orders.map((order) => ({
        orderNo: order.orderNo,
        amount: fenToString(order.amount),
        status: order.status,
        channel: order.channel,
        createdAt: order.createdAt.toISOString(),
      })),
      adjustments: adjustments.map((item) => ({
        id: item.id,
        amount: fenToString(item.amount),
        reason: item.reason,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  }

  async adjust(
    adminId: number,
    userId: number,
    amount: bigint,
    reason: string,
  ): Promise<unknown> {
    const result = await this.billing.adjustBalance({
      userId,
      adminUserId: adminId,
      amount,
      reason,
    });
    await writeAudit(this.prisma, {
      actorId: adminId,
      actorType: 'admin',
      action: 'user.adjust',
      targetType: 'user',
      targetId: String(userId),
      detail: { amount: fenToString(amount), reason },
    });
    return {
      id: result.id,
      amount: fenToString(result.amount),
      reason: result.reason,
      createdAt: result.createdAt.toISOString(),
    };
  }

  async setUserStatus(
    adminId: number,
    userId: number,
    status: 'active' | 'banned',
  ): Promise<unknown> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');
    if (user.role === 'admin' && status === 'banned') {
      throw new BadRequestException('不能封禁管理员');
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { status },
    });
    await writeAudit(this.prisma, {
      actorId: adminId,
      actorType: 'admin',
      action: 'user.status',
      targetType: 'user',
      targetId: String(userId),
      detail: { status },
    });
    return { id: updated.id, status: updated.status };
  }

  async listProviders(): Promise<unknown[]> {
    const rows = await this.prisma.modelProvider.findMany({
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      providerKey: row.providerKey,
      name: row.name,
      apiBaseUrl: row.apiBaseUrl,
      apiKeyMasked: maskSecret(row.apiKeyEncrypted),
      enabled: row.enabled,
    }));
  }

  async createProvider(
    adminId: number,
    input: {
      providerKey: string;
      name: string;
      apiBaseUrl: string;
      apiKey: string;
      enabled?: boolean;
    },
  ): Promise<unknown> {
    const created = await this.prisma.modelProvider.create({
      data: {
        providerKey: input.providerKey,
        name: input.name,
        apiBaseUrl: input.apiBaseUrl,
        apiKeyEncrypted: encryptSecret(input.apiKey, env.AES_MASTER_KEY),
        enabled: input.enabled ?? true,
      },
    });
    await writeAudit(this.prisma, {
      actorId: adminId,
      actorType: 'admin',
      action: 'provider.create',
      targetType: 'model_provider',
      targetId: String(created.id),
      detail: { providerKey: created.providerKey },
    });
    return {
      id: created.id,
      providerKey: created.providerKey,
      name: created.name,
      apiBaseUrl: created.apiBaseUrl,
      apiKeyMasked: maskSecret(created.apiKeyEncrypted),
      enabled: created.enabled,
    };
  }

  async patchProvider(
    adminId: number,
    id: number,
    input: {
      name?: string;
      apiBaseUrl?: string;
      apiKey?: string;
      enabled?: boolean;
    },
  ): Promise<unknown> {
    const existing = await this.prisma.modelProvider.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Provider 不存在');
    const updated = await this.prisma.modelProvider.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.apiBaseUrl !== undefined ? { apiBaseUrl: input.apiBaseUrl } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.apiKey
          ? { apiKeyEncrypted: encryptSecret(input.apiKey, env.AES_MASTER_KEY) }
          : {}),
      },
    });
    await writeAudit(this.prisma, {
      actorId: adminId,
      actorType: 'admin',
      action: 'provider.patch',
      targetType: 'model_provider',
      targetId: String(id),
      detail: { enabled: updated.enabled },
    });
    return {
      id: updated.id,
      providerKey: updated.providerKey,
      name: updated.name,
      apiBaseUrl: updated.apiBaseUrl,
      apiKeyMasked: maskSecret(updated.apiKeyEncrypted),
      enabled: updated.enabled,
    };
  }

  async lookupRate(query: string): Promise<unknown> {
    return lookupModelPrice(query);
  }

  async listRates(): Promise<unknown[]> {
    const rows = await this.prisma.modelRate.findMany({
      orderBy: [{ modelKey: 'asc' }, { effectiveFrom: 'desc' }],
      include: { provider: true },
    });
    return rows.map((row) => ({
      id: row.id,
      modelKey: row.modelKey,
      displayName: row.displayName,
      providerId: row.providerId,
      providerKey: row.provider.providerKey,
      inputPricePerMillion: fenToString(row.inputPricePerMillion),
      outputPricePerMillion: fenToString(row.outputPricePerMillion),
      multiplierPercent: row.multiplierPercent,
      effectiveFrom: row.effectiveFrom.toISOString(),
      enabled: row.enabled,
    }));
  }

  async createRate(
    adminId: number,
    input: {
      modelKey: string;
      displayName: string;
      providerId: number;
      inputPricePerMillion: bigint;
      outputPricePerMillion: bigint;
      multiplierPercent?: number;
      effectiveFrom?: Date;
      enabled?: boolean;
    },
  ): Promise<unknown> {
    const provider = await this.prisma.modelProvider.findUnique({
      where: { id: input.providerId },
    });
    if (!provider) throw new NotFoundException('Provider 不存在');
    const created = await this.prisma.modelRate.create({
      data: {
        modelKey: input.modelKey,
        displayName: input.displayName,
        providerId: input.providerId,
        inputPricePerMillion: input.inputPricePerMillion,
        outputPricePerMillion: input.outputPricePerMillion,
        multiplierPercent: input.multiplierPercent ?? 100,
        effectiveFrom: input.effectiveFrom ?? new Date(),
        enabled: input.enabled ?? true,
      },
    });
    await writeAudit(this.prisma, {
      actorId: adminId,
      actorType: 'admin',
      action: 'rate.create',
      targetType: 'model_rate',
      targetId: String(created.id),
      detail: {
        modelKey: created.modelKey,
        inputPricePerMillion: fenToString(created.inputPricePerMillion),
        outputPricePerMillion: fenToString(created.outputPricePerMillion),
        multiplierPercent: created.multiplierPercent,
      },
    });
    return {
      id: created.id,
      modelKey: created.modelKey,
      displayName: created.displayName,
      inputPricePerMillion: fenToString(created.inputPricePerMillion),
      outputPricePerMillion: fenToString(created.outputPricePerMillion),
      multiplierPercent: created.multiplierPercent,
      effectiveFrom: created.effectiveFrom.toISOString(),
      enabled: created.enabled,
    };
  }

  async patchRate(
    adminId: number,
    id: number,
    input: { enabled?: boolean; displayName?: string; multiplierPercent?: number },
  ): Promise<unknown> {
    const existing = await this.prisma.modelRate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('费率不存在');
    const updated = await this.prisma.modelRate.update({
      where: { id },
      data: {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.displayName !== undefined
          ? { displayName: input.displayName }
          : {}),
        ...(input.multiplierPercent !== undefined
          ? { multiplierPercent: input.multiplierPercent }
          : {}),
      },
    });
    await writeAudit(this.prisma, {
      actorId: adminId,
      actorType: 'admin',
      action: 'rate.patch',
      targetType: 'model_rate',
      targetId: String(id),
      detail: {
        enabled: updated.enabled,
        multiplierPercent: updated.multiplierPercent,
      },
    });
    return {
      id: updated.id,
      enabled: updated.enabled,
      displayName: updated.displayName,
      inputPricePerMillion: fenToString(updated.inputPricePerMillion),
      outputPricePerMillion: fenToString(updated.outputPricePerMillion),
      multiplierPercent: updated.multiplierPercent,
    };
  }

  /** 删除费率：历史账单按落库快照结算，不受影响。 */
  async deleteRate(adminId: number, id: number): Promise<unknown> {
    const existing = await this.prisma.modelRate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('费率不存在');
    await this.prisma.modelRate.delete({ where: { id } });
    await writeAudit(this.prisma, {
      actorId: adminId,
      actorType: 'admin',
      action: 'rate.delete',
      targetType: 'model_rate',
      targetId: String(id),
      detail: { modelKey: existing.modelKey },
    });
    return { id, deleted: true };
  }

  /** 删除供应商：仍有费率关联时拒绝，需先删除其费率。 */
  async deleteProvider(adminId: number, id: number): Promise<unknown> {
    const existing = await this.prisma.modelProvider.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Provider 不存在');
    const rateCount = await this.prisma.modelRate.count({
      where: { providerId: id },
    });
    if (rateCount > 0) {
      throw new BadRequestException(
        `该供应商仍有 ${rateCount} 条费率，请先删除费率`,
      );
    }
    await this.prisma.modelProvider.delete({ where: { id } });
    await writeAudit(this.prisma, {
      actorId: adminId,
      actorType: 'admin',
      action: 'provider.delete',
      targetType: 'model_provider',
      targetId: String(id),
      detail: { providerKey: existing.providerKey },
    });
    return { id, deleted: true };
  }

  async usageSummary(
    groupBy: 'model' | 'user' | 'day',
    filters: {
      userId?: number;
      model?: string;
      from?: string;
      to?: string;
    } = {},
  ): Promise<unknown> {
    const range = requireRange(filters.from, filters.to);
    const where = generationCallWhere(range, filters);
    if (groupBy === 'day') {
      const rows = await this.prisma.$queryRaw<
        Array<{ day: Date; charge: bigint; calls: bigint }>
      >`SELECT date_trunc('day', created_at) AS day,
               COALESCE(SUM(actual_charge), 0) AS charge,
               COUNT(*)::bigint AS calls
        FROM novel_generation_call
        WHERE ${generationCallWhereSql(range, filters)}
        GROUP BY 1
        ORDER BY 1 DESC
        LIMIT 60`;
      return rows.map((row) => ({
        day: row.day.toISOString().slice(0, 10),
        charge: fenToString(row.charge),
        calls: Number(row.calls),
      }));
    }
    if (groupBy === 'user') {
      const rows = await this.prisma.novelGenerationCall.groupBy({
        by: ['userId'],
        where,
        _sum: { actualCharge: true, tokensIn: true, tokensOut: true },
        _count: true,
        orderBy: { userId: 'asc' },
      });
      return rows.map((row) => ({
        userId: row.userId,
        charge: fenToString(row._sum.actualCharge ?? 0n),
        tokensIn: row._sum.tokensIn ?? 0,
        tokensOut: row._sum.tokensOut ?? 0,
        calls: row._count,
      }));
    }
    const rows = await this.prisma.novelGenerationCall.groupBy({
      by: ['model'],
      where,
      _sum: { actualCharge: true, tokensIn: true, tokensOut: true },
      _count: true,
      orderBy: { model: 'asc' },
    });
    return rows.map((row) => ({
      model: row.model,
      charge: fenToString(row._sum.actualCharge ?? 0n),
      tokensIn: row._sum.tokensIn ?? 0,
      tokensOut: row._sum.tokensOut ?? 0,
      calls: row._count,
    }));
  }

  async usageDashboard(filters: {
    from?: string;
    to?: string;
    userId?: number;
  }): Promise<unknown> {
    const range = filters.from || filters.to
      ? requireRange(filters.from, filters.to)
      : lastUtcDays(7);
    const previous = previousUtcRange(range);
    const where = generationCallWhere(range, { userId: filters.userId });
    const prevWhere = generationCallWhere(previous, { userId: filters.userId });
    const [current, prev, trend, byModel, byUserRaw] = await Promise.all([
      this.prisma.novelGenerationCall.aggregate({
        where,
        _sum: { actualCharge: true, tokensIn: true, tokensOut: true },
        _count: true,
      }),
      previous.start
        ? this.prisma.novelGenerationCall.aggregate({
            where: prevWhere,
            _sum: { actualCharge: true, tokensIn: true, tokensOut: true },
            _count: true,
          })
        : Promise.resolve(null),
      this.prisma.$queryRaw<
        Array<{
          day: Date;
          charge: bigint;
          calls: bigint;
          tokens_in: bigint;
          tokens_out: bigint;
        }>
      >`SELECT date_trunc('day', created_at) AS day,
               COALESCE(SUM(actual_charge), 0) AS charge,
               COUNT(*)::bigint AS calls,
               COALESCE(SUM(tokens_in), 0)::bigint AS tokens_in,
               COALESCE(SUM(tokens_out), 0)::bigint AS tokens_out
        FROM novel_generation_call
        WHERE ${generationCallWhereSql(range, { userId: filters.userId })}
        GROUP BY 1
        ORDER BY 1 ASC`,
      this.prisma.novelGenerationCall.groupBy({
        by: ['model'],
        where,
        _sum: { actualCharge: true, tokensIn: true, tokensOut: true },
        _count: true,
        orderBy: { _sum: { actualCharge: 'desc' } },
        take: 20,
      }),
      this.prisma.novelGenerationCall.groupBy({
        by: ['userId'],
        where,
        _sum: { actualCharge: true, tokensIn: true, tokensOut: true },
        _count: true,
        orderBy: { _sum: { actualCharge: 'desc' } },
        take: 20,
      }),
    ]);
    const users = await this.prisma.user.findMany({
      where: { id: { in: byUserRaw.map((row) => row.userId) } },
      select: { id: true, email: true, nickname: true },
    });
    const userMap = new Map(users.map((row) => [row.id, row]));
    const uniqueUsers = await this.prisma.novelGenerationCall.findMany({
      where,
      distinct: ['userId'],
      select: { userId: true },
    });
    return {
      from: range.start?.toISOString() ?? null,
      to: range.end?.toISOString() ?? null,
      cards: {
        requests: current._count,
        tokensIn: current._sum.tokensIn ?? 0,
        tokensOut: current._sum.tokensOut ?? 0,
        charge: fenToString(current._sum.actualCharge ?? 0n),
        users: uniqueUsers.length,
      },
      previous: prev
        ? {
            requests: prev._count,
            tokensIn: prev._sum.tokensIn ?? 0,
            tokensOut: prev._sum.tokensOut ?? 0,
            charge: fenToString(prev._sum.actualCharge ?? 0n),
          }
        : null,
      trend: trend.map((row) => ({
        day: row.day.toISOString().slice(0, 10),
        calls: Number(row.calls),
        tokensIn: Number(row.tokens_in),
        tokensOut: Number(row.tokens_out),
        charge: fenToString(row.charge),
      })),
      byModel: byModel.map((row) => ({
        model: row.model,
        calls: row._count,
        tokensIn: row._sum.tokensIn ?? 0,
        tokensOut: row._sum.tokensOut ?? 0,
        charge: fenToString(row._sum.actualCharge ?? 0n),
      })),
      byUser: byUserRaw.map((row) => ({
        userId: row.userId,
        email: userMap.get(row.userId)?.email ?? '',
        nickname: userMap.get(row.userId)?.nickname ?? '',
        calls: row._count,
        tokensIn: row._sum.tokensIn ?? 0,
        tokensOut: row._sum.tokensOut ?? 0,
        charge: fenToString(row._sum.actualCharge ?? 0n),
      })),
    };
  }

  async usageRecords(
    page: number,
    pageSize: number,
    filters: { userId?: number; model?: string; from?: string; to?: string },
  ): Promise<unknown> {
    const range = requireRange(filters.from, filters.to);
    const where = generationCallWhere(range, filters);
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
      items: rows.map((row) => ({
        callId: row.callId,
        jobId: row.jobId,
        userId: row.userId,
        model: row.model,
        tokensIn: row.tokensIn,
        tokensOut: row.tokensOut,
        actualCharge: fenToString(row.actualCharge),
        chargeFromReal: fenToString(row.chargeFromReal),
        chargeFromBonus: fenToString(row.chargeFromBonus),
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async revenueSummary(filters: {
    from?: string;
    to?: string;
    userId?: number;
  } = {}): Promise<unknown> {
    const range = requireRange(filters.from, filters.to);
    const period = await this.revenueTotals(range, filters.userId);
    const allTime = await this.remainingQuota(filters.userId);
    const byDay = await this.revenueByDay(range, filters.userId);
    const rechargeTotal = period.realRecharge + period.virtualRecharge;
    const consumeTotal = period.realConsume + period.virtualConsume;
    return {
      realRecharge: fenToString(period.realRecharge),
      virtualRecharge: fenToString(period.virtualRecharge),
      realConsume: fenToString(period.realConsume),
      virtualConsume: fenToString(period.virtualConsume),
      rechargeTotal: fenToString(rechargeTotal),
      consumeTotal: fenToString(consumeTotal),
      periodRemaining: fenToString(rechargeTotal - consumeTotal),
      remainingQuota: allTime.remainingQuota,
      remainingReal: allTime.remainingReal,
      remainingVirtual: allTime.remainingVirtual,
      byDay,
    };
  }

  private async remainingQuota(userId?: number): Promise<{
    remainingQuota: string;
    remainingReal: string;
    remainingVirtual: string;
  }> {
    const totals = await this.revenueTotals({}, userId);
    return {
      remainingQuota: fenToString(
        totals.realRecharge +
          totals.virtualRecharge -
          totals.realConsume -
          totals.virtualConsume,
      ),
      remainingReal: fenToString(totals.realRecharge - totals.realConsume),
      remainingVirtual: fenToString(
        totals.virtualRecharge - totals.virtualConsume,
      ),
    };
  }

  private async revenueTotals(
    range: UtcDayRange,
    userId?: number,
  ): Promise<{
    realRecharge: bigint;
    virtualRecharge: bigint;
    realConsume: bigint;
    virtualConsume: bigint;
  }> {
    const paidAt = createdAtFilter(range);
    const createdAt = createdAtFilter(range);
    const paidCalls = await this.unrefundedCalls();
    const [paid, adjustments, consume] = await Promise.all([
      this.prisma.paymentOrder.aggregate({
        where: {
          status: 'paid',
          ...(userId ? { userId } : {}),
          ...(paidAt ? { paidAt } : { paidAt: { not: null } }),
        },
        _sum: { amount: true },
      }),
      this.prisma.novelBillingAdjustment.aggregate({
        where: {
          ...(userId ? { userId } : {}),
          ...(createdAt ? { createdAt } : {}),
        },
        _sum: { amount: true },
      }),
      this.prisma.novelGenerationCall.aggregate({
        where: {
          ...paidCalls,
          ...(userId ? { userId } : {}),
          ...(createdAt ? { createdAt } : {}),
        },
        _sum: { chargeFromReal: true, chargeFromBonus: true },
      }),
    ]);
    return {
      realRecharge: paid._sum.amount ?? 0n,
      virtualRecharge: adjustments._sum.amount ?? 0n,
      realConsume: consume._sum.chargeFromReal ?? 0n,
      virtualConsume: consume._sum.chargeFromBonus ?? 0n,
    };
  }

  private async revenueByDay(
    range: UtcDayRange,
    userId?: number,
  ): Promise<
    Array<{
      day: string;
      realRecharge: string;
      virtualRecharge: string;
      realConsume: string;
      virtualConsume: string;
      recharge: string;
      consume: string;
    }>
  > {
    const rows = await this.prisma.$queryRaw<
      Array<{
        day: Date;
        real_recharge: bigint;
        virtual_recharge: bigint;
        real_consume: bigint;
        virtual_consume: bigint;
      }>
    >`SELECT d.day,
             COALESCE(p.real_recharge, 0) AS real_recharge,
             COALESCE(a.virtual_recharge, 0) AS virtual_recharge,
             COALESCE(c.real_consume, 0) AS real_consume,
             COALESCE(c.virtual_consume, 0) AS virtual_consume
      FROM (
        SELECT date_trunc('day', paid_at) AS day
        FROM payment_orders
        WHERE status = 'paid' AND paid_at IS NOT NULL
          AND ${paymentWhereSql(range, userId)}
        UNION
        SELECT date_trunc('day', created_at)
        FROM novel_billing_adjustment
        WHERE ${adjustmentWhereSql(range, userId)}
        UNION
        SELECT date_trunc('day', created_at)
        FROM novel_generation_call
        WHERE ${generationCallWhereSql(range, { userId })}
          AND job_id NOT IN (SELECT job_id FROM novel_generation_refunds)
      ) d
      LEFT JOIN (
        SELECT date_trunc('day', paid_at) AS day, SUM(amount) AS real_recharge
        FROM payment_orders
        WHERE status = 'paid' AND paid_at IS NOT NULL
          AND ${paymentWhereSql(range, userId)}
        GROUP BY 1
      ) p ON p.day = d.day
      LEFT JOIN (
        SELECT date_trunc('day', created_at) AS day, SUM(amount) AS virtual_recharge
        FROM novel_billing_adjustment
        WHERE ${adjustmentWhereSql(range, userId)}
        GROUP BY 1
      ) a ON a.day = d.day
      LEFT JOIN (
        SELECT date_trunc('day', created_at) AS day,
               SUM(charge_from_real) AS real_consume,
               SUM(charge_from_bonus) AS virtual_consume
        FROM novel_generation_call
        WHERE ${generationCallWhereSql(range, { userId })}
          AND job_id NOT IN (SELECT job_id FROM novel_generation_refunds)
        GROUP BY 1
      ) c ON c.day = d.day
      ORDER BY d.day DESC
      LIMIT 90`;
    return rows.map((row) => {
      const realRecharge = row.real_recharge;
      const virtualRecharge = row.virtual_recharge;
      const realConsume = row.real_consume;
      const virtualConsume = row.virtual_consume;
      return {
        day: row.day.toISOString().slice(0, 10),
        realRecharge: fenToString(realRecharge),
        virtualRecharge: fenToString(virtualRecharge),
        realConsume: fenToString(realConsume),
        virtualConsume: fenToString(virtualConsume),
        recharge: fenToString(realRecharge + virtualRecharge),
        consume: fenToString(realConsume + virtualConsume),
      };
    });
  }

  private async topUsersByConsume(
    range: UtcDayRange,
    take: number,
  ): Promise<
    Array<{ userId: number; email: string; nickname: string; consume: string; calls: number }>
  > {
    const rows = await this.prisma.novelGenerationCall.groupBy({
      by: ['userId'],
      where: { ...generationCallWhere(range, {}), ...await this.unrefundedCalls() },
      _sum: { actualCharge: true },
      _count: true,
      orderBy: { _sum: { actualCharge: 'desc' } },
      take,
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((row) => row.userId) } },
      select: { id: true, email: true, nickname: true },
    });
    const userMap = new Map(users.map((row) => [row.id, row]));
    return rows.map((row) => ({
      userId: row.userId,
      email: userMap.get(row.userId)?.email ?? '',
      nickname: userMap.get(row.userId)?.nickname ?? '',
      consume: fenToString(row._sum.actualCharge ?? 0n),
      calls: row._count,
    }));
  }

  private async topModelsByConsume(
    range: UtcDayRange,
    take: number,
  ): Promise<Array<{ model: string; consume: string; calls: number }>> {
    const rows = await this.prisma.novelGenerationCall.groupBy({
      by: ['model'],
      where: { ...generationCallWhere(range, {}), ...await this.unrefundedCalls() },
      _sum: { actualCharge: true },
      _count: true,
      orderBy: { _sum: { actualCharge: 'desc' } },
      take,
    });
    return rows.map((row) => ({
      model: row.model,
      consume: fenToString(row._sum.actualCharge ?? 0n),
      calls: row._count,
    }));
  }

  /** Revenue/author spend excludes refunds; usage dashboards retain gross model consumption. */
  private async unrefundedCalls(): Promise<Prisma.NovelGenerationCallWhereInput> {
    const refunds = await this.prisma.novelGenerationRefund.findMany({ select: { jobId: true } });
    return { jobId: { notIn: refunds.map((refund) => refund.jobId) } };
  }

  async listAuditLogs(
    page: number,
    pageSize: number,
    action?: string,
  ): Promise<unknown> {
    const where = action ? { action } : {};
    const currentPage = Number(page) || 1;
    const currentSize = Number(pageSize) || 20;
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (currentPage - 1) * currentSize,
        take: currentSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        actorType: row.actorType,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        detail: row.detail,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      page: currentPage,
      pageSize: currentSize,
    };
  }

  async getSettings(): Promise<unknown[]> {
    const rows = await this.prisma.setting.findMany({ orderBy: { key: 'asc' } });
    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async putSettings(
    adminId: number,
    items: Array<{ key: string; value: unknown }>,
  ): Promise<unknown[]> {
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('settings items 不能为空');
    }
    for (const item of items) {
      if (!item.key?.trim()) {
        throw new BadRequestException('settings key 不能为空');
      }
      await this.prisma.setting.upsert({
        where: { key: item.key },
        update: { value: item.value as Prisma.InputJsonValue },
        create: { key: item.key, value: item.value as Prisma.InputJsonValue },
      });
      await writeAudit(this.prisma, {
        actorId: adminId,
        actorType: 'admin',
        action: 'settings.put',
        targetType: 'setting',
        targetId: item.key,
        detail: item.value as Prisma.InputJsonValue,
      });
    }
    return this.getSettings();
  }
}

function requireRange(from?: string, to?: string): UtcDayRange {
  try {
    return parseUtcDayRange(from, to);
  } catch (error) {
    throw new BadRequestException(
      error instanceof Error ? error.message : '无效日期',
    );
  }
}

function createdAtFilter(range: UtcDayRange): Prisma.DateTimeFilter | undefined {
  if (!range.start && !range.end) return undefined;
  return {
    ...(range.start ? { gte: range.start } : {}),
    ...(range.end ? { lt: range.end } : {}),
  };
}

function generationCallWhere(
  range: UtcDayRange,
  filters: { userId?: number; model?: string },
): Prisma.NovelGenerationCallWhereInput {
  const createdAt = createdAtFilter(range);
  return {
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.model ? { model: filters.model } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

function generationCallWhereSql(
  range: UtcDayRange,
  filters: { userId?: number; model?: string },
): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (range.start) parts.push(Prisma.sql`created_at >= ${range.start}`);
  if (range.end) parts.push(Prisma.sql`created_at < ${range.end}`);
  if (filters.userId) parts.push(Prisma.sql`user_id = ${filters.userId}`);
  if (filters.model) parts.push(Prisma.sql`model = ${filters.model}`);
  return Prisma.join(parts, ' AND ');
}

function paymentWhereSql(range: UtcDayRange, userId?: number): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (range.start) parts.push(Prisma.sql`paid_at >= ${range.start}`);
  if (range.end) parts.push(Prisma.sql`paid_at < ${range.end}`);
  if (userId) parts.push(Prisma.sql`user_id = ${userId}`);
  return Prisma.join(parts, ' AND ');
}

function adjustmentWhereSql(range: UtcDayRange, userId?: number): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (range.start) parts.push(Prisma.sql`created_at >= ${range.start}`);
  if (range.end) parts.push(Prisma.sql`created_at < ${range.end}`);
  if (userId) parts.push(Prisma.sql`user_id = ${userId}`);
  return Prisma.join(parts, ' AND ');
}
