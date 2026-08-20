/**
 * 支付宝直连：当前商户只开通了电脑网站支付（alipay.trade.page.pay）。
 * 桌面与移动都走 page.pay 收银台，不调用当面付 precreate。
 */
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { env } from '../../config/env';
import { fenToYuan, yuanToFen } from './amount';
import {
  defaultAlipayNotifyUrl,
  defaultPaymentReturnUrl,
  parseAlipayNotifyParams,
  wrapAlipayPem,
} from './alipay-notify';
import type {
  ChannelQueryResult,
  CreatePaymentResult,
  PaymentChannelAdapter,
  VerifiedNotify,
} from './payment.types';

const PRODUCT_PAGE_PAY = 'FAST_INSTANT_TRADE_PAY';

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
    userAgent?: string;
  }): Promise<CreatePaymentResult> {
    const sdk = await this.loadSdk();
    const notifyUrl =
      env.ALIPAY_NOTIFY_URL.trim() || defaultAlipayNotifyUrl(env.PAYMENT_NOTIFY_BASE_URL);
    const returnUrl =
      env.PAYMENT_RETURN_URL.trim() || defaultPaymentReturnUrl(env.PAYMENT_NOTIFY_BASE_URL);
    const subject = order.subject.trim() || env.PAYMENT_SUBJECT;
    return this.createPagePay(sdk, order, subject, notifyUrl, returnUrl);
  }

  async verifyNotify(input: {
    body: unknown;
    rawBody?: string;
  }): Promise<VerifiedNotify> {
    const sdk = await this.loadSdk();
    const params = parseAlipayNotifyParams(input.body, input.rawBody);
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

  private createPagePay(
    sdk: AlipaySdkLike,
    order: { orderNo: string; amountFen: bigint },
    subject: string,
    notifyUrl: string,
    returnUrl: string,
  ): CreatePaymentResult {
    const payUrl = sdk.pageExecute('alipay.trade.page.pay', 'GET', {
      notifyUrl,
      returnUrl,
      bizContent: {
        outTradeNo: order.orderNo,
        productCode: PRODUCT_PAGE_PAY,
        subject,
        totalAmount: fenToYuan(order.amountFen),
      },
    });
    if (!payUrl) {
      throw new ServiceUnavailableException('支付宝电脑网站支付未返回收银台');
    }
    return { qrContent: '', payUrl };
  }

  private async loadSdk(): Promise<AlipaySdkLike> {
    if (!env.ALIPAY_APP_ID || !env.ALIPAY_PRIVATE_KEY || !env.ALIPAY_PUBLIC_KEY) {
      throw new ServiceUnavailableException('支付宝商户未配置');
    }
    const mod = (await import('alipay-sdk')) as unknown as {
      default?: new (opts: Record<string, unknown>) => AlipaySdkLike;
      AlipaySdk?: new (opts: Record<string, unknown>) => AlipaySdkLike;
    };
    const Sdk = mod.AlipaySdk ?? mod.default;
    if (!Sdk) {
      throw new ServiceUnavailableException('支付宝 SDK 不可用');
    }
    return new Sdk({
      appId: env.ALIPAY_APP_ID,
      privateKey: wrapAlipayPem(env.ALIPAY_PRIVATE_KEY, 'PRIVATE KEY'),
      alipayPublicKey: wrapAlipayPem(env.ALIPAY_PUBLIC_KEY, 'PUBLIC KEY'),
      gateway: env.ALIPAY_GATEWAY,
      keyType: 'PKCS8',
      signType: 'RSA2',
    });
  }
}

interface AlipaySdkLike {
  exec: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  checkNotifySign: (params: Record<string, string>) => boolean;
  pageExecute: (
    method: string,
    httpMethod: string,
    params: Record<string, unknown>,
  ) => string;
}
