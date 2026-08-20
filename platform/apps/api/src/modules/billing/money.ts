/**
 * 计费金额整数运算：费率单位为「每百万 token 多少分」，结果向上取整到分。
 */
export interface ChargeInput {
  tokensIn: number;
  tokensOut: number;
  inputPricePerMillion: bigint;
  outputPricePerMillion: bigint;
}

/** 按 token 用量与费率快照计算实际扣费（分，向上取整）。 */
export function computeChargeFen(input: ChargeInput): bigint {
  const { tokensIn, tokensOut, inputPricePerMillion, outputPricePerMillion } =
    input;
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
  const numerator =
    BigInt(tokensIn) * inputPricePerMillion +
    BigInt(tokensOut) * outputPricePerMillion;
  if (numerator === 0n) {
    return 0n;
  }
  return (numerator + 999_999n) / 1_000_000n;
}

/** BigInt 金额转对外字符串（分）。 */
export function fenToString(value: bigint): string {
  return value.toString();
}
