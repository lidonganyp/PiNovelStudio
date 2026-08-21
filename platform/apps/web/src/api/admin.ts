/**
 * 管理后台 API：概览 / 用户 / 模型费率 / 用量 / 收入 / 审计 / 设置。
 */
import { http } from './http';

export interface AdminOverview {
  userCount: number;
  activeUsers: number;
  rechargeToday: string;
  consumeToday: string;
  remainingQuota?: string;
  trend7d?: Array<{
    day: string;
    realRecharge: string;
    virtualRecharge: string;
    realConsume: string;
    virtualConsume: string;
    recharge: string;
    consume: string;
  }>;
  topUsers?: Array<{
    userId: number;
    email: string;
    nickname: string;
    consume: string;
    calls: number;
  }>;
  topModels?: Array<{ model: string; consume: string; calls: number }>;
}

export interface ModelPriceLookup {
  found: boolean;
  query: string;
  matchedId?: string;
  displayName?: string;
  source?: 'siliconflow' | 'openrouter';
  nativeCurrency?: 'CNY' | 'USD';
  usdCnyRate?: number;
  inputYuanPerMillion?: number;
  outputYuanPerMillion?: number;
  inputPricePerMillionFen?: string;
  outputPricePerMillionFen?: string;
  message?: string;
  candidates?: Array<{
    id: string;
    source: string;
    inputYuanPerMillion: number;
    outputYuanPerMillion: number;
  }>;
}

export interface UsageDashboard {
  from: string | null;
  to: string | null;
  cards: {
    requests: number;
    tokensIn: number;
    tokensOut: number;
    charge: string;
    users: number;
  };
  previous: {
    requests: number;
    tokensIn: number;
    tokensOut: number;
    charge: string;
  } | null;
  trend: Array<{
    day: string;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    charge: string;
  }>;
  byModel: Array<{
    model: string;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    charge: string;
  }>;
  byUser: Array<{
    userId: number;
    email: string;
    nickname: string;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    charge: string;
  }>;
}

export interface AdminUserRow {
  id: number;
  email: string;
  nickname: string;
  role: string;
  status: string;
  /** 充值余额（真实）。 */
  balance: string;
  /** 赠送余额（虚拟）。 */
  bonusBalance: string;
  /** 总余额 = 充值 + 赠送。 */
  totalBalance: string;
  spent: string;
  createdAt: string;
}

