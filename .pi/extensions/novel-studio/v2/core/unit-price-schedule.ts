/**
 * UNIT-PRICE-SCHEDULE — 版本化模型单价表（BudgetLedger 货币结算）
 *
 * 历史成本按结算时的 unitPriceScheduleVersion 解释；价格变化后用同一
 * token 用量 + 目标版本重算，不得改写旧快照。
 */

export interface UnitPriceRate {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}

export interface UnitPriceSchedule {
  version: string;
  currency: "USD";
  rates: Record<string, UnitPriceRate>;
  defaultRate: UnitPriceRate;
}

export const CURRENT_UNIT_PRICE_SCHEDULE_VERSION = "ups-2026-08-15";

const DEFAULT_RATE: UnitPriceRate = { input: 1, output: 4 };

const SCHEDULES: Record<string, UnitPriceSchedule> = {
  "ups-2026-07-01": {
    version: "ups-2026-07-01",
    currency: "USD",
    defaultRate: DEFAULT_RATE,
    rates: {
      gemini31: { input: 2.5, output: 10.0 },
      claude: { input: 8.0, output: 40.0 },
      gpt: { input: 5.0, output: 20.0 },
      glm: { input: 1.0, output: 4.0 },
      doubao: { input: 0.8, output: 3.2 },
    },
  },
  "ups-2026-08-15": {
    version: "ups-2026-08-15",
    currency: "USD",
    defaultRate: DEFAULT_RATE,
    rates: {
      gemini31: { input: 1.25, output: 5.0 },
      claude: { input: 5.0, output: 25.0 },
      gpt: { input: 2.5, output: 10.0 },
      glm: { input: 0.5, output: 2.0 },
      doubao: { input: 0.4, output: 1.6 },
    },
  },
};

export function getUnitPriceSchedule(version: string): UnitPriceSchedule {
  const schedule = SCHEDULES[version];
  if (!schedule) {
    throw new Error(`unknown unitPriceScheduleVersion: ${version}`);
  }
  return schedule;
}

export function resolveUnitPrice(
  provider: string,
  version: string = CURRENT_UNIT_PRICE_SCHEDULE_VERSION,
): UnitPriceRate {
  const schedule = getUnitPriceSchedule(version);
  return schedule.rates[provider] ?? schedule.defaultRate;
}

function roundMoney(value: number): number {
  return Number(value.toFixed(10));
}

export function computeActualCost(input: {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  unitPriceScheduleVersion?: string;
}): { actualCost: number; unitPriceScheduleVersion: string; rate: UnitPriceRate } {
  const version = input.unitPriceScheduleVersion ?? CURRENT_UNIT_PRICE_SCHEDULE_VERSION;
  const rate = resolveUnitPrice(input.provider, version);
  const actualCost = roundMoney(
    (Math.max(0, input.inputTokens) / 1_000_000) * rate.input +
      (Math.max(0, input.outputTokens) / 1_000_000) * rate.output,
  );
  return { actualCost, unitPriceScheduleVersion: version, rate };
}

export function recomputeActualCost(input: {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  unitPriceScheduleVersion: string;
}): { actualCost: number; unitPriceScheduleVersion: string; rate: UnitPriceRate } {
  return computeActualCost(input);
}
