/**
 * 字数预算 / 安全系数解析与预占包络。
 */
import { describe, expect, it } from 'vitest';
import {
  applySafetyFactor,
  parseSafetyFactor,
  parseWordCountBudget,
  reservationTokensForBudget,
} from './runtime-settings';

describe('runtime settings', () => {
  it('treats a missing word budget as the historical token envelope', () => {
    expect(parseWordCountBudget(undefined)).toBe(0);
    expect(reservationTokensForBudget(0)).toEqual({
      tokensIn: 400_000,
      tokensOut: 65_536,
    });
  });

  it('derives reservation tokens from a character budget', () => {
    expect(parseWordCountBudget({ chars: 4000 })).toBe(4000);
    expect(reservationTokensForBudget(4000)).toEqual({
      tokensIn: 160_000,
      tokensOut: 8_000,
    });
  });

  it('clamps safety factor and matches the historical 1.3 default', () => {
    expect(parseSafetyFactor(undefined)).toBe(1.3);
    expect(applySafetyFactor(100n, 1.3)).toBe(130n);
    expect(parseSafetyFactor(0.2)).toBe(1);
    expect(parseSafetyFactor(9)).toBe(5);
  });
});
