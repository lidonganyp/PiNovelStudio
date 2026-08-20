/**
 * 充值订单：下单、渠道通知入账（幂等）、查单补偿、过期。
 */
import {
  BadRequestException,
  ConflictException,
  Logger,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { fenToString } from '../billing/money';
import { MAX_SAFE_PAYMENT_AMOUNT_FEN } from './amount';
import type {
  CreateOrderInput,
  CreatePaymentResult,
  PaymentChannel,
  PaymentChannelAdapter,
  PaymentOrderView,
} from './payment.types';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: Record<string, PaymentChannelAdapter>,
    private readonly expireAfterMs: number = 30 * 60 * 1000,
  ) {}

  /** 创建充值订单并向渠道申请收款码。 */
  async createOrder(input: CreateOrderInput): Promise<PaymentOrderView> {
    if (input.amountFen <= 0n || input.amountFen > MAX_SAFE_PAYMENT_AMOUNT_FEN) {
      throw new BadRequestException('充值金额必须为正');
    }
    const adapter = this.requireAdapter(input.channel);
    // Keep the provider-facing order number short while using cryptographic
    // randomness so burst traffic cannot collide on a six-character suffix.
    const orderNo = `PO${Date.now()}${randomUUID().replace(/-/g, '').slice(0, 15).toUpperCase()}`;
    await this.prisma.paymentOrder.create({
      data: {
        orderNo,
        userId: input.userId,
        channel: input.channel,
        amount: input.amountFen,
        status: 'created',
        qrContent: '',
        payUrl: null,
      },
    });

    // If transport fails after the provider created a payable transaction,
    // the persisted order remains reconcilable by query or signed notify.
    const pay: CreatePaymentResult = await adapter.createPayment({
        orderNo,
        amountFen: input.amountFen,
        subject: '账户充值',
    });

    const updated = await this.prisma.paymentOrder.update({
      where: { orderNo },
      data: {
        qrContent: pay.qrContent,
        payUrl: pay.payUrl ?? null,
      },
    });
    return this.toView(updated);
  }

  /** 当前用户查询订单。 */
  async getOrder(userId: number, orderNo: string): Promise<PaymentOrderView> {
    const order = await this.prisma.paymentOrder.findFirst({
      where: { orderNo, userId },
    });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return this.toView(order);
  }

  /** 渠道异步通知：验签 + 金额核对 + 幂等入账。 */
  async handleNotify(
    channel: string,
    raw: {
      body: unknown;
      headers?: Record<string, string | string[] | undefined>;
      rawBody?: string;
    },
  ): Promise<{ alreadyPaid: boolean; status: string; orderNo: string }> {
    const adapter = this.requireAdapter(channel);
    const verified = await adapter.verifyNotify({
      body: raw.body,
      headers: raw.headers ?? {},
      rawBody: raw.rawBody,
    });
    return this.creditIfCreated({ ...verified, channel });
  }

  /** 查单补偿：渠道已支付则入账；超时未支付则过期。 */
  async reconcilePendingOrders(): Promise<{ credited: number; expired: number }> {
    const pending = await this.prisma.paymentOrder.findMany({
      where: { status: 'created' },
    });
    let credited = 0;
    let expired = 0;
    const now = Date.now();
    for (const order of pending) {
      const adapter = this.adapters[order.channel];
      if (!adapter) continue;
      let queried;
      try {
        queried = await adapter.queryPayment(order.orderNo);
      } catch (error: unknown) {
        this.logger.warn(
          `payment query failed for ${order.orderNo}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (queried.status === 'paid' && queried.externalTradeNo && queried.amountFen !== undefined) {
        await this.creditIfCreated({
          orderNo: order.orderNo,
          amountFen: queried.amountFen,
          externalTradeNo: queried.externalTradeNo,
          channel: order.channel,
        });
        credited += 1;
        continue;
      }
      // Only a successful provider response may authorize expiry.  An
      // unavailable/unknown query must remain pending: expiring it could
      // strand a real payment whose notification arrives after a transient
      // provider outage.
      // An unpaid snapshot is not a terminal fact: the customer can complete
      // payment immediately after this query and the signed notification may
      // arrive later. Only the provider's explicit CLOSED state authorizes
      // expiry, preventing a paid order from being stranded by this race.
      if (
        queried.status === 'closed' &&
        now - order.createdAt.getTime() >= this.expireAfterMs
      ) {
        const result = await this.prisma.paymentOrder.updateMany({
          where: { orderNo: order.orderNo, status: 'created' },
          data: { status: 'expired' },
        });
        if (result.count === 1) expired += 1;
      }
    }
    return { credited, expired };
  }

  /** 管理端订单列表。 */
  async listOrders(
    page: number,
    pageSize: number,
  ): Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.paymentOrder.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { email: true, nickname: true } } },
      }),
      this.prisma.paymentOrder.count(),
    ]);
    return {
      items: rows.map((row) => ({
        ...this.serialize(this.toView(row)),
        userEmail: row.user.email,
        userNickname: row.user.nickname,
      })),
      total,
      page,
      pageSize,
    };
  }

  serialize(view: PaymentOrderView): Record<string, unknown> {
    return {
      orderNo: view.orderNo,
      userId: view.userId,
      channel: view.channel,
      amount: fenToString(view.amount),
      status: view.status,
      qrContent: view.qrContent,
      payUrl: view.payUrl,
      paidAt: view.paidAt?.toISOString() ?? null,
      createdAt: view.createdAt.toISOString(),
    };
  }

  private async creditIfCreated(input: {
    orderNo: string;
    amountFen: bigint;
    externalTradeNo: string;
    channel: string;
  }): Promise<{ alreadyPaid: boolean; status: string; orderNo: string }> {
    if (!input.orderNo || input.amountFen <= 0n || !input.externalTradeNo) {
      throw new BadRequestException('支付通知字段无效');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM payment_orders WHERE order_no = ${input.orderNo} FOR UPDATE`;
      const order = await tx.paymentOrder.findUnique({
        where: { orderNo: input.orderNo },
      });
      if (!order) {
        throw new NotFoundException('订单不存在');
      }
      if (order.status === 'paid') {
        if (
          order.channel !== input.channel ||
          order.amount !== input.amountFen ||
          order.externalTradeNo !== input.externalTradeNo
        ) {
          throw new ConflictException('paid order notification does not match the original transaction');
        }
        return { alreadyPaid: true, status: 'paid', orderNo: order.orderNo };
      }
      if (order.status !== 'created') {
        throw new BadRequestException('订单已关闭，无法入账');
      }
      if (order.channel !== input.channel) {
        throw new BadRequestException('支付通知渠道与订单渠道不匹配');
      }
      if (order.amount !== input.amountFen) {
        throw new BadRequestException('通知金额与订单不符');
      }
      await tx.paymentOrder.update({
        where: { orderNo: order.orderNo },
        data: {
          status: 'paid',
          externalTradeNo: input.externalTradeNo,
          paidAt: new Date(),
        },
      });
      await tx.user.update({
        where: { id: order.userId },
        data: { balance: { increment: order.amount } },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'channel',
          action: 'payment.paid',
          targetType: 'payment_order',
          targetId: order.orderNo,
          detail: {
            amount: fenToString(order.amount),
            channel: order.channel,
            externalTradeNo: input.externalTradeNo,
          },
        },
      });
      return { alreadyPaid: false, status: 'paid', orderNo: order.orderNo };
      });
    } catch (error: unknown) {
      // The provider trade number is globally unique. A signed notification
      // that collides with an already credited order is a conflict, not an
      // unhandled database error (and must not be retried as a 5xx).
      if (typeof error === 'object' && error !== null &&
        'code' in error && (error as { code?: unknown }).code === 'P2002') {
        throw new ConflictException('payment trade number already used');
      }
      throw error;
    }
  }

  private requireAdapter(channel: string): PaymentChannelAdapter {
    const adapter = this.adapters[channel];
    if (!adapter) {
      throw new BadRequestException(`不支持的支付渠道: ${channel}`);
    }
    return adapter;
  }

  private toView(row: {
    orderNo: string;
    userId: number;
    channel: string;
    amount: bigint;
    status: string;
    qrContent: string;
    payUrl: string | null;
    paidAt: Date | null;
    createdAt: Date;
  }): PaymentOrderView {
    return {
      orderNo: row.orderNo,
      userId: row.userId,
      channel: row.channel as PaymentChannel,
      amount: row.amount,
      status: row.status as PaymentOrderView['status'],
      qrContent: row.qrContent,
      payUrl: row.payUrl,
      paidAt: row.paidAt,
      createdAt: row.createdAt,
    };
  }
}