export interface AdminUserList {
  items: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminUserDetail extends AdminUserRow {
  /** 真实消耗（从充值余额扣减）。 */
  spentFromReal: string;
  /** 虚拟消耗（从赠送余额扣减）。 */
  spentFromBonus: string;
  holds: Array<{
    jobId: string;
    amount: string;
    settledAmount: string;
    status: string;
  }>;
  orders: Array<{
    orderNo: string;
    amount: string;
    status: string;
    channel: string;
    createdAt: string;
  }>;
  adjustments: Array<{
    id: number;
    amount: string;
    reason: string;
    createdAt: string;
  }>;
}

export interface ModelProviderRow {
  id: number;
  providerKey: string;
  name: string;
  apiBaseUrl: string;
  apiKeyMasked: string;
  enabled: boolean;
}

export interface ModelRateRow {
  id: number;
  modelKey: string;
  displayName: string;
  providerId: number;
  providerKey: string;
  inputPricePerMillion: string;
  outputPricePerMillion: string;
  multiplierPercent?: number;
  effectiveFrom: string;
  enabled: boolean;
}

export interface UsageSummaryRow {
  model?: string;
  userId?: number;
  day?: string;
  charge: string;
  tokensIn?: number;
  tokensOut?: number;
  calls: number;
}

export interface UsageRecordList {
  items: Array<{
    callId: string;
    jobId: string;
    userId: number;
    model: string;
    tokensIn: number;
    tokensOut: number;
    actualCharge: string;
    createdAt: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

export interface RevenueSummary {
  realRecharge: string;
  virtualRecharge: string;
  realConsume: string;
  virtualConsume: string;
  rechargeTotal: string;
  consumeTotal: string;
  periodRemaining: string;
  remainingQuota: string;
  remainingReal: string;
  remainingVirtual: string;
  byDay: Array<{
    day: string;
    realRecharge: string;
    virtualRecharge: string;
    realConsume: string;
    virtualConsume: string;
    recharge: string;
    consume: string;
  }>;
}

export interface AuditLogList {
  items: Array<{
    id: number;
    actorId: number | null;
    actorType: string;
    action: string;
    targetType: string;
    targetId: string;
    detail: unknown;
    createdAt: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

export interface SettingRow {
  key: string;
  value: unknown;
  updatedAt: string;
}

export function getAdminOverview(): Promise<AdminOverview> {
  return http.get('/admin').then((r) => r.data);
}

export function listAdminUsers(params: {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: string;
}): Promise<AdminUserList> {
  return http.get('/admin/users', { params }).then((r) => r.data);
}

export function getAdminUser(id: number): Promise<AdminUserDetail> {
  return http.get(`/admin/users/${id}`).then((r) => r.data);
}

export function adjustUserBalance(
  id: number,
  payload: { amount: number; reason: string },
): Promise<{ id: number; amount: string; reason: string }> {
  return http.post(`/admin/users/${id}/adjustments`, payload).then((r) => r.data);
}

export function setUserStatus(
  id: number,
  status: 'active' | 'banned',
): Promise<{ id: number; status: string }> {
  return http.post(`/admin/users/${id}/status`, { status }).then((r) => r.data);
}

export function listModelProviders(): Promise<ModelProviderRow[]> {
  return http.get('/admin/model-providers').then((r) => r.data);
}

export function createModelProvider(payload: {
  providerKey: string;
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  enabled?: boolean;
}): Promise<ModelProviderRow> {
  return http.post('/admin/model-providers', payload).then((r) => r.data);
}

export function patchModelProvider(
  id: number,
  payload: { name?: string; apiBaseUrl?: string; apiKey?: string; enabled?: boolean },
): Promise<ModelProviderRow> {
  return http.patch(`/admin/model-providers/${id}`, payload).then((r) => r.data);
}

export function listModelRates(): Promise<ModelRateRow[]> {
  return http.get('/admin/model-rates').then((r) => r.data);
}

export function lookupModelRate(q: string): Promise<ModelPriceLookup> {
  return http.get('/admin/model-rates/lookup', { params: { q } }).then((r) => r.data);
}

export function createModelRate(payload: {
  modelKey: string;
  displayName: string;
  providerId: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  multiplierPercent?: number;
  effectiveFrom?: string;
  enabled?: boolean;
}): Promise<ModelRateRow> {
  return http.post('/admin/model-rates', payload).then((r) => r.data);
}

export function patchModelRate(
  id: number,
  payload: {
    enabled?: boolean;
    displayName?: string;
    multiplierPercent?: number;
  },
): Promise<ModelRateRow> {
  return http.patch(`/admin/model-rates/${id}`, payload).then((r) => r.data);
}

export function deleteModelRate(id: number): Promise<{ id: number }> {
  return http.delete(`/admin/model-rates/${id}`).then((r) => r.data);
}

export function deleteModelProvider(id: number): Promise<{ id: number }> {
  return http.delete(`/admin/model-providers/${id}`).then((r) => r.data);
}

export function getUsageSummary(
  groupBy: 'model' | 'user' | 'day',
  params: { from?: string; to?: string; userId?: number; model?: string } = {},
): Promise<UsageSummaryRow[]> {
  return http
    .get('/admin/usage/summary', { params: { groupBy, ...params } })
    .then((r) => r.data);
}

export function getUsageDashboard(params: {
  from?: string;
  to?: string;
  userId?: number;
}): Promise<UsageDashboard> {
  return http.get('/admin/usage/dashboard', { params }).then((r) => r.data);
}

export function listUsageRecords(params: {
  page?: number;
  pageSize?: number;
  userId?: number;
  model?: string;
  from?: string;
  to?: string;
}): Promise<UsageRecordList> {
  return http.get('/admin/usage/records', { params }).then((r) => r.data);
}

export function getRevenueSummary(params: {
  from?: string;
  to?: string;
  userId?: number;
} = {}): Promise<RevenueSummary> {
  return http.get('/admin/revenue/summary', { params }).then((r) => r.data);
}

export function listAuditLogs(params: {
  page?: number;
  pageSize?: number;
  action?: string;
}): Promise<AuditLogList> {
  return http.get('/admin/audit-logs', { params }).then((r) => r.data);
}

export function listSettings(): Promise<SettingRow[]> {
  return http.get('/admin/settings').then((r) => r.data);
}

export function putSettings(
  items: Array<{ key: string; value: unknown }>,
): Promise<SettingRow[]> {
  return http.put('/admin/settings', { items }).then((r) => r.data);
}
