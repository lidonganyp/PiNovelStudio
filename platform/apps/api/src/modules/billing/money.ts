/**
 * 计费金额整数运算：费率单位为「每百万 token 多少分」，结果向上取整到分。
 * 结算倍率 multiplierPercent 为百分比整数（100=1.0 倍）：最终价 = 公开原价 × 倍率。
 */
export interface ChargeInput {
  tokensIn: number;
  tokensOut: number;
  inputPricePerMillion: bigint;
  outputPricePerMillion: bigint;
  multiplierPercent?: number;
}

/** 按 token 用量与费率快照计算实际扣费（分，向上取整）。 */
export function computeChargeFen(input: ChargeInput): bigint {
  const { tokensIn, tokensOut, inputPricePerMillion, outputPricePerMillion } =
    input;
  const multiplierPercent = input.multiplierPercent ?? 100;
  if (
    !Number.isSafeInteger(tokensIn) ||
    !Number.isSafeInteger(tokensOut) ||
    tokensIn < 0 ||
    tokensOut < 0
  ) {
    throw new Error('token 必须为非负整数');
  }
  if (inputPricePerMillion < 0n || outputPricePerMillion < 0n) {
    throw new Error('费率不能为负');
  }
  if (!Number.isSafeInteger(multiplierPercent) || multiplierPercent < 0) {
    throw new Error('倍率必须为非负整数（百分比）');
  }
  const base =
    BigInt(tokensIn) * inputPricePerMillion +
    BigInt(tokensOut) * outputPricePerMillion;
  const numerator = base * BigInt(multiplierPercent);
  if (numerator === 0n) {
    return 0n;
  }
  // base 已是「分」，再乘百分比后除以 1e6 * 100，向上取整到分。
  return (numerator + 99_999_999n) / 100_000_000n;
}

/** BigInt 金额转对外字符串（分）。 */
export function fenToString(value: bigint): string {
  return value.toString();
}
