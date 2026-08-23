/** CreatePaymentOrderDto top-up amount boundary validation tests. */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreatePaymentOrderDto } from './create-order.dto';

async function validationErrors(amount: unknown): Promise<number> {
  const dto = plainToInstance(CreatePaymentOrderDto, {
    channel: 'alipay',
    amount,
  });
  return (await validate(dto)).length;
}

describe('CreatePaymentOrderDto top-up amount', () => {
  it.each([[100, 1], [100_000, 1000]])('accepts %s fen (%s yuan boundary)', async (amount) => {
    await expect(validationErrors(amount)).resolves.toBe(0);
  });

  it.each([0, 99, 101, 100_001, -100, 100.5, '1000.5', 'not-a-number'])(
    'rejects invalid amount %s',
    async (amount) => {
      await expect(validationErrors(amount)).resolves.toBeGreaterThan(0);
    },
  );
});
