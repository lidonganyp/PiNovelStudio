/**
 * 微信 Native 支付适配器。PAYMENT_MODE=live 且配置齐全时启用。
 */
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { env } from '../../config/env';
import { fenToProviderInteger, providerIntegerToFen } from './amount';
import type {
  ChannelQueryResult,
  CreatePaymentResult,
  PaymentChannelAdapter,
  VerifiedNotify,
} from './payment.types';

/** Map a WeChat query response without treating an absent/unknown state as unpaid. */
export function mapWechatQueryResult(result: {
  trade_state?: string;
  transaction_id?: string;
  amount?: { total?: number };
}): ChannelQueryResult {
  if (result.trade_state === 'SUCCESS') {
    if (!result.transaction_id || result.amount?.total === undefined) {
      return { status: 'unknown' };
    }
    return {
      status: 'paid',
      amountFen: providerIntegerToFen(result.amount.total),
      externalTradeNo: result.transaction_id,
    };
  }
  if (result.trade_state === 'CLOSED') return { status: 'closed' };
  if (result.trade_state === 'NOTPAY' || result.trade_state === 'USERPAYING') {
    return { status: 'unpaid' };
  }
  return { status: 'unknown' };
}

@Injectable()
export class WechatPaymentAdapter implements PaymentChannelAdapter {
  readonly channel = 'wechat';
  private readonly logger = new Logger(WechatPaymentAdapter.name);

  async createPayment(order: {
    orderNo: string;
    amountFen: bigint;
    subject: string;
  }): Promise<CreatePaymentResult> {
    const pay = await this.loadSdk();
    const result = (await pay.transactions_native({
      description: order.subject,
      out_trade_no: order.orderNo,
      notify_url: `${env.PAYMENT_NOTIFY_BASE_URL.replace(/\/$/, '')}/api/payment/notify/wechat`,
      amount: { total: fenToProviderInteger(order.amountFen) },
    })) as { code_url?: string };
    if (!result.code_url) {
      throw new ServiceUnavailableException('微信未返回收款码');
    }
    return { qrContent: result.code_url };
  }

  async verifyNotify(input: {
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
    rawBody?: string;
  }): Promise<VerifiedNotify> {
    const pay = await this.loadSdk();
    const timestamp = headerValue(input.headers['wechatpay-timestamp']);
    const nonce = headerValue(input.headers['wechatpay-nonce']);
    const serial = headerValue(input.headers['wechatpay-serial']);
    const signature = headerValue(input.headers['wechatpay-signature']);
    if (!timestamp || !nonce || !serial || !signature) {
      throw new UnauthorizedException('微信通知缺少签名头');
    }
    const signatureValid = await pay.verifySign({
      timestamp,
      nonce,
      serial,
      signature,
      body: input.rawBody ?? JSON.stringify(input.body),
      apiSecret: env.WECHAT_API_V3_KEY,
    });
    if (!signatureValid) {
      throw new UnauthorizedException('微信通知验签失败');
    }
    const body = input.body as {
      resource?: { ciphertext?: string; nonce?: string; associated_data?: string };
    };
    if (!body.resource?.ciphertext) {
      throw new UnauthorizedException('微信通知缺少 resource');
    }
    const plain = pay.decipher_gcm(
      body.resource.ciphertext,
      body.resource.associated_data ?? '',
      body.resource.nonce ?? '',
      env.WECHAT_API_V3_KEY,
    ) as {
      out_trade_no?: string;
      transaction_id?: string;
      trade_state?: string;
      amount?: { total?: number };
    };
    if (plain.trade_state !== 'SUCCESS') {
      throw new UnauthorizedException('微信支付未成功');
    }
    return {
      orderNo: plain.out_trade_no ?? '',
      amountFen: providerIntegerToFen(plain.amount?.total ?? 0),
      externalTradeNo: plain.transaction_id ?? '',
    };
  }

  async queryPayment(orderNo: string): Promise<ChannelQueryResult> {
    const pay = await this.loadSdk();
    try {
      const result = (await pay.query({ out_trade_no: orderNo })) as {
        trade_state?: string;
        transaction_id?: string;
        amount?: { total?: number };
      };
      return mapWechatQueryResult(result);
    } catch (error: unknown) {
      this.logger.warn(
        `wechat query failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: 'unknown' };
    }
  }

  private async loadSdk(): Promise<{
    transactions_native: (params: Record<string, unknown>) => Promise<unknown>;
    decipher_gcm: (
      ciphertext: string,
      associatedData: string,
      nonce: string,
      key: string,
    ) => unknown;
    query: (params: Record<string, unknown>) => Promise<unknown>;
    verifySign: (params: {
      timestamp: string;
      nonce: string;
      body: string;
      serial: string;
      signature: string;
      apiSecret: string;
    }) => Promise<boolean>;
  }> {
    if (
      !env.WECHAT_APP_ID ||
      !env.WECHAT_MCH_ID ||
      !env.WECHAT_SERIAL_NO ||
      !env.WECHAT_PRIVATE_KEY ||
      !env.WECHAT_API_V3_KEY ||
      !env.WECHAT_PLATFORM_CERT
    ) {
      throw new ServiceUnavailableException('微信商户未配置');
    }
    const mod = (await import('wechatpay-node-v3')) as unknown as {
      default: new (opts: Record<string, unknown>) => {
        transactions_native: (
          params: Record<string, unknown>,
        ) => Promise<unknown>;
        decipher_gcm: (
          ciphertext: string,
          associatedData: string,
          nonce: string,
          key: string,
        ) => unknown;
        query: (params: Record<string, unknown>) => Promise<unknown>;
        verifySign: (params: {
          timestamp: string;
          nonce: string;
          body: string;
          serial: string;
          signature: string;
          apiSecret: string;
        }) => Promise<boolean>;
      };
    };
    const WxPay = mod.default;
    return new WxPay({
      appid: env.WECHAT_APP_ID,
      mchid: env.WECHAT_MCH_ID,
      publicKey: Buffer.from(env.WECHAT_PLATFORM_CERT.replace(/\\n/g, '\n')),
      privateKey: env.WECHAT_PRIVATE_KEY.replace(/\\n/g, '\n'),
      key: env.WECHAT_API_V3_KEY,
    });
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
