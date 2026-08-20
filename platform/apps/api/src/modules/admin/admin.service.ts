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

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  async overview(): Promise<unknown> {
    const start = startOfUtcDay(new Date());
    const [userCount, activeUsers, recharge, consume] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: 'active' } }),
      this.prisma.paymentOrder.aggregate({
        where: { status: 'paid', paidAt: { gte: start } },
        _sum: { amount: true },
      }),
      this.prisma.novelGenerationCall.aggregate({
        where: { createdAt: { gte: start } },
        _sum: { actualCharge: true },
      }),
    ]);
    return {
      userCount,
      activeUsers,
      rechargeToday: fenToString(recharge._sum.amount ?? 0n),
      consumeToday: fenToString(consume._sum.actualCharge ?? 0n),
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
      where: { userId: { in: rows.map((row) => row.id) } },
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
        where: { userId: id },
        _sum: { actualCharge: true },
      }),
    ]);
    return {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      role: user.role,
      status: user.status,
      balance: fenToString(user.balance),
      spent: fenToString(spent._sum.actualCharge ?? 0n),
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
      },
    });
    return {
      id: created.id,
      modelKey: created.modelKey,
      displayName: created.displayName,
      inputPricePerMillion: fenToString(created.inputPricePerMillion),
      outputPricePerMillion: fenToString(created.outputPricePerMillion),
      effectiveFrom: created.effectiveFrom.toISOString(),
      enabled: created.enabled,
    };
  }

  async patchRate(
    adminId: number,
    id: number,
    input: { enabled?: boolean; displayName?: string },
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
      },
    });
    await writeAudit(this.prisma, {
      actorId: adminId,
      actorType: 'admin',
      action: 'rate.patch',
      targetType: 'model_rate',
      targetId: String(id),
      detail: { enabled: updated.enabled },
    });
    return {
      id: updated.id,
      enabled: updated.enabled,
      displayName: updated.displayName,
      inputPricePerMillion: fenToString(updated.inputPricePerMillion),
    };
  }

  async usageSummary(groupBy: 'model' | 'user' | 'day'): Promise<unknown> {
    if (groupBy === 'day') {
      const rows = await this.prisma.$queryRaw<
        Array<{ day: Date; charge: bigint; calls: bigint }>
      >`SELECT date_trunc('day', created_at) AS day,
               COALESCE(SUM(actual_charge), 0) AS charge,
               COUNT(*)::bigint AS calls
        FROM novel_generation_call
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

  async usageRecords(
    page: number,
    pageSize: number,
    filters: { userId?: number; model?: string },
  ): Promise<unknown> {
    const where: Prisma.NovelGenerationCallWhereInput = {
      ...(filters.userId ? { userId: filters.userId } : {}),
      ...(filters.model ? { model: filters.model } : {}),
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
      items: rows.map((row) => ({
        callId: row.callId,
        jobId: row.jobId,
        userId: row.userId,
        model: row.model,
        tokensIn: row.tokensIn,
        tokensOut: row.tokensOut,
        actualCharge: fenToString(row.actualCharge),
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async revenueSummary(): Promise<unknown> {
    const [paid, consume] = await Promise.all([
      this.prisma.paymentOrder.aggregate({
        where: { status: 'paid' },
        _sum: { amount: true },
      }),
      this.prisma.novelGenerationCall.aggregate({
        _sum: { actualCharge: true },
      }),
    ]);
    const days = await this.prisma.$queryRaw<
      Array<{ day: Date; recharge: bigint; consume: bigint }>
    >`SELECT d.day,
             COALESCE(p.recharge, 0) AS recharge,
             COALESCE(c.consume, 0) AS consume
      FROM (
        SELECT date_trunc('day', paid_at) AS day FROM payment_orders WHERE status = 'paid' AND paid_at IS NOT NULL
        UNION
        SELECT date_trunc('day', created_at) AS day FROM novel_generation_call
      ) d
      LEFT JOIN (
        SELECT date_trunc('day', paid_at) AS day, SUM(amount) AS recharge
        FROM payment_orders WHERE status = 'paid' AND paid_at IS NOT NULL
        GROUP BY 1
      ) p ON p.day = d.day
      LEFT JOIN (
        SELECT date_trunc('day', created_at) AS day, SUM(actual_charge) AS consume
        FROM novel_generation_call GROUP BY 1
      ) c ON c.day = d.day
      ORDER BY d.day DESC
      LIMIT 60`;
    return {
      rechargeTotal: fenToString(paid._sum.amount ?? 0n),
      consumeTotal: fenToString(consume._sum.actualCharge ?? 0n),
      byDay: days.map((row) => ({
        day: row.day.toISOString().slice(0, 10),
        recharge: fenToString(row.recharge),
        consume: fenToString(row.consume),
      })),
    };
  }

  async listAuditLogs(
    page: number,
    pageSize: number,
    action?: string,
  ): Promise<unknown> {
    const where = action ? { action } : {};
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
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
      page,
      pageSize,
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

function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}
