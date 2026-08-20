/**
 * 运行时系统设置解析：字数预算（汉字）与预占安全系数。
 * 缺失设置时保持历史默认，避免改变既有 stub 预占口径。
 */
export const SETTING_REGISTRATION = 'registration_enabled';
export const SETTING_WORD_COUNT_BUDGET = 'word_count_budget';
export const SETTING_SAFETY_FACTOR = 'safety_factor';

export const DEFAULT_WORD_COUNT_BUDGET_CHARS = 0;
export const DEFAULT_SAFETY_FACTOR = 1.3;
export const DEFAULT_RESERVATION_TOKENS_IN = 400_000;
export const DEFAULT_RESERVATION_TOKENS_OUT = 65_536;

export function parseWordCountBudget(value: unknown): number {
  const raw =
    typeof value === 'number'
      ? value
      : value && typeof value === 'object' && 'chars' in value
        ? (value as { chars?: unknown }).chars
        : value && typeof value === 'object' && 'value' in value
          ? (value as { value?: unknown }).value
          : undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_WORD_COUNT_BUDGET_CHARS;
  }
  return Math.min(Math.floor(raw), 200_000);
}

export function parseSafetyFactor(value: unknown): number {
  const raw =
    typeof value === 'number'
      ? value
      : value && typeof value === 'object' && 'value' in value
        ? (value as { value?: unknown }).value
        : undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_SAFETY_FACTOR;
  }
  return Math.min(5, Math.max(1, raw));
}

export function reservationTokensForBudget(wordCountBudget: number): {
  tokensIn: number;
  tokensOut: number;
} {
  if (wordCountBudget <= 0) {
    return {
      tokensIn: DEFAULT_RESERVATION_TOKENS_IN,
      tokensOut: DEFAULT_RESERVATION_TOKENS_OUT,
    };
  }
  return {
    tokensIn: Math.max(8_192, wordCountBudget * 40),
    tokensOut: Math.max(1_024, wordCountBudget * 2),
  };
}

export function applySafetyFactor(baseFen: bigint, factor: number): bigint {
  const tenths = BigInt(Math.round(parseSafetyFactor(factor) * 10));
  const withFactor = (baseFen * tenths + 9n) / 10n;
  return withFactor < 1n ? 1n : withFactor;
}
