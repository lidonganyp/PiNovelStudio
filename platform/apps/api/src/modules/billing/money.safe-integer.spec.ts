import { describe, expect, it } from 'vitest';
import { computeChargeFen } from './money';

describe('computeChargeFen safe integer boundary', () => {
  it('rejects token counts outside the exact JavaScript integer range', () => {
    expect(() => computeChargeFen({
      tokensIn: Number.MAX_SAFE_INTEGER + 1,
      tokensOut: 0,
      inputPricePerMillion: 1n,
      outputPricePerMillion: 1n,
    })).toThrow(/token/i);
  });
});
