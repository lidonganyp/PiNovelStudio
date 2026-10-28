/**
 * 全局错误处理中间件
 *
 * 把内部错误转换为脱敏的公共错误响应（plan §7 公共错误模型）。
 * 不暴露：堆栈、文件路径、内部 URL、模型名、Trace 路径。
 */

import type { NextFunction, Request, Response } from "express";
import { ConfigError } from "../config.js";
import { WhitelistViolationError } from "../tool-whitelist.js";
import { TaskTokenError } from "../task-token.js";
import { ExtensionLoadError } from "../extension-loader.js";
import { PricingTableError } from "../pricing-table.js";
import { BillingClientError } from "../billing-client.js";
import { ProviderCredentialsError } from "../provider-credentials.js";
import { WorkspaceManagerError } from "../workspace-manager.js";
import { UsageReconciliationRequired } from '../metering-binder.js';

export interface AppError {
  code: string;
  message: string;
  statusCode: number;
}

/** 把任意错误归一化为 AppError（脱敏） */
export function normalizeError(err: unknown): AppError {
  if (err instanceof UsageReconciliationRequired) return {code:'USAGE_RECONCILIATION_REQUIRED',message:err.message,statusCode:422};
  if (err instanceof ConfigError) {
    return {
      code: err.code,
      message: "服务配置错误",
      statusCode: 503,
    };
  }
  if (err instanceof PricingTableError) {
    return {
      code: err.code,
      message: "定价表加载失败",
      statusCode: 503,
    };
  }
  if (err instanceof BillingClientError) {
    // 计费结算错误：不暴露回调 URL
    const publicCode =
      err.code === "BUDGET_EXHAUSTED" ? "BILLING_BUDGET_EXHAUSTED" :
      err.code === "TIMEOUT" ? "BILLING_TIMEOUT" :
      err.code === "INVALID_RESPONSE" ? "BILLING_INVALID_RESPONSE" :
      "BILLING_SETTLE_FAILED";
    return {
      code: publicCode,
      message: "计费结算失败",
      statusCode: err.statusCode,
    };
  }
  if (err instanceof WhitelistViolationError) {
    return {
      code: err.code,
      message: "工具白名单校验失败",
      statusCode: 503,
    };
  }
  if (err instanceof ExtensionLoadError) {
    return {
      code: err.code,
      message: "扩展加载失败",
      statusCode: 503,
    };
  }
  if (err instanceof TaskTokenError) {
    return {
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
    };
  }
  if (err instanceof ProviderCredentialsError) {
    // Provider 凭证拉取错误：不暴露 platform-api URL
    const publicCode =
      err.code === "FETCH_FAILED" ? "PROVIDER_CREDENTIALS_FETCH_FAILED" :
      "PROVIDER_CREDENTIALS_INVALID_RESPONSE";
    return {
      code: publicCode,
      message: "Provider 凭证获取失败",
      statusCode: 503,
    };
  }
  if (err instanceof WorkspaceManagerError) {
    return {
      code: err.code,
      message: "临时工作区操作失败",
      statusCode: 500,
    };
  }
  if (err instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: "内部错误",
      statusCode: 500,
    };
  }
  return {
    code: "UNKNOWN_ERROR",
    message: "未知错误",
    statusCode: 500,
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const appError = normalizeError(err);
  res.status(appError.statusCode).json({
    code: appError.code,
    message: appError.message,
    // 不暴露 requestId 之外的细节（requestId 由中间件注入 res.locals）
    requestId: res.locals.requestId ?? "unknown",
    ...(err instanceof UsageReconciliationRequired ? {status:'blocked',failureEnvelope:{
      code:'generation_usage_unknown',stage:'runtime.accounting',gate:'usage_unknown',severity:'recoverable',
      reason:err.message,recoverable:true,retryPlan:'retry_same_stage',
    }} : {}),
    ...(err instanceof BillingClientError && err.code === 'BUDGET_EXHAUSTED' ? { status: 'blocked', failureEnvelope: {
      code: 'generation_budget_exhausted', stage: 'runtime.budget', gate: 'budget_exhausted', severity: 'hard',
      reason: err.message, recoverable: false, userActionRequired: ['检查本次授权预算和未决用量后，重新确认任务'],
    } } : {}),
  });
}
