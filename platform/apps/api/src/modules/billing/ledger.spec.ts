/**
 * 账本恒等式：调账入账计入公式；SQL 直改余额则账面不平。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BillingService } from './billing.service';
import { RatesService } from '../rates/rates.service';
import { computeLedgerIdentity } from './ledger';

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('computeLedgerIdentity', () => {
  let prisma: PrismaService;
  let billing: BillingService;
  let userId = 0;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    billing = new BillingService(prisma, new RatesService(prisma));
    const user = await prisma.user.create({
      data: {
        email: `ledger-${runId}@test.local`,
        passwordHash: 'x',
        nickname: '对账',
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    const raw = new PrismaClient();
    try {
      await raw.novelBillingAdjustment.deleteMany({ where: { userId } });
      await raw.user.deleteMany({ where: { id: userId } });
    } finally {
      await raw.$disconnect();
      await prisma.$disconnect();
    }
  });

  it('counts adjustments toward users.bonusBalance', async () => {
    await billing.adjustBalance({
      userId,
      adminUserId: userId,
      amount: 2500n,
      reason: 'ledger spec',
    });
    const row = await computeLedgerIdentity(prisma, userId);
    expect(row.balanceMatches).toBe(true);
    expect(row.bonusBalanceMatches).toBe(true);
    expect(row.availableMatches).toBe(true);
    expect(row.balanceFen).toBe(0n);
    expect(row.bonusBalanceFen).toBe(2500n);
    expect(row.adjustmentFen).toBe(2500n);
  });
});
