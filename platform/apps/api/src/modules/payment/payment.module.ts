/**
 * 支付充值模块：订单、渠道适配器、通知、查单补偿。
 */
import {
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { AlipayPaymentAdapter } from './alipay.adapter';
import { PAYMENT_ADAPTERS } from './payment.constants';
import { PaymentAdminController } from './payment-admin.controller';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { StubPaymentAdapter } from './stub.adapter';
import { WechatPaymentAdapter } from './wechat.adapter';
import type { PaymentChannelAdapter } from './payment.types';

function buildAdapters(): Record<string, PaymentChannelAdapter> {
  if (env.PAYMENT_MODE === 'stub') {
    const stub = new StubPaymentAdapter();
    return { alipay: stub, wechat: stub };
  }
  return {
    alipay: new AlipayPaymentAdapter(),
    wechat: new WechatPaymentAdapter(),
  };
}

@Injectable()
export class PaymentReconcileHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentReconcileHost.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(private readonly payment: PaymentService) {}

  onModuleInit(): void {
    if (env.NODE_ENV === 'test') return;
    // Recover notifications missed during a restart before serving traffic;
    // the interval keeps the same hourly sweep for orders that remain pending.
    void this.reconcileOnce();
    this.timer = setInterval(() => void this.reconcileOnce(), 60 * 60 * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async reconcileOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const report = await this.payment.reconcilePendingOrders();
      if (report.credited > 0 || report.expired > 0) {
        this.logger.log(
          `payment reconcile credited=${report.credited} expired=${report.expired}`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `payment reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.inFlight = false;
    }
  }
}

@Module({
  controllers: [PaymentController, PaymentAdminController],
  providers: [
    {
      provide: PAYMENT_ADAPTERS,
      useFactory: buildAdapters,
    },
    {
      provide: PaymentService,
      useFactory: (
        prisma: PrismaService,
        adapters: Record<string, PaymentChannelAdapter>,
      ): PaymentService =>
        new PaymentService(
          prisma,
          adapters,
          env.PAYMENT_ORDER_EXPIRE_MINUTES * 60 * 1000,
        ),
      inject: [PrismaService, PAYMENT_ADAPTERS],
    },
    PaymentReconcileHost,
  ],
  exports: [PaymentService],
})
export class PaymentModule {}
