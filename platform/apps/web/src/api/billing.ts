/**
 * 计费查询 API：总览 + 消费明细分页。
 * 金额均为「分」字符串，展示层统一转元。
 */
import { http } from './http';

/** 计费总览视图。 */
export interface BillingSummary {
  balance: string;
  reserved: string;
  available: string;
  spentLast30Days: string;
  spentByDay?: Array<{ day: string; charge: string }>;
}

/** 消费明细行。 */
export interface BillingRecord {
  callId: string;
  jobId: string;
  projectId: number | null;
  projectTitle: string | null;
  model: string;
  internalStage: string;
  tokensIn: number;
  tokensOut: number;
  actualCharge: string;
  createdAt: string;
}

export interface BillingRecordsResult {
  items: BillingRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export function getBillingSummary(): Promise<BillingSummary> {
  return http.get('/billing/summary').then((r) => r.data);
}

export function listBillingRecords(params: {
  page?: number;
  pageSize?: number;
  projectId?: number;
}): Promise<BillingRecordsResult> {
  return http.get('/billing/records', { params }).then((r) => r.data);
}

/** 分字符串 → 元展示（两位小数）。 */
export function fenToYuan(fen: string | number): string {
  return (Number(fen) / 100).toFixed(2);
}
