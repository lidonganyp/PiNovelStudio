/**
 * 充值订单 API。
 */
import { http } from './http';

export type PaymentChannel = 'alipay' | 'wechat';
export type PaymentStatus = 'created' | 'paid' | 'failed' | 'expired';

export interface PaymentOrder {
  orderNo: string;
  userId: number;
  channel: PaymentChannel;
  amount: string;
  status: PaymentStatus;
  qrContent: string;
  payUrl: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface PaymentOrderList {
  items: Array<PaymentOrder & { userEmail: string; userNickname: string }>;
  total: number;
  page: number;
  pageSize: number;
}

export function createPaymentOrder(payload: {
  channel: PaymentChannel;
  amount: number;
}): Promise<PaymentOrder> {
  return http.post('/payment/orders', payload).then((r) => r.data);
}

export function getPaymentOrder(orderNo: string): Promise<PaymentOrder> {
  return http.get(`/payment/orders/${orderNo}`).then((r) => r.data);
}

export function simulatePayment(orderNo: string): Promise<{
  alreadyPaid: boolean;
  status: string;
}> {
  return http.post(`/payment/orders/${orderNo}/simulate`).then((r) => r.data);
}

export function listAdminPaymentOrders(params: {
  page?: number;
  pageSize?: number;
}): Promise<PaymentOrderList> {
  return http.get('/admin/payment/orders', { params }).then((r) => r.data);
}
