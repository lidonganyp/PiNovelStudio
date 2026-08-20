/**
 * 管理后台 API：概览 / 用户 / 模型费率 / 用量 / 收入 / 审计 / 设置。
 */
import { http } from './http';

export interface AdminOverview {
  userCount: number;
  activeUsers: number;
  rechargeToday: string;
  consumeToday: string;
}

export interface AdminUserRow {
  id: number;
  email: string;
  nickname: string;
  role: string;
  status: string;
  balance: string;
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
  rechargeTotal: string;
  consumeTotal: string;
  byDay: Array<{ day: string; recharge: string; consume: string }>;
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

export function createModelRate(payload: {
  modelKey: string;
  displayName: string;
  providerId: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  effectiveFrom?: string;
  enabled?: boolean;
}): Promise<ModelRateRow> {
  return http.post('/admin/model-rates', payload).then((r) => r.data);
}

export function patchModelRate(
  id: number,
  payload: { enabled?: boolean; displayName?: string },
): Promise<ModelRateRow> {
  return http.patch(`/admin/model-rates/${id}`, payload).then((r) => r.data);
}

export function getUsageSummary(
  groupBy: 'model' | 'user' | 'day',
): Promise<UsageSummaryRow[]> {
  return http.get('/admin/usage/summary', { params: { groupBy } }).then((r) => r.data);
}

export function listUsageRecords(params: {
  page?: number;
  pageSize?: number;
  userId?: number;
  model?: string;
}): Promise<UsageRecordList> {
  return http.get('/admin/usage/records', { params }).then((r) => r.data);
}

export function getRevenueSummary(): Promise<RevenueSummary> {
  return http.get('/admin/revenue/summary').then((r) => r.data);
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
