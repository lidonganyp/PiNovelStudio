/**
 * Stub 支付渠道：商户号未就绪时的开发/测试通道。
 * 通知头 x-payment-stub-secret 必须等于 PAYMENT_STUB_SECRET。
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { env } from '../../config/env';
import type {
  ChannelQueryResult,
  CreatePaymentResult,
  PaymentChannelAdapter,
  VerifiedNotify,
} from './payment.types';

@Injectable()
export class StubPaymentAdapter implements PaymentChannelAdapter {
  readonly channel = 'stub';
  private readonly paid = new Map<string, ChannelQueryResult>();

  async createPayment(order: {
    orderNo: string;
  }): Promise<CreatePaymentResult> {
    return { qrContent: `stub://pay/${order.orderNo}` };
  }

  async verifyNotify(input: {
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<VerifiedNotify> {
    const secret = headerValue(input.headers['x-payment-stub-secret']);
    if (secret !== env.PAYMENT_STUB_SECRET) {
      throw new UnauthorizedException('stub 支付签名无效');
    }
    const body = input.body as {
      orderNo?: string;
      amount?: number;
      tradeNo?: string;
    };
    if (!body.orderNo || !body.tradeNo || typeof body.amount !== 'number') {
      throw new UnauthorizedException('stub 通知字段不完整');
    }
    return {
      orderNo: body.orderNo,
      amountFen: BigInt(body.amount),
      externalTradeNo: body.tradeNo,
    };
  }

  async queryPayment(orderNo: string): Promise<ChannelQueryResult> {
    return this.paid.get(orderNo) ?? { status: 'unpaid' };
  }

  /** 测试辅助：标记渠道侧已支付。 */
  markPaid(orderNo: string, amountFen: bigint, externalTradeNo: string): void {
    this.paid.set(orderNo, { status: 'paid', amountFen, externalTradeNo });
  }
}

function headerValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
