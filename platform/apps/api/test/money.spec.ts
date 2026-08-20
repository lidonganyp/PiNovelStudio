/**
 * 计费金额整数运算单测（表驱动）。
 * 规则：charge = ceil((tokensIn * inputPrice + tokensOut * outputPrice) / 1_000_000)，单位分。
 */
import { describe, expect, it } from 'vitest';
import { computeChargeFen } from '../src/modules/billing/money';

const CASES: Array<{
  name: string;
  tokensIn: number;
  tokensOut: number;
  inputPricePerMillion: bigint;
  outputPricePerMillion: bigint;
  expected: bigint;
}> = [
  {
    name: '整百万输入按单价精确入账',
    tokensIn: 1_000_000,
    tokensOut: 0,
    inputPricePerMillion: 10n,
    outputPricePerMillion: 20n,
    expected: 10n,
  },
  {
    name: '整百万输出按单价精确入账',
    tokensIn: 0,
    tokensOut: 1_000_000,
    inputPricePerMillion: 10n,
    outputPricePerMillion: 20n,
    expected: 20n,
  },
  {
    name: '不足 1 分向上取整',
    tokensIn: 1,
    tokensOut: 0,
    inputPricePerMillion: 1n,
    outputPricePerMillion: 1n,
    expected: 1n,
  },
  {
    name: '零用量零费用',
    tokensIn: 0,
    tokensOut: 0,
    inputPricePerMillion: 100n,
    outputPricePerMillion: 200n,
    expected: 0n,
  },
  {
    name: '输入输出同时计费并向上取整',
    tokensIn: 100_000,
    tokensOut: 50_000,
    inputPricePerMillion: 100n,
    outputPricePerMillion: 200n,
    expected: 20n,
  },
  {
    name: '刚好整分不进位',
    tokensIn: 500_000,
    tokensOut: 0,
    inputPricePerMillion: 2n,
    outputPricePerMillion: 0n,
    expected: 1n,
  },
  {
    name: '整分 + 1 token 仍进 1 分',
    tokensIn: 500_001,
    tokensOut: 0,
    inputPricePerMillion: 2n,
    outputPricePerMillion: 0n,
    expected: 2n,
  },
];

describe('computeChargeFen', () => {
  it.each(CASES)('$name', (row) => {
    expect(
      computeChargeFen({
        tokensIn: row.tokensIn,
        tokensOut: row.tokensOut,
        inputPricePerMillion: row.inputPricePerMillion,
        outputPricePerMillion: row.outputPricePerMillion,
      }),
    ).toBe(row.expected);
  });

  it('拒绝负数 token', () => {
    expect(() =>
      computeChargeFen({
        tokensIn: -1,
        tokensOut: 0,
        inputPricePerMillion: 1n,
        outputPricePerMillion: 1n,
      }),
    ).toThrow(/token/i);
  });
});
