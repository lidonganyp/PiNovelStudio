/**
 * 支付渠道适配器与订单视图类型。
 */

export type PaymentChannel = 'alipay' | 'wechat';
export type PaymentOrderStatus = 'created' | 'paid' | 'failed' | 'expired';

export interface CreatePaymentResult {
  qrContent: string;
  payUrl?: string;
}

export interface VerifiedNotify {
  orderNo: string;
  amountFen: bigint;
  externalTradeNo: string;
}

export interface ChannelQueryResult {
  /** unknown means the provider could not be queried authoritatively. */
  status: 'paid' | 'unpaid' | 'closed' | 'unknown';
  amountFen?: bigint;
  externalTradeNo?: string;
}

export interface PaymentChannelAdapter {
  readonly channel: string;
  createPayment(order: {
    orderNo: string;
    amountFen: bigint;
    subject: string;
  }): Promise<CreatePaymentResult>;
  verifyNotify(input: {
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
    rawBody?: string;
  }): Promise<VerifiedNotify>;
  queryPayment(orderNo: string): Promise<ChannelQueryResult>;
}

export interface PaymentOrderView {
  orderNo: string;
  userId: number;
  channel: string;
  amount: bigint;
  status: PaymentOrderStatus;
  qrContent: string;
  payUrl: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface CreateOrderInput {
  userId: number;
  channel: PaymentChannel;
  amountFen: bigint;
}
