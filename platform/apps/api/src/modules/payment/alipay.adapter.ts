/**
 * 支付宝当面付（预下单）适配器。PAYMENT_MODE=live 且配置齐全时启用。
 */
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { env } from '../../config/env';
import { fenToYuan, yuanToFen } from './amount';
import type {
  ChannelQueryResult,
  CreatePaymentResult,
  PaymentChannelAdapter,
  VerifiedNotify,
} from './payment.types';

/** Alipay may report a completed payment as either success or finished. */
export function isAlipayPaidTradeStatus(status: string | undefined): boolean {
  return status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED';
}

/** Map an Alipay query response without treating an absent/unknown state as unpaid. */
export function mapAlipayQueryResult(result: {
  tradeStatus?: string;
  totalAmount?: string;
  tradeNo?: string;
}): ChannelQueryResult {
  if (isAlipayPaidTradeStatus(result.tradeStatus)) {
    if (!result.totalAmount || !result.tradeNo) return { status: 'unknown' };
    return {
      status: 'paid',
      amountFen: yuanToFen(result.totalAmount),
      externalTradeNo: result.tradeNo,
    };
  }
  if (result.tradeStatus === 'TRADE_CLOSED') return { status: 'closed' };
  if (result.tradeStatus === 'WAIT_BUYER_PAY') return { status: 'unpaid' };
  return { status: 'unknown' };
}

@Injectable()
export class AlipayPaymentAdapter implements PaymentChannelAdapter {
  readonly channel = 'alipay';
  private readonly logger = new Logger(AlipayPaymentAdapter.name);

  async createPayment(order: {
    orderNo: string;
    amountFen: bigint;
    subject: string;
  }): Promise<CreatePaymentResult> {
    const sdk = await this.loadSdk();
    const result = (await sdk.exec('alipay.trade.precreate', {
      notifyUrl: `${env.PAYMENT_NOTIFY_BASE_URL.replace(/\/$/, '')}/api/payment/notify/alipay`,
      bizContent: {
        outTradeNo: order.orderNo,
        totalAmount: fenToYuan(order.amountFen),
        subject: order.subject,
      },
    })) as { qrCode?: string };
    if (!result.qrCode) {
      throw new ServiceUnavailableException('支付宝未返回收款码');
    }
    return { qrContent: result.qrCode };
  }

  async verifyNotify(input: {
    body: unknown;
  }): Promise<VerifiedNotify> {
    const sdk = await this.loadSdk();
    const params = asStringRecord(input.body);
    const ok = sdk.checkNotifySign(params) as boolean;
    if (!ok) {
      throw new UnauthorizedException('支付宝通知验签失败');
    }
    if (!isAlipayPaidTradeStatus(params.trade_status)) {
      throw new UnauthorizedException('支付宝交易未成功');
    }
    return {
      orderNo: params.out_trade_no ?? '',
      amountFen: yuanToFen(params.total_amount ?? '0'),
      externalTradeNo: params.trade_no ?? '',
    };
  }

  async queryPayment(orderNo: string): Promise<ChannelQueryResult> {
    const sdk = await this.loadSdk();
    try {
      const result = (await sdk.exec('alipay.trade.query', {
        bizContent: { outTradeNo: orderNo },
      })) as {
        tradeStatus?: string;
        totalAmount?: string;
        tradeNo?: string;
      };
      return mapAlipayQueryResult(result);
    } catch (error: unknown) {
      this.logger.warn(
        `alipay query failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: 'unknown' };
    }
  }

  private async loadSdk(): Promise<{
    exec: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    checkNotifySign: (params: Record<string, string>) => boolean;
  }> {
    if (!env.ALIPAY_APP_ID || !env.ALIPAY_PRIVATE_KEY || !env.ALIPAY_PUBLIC_KEY) {
      throw new ServiceUnavailableException('支付宝商户未配置');
    }
    const mod = (await import('alipay-sdk')) as unknown as {
      default?: new (opts: Record<string, unknown>) => {
        exec: (
          method: string,
          params: Record<string, unknown>,
        ) => Promise<unknown>;
        checkNotifySign: (params: Record<string, string>) => boolean;
      };
      AlipaySdk?: new (opts: Record<string, unknown>) => {
        exec: (
          method: string,
          params: Record<string, unknown>,
        ) => Promise<unknown>;
        checkNotifySign: (params: Record<string, string>) => boolean;
      };
    };
    const Sdk = mod.default ?? mod.AlipaySdk;
    if (!Sdk) {
      throw new ServiceUnavailableException('支付宝 SDK 不可用');
    }
    return new Sdk({
      appId: env.ALIPAY_APP_ID,
      privateKey: env.ALIPAY_PRIVATE_KEY.replace(/\\n/g, '\n'),
      alipayPublicKey: env.ALIPAY_PUBLIC_KEY.replace(/\\n/g, '\n'),
      gateway: env.ALIPAY_GATEWAY,
    });
  }
}

function asStringRecord(body: unknown): Record<string, string> {
  if (!body || typeof body !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    result[key] = String(value);
  }
  return result;
}
