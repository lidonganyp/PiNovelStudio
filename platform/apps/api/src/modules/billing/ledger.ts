/**
 * 账本恒等式（双余额账户口径，精确到分）：
 *   users.balance      == Σ充值(paid 支付订单) − Σcharge_from_real + Σ退款.from_real
 *   users.bonusBalance == Σ调账 − Σcharge_from_bonus + Σ退款.from_bonus
 *   available          == balance + bonusBalance − Σ在途预占(amount − settled_amount)
 * 预占不扣余额，只冻结可用额度；结算逐调用按「先充值后赠送」归因扣款。
 * 说明：SQL 直改余额（如测试期直充）不在任何流水表留痕，账面自然不平，
 *       对账脚本会以 mismatch 形式暴露，符合预期。
 */
import type { Prisma } from '@prisma/client';

export interface LedgerIdentity {
  userId: number;
  rechargeFen: bigint;
  adjustmentFen: bigint;
  settledFen: bigint;
  settledFromRealFen: bigint;
  settledFromBonusFen: bigint;
  refundedFromRealFen: bigint;
  refundedFromBonusFen: bigint;
  reservedFen: bigint;
  balanceFen: bigint;
  bonusBalanceFen: bigint;
  availableFen: bigint;
  expectedBalanceFen: bigint;
  expectedBonusBalanceFen: bigint;
  expectedAvailableFen: bigint;
  balanceMatches: boolean;
  bonusBalanceMatches: boolean;
  availableMatches: boolean;
}

type LedgerDb = {
  novelGenerationRefund: {
    aggregate: (args: { where: { userId: number }; _sum: { fromReal: true; fromBonus: true } }) => Promise<{ _sum: { fromReal: bigint | null; fromBonus: bigint | null } }>;
  };
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
      _sum: { actualCharge: true; chargeFromReal: true; chargeFromBonus: true };
    }) => Promise<{
      _sum: {
        actualCharge: bigint | null;
        chargeFromReal: bigint | null;
        chargeFromBonus: bigint | null;
      };
    }>;
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
      select: { balance: true; bonusBalance: true };
    }) => Promise<{ balance: bigint; bonusBalance: bigint }>;
  };
};

/** 计算单个用户的账本恒等式，供对账脚本与 e2e 共用。 */
export async function computeLedgerIdentity(
  db: LedgerDb,
  userId: number,
): Promise<LedgerIdentity> {
  const [paid, adjustments, settled, holds, user, refunds] = await Promise.all([
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
      _sum: { actualCharge: true, chargeFromReal: true, chargeFromBonus: true },
    }),
    db.novelBalanceHold.findMany({
      where: { userId, status: 'active' },
      select: { amount: true, settledAmount: true },
    }),
    db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { balance: true, bonusBalance: true },
    }),
    db.novelGenerationRefund.aggregate({ where: { userId }, _sum: { fromReal: true, fromBonus: true } }),
  ]);

  const rechargeFen = paid._sum.amount ?? 0n;
  const adjustmentFen = adjustments._sum.amount ?? 0n;
  const settledFen = settled._sum.actualCharge ?? 0n;
  const settledFromRealFen = settled._sum.chargeFromReal ?? 0n;
  const settledFromBonusFen = settled._sum.chargeFromBonus ?? 0n;
  const reservedFen = holds.reduce(
    (sum, hold) => sum + (hold.amount - hold.settledAmount),
    0n,
  );
  const refundedFromRealFen = refunds._sum.fromReal ?? 0n;
  const refundedFromBonusFen = refunds._sum.fromBonus ?? 0n;
  const expectedBalanceFen = rechargeFen - settledFromRealFen + refundedFromRealFen;
  const expectedBonusBalanceFen = adjustmentFen - settledFromBonusFen + refundedFromBonusFen;
  const totalFen = user.balance + user.bonusBalance;
  const expectedTotalFen = expectedBalanceFen + expectedBonusBalanceFen;
  const availableFen = totalFen - reservedFen;
  const expectedAvailableFen = expectedTotalFen - reservedFen;

  return {
    userId,
    rechargeFen,
    adjustmentFen,
    settledFen,
    settledFromRealFen,
    settledFromBonusFen,
    refundedFromRealFen,
    refundedFromBonusFen,
    reservedFen,
    balanceFen: user.balance,
    bonusBalanceFen: user.bonusBalance,
    availableFen,
    expectedBalanceFen,
    expectedBonusBalanceFen,
    expectedAvailableFen,
    balanceMatches: user.balance === expectedBalanceFen,
    bonusBalanceMatches: user.bonusBalance === expectedBonusBalanceFen,
    availableMatches: availableFen === expectedAvailableFen,
  };
}

/** Prisma 客户端满足 LedgerDb 结构即可，避免把整个 PrismaService 绑死。 */
export type LedgerPrisma = Prisma.TransactionClient | LedgerDb;
