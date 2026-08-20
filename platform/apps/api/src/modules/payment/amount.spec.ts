import { describe, expect, it } from 'vitest';
import {
  MAX_SAFE_PAYMENT_AMOUNT_FEN,
  fenToYuan,
  fenToProviderInteger,
  providerIntegerToFen,
  yuanToFen,
} from './amount';

describe('payment amount conversion', () => {
  it('converts fen to an exact yuan decimal without floating point', () => {
    expect(fenToYuan(1n)).toBe('0.01');
    expect(fenToYuan(10001n)).toBe('100.01');
    expect(fenToYuan(MAX_SAFE_PAYMENT_AMOUNT_FEN)).toBe('90071992547409.91');
  });

  it('parses provider yuan decimals exactly to fen', () => {
    expect(yuanToFen('0.01')).toBe(1n);
    expect(yuanToFen('100.1')).toBe(10010n);
    expect(yuanToFen('100')).toBe(10000n);
    expect(() => yuanToFen('0.001')).toThrow();
  });

  it('rejects provider integer amounts that cannot be represented exactly', () => {
    expect(providerIntegerToFen(10001)).toBe(10001n);
    expect(fenToProviderInteger(10001n)).toBe(10001);
    expect(() => fenToProviderInteger(MAX_SAFE_PAYMENT_AMOUNT_FEN + 1n)).toThrow();
    expect(() => providerIntegerToFen(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => providerIntegerToFen(-1)).toThrow();
  });
});
