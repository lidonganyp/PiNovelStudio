/**
 * 本地费率估算表（R5 改造：移除硬编码费率，权威金额归 platform-api）
 *
 * 新计费架构（platform 计划 §7）：
 * - 逐调用结算金额由 platform-api 按调用时刻生效费率（model_rates 快照）权威计算，
 *   通过 /internal/billing/settlements 响应返回 actualCharge（分）。
 * - 本模块不再参与扣费——仅当部署方通过 NOVEL_RUNTIME_PRICING_TABLE_PATH
 *   显式提供本地费率文件时，用于日志/诊断层面的粗估（如成本预警）。
 * - 无本地文件时返回空表，估算一律为 0（不再有硬编码兜底费率）。
 */

import { existsSync, readFileSync } from "node:fs";
import type * as pino from "pino";

/** 单个 provider 的 token 费率（CNY / 1K tokens，仅诊断估算用） */
export interface ProviderRate {
  inputPer1kCny: number;
  outputPer1kCny: number;
}

/** 完整定价表 */
export interface PricingTable {
  providers: Record<string, ProviderRate>;
  routeFallback: Record<string, string>;
  defaultPer1kCny: { input: number; output: number };
}

/** 空表：无本地费率文件时的默认值（估算恒为 0） */
export const EMPTY_PRICING_TABLE: PricingTable = {
  providers: {},
  routeFallback: {},
  defaultPer1kCny: { input: 0, output: 0 },
};

/**
 * 加载本地诊断费率表：
 * - 未设置 NOVEL_RUNTIME_PRICING_TABLE_PATH → 空表（正常路径：金额由 platform-api 权威计算）
 * - 显式路径无效/非法 → fail-closed 抛错（显式配置错了不能静默吞掉）
 */
export function loadPricingTable(
  envPath: string | undefined,
  logger?: pino.Logger,
): PricingTable {
  if (!envPath) {
    return EMPTY_PRICING_TABLE;
  }
  if (!existsSync(envPath)) {
    throw new PricingTableError(
      `FAIL_CLOSED: NOVEL_RUNTIME_PRICING_TABLE_PATH points to non-existent file: ${envPath}`,
      "PRICING_FILE_NOT_FOUND",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf-8");
  } catch (err) {
    throw new PricingTableError(
      `FAIL_CLOSED: cannot read pricing table at ${envPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "PRICING_FILE_UNREADABLE",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PricingTableError(
      `FAIL_CLOSED: invalid JSON in pricing table at ${envPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "PRICING_FILE_INVALID_JSON",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new PricingTableError(
      `FAIL_CLOSED: pricing table at ${envPath} is not an object`,
      "PRICING_FILE_INVALID_SHAPE",
    );
  }
  const userTable = parsed as Partial<PricingTable>;
  const merged: PricingTable = {
    providers: userTable.providers ?? {},
    routeFallback: userTable.routeFallback ?? {},
    defaultPer1kCny: userTable.defaultPer1kCny ?? { input: 0, output: 0 },
  };
  logger?.info(
    { providerCount: Object.keys(merged.providers).length },
    "local diagnostic pricing table loaded",
  );
  return merged;
}

export class PricingTableError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "PricingTableError";
  }
}

/**
 * 诊断估算单次调用金额（CNY）。
 * ⚠️ 不参与扣费：权威金额 = platform-api settlements 响应的 actualCharge（分）。
 * 空表/未命中时返回 0。
 */
export function estimateActualCharge(
  table: PricingTable,
  params: {
    provider?: string;
    routeHint?: string;
    inputTokens: number;
    outputTokens: number;
  },
): number {
  const { provider, routeHint, inputTokens, outputTokens } = params;

  let rate: ProviderRate | undefined;
  if (provider) {
    rate = table.providers[provider.toLowerCase()];
  }
  if (!rate && routeHint) {
    const fallbackProvider = table.routeFallback[routeHint];
    if (fallbackProvider) {
      rate = table.providers[fallbackProvider.toLowerCase()];
    }
  }
  if (!rate && routeHint) {
    for (const [prefix, prov] of Object.entries(table.routeFallback)) {
      if (routeHint.startsWith(prefix) || routeHint.includes(prefix)) {
        rate = table.providers[prov.toLowerCase()];
        if (rate) break;
      }
    }
  }
  if (!rate) {
    rate = {
      inputPer1kCny: table.defaultPer1kCny.input,
      outputPer1kCny: table.defaultPer1kCny.output,
    };
  }

  const inputCharge = (inputTokens / 1000) * rate.inputPer1kCny;
  const outputCharge = (outputTokens / 1000) * rate.outputPer1kCny;
  const total = inputCharge + outputCharge;
  return Math.round(total * 1_000_000) / 1_000_000;
}
