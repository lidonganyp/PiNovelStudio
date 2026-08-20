/**
 * P8-2 对账脚本：按用户打印账本恒等式，零差额退出 0，否则退出 1。
 *
 *   users.balance == Σ充值 + Σ调账 − Σ已结算调用
 *   available     == users.balance − Σ在途预占
 *
 * 用法（在 apps/api 下）：
 *   pnpm ledger:reconcile
 *   pnpm ledger:reconcile -- --user-id 12
 */
import '../src/config/load-env-file';
import { PrismaClient } from '@prisma/client';
import { computeLedgerIdentity } from '../src/modules/billing/ledger';

function parseUserId(argv: string[]): number | undefined {
  const flag = argv.findIndex((item) => item === '--user-id');
  if (flag >= 0 && argv[flag + 1]) {
    const parsed = Number(argv[flag + 1]);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error('--user-id 必须为正整数');
    }
    return parsed;
  }
  return undefined;
}

function fen(value: bigint): string {
  return value.toString();
}

async function main(): Promise<void> {
  const userId = parseUserId(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const users = userId
      ? await prisma.user.findMany({ where: { id: userId }, select: { id: true, email: true } })
      : await prisma.user.findMany({ select: { id: true, email: true }, orderBy: { id: 'asc' } });
    if (users.length === 0) {
      console.error(userId ? `用户 ${userId} 不存在` : '库中没有用户');
      process.exitCode = 1;
      return;
    }

    let failed = 0;
    for (const user of users) {
      const row = await computeLedgerIdentity(prisma, user.id);
      const ok = row.balanceMatches && row.availableMatches;
      if (!ok) failed += 1;
      console.log(
        JSON.stringify(
          {
            email: user.email,
            userId: row.userId,
            rechargeFen: fen(row.rechargeFen),
            adjustmentFen: fen(row.adjustmentFen),
            settledFen: fen(row.settledFen),
            reservedFen: fen(row.reservedFen),
            balanceFen: fen(row.balanceFen),
            availableFen: fen(row.availableFen),
            expectedBalanceFen: fen(row.expectedBalanceFen),
            expectedAvailableFen: fen(row.expectedAvailableFen),
            balanceMatches: row.balanceMatches,
            availableMatches: row.availableMatches,
            ok,
          },
          null,
          2,
        ),
      );
    }
    if (failed > 0) {
      console.error(`对账失败：${failed}/${users.length} 个用户恒等式不平`);
      process.exitCode = 1;
      return;
    }
    console.log(`对账通过：${users.length} 个用户零差额`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
