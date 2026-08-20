/** Exact payment amount conversions shared by live payment adapters. */

export const MAX_SAFE_PAYMENT_AMOUNT_FEN = BigInt(Number.MAX_SAFE_INTEGER);

export function fenToYuan(amountFen: bigint): string {
  if (amountFen < 0n) throw new Error('payment amount cannot be negative');
  const yuan = amountFen / 100n;
  const fen = (amountFen % 100n).toString().padStart(2, '0');
  return `${yuan.toString()}.${fen}`;
}

export function yuanToFen(yuan: string): bigint {
  if (!/^\d+(?:\.\d{1,2})?$/.test(yuan)) {
    throw new Error(`invalid yuan amount: ${yuan}`);
  }
  const [whole, fraction = ''] = yuan.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function providerIntegerToFen(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('provider amount must be a non-negative safe integer');
  }
  return BigInt(value);
}

export function fenToProviderInteger(amountFen: bigint): number {
  if (amountFen < 0n || amountFen > MAX_SAFE_PAYMENT_AMOUNT_FEN) {
    throw new Error('payment amount cannot be represented exactly by provider');
  }
  return Number(amountFen);
}
