/**
 * 账本恒等式（Phase 2 实际口径，精确到分）：
 *   users.balance == Σ充值(paid) + Σ调账 − Σ已结算调用
 *   available     == users.balance − Σ在途预占(amount − settled_amount)
 * 开发计划原 DoD 把「在途预占」写进了与 users.balance 的等式；预占不扣
 * balance，因此合并式应等于 available，而不是账面余额。
 */
import type { Prisma } from '@prisma/client';

export interface LedgerIdentity {
  userId: number;
  rechargeFen: bigint;
  adjustmentFen: bigint;
  settledFen: bigint;
  reservedFen: bigint;
  balanceFen: bigint;
  availableFen: bigint;
  expectedBalanceFen: bigint;
  expectedAvailableFen: bigint;
  balanceMatches: boolean;
  availableMatches: boolean;
}

type LedgerDb = {
  paymentOrder: {
    aggregate: (args: {
      where: { userId: number; status: string };
      _sum: { amount: true };
    }) => Promise<{ _sum: { amount: bigint | null } }>;
  };
  novelBillingAdjustment: {
    aggregate: (args: {
      where: { userId: number };
      _sum: { amount: true };
    }) => Promise<{ _sum: { amount: bigint | null } }>;
  };
  novelGenerationCall: {
    aggregate: (args: {
      where: { userId: number };
      _sum: { actualCharge: true };
    }) => Promise<{ _sum: { actualCharge: bigint | null } }>;
  };
  novelBalanceHold: {
    findMany: (args: {
      where: { userId: number; status: string };
      select: { amount: true; settledAmount: true };
    }) => Promise<Array<{ amount: bigint; settledAmount: bigint }>>;
  };
  user: {
    findUniqueOrThrow: (args: {
      where: { id: number };
      select: { balance: true };
    }) => Promise<{ balance: bigint }>;
  };
};

/** 计算单个用户的账本恒等式，供对账脚本与 e2e 共用。 */
export async function computeLedgerIdentity(
  db: LedgerDb,
  userId: number,
): Promise<LedgerIdentity> {
  const [paid, adjustments, settled, holds, user] = await Promise.all([
    db.paymentOrder.aggregate({
      where: { userId, status: 'paid' },
      _sum: { amount: true },
    }),
    db.novelBillingAdjustment.aggregate({
      where: { userId },
      _sum: { amount: true },
    }),
    db.novelGenerationCall.aggregate({
      where: { userId },
      _sum: { actualCharge: true },
    }),
    db.novelBalanceHold.findMany({
      where: { userId, status: 'active' },
      select: { amount: true, settledAmount: true },
    }),
    db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { balance: true },
    }),
  ]);

  const rechargeFen = paid._sum.amount ?? 0n;
  const adjustmentFen = adjustments._sum.amount ?? 0n;
  const settledFen = settled._sum.actualCharge ?? 0n;
  const reservedFen = holds.reduce(
    (sum, hold) => sum + (hold.amount - hold.settledAmount),
    0n,
  );
  const expectedBalanceFen = rechargeFen + adjustmentFen - settledFen;
  const expectedAvailableFen = expectedBalanceFen - reservedFen;
  const availableFen = user.balance - reservedFen;

  return {
    userId,
    rechargeFen,
    adjustmentFen,
    settledFen,
    reservedFen,
    balanceFen: user.balance,
    availableFen,
    expectedBalanceFen,
    expectedAvailableFen,
    balanceMatches: user.balance === expectedBalanceFen,
    availableMatches: availableFen === expectedAvailableFen,
  };
}

/** Prisma 客户端满足 LedgerDb 结构即可，避免把整个 PrismaService 绑死。 */
export type LedgerPrisma = Prisma.TransactionClient | LedgerDb;
